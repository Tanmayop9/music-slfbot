/**
 * VanitySniper — main orchestrator.
 *
 * Wires together:
 *   - Multiple GatewayMonitor instances (one per account) for real-time monitoring
 *   - Multiple VanityClaimer instances (one per account × claim-guild) for instant claiming
 *   - WebhookNotifier for notifications
 *   - ConfigWatcher for live hot-reload of targets
 *   - Public command API so the music bot (or sniper.js) can control everything
 *
 * Claim strategy:
 *   When a watched vanity becomes available every claimer fires in parallel.
 *   The first successful result wins. Failed codes can be re-attempted.
 *   De-duplication prevents double-claim of the same code within the same session.
 */

import { ClaimResult, VanityClaimer } from './claimer.js';
import { GatewayMonitor }             from './gateway.js';
import { ConfigWatcher }              from './watcher.js';
import { WebhookNotifier }            from './webhook.js';
import { createLogger }               from '../logger.js';

const log = createLogger('VanitySniper');

export class SniperStatus {
  constructor({ paused, targets, monitors, claimers, claimed }) {
    this.paused   = paused;
    this.targets  = targets;   // Set<string>
    this.monitors = monitors;  // number
    this.claimers = claimers;  // number
    this.claimed  = claimed;   // string[]
  }
}

