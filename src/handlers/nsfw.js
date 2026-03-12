/**
 * Fun / NSFW action command handlers — all text-based, no external API calls.
 *
 * Every command picks a random message from its own pool and sends it.
 * Use {actor} and {target} as placeholders in message strings.
 *
 * spank   — spank a user
 * slap    — slap a user
 * kiss    — kiss a user
 * hug     — hug a user
 * pat     — pat a user
 * cuddle  — cuddle a user
 * poke    — poke a user
 * bite    — bite a user
 * lick    — lick a user
 * tickle  — tickle a user
 * punch   — punch a user
 * wink    — wink at a user
 * smack   — smack a user's butt
 * flirt   — throw a cheesy pick-up line
 * seduce  — attempt to seduce a user
 * strip   — do a chaotic strip-tease
 */

// ── Helpers ────────────────────────────────────────────────────────────────

/** Return a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Create a text-only action command with a pool of random messages.
 *
 * @param {string}   cmdName  Command name shown in the usage hint.
 * @param {string}   emoji    Leading emoji.
 * @param {string[]} lines    Message pool. Use {actor} and {target} as placeholders.
 */
function makeCmd(cmdName, emoji, lines) {
  return async function cmd(bot, message) {
    const target = message.mentions?.users?.first();
    if (!target) {
      return message.channel.send(
        `❌ You must mention a user. Usage: \`${bot.prefix}${cmdName} @user\``,
      );
    }

    const actor = message.author.username;
    const line  = pick(lines)
      .replace(/\{actor\}/g,  `**${actor}**`)
      .replace(/\{target\}/g, `**${target.username}**`);

    return message.channel.send(`${emoji} ${line}`);
  };
}

// ── Message pools ──────────────────────────────────────────────────────────

const SPANK_LINES = [
  '{actor} gives {target} a firm spank! 💥',
  '{actor} sneaks up and spanks {target} — run! 💨',
  '{actor} spanks {target} so hard the whole channel felt it. 😳',
  'SPANK! {actor} leaves a handprint on {target}. 👋',
  '{actor} winds up and delivers the most legendary spank to {target}. 🏆',
];

const SLAP_LINES = [
  '{actor} slaps {target} across the face! 👋😤',
  '{actor} delivers a crisp slap to {target}. The echo fills the room. 😶',
  '{actor} slaps {target} with the force of a thousand suns. 🌟',
  '{actor} goes for the double slap on {target}. Ruthless. 😬',
  '{actor} slaps {target} — someone had it coming. 💁',
];

const KISS_LINES = [
  '{actor} plants a big kiss on {target}! 😘💋',
  '{actor} sneaks up and kisses {target} on the cheek~ 🌸',
  '{actor} gives {target} the most passionate kiss. 💋🔥',
  '{actor} kisses {target} softly and runs away. 🏃💨💋',
  '{actor} blows a kiss at {target}. Catch it! 😙💨',
];

const HUG_LINES = [
  '{actor} wraps {target} in a big warm hug! 🤗',
  '{actor} squeezes {target} so tight they might pop. 🫂',
  '{actor} runs over and bear-hugs {target}! 🐻',
  '{actor} gives {target} the coziest hug imaginable. ☁️',
  '{actor} hugs {target} and refuses to let go. 🤗💕',
];

const PAT_LINES = [
  '{actor} gently pats {target} on the head. 🤚',
  '{actor} gives {target} a proud head pat. Good job! 👏',
  '{actor} pats {target} like a good dog. 🐶',
  '{actor} aggressively pats {target} on the head. 🤚🤚🤚',
  '{actor} gives {target} the most affectionate pat. 💛',
];

const CUDDLE_LINES = [
  '{actor} cuddles up next to {target}. So warm~ 🥰',
  '{actor} wraps a blanket around {target} and cuddles them. 🛋️',
  '{actor} nuzzles into {target} and falls asleep. 💤',
  '{actor} and {target} are now a cuddle puddle. 🫂💕',
  '{actor} refuses to stop cuddling {target}. 😤🤗',
];

const POKE_LINES = [
  '{actor} pokes {target}. 👉',
  '{actor} pokes {target} repeatedly until they respond. 👉👉👉',
  '{actor} aggressively pokes {target} in the ribs. 😠👉',
  '{actor} pokes {target} and immediately looks away pretending to be innocent. 😇',
  '{actor} pokes {target} in the most annoying way possible. 😈👉',
];

const BITE_LINES = [
  '{actor} bites {target}! 😬🦷',
  '{actor} chomps down on {target}\'s shoulder. NOM. 🦴',
  '{actor} sneaks up and bites {target} like a feral creature. 🐺',
  '{actor} lightly nibbles on {target}\'s ear. 👂😬',
  '{actor} bites {target} hard enough to leave a mark. Possessive much? 😏🦷',
];

const LICK_LINES = [
  '{actor} licks {target} from chin to forehead. Gross. 👅',
  '{actor} sneaks up and licks {target}\'s cheek! 😛',
  '{actor} gives {target} a big sloppy lick. 🐶👅',
  '{actor} licks {target} — nobody asked but here we are. 👅',
  '{actor} licks {target} like an ice cream cone on a hot day. 🍦👅',
];

