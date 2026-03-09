/**
 * Queue with loop modes (none / track / queue), shuffle, remove, and move.
 */

export const LoopMode = Object.freeze({
  NONE:  'none',
  TRACK: 'track',
  QUEUE: 'queue',
});

export class Queue {
  constructor(maxSize = 500) {
    this._tracks  = [];
    this._history = [];
    this.loopMode = LoopMode.NONE;
    this.maxSize  = maxSize;
  }

  // ── Properties ─────────────────────────────────────────────────────────────

  get tracks()          { return [...this._tracks]; }
  get size()            { return this._tracks.length; }
  get isEmpty()         { return this._tracks.length === 0; }
  get totalDurationMs() { return this._tracks.reduce((s, t) => s + (t.info?.length ?? 0), 0); }
  get history()         { return [...this._history]; }

  // ── Adding tracks ──────────────────────────────────────────────────────────

  add(track) {
    if (this._tracks.length >= this.maxSize) return false;
    this._tracks.push(track);
    return true;
  }

  addMany(tracks) {
    let added = 0;
    for (const track of tracks) {
      if (!this.add(track)) break;
      added++;
    }
    return added;
  }

  // ── Consuming tracks ───────────────────────────────────────────────────────

  /**
   * Dequeue the next track, honouring the current loop mode.
   * @param {import('../lavalink/models.js').Track|null} current
   * @returns {import('../lavalink/models.js').Track|null}
   */
  getNext(current = null) {
    if (this.loopMode === LoopMode.TRACK && current !== null) {
      return current;
    }

    if (this._tracks.length === 0) return null;

    const track = this._tracks.shift();

    if (current !== null) {
      this._history.push(current);
      if (this._history.length > 50) this._history.shift();
    }

    if (this.loopMode === LoopMode.QUEUE) {
      this._tracks.push(track);
    }

    return track;
  }

  remove(index) {
    if (index >= 0 && index < this._tracks.length) {
      return this._tracks.splice(index, 1)[0];
    }
    return null;
  }

  clear() {
    this._tracks.length = 0;
  }

  // ── Reordering ─────────────────────────────────────────────────────────────

  shuffle() {
    for (let i = this._tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._tracks[i], this._tracks[j]] = [this._tracks[j], this._tracks[i]];
    }
  }

  move(fromIndex, toIndex) {
    const len = this._tracks.length;
    if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) return false;
    const [track] = this._tracks.splice(fromIndex, 1);
    this._tracks.splice(toIndex, 0, track);
    return true;
  }
}
