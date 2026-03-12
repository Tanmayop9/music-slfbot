/**
 * Canvas-based Discord-style chat screenshot generator.
 *
 * Every rendering decision mirrors Discord's actual dark-theme UI:
 *
 *  Name resolution   nickname → displayName → username
 *  Username colour   top-role hex → deterministic hash-palette fallback
 *  Avatar            guild avatar → global avatar → default Discord CDN avatar → initials
 *  Decoration        avatarDecorationURL() → avatarDecorationData.asset → avatarDecoration
 *                    rendered at Discord's 1.5× ratio (240px asset / 160px avatar slot)
 *  Role icon         highest role with .icon, rendered as 18×18 rounded square after username
 *  Bot badge         "APP" pill shown for bot accounts
 *  Grouping          consecutive messages from same author within 7 minutes → one group
 *  Height            two-pass render (measure → draw) so canvas is pixel-perfect
 *
 * @module canvas/ss
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  DISCORD,
  getUserColor,
  getDisplayName,
  formatFullDate,
  fetchImageBuffer,
  wrapText,
  drawCircularAvatar,
  stripMarkdown,
} from './helpers.js';
import { loadFonts } from './fonts.js';
import { createLogger } from '../logger.js';

const log = createLogger('SSGen');

// ── Constants ──────────────────────────────────────────────────────────────
/** Messages from the same author within this window are grouped (Discord = 7 min). */
const MESSAGE_GROUP_THRESHOLD_MS = 7 * 60 * 1000;

// ── Layout constants ───────────────────────────────────────────────────────
const L = Object.freeze({
  width:        800,
  padX:          16,
  padY:          20,
  avatarSize:    40,
  // contentX: padX(16) + avatarSize(40) + gap(16) = 72
  // We leave extra horizontal room because decorations extend 10px outside
  // the avatar bounding box on each side (avatarSize * 0.25 = 10px).
  contentX:      72,
  get contentW() { return this.width - this.contentX - this.padX; }, // 712
  headerSize:    16,   // username font size
  timestampSize: 12,
  msgSize:       15,
  lineH:         22,
  groupGap:      14,   // vertical space above every group header
  msgGap:         3,   // vertical space between continuation messages
  footerH:       34,
  maxNameW:     220,   // max px for username before truncation
});

// ── Utility ────────────────────────────────────────────────────────────────

/**
 * Default Discord avatar URL derived from the user's snowflake.
 * New-style (no discriminator): (userId >> 22) % 6
 * Falls back to index 0 if BigInt conversion fails.
 */
function defaultAvatarURL(userId) {
  try {
    const idx = Number(BigInt(String(userId)) >> 22n) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  } catch {
    return 'https://cdn.discordapp.com/embed/avatars/0.png';
  }
}

/** Truncate text to fit maxWidth, appending '…' when needed. */
function truncate(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/**
 * Trace a rounded-rect path segment.
 * Caller must have opened a path with ctx.beginPath() and should call
 * ctx.closePath() + ctx.fill() / ctx.clip() after.
 */
function traceRoundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y,     x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x,     y + h, x,     y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x,     y,     x + rad, y);
}

// ── Message grouping (same author, ≤7 min gap) ────────────────────────────

function groupMessages(messages) {
  const groups = [];
  let cur = null;
  for (const msg of messages) {
    const ts = new Date(msg.timestamp).getTime();
    if (cur && cur.authorId === msg.author.id && ts - cur.lastTs < MESSAGE_GROUP_THRESHOLD_MS) {
      cur.msgs.push(msg);
      cur.lastTs = ts;
    } else {
      cur = { authorId: msg.author.id, author: msg.author, msgs: [msg], firstTs: ts, lastTs: ts };
      groups.push(cur);
    }
  }
  return groups;
}

// ── Pass 1: height measurement ─────────────────────────────────────────────

function measureGroupH(mCtx, group) {
  let h = L.groupGap + L.lineH;        // top gap + header row
  mCtx.font = `${L.msgSize}px Inter, sans-serif`;
  for (const msg of group.msgs) {
    const text    = stripMarkdown(msg.content || '').trim();
    const attCnt  = msg.attachments?.length || 0;
    const hasEmb  = !text && !attCnt && (msg.embeds || 0) > 0;
    const isEmpty = !text && !attCnt && !msg.embeds;
    if (text)              h += wrapText(mCtx, text, L.contentW).length * L.lineH;
    if (attCnt)            h += attCnt * L.lineH;
    if (hasEmb || isEmpty) h += L.lineH;
    h += L.msgGap;
  }
  return h + L.groupGap;               // bottom gap
}

