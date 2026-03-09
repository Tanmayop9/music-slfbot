/**
 * Per-guild persistent settings.
 *
 * Keys stored per guild:
 *   volume     number  (0-200, default 100)
 *   loop_mode  string  ("none"|"track"|"queue", default "none")
 *   prefix     string  (optional per-guild prefix override)
 */

const DEFAULTS = {
  volume: 100,
  loop_mode: 'none',
};

export class GuildSettings {
  /** @param {import('./store.js').JSONStore} store */
  constructor(store) {
    this._store = store;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  get(guildId, key, defaultValue = null) {
    const guildData = this._store.get(String(guildId)) || {};
    if (Object.prototype.hasOwnProperty.call(guildData, key)) return guildData[key];
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return DEFAULTS[key];
    return defaultValue;
  }

  getAll(guildId) {
    return { ...DEFAULTS, ...(this._store.get(String(guildId)) || {}) };
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  async set(guildId, key, value) {
    const guildData = { ...(this._store.get(String(guildId)) || {}) };
    guildData[key] = value;
    await this._store.set(String(guildId), guildData);
  }

  async setMany(guildId, updates) {
    const guildData = { ...(this._store.get(String(guildId)) || {}), ...updates };
    await this._store.set(String(guildId), guildData);
  }

  async reset(guildId) {
    await this._store.delete(String(guildId));
  }

  // ── Shortcuts ──────────────────────────────────────────────────────────────

  volume(guildId) {
    return Number(this.get(guildId, 'volume', 100));
  }

  loopMode(guildId) {
    return String(this.get(guildId, 'loop_mode', 'none'));
  }

  prefix(guildId) {
    return this.get(guildId, 'prefix', null);
  }

  async saveVolume(guildId, volume) {
    await this.set(guildId, 'volume', volume);
  }

  async saveLoopMode(guildId, mode) {
    await this.set(guildId, 'loop_mode', mode);
  }
}
