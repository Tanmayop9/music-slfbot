/**
 * Lavalink v4 data models — Track, Playlist, LoadResult.
 */

export class TrackInfo {
  constructor(data) {
    this.identifier  = data.identifier  ?? '';
    this.isSeekable  = data.isSeekable  ?? false;
    this.author      = data.author      ?? 'Unknown';
    this.length      = data.length      ?? 0;       // milliseconds
    this.isStream    = data.isStream    ?? false;
    this.position    = data.position    ?? 0;
    this.title       = data.title       ?? 'Unknown';
    this.uri         = data.uri         ?? null;
    this.artworkUrl  = data.artworkUrl  ?? null;
    this.isrc        = data.isrc        ?? null;
    this.sourceName  = data.sourceName  ?? 'unknown';
  }
}

export class Track {
  constructor({ encoded, info, pluginInfo = {}, userData = {}, requester = null } = {}) {
    this.encoded    = encoded    ?? '';
    this.info       = info instanceof TrackInfo ? info : new TrackInfo(info ?? {});
    this.pluginInfo = pluginInfo;
    this.userData   = userData;
    this.requester  = requester;
  }

  static fromData(data) {
    return new Track({
      encoded:    data.encoded    ?? '',
      info:       new TrackInfo(data.info ?? {}),
      pluginInfo: data.pluginInfo ?? {},
      userData:   data.userData   ?? {},
    });
  }

  get durationStr() {
    const ms      = this.info.length;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours   = Math.floor(minutes / 60);
    if (hours > 0) {
      return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
}

export class PlaylistInfo {
  constructor({ name = '', selectedTrack = -1 } = {}) {
    this.name          = name;
    this.selectedTrack = selectedTrack;
  }
}

export class LoadResult {
  constructor({ loadType, tracks = [], playlistInfo = null, exception = null } = {}) {
    this.loadType     = loadType;
    this.tracks       = tracks;
    this.playlistInfo = playlistInfo;
    this.exception    = exception;
  }

  get isEmpty() {
    return this.loadType === LoadType.EMPTY
      || this.loadType === LoadType.ERROR
      || this.tracks.length === 0;
  }
}

export const LoadType = Object.freeze({
  TRACK:    'track',
  PLAYLIST: 'playlist',
  SEARCH:   'search',
  EMPTY:    'empty',
  ERROR:    'error',
});
