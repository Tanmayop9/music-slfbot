/**
 * SelfBot — discord.js-selfbot-v13 Client subclass.
 *
 * General AI agent design:
 *   When anyone pings or replies to the bot the agent:
 *     1. Loads the per-user persistent memory (facts learned about that user).
 *     2. Passes the rolling per-channel conversation history to Groq so the
 *        model understands follow-ups ("do it again", "now roast him too", etc.).
 *     3. Executes every action in the returned `actions` array:
 *          send     — post a text reply (chat, roast, mock, answer, anything)
 *          react    — add an emoji reaction to a message
 *          reminder — store a timed reminder and confirm it
 *     4. Persists any new `memory` facts the model extracted about the user.
 *
 *   Other responsibilities:
 *     - Dispatch prefix commands to the owner.
 *     - Track deleted + edited messages for snipe commands.
 *     - Fire due reminders on a 30-second tick.
 *     - Reconnect automatically on transient disconnects.
 */

import { Client } from 'discord.js-selfbot-v13';
import { handleCommand } from './commands.js';
import { startConsole } from './console.js';
import { trackDeletedMessage, trackEditedMessage } from '../handlers/snipe.js';
import { createLogger } from '../logger.js';

const log = createLogger('SelfBot');

// ── Groq AI ────────────────────────────────────────────────────────────────

const GROQ_API_URL    = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL      = 'llama3-8b-8192';
const GROQ_MAX_TOKENS = 500;

/** Maximum conversation turns kept in memory per channel (user + assistant pairs). */
const MAX_HISTORY_MSGS = 20;

/**
 * Build the system prompt.
 *
 * Injecting the current UTC time lets the model resolve relative datetimes.
 * Injecting user facts personalises every response.
 *
 * Expected response shape from the model:
 * {
 *   "actions": [
 *     { "action": "send",     "content": "<text, no emojis>" },
 *     { "action": "react",    "emoji": "<unicode emoji>", "target": "current|referenced" },
 *     { "action": "reminder", "remindAt": "<ISO UTC>", "reminderMsg": "<text>", "content": "<confirmation>" }
 *   ],
 *   "memory": [
 *     { "userId": "<discord id>", "fact": "<one sentence>" }
 *   ]
 * }
 *
 * @param {string[]} userFacts  Facts already known about the user.
 * @returns {string}
 */
function buildSystemPrompt(userFacts = []) {
  const now         = new Date().toISOString();
  const memSection  = userFacts.length
    ? `\nWHAT YOU ALREADY KNOW ABOUT THIS USER:\n${userFacts.map(f => `- ${f}`).join('\n')}\n`
    : '';

  return [
    `You are a witty, slightly naughty, intelligent AI agent on Discord. Current UTC time: ${now}.`,
    memSection,
    `You have full memory of this conversation via the message history provided.`,
    ``,
    `Respond with a JSON object in this exact shape:`,
    `{"actions":[...],"memory":[...]}`,
    ``,
    `ACTIONS ARRAY — include one or more:`,
    `  {"action":"send","content":"<text, no emojis, short and punchy>"}`,
    `  {"action":"react","emoji":"<single unicode emoji>","target":"current|referenced"}`,
    `    (target=referenced means react to the message being replied to; target=current means the user's own message)`,
    `  {"action":"reminder","remindAt":"<ISO 8601 UTC>","reminderMsg":"<what to remind>","content":"<casual confirmation, no emojis>"}`,
    ``,
    `MEMORY ARRAY (optional) — facts you want to remember about the user for future conversations:`,
    `  [{"userId":"<their Discord id>","fact":"<one short sentence, no emojis>"}]`,
    ``,
    `RULES:`,
    `- Always include at least one action.`,
    `- For mock/roast: be savage, creative, and funny.`,
    `- Never use emojis inside "content", "reminderMsg", or "fact" string values.`,
    `- Use conversation history for context — handle follow-ups like "do it again" or "now roast him too".`,
    `- When the user shares personal info (name, likes, location, etc.) add it to memory.`,
    `- Keep text short and punchy (1–3 sentences max).`,
    `- Respond with valid JSON only, nothing else.`,
  ].join('\n');
}