// ── Image pre-fetching ─────────────────────────────────────────────────────

async function safeLoad(url) {
  if (!url) return null;
  const buf = await fetchImageBuffer(url);
  if (!buf) return null;
  try   { return await loadImage(buf); }
  catch { return null; }
}

/**
 * Pre-fetch all unique avatars, decorations and role icons in parallel.
 * Every fetch is independent; one failure never blocks the others.
 *
 * Avatar fallback chain:
 *   1. author.avatarURL      (guild avatar preferred, passed by handler)
 *   2. default Discord CDN   (generated from snowflake)
 *   3. null                  (drawCircularAvatar will paint initials)
 */
async function prefetchImages(messages) {
  const uniqueAuthors = [
    ...new Map(messages.map(m => [m.author.id, m.author])).values(),
  ];

  const avatarCache   = new Map();
  const decoCache     = new Map();
  const roleIconCache = new Map();

  await Promise.all(uniqueAuthors.map(async (a) => {
    // Avatar
    const avatarImg =
      (await safeLoad(a.avatarURL)) ??
      (await safeLoad(defaultAvatarURL(a.id)));
    if (avatarImg) avatarCache.set(a.id, avatarImg);

    // Decoration (passthrough PNG — transparent centre + frame overlay)
    const decoImg = await safeLoad(a.decorationURL);
    if (decoImg) decoCache.set(a.id, decoImg);

    // Role icon
    const roleImg = await safeLoad(a.roleIconURL);
    if (roleImg) roleIconCache.set(a.id, roleImg);
  }));

  return { avatarCache, decoCache, roleIconCache };
}

// ── Pass 2: drawing helpers ────────────────────────────────────────────────

/**
 * Draw the header row: [username] [APP badge?] [role icon?] [timestamp]
 * Returns nothing; modifies canvas in-place.
 */
