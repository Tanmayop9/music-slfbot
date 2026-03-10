/**
 * Command handlers for the music selfbot.
 *
 * All commands are owner-only (checked in core/bot.js before dispatch).
 *
 * Music commands:
 *   play (p), pause, resume (r), stop, skip (s), queue (q), clear, shuffle,
 *   loop, volume (vol), seek, nowplaying (np), filter (f), filters,
 *   clearfilter (cf), remove, disconnect (dc), move, search
 *
 * Sniper commands (owner only, always):
 *   sniper status  — live status panel
 *   sniper add <code>
 *   sniper remove <code>
 *   sniper list
 *   sniper pause
 *   sniper resume
 *   sniper history [N]
 *   sniper clear    — clear claim history
 *   sniper guilds   — list claimer guilds
 */

import { LoadType }   from '../lavalink/models.js';
import { listFilters } from '../music/filters.js';
import { LoopMode }   from '../music/queue.js';
import { createLogger } from '../logger.js';
import { resolveWithYtdl } from '../ytdl/fallback.js';

const log = createLogger('Commands');

const SOURCE_MAP = {
  youtube:    'ytsearch:',
  yt:         'ytsearch:',
  spotify:    'spsearch:',
  sp:         'spsearch:',
  soundcloud: 'scsearch:',
  sc:         'scsearch:',
  jiosaavn:   'jssearch:',
  js:         'jssearch:',
  apple:      'amsearch:',
  am:         'amsearch:',
  deezer:     'dzsearch:',
  dz:         'dzsearch:',
};

export const COMMAND_MAP = {
  play:        '_cmdPlay',
  p:           '_cmdPlay',
  pause:       '_cmdPause',
  resume:      '_cmdResume',
  r:           '_cmdResume',
  stop:        '_cmdStop',
  skip:        '_cmdSkip',
  s:           '_cmdSkip',
  queue:       '_cmdQueue',
  q:           '_cmdQueue',
  clear:       '_cmdClearQueue',
  shuffle:     '_cmdShuffle',
  loop:        '_cmdLoop',
  volume:      '_cmdVolume',
  vol:         '_cmdVolume',
  seek:        '_cmdSeek',
  nowplaying:  '_cmdNowplaying',
  np:          '_cmdNowplaying',
  filter:      '_cmdFilter',
  f:           '_cmdFilter',
  filters:     '_cmdFilters',
  clearfilter: '_cmdClearfilter',
  cf:          '_cmdClearfilter',
  remove:      '_cmdRemove',
  disconnect:  '_cmdDisconnect',
  dc:          '_cmdDisconnect',
  move:        '_cmdMove',
  search:      '_cmdSearch',
  sniper:      '_cmdSniper',
  sn:          '_cmdSniper',
};

