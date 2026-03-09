/**
 * Discord Gateway monitor for vanity URL sniping.
 *
 * Maintains a persistent WebSocket connection to Discord's gateway using a user
 * token, tracks every guild's vanity_url_code, and calls `onVanityAvailable`
 * whenever a vanity is released (GUILD_UPDATE code change or GUILD_DELETE).
 *
 * Features:
 *   - Automatic session RESUME on reconnect (no re-identify penalty)
 *   - Jittered heartbeat to match Discord client behaviour
 *   - Thread-safe design using async functions
 */

import WebSocket from 'ws';
import { createLogger } from '../logger.js';

const log = createLogger('GatewayMonitor');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP_DISPATCH       = 0;
const OP_HEARTBEAT      = 1;
const OP_IDENTIFY       = 2;
const OP_RESUME         = 6;
const OP_HELLO          = 10;
const OP_HEARTBEAT_ACK  = 11;
const OP_INVALID_SESSION = 9;
const OP_RECONNECT       = 7;

const CLIENT_PROPERTIES = {
  os:                   'Windows',
  browser:              'Discord Client',
  device:               '',
  system_locale:        'en-US',
  browser_user_agent:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  browser_version:      '122.0.0.0',
  os_version:           '10',
  referrer:             '',
  referring_domain:     '',
  release_channel:      'stable',
  client_build_number:  281337,
};

export class GatewayMonitor {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {(code: string, sourceGuildId: string) => Promise<void>} opts.onVanityAvailable
   * @param {string|null} [opts.proxy]
   * @param {string} [opts.name]
   */
  constructor({ token, onVanityAvailable, proxy = null, name = 'Monitor' }) {
    this.token             = token;
    this.onVanityAvailable = onVanityAvailable;
    this.proxy             = proxy;
    this.name              = name;

    this._ws             = null;
    this._heartbeatTimer = null;
    this._sequence       = null;
    this._sessionId      = null;
    this._resumeUrl      = null;
    this._lastAck        = 0;
    this._latency        = 0;
    this._running        = false;

    // Guild vanity tracking: guildId -> vanityCode (or "")
    this._vanityMap = new Map();
    // All guild IDs this account belongs to (used for auto-leave)
    this.guilds = new Set();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect() {
    this._running = true;
    this._loop().catch(() => {});
  }

  async close() {
    this._running = false;
    this._cancelHeartbeat();
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }

  get latency() { return this._latency; }

  // ── Connection loop ────────────────────────────────────────────────────────

  async _loop() {
    let backoff = 1.0;
    while (this._running) {
      try {
        await this._connectAndListen();
        backoff = 1.0;
      } catch (err) {
        log.warn(`[${this.name}] Gateway error: ${err.message} — reconnecting in ${Math.round(backoff)}s`);
        await sleep(backoff * 1000);
        backoff = Math.min(backoff * 2, 60.0);
      }
    }
  }

  async _connectAndListen() {
    const url = this._resumeUrl || GATEWAY_URL;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: 0 });
      this._ws = ws;

      ws.once('open', () => {
        log.debug(`[${this.name}] WebSocket connected (${url})`);
        resolve();
      });
      ws.once('error', reject);

      ws.on('message', async (data) => {
        try {
          await this._handle(JSON.parse(data));
        } catch {}
      });

