/**
 * Console command interface — lets the bot owner type commands from the
 * terminal while the bot is running.
 *
 * Usage: set "console_channel_id" in config.json to the ID of a Discord
 * channel you want command output delivered to, then type commands at the
 * terminal with or without the configured prefix.
 *
 * Example:
 *   .help
 *   help
 *   .ping
 *   premium list
 */

import readline from 'node:readline';
import { handleCommand } from './commands.js';
import { createLogger } from '../logger.js';

const log = createLogger('Console');

/**
 * Start reading commands from stdin.
 * Safe to call before the bot is fully ready — lines are processed
 * asynchronously and each one fetches the channel on demand.
 *
 * @param {import('./bot.js').SelfBot} bot
 */
export function startConsole(bot) {
  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: false,
  });

  log.info('Console ready — type commands (prefix optional). Ctrl+C to exit.');

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Accept both ".command args" and "command args" (prefix is optional)
    const body     = trimmed.startsWith(bot.prefix) ? trimmed.slice(bot.prefix.length) : trimmed;
    const spaceIdx = body.search(/\s/);
    const command  = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase().trim();
    const args     = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trimStart();

    if (!command) return;

    if (!bot.consoleChannelId) {
      log.warn('Set "console_channel_id" in config.json to route command output to a Discord channel.');
      return;
    }

    let channel;
    try {
      channel = await bot.channels.fetch(bot.consoleChannelId);
    } catch (err) {
      log.error(`Cannot fetch console channel ${bot.consoleChannelId}: ${err.message}`);
      return;
    }

    const fakeMessage = _makeConsoleMessage(bot, channel, command, args);

    log.info(`console> ${command}${args ? ' ' + args : ''}`);
    try {
      await handleCommand(bot, fakeMessage, command, args, { isOwner: true, isPremium: false });
    } catch (err) {
      log.error(`Command '${command}': ${err.stack}`);
    }
  });

  // stdin closed (e.g., non-interactive / piped input) — bot keeps running
  rl.on('close', () => {});
}

/**
 * Build a minimal message-like object that routes Discord API calls to the
 * given channel.  Only the surface needed by the existing command handlers is
 * implemented.
 */
function _makeConsoleMessage(bot, channel, command, args) {
  // Empty Collection-like map for mentions
  const emptyUsers = Object.assign(new Map(), { first: () => undefined });

  return {
    channel,
    guild:            channel.guild ?? null,
    author:           {
      id:       bot.user.id,
      tag:      bot.user?.tag      ?? 'console',
      username: bot.user?.username ?? 'console',
    },
    mentions: {
      users: emptyUsers,
      roles: new Map(),
      has:   () => false,
      size:  0,
    },
    content:          `${bot.prefix}${command}${args ? ' ' + args : ''}`,
    createdTimestamp: Date.now(),
    // Deleting a console-triggered message is a no-op
    delete: () => Promise.resolve(),
    // Edits become new sends so the output still reaches Discord
    edit:   (data) => {
      const text = typeof data === 'string' ? data : (data?.content ?? '');
      return text ? channel.send(text) : Promise.resolve();
    },
  };
}