export async function handleCommand(bot, message, command, args) {
  const funcName = COMMAND_MAP[command];
  if (!funcName) return;
  const handler = handlers[funcName];
  if (handler) await handler(bot, message, args);
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function _ensureVoice(bot, message) {
  const guild = message.guild;
  if (!guild) return null;
  const member = guild.members.cache.get(message.author.id);
  if (!member || !member.voice?.channel) {
    await message.channel.send('❌ Join a voice channel first!');
    return null;
  }
  let player = bot.getPlayer(guild.id);
  if (!player || !player.connected) {
    const ok = await bot.joinVoice(member.voice.channel);
    if (!ok) {
      await message.channel.send('❌ Failed to join your voice channel!');
      return null;
    }
  }
  return bot.getPlayer(guild.id);
}

function _buildIdentifier(args) {
  if (args.startsWith('http://') || args.startsWith('https://')) return args;
  const lc = args.toLowerCase();
  for (const [shorthand, prefix] of Object.entries(SOURCE_MAP)) {
    if (lc.startsWith(shorthand + ':')) {
      return `${prefix}${args.slice(shorthand.length + 1)}`;
    }
  }
  return `ytsearch:${args}`;
}

function _fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Music commands ─────────────────────────────────────────────────────────────

async function _cmdPlay(bot, message, args) {
  if (!args) {
    const player = bot.getPlayer(message.guild?.id);
    if (player && player.paused) {
      await player.resume();
      await message.channel.send('▶️ Resumed!');
    } else {
      await message.channel.send(`❌ Usage: \`${bot.prefix}play <song name or URL>\``);
    }
    return;
  }

  const player = await _ensureVoice(bot, message);
  if (!player) return;

  const identifier = _buildIdentifier(args);
  const status = await message.channel.send(`🔍 Searching for \`${args}\`…`);
  let result = await player.node.loadTracks(identifier);

  if (result.isEmpty) {
    // Primary Lavalink node found nothing — try yt-dlp as a backup source.
    await status.edit({ content: `⚙️ No Lavalink results — trying yt-dlp fallback…` });
    const ytdl = await resolveWithYtdl(args);
    if (ytdl) {
      result = await player.node.loadTracks(ytdl.url);
    }
  }

  if (result.isEmpty) {
    await status.edit({ content: '❌ No results found!' });
    return;
  }

  if (result.loadType === LoadType.PLAYLIST) {
    const count = player.queue.addMany(result.tracks);
    const name  = result.playlistInfo?.name || 'Playlist';
    if (!player.current) {
      const first = player.queue.getNext();
      if (first) {
        first.requester = String(message.author);
        await player.play(first);
        await _setVoiceStatus(bot, player, first.info.title);
      }
    }
    await status.edit({ content: `📋 Queued **${count}** tracks from **${name}**!` });
    return;
  }

  const track = result.tracks[0];
  track.requester = String(message.author);
  if (!player.current) {
    await player.play(track);
    await _setVoiceStatus(bot, player, track.info.title);
    await status.edit({
      content: `🎵 Now playing: **${track.info.title}** — *${track.info.author}* \`[${track.durationStr}]\``,
    });
  } else {
    player.queue.add(track);
    await status.edit({
      content: `➕ Added **${track.info.title}** to queue (position #${player.queue.size})`,
    });
  }
}

async function _setVoiceStatus(bot, player, title) {
  if (player.voiceChannelId) {
    await bot.updateVoiceStatus(player.voiceChannelId, `🎵 ${title}`);
  }
}

async function _cmdPause(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || !player.current) { await message.channel.send('❌ Nothing is playing!'); return; }
  await player.pause();
  await message.channel.send('⏸️ Paused!');
}

async function _cmdResume(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player) { await message.channel.send('❌ No active player!'); return; }
  await player.resume();
  await message.channel.send('▶️ Resumed!');
}

async function _cmdStop(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player) { await message.channel.send('❌ No active player!'); return; }
  await player.stop();
  await message.channel.send('⏹️ Stopped and cleared the queue!');
}

async function _cmdSkip(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || !player.current) { await message.channel.send('❌ Nothing is playing!'); return; }
  const next = await player.skip();
  if (next) {
    await _setVoiceStatus(bot, player, next.info.title);
    await message.channel.send(`⏭️ Skipped! Now playing: **${next.info.title}**`);
  } else {
    await message.channel.send('⏭️ Skipped! Queue is empty.');
  }
}

async function _cmdQueue(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player) { await message.channel.send('❌ No active player!'); return; }
  const lines = [];
  if (player.current) {
    const elS = Math.floor(player.position / 1000);
    const totS = Math.floor(player.current.info.length / 1000);
    lines.push(
      '**🎵 Now Playing:**',
      `  \`${player.current.info.title}\` — \`${Math.floor(elS/60)}:${String(elS%60).padStart(2,'0')}\` / \`${Math.floor(totS/60)}:${String(totS%60).padStart(2,'0')}\``,
      '',
    );
  }
  const tracks = player.queue.tracks;
  if (!tracks.length) {
    lines.push('📋 Queue is empty.');
  } else {
    lines.push(`**📋 Queue — ${tracks.length} track(s) [${_fmtMs(player.queue.totalDurationMs)}]:**`);
    for (let i = 0; i < Math.min(10, tracks.length); i++) {
      lines.push(`  \`${String(i+1).padStart(2)}.\` ${tracks[i].info.title} \`[${tracks[i].durationStr}]\``);
    }
    if (tracks.length > 10) lines.push(`  *…and ${tracks.length - 10} more*`);
  }
  const extras = [];
  if (player.loopMode !== LoopMode.NONE) extras.push(`🔁 Loop: \`${player.loopMode}\``);
  if (player.currentFilter)              extras.push(`🎛️ Filter: \`${player.currentFilter}\``);
  extras.push(`🔊 Vol: \`${player.volume}%\``);
  lines.push('', extras.join('  '));
  await message.channel.send(lines.join('\n'));
}

