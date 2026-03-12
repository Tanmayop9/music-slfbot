/**
 * Font loader for Discord-like rendering.
 *
 * Downloads Inter (the closest open-source match to Discord's "gg sans") from
 * jsDelivr at first use, caches the files in <cwd>/fonts/, and registers all
 * three weights with @napi-rs/canvas so that CSS font specs like
 * '600 16px Inter' resolve to the correct variant.
 *
 * Safe to call multiple times — work is only done once per process.
 */

import { GlobalFonts } from '@napi-rs/canvas';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('Fonts');

const FONTS_DIR = join(process.cwd(), 'fonts');

/** Inter weights to download (woff2 from @fontsource/inter via jsDelivr). */
const FONT_VARIANTS = [
  {
    label:    'Inter Regular',
    filename: 'inter-latin-400-normal.woff2',
    url:      'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-400-normal.woff2',
  },
  {
    label:    'Inter SemiBold',
    filename: 'inter-latin-600-normal.woff2',
    url:      'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-600-normal.woff2',
  },
  {
    label:    'Inter Bold',
    filename: 'inter-latin-700-normal.woff2',
    url:      'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-700-normal.woff2',
  },
];

let _fontsPromise = null;

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Ensure Inter font is downloaded and registered with GlobalFonts.
 * Concurrent callers all await the same Promise — work is only done once.
 */
export function loadFonts() {
  if (!_fontsPromise) _fontsPromise = _doLoadFonts();
  return _fontsPromise;
}

async function _doLoadFonts() {
  try {
    await mkdir(FONTS_DIR, { recursive: true });

    await Promise.all(FONT_VARIANTS.map(async ({ label, filename, url }) => {
      const dest = join(FONTS_DIR, filename);

      if (!(await fileExists(dest))) {
        log.info(`Downloading ${label}…`);
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(dest, buf);
          log.info(`Saved ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
        } catch (err) {
          log.warn(`Could not download ${label}: ${err.message}`);
          return; // skip registration for this variant
        }
      }

      try {
        GlobalFonts.registerFromPath(dest, 'Inter');
        log.debug(`Registered: ${label}`);
      } catch (err) {
        log.warn(`Could not register ${label}: ${err.message}`);
      }
    }));

  } catch (err) {
    log.warn(`Font setup failed: ${err.message} — will use system sans-serif`);
  }
}
