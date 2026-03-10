/**
 * yt-dlp / @distube/ytdl-core fallback.
 *
 * Resolves a search query or URL to a YouTube watch URL + CDN audio URL when
 * the primary Lavalink node cannot find or load the track.
 *
 * Resolution priority:
 *   1. YouTube Data API v3 search  (if ytdl.api_key is set in config)
 *   2. @distube/ytdl-core          (pure JS — always available, ideal for Termux)
 *   3. yt-dlp CLI                  (requires:  pip install yt-dlp)
 *
 * Termux install notes:
 *   pkg install python ffmpeg nodejs
 *   pip install yt-dlp
 *   npm install    (installs @distube/ytdl-core, opusscript, libsodium-wrappers)
 *
 * Optional config (config.yaml → ytdl:):
 *   api_key  — YouTube Data API v3 key (better search quality)
 *   cookies  — Raw YouTube cookie string for age-restricted content
 *              (DevTools → Application → Cookies → copy the Cookie header value)
 */

import { execFile } from 'child_process';
import { createLogger } from '../logger.js';

const log = createLogger('YtdlFallback');

// Termux keeps pip-installed tools here; add it to PATH so execFile finds yt-dlp.
const TERMUX_BIN = '/data/data/com.termux/files/usr/bin';

/**
 * Resolve a search query or URL to a playable result.
 *
 * Returns an object with:
 *   watchUrl  — canonical YouTube URL (pass this to Lavalink loadTracks first)
 *   url       — direct CDN audio stream URL (fallback if Lavalink rejects watchUrl)
 *   title     — track title
 *   author    — uploader / artist
 *   durationMs — duration in milliseconds
 *
 * @param {string} query  Search keywords or a full URL.
 * @param {object} [opts]
 * @param {string} [opts.cookies='']   Raw browser cookie string.
 * @param {string} [opts.apiKey='']    YouTube Data API v3 key.
 * @returns {Promise<{watchUrl:string, url:string, title:string, author:string, durationMs:number}|null>}
 */
export async function resolveWithYtdl(query, { cookies = '', apiKey = '' } = {}) {
  const isUrl = query.startsWith('http://') || query.startsWith('https://');

  // ── Step 1: Find the canonical YouTube watch URL ───────────────────────────
  let watchUrl = isUrl ? query : null;

  if (!watchUrl && apiKey) {
    const videoId = await _searchYouTubeApi(query, apiKey);
    if (videoId) watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  }

  // ── Step 2: Use @distube/ytdl-core (pure JS, works on Termux with no extras) ─
  const ytdlResult = await _resolveWithYtdlCore(watchUrl || query, { cookies, isUrl: !!watchUrl });
  if (ytdlResult) return ytdlResult;

  // ── Step 3: yt-dlp CLI (pip install yt-dlp) ───────────────────────────────
  return _resolveWithYtdlp(watchUrl || query, { cookies });
}

/**
 * Create a readable audio stream for direct playback via connection.playAudio().
 * Used by DirectPlayer when no Lavalink node is available.
 *
 * @param {string} url       YouTube watch URL or direct audio URL.
 * @param {string} [cookies] Raw cookie string for age-restricted content.
 * @returns {import('stream').Readable|null}
 */
export function createYtdlStream(url, { cookies = '' } = {}) {
  const ytdl = _cachedYtdlCore;
  if (!ytdl) {
    log.warn('createYtdlStream: @distube/ytdl-core not loaded');
    return null;
  }
  try {
    const requestOptions = cookies ? { headers: { Cookie: cookies } } : {};
    return ytdl(url, { quality: 'highestaudio', requestOptions });
  } catch (err) {
    log.warn(`createYtdlStream failed: ${err.message}`);
    return null;
  }
}

// ── @distube/ytdl-core ─────────────────────────────────────────────────────

let _cachedYtdlCore = null;

/** Lazy-load @distube/ytdl-core; returns null if unavailable. */
async function _loadYtdlCore() {
  if (_cachedYtdlCore) return _cachedYtdlCore;
  try {
    const mod = await import('@distube/ytdl-core');
    _cachedYtdlCore = mod.default;
    log.debug('@distube/ytdl-core loaded');
    return _cachedYtdlCore;
  } catch {
    return null;
  }
}

