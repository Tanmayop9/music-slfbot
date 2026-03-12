/**
 * Command dispatcher.
 *
 * Owner-only: premium
 */

import { cmdPremium } from '../handlers/premium.js';

// Commands available to owner only
const OWNER_CMDS = {
  premium: cmdPremium,
};

export async function handleCommand(bot, message, command, args, ctx) {
  const { isOwner } = ctx;

  if (isOwner && OWNER_CMDS[command]) {
    return OWNER_CMDS[command](bot, message, args, ctx);
  }
  // Unknown command — silently ignored
}
