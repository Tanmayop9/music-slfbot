/**
 * Premium user storage.
 *
 * JSON layout (data/premium.json):
 *   { "users": ["userId1", "userId2", ...] }
 */

export class PremiumData {
  /** @param {import('./store.js').JSONStore} store */
  constructor(store) {
    this._store = store;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  _getSet() {
    return new Set(this._store.get('users') || []);
  }

  has(userId) {
    return this._getSet().has(String(userId));
  }

  list() {
    return [...this._getSet()];
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  async add(userId) {
    userId = String(userId);
    const users = this._getSet();
    if (users.has(userId)) return false;
    users.add(userId);
    await this._store.set('users', [...users]);
    return true;
  }

  async remove(userId) {
    userId = String(userId);
    const users = this._getSet();
    if (!users.has(userId)) return false;
    users.delete(userId);
    await this._store.set('users', [...users]);
    return true;
  }
}
