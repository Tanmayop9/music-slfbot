/**
 * Miscellaneous command handlers.
 *
 * ping        — API + WS latency
 * stats       — bot statistics
 * say <text>  — send message as bot (owner only)
 * purge [n]   — delete own messages
 * ghostping   — ping then immediately delete
 * steal       — steal a custom emoji into the current server
 * afk [reason]— toggle AFK mode (auto-reply to mentions)
 * status      — change bot presence / activity
 * help        — command list
 */

import { createLogger } from '../logger.js';

const log = createLogger('Misc');

/** Delay between individual message deletions to stay below the rate limit. */
const RATE_LIMIT_DELAY_MS = 350;

// ── AFK state (in-memory) ──────────────────────────────────────────────────

/** @type {Map<string, {reason:string, since:number}>} */
const afkMap = new Map();

export function getAfkData(userId) { return afkMap.get(userId) ?? null; }
export function clearAfk(userId)   { afkMap.delete(userId); }

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtUptime(ms) {
  const s   = Math.floor(ms / 1000);
  const d   = Math.floor(s / 86400);
  const h   = Math.floor((s % 86400) / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d)   parts.push(`${d}d`);
  if (h)   parts.push(`${h}h`);
  if (m)   parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Command handlers ───────────────────────────────────────────────────────

export async function cmdPing(bot, message) {
  const start = Date.now();
  const msg   = await message.channel.send('🏓 Pinging…');
  const round = Date.now() - start;
  return msg.edit(
    `🏓 **Pong!**\n📡 Message Round-trip: \`${round}ms\`\n💓 WebSocket: \`${bot.ws.ping}ms\``,
  );
}

export async function cmdStats(bot, message) {
  const memMB    = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
  const premium  = bot.premiumData?.list().length ?? 0;
  const lines = [
    '**📊 Bot Stats**',
    '',
    `🏠 **Servers:**       \`${bot.guilds.cache.size}\``,
    `👥 **Cached users:**  \`${bot.users.cache.size}\``,
    `💬 **Channels:**      \`${bot.channels.cache.size}\``,
    `👑 **Premium users:** \`${premium}\``,
    `⏱️ **Uptime:**        \`${fmtUptime(bot.uptime ?? 0)}\``,
    `💾 **Memory:**        \`${memMB} MB\``,
    `🟢 **Node.js:**       \`${process.version}\``,
  ];
  return message.channel.send(lines.join('\n'));
}

export async function cmdSay(bot, message, args) {
  if (!args) {
    return message.channel.send(`❌ Usage: \`${bot.prefix}say <text>\``);
  }
  await message.delete().catch(() => {});
  return message.channel.send(args);
}

export async function cmdPurge(bot, message, args) {
  const rawCount = parseInt(args || '10', 10);
  const count    = isNaN(rawCount) ? 10 : Math.min(Math.max(rawCount, 1), 100);

  const status = await message.channel.send(
    `🗑️ Deleting up to \`${count}\` of your messages…`,
  );

  try {
    const fetched = await message.channel.messages.fetch({ limit: 100 });
    const ownerId = bot.effectiveOwnerId;

    const toDelete = [...fetched.values()]
      .filter(m => m.author.id === ownerId && m.id !== status.id)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
      .slice(0, count);

    let deleted = 0;
    for (const m of toDelete) {
      try {
        await m.delete();
        deleted++;
        await sleep(RATE_LIMIT_DELAY_MS); // stay well below rate-limit
      } catch { /* message already deleted or no permission */ }
    }

    const confirm = await status.edit({ content: `✅ Deleted \`${deleted}\` message(s).` });
    setTimeout(() => confirm.delete().catch(() => {}), 4000);

  } catch (err) {
    log.error(`purge: ${err.message}`);
    return status.edit({ content: `❌ ${err.message}` });
  }
}

export async function cmdGhostPing(bot, message, args) {
  const target = message.mentions?.users?.first();
  if (!target) {
    return message.channel.send(
      `❌ Usage: \`${bot.prefix}ghostping @user\``,
    );
  }
  await message.delete().catch(() => {});
  const m = await message.channel.send(`<@${target.id}>`);
  await m.delete().catch(() => {});
}

export async function cmdSteal(bot, message, args) {
  if (!message.guild) {
    return message.channel.send('❌ This command can only be used in a server.');
  }
  if (!args) {
    return message.channel.send(
      `❌ Usage: \`${bot.prefix}steal <:emoji:>\``,
    );
  }

  const match = args.match(/<(a?):(\w+):(\d+)>/);
  if (!match) {
    return message.channel.send(
      '❌ Provide a valid custom emoji to steal — e.g. `steal <:wave:123456789>`',
    );
  }

  const [, animated, name, id] = match;
  const ext = animated ? 'gif' : 'png';
  const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?quality=lossless`;

  try {
    const emoji = await message.guild.emojis.create(url, name);
    return message.channel.send(`✅ Stolen! Added **${emoji.name}** ${emoji}`);
  } catch (err) {
    log.error(`steal: ${err.message}`);
    return message.channel.send(`❌ Failed to add emoji: ${err.message}`);
  }
}

export async function cmdAfk(bot, message, args) {
  const userId   = message.author.id;
  const existing = afkMap.get(userId);

  if (existing) {
    afkMap.delete(userId);
    const gone = fmtUptime(Date.now() - existing.since);
    return message.channel.send(
      `✅ Welcome back! You were AFK for \`${gone}\`.`,
    );
  }

  const reason = args || 'AFK';
  afkMap.set(userId, { reason, since: Date.now() });
  return message.channel.send(`💤 You are now AFK: **${reason}**`);
}