/**
 * Call the Groq chat-completion API with a full conversation history.
 *
 * @param {string}   apiKey
 * @param {string}   systemPrompt
 * @param {Array<{role:string,content:string}>} history  Full message history including
 *                                                        the current user message as last entry.
 * @returns {Promise<{actions: object[], memory?: object[]}>}
 */
async function groqAgent(apiKey, systemPrompt, history) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:           GROQ_MODEL,
      messages:        [{ role: 'system', content: systemPrompt }, ...history],
      max_tokens:      GROQ_MAX_TOKENS,
      temperature:     0.9,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data    = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() ?? '{}';

  try {
    const parsed = JSON.parse(content);
    // Gracefully handle old single-action shape { action, content, ... }
    if (!Array.isArray(parsed.actions) && parsed.action) {
      const { action, content: c, emoji, target, remindAt, reminderMsg } = parsed;
      parsed.actions = [{ action, content: c, emoji, target, remindAt, reminderMsg }];
    }
    if (!Array.isArray(parsed.actions)) parsed.actions = [];
    return parsed;
  } catch {
    // JSON parse failed — don't expose raw API output to users
    return { actions: [{ action: 'send', content: 'had a brain glitch, try again' }] };
  }
}

/** Generate a unique reminder ID. */
function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SelfBot extends Client {
  /**
   * @param {object}  opts
   * @param {string}  opts.token
   * @param {string}  [opts.prefix='!']
   * @param {string}  [opts.ownerId='0']
   * @param {string|null} [opts.consoleChannelId=null]
   * @param {import('../storage/premiumData.js').PremiumData|null}   [opts.premiumData]
   * @param {import('../storage/reminderData.js').ReminderData|null} [opts.reminderData]
   * @param {import('../storage/memoryData.js').MemoryData|null}     [opts.memoryData]
   * @param {string|null} [opts.groqApiKey=null]
   */
  constructor({
    token,
    prefix           = '!',
    ownerId          = '0',
    consoleChannelId = null,
    premiumData      = null,
    reminderData     = null,
    memoryData       = null,
    groqApiKey       = null,
  }) {
    super({ checkUpdate: false });
    this._token           = token;
    this.prefix           = prefix;
    this.ownerId          = String(ownerId);
    this.consoleChannelId = consoleChannelId ? String(consoleChannelId) : null;
    this.premiumData      = premiumData;
    this.reminderData     = reminderData;
    this.memoryData       = memoryData;
    this.groqApiKey       = groqApiKey || null;
    this._reminderTimer   = null;
    /** @type {Map<string, Array<{role:string,content:string}>>} */
    this._convHistory     = new Map();
    this._setupListeners();
  }

  /** The effective owner ID: explicit config value, or the logged-in account. */
  get effectiveOwnerId() {
    return this.ownerId !== '0' ? this.ownerId : (this.user?.id ?? '0');
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  _setupListeners() {
    this.on('ready',         ()          => this._onReady());
    this.on('messageCreate', (msg)       => this._onMessage(msg).catch(err => log.error(`messageCreate: ${err.stack}`)));
    this.on('messageDelete', (msg)       => trackDeletedMessage(msg));
    this.on('messageUpdate', (old, cur)  => trackEditedMessage(old, cur));
  }

  // ── Startup / reconnect ────────────────────────────────────────────────────

  async startBot() {
    const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
    let delay = 5_000;

    while (true) {
      try {
        await this.login(this._token);
        return; // clean exit (e.g. SIGINT destroyed the client)
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('TOKEN_INVALID') || err.code === 4004) {
          log.error(`Login failed — bad token: ${msg}`);
          return;
        }
        if (err.code && FATAL.has(err.code)) {
          log.error(`Permanent gateway close (${err.code}): ${msg}`);
          return;
        }
        log.warn(`Disconnected — retrying in ${Math.round(delay / 1000)}s`);
      }

      try { await this.destroy(); } catch {}
      await sleep(delay);
      delay = Math.min(delay * 2, 300_000);
    }
  }

  _onReady() {
    log.info(`Logged in as ${this.user.tag} (${this.user.id})`);
    startConsole(this);
    this._startReminderScheduler();
  }

  // ── Reminder scheduler ─────────────────────────────────────────────────────

  _startReminderScheduler() {
    if (!this.reminderData) return;
    this._tickReminders();
    this._reminderTimer = setInterval(() => this._tickReminders(), 30_000);
  }

  async _tickReminders() {
    if (!this.reminderData) return;
    const due = this.reminderData.getDue();
    if (!due.length) return;

    // Resolve each unique channel only once
    const channelCache = new Map();
    for (const reminder of due) {
      if (!channelCache.has(reminder.channelId)) {
        const ch = this.channels.cache.get(reminder.channelId)
          ?? await this.channels.fetch(reminder.channelId).catch(() => null);
        channelCache.set(reminder.channelId, ch);
      }
    }

    for (const reminder of due) {
      const channel = channelCache.get(reminder.channelId);
      try {
        if (channel) {
          await channel.send(`hey <@${reminder.userId}>, just a reminder — ${reminder.message}`);
        } else {
          log.warn(`Reminder ${reminder.id}: channel ${reminder.channelId} not found`);
        }
      } catch (err) {
        log.error(`Reminder ${reminder.id}: ${err.message}`);
      }
      await this.reminderData.remove(reminder.id).catch(() => {});
    }
  }

  // ── Message handler ────────────────────────────────────────────────────────

  async _onMessage(message) {
    if (!this.user) return;
    if (!message.author) return;

    const authorId = message.author.id;
    const botId    = this.user.id;

    const isOwner   = authorId === botId || authorId === this.effectiveOwnerId;
    const isPremium = !isOwner && (this.premiumData?.has(authorId) ?? false);

    // Self-bot: process prefix commands typed by the logged-in account
    if (authorId === botId) {
      if (!message.content?.startsWith(this.prefix)) return;
      const body     = message.content.slice(this.prefix.length);
      const spaceIdx = body.search(/\s/);
      const command  = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase().trim();
      const args     = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trimStart();
      if (!command) return;
      try {
        await handleCommand(this, message, command, args, { isOwner: true, isPremium: false });
      } catch (err) {
        log.error(`Command '${command}': ${err.stack}`);
      }
      return;
    }

    // ── AI agent: handle pings and replies to the bot ──────────────────────
    if (this.groqApiKey) {
      const isMention = message.mentions?.users?.has(botId);
      // Only check reply status when there is no mention to avoid unnecessary API fetches
      const isReply   = !isMention &&
                        message.reference?.messageId != null &&
                        (await this._isBotMessage(message.channel, message.reference.messageId));

      if (isMention || isReply) {
        await this._handleAiInteraction(message);
        return;
      }
    }

    // ── Only process prefix commands from owner ────────────────────────────
    if (!isOwner && !isPremium) return;

    if (!message.content?.startsWith(this.prefix)) return;

    const body     = message.content.slice(this.prefix.length);
    const spaceIdx = body.search(/\s/);
    const command  = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase().trim();
    const args     = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trimStart();

    if (!command) return;

    try {
      await handleCommand(this, message, command, args, { isOwner, isPremium });
    } catch (err) {
      log.error(`Command '${command}': ${err.stack}`);
      try {
        await message.channel.send(`❌ Unexpected error: ${err.message}`);
      } catch {}
    }
  }

  // ── AI agent core ──────────────────────────────────────────────────────────

  /**
   * Full agent turn:
   *   1. Load user memory.
   *   2. Append incoming message to channel history.
   *   3. Call Groq with system prompt + full history.
   *   4. Execute every returned action.
   *   5. Persist any new memory facts.
   *   6. Append the bot's first text response to history.
   */
  async _handleAiInteraction(message) {
    const channelId = message.channel.id;
    const authorId  = message.author.id;

    // 1. Load what we know about this user
    const userFacts = this.memoryData ? this.memoryData.get(authorId) : [];

    // 2. Append the new user message to the rolling channel history
    const prevHistory = this._convHistory.get(channelId) ?? [];
    const history     = [
      ...prevHistory,
      { role: 'user', content: message.content || '' },
    ];

    // 3. Call Groq
    const systemPrompt = buildSystemPrompt(userFacts);
    let result;
    try {
      result = await groqAgent(this.groqApiKey, systemPrompt, history);
    } catch (err) {
      log.error(`groqAgent: ${err.message}`);
      return;
    }

    // 4. Execute all actions in order; collect sent text for history
    const actions   = Array.isArray(result?.actions) ? result.actions : [];
    let firstSentText = null;

    for (const action of actions) {
      if (!action?.action) continue;
      switch (action.action) {
        case 'send':
          if (action.content) {
            await message.channel.send(action.content).catch(() => {});
            firstSentText ??= action.content; // keep first sent text for conversation history
          }
          break;

        case 'react':
          await this._executeReact(message, action);
          break;

        case 'reminder': {
          const sent = await this._executeReminder(message, action);
          firstSentText ??= sent; // keep first sent text for conversation history
          break;
        }
      }
    }

    // 5. Persist memory facts the model identified
    if (this.memoryData && Array.isArray(result?.memory)) {
      for (const item of result.memory) {
        if (item?.userId && item?.fact) {
          await this.memoryData.addFact(String(item.userId), String(item.fact))
            .catch(err => log.error(`memoryData.addFact: ${err.message}`));
        }
      }
    }

    // 6. Update rolling history: user message already added; add bot reply
    const updatedHistory = firstSentText
      ? [...history, { role: 'assistant', content: firstSentText }]
      : history;

    // Cap to keep only the most recent MAX_HISTORY_MSGS messages
    const capped = updatedHistory.length > MAX_HISTORY_MSGS
      ? updatedHistory.slice(-MAX_HISTORY_MSGS)
      : updatedHistory;

    this._convHistory.set(channelId, capped);
  }

  // ── Action executors ───────────────────────────────────────────────────────

  /** Add a single emoji reaction to the target message. */
  async _executeReact(message, action) {
    const emoji = action?.emoji;
    if (!emoji) return;

    // "referenced" → react to the message the user was replying to
    let targetMsg = message;
    if (action.target === 'referenced' && message.reference?.messageId) {
      try {
        targetMsg = await message.channel.messages.fetch(message.reference.messageId);
      } catch {
        targetMsg = message;
      }
    }

    try {
      await targetMsg.react(emoji);
    } catch (err) {
      log.error(`react: ${err.message}`);
      await message.channel.send('Could not add that reaction. Please use a standard Unicode emoji.').catch(() => {});
    }
  }

  /**
   * Store a reminder and send the AI-generated confirmation.
   * @returns {Promise<string|null>} The confirmation text that was sent, or null.
   */
  async _executeReminder(message, action) {
    const confirmation = action?.content ?? null;

    if (action?.remindAt && action?.reminderMsg && this.reminderData) {
      const remindAt = new Date(action.remindAt);
      if (!isNaN(remindAt.getTime()) && remindAt.getTime() > Date.now()) {
        const reminder = {
          id:        makeId(),
          userId:    message.author.id,
          channelId: message.channel.id,
          guildId:   message.guild?.id ?? null,
          remindAt:  remindAt.toISOString(),
          message:   action.reminderMsg,
          createdAt: new Date().toISOString(),
        };
        try {
          await this.reminderData.add(reminder);
          log.info(`Reminder set for ${reminder.userId} at ${reminder.remindAt}: ${reminder.message}`);
        } catch (err) {
          log.error(`Failed to save reminder: ${err.message}`);
        }
      } else {
        log.warn(`groqAgent returned invalid/past remindAt: ${action.remindAt}`);
      }
    }

    if (confirmation) {
      await message.channel.send(confirmation).catch(() => {});
    }
    return confirmation;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /**
   * Check whether a message in the given channel was authored by the bot.
   * Cache is checked first to avoid an unnecessary REST fetch; the API is
   * only called when the message is not already in the local message cache.
   */
  async _isBotMessage(channel, messageId) {
    const resolved = channel.messages?.cache?.get(messageId);
    if (resolved) return resolved.author?.id === this.user?.id;
    try {
      const msg = await channel.messages.fetch(messageId);
      return msg?.author?.id === this.user?.id;
    } catch {
      return false;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async close() {
    if (this._reminderTimer) clearInterval(this._reminderTimer);
    try { await this.destroy(); } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