export class VanitySniper {
  /**
   * @param {object} config
   * @param {object|null} [sniperData]  SniperData instance for JSON persistence
   */
  constructor(config, sniperData = null) {
    this._config      = config;
    this._sniperCfg   = config.sniper || {};
    this._sniperData  = sniperData;

    // Seed targets: JSON store takes priority over config file
    if (sniperData) {
      this._targets = sniperData.getTargets();
    } else {
      this._targets = new Set(this._sniperCfg.targets || []);
    }

    this._paused    = false;
    this._claimed   = new Set();   // codes claimed this session
    this._claimLog  = [];          // human-readable log of snipes

    this._monitors  = [];
    this._claimers  = [];
    this._notifier  = null;
    this._watcher   = null;
    this._running   = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(configPath = 'config.yaml') {
    this._running = true;
    this._buildComponents(this._sniperCfg);

    // Pre-warm all claimers concurrently
    if (this._claimers.length > 0) {
      await Promise.allSettled(this._claimers.map(c => c.warmUp()));
    }

    // Config hot-reload
    this._watcher = new ConfigWatcher(configPath, cfg => this._onConfigChange(cfg));
    this._watcher.start();

    log.info(
      `[Sniper] Ready — ${this._targets.size} target(s) | ${this._monitors.length} monitor(s) | ${this._claimers.length} claimer(s)`,
    );
  }

  _buildComponents(cfg) {
    // Webhook
    const webhookUrl = cfg.webhook_url || null;
    if (webhookUrl) this._notifier = new WebhookNotifier(webhookUrl);

    // Proxy round-robin
    const proxies = (cfg.proxies && cfg.proxies.length > 0) ? cfg.proxies : [null];

    // MFA
    const mfa            = cfg.mfa || {};
    const mfaEnabled     = Boolean(mfa.enabled);
    const mfaTotpSecret  = mfaEnabled ? (mfa.totp_secret || null) : null;
    const mfaPassword    = mfaEnabled ? (mfa.password    || null) : null;

    // Accounts
    const accounts = cfg.accounts || [];
    for (let idx = 0; idx < accounts.length; idx++) {
      const acc   = accounts[idx];
      const token = acc.token;
      if (!token) continue;

      const proxy = proxies[idx % proxies.length];
      const label = acc.name || `Account-${idx + 1}`;

      // Gateway monitor
      const monitor = new GatewayMonitor({
        token,
        onVanityAvailable: (code, guildId) => this._onVanityAvailable(code, guildId),
        proxy,
        name: label,
      });
      this._monitors.push(monitor);
      monitor.connect().catch(() => {});

      // Claimers — one per (account × claim_guild)
      for (const g of (acc.claim_guilds || [])) {
        const guildId = String(typeof g === 'object' ? (g.id || '') : g);
        const claimer = new VanityClaimer({
          token,
          guildId,
          proxy,
          mfaTotpSecret,
          mfaPassword,
        });
        this._claimers.push(claimer);
      }
    }
  }

  async close() {
    this._running = false;
    if (this._watcher) this._watcher.stop();
    await Promise.allSettled([
      ...this._monitors.map(m => m.close()),
      ...this._claimers.map(c => c.close()),
    ]);
    if (this._notifier) await this._notifier.close();
  }

  // ── Core claim flow ────────────────────────────────────────────────────────

  async _onVanityAvailable(code, sourceGuildId) {
    if (this._paused) {
      log.debug(`[Sniper] Paused — ignoring '${code}'`);
      return;
    }

    // Filter to watched targets (empty = snipe everything)
    if (this._targets.size > 0 && !this._targets.has(code)) return;

    // De-duplicate within this session
    if (this._claimed.has(code)) return;
    this._claimed.add(code);

    log.info(`[Sniper] 🎯 Spotted '${code}' from guild ${sourceGuildId}`);
    if (this._notifier) {
      this._notifier.notifySpotted(code, sourceGuildId).catch(() => {});
    }

    if (this._claimers.length === 0) {
      log.warn('[Sniper] No claimers configured — cannot claim!');
      this._claimed.delete(code);
      return;
    }

    // Fire all claimers in parallel — first success wins
    const t0      = performance.now();
    const results = await Promise.all(this._claimers.map(c => c.claim(code)));

    let winner = null;
    for (const r of results) {
      if (r.success && (winner === null || r.latencyMs < winner.latencyMs)) {
        winner = r;
      }
    }

    if (winner) {
      const entry = `discord.gg/${code} → guild ${winner.guildId} (${Math.round(winner.latencyMs)} ms)`;
      this._claimLog.push(entry);
      log.info(`[Sniper] ✅ ${entry}`);

      if (this._sniperData) {
        this._sniperData.addHistory(code, winner.guildId, winner.latencyMs, sourceGuildId).catch(() => {});
      }
      if (this._notifier) {
        this._notifier.notifySuccess(code, winner.guildId, winner.latencyMs, sourceGuildId).catch(() => {});
      }
      if (this._sniperCfg.auto_leave) {
        await this._autoLeave(sourceGuildId);
      }
    } else {
      const totalMs = performance.now() - t0;
      const reason  = results[0]?.error || 'unknown';
      log.warn(`[Sniper] ❌ Failed to claim '${code}': ${reason}`);
      if (this._notifier) {
        this._notifier.notifyFailure(code, reason, totalMs).catch(() => {});
      }
      // Allow retry
      this._claimed.delete(code);
    }
  }

  async _autoLeave(guildId) {
    for (const monitor of this._monitors) {
      if (!monitor.guilds.has(guildId)) continue;
      try {
        const resp = await fetch(
          `https://discord.com/api/v10/users/@me/guilds/${guildId}`,
          {
            method:  'DELETE',
            headers: { Authorization: monitor.token },
          },
        );
        if (resp.status === 200 || resp.status === 204) {
          log.info(`[Sniper] Auto-left guild ${guildId}`);
          return;
        }
      } catch (err) {
        log.debug(`[Sniper] auto_leave error: ${err.message}`);
      }
    }
  }

  // ── Hot-reload ─────────────────────────────────────────────────────────────

  _onConfigChange(newConfig) {
    const newTargets = new Set((newConfig?.sniper?.targets || []));
    const added   = [...newTargets].filter(t => !this._targets.has(t));
    const removed = [...this._targets].filter(t => !newTargets.has(t));
    this._targets = newTargets;
    if (added.length)   log.info(`[Sniper] Hot-reload ➕ new targets: ${added.join(', ')}`);
    if (removed.length) log.info(`[Sniper] Hot-reload ➖ removed targets: ${removed.join(', ')}`);
  }

  // ── Public command API ─────────────────────────────────────────────────────

  addTarget(code) {
    code = code.toLowerCase().trim();
    if (this._targets.has(code)) return false;
    this._targets.add(code);
    return true;
  }

  removeTarget(code) {
    code = code.toLowerCase().trim();
    if (!this._targets.has(code)) return false;
    this._targets.delete(code);
    this._claimed.delete(code);
    return true;
  }

  pause() {
    this._paused = true;
    log.info('[Sniper] Paused');
  }

  resume() {
    this._paused = false;
    log.info('[Sniper] Resumed');
  }

  status() {
    return new SniperStatus({
      paused:   this._paused,
      targets:  new Set(this._targets),
      monitors: this._monitors.length,
      claimers: this._claimers.length,
      claimed:  [...this._claimLog],
    });
  }

  clearHistory() {
    this._claimLog.length = 0;
    this._claimed.clear();
  }

  get targets()       { return new Set(this._targets); }
  get paused()        { return this._paused; }
  get claimerGuilds() { return this._claimers.map(c => c.guildId); }
}