const TICKLE_LINES = [
  '{actor} tickles {target} mercilessly! 🤣',
  '{actor} finds {target}\'s most ticklish spot. No escape. 😂',
  '{actor} wiggles fingers at {target} — the tickle is incoming! 🤣👐',
  '{actor} launches a full tickle assault on {target}. 😂💀',
  '{actor} tickles {target} until tears run down their face. 🤣',
];

const PUNCH_LINES = [
  '{actor} throws a punch straight at {target}! 👊💥',
  '{actor} delivers a right hook to {target}. BOOM. 💥',
  '{actor} uppercuts {target} into next week. 👊🚀',
  '{actor} punches {target} so hard their ancestors felt it. 💀👊',
  '{actor} lands a jab on {target}. Not pulling any punches today! 🥊',
];

const WINK_LINES = [
  '{actor} winks at {target}. 😉',
  '{actor} throws a cheeky wink at {target}. 😏',
  '{actor} gives {target} the most suggestive wink. 😉🔥',
  '{actor} winks at {target} so hard they pulled a face muscle. 😉😂',
  '{actor} double-winks at {target}. Twice as cheeky. 😉😉',
];

const SMACK_LINES = [
  '{actor} gives {target} a firm smack on the booty! 🍑💥',
  '{actor} sneaks up and smacks {target}\'s behind — RUN! 🍑💨',
  '{actor} delivers a legendary smack to {target}. The impact echoes. 🍑🔔',
  'SMACK! {actor} leaves a handprint on {target}\'s backside. 🍑👋',
  '{actor} smacks {target} so hard the whole server felt it. 😳🍑',
];

const FLIRT_LINES = [
  '{actor} to {target}: "Are you a magician? Whenever I look at you, everyone else disappears." 🪄😍',
  '{actor} slides over to {target}: "Are you a keyboard? Because you\'re just my type." ⌨️💘',
  '{actor} whispers to {target}: "You must be made of copper and tellurium, because you\'re CuTe." 🧪😏',
  '{actor} nudges {target}: "Is your name Wi-Fi? Because I\'m feeling a connection." 📶💕',
  '{actor} tells {target}: "Do you believe in love at first ping, or should I message again?" 💌',
  '{actor} smirks at {target}: "Are you a Discord boost? Because you\'re upgrading my mood." 🚀💖',
  '{actor} leans over to {target}: "Do you have a map? I keep getting lost in your eyes." 🗺️',
];

const SEDUCE_LINES = [
  '{actor} leans in close and whispers something into {target}\'s ear... 🥵😈',
  '{actor} twirls hair and bats eyes at {target} dangerously... 💋😏',
  '{actor} sends {target} a wink that could melt steel beams. 😉🔥',
  '{actor} slowly walks over and sits *dangerously* close to {target}... 😳',
  '{actor} traces a finger along {target}\'s arm and raises an eyebrow. 😈💅',
  '{actor} stares {target} dead in the eyes and says nothing. The silence speaks volumes. 👁️😈',
];

const STRIP_LINES = [
  '{actor} starts a slow, sultry strip-tease just for {target}... 💃🔥 *reveals another layer of clothes underneath* 👕👕',
  '{actor} dramatically removes their jacket and throws it at {target}. 🧥😤',
  '{actor} does the most chaotic strip-tease known to mankind for {target}. Somehow a sock ends up on the ceiling. 🧦🙈',
  '{actor} begins stripping for {target}... trips on their shoelaces and faceplants. 💀👟',
  '{actor} winks at {target} and slowly unbuttons... just kidding, it\'s a turtleneck. 😈🐢',
];

// ── Command exports ────────────────────────────────────────────────────────

export const cmdSpank  = makeCmd('spank',  '👋', SPANK_LINES);
export const cmdSlap   = makeCmd('slap',   '👋', SLAP_LINES);
export const cmdKiss   = makeCmd('kiss',   '💋', KISS_LINES);
export const cmdHug    = makeCmd('hug',    '🤗', HUG_LINES);
export const cmdPat    = makeCmd('pat',    '🤚', PAT_LINES);
export const cmdCuddle = makeCmd('cuddle', '🥰', CUDDLE_LINES);
export const cmdPoke   = makeCmd('poke',   '👉', POKE_LINES);
export const cmdBite   = makeCmd('bite',   '😬', BITE_LINES);
export const cmdLick   = makeCmd('lick',   '👅', LICK_LINES);
export const cmdTickle = makeCmd('tickle', '🤣', TICKLE_LINES);
export const cmdPunch  = makeCmd('punch',  '👊', PUNCH_LINES);
export const cmdWink   = makeCmd('wink',   '😉', WINK_LINES);
export const cmdSmack  = makeCmd('smack',  '🍑', SMACK_LINES);
export const cmdFlirt  = makeCmd('flirt',  '😘', FLIRT_LINES);
export const cmdSeduce = makeCmd('seduce', '😈', SEDUCE_LINES);
export const cmdStrip  = makeCmd('strip',  '💃', STRIP_LINES);
