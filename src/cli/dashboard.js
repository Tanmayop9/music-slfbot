/**
 * Simple interactive console for controlling the music bot from the terminal.
 *
 * Usage — just type commands at the  >>>  prompt:
 *
 *   guilds                     list all guilds
 *   channels <guild>           list voice channels in a guild
 *   join <guild> <channel>     join a voice channel
 *   play <guild> <query>       search and play a song (join a VC first!)
 *   pause   [guild]            pause playback
 *   resume  [guild]            resume playback
 *   skip    [guild]            skip current track
 *   stop    [guild]            stop and clear queue
 *   dc      [guild]            disconnect from voice
 *   np      [guild]            now-playing info
 *   queue   [guild]            show queue
 *   vol     <guild> [0-200]    get / set volume
 *   help                       show this help
 *   quit                       shut down all bots
 *
 * <guild> may be a name (partial ok) or numeric ID.
 * [guild] is optional when only one guild has an active player.
 */

import readline from 'node:readline';
import { LoadType, Track, TrackInfo } from '../lavalink/models.js';
import { createLogger } from '../logger.js';
import { DirectPlayer } from '../ytdl/directPlayer.js';
import { resolveWithYtdl } from '../ytdl/fallback.js';

const log = createLogger('ConsoleCLI');

const HELP = `Console commands
  guilds                     list all guilds
  channels <guild>           list voice channels in a guild
  join     <guild> <channel> join a voice channel
  play     <guild> <query>   search and play a song (join a VC first!)
  pause    [guild]           pause playback
  resume   [guild]           resume playback
  skip     [guild]           skip current track
  stop     [guild]           stop and clear queue
  dc       [guild]           disconnect from voice
  np       [guild]           now-playing info
  queue    [guild]           show queue
  vol      <guild> [0-200]   get / set volume
  help                       show this help
  quit                       shut down all bots

<guild> = name (partial ok) or numeric ID
[guild] = optional when only one guild has an active player`;

export class ConsoleCLI {
  /** @param {import('../core/bot.js').MusicBot[]} bots */
  constructor(bots) {
    this.bots     = bots;
    this._running = false;
    this._rl      = null;
  }

