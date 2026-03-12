/**
 * Per-user persistent memory store.
 *
 * The agent calls addFact() when it learns something about a user, and
 * get() to load those facts into the system prompt before each interaction.
 *
 * JSON layout (data/memory.json):
 *   {
 *     "userId1": ["name is Rahul", "likes cricket", "from Mumbai"],
 *     "userId2": ["prefers chai over coffee"]
 *   }
 */

/** Maximum facts kept per user — oldest are pruned when the limit is reached. */
const MAX_FACTS = 20;

export class MemoryData {
  /** @param {import('./store.js').JSONStore} store */
  constructor(store) {
    this._store = store;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Returns the list of remembered facts for a user (may be empty).
   * @param {string} userId
   * @returns {string[]}
   */
  get(userId) {
    const data = this._store.get(String(userId));
    return Array.isArray(data) ? data : [];
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Append a new fact about a user.  Duplicate facts are silently ignored.
   * When the cap is reached the oldest fact is dropped.
   *
   * @param {string} userId
   * @param {string} fact  Short descriptive sentence, no emojis.
   */
  async addFact(userId, fact) {
    userId = String(userId);
    await this._store.update(userId, (current) => {
      const facts = Array.isArray(current) ? current : [];
      if (facts.includes(fact)) return facts;
      const updated = [...facts, fact];
      return updated.length > MAX_FACTS ? updated.slice(-MAX_FACTS) : updated;
    }, []);
  }

  /**
   * Wipe all remembered facts for a user.
   * @param {string} userId
   */
  async clear(userId) {
    await this._store.delete(String(userId));
  }
}