async function _cmdClearQueue(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player) { await message.channel.send('❌ No active player!'); return; }
  player.queue.clear();
  await message.channel.send('🗑️ Queue cleared!');
}

async function _cmdShuffle(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || player.queue.isEmpty) { await message.channel.send('❌ Queue is empty!'); return; }
  player.queue.shuffle();
  await message.channel.send('🔀 Queue shuffled!');
}

async function _cmdLoop(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player) { await message.channel.send('❌ No active player!'); return; }
  const arg = args.toLowerCase().trim();
  const modeMap = {
    track: LoopMode.TRACK,
    queue: LoopMode.QUEUE,
    off:   LoopMode.NONE,
    none:  LoopMode.NONE,
    '':    null,
  };
  if (!Object.prototype.hasOwnProperty.call(modeMap, arg)) {
    await message.channel.send('❌ Usage: `loop [track|queue|off]`');
    return;
  }
  let newMode;
  if (modeMap[arg] === null) {
    const cycle = [LoopMode.NONE, LoopMode.TRACK, LoopMode.QUEUE];
    const idx   = cycle.indexOf(player.loopMode);
    newMode     = cycle[(idx + 1) % cycle.length];
  } else {
    newMode = modeMap[arg];
  }
  player.setLoop(newMode);
  if (bot.guildSettings && message.guild) {
    await bot.guildSettings.saveLoopMode(message.guild.id, newMode);
  }
  const icons = { [LoopMode.NONE]: '➡️', [LoopMode.TRACK]: '🔂', [LoopMode.QUEUE]: '🔁' };
  await message.channel.send(`${icons[newMode]} Loop: **${newMode}**`);
}

async function _cmdVolume(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player) { await message.channel.send('❌ No active player!'); return; }
  if (!args) { await message.channel.send(`🔊 Volume: **${player.volume}%**`); return; }
  const vol = parseInt(args, 10);
  if (isNaN(vol)) { await message.channel.send('❌ Volume must be 0–200!'); return; }
  await player.setVolume(vol);
  if (bot.guildSettings && message.guild) {
    await bot.guildSettings.saveVolume(message.guild.id, player.volume);
  }
  await message.channel.send(`🔊 Volume set to **${player.volume}%**`);
}

async function _cmdSeek(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || !player.current) { await message.channel.send('❌ Nothing is playing!'); return; }
  if (!args) { await message.channel.send('❌ Usage: `seek <seconds>` or `seek <MM:SS>`'); return; }
  let seconds;
  if (args.includes(':')) {
    const [m, s] = args.split(':', 2);
    seconds = parseInt(m, 10) * 60 + parseInt(s, 10);
  } else {
    seconds = parseInt(args, 10);
  }
  if (isNaN(seconds)) { await message.channel.send('❌ Invalid time — use seconds or `MM:SS`.'); return; }
  await player.seek(seconds * 1000);
  await message.channel.send(`⏩ Seeked to **${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}**`);
}

async function _cmdNowplaying(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || !player.current) { await message.channel.send('❌ Nothing is playing!'); return; }
  const track   = player.current;
  const elS     = Math.floor(player.position / 1000);
  const totS    = Math.floor(track.info.length / 1000);
  const progress = totS > 0 ? Math.floor((elS / totS) * 20) : 0;
  const bar     = '▓'.repeat(progress) + '░'.repeat(20 - progress);
  const lines   = [
    '**🎵 Now Playing**',
    `**${track.info.title}**`,
    `by *${track.info.author}*`,
    '',
    `\`[${bar}]\``,
    `\`${Math.floor(elS/60)}:${String(elS%60).padStart(2,'0')} / ${Math.floor(totS/60)}:${String(totS%60).padStart(2,'0')}\``,
    '',
    `🔊 Vol: \`${player.volume}%\`  🔁 Loop: \`${player.loopMode}\``,
  ];
  if (player.currentFilter) lines.push(`🎛️ Filter: \`${player.currentFilter}\``);
  if (track.requester)      lines.push(`👤 Requested by: ${track.requester}`);
  await message.channel.send(lines.join('\n'));
}

