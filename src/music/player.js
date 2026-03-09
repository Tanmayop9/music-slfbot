/**
 * MusicPlayer — wraps a Lavalink node player for one guild.
 * Handles playback, queue advancement, volume, seek, and filters.
 */

import { getFilterPayload, resetFiltersPayload } from './filters.js';
import { LoopMode, Queue } from './queue.js';
import { createLogger } from '../logger.js';

const log = createLogger('MusicPlayer');

export class MusicPlayer {
  /**
   * @param {string|number} guildId
   * @param {import('../lavalink/node.js').LavalinkNode} node
   */
  constructor(guildId, node) {
    this.guildId        = guildId;
    this.node           = node;

    this.queue          = new Queue();
    this.current        = null;
    this.volume         = 100;
    this.paused         = false;
    this.position       = 0;        // milliseconds, updated by playerUpdate
    this.connected      = false;
    this.voiceChannelId = null;
    this._currentFilter = null;

    // Callbacks invoked after the queue empties: (guildId) => void
    this._queueEndCallbacks = [];

    // Register Lavalink hooks
    node.onEvent('TrackStartEvent',     this._onTrackStart.bind(this));
    node.onEvent('TrackEndEvent',       this._onTrackEnd.bind(this));
    node.onEvent('TrackExceptionEvent', this._onTrackException.bind(this));
    node.onEvent('TrackStuckEvent',     this._onTrackStuck.bind(this));
    node.onPlayerUpdate(this._onPlayerUpdate.bind(this));
  }

  // ── Lavalink event handlers ────────────────────────────────────────────────

  async _onTrackStart(guildId, data) {
    if (String(guildId) !== String(this.guildId)) return;
    log.debug(`[Player ${this.guildId}] TrackStart: ${data?.track?.info?.title}`);
  }

  async _onTrackEnd(guildId, data) {
    if (String(guildId) !== String(this.guildId)) return;
    const reason = data?.reason ?? '';
    if (reason === 'finished' || reason === 'loadFailed' || reason === 'stopped') {
      await this._advance();
    }
  }

  async _onTrackException(guildId, data) {
    if (String(guildId) !== String(this.guildId)) return;
    log.warn(`[Player ${this.guildId}] TrackException: ${JSON.stringify(data?.exception)}`);
    await this._advance();
  }

  async _onTrackStuck(guildId, data) {
    if (String(guildId) !== String(this.guildId)) return;
    log.warn(`[Player ${this.guildId}] TrackStuck`);
    await this._advance();
  }

  async _onPlayerUpdate(guildId, state) {
    if (String(guildId) !== String(this.guildId)) return;
    this.position = state?.position ?? this.position;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  async _advance() {
    const nextTrack = this.queue.getNext(this.current);
    if (nextTrack) {
      await this.play(nextTrack);
    } else {
      this.current = null;
      for (const cb of this._queueEndCallbacks) {
        try { await cb(this.guildId); } catch (err) {
          log.error(`[Player ${this.guildId}] queue_end callback error: ${err.message}`);
        }
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  onQueueEnd(callback) {
    this._queueEndCallbacks.push(callback);
  }

  async play(track) {
    this.current = track;
    this.paused  = false;
    await this.node.updatePlayer(this.guildId, {
      track:  { encoded: track.encoded },
      volume: this.volume,
    });
  }

  async pause() {
    this.paused = true;
    await this.node.updatePlayer(this.guildId, { paused: true });
  }

  async resume() {
    this.paused = false;
    await this.node.updatePlayer(this.guildId, { paused: false });
  }

  async stop() {
    this.current = null;
    this.queue.clear();
    await this.node.updatePlayer(this.guildId, { track: { encoded: null } });
  }

  async skip() {
    const nextTrack = this.queue.getNext(this.current);
    if (nextTrack) {
      await this.play(nextTrack);
      return nextTrack;
    }
    await this.stop();
    return null;
  }

  async setVolume(volume) {
    this.volume = Math.max(0, Math.min(200, volume));
    await this.node.updatePlayer(this.guildId, { volume: this.volume });
  }

  async seek(positionMs) {
    await this.node.updatePlayer(this.guildId, { position: positionMs });
  }

  async setFilter(filterName) {
    const payload = getFilterPayload(filterName);
    if (!payload) return false;
    this._currentFilter = filterName;
    await this.node.updatePlayer(this.guildId, { filters: payload });
    return true;
  }

  async clearFilters() {
    this._currentFilter = null;
    await this.node.updatePlayer(this.guildId, { filters: resetFiltersPayload() });
  }

  async destroy() {
    this.connected = false;
    this.current   = null;
    this.queue.clear();
    try {
      await this.node.destroyPlayer(this.guildId);
    } catch (err) {
      log.debug(`[Player ${this.guildId}] destroy error: ${err.message}`);
    }
  }

  // ── Properties ─────────────────────────────────────────────────────────────

  get currentFilter() { return this._currentFilter; }

  get loopMode() { return this.queue.loopMode; }

  setLoop(mode) {
    this.queue.loopMode = mode;
  }
}
