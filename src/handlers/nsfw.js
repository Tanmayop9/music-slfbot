/**
 * Fun / NSFW action command handlers.
 *
 * Each command mentions a target user and sends an animated GIF fetched from
 * the waifu.pics public API.  All GIFs served by the /sfw/* endpoints are
 * safe-for-work; the file is named "nsfw" because these commands are typically
 * used in channels that allow adult humour (e.g. spank).
 *
 * spank   — spank a user
 * slap    — slap a user
 * kiss    — kiss a user
 * hug     — hug a user
 * pat     — pat a user
 * cuddle  — cuddle a user
 * poke    — poke a user
 * bite    — bite a user
 */

import { createLogger } from '../logger.js';

const log = createLogger('NSFW');

/** Base URL for the waifu.pics SFW action GIF API. */
const WAIFU_API = 'https://api.waifu.pics/sfw';

/**
 * Fetch a random GIF URL for the given action from waifu.pics.
 * Returns `null` on network / parse errors.
 *
 * @param {string} action
 * @returns {Promise<string|null>}
 */
async function fetchGif(action) {
  try {
    const res  = await fetch(`${WAIFU_API}/${action}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.url ?? null;
  } catch (err) {
    log.error(`fetchGif(${action}): ${err.message}`);
    return null;
  }
}

/**
 * Generic action command factory.
 *
 * Sends "<actor> <verb> <target>! <gif>" and falls back to a text-only
 * message if the GIF API is unavailable.
 *
 * @param {string} action   — API endpoint name (e.g. 'spank')
 * @param {string} verb     — Human-readable verb (e.g. 'spanked')
 * @param {string} emoji    — Leading emoji
 */
function makeActionCmd(action, verb, emoji) {
  return async function actionCmd(bot, message, args) {
    const target = message.mentions?.users?.first();
    if (!target) {
      return message.channel.send(
        `❌ Usage: \`${bot.prefix}${action} @user\``,
      );
    }

    const actor = message.author.username;
    const gif   = await fetchGif(action);
    const text  = `${emoji} **${actor}** ${verb} **${target.username}**!`;

    return gif
      ? message.channel.send(`${text}\n${gif}`)
      : message.channel.send(text);
  };
}

// ── Command exports ────────────────────────────────────────────────────────

export const cmdSpank  = makeActionCmd('spank',  'spanked',  '👋');
export const cmdSlap   = makeActionCmd('slap',   'slapped',  '👋');
export const cmdKiss   = makeActionCmd('kiss',   'kissed',   '💋');
export const cmdHug    = makeActionCmd('hug',    'hugged',   '🤗');
export const cmdPat    = makeActionCmd('pat',    'patted',   '🤚');
export const cmdCuddle = makeActionCmd('cuddle', 'cuddled',  '🥰');
export const cmdPoke   = makeActionCmd('poke',   'poked',    '👉');
export const cmdBite   = makeActionCmd('bite',   'bit',      '😬');
