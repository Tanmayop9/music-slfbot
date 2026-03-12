/**
 * Command dispatcher.
 *
 * Owner-only:      premium, say
 * Owner + premium: everything else
 */

import { cmdPremium }  from '../handlers/premium.js';
import { cmdSS }       from '../handlers/ss.js';
import { cmdSnipe, cmdEditSnipe } from '../handlers/snipe.js';
import { cmdUserInfo, cmdAvatar, cmdServerInfo } from '../handlers/userinfo.js';
import {
  cmdPing, cmdStats, cmdSay, cmdPurge,
  cmdGhostPing, cmdSteal, cmdAfk, cmdStatus, cmdHelp,
} from '../handlers/misc.js';
import {
  cmdSpank, cmdSlap, cmdKiss, cmdHug,
  cmdPat, cmdCuddle, cmdPoke, cmdBite,
  cmdLick, cmdTickle, cmdPunch, cmdWink,
  cmdSmack, cmdFlirt, cmdSeduce, cmdStrip,
} from '../handlers/nsfw.js';

// Commands available to owner AND premium users
const OPEN_CMDS = {
  // Screenshot
  ss:          cmdSS,
  screenshot:  cmdSS,

  // Profile
  userinfo:    cmdUserInfo,
  ui:          cmdUserInfo,
  whois:       cmdUserInfo,
  avatar:      cmdAvatar,
  av:          cmdAvatar,
  pfp:         cmdAvatar,
  serverinfo:  cmdServerInfo,
  si:          cmdServerInfo,

  // Snipe
  snipe:       cmdSnipe,
  editsnipe:   cmdEditSnipe,
  esnipe:      cmdEditSnipe,

  // Tools
  ping:        cmdPing,
  stats:       cmdStats,
  purge:       cmdPurge,
  clear:       cmdPurge,
  ghostping:   cmdGhostPing,
  gp:          cmdGhostPing,
  steal:       cmdSteal,
  afk:         cmdAfk,
  status:      cmdStatus,
  presence:    cmdStatus,
  help:        (b, m, _a, ctx) => cmdHelp(b, m, ctx.isOwner),
  h:           (b, m, _a, ctx) => cmdHelp(b, m, ctx.isOwner),

  // Fun / NSFW actions
  spank:       cmdSpank,
  slap:        cmdSlap,
  kiss:        cmdKiss,
  hug:         cmdHug,
  pat:         cmdPat,
  cuddle:      cmdCuddle,
  poke:        cmdPoke,
  bite:        cmdBite,
  lick:        cmdLick,
  tickle:      cmdTickle,
  punch:       cmdPunch,
  wink:        cmdWink,
  smack:       cmdSmack,
  flirt:       cmdFlirt,
  seduce:      cmdSeduce,
  strip:       cmdStrip,
};

// Commands available to owner only
const OWNER_CMDS = {
  premium: cmdPremium,
  say:     cmdSay,
};

export async function handleCommand(bot, message, command, args, ctx) {
  const { isOwner } = ctx;

  if (isOwner && OWNER_CMDS[command]) {
    return OWNER_CMDS[command](bot, message, args, ctx);
  }

  if (OPEN_CMDS[command]) {
    return OPEN_CMDS[command](bot, message, args, ctx);
  }
  // Unknown command — silently ignored
}
