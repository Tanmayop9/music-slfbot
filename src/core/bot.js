/**
 * SelfBot — discord.js-selfbot-v13 Client subclass.
 *
 * Responsibilities:
 *   - Dispatch commands to owner (full access).
 *   - Track deleted + edited messages for snipe commands.
 *   - AI agent: when anyone pings or replies to the bot, Groq AI figures out
 *     the intent and executes the right Discord action:
 *       • send    — reply / mock / roast / chat / compliment / any text action
 *       • react   — add an emoji reaction to a message
 *       • reminder — store a timed reminder and confirm it
 *   - Fire due reminders on a 30-second tick.
 *   - Reconnect automatically on transient disconnects.
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
const GROQ_MAX_TOKENS = 300;

/**
 * System prompt injected with the current UTC time.
 *
 * The AI must return a JSON object with one of three shapes:
 *
 *   send action (default for most requests — mocking, roasting, chatting, replying, etc.)
 *     { "action": "send", "content": "<text to send, no emojis>" }
 *
 *   react action (user asks the bot to react to a message with an emoji)
 *     { "action": "react", "emoji": "<single unicode emoji>", "target": "current" | "referenced" }
 *     target = "referenced" when the user is replying to another message and wants
 *     the bot to react to THAT message; otherwise "current" to react to the user's own message.
 *
 *   reminder action (user wants to be reminded about something at a specific time)
 *     { "action": "reminder", "remindAt": "<ISO 8601 UTC>", "reminderMsg": "<what to remind>", "content": "<casual confirmation, no emojis>" }
 */
function buildSystemPrompt() {
  const now = new Date().toISOString();
  return (
    `You are an intelligent, witty, slightly naughty Discord bot assistant. Current UTC time: ${now}. ` +
    `A user is talking to you. Understand their request and respond with a JSON object describing the action to take. ` +
    `\n\n` +
    `ACTION TYPES:\n` +
    `1. send — use for: mocking someone, roasting someone, chatting, replying, complimenting, commenting on a message, any text-based task. ` +
    `   JSON: {"action":"send","content":"<the text, no emojis, punchy and human>"}\n` +
    `2. react — use when the user explicitly asks to react/add a reaction/emoji to a message. ` +
    `   target is "referenced" if they want to react to the message they are replying to, otherwise "current". ` +
    `   JSON: {"action":"react","emoji":"<one unicode emoji>","target":"current"}\n` +
    `3. reminder — use when the user wants to be reminded about something at a future time. ` +
    `   JSON: {"action":"reminder","remindAt":"<ISO 8601 UTC datetime>","reminderMsg":"<concise reminder text>","content":"<casual confirmation, no emojis>"}\n` +
    `\n` +
    `RULES:\n` +
    `- For mock/roast: be creative, savage, and funny.\n` +
    `- Never use emojis in "content" or "reminderMsg" fields.\n` +
    `- Keep text short and punchy (1-3 sentences max).\n` +
    `- Respond with valid JSON only, nothing else.`
  );
}

/**
 * Call the Groq chat completion API and return the parsed intent object.
 *
 * @param {string} apiKey
 * @param {string} userMessage
 * @returns {Promise<object>}
 */
async function groqIntent(apiKey, userMessage) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:           GROQ_MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user',   content: userMessage || 'hey' },
      ],
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
    return JSON.parse(content);
  } catch {
    return { action: 'send', content: content };
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
   * @param {string|null} [opts.groqApiKey=null]
   */
  constructor({
    token,
    prefix           = '!',
    ownerId          = '0',
    consoleChannelId = null,
    premiumData      = null,
    reminderData     = null,
    groqApiKey       = null,
  }) {
    super({ checkUpdate: false });
    this._token           = token;
    this.prefix           = prefix;
    this.ownerId          = String(ownerId);
    this.consoleChannelId = consoleChannelId ? String(consoleChannelId) : null;
    this.premiumData      = premiumData;
    this.reminderData     = reminderData;
    this.groqApiKey       = groqApiKey || null;
    this._reminderTimer   = null;
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
        return;
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
        const channel = this.channels.cache.get(reminder.channelId)
          ?? await this.channels.fetch(reminder.channelId).catch(() => null);
        channelCache.set(reminder.channelId, channel);
      }
    }

    for (const reminder of due) {
      const channel = channelCache.get(reminder.channelId);
      try {
        if (channel) {
          await channel.send(
            `hey <@${reminder.userId}>, just a reminder — ${reminder.message}`,
          );
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
        await message.channel.send(`Unexpected error: ${err.message}`);
      } catch {}
    }
  }

  // ── AI interaction dispatcher ──────────────────────────────────────────────

  /**
   * Ask Groq to classify the message intent and execute the right action:
   *   send     → post a text message (mock, roast, chat, any text task)
   *   react    → add an emoji reaction to a message
   *   reminder → store a timed reminder and send a confirmation
   */
  async _handleAiInteraction(message) {
    let intent;
    try {
      intent = await groqIntent(this.groqApiKey, message.content);
    } catch (err) {
      log.error(`groqIntent: ${err.message}`);
      return;
    }

    const action = intent?.action ?? 'send';

    switch (action) {
      case 'react':
        await this._executeReact(message, intent);
        break;

      case 'reminder':
        await this._executeReminder(message, intent);
        break;

      case 'send':
      default:
        if (intent?.content) {
          await message.channel.send(intent.content).catch(() => {});
        }
        break;
    }
  }

  /** Add an emoji reaction to the target message. */
  async _executeReact(message, intent) {
    const emoji = intent?.emoji;
    if (!emoji) return;

    // "referenced" → react to the message the user was replying to;
    // "current"    → react to the user's own message.
    let targetMessage = message;
    if (intent.target === 'referenced' && message.reference?.messageId) {
      try {
        targetMessage = await message.channel.messages.fetch(message.reference.messageId);
      } catch {
        targetMessage = message;
      }
    }

    try {
      await targetMessage.react(emoji);
    } catch (err) {
      log.error(`react: ${err.message}`);
      // Fall back to telling the user we couldn't do it
      await message.channel.send('could not add that reaction, use a standard unicode emoji').catch(() => {});
    }
  }

  /** Store a reminder and send the AI-generated confirmation. */
  async _executeReminder(message, intent) {
    const confirmation = intent?.content;

    if (intent?.remindAt && intent?.reminderMsg && this.reminderData) {
      const remindAt = new Date(intent.remindAt);
      if (!isNaN(remindAt.getTime()) && remindAt.getTime() > Date.now()) {
        const reminder = {
          id:        makeId(),
          userId:    message.author.id,
          channelId: message.channel.id,
          guildId:   message.guild?.id ?? null,
          remindAt:  remindAt.toISOString(),
          message:   intent.reminderMsg,
          createdAt: new Date().toISOString(),
        };
        try {
          await this.reminderData.add(reminder);
          log.info(`Reminder set for ${reminder.userId} at ${reminder.remindAt}: ${reminder.message}`);
        } catch (err) {
          log.error(`Failed to save reminder: ${err.message}`);
        }
      } else {
        log.warn(`groqIntent returned invalid/past remindAt: ${intent.remindAt}`);
      }
    }

    if (confirmation) {
      await message.channel.send(confirmation).catch(() => {});
    }
  }

  /** Check whether a message in the given channel was authored by the bot. */
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


