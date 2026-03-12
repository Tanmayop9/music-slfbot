/**
 * Reminder storage.
 *
 * JSON layout (data/reminders.json):
 *   {
 *     "reminders": [
 *       {
 *         "id":        "1710233715000-a3f8b2",
 *         "userId":    "123456789",
 *         "channelId": "987654321",
 *         "guildId":   "111111111",  // null for DMs
 *         "remindAt":  "2024-03-15T10:00:00.000Z",
 *         "message":   "Meeting with @user69",
 *         "createdAt": "2024-03-12T08:00:00.000Z"
 *       }
 *     ]
 *   }
 */

export class ReminderData {
  /** @param {import('./store.js').JSONStore} store */
  constructor(store) {
    this._store = store;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  _getAll() {
    return this._store.get('reminders') || [];
  }

  getAll() {
    return [...this._getAll()];
  }

  /**
   * Returns all reminders whose remindAt time is <= now.
   * @param {number} [now=Date.now()]
   */
  getDue(now = Date.now()) {
    return this._getAll().filter(r => new Date(r.remindAt).getTime() <= now);
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * @param {{
   *   id: string,
   *   userId: string,
   *   channelId: string,
   *   guildId: string|null,
   *   remindAt: string,
   *   message: string,
   *   createdAt: string
   * }} reminder
   */
  async add(reminder) {
    await this._store.update('reminders', (current) => {
      return [...(current || []), reminder];
    }, []);
  }

  /** Remove a reminder by its id. */
  async remove(id) {
    await this._store.update('reminders', (current) => {
      return (current || []).filter(r => r.id !== id);
    }, []);
  }
}