export async function cmdStatus(bot, message, args) {
  if (!args) {
    return message.channel.send(
      `❌ **Status command usage:**\n` +
      `\`${bot.prefix}status <online|idle|dnd|invisible>\` — Set online status\n` +
      `\`${bot.prefix}status playing <text>\` — Set activity\n` +
      `\`${bot.prefix}status watching <text>\`\n` +
      `\`${bot.prefix}status listening <text>\`\n` +
      `\`${bot.prefix}status competing <text>\`\n` +
      `\`${bot.prefix}status clear\` — Clear presence`,
    );
  }

  const parts  = args.trim().split(/\s+/);
  const type   = parts[0].toLowerCase();
  const text   = parts.slice(1).join(' ');

  const onlineStatuses = new Set(['online', 'idle', 'dnd', 'invisible']);
  const activityTypes  = { playing: 0, streaming: 1, listening: 2, watching: 3, competing: 5 };

  if (type === 'clear' || type === 'reset') {
    try {
      await bot.user.setPresence({ activities: [], status: 'online' });
      return message.channel.send('✅ Presence cleared.');
    } catch (err) {
      return message.channel.send(`❌ ${err.message}`);
    }
  }

  if (onlineStatuses.has(type)) {
    try {
      await bot.user.setStatus(type);
      return message.channel.send(`✅ Status set to **${type}**.`);
    } catch (err) {
      return message.channel.send(`❌ ${err.message}`);
    }
  }

  if (activityTypes[type] !== undefined) {
    if (!text) {
      return message.channel.send(
        `❌ Usage: \`${bot.prefix}status ${type} <text>\``,
      );
    }
    try {
      await bot.user.setActivity(text, { type: activityTypes[type] });
      return message.channel.send(`✅ Activity set to **${type}** *${text}*.`);
    } catch (err) {
      return message.channel.send(`❌ ${err.message}`);
    }
  }

  return message.channel.send(
    `❌ Unknown type \`${type}\`. Valid types: \`online\` \`idle\` \`dnd\` \`invisible\` \`playing\` \`watching\` \`listening\` \`competing\` \`clear\``,
  );
}

export async function cmdHelp(bot, message, isOwner) {
  const p = bot.prefix;
  const lines = [
    '**📋 Available Commands**',
    '',
    '**📸 Screenshot**',
    `\`${p}ss @user [count]\` — Canvas screenshot of a user's messages`,
    '',
    '**👤 Profile**',
    `\`${p}userinfo [@user]\` — User info card`,
    `\`${p}avatar [@user]\` — Full-size avatar`,
    `\`${p}serverinfo\` — Server info card`,
    '',
    '**🔍 Snipe**',
    `\`${p}snipe\` — Last deleted message`,
    `\`${p}editsnipe\` — Last edited message`,
    '',
    '**🛠️ Tools**',
    `\`${p}purge [count]\` — Delete your own messages (default 10, max 100)`,
    `\`${p}ghostping @user\` — Ping + instant delete`,
    `\`${p}steal <:emoji:>\` — Add a custom emoji to this server`,
    `\`${p}afk [reason]\` — Toggle AFK (auto-replies to mentions)`,
    `\`${p}status <type> [text]\` — Change bot presence`,
    `\`${p}ping\` — API & WebSocket latency`,
    `\`${p}stats\` — Bot statistics`,
    '',
    '**🎭 Fun Actions**',
    `\`${p}hug @user\` — Hug someone 🤗`,
    `\`${p}pat @user\` — Pat someone 🤚`,
    `\`${p}cuddle @user\` — Cuddle someone 🥰`,
    `\`${p}kiss @user\` — Kiss someone 💋`,
    `\`${p}poke @user\` — Poke someone 👉`,
    `\`${p}wink @user\` — Wink at someone 😉`,
    `\`${p}punch @user\` — Punch someone 👊`,
    `\`${p}tickle @user\` — Tickle someone 🤣`,
    '',
    '**🔞 Naughty Actions**',
    `\`${p}spank @user\` — Spank someone 👋`,
    `\`${p}slap @user\` — Slap someone 👋`,
    `\`${p}bite @user\` — Bite someone 😬`,
    `\`${p}lick @user\` — Lick someone 👅`,
    `\`${p}smack @user\` — Smack someone's butt 🍑`,
    `\`${p}flirt @user\` — Throw a cheesy pick-up line 😘`,
    `\`${p}seduce @user\` — Attempt to seduce someone 😈`,
    `\`${p}strip @user\` — Do a strip-tease for someone 💃`,
  ];

  if (isOwner) {
    lines.push(
      '',
      '**👑 Owner Only**',
      `\`${p}premium add <@user|id>\` — Grant premium`,
      `\`${p}premium remove <@user|id>\` — Revoke premium`,
      `\`${p}premium list\` — List premium users`,
      `\`${p}say <text>\` — Send a message as the bot`,
    );
  }

  return message.channel.send(lines.join('\n'));
}
