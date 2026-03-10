/**
 * Shared canvas drawing utilities.
 *
 * Discord dark-theme palette, colour helpers, text wrapping,
 * circular avatar + decoration overlay, rounded-rect path.
 */

// ── Discord dark-theme palette ─────────────────────────────────────────────
export const DISCORD = {
  bg:           '#313338',
  bgSecondary:  '#2b2d31',
  bgTertiary:   '#1e1f22',
  text:         '#dbdee1',
  textMuted:    '#949ba4',
  link:         '#00aff4',
  brand:        '#5865f2',
  red:          '#f23f43',
  green:        '#23a55a',
  yellow:       '#f0b232',
  codeBorder:   '#4f545c',
};

// 18-colour fallback palette for users with no coloured role
export const USER_COLORS = [
  '#f23f43', '#f0b232', '#23a55a', '#00b0f4', '#5865f2',
  '#eb459e', '#e91e63', '#9c27b0', '#3f51b5', '#2196f3',
  '#009688', '#4caf50', '#ff9800', '#ff5722',
  '#7289da', '#43b581', '#faa61a', '#f04747',
];

// ── Colour utilities ───────────────────────────────────────────────────────

/** Deterministic colour from a user ID string. */
export function getUserColor(userId) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = Math.imul(31, h) + userId.charCodeAt(i) | 0;
  }
  return USER_COLORS[Math.abs(h) % USER_COLORS.length];
}

/**
 * Returns the best display name for a message author object.
 * Priority: nickname → displayName → username.
 */
export function getDisplayName(author) {
  return author.nickname || author.displayName || author.username || 'Unknown';
}

// ── Date/time helpers ──────────────────────────────────────────────────────

/** Format as "3:45 PM" */
export function formatTime(date) {
  const d    = new Date(date);
  const h    = d.getHours();
  const m    = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${m} ${ampm}`;
}

/** Full Discord-style timestamp. */
export function formatFullDate(date) {
  const d         = new Date(date);
  const now       = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === now.toDateString())       return `Today at ${formatTime(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${formatTime(d)}`;

  const MON = ['Jan','Feb','Mar','Apr','May','Jun',
               'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${formatTime(d)}`;
}

/** Long-form date e.g. "January 5, 2024". */
export function formatDate(date) {
  const d    = new Date(date);
  const MON  = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
  return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ── Network helpers ────────────────────────────────────────────────────────

/** Fetch a remote URL and return a Buffer, or null on failure. */
export async function fetchImageBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Silently return null — canvas falls back to initials / skips decoration
    // Uncomment the line below for verbose debugging:
    // createLogger('fetch').debug(`Image fetch failed for ${url}: ${err.message}`);
    void err;
    return null;
  }
}

// ── Text helpers ───────────────────────────────────────────────────────────

/**
 * Word-wrap `text` into lines that each fit within `maxWidth` pixels.
 * Preserves explicit newlines.
 */
export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    if (!para) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Strip the most common Discord markdown tokens so plain text renders cleanly
 * on a canvas without literal markdown symbols.
 */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?|```/g, '').trim())
    .replace(/`([^`]+)`/g,     '$1')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs,    '$1')
    .replace(/__(.+?)__/gs,    '$1')
    .replace(/_(.+?)_/gs,      '$1')
    .replace(/~~(.+?)~~/gs,    '$1')
    .replace(/\|\|(.+?)\|\|/gs,'▓▓▓')
    .replace(/<@!?(\d+)>/g,    '@user')
    .replace(/<@&(\d+)>/g,     '@role')
    .replace(/<#(\d+)>/g,      '#channel')
    .replace(/<a?:\w+:\d+>/g,  ':emoji:');
}

// ── Canvas drawing helpers ─────────────────────────────────────────────────

/**
 * Draw a circular avatar with an optional avatar-decoration overlay.
 *
 * Decoration rendering follows Discord's actual ratio:
 *   The decoration asset is 240×240; the inner avatar area is 160×160.
 *   Ratio = 240/160 = 1.5  →  decoration rendered at `size * 1.5`, centred.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Image|null}  avatarImg     – pre-loaded avatar image (or null → initials)
 * @param {Image|null}  decoImg       – pre-loaded decoration PNG (or null → none)
 * @param {object}      author        – { id, … }
 * @param {string}      displayName
 * @param {number}      x             – top-left x of avatar bounding box
 * @param {number}      y             – top-left y
 * @param {number}      size          – width & height of avatar bounding box
 */
export function drawCircularAvatar(ctx, avatarImg, decoImg, author, displayName, x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;

  // ── 1. Draw circular avatar (clipped to circle) ──────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (avatarImg) {
    ctx.drawImage(avatarImg, x, y, size, size);
  } else {
    // Fallback: solid colour + initial letter
    ctx.fillStyle    = getUserColor(author?.id || '0');
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle    = '#ffffff';
    ctx.font         = `bold ${Math.floor(size * 0.42)}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((displayName[0] || '?').toUpperCase(), cx, cy);
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  ctx.restore(); // release clip before drawing decoration

  // ── 2. Decoration overlay (drawn AFTER releasing the avatar clip) ─────────
  // Discord ratio: decoration asset 240px / avatar slot 160px = 1.5×
  if (decoImg) {
    const decoSize = Math.round(size * 1.5);
    const decoX    = cx - decoSize / 2;
    const decoY    = cy - decoSize / 2;
    ctx.drawImage(decoImg, decoX, decoY, decoSize, decoSize);
  }
}

/** Trace a rounded-rectangle path (call ctx.fill() / ctx.stroke() yourself). */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

