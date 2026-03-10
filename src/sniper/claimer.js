/**
 * Pre-warmed Discord REST claimer for ultra-low-latency vanity URL claiming.
 *
 * Key design choices for speed:
 *   - Persistent keep-alive connection — TCP+TLS already open.
 *   - Pre-warm GET keeps the connection alive before the race starts.
 *   - MFA/TOTP generated inline — no external library needed.
 *   - Proxy support via HTTP CONNECT tunnelling (http-proxy-agent).
 */

import crypto from 'node:crypto';
import https from 'node:https';
import { createLogger } from '../logger.js';

const log = createLogger('VanityClaimer');

const DISCORD_API = 'https://discord.com/api/v10';

// ── TOTP (RFC 6238) — generated inline, no external libraries required ────────

/**
 * Generate a 6-digit TOTP code from a base32 secret (RFC 6238 / SHA-1).
 * @param {string} secretB32
 * @param {number} interval  time step in seconds (default 30)
 * @returns {string}  6-digit code (zero-padded)
 */
function totp(secretB32, interval = 30) {
  const key = base32Decode(secretB32.toUpperCase().replace(/\s/g, ''));
  const counter = Math.floor(Date.now() / 1000 / interval);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));
  const hmac   = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output = [];
  for (const char of s.replace(/=/g, '')) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// ── Result type ───────────────────────────────────────────────────────────────

export class ClaimResult {
  constructor({ success, code, guildId, latencyMs, error = null }) {
    this.success   = success;
    this.code      = code;
    this.guildId   = guildId;
    this.latencyMs = latencyMs;
    this.error     = error;
  }

  toString() {
    const status = this.success ? '✅' : '❌';
    const errStr = this.error ? `  [${this.error}]` : '';
    return `${status} discord.gg/${this.code}  guild=${this.guildId}  ${this.latencyMs.toFixed(1)} ms${errStr}`;
  }
}

// ── Claimer ───────────────────────────────────────────────────────────────────

const CLAIM_HEADERS = {
  'Content-Type':       'application/json',
  'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRGlzY29yZCBDbGllbnQiLCJyZWxlYXNlX2NoYW5uZWwiOiJzdGFibGUifQ==',
};

export class VanityClaimer {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {string} opts.guildId
   * @param {string|null} [opts.proxy]
   * @param {string|null} [opts.mfaTotpSecret]
   * @param {string|null} [opts.mfaPassword]
   */
  constructor({ token, guildId, proxy = null, mfaTotpSecret = null, mfaPassword = null }) {
    this.token         = token;
    this.guildId       = String(guildId);
    this.proxy         = proxy;
    this.mfaTotpSecret = mfaTotpSecret;
    this.mfaPassword   = mfaPassword;

    this._url   = `${DISCORD_API}/guilds/${this.guildId}/vanity-url`;
    // Keep-alive agent for connection reuse
    this._agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
    this._warmed = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async warmUp() {
    if (this._warmed) return;
    try {
      const resp = await this._fetchWithAgent('GET', this._url, null, {});
      await resp.text(); // drain so the socket is reused
      this._warmed = true;
      log.debug(`[Claimer ${this.guildId}] Connection pre-warmed`);
    } catch (err) {
      log.debug(`[Claimer ${this.guildId}] Pre-warm GET: ${err.message} (harmless)`);
    }
  }

  async close() {
    this._agent.destroy();
  }

  // ── Claim ──────────────────────────────────────────────────────────────────

  async claim(code) {
    if (!this._warmed) await this.warmUp();

    const extraHeaders = {};
    if (this.mfaTotpSecret) {
      try {
        extraHeaders['X-Discord-MFA-Authorization'] = totp(this.mfaTotpSecret);
      } catch (err) {
        log.warn(`[Claimer ${this.guildId}] TOTP error: ${err.message}`);
      }
    } else if (this.mfaPassword) {
      extraHeaders['X-Discord-MFA-Authorization'] = this.mfaPassword;
    }

    const t0 = performance.now();
    try {
      const resp = await this._fetchWithAgent(
        'PATCH',
        this._url,
        JSON.stringify({ code }),
        extraHeaders,
      );
      const latencyMs = performance.now() - t0;
      const body = await resp.json().catch(() => ({}));

      if (resp.status === 200) {
        log.info(`[Claimer ${this.guildId}] ✅ Claimed 'discord.gg/${code}' in ${latencyMs.toFixed(1)} ms`);
        return new ClaimResult({ success: true, code, guildId: this.guildId, latencyMs });
      }

      const error = body.message || JSON.stringify(body);
      log.warn(`[Claimer ${this.guildId}] ❌ HTTP ${resp.status} — ${error} (${latencyMs.toFixed(1)} ms)`);
      return new ClaimResult({
        success: false, code, guildId: this.guildId, latencyMs,
        error: `HTTP ${resp.status}: ${error}`,
      });
    } catch (err) {
      const latencyMs = performance.now() - t0;
      log.error(`[Claimer ${this.guildId}] Request exception: ${err.message}`);
      return new ClaimResult({ success: false, code, guildId: this.guildId, latencyMs, error: err.message });
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _fetchWithAgent(method, url, body, extraHeaders) {
    const headers = {
      ...CLAIM_HEADERS,
      Authorization: this.token,
      ...extraHeaders,
    };

    const init = {
      method,
      headers,
    };
    if (body !== null) init.body = body;

    // Use undici/fetch with the keep-alive agent
    return fetch(url, { ...init, agent: this._agent }).catch(() => {
      // Fallback if agent param isn't supported by the runtime's fetch
      return fetch(url, init);
    });
  }
}
