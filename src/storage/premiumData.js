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
    let added = false;
    await this._store.update('users', (current) => {
      const users = new Set(current || []);
      if (users.has(userId)) return [...users]; // no change
      users.add(userId);
      added = true;
      return [...users];
    }, []);
    return added;
  }

  async remove(userId) {
    userId = String(userId);
    let removed = false;
    await this._store.update('users', (current) => {
      const users = new Set(current || []);
      if (!users.has(userId)) return [...users]; // no change
      users.delete(userId);
      removed = true;
      return [...users];
    }, []);
    return removed;
  }
}
