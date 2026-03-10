/**
 * `ss` command handler.
 *
 * - Deletes the invoker's command message immediately.
 * - Fetches the target user's guild member to resolve:
 *     • Nickname           (shown instead of global display name when set)
 *     • Real top-role colour  (member.displayHexColor, '#000000' → fallback)
 *     • Guild-specific avatar (has priority over global avatar)
 *     • Avatar decoration  (fetched from Discord API via user object)
 *     • Top role icon      (highest role with an icon hash set)
 * - Renders a canvas screenshot and posts it to the channel.
 */

import { generateSS } from '../canvas/ss.js';
import { createLogger } from '../logger.js';

const log = createLogger('SS');

// ── Helper: resolve decoration URL from a User object ─────────────────────

function getAvatarDecorationURL(user) {
  // discord.js-selfbot-v13 v3.x exposes avatarDecorationURL() when data present
  if (typeof user.avatarDecorationURL === 'function') {
    try {
      const url = user.avatarDecorationURL({ size: 240 });
      if (url) return url;
    } catch {}
  }

  // Fallback: construct manually from avatarDecorationData.asset or avatarDecoration
  const asset =
    user.avatarDecorationData?.asset ??
    user.avatarDecoration           ??
    null;

  if (!asset) return null;
  return `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?size=240&passthrough=true`;
}

// ── Helper: highest role that has an icon ─────────────────────────────────

function getRoleIconURL(member) {
  if (!member?.roles?.cache) return null;

  const role = [...member.roles.cache.values()]
    .filter(r => r.icon && r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)[0];

  if (!role) return null;

  // Use the library method when available, otherwise construct manually
  if (typeof role.iconURL === 'function') {
    try {
      const url = role.iconURL({ size: 20, format: 'png' });
      if (url) return url;
    } catch {}
  }

  return `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png?size=20`;
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function cmdSS(bot, message, args) {
  // 0. Delete the command message immediately; log if it fails (e.g. no permission)
  message.delete().catch(err => log.warn(`Could not delete command message: ${err.message}`));

  if (!message.guild) {
    return message.channel.send('❌ `ss` can only be used inside a server.');
  }
  if (!args) {
    return message.channel.send(`❌ Usage: \`${bot.prefix}ss @user [count]\``);
  }

  // ── 1. Resolve target user ───────────────────────────────────────────────
  const parts      = args.trim().split(/\s+/);
  let   targetUser = null;
  let   count      = 30;

  const mention = message.mentions?.users?.first();
  if (mention) {
    targetUser = mention;
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^\d+$/.test(last)) {
      count = Math.min(parseInt(last, 10), 50);
    }
  } else {
    const rawId = parts[0].replace(/[<@!>]/g, '');
    if (/^\d{17,20}$/.test(rawId)) {
      try {
        targetUser = await bot.users.fetch(rawId);
      } catch {
        return message.channel.send('❌ Could not find that user.');
      }
      if (parts.length > 1 && /^\d+$/.test(parts[1])) {
        count = Math.min(parseInt(parts[1], 10), 50);
      }
    }
  }

  if (!targetUser) {
    return message.channel.send(`❌ Usage: \`${bot.prefix}ss @user [count]\``);
  }

  // ── 2. Fetch fresh user data (decoration is only present on forced fetch) ─
  let freshUser = targetUser;
  try {
    freshUser = await bot.users.fetch(targetUser.id, { force: true });
  } catch { /* use original */ }

  // ── 3. Fetch guild member (nickname, role colour, guild avatar, role icon) ─
  let member = null;
  try {
    member = await message.guild.members.fetch(targetUser.id);
  } catch { /* user not in guild — continue without member data */ }

  const nickname      = member?.nickname ?? null;

  // Real top-role colour; '#000000' means "no coloured role" in Discord
  const rawHex        = member?.displayHexColor ?? null;
  const roleColor     = (rawHex && rawHex !== '#000000') ? rawHex : null;

  // Guild-specific avatar has priority over global avatar
  const avatarURL     =
    member?.avatarURL?.({ size: 64, format: 'png' }) ??
    freshUser.displayAvatarURL({ size: 64, format: 'png' });

  const decorationURL = getAvatarDecorationURL(freshUser);
  const roleIconURL   = getRoleIconURL(member);

  // Best display name for the caption
  const displayName   = nickname ?? freshUser.displayName ?? freshUser.username;

  // ── 4. Fetch recent messages from this user ──────────────────────────────
  const status = await message.channel.send(
    `📸 Generating screenshot for **${displayName}**…`,
  );

  try {
    const fetched  = await message.channel.messages.fetch({ limit: 100 });
    const filtered = [...fetched.values()]
      .filter(m => m.author.id === targetUser.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-count);

    if (!filtered.length) {
      return status.edit({
        content: `❌ No recent messages found from **${displayName}** in this channel.`,
      });
    }

    // ── 5. Build normalised message data ───────────────────────────────────
    const msgData = filtered.map(m => ({
      id:        m.id,
      content:   m.content || '',
      timestamp: m.createdAt,
      author: {
        id:            m.author.id,
        username:      m.author.username,
        displayName:   m.author.displayName || m.author.username,
        nickname,        // server nickname (null if not set)
        roleColor,       // real top-role hex (null → hash-palette fallback)
        avatarURL,       // guild avatar preferred over global
        decorationURL,   // avatar decoration CDN URL (null if none)
        roleIconURL,     // highest role with icon (null if none)
        bot:           m.author.bot,
      },
      attachments: [...m.attachments.values()].map(a => ({
        name:        a.name,
        url:         a.url,
        contentType: a.contentType || '',
      })),
      embeds: m.embeds.length,
    }));

    // ── 6. Render canvas ───────────────────────────────────────────────────
    const imgBuf = await generateSS(msgData);

    await status.delete().catch(() => {});
    return message.channel.send({
      content: `📸 **${displayName}**'s messages (${filtered.length} shown)`,
      files:   [{ attachment: imgBuf, name: 'screenshot.png' }],
    });

  } catch (err) {
    log.error(`SS failed: ${err.stack}`);
    return status.edit({ content: `❌ Failed to generate screenshot: ${err.message}` });
  }
}
