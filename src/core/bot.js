/**
 * SelfBot — discord.js-selfbot-v13 Client subclass.
 *
 * Responsibilities:
 *   - Dispatch commands to owner (full access).
 *   - Track deleted + edited messages for snipe commands.
 *   - Auto-reply with a Groq AI 1-liner when someone pings or replies to the bot.
 *   - Reconnect automatically on transient disconnects.
 */

import { Client } from 'discord.js-selfbot-v13';
import { handleCommand } from './commands.js';
import { startConsole } from './console.js';
import { trackDeletedMessage, trackEditedMessage } from '../handlers/snipe.js';
import { createLogger } from '../logger.js';

const log = createLogger('SelfBot');

// ── Groq AI helper ─────────────────────────────────────────────────────────

const GROQ_API_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL    = 'llama3-8b-8192';
const GROQ_MAX_TOKENS = 80;

const SYSTEM_PROMPT =
  'You are a witty, slightly naughty, and playfully cheeky person chatting on Discord. ' +
  'When someone mentions or talks to you, reply with a single short sentence. ' +
  'Sound natural and human, be a little naughty or flirtatious, and never use emojis or special characters.';

async function groqReply(apiKey, userMessage) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:      GROQ_MODEL,
      messages: [
        { role: 'system',  content: SYSTEM_PROMPT },
        { role: 'user',    content: userMessage || 'hey' },
      ],
      max_tokens:   GROQ_MAX_TOKENS,
      temperature:  0.9,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

export class SelfBot extends Client {
  /**
   * @param {object}  opts
   * @param {string}  opts.token
   * @param {string}  [opts.prefix='!']
   * @param {string}  [opts.ownerId='0']
   * @param {string|null} [opts.consoleChannelId=null]
   * @param {import('../storage/premiumData.js').PremiumData|null} [opts.premiumData]
   * @param {string|null} [opts.groqApiKey=null]
   */
  constructor({ token, prefix = '!', ownerId = '0', consoleChannelId = null, premiumData = null, groqApiKey = null }) {
    super({ checkUpdate: false });
    this._token           = token;
    this.prefix           = prefix;
    this.ownerId          = String(ownerId);
    this.consoleChannelId = consoleChannelId ? String(consoleChannelId) : null;
    this.premiumData      = premiumData;
    this.groqApiKey       = groqApiKey || null;
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
    // Codes that indicate a permanent failure — no point retrying
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
      delay = Math.min(delay * 2, 300_000); // cap at 5 min
    }
  }

  _onReady() {
    log.info(`Logged in as ${this.user.tag} (${this.user.id})`);
    startConsole(this);
  }

  // ── Message handler ────────────────────────────────────────────────────────

  async _onMessage(message) {
    if (!this.user) return;
    if (!message.author) return;

    const authorId = message.author.id;
    const botId    = this.user.id;

    const isOwner   = authorId === botId || authorId === this.effectiveOwnerId;
    const isPremium = !isOwner && (this.premiumData?.has(authorId) ?? false);

    // Never auto-reply to our own messages (but still process owner commands below)
    if (authorId === botId) {
      // Self-bot: still process commands typed by the logged-in account
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

    // ── Groq AI auto-reply: ping or reply to bot ───────────────────────────
    if (this.groqApiKey) {
      const isMention  = message.mentions?.users?.has(botId);
      const isReply    = message.reference?.messageId != null &&
                         (await this._isBotMessage(message.channel, message.reference.messageId));

      if (isMention || isReply) {
        try {
          const reply = await groqReply(this.groqApiKey, message.content);
          if (reply) {
            await message.channel.send(reply);
          }
        } catch (err) {
          log.error(`groqReply: ${err.message}`);
        }
        return; // don't fall through to command processing
      }
    }

    // ── Only process commands from owner ──────────────────────────────────
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

  /** Check whether a message in the given channel was authored by the bot. */
  async _isBotMessage(channel, messageId) {
    // Use the already-resolved reference message if available (no extra API call)
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
    try { await this.destroy(); } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