async function _cmdFilter(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || !player.current) { await message.channel.send('❌ Nothing is playing!'); return; }
  if (!args) {
    await message.channel.send(`❌ Usage: \`${bot.prefix}filter <name>\` — see \`${bot.prefix}filters\``);
    return;
  }
  const ok = await player.setFilter(args.toLowerCase().trim());
  if (ok) {
    await message.channel.send(`🎛️ Filter applied: **${args.toLowerCase().trim()}**`);
  } else {
    await message.channel.send(`❌ Unknown filter \`${args}\`! Use \`${bot.prefix}filters\` for the list.`);
  }
}

async function _cmdFilters(bot, message, args) {
  const names = listFilters();
  await message.channel.send(
    `🎛️ **Available filters (${names.length}):**\n` + names.map(n => `\`${n}\``).join('  '),
  );
}

async function _cmdClearfilter(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player) { await message.channel.send('❌ No active player!'); return; }
  await player.clearFilters();
  await message.channel.send('🎛️ Filters cleared!');
}

async function _cmdRemove(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || player.queue.isEmpty) { await message.channel.send('❌ Queue is empty!'); return; }
  const idx = parseInt(args?.trim(), 10) - 1;
  if (isNaN(idx)) { await message.channel.send('❌ Usage: `remove <position>`'); return; }
  const removed = player.queue.remove(idx);
  if (removed) {
    await message.channel.send(`🗑️ Removed **${removed.info.title}** from queue.`);
  } else {
    await message.channel.send('❌ Invalid queue position!');
  }
}

async function _cmdDisconnect(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (player) await player.stop();
  await bot.leaveVoice(message.guild.id);
  await message.channel.send('👋 Disconnected!');
}

async function _cmdMove(bot, message, args) {
  const player = bot.getPlayer(message.guild?.id);
  if (!player || player.queue.isEmpty) { await message.channel.send('❌ Queue is empty!'); return; }
  const parts = (args || '').split(/\s+/);
  const from  = parseInt(parts[0], 10) - 1;
  const to    = parseInt(parts[1], 10) - 1;
  if (isNaN(from) || isNaN(to)) { await message.channel.send('❌ Usage: `move <from> <to>`'); return; }
  if (player.queue.move(from, to)) {
    await message.channel.send(`↕️ Moved track from position **${from+1}** to **${to+1}**.`);
  } else {
    await message.channel.send('❌ Invalid positions!');
  }
}

async function _cmdSearch(bot, message, args) {
  if (!args) { await message.channel.send('❌ Usage: `search <query>`'); return; }
  const player = await _ensureVoice(bot, message);
  if (!player) return;
  const status = await message.channel.send(`🔍 Searching for \`${args}\`…`);
  const result = await player.node.loadTracks(`ytsearch:${args}`);
  if (result.isEmpty) { await status.edit({ content: '❌ No results found!' }); return; }
  const tracks = result.tracks.slice(0, 5);
  const lines  = ['🔍 **Search Results** — reply `play <number>` to queue:'];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    lines.push(`  \`${i+1}.\` **${t.info.title}** — *${t.info.author}* \`[${t.durationStr}]\``);
  }
  await status.edit({ content: lines.join('\n') });
}

// ── Sniper commands ────────────────────────────────────────────────────────────

async function _cmdSniper(bot, message, args) {
  if (!bot.sniper) {
    await message.channel.send(
      '❌ Sniper is not enabled — set `sniper:` to a config block in `config.yaml` '
      + '(or `config.json`) and restart. Use `sniper: false` to keep it disabled.',
    );
    return;
  }

  const parts = (args || '').split(/\s+/, 2);
  const sub   = (parts[0] || 'status').toLowerCase();
  const rest  = (args || '').slice(sub.length).trim();

  const subHandlers = {
    status:  _sniperStatus,
    add:     _sniperAdd,
    remove:  _sniperRemove,
    rm:      _sniperRemove,
    list:    _sniperList,
    pause:   _sniperPause,
    resume:  _sniperResume,
    history: _sniperHistory,
    hist:    _sniperHistory,
    clear:   _sniperClearHistory,
    guilds:  _sniperGuilds,
  };

  const handler = subHandlers[sub];
  if (!handler) {
    const cmds = Object.keys(subHandlers).filter(k => !k.startsWith('_')).map(k => `\`${k}\``).join('  ');
    await message.channel.send(`❌ Unknown sub-command.  Available: ${cmds}`);
    return;
  }
  await handler(bot, message, rest);
}