  start() {
    this._running = true;
    this._rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
      prompt: '>>> ',
    });

    console.log("Console ready. Type 'help' for a list of commands.");

    this._rl.prompt();
    this._rl.on('line', async (line) => {
      if (!this._running) return;
      const trimmed = line.trim();
      if (trimmed) {
        try {
          await this._dispatch(trimmed);
        } catch (err) {
          console.log(`Console error: ${err.message}`);
        }
      }
      if (this._running) this._rl.prompt();
    });

    this._rl.on('close', () => {
      this._running = false;
    });
  }

  stop() {
    this._running = false;
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  async _dispatch(line) {
    const parts = line.split(/\s+/);
    const cmd   = parts[0].toLowerCase();
    const arg1  = parts[1] || '';
    const arg2  = parts.slice(2).join(' ');

    if (cmd === 'help' || cmd === 'h' || cmd === '?') {
      console.log(HELP);
    } else if (cmd === 'guilds') {
      this._cmdGuilds();
    } else if (cmd === 'channels') {
      this._cmdChannels(arg1);
    } else if (cmd === 'join') {
      await this._cmdJoin(arg1, arg2);
    } else if (cmd === 'play') {
      await this._cmdPlay(arg1, arg2);
    } else if (cmd === 'pause') {
      await this._cmdPlayerAction('pause', arg1);
    } else if (cmd === 'resume' || cmd === 'r') {
      await this._cmdPlayerAction('resume', arg1);
    } else if (cmd === 'skip' || cmd === 's') {
      await this._cmdPlayerAction('skip', arg1);
    } else if (cmd === 'stop') {
      await this._cmdPlayerAction('stop', arg1);
    } else if (cmd === 'dc' || cmd === 'disconnect') {
      await this._cmdPlayerAction('dc', arg1);
    } else if (cmd === 'np' || cmd === 'nowplaying') {
      this._cmdNp(arg1);
    } else if (cmd === 'queue' || cmd === 'q') {
      this._cmdQueue(arg1);
    } else if (cmd === 'vol' || cmd === 'volume') {
      await this._cmdVolume(arg1, arg2);
    } else if (cmd === 'quit' || cmd === 'exit') {
      console.log('Shutting down...');
      this._running = false;
      process.emit('SIGINT');
    } else {
      console.log(`Unknown command: '${cmd}'  (type 'help')`);
    }
  }

  // ── Guild / channel helpers ─────────────────────────────────────────────────

  _findGuild(guildRef) {
    const candidates = this.bots
      .filter(b => b.user)
      .flatMap(b => b.guilds.cache.map(g => ({ bot: b, guild: g })));

    for (const { bot, guild } of candidates) {
      if (guildRef === String(guild.id)) return { bot, guild };
    }
    for (const { bot, guild } of candidates) {
      if (guildRef.toLowerCase() === guild.name.toLowerCase()) return { bot, guild };
    }
    for (const { bot, guild } of candidates) {
      if (guild.name.toLowerCase().includes(guildRef.toLowerCase())) return { bot, guild };
    }
    return { bot: null, guild: null };
  }

  _singleActive() {
    const active = this.bots
      .filter(b => b.user)
      .flatMap(b => [...b.players.keys()].map(gid => ({ bot: b, guild: b.guilds.cache.get(gid) })))
      .filter(({ guild }) => guild);
    return active.length === 1 ? active[0] : { bot: null, guild: null };
  }

  _resolve(guildRef) {
    if (guildRef) {
      const found = this._findGuild(guildRef);
      if (!found.guild) console.log(`Guild not found: '${guildRef}'  (type 'guilds' to list)`);
      return found;
    }
    const found = this._singleActive();
    if (!found.guild) console.log("No active guild. Specify a guild name/ID, or use 'join' first.");
    return found;
  }

  _findVoiceChannel(guild, channelRef) {
    const vcs = guild.channels.cache.filter(c => c.type === 'GUILD_VOICE');
    for (const [, c] of vcs) {
      if (channelRef === String(c.id)) return c;
    }
    for (const [, c] of vcs) {
      if (channelRef.toLowerCase() === c.name.toLowerCase()) return c;
    }
    for (const [, c] of vcs) {
      if (c.name.toLowerCase().includes(channelRef.toLowerCase())) return c;
    }
    return null;
  }

  // ── Individual commands ─────────────────────────────────────────────────────

  _cmdGuilds() {
    let found = false;
    for (const bot of this.bots) {
      if (!bot.user) continue;
      for (const [, guild] of bot.guilds.cache) {
        const player = bot.getPlayer(guild.id);
        let status   = '';
        if (player?.current)   status = '  [playing]';
        else if (player?.connected) status = '  [in VC, idle]';
        console.log(`  ${guild.name} (${guild.id})${status}  via ${bot.user.tag}`);
        found = true;
      }
    }
    if (!found) console.log('No guilds yet -- bot may still be connecting.');
  }

  _cmdChannels(guildRef) {
    if (!guildRef) { console.log('Usage: channels <guild>'); return; }
    const { guild } = this._findGuild(guildRef);
    if (!guild) { console.log(`Guild not found: '${guildRef}'`); return; }
    const vcs = [...guild.channels.cache.values()]
      .filter(c => c.type === 'GUILD_VOICE')
      .sort((a, b) => a.rawPosition - b.rawPosition);
    if (!vcs.length) { console.log(`No voice channels in ${guild.name}`); return; }
    console.log(`Voice channels in ${guild.name}:`);
    for (const c of vcs) {
      const memberCount = c.members?.size ?? 0;
      const mStr = memberCount ? `  (${memberCount} member(s))` : '';
      console.log(`  ${c.name} (${c.id})${mStr}`);
    }
  }

  async _cmdJoin(guildRef, channelRef) {
    if (!guildRef || !channelRef) { console.log('Usage: join <guild> <channel>'); return; }
    const { bot, guild } = this._findGuild(guildRef);
    if (!guild) return;
    const channel = this._findVoiceChannel(guild, channelRef);
    if (!channel) {
      console.log(`Voice channel not found: '${channelRef}' (use 'channels ${guild.name}' to list)`);
      return;
    }
    console.log(`Joining ${channel.name} in ${guild.name}...`);
    const ok = await bot.joinVoice(channel);
    console.log(ok ? `Joined ${channel.name} in ${guild.name}` : `Failed to join ${channel.name}`);
  }

  async _cmdPlay(guildRef, query) {
    if (!guildRef || !query) { console.log('Usage: play <guild> <song name or URL>'); return; }
    const { bot, guild } = this._findGuild(guildRef);
    if (!guild) return;
    let player = bot.getPlayer(guild.id);
    if (!player?.connected) {
      console.log("Bot is not in a voice channel. Use 'join <guild> <channel>' first.");
      return;
    }

    console.log(`Searching for '${query}'...`);

    // ── Priority 1: DirectPlayer path (ytdl-core / yt-dlp) ───────────────────
    // When joinVoice() was used (e.g. via the 'join' CLI command), the player is
    // a DirectPlayer with no Lavalink node — use the ytdl fallback resolver.
    if (player instanceof DirectPlayer) {
      let ytdl = null;
      try {
        ytdl = await resolveWithYtdl(query, bot.ytdlConfig ?? {});
      } catch (err) {
        log.warn(`ytdl resolve failed: ${err.message}`);
      }
      if (ytdl) {
        const info = new TrackInfo({
          title:      ytdl.title,
          author:     ytdl.author,
          length:     ytdl.durationMs,
          uri:        ytdl.watchUrl || ytdl.url,
          identifier: ytdl.watchUrl || ytdl.url,
          sourceName: 'ytdl',
          isSeekable: false,
          isStream:   false,
        });
        const track = new Track({ encoded: '', info, requester: 'console' });
        if (!player.current) {
          await player.play(track);
          if (player.voiceChannelId) {
            await bot.updateVoiceStatus(player.voiceChannelId, `Playing: ${track.info.title}`);
          }
          console.log(`Now playing: ${track.info.title} -- ${track.info.author}  [${track.durationStr}]`);
        } else {
          player.queue.add(track);
          console.log(`Added to queue (#${player.queue.size}): ${track.info.title}`);
        }
        return;
      }

      // ytdl-core / yt-dlp could not resolve — try switching the session to Lavalink.
      const voiceChannel = guild.channels.cache.get(player.voiceChannelId);
      if (voiceChannel) {
        const lavaPlayer = await bot.switchToLavalink(guild.id, voiceChannel);
        if (lavaPlayer) player = lavaPlayer;
      }
    }

    // ── Priority 2: Lavalink path ─────────────────────────────────────────────
    if (!player.node) {
      console.log('No results found and no Lavalink node is available.');
      return;
    }

    const identifier = (query.startsWith('http://') || query.startsWith('https://'))
      ? query : `ytsearch:${query}`;

    let result;
    try {
      result = await player.node.loadTracks(identifier);
    } catch (err) {
      console.log(`Load error: ${err.message}`);
      return;
    }

    if (result.isEmpty || result.loadType === LoadType.ERROR) {
      console.log('No results found.');
      return;
    }

    if (result.loadType === LoadType.PLAYLIST) {
      const count = player.queue.addMany(result.tracks);
      const name  = result.playlistInfo?.name || 'Playlist';
      if (!player.current) {
        const first = player.queue.getNext();
        if (first) {
          first.requester = 'console';
          await player.play(first);
          if (player.voiceChannelId) {
            await bot.updateVoiceStatus(player.voiceChannelId, `Playing: ${first.info.title}`);
          }
          console.log(`Now playing: ${first.info.title}`);
        }
      }
      console.log(`Queued ${count} tracks from '${name}'`);
      return;
    }

    const track      = result.tracks[0];
    track.requester  = 'console';
    if (!player.current) {
      await player.play(track);
      if (player.voiceChannelId) {
        await bot.updateVoiceStatus(player.voiceChannelId, `Playing: ${track.info.title}`);
      }
      console.log(`Now playing: ${track.info.title} -- ${track.info.author}  [${track.durationStr}]`);
    } else {
      player.queue.add(track);
      console.log(`Added to queue (#${player.queue.size}): ${track.info.title}`);
    }
  }

  async _cmdPlayerAction(action, guildRef) {
    const { bot, guild } = this._resolve(guildRef);
    if (!guild) return;
    const player = bot.getPlayer(guild.id);
    if (!player) { console.log('No active player in that guild.'); return; }

    if (action === 'pause') {
      if (!player.current) { console.log('Nothing is playing.'); return; }
      await player.pause();
      console.log('Paused');
    } else if (action === 'resume') {
      await player.resume();
      console.log('Resumed');
    } else if (action === 'skip') {
      if (!player.current) { console.log('Nothing is playing.'); return; }
      const next = await player.skip();
      if (next) {
        if (player.voiceChannelId) await bot.updateVoiceStatus(player.voiceChannelId, `Playing: ${next.info.title}`);
        console.log(`Skipped. Now playing: ${next.info.title}`);
      } else {
        console.log('Skipped. Queue is now empty.');
      }
    } else if (action === 'stop') {
      await player.stop();
      console.log('Stopped and cleared queue');
    } else if (action === 'dc') {
      await player.stop();
      await bot.leaveVoice(guild.id);
      console.log(`Disconnected from voice in ${guild.name}`);
    }
  }

  _cmdNp(guildRef) {
    const { bot, guild } = this._resolve(guildRef);
    if (!guild) return;
    const player = bot.getPlayer(guild.id);
    if (!player?.current) { console.log('Nothing is playing.'); return; }
    const t        = player.current;
    const elS      = Math.floor(player.position / 1000);
    const totalS   = Math.floor(t.info.length / 1000);
    const progress = Math.floor((elS / Math.max(totalS, 1)) * 20);
    const bar      = '#'.repeat(progress) + '-'.repeat(20 - progress);
    console.log(`Now playing: ${t.info.title}`);
    console.log(`  by ${t.info.author}`);
    console.log(`  [${bar}]  ${Math.floor(elS/60)}:${String(elS%60).padStart(2,'0')} / ${Math.floor(totalS/60)}:${String(totalS%60).padStart(2,'0')}`);
    console.log(`  Volume: ${player.volume}%  Loop: ${player.loopMode}`);
    if (player.currentFilter) console.log(`  Filter: ${player.currentFilter}`);
  }

  _cmdQueue(guildRef) {
    const { bot, guild } = this._resolve(guildRef);
    if (!guild) return;
    const player = bot.getPlayer(guild.id);
    if (!player) { console.log('No active player.'); return; }
    if (player.current) {
      console.log(`Now playing: ${player.current.info.title} -- ${player.current.info.author}`);
    }
    const tracks = player.queue.tracks;
    if (!tracks.length) {
      console.log('Queue is empty.');
    } else {
      console.log(`Queue (${tracks.length} track(s)):`);
      for (let i = 0; i < Math.min(15, tracks.length); i++) {
        console.log(`  ${String(i + 1).padStart(2)}. ${tracks[i].info.title}`);
      }
      if (tracks.length > 15) console.log(`  ... and ${tracks.length - 15} more`);
    }
  }

  async _cmdVolume(guildRef, volStr) {
    const { bot, guild } = this._resolve(guildRef);
    if (!guild) return;
    const player = bot.getPlayer(guild.id);
    if (!player) { console.log('No active player.'); return; }
    if (!volStr) { console.log(`Volume: ${player.volume}%`); return; }
    const vol = parseInt(volStr, 10);
    if (isNaN(vol)) { console.log('Usage: vol <guild> [0-200]'); return; }
    await player.setVolume(vol);
    if (bot.guildSettings) await bot.guildSettings.saveVolume(guild.id, player.volume);
    console.log(`Volume set to ${player.volume}%`);
  }
}
