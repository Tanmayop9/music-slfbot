/**
 * Premium command handlers — owner-only.
 *
 * premium add    <@user|id>
 * premium remove <@user|id>
 * premium list
 */

import { createLogger } from '../logger.js';

const log = createLogger('Premium');

// ── Shared helper ──────────────────────────────────────────────────────────

function resolveUserId(message, args) {
  if (!args) return null;
  const mention = message.mentions?.users?.first();
  if (mention) return mention.id;
  const id = args.trim().replace(/[<@!>]/g, '');
  return /^\d{17,20}$/.test(id) ? id : null;
}

async function fetchTag(bot, userId) {
  try {
    const u = await bot.users.fetch(userId);
    return u.tag || u.username;
  } catch {
    return userId;
  }
}

// ── Sub-command handlers ───────────────────────────────────────────────────

async function premiumAdd(bot, message, args) {
  const userId = resolveUserId(message, args);
  if (!userId) {
    return message.channel.send(
      `❌ Usage: \`${bot.prefix}premium add <@user|user_id>\``,
    );
  }

  const ownerId = bot.effectiveOwnerId;
  if (userId === ownerId) {
    return message.channel.send('❌ The owner already has full access.');
  }

  const added = await bot.premiumData.add(userId);
  if (!added) {
    return message.channel.send(`ℹ️ \`${userId}\` is already premium.`);
  }

  const tag = await fetchTag(bot, userId);
  log.info(`Premium added: ${tag} (${userId})`);
  return message.channel.send(`✅ **${tag}** (\`${userId}\`) added to premium.`);
}

async function premiumRemove(bot, message, args) {
  const userId = resolveUserId(message, args);
  if (!userId) {
    return message.channel.send(
      `❌ Usage: \`${bot.prefix}premium remove <@user|user_id>\``,
    );
  }

  const removed = await bot.premiumData.remove(userId);
  if (!removed) {
    return message.channel.send(`ℹ️ \`${userId}\` is not in the premium list.`);
  }

  const tag = await fetchTag(bot, userId);
  log.info(`Premium removed: ${tag} (${userId})`);
  return message.channel.send(
    `🗑️ **${tag}** (\`${userId}\`) removed from premium.`,
  );
}

async function premiumList(bot, message) {
  const users = bot.premiumData.list();
  if (!users.length) {
    return message.channel.send('📋 No premium users yet.');
  }

  const lines = [`👑 **Premium Users (${users.length}):**`];
  for (const uid of users) {
    const tag = await fetchTag(bot, uid);
    lines.push(`  • ${tag} (\`${uid}\`)`);
  }
  return message.channel.send(lines.join('\n'));
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

export async function cmdPremium(bot, message, args) {
  const parts   = (args || '').trim().split(/\s+/);
  const sub     = (parts[0] || '').toLowerCase();
  const restStr = parts.slice(1).join(' ');

  switch (sub) {
    case 'add':
      return premiumAdd(bot, message, restStr);
    case 'remove':
    case 'rm':
      return premiumRemove(bot, message, restStr);
    case 'list':
      return premiumList(bot, message);
    default:
      return message.channel.send(
        `❌ **Premium commands (owner only):**\n` +
        `\`${bot.prefix}premium add <@user|id>\` — Grant premium\n` +
        `\`${bot.prefix}premium remove <@user|id>\` — Revoke premium\n` +
        `\`${bot.prefix}premium list\` — List premium users`,
      );
  }
}
