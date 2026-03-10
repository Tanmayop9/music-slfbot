/**
 * Persistent sniper data — targets and claim history.
 *
 * JSON layout (data/sniper.json):
 *   {
 *     "targets": ["code1", "code2", ...],
 *     "history": [
 *       {"code": "...", "guild_id": "...", "latency_ms": 12.3, "ts": "ISO8601"},
 *       ...
 *     ]
 *   }
 */

const MAX_HISTORY = 200;

export class SniperData {
  /** @param {import('./store.js').JSONStore} store */
  constructor(store) {
    this._store = store;
  }

  // ── Targets ────────────────────────────────────────────────────────────────

  getTargets() {
    return new Set(this._store.get('targets') || []);
  }

  async addTarget(code) {
    code = code.toLowerCase().trim();
    const targets = this.getTargets();
    if (targets.has(code)) return false;
    targets.add(code);
    await this._store.set('targets', [...targets].sort());
    return true;
  }

  async removeTarget(code) {
    code = code.toLowerCase().trim();
    const targets = this.getTargets();
    if (!targets.has(code)) return false;
    targets.delete(code);
    await this._store.set('targets', [...targets].sort());
    return true;
  }

  async setTargets(codes) {
    await this._store.set('targets', [...codes].map(c => c.toLowerCase()).sort());
  }

  // ── Claim history ──────────────────────────────────────────────────────────

  getHistory() {
    return [...(this._store.get('history') || [])];
  }

  async addHistory(code, guildId, latencyMs, sourceGuildId = '') {
    const history = this.getHistory();
    history.unshift({
      code,
      guild_id: guildId,
      source_guild_id: sourceGuildId,
      latency_ms: Math.round(latencyMs * 100) / 100,
      ts: new Date().toISOString(),
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await this._store.set('history', history);
  }

  async clearHistory() {
    await this._store.set('history', []);
  }

  historySummary(limit = 10) {
    return this.getHistory()
      .slice(0, limit)
      .map(entry => {
        const ts = (entry.ts || '').slice(0, 19).replace('T', ' ');
        return `\`discord.gg/${entry.code}\`  →  guild \`${entry.guild_id}\`  \`${Math.round(entry.latency_ms)} ms\`  *${ts} UTC*`;
      });
  }
}
