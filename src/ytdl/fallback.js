/**
 * yt-dlp fallback — resolves a search query or URL to a direct audio stream
 * URL when the primary Lavalink node cannot find or load the track.
 *
 * Requires yt-dlp to be installed and available on $PATH.
 * Install: https://github.com/yt-dlp/yt-dlp#installation
 *   Linux/macOS: pip install yt-dlp   OR   sudo apt install yt-dlp
 *   Windows:     winget install yt-dlp
 */

import { execFile } from 'child_process';
import { createLogger } from '../logger.js';

const log = createLogger('YtdlFallback');

/**
 * Resolve a search query or direct URL to a playable audio stream URL.
 *
 * yt-dlp is invoked with `--print` for each field so the output is always
 * four lines: title, uploader, duration (seconds), stream URL.
 *
 * @param {string} query  Search keywords or a full URL.
 * @returns {Promise<{url: string, title: string, author: string, durationMs: number} | null>}
 */
export async function resolveWithYtdl(query) {
  // Prefix keyword searches with ytsearch1: so yt-dlp picks the top result.
  const identifier = (query.startsWith('http://') || query.startsWith('https://'))
    ? query
    : `ytsearch1:${query}`;

  let raw;
  try {
    raw = await _runYtdlp([
      '--no-playlist',
      '-f', 'bestaudio[ext=webm]/bestaudio/best',
      '--print', 'title',
      '--print', 'uploader',
      '--print', 'duration',
      '--print', 'url',
      '--no-warnings',
      '--quiet',
      identifier,
    ]);
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.warn('yt-dlp is not installed — skipping fallback. Install with: pip install yt-dlp');
    } else {
      log.warn(`yt-dlp failed: ${err.message}`);
    }
    return null;
  }

  const lines = raw.trim().split('\n');
  // --print outputs one value per line in the order requested: title, uploader, duration, url
  if (lines.length < 4) {
    log.warn(`yt-dlp unexpected output (${lines.length} lines)`);
    return null;
  }

  const title      = lines[0].trim() || 'Unknown';
  const author     = lines[1].trim() || 'Unknown';
  const durationMs = Math.round((parseFloat(lines[2]) || 0) * 1000);
  const streamUrl  = lines[lines.length - 1].trim();

  if (!streamUrl.startsWith('http')) {
    log.warn(`yt-dlp returned non-HTTP URL — skipping`);
    return null;
  }

  log.info(`yt-dlp resolved: "${title}" (${author})`);
  return { url: streamUrl, title, author, durationMs };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function _runYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: 30_000 }, (error, stdout, stderr) => {
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