      ws.on('close', (code, reason) => {
        this._cancelHeartbeat();
        log.debug(`[${this.name}] WS closed: ${code} ${reason}`);
        // If not resolved yet (early close), reject
        reject(new Error(`WS closed with code ${code}`));
      });
    });

    // Wait until the WS closes
    await new Promise((resolve) => {
      if (this._ws.readyState === WebSocket.CLOSED) {
        resolve();
      } else {
        this._ws.once('close', resolve);
        this._ws.once('error', resolve);
      }
    });
  }

  // ── Opcode handling ────────────────────────────────────────────────────────

  async _handle(data) {
    const op  = data.op ?? -1;
    const seq = data.s;
    if (seq !== null && seq !== undefined) this._sequence = seq;

    if (op === OP_HELLO) {
      const intervalMs = data.d?.heartbeat_interval ?? 41250;
      this._cancelHeartbeat();
      this._startHeartbeat(intervalMs / 1000);
      await this._identifyOrResume();

    } else if (op === OP_HEARTBEAT_ACK) {
      this._latency = (performance.now() - this._lastAck);

    } else if (op === OP_HEARTBEAT) {
      await this._sendHeartbeat();

    } else if (op === OP_DISPATCH) {
      await this._dispatch(data.t, data.d || {});

    } else if (op === OP_INVALID_SESSION) {
      const canResume = !!data.d;
      if (!canResume) {
        this._sessionId = null;
        this._sequence  = null;
      }
      log.warn(`[${this.name}] Invalid session (resumable=${canResume})`);
      await sleep(2000);

    } else if (op === OP_RECONNECT) {
      log.debug(`[${this.name}] Server requested reconnect`);
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.close();
      }
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  _startHeartbeat(intervalSec) {
    // Jitter: first beat at a random offset [0, interval)
    const jitter = Math.random() * intervalSec * 1000;
    this._heartbeatTimer = setTimeout(async () => {
      await this._sendHeartbeat();
      this._heartbeatTimer = setInterval(async () => {
        await this._sendHeartbeat();
      }, intervalSec * 1000);
    }, jitter);
  }

  async _sendHeartbeat() {
    this._lastAck = performance.now();
    await this._send({ op: OP_HEARTBEAT, d: this._sequence });
  }

  _cancelHeartbeat() {
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── Identify / Resume ──────────────────────────────────────────────────────

  async _identifyOrResume() {
    if (this._sessionId && this._sequence !== null) {
      log.debug(`[${this.name}] Resuming session ${this._sessionId}`);
      await this._send({
        op: OP_RESUME,
        d: {
          token:      this.token,
          session_id: this._sessionId,
          seq:        this._sequence,
        },
      });
    } else {
      log.debug(`[${this.name}] Identifying`);
      await this._send({
        op: OP_IDENTIFY,
        d: {
          token:        this.token,
          capabilities: 16381,
          properties:   CLIENT_PROPERTIES,
          presence: {
            status:     'online',
            since:      0,
            activities: [],
            afk:        false,
          },
          compress:     false,
          client_state: {
            guild_versions:                {},
            highest_last_message_id:       '0',
            read_state_version:            0,
            user_guild_settings_version:   -1,
            user_settings_version:         -1,
            private_channels_version:      '0',
            api_code_version:              0,
          },
        },
      });
    }
  }

  // ── Event dispatch ─────────────────────────────────────────────────────────

  async _dispatch(event, data) {
    if (event === 'READY') {
      this._sessionId = data.session_id;
      this._resumeUrl = data.resume_gateway_url;
      const user = data.user || {};
      log.info(
        `[${this.name}] Ready as ${user.username}#${user.discriminator || '0'} — tracking ${(data.guilds || []).length} guilds`,
      );
      for (const g of (data.guilds || [])) {
        const gid  = g.id || '';
        if (!gid) continue;
        this.guilds.add(gid);
        const code = g.vanity_url_code || '';
        if (code) this._vanityMap.set(gid, code);
      }

    } else if (event === 'RESUMED') {
      log.debug(`[${this.name}] Session resumed`);

    } else if (event === 'GUILD_CREATE') {
      const gid  = data.id || '';
      if (gid) {
        this.guilds.add(gid);
        const code = data.vanity_url_code || '';
        if (code) this._vanityMap.set(gid, code);
      }

    } else if (event === 'GUILD_UPDATE') {
      await this._handleGuildUpdate(data);

    } else if (event === 'GUILD_DELETE') {
      await this._handleGuildDelete(data);
    }
  }

  async _handleGuildUpdate(data) {
    const gid = data.id || '';
    if (!gid) return;

    const newCode = data.vanity_url_code || '';
    const oldCode = this._vanityMap.get(gid) || '';

    if (newCode) {
      this._vanityMap.set(gid, newCode);
    } else {
      this._vanityMap.delete(gid);
    }

    if (oldCode && oldCode !== newCode) {
      log.info(`[${this.name}] 🔓 Vanity '${oldCode}' released from guild ${gid}`);
      this.onVanityAvailable(oldCode, gid).catch(() => {});
    }
  }

  async _handleGuildDelete(data) {
    const gid = data.id || '';
    if (!gid) return;
    const code = this._vanityMap.get(gid) || '';
    this._vanityMap.delete(gid);
    this.guilds.delete(gid);
    if (code) {
      log.info(`[${this.name}] 🔓 Guild ${gid} deleted — vanity '${code}' released`);
      this.onVanityAvailable(code, gid).catch(() => {});
    }
  }

  // ── WS send helper ─────────────────────────────────────────────────────────

  async _send(payload) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify(payload));
      } catch (err) {
        log.debug(`[${this.name}] send error: ${err.message}`);
      }
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
