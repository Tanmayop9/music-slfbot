/**
 * Lavalink v4 node — WebSocket + REST client with automatic reconnection.
 */

import WebSocket from 'ws';
import { LoadResult, LoadType, PlaylistInfo, Track } from './models.js';
import { createLogger } from '../logger.js';

const log = createLogger('LavalinkNode');

class NodeStats {
  constructor(data) {
    this.players          = data.players          ?? 0;
    this.playingPlayers   = data.playingPlayers   ?? 0;
    this.uptime           = data.uptime           ?? 0;
    const memory          = data.memory           ?? {};
    this.memoryUsed       = memory.used           ?? 0;
    this.memoryFree       = memory.free           ?? 0;
    const cpu             = data.cpu              ?? {};
    this.cpuCores         = cpu.cores             ?? 0;
    this.cpuSystemLoad    = cpu.systemLoad        ?? 0;
    this.cpuLavalinkLoad  = cpu.lavalinkLoad      ?? 0;
  }
}

export class LavalinkNode {
  constructor({ host, port, password, secure = false, name = 'Node', userId = 0 }) {
    this.host     = host;
    this.port     = port;
    this.password = password;
    this.secure   = secure;
    this.name     = name;
    this.userId   = userId;

    this._ws           = null;
    this._sessionId    = null;
    this._available    = false;
    this._stats        = null;
    this._reconnectTimer = null;

    // Registered hooks: eventType -> [fn(guildId, data)]
    this._eventHooks        = {};
    // Registered hooks: [fn(guildId, state)]
    this._playerUpdateHooks = [];
  }

  // ── Properties ─────────────────────────────────────────────────────────────

  get wsUrl() {
    const scheme = this.secure ? 'wss' : 'ws';
    return `${scheme}://${this.host}:${this.port}/v4/websocket`;
  }

  get restUrl() {
    const scheme = this.secure ? 'https' : 'http';
    return `${scheme}://${this.host}:${this.port}`;
  }

  get available() { return this._available; }
  get stats()     { return this._stats; }
  get sessionId() { return this._sessionId; }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async connect() {
    await this._connectWs();
  }

  _connectWs() {
    return new Promise((resolve) => {
      const headers = {
        Authorization:  this.password,
        'User-Id':      String(this.userId),
        'Client-Name':  'MusicSelfBot/1.0',
      };
      if (this._sessionId) headers['Session-Id'] = this._sessionId;

      try {
        const ws = new WebSocket(this.wsUrl, { headers });
        this._ws = ws;

        ws.once('open', () => {
          this._available = true;
          log.info(`[${this.name}] WebSocket connected`);
          resolve();
        });

        ws.once('error', (err) => {
          this._available = false;
          log.warn(`[${this.name}] Connection failed: ${err.message} — retrying in 5s`);
          resolve(); // don't reject — we'll reconnect
          this._scheduleReconnect(5000);
        });

        ws.on('message', (data) => {
          try {
            this._dispatch(JSON.parse(data));
          } catch {}
        });

        ws.on('close', () => {
          this._available = false;
          log.warn(`[${this.name}] Disconnected — scheduling reconnect`);
          this._scheduleReconnect(5000);
        });
      } catch (err) {
        this._available = false;
        log.warn(`[${this.name}] Connection error: ${err.message} — retrying in 5s`);
        resolve();
        this._scheduleReconnect(5000);
      }
    });
  }

  _scheduleReconnect(delayMs) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      this._safeCloseWs();
      await this._connectWs();
    }, delayMs);
  }

  _safeCloseWs() {
    if (this._ws) {
      try { this._ws.terminate(); } catch {}
      this._ws = null;
    }
  }

  // ── Message dispatch ───────────────────────────────────────────────────────

  _dispatch(data) {
    const op = data.op;

    if (op === 'ready') {
      this._sessionId = data.sessionId;
      this._available = true;
      log.info(`[${this.name}] Ready — session ${this._sessionId}`);

    } else if (op === 'stats') {
      this._stats = new NodeStats(data);

    } else if (op === 'playerUpdate') {
      const guildId = data.guildId ?? '';
      const state   = data.state   ?? {};
      for (const hook of this._playerUpdateHooks) {
        hook(guildId, state).catch(() => {});
      }

    } else if (op === 'event') {
      const eventType = data.type    ?? '';
      const guildId   = data.guildId ?? '';
      for (const hook of (this._eventHooks[eventType] || [])) {
        hook(guildId, data).catch(() => {});
      }
    }
  }

  // ── Hook registration ──────────────────────────────────────────────────────

  onEvent(eventType, hook) {
    if (!this._eventHooks[eventType]) this._eventHooks[eventType] = [];
    this._eventHooks[eventType].push(hook);
  }

  onPlayerUpdate(hook) {
    this._playerUpdateHooks.push(hook);
  }

  // ── REST helpers ───────────────────────────────────────────────────────────

  async _request(method, path, { body, params } = {}) {
    let url = `${this.restUrl}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    }

    const init = {
      method,
      headers: {
        Authorization: this.password,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const resp = await fetch(url, init);
    if (resp.status === 204) return null;
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  // ── Track loading ──────────────────────────────────────────────────────────

  async loadTracks(identifier) {
    let data;
    try {
      data = await this._request('GET', '/v4/loadtracks', { params: { identifier } });
    } catch (err) {
      log.error(`[${this.name}] loadTracks error: ${err.message}`);
      return new LoadResult({ loadType: LoadType.ERROR, exception: { message: err.message } });
    }

    const loadType = data.loadType ?? 'empty';

    if (loadType === 'track') {
      const track = Track.fromData(data.data);
      return new LoadResult({ loadType: LoadType.TRACK, tracks: [track] });
    }

    if (loadType === 'playlist') {
      const pd     = data.data;
      const tracks = (pd.tracks ?? []).map(Track.fromData);
      const pInfo  = new PlaylistInfo({
        name:          pd.info?.name ?? 'Playlist',
        selectedTrack: pd.info?.selectedTrack ?? -1,
      });
      return new LoadResult({ loadType: LoadType.PLAYLIST, tracks, playlistInfo: pInfo });
    }

    if (loadType === 'search') {
      const tracks = (data.data ?? []).map(Track.fromData);
      return new LoadResult({ loadType: LoadType.SEARCH, tracks });
    }

    if (loadType === 'error') {
      return new LoadResult({ loadType: LoadType.ERROR, exception: data.data });
    }

    return new LoadResult({ loadType: LoadType.EMPTY });
  }

  // ── Player control ─────────────────────────────────────────────────────────

  async updatePlayer(guildId, payload, { noReplace = false } = {}) {
    if (!this._sessionId) throw new Error(`[${this.name}] No session — not yet connected`);
    return this._request(
      'PATCH',
      `/v4/sessions/${this._sessionId}/players/${guildId}`,
      { body: payload, params: { noReplace: noReplace ? 'true' : 'false' } },
    );
  }

  async destroyPlayer(guildId) {
    if (!this._sessionId) return;
    try {
      await this._request('DELETE', `/v4/sessions/${this._sessionId}/players/${guildId}`);
    } catch (err) {
      log.debug(`[${this.name}] destroyPlayer: ${err.message}`);
    }
  }

  // ── Voice update forwarding ────────────────────────────────────────────────

  async sendVoiceUpdate(guildId, sessionId, token, endpoint) {
    await this.updatePlayer(guildId, {
      voice: { token, endpoint, sessionId },
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async close() {
    this._available = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._safeCloseWs();
  }
}
