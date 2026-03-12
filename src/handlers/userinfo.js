/**
 * User-info, avatar, and server-info command handlers.
 *
 * userinfo  [@user|id]  — canvas member card
 * avatar    [@user|id]  — full-size avatar
 * serverinfo            — canvas server card
 */

import { generateUserInfoCard, generateServerInfoCard } from '../canvas/cards.js';
import { createLogger } from '../logger.js';

const log = createLogger('UserInfo');

// ── Helpers ────────────────────────────────────────────────────────────────

async function resolveUser(bot, message, args) {
  const mention = message.mentions?.users?.first();
  if (mention) return mention;

  if (args) {
    const rawId = args.trim().replace(/[<@!>]/g, '');
    if (/^\d{17,20}$/.test(rawId)) {
      try { return await bot.users.fetch(rawId); } catch {}
    }
  }

  return message.author;
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function cmdUserInfo(bot, message, args) {
  const targetUser = await resolveUser(bot, message, args);

  let member = null;
  if (message.guild) {
    try { member = await message.guild.members.fetch(targetUser.id); } catch {}
  }

  const status = await message.channel.send('🔍 Building user card…');
  try {
    const img = await generateUserInfoCard(member, targetUser);
    await status.delete().catch(() => {});
    return message.channel.send({
      files: [{ attachment: img, name: 'userinfo.png' }],
    });
  } catch (err) {
    log.error(`userinfo failed: ${err.message}`);
    return status.edit({ content: `❌ ${err.message}` });
  }
}

export async function cmdAvatar(bot, message, args) {
  const targetUser = await resolveUser(bot, message, args);

  // Prefer the guild-specific avatar when the member has one
  let url = null;
  if (message.guild) {
    try {
      const member = await message.guild.members.fetch(targetUser.id);
      url = member.avatarURL?.({ size: 4096, dynamic: true }) ?? null;
    } catch {}
  }
  if (!url) {
    url = targetUser.displayAvatarURL({ size: 4096, dynamic: true });
  }

  return message.channel.send({
    content: `🖼️ **${targetUser.tag ?? targetUser.username}**'s avatar`,
    files:   [{ attachment: url, name: 'avatar.png' }],
  });
}

export async function cmdServerInfo(bot, message) {
  if (!message.guild) {
    return message.channel.send(
      '❌ This command can only be used inside a server.',
    );
  }

  const status = await message.channel.send('🔍 Building server card…');
  try {
    const img = await generateServerInfoCard(message.guild);
    await status.delete().catch(() => {});
    return message.channel.send({
      files: [{ attachment: img, name: 'serverinfo.png' }],
    });
  } catch (err) {
    log.error(`serverinfo failed: ${err.message}`);
    return status.edit({ content: `❌ ${err.message}` });
  }
}
