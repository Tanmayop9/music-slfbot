/**
 * Canvas-based info cards.
 *
 * generateUserInfoCard  – user / member profile card
 * generateServerInfoCard – server statistics card
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  DISCORD,
  getUserColor,
  formatDate,
  fetchImageBuffer,
  roundRect,
} from './helpers.js';
import { createLogger } from '../logger.js';

const log = createLogger('Cards');

const CARD_W  = 720;
const CARD_R  = 14;   // corner radius
const AV_SIZE = 80;
const PAD_X   = 24;
const PAD_Y   = 22;

// ── Shared drawing helpers ─────────────────────────────────────────────────

function drawBackground(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#1e1f22');
  grad.addColorStop(1, '#2b2d31');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, w, h, CARD_R);
  ctx.fill();
}

function drawAccentBar(ctx, h, color = DISCORD.brand) {
  ctx.fillStyle = color;
  roundRect(ctx, 0, 0, 4, h, CARD_R);
  ctx.fill();
}

async function loadAvatarImage(url) {
  if (!url) return null;
  const buf = await fetchImageBuffer(url);
  if (!buf) return null;
  try { return await loadImage(buf); } catch { return null; }
}

function drawCircle(ctx, img, fallbackColor, fallbackLetter, x, y, size) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle    = '#fff';
    ctx.font         = `bold ${Math.floor(size * 0.4)}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((fallbackLetter || '?').toUpperCase(), x + size / 2, y + size / 2);
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function drawSeparator(ctx, x, y, w) {
  ctx.fillStyle = '#3a3c41';
  ctx.fillRect(x, y, w, 1);
}

function drawFieldGrid(ctx, fields, startX, startY, colW, maxFields = 6) {
  const visible = fields.slice(0, maxFields);
  for (let i = 0; i < visible.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const fx  = startX + col * colW;
    const fy  = startY + row * 40;

    ctx.font      = `bold 11px sans-serif`;
    ctx.fillStyle = DISCORD.textMuted;
    ctx.fillText(visible[i][0].toUpperCase(), fx, fy);

    ctx.font      = `13px sans-serif`;
    ctx.fillStyle = DISCORD.text;
    ctx.fillText(String(visible[i][1]), fx, fy + 16);
  }
}

// ── User info card ─────────────────────────────────────────────────────────

/**
 * @param {import('discord.js-selfbot-v13').GuildMember|null} member
 * @param {import('discord.js-selfbot-v13').User} user
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function generateUserInfoCard(member, user) {
  const CARD_H = 210;

  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx    = canvas.getContext('2d');

  drawBackground(ctx, CARD_W, CARD_H);

  // Accent bar uses the member's highest coloured-role hex via displayHexColor.
  // '#000000' means no coloured role — fall back to brand colour.
  const rawAccent  = member?.displayHexColor ?? null;
  const accentHex  = (rawAccent && rawAccent !== '#000000') ? rawAccent : DISCORD.brand;
  drawAccentBar(ctx, CARD_H, accentHex);

  // Avatar
  const displayName = member?.nickname || user.displayName || user.username;
  const avatarURL   = user.displayAvatarURL
    ? user.displayAvatarURL({ size: 128, format: 'png' })
    : (user.avatarURL || '');
  const avatarImg   = await loadAvatarImage(avatarURL);

  const ax = PAD_X + 4; // offset because of the accent bar
  const ay = (CARD_H - AV_SIZE) / 2;

  drawCircle(ctx, avatarImg, getUserColor(user.id), displayName[0], ax, ay, AV_SIZE);

  // ── Text section ───────────────────────────────────────────────────────────
  const textX  = ax + AV_SIZE + 18;
  const textW  = CARD_W - textX - PAD_X;
  let   textY  = PAD_Y + 20;

  // Display name (nickname if set, else displayName)
  ctx.font      = `bold 22px sans-serif`;
  ctx.fillStyle = '#ffffff';
  // Truncate if too long
  let nameStr = displayName;
  while (ctx.measureText(nameStr).width > textW && nameStr.length > 1)
    nameStr = nameStr.slice(0, -1);
  if (nameStr !== displayName) nameStr += '…';
  ctx.fillText(nameStr, textX, textY);

  // Username handle
  textY += 26;
  ctx.font      = `14px sans-serif`;
  ctx.fillStyle = DISCORD.textMuted;
  ctx.fillText(`@${user.username}`, textX, textY);

  // Separator
  textY += 12;
  drawSeparator(ctx, textX, textY, textW);
  textY += 14;

  // Fields
  const fields = [];

  if (user.bot) fields.push(['Type', '🤖 Bot Account']);

  if (user.createdTimestamp || user.createdAt) {
    const d = new Date(user.createdTimestamp ?? user.createdAt);
    fields.push(['Account Created', formatDate(d)]);
  }
  if (member?.joinedTimestamp || member?.joinedAt) {
    const d = new Date(member.joinedTimestamp ?? member.joinedAt);
    fields.push(['Joined Server', formatDate(d)]);
  }
  if (member?.nickname) {
    // Show original username when nickname differs
    fields.push(['Nickname', member.nickname]);
  }

  // Top roles (up to 3)
  if (member?.roles?.cache) {
    const roles = [...member.roles.cache.values()]
      .filter(r => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .slice(0, 3)
      .map(r => r.name);
    if (roles.length) fields.push(['Top Roles', roles.join(', ')]);
  }

  const colW = Math.floor(textW / 2);
  drawFieldGrid(ctx, fields, textX, textY, colW, 6);

  // User ID footer
  ctx.font      = `11px sans-serif`;
  ctx.fillStyle = '#4f545c';
  ctx.textAlign = 'right';
  ctx.fillText(`ID: ${user.id}`, CARD_W - PAD_X, CARD_H - 10);
  ctx.textAlign = 'left';

  log.debug(`userinfo card rendered for ${user.id}`);
  return canvas.toBuffer('image/png');
}

// ── Server info card ───────────────────────────────────────────────────────

/**
 * @param {import('discord.js-selfbot-v13').Guild} guild
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function generateServerInfoCard(guild) {
  const CARD_H = 230;

  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx    = canvas.getContext('2d');

  drawBackground(ctx, CARD_W, CARD_H);
  drawAccentBar(ctx, CARD_H);

  // Server icon
  const iconURL = guild.iconURL
    ? guild.iconURL({ size: 128, format: 'png' })
    : (guild.icon || '');
  const iconImg = await loadAvatarImage(iconURL);

  const ax = PAD_X + 4;
  const ay = (CARD_H - AV_SIZE) / 2;
  drawCircle(ctx, iconImg, DISCORD.brand, guild.name?.[0], ax, ay, AV_SIZE);

  // ── Text section ───────────────────────────────────────────────────────────
  const textX = ax + AV_SIZE + 18;
  const textW = CARD_W - textX - PAD_X;
  let   textY = PAD_Y + 20;

  // Server name
  ctx.font      = `bold 22px sans-serif`;
  ctx.fillStyle = '#ffffff';
  let serverName = guild.name || 'Unknown Server';
  while (ctx.measureText(serverName).width > textW && serverName.length > 1)
    serverName = serverName.slice(0, -1);
  if (serverName !== guild.name) serverName += '…';
  ctx.fillText(serverName, textX, textY);

  // Server ID
  textY += 26;
  ctx.font      = `13px sans-serif`;
  ctx.fillStyle = DISCORD.textMuted;
  ctx.fillText(`ID: ${guild.id}`, textX, textY);

  textY += 12;
  drawSeparator(ctx, textX, textY, textW);
  textY += 14;

  // Stats
  const members   = guild.memberCount
    ?? guild.members?.cache?.size
    ?? '?';
  const textChs   = guild.channels?.cache?.filter(c => c.type === 'GUILD_TEXT').size  ?? '?';
  const voiceChs  = guild.channels?.cache?.filter(c => c.type === 'GUILD_VOICE').size ?? '?';
  const roleCount = guild.roles?.cache
    ? Math.max(0, guild.roles.cache.size - 1) // exclude @everyone
    : '?';
  const boostLvl  = guild.premiumTier ?? 0;
  const boostCnt  = guild.premiumSubscriptionCount ?? 0;

  const fields = [
    ['Members',        `👥 ${Number(members).toLocaleString('en-US')}`],
    ['Text Channels',  `💬 ${textChs}`],
    ['Voice Channels', `🔊 ${voiceChs}`],
    ['Roles',          `🎭 ${roleCount}`],
    ['Boost Level',    `🚀 Tier ${boostLvl} (${boostCnt})`],
  ];

  if (guild.createdTimestamp || guild.createdAt) {
    const d = new Date(guild.createdTimestamp ?? guild.createdAt);
    fields.push(['Created', `📅 ${formatDate(d)}`]);
  }

  const colW = Math.floor(textW / 2);
  drawFieldGrid(ctx, fields, textX, textY, colW, 6);

  log.debug(`serverinfo card rendered for ${guild.id}`);
  return canvas.toBuffer('image/png');
}