/**
 * Use @distube/ytdl-core to get audio info.
 * Only works with full YouTube watch URLs (not search terms).
 */
async function _resolveWithYtdlCore(input, { cookies = '', isUrl = false } = {}) {
  // ytdl-core cannot search; it needs a full URL.
  if (!isUrl && !input.startsWith('http')) return null;

  const ytdl = await _loadYtdlCore();
  if (!ytdl) return null;

  try {
    const requestOptions = cookies ? { headers: { Cookie: cookies } } : {};
    const info    = await ytdl.getInfo(input, { requestOptions });
    const format  = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    const details = info.videoDetails;

    log.info(`ytdl-core resolved: "${details.title}"`);
    return {
      watchUrl:   input,
      url:        format.url,
      title:      details.title     || 'Unknown',
      author:     details.author?.name || 'Unknown',
      durationMs: Math.round((parseInt(details.lengthSeconds) || 0) * 1000),
    };
  } catch (err) {
    log.warn(`ytdl-core failed for "${input}": ${err.message}`);
    return null;
  }
}

// ── YouTube Data API v3 ────────────────────────────────────────────────────

async function _searchYouTubeApi(query, apiKey) {
  const qs = new URLSearchParams({
    part: 'snippet', q: query, maxResults: '1', type: 'video', key: apiKey,
  });
  try {
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/search?${qs}`);
    if (!resp.ok) {
      log.warn(`YouTube API search HTTP ${resp.status}`);
      return null;
    }
    const data    = await resp.json();
    const videoId = data?.items?.[0]?.id?.videoId ?? null;
    if (videoId) log.debug(`YouTube API found: ${videoId}`);
    return videoId;
  } catch (err) {
    log.warn(`YouTube API error: ${err.message}`);
    return null;
  }
}

// ── yt-dlp CLI ─────────────────────────────────────────────────────────────

async function _resolveWithYtdlp(query, { cookies = '' } = {}) {
  const identifier = (query.startsWith('http://') || query.startsWith('https://'))
    ? query
    : `ytsearch1:${query}`;

  const args = [
    '--no-playlist',
    '-f', 'bestaudio[ext=webm]/bestaudio/best',
    '--print', 'title',
    '--print', 'uploader',
    '--print', 'duration',
    '--print', 'webpage_url',  // canonical watch URL, not expiring CDN URL
    '--print', 'url',          // CDN audio URL as last resort
    '--no-warnings', '--quiet',
  ];
  if (cookies) args.push('--add-header', `Cookie: ${cookies}`);
  args.push(identifier);

  let raw;
  try {
    raw = await _runYtdlp(args);
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.warn('yt-dlp not found — install with: pip install yt-dlp');
    } else {
      log.warn(`yt-dlp error: ${err.message}`);
    }
    return null;
  }

  const lines = raw.trim().split('\n');
  // Output order: title, uploader, duration, webpage_url, url  (5 lines)
  if (lines.length < 5) {
    log.warn(`yt-dlp unexpected output (${lines.length} lines)`);
    return null;
  }

  const title      = lines[0].trim() || 'Unknown';
  const author     = lines[1].trim() || 'Unknown';
  const durationMs = Math.round((parseFloat(lines[2]) || 0) * 1000);
  const watchUrl   = lines[3].trim();
  const url        = lines[4].trim();

  if (!url.startsWith('http')) {
    log.warn('yt-dlp returned non-HTTP URL');
    return null;
  }

  log.info(`yt-dlp resolved: "${title}" (${author})`);
  return { watchUrl, url, title, author, durationMs };
}

function _runYtdlp(args) {
  // Ensure Termux pip-installed binaries are visible even in restricted PATH.
  const env = { ...process.env };
  if (!env.PATH?.includes(TERMUX_BIN)) {
    env.PATH = `${TERMUX_BIN}:${env.PATH || ''}`;
  }
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: 30_000, env }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr?.trim() || error.message);
        err.code = error.code;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}
