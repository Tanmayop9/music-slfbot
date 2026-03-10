/**
 * DirectPlayer — streams audio through discord.js-selfbot-v13's built-in
 * voice connection using @distube/ytdl-core, following the official
 * PlayAudio.js example from the library.
 *
 * Used automatically when no Lavalink node is reachable.
 * Requires: opusscript (or @discordjs/opus), libsodium-wrappers (or sodium),
 *           and ffmpeg to be installed.
 *
 * Termux: pkg install ffmpeg && npm install (installs opusscript + libsodium-wrappers)
 */

import { Queue, LoopMode } from '../music/queue.js';
import { createYtdlStream } from './fallback.js';
import { createLogger } from '../logger.js';

const log = createLogger('DirectPlayer');

export class DirectPlayer {
  /**
   * @param {string|number} guildId
   * @param {object} connection  discord.js-selfbot-v13 VoiceConnection
   * @param {object} [opts]
   * @param {string} [opts.cookies='']  Cookie string forwarded to ytdl-core requests.
   */
  constructor(guildId, connection, { cookies = '' } = {}) {
    this.guildId        = String(guildId);
    this.connection     = connection;
    this._cookies       = cookies;

    this.queue          = new Queue();
    this.current        = null;
    this.volume         = 100;
    this.paused         = false;
    this.position       = 0;
    this.connected      = true;
    this.voiceChannelId = null;

    this._dispatcher        = null;
    this._positionTimer     = null;
    this._queueEndCallbacks = [];
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  /**
   * Play a track.  track.info.uri must be a YouTube watch URL or a direct
   * audio URL that @distube/ytdl-core / ffmpeg can handle.
   *
   * @param {import('../lavalink/models.js').Track} track
   */
  async play(track) {
    this.current = track;
    this.paused  = false;
    this.position = 0;
    this._stopDispatcher();

    const url = track.info.uri || track.info.identifier;
    if (!url) throw new Error('DirectPlayer: track has no URI');

    const stream = createYtdlStream(url, { cookies: this._cookies });
    if (!stream) throw new Error('DirectPlayer: could not create audio stream — is @distube/ytdl-core installed?');

    this._dispatcher = this.connection.playAudio(stream);
    this._dispatcher.setVolume(this.volume / 100);

    this._dispatcher.on('start', () => {
      log.debug(`[DirectPlayer ${this.guildId}] start: ${track.info.title}`);
      this._startPositionTimer();
    });

    this._dispatcher.on('finish', () => {
      log.debug(`[DirectPlayer ${this.guildId}] finish`);
      this._stopPositionTimer();
      this._advance().catch(() => {});
    });

    this._dispatcher.on('error', (err) => {
      log.warn(`[DirectPlayer ${this.guildId}] dispatcher error: ${err.message}`);
      this._stopPositionTimer();
      this._advance().catch(() => {});
    });
  }

  async pause() {
    this.paused = true;
    this._dispatcher?.pause();
    this._stopPositionTimer();
  }

  async resume() {
    this.paused = false;
    this._dispatcher?.resume();
    this._startPositionTimer();
  }

  async stop() {
    this.current = null;
    this.queue.clear();
    this._stopDispatcher();
  }

  async skip() {
    const next = this.queue.getNext(this.current);
    if (next) {
      await this.play(next);
      return next;
    }
    await this.stop();
    return null;
  }

  async setVolume(volume) {
    this.volume = Math.max(0, Math.min(200, volume));
    this._dispatcher?.setVolume(this.volume / 100);
  }

  // seek() is not supported in direct mode; silently ignored.
  async seek() {}

  // Filters are not supported in direct mode.
  async setFilter()    { return false; }
  async clearFilters() {}

  async destroy() {
    this.connected = false;
    this.current   = null;
    this.queue.clear();
    this._stopDispatcher();
    try { this.connection.disconnect(); } catch {}
  }

  // ── Queue helpers ──────────────────────────────────────────────────────────

  onQueueEnd(callback) {
    this._queueEndCallbacks.push(callback);
  }

  async _advance() {
    const next = this.queue.getNext(this.current);
    if (next) {
      await this.play(next);
    } else {
      this.current = null;
      for (const cb of this._queueEndCallbacks) {
        try { await cb(this.guildId); } catch {}
      }
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  _stopDispatcher() {
    this._stopPositionTimer();
    if (this._dispatcher) {
      try { this._dispatcher.destroy(); } catch {}
      this._dispatcher = null;
    }
  }

  _startPositionTimer() {
    this._stopPositionTimer();
    this._positionTimer = setInterval(() => { this.position += 1000; }, 1000);
  }

  _stopPositionTimer() {
    if (this._positionTimer) {
      clearInterval(this._positionTimer);
      this._positionTimer = null;
    }
  }

  // ── Properties ─────────────────────────────────────────────────────────────

  get currentFilter() { return null; }
  get loopMode()      { return this.queue.loopMode; }
  setLoop(mode)       { this.queue.loopMode = mode; }

  /** Always null — DirectPlayer has no Lavalink node. */
  get node() { return null; }
}
