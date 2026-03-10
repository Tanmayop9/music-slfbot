/**
 * SelfBot — discord.js-selfbot-v13 Client subclass.
 *
 * Responsibilities:
 *   - Dispatch commands to owner (full access) and premium users (open commands).
 *   - Track deleted + edited messages for snipe commands.
 *   - Handle AFK: auto-reply to mentions of AFK users; clear AFK on next message.
 *   - Reconnect automatically on transient disconnects.
 */

import { Client } from 'discord.js-selfbot-v13';
import { handleCommand } from './commands.js';
import { trackDeletedMessage, trackEditedMessage } from '../handlers/snipe.js';
import { getAfkData, clearAfk } from '../handlers/misc.js';
import { createLogger } from '../logger.js';

const log = createLogger('SelfBot');

export class SelfBot extends Client {
  /**
   * @param {object}  opts
   * @param {string}  opts.token
   * @param {string}  [opts.prefix='!']
   * @param {string}  [opts.ownerId='0']
   * @param {import('../storage/premiumData.js').PremiumData|null} [opts.premiumData]
   */
  constructor({ token, prefix = '!', ownerId = '0', premiumData = null }) {
    super({ checkUpdate: false });
    this._token      = token;
    this.prefix      = prefix;
    this.ownerId     = String(ownerId);
    this.premiumData = premiumData;
    this._setupListeners();
  }

  /** The effective owner ID: explicit config value, or the logged-in account. */
  get effectiveOwnerId() {
    return this.ownerId !== '0' ? this.ownerId : (this.user?.id ?? '0');
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  _setupListeners() {
    this.on('ready',         ()          => this._onReady());
    this.on('messageCreate', (msg)       => this._onMessage(msg).catch(() => {}));
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
  }

  // ── Message handler ────────────────────────────────────────────────────────

  async _onMessage(message) {
    if (!this.user) return;
    if (!message.author) return;

    const authorId  = message.author.id;
    const isOwner   = authorId === this.effectiveOwnerId;
    const isPremium = !isOwner && (this.premiumData?.has(authorId) ?? false);

    // ── AFK: auto-reply when someone mentions an AFK user ─────────────────
    // Runs for ALL messages in guild channels (not just owner/premium).
    if (message.guild && message.mentions?.users?.size) {
      for (const [uid, mentionedUser] of message.mentions.users) {
        if (uid === authorId) continue;         // ignore self-mention
        if (uid === this.user.id) continue;     // ignore mentions of the bot itself
        const afk = getAfkData(uid);
        if (!afk) continue;
        const since = Math.floor(afk.since / 1000);
        message.channel.send(
          `💤 **${mentionedUser.username}** is AFK: ${afk.reason} — <t:${since}:R>`,
        ).catch(() => {});
      }
    }

    // ── Only process commands from owner / premium ─────────────────────────
    if (!isOwner && !isPremium) return;

    // ── AFK: remove when owner/premium sends any message ──────────────────
    if (getAfkData(authorId)) {
      clearAfk(authorId);
      message.channel.send('✅ Welcome back! Your AFK has been removed.').catch(() => {});
    }

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

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async close() {
    try { await this.destroy(); } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