async function _sniperStatus(bot, message, args) {
  const s     = bot.sniper.status();
  const state = s.paused ? '⏸️ **PAUSED**' : '▶️ **ACTIVE**';
  const targetsStr = s.targets.size
    ? [...s.targets].sort().map(t => `\`${t}\``).join('  ')
    : '*watching everything (no filter)*';
  const lines = [
    `**🎯 Vanity Sniper — ${state}**`,
    '',
    `**Targets:**  ${targetsStr}`,
    `**Monitors:** \`${s.monitors}\`   **Claimers:** \`${s.claimers}\``,
    `**Claimed this session:** \`${s.claimed.length}\``,
  ];
  await message.channel.send(lines.join('\n'));
}

async function _sniperAdd(bot, message, args) {
  const code = args.toLowerCase().trim();
  if (!code) { await message.channel.send('❌ Usage: `sniper add <vanity_code>`'); return; }
  const added = bot.sniper.addTarget(code);
  if (bot._sniperData) await bot._sniperData.addTarget(code);
  if (added) {
    await message.channel.send(`✅ Added \`discord.gg/${code}\` to the watch list.`);
  } else {
    await message.channel.send(`ℹ️ \`discord.gg/${code}\` is already in the watch list.`);
  }
}

async function _sniperRemove(bot, message, args) {
  const code = args.toLowerCase().trim();
  if (!code) { await message.channel.send('❌ Usage: `sniper remove <vanity_code>`'); return; }
  const removed = bot.sniper.removeTarget(code);
  if (bot._sniperData) await bot._sniperData.removeTarget(code);
  if (removed) {
    await message.channel.send(`🗑️ Removed \`discord.gg/${code}\` from the watch list.`);
  } else {
    await message.channel.send(`ℹ️ \`discord.gg/${code}\` was not in the watch list.`);
  }
}

async function _sniperList(bot, message, args) {
  const targets = bot.sniper.targets;
  if (!targets.size) {
    await message.channel.send('📋 Watch list empty — sniping **all** vanities that drop.');
  } else {
    const lines = [`📋 **Watching ${targets.size} vanity code(s):**`];
    for (const t of [...targets].sort()) lines.push(`  • \`discord.gg/${t}\``);
    await message.channel.send(lines.join('\n'));
  }
}

async function _sniperPause(bot, message, args) {
  bot.sniper.pause();
  await message.channel.send('⏸️ Sniper **paused**.');
}

async function _sniperResume(bot, message, args) {
  bot.sniper.resume();
  await message.channel.send('▶️ Sniper **resumed**.');
}

async function _sniperHistory(bot, message, args) {
  let limit = 10;
  if (args && /^\d+$/.test(args.trim())) {
    limit = Math.min(parseInt(args.trim(), 10), 25);
  }
  let lines;
  if (bot._sniperData) {
    lines = bot._sniperData.historySummary(limit);
  } else {
    lines = bot.sniper.status().claimed.slice(0, limit).map(e => `  ${e}`);
  }
  if (!lines.length) {
    await message.channel.send('📜 No snipes recorded yet.');
  } else {
    await message.channel.send(`📜 **Last ${lines.length} snipe(s):**\n${lines.join('\n')}`);
  }
}

async function _sniperClearHistory(bot, message, args) {
  bot.sniper.clearHistory();
  if (bot._sniperData) await bot._sniperData.clearHistory();
  await message.channel.send('🗑️ Claim history cleared.');
}

async function _sniperGuilds(bot, message, args) {
  const guilds = bot.sniper.claimerGuilds;
  if (!guilds.length) { await message.channel.send('❌ No claimer guilds configured.'); return; }
  const lines = [`🏠 **Claimer guilds (${guilds.length}):**`];
  for (const gid of guilds) {
    const guild = bot.guilds?.cache?.get(gid);
    const name  = guild ? ` — *${guild.name}*` : '';
    lines.push(`  • \`${gid}\`${name}`);
  }
  await message.channel.send(lines.join('\n'));
}

// Export all handler functions
const handlers = {
  _cmdPlay, _cmdPause, _cmdResume, _cmdStop, _cmdSkip,
  _cmdQueue, _cmdClearQueue, _cmdShuffle, _cmdLoop, _cmdVolume,
  _cmdSeek, _cmdNowplaying, _cmdFilter, _cmdFilters, _cmdClearfilter,
  _cmdRemove, _cmdDisconnect, _cmdMove, _cmdSearch, _cmdSniper,
};