function drawHeader(ctx, group, y, roleIconCache) {
  const { author, msgs } = group;
  const displayName      = getDisplayName(author);

  // Colour: real top-role hex, skip '#000000' (= no coloured role), else hash-palette
  const nameColor =
    author.roleColor && author.roleColor !== '#000000'
      ? author.roleColor
      : getUserColor(author.id);

  const baseline = y + L.headerSize + 2;
  let   curX     = L.contentX;

  // ── Username ─────────────────────────────────────────────────────────────
  ctx.font      = `600 ${L.headerSize}px Inter, sans-serif`;
  ctx.fillStyle = nameColor;
  const nameStr = truncate(ctx, displayName, L.maxNameW);
  ctx.fillText(nameStr, curX, baseline);
  curX += ctx.measureText(nameStr).width + 4;

  // ── APP badge (bots only) ─────────────────────────────────────────────────
  if (author.bot) {
    const tw = 36, th = 16;
    const tx = curX + 2,  ty = baseline - th + 2;

    ctx.fillStyle = DISCORD.brand;
    ctx.beginPath();
    traceRoundRect(ctx, tx, ty, tw, th, 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle    = '#ffffff';
    ctx.font         = 'bold 10px Inter, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('APP', tx + tw / 2, ty + th / 2);
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';

    curX = tx + tw + 6;
  }

  // ── Role icon ─────────────────────────────────────────────────────────────
  const roleIconImg = roleIconCache.get(author.id) ?? null;
  if (roleIconImg) {
    const is  = 18;  // icon size
    const ix  = curX + 2;
    const iy  = Math.round(baseline - is * 0.82);

    ctx.save();
    ctx.beginPath();
    traceRoundRect(ctx, ix, iy, is, is, 4);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(roleIconImg, ix, iy, is, is);
    ctx.restore();

    curX = ix + is + 6;
  }

  // ── Timestamp ─────────────────────────────────────────────────────────────
  ctx.font      = `${L.timestampSize}px Inter, sans-serif`;
  ctx.fillStyle = DISCORD.textMuted;
  ctx.fillText(formatFullDate(msgs[0].timestamp), curX + 2, baseline - 1);
}

/** Draw all message bodies in a group. Returns the new Y cursor. */
function drawMessages(ctx, msgs, startY) {
  let y = startY;
  for (const msg of msgs) {
    const text   = stripMarkdown(msg.content || '').trim();
    const attCnt = msg.attachments?.length || 0;

    ctx.font      = `${L.msgSize}px Inter, sans-serif`;
    ctx.fillStyle = DISCORD.text;

    if (text) {
      for (const line of wrapText(ctx, text, L.contentW)) {
        y += L.lineH;
        ctx.fillText(line, L.contentX, y);
      }
    }

    if (attCnt) {
      for (const att of msg.attachments) {
        y += L.lineH;
        ctx.fillStyle = DISCORD.link;
        ctx.fillText(`�� ${att.name || 'attachment'}`, L.contentX, y);
        ctx.fillStyle = DISCORD.text;
      }
    }

    if (!text && !attCnt && msg.embeds > 0) {
      y += L.lineH;
      ctx.fillStyle = DISCORD.textMuted;
      ctx.fillText(
        `[${msg.embeds} embed${msg.embeds > 1 ? 's' : ''}]`,
        L.contentX, y,
      );
      ctx.fillStyle = DISCORD.text;
    }

    // Empty message guard — still consumes one line height
    if (!text && !attCnt && !msg.embeds) y += L.lineH;

    y += L.msgGap;
  }
  return y;
}

/** Draw one full message group (avatar + header + bodies). Returns new Y. */
function drawGroup(ctx, group, startY, avatarCache, decoCache, roleIconCache) {
  const { author, msgs } = group;
  const displayName      = getDisplayName(author);
  const y                = startY + L.groupGap;

  // Avatar circle + decoration overlay
  drawCircularAvatar(
    ctx,
    avatarCache.get(author.id) ?? null,
    decoCache.get(author.id)   ?? null,
    author,
    displayName,
    L.padX,
    y,
    L.avatarSize,
  );

  // Header row
  drawHeader(ctx, group, y, roleIconCache);

  // Message content
  const endY = drawMessages(ctx, msgs, y + L.lineH);
  return endY + L.groupGap;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a Discord-style chat screenshot.
 *
 * Expected author fields on each message:
 *   id, username, displayName, nickname, roleColor, avatarURL,
 *   decorationURL, roleIconURL, bot
 *
 * @param {object[]} messages
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function generateSS(messages) {
  if (!messages?.length) throw new Error('No messages provided');

  // Ensure Inter font is downloaded and registered before rendering
  await loadFonts();

  const groups = groupMessages(messages);

  // ── Pass 1: measure exact canvas height ───────────────────────────────────
  const mCanvas = createCanvas(L.width, 100);
  const mCtx    = mCanvas.getContext('2d');
  let   totalH  = L.padY;
  for (const g of groups) totalH += measureGroupH(mCtx, g);
  totalH += L.footerH;

  // ── Pre-fetch all images (parallel, with fallbacks) ────────────────────────
  const { avatarCache, decoCache, roleIconCache } = await prefetchImages(messages);

  // ── Pass 2: render ─────────────────────────────────────────────────────────
  const canvas = createCanvas(L.width, totalH);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = DISCORD.bg;
  ctx.fillRect(0, 0, L.width, totalH);

  // Subtle left-edge accent stripe
  ctx.fillStyle = '#23242a';
  ctx.fillRect(0, 0, 3, totalH);

  let y = L.padY;
  for (const g of groups) {
    y = drawGroup(ctx, g, y, avatarCache, decoCache, roleIconCache);
  }

  // Footer divider + watermark
  ctx.fillStyle = '#3a3c41';
  ctx.fillRect(L.padX, y + 2, L.width - L.padX * 2, 1);

  ctx.font      = '11px Inter, sans-serif';
  ctx.fillStyle = '#4f545c';
  ctx.textAlign = 'right';
  ctx.fillText(
    `discord  •  ${new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })}`,
    L.width - L.padX,
    y + L.footerH - 8,
  );
  ctx.textAlign = 'left';

  log.debug(
    `SS rendered: ${groups.length} group(s), ${messages.length} msg(s), h=${totalH}px`,
  );
  return canvas.toBuffer('image/png');
}
