"""
Simple interactive console for controlling the music bot from the terminal.

Usage — just type commands at the  >>>  prompt:

  guilds                     list all guilds
  channels <guild>           list voice channels in a guild
  join <guild> <channel>     join a voice channel
  play <guild> <query>       search and play a song (join a VC first!)
  pause   [guild]            pause playback
  resume  [guild]            resume playback
  skip    [guild]            skip current track
  stop    [guild]            stop and clear queue
  dc      [guild]            disconnect from voice
  np      [guild]            now-playing info
  queue   [guild]            show queue
  vol     <guild> [0-200]    get / set volume
  help                       show this help
  quit                       shut down all bots

<guild> may be a name (partial ok) or numeric ID.
[guild] is optional when only one guild has an active player.
"""
from __future__ import annotations

import asyncio
import logging
import re
import sys
from typing import TYPE_CHECKING, List, Optional, Tuple

import discord
from lavalink.models import LoadType

if TYPE_CHECKING:
    from core.bot import MusicBot

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Compatibility stub — Dashboard is no longer used but kept importable so
# any code that does  "from cli.dashboard import Dashboard"  still works.
# ---------------------------------------------------------------------------

class Dashboard:
    """Removed — kept only for import compatibility; does nothing."""

    def __init__(self, bots) -> None:
        pass

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass


# ---------------------------------------------------------------------------
# ConsoleCLI
# ---------------------------------------------------------------------------

class ConsoleCLI:
    """
    Plain-text interactive console.

    Prints a  >>>  prompt, reads commands from stdin without blocking the
    asyncio event loop (uses asyncio.to_thread), and calls the matching
    handler.  No external packages required — all output is plain print().
    """

    _HELP = """\
Console commands
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
[guild] = optional when only one guild has an active player"""

    def __init__(self, bots: List["MusicBot"]) -> None:
        self.bots = bots
        self._running = False
        self._task: Optional[asyncio.Task] = None

    # -- Lifecycle ------------------------------------------------------------

    def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._run(), name="console-cli")

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()

    # -- Output ---------------------------------------------------------------

    @staticmethod
    def _print(msg: str) -> None:
        """Print msg after stripping any Rich markup tags."""
        print(re.sub(r"\[/?[^\]]*\]", "", msg))

    # -- Input loop -----------------------------------------------------------

    async def _run(self) -> None:
        print("Console ready. Type 'help' for a list of commands.")
        while self._running:
            try:
                print(">>> ", end="", flush=True)
                # readline runs in a thread so the event loop stays free.
                # If stop() cancels this task while the thread is blocked on
                # input, the thread finishes on the next Enter press, but by
                # then _running is False so the loop exits cleanly.
                line: str = await asyncio.to_thread(sys.stdin.readline)
                if not self._running:   # stop() was called while we were reading
                    break
                line = line.strip()
                if line:
                    await self._dispatch(line)
            except (asyncio.CancelledError, EOFError, KeyboardInterrupt):
                break
            except Exception as exc:
                print(f"Console error: {exc}")

    # -- Dispatch -------------------------------------------------------------

    async def _dispatch(self, line: str) -> None:
        parts = line.split(None, 2)
        cmd  = parts[0].lower() if parts else ""
        arg1 = parts[1] if len(parts) > 1 else ""
        arg2 = parts[2] if len(parts) > 2 else ""

        if cmd in ("help", "h", "?"):
            print(self._HELP)
        elif cmd == "guilds":
            self._cmd_guilds()
        elif cmd == "channels":
            self._cmd_channels(arg1)
        elif cmd == "join":
            await self._cmd_join(arg1, arg2)
        elif cmd == "play":
            await self._cmd_play(arg1, arg2)
        elif cmd == "pause":
            await self._cmd_player_action("pause", arg1)
        elif cmd in ("resume", "r"):
            await self._cmd_player_action("resume", arg1)
        elif cmd in ("skip", "s"):
            await self._cmd_player_action("skip", arg1)
        elif cmd == "stop":
            await self._cmd_player_action("stop", arg1)
        elif cmd in ("dc", "disconnect"):
            await self._cmd_player_action("dc", arg1)
        elif cmd in ("np", "nowplaying"):
            self._cmd_np(arg1)
        elif cmd in ("queue", "q"):
            self._cmd_queue(arg1)
        elif cmd in ("vol", "volume"):
            await self._cmd_volume(arg1, arg2)
        elif cmd in ("quit", "exit"):
            print("Shutting down...")
            self._running = False
            # Stop the running event loop — same clean shutdown path as Ctrl+C.
            # loop.stop() is safe to call from a coroutine and lets asyncio.run()
            # cancel all tasks and execute finally blocks before exiting.
            asyncio.get_event_loop().stop()
        else:
            print(f"Unknown command: {cmd!r}  (type \'help\')")

    # -- Guild / channel helpers ----------------------------------------------

    def _find_guild(
        self, guild_ref: str
    ) -> Tuple[Optional["MusicBot"], Optional[object]]:
        """Return (bot, guild) for the first match of guild_ref."""
        candidates = [
            (bot, g)
            for bot in self.bots
            if bot.user
            for g in bot.guilds
        ]
        for bot, g in candidates:           # exact numeric ID
            if guild_ref == str(g.id):
                return bot, g
        for bot, g in candidates:           # exact name (case-insensitive)
            if guild_ref.lower() == g.name.lower():
                return bot, g
        for bot, g in candidates:           # partial name
            if guild_ref.lower() in g.name.lower():
                return bot, g
        return None, None

    def _single_active(
        self,
    ) -> Tuple[Optional["MusicBot"], Optional[object]]:
        """Return (bot, guild) when exactly one guild has an active player."""
        active = [
            (bot, bot.get_guild(gid))
            for bot in self.bots
            if bot.user
            for gid in bot.players
            if bot.get_guild(gid)
        ]
        return active[0] if len(active) == 1 else (None, None)

    def _resolve(
        self, guild_ref: str
    ) -> Tuple[Optional["MusicBot"], Optional[object]]:
        """Resolve guild_ref, or fall back to the single active guild."""
        if guild_ref:
            bot, guild = self._find_guild(guild_ref)
            if guild is None:
                print(f"Guild not found: {guild_ref!r}  (type \'guilds\' to list)")
            return bot, guild
        bot, guild = self._single_active()
        if guild is None:
            print("No active guild. Specify a guild name/ID, or use \'join\' first.")
        return bot, guild

    @staticmethod
    def _find_voice_channel(guild, channel_ref: str):
        """Return a VoiceChannel matching channel_ref (name, partial, or ID)."""
        vcs = [c for c in guild.channels if isinstance(c, discord.VoiceChannel)]
        for c in vcs:
            if channel_ref == str(c.id):
                return c
        for c in vcs:
            if channel_ref.lower() == c.name.lower():
                return c
        for c in vcs:
            if channel_ref.lower() in c.name.lower():
                return c
        return None

    # -- Individual commands --------------------------------------------------

    def _cmd_guilds(self) -> None:
        found = False
        for bot in self.bots:
            if bot.user is None:
                continue
            for guild in bot.guilds:
                player = bot.get_player(guild.id)
                if player and player.current:
                    status = "  [playing]"
                elif player and player.connected:
                    status = "  [in VC, idle]"
                else:
                    status = ""
                print(f"  {guild.name} ({guild.id}){status}  via {bot.user}")
                found = True
        if not found:
            print("No guilds yet -- bot may still be connecting.")

    def _cmd_channels(self, guild_ref: str) -> None:
        if not guild_ref:
            print("Usage: channels <guild>")
            return
        bot, guild = self._find_guild(guild_ref)
        if guild is None:
            print(f"Guild not found: {guild_ref!r}")
            return
        vcs = sorted(
            [c for c in guild.channels if isinstance(c, discord.VoiceChannel)],
            key=lambda c: c.position,
        )
        if not vcs:
            print(f"No voice channels in {guild.name}")
            return
        print(f"Voice channels in {guild.name}:")
        for c in vcs:
            members = len(c.members)
            member_str = f"  ({members} member(s))" if members else ""
            print(f"  {c.name} ({c.id}){member_str}")

    async def _cmd_join(self, guild_ref: str, channel_ref: str) -> None:
        if not guild_ref or not channel_ref:
            print("Usage: join <guild> <channel>")
            return
        bot, guild = self._find_guild(guild_ref)
        if guild is None:
            return
        channel = self._find_voice_channel(guild, channel_ref)
        if channel is None:
            print(
                f"Voice channel not found: {channel_ref!r}"
                f" (use 'channels {guild.name}' to list)"
            )
            return
        print(f"Joining {channel.name} in {guild.name}...")
        ok = await bot.join_voice(channel)
        if ok:
            print(f"Joined {channel.name} in {guild.name}")
        else:
            print(f"Failed to join {channel.name}")

    async def _cmd_play(self, guild_ref: str, query: str) -> None:
        if not guild_ref or not query:
            print("Usage: play <guild> <song name or URL>")
            return
        bot, guild = self._find_guild(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if player is None or not player.connected:
            print("Bot is not in a voice channel. Use \'join <guild> <channel>\' first.")
            return

        identifier = (
            query if query.startswith(("http://", "https://")) else f"ytsearch:{query}"
        )
        print(f"Searching for \'{query}\'...")

        try:
            result = await player.node.load_tracks(identifier)
        except Exception as exc:
            print(f"Load error: {exc}")
            return

        if result.is_empty or result.load_type == LoadType.ERROR:
            print("No results found.")
            return

        if result.load_type == LoadType.PLAYLIST:
            count = player.queue.add_many(result.tracks)
            name = result.playlist_info.name if result.playlist_info else "Playlist"
            if not player.current:
                first = player.queue.get_next()
                if first:
                    first.requester = "console"
                    await player.play(first)
                    if player.voice_channel_id:
                        await bot.update_voice_status(
                            player.voice_channel_id, f"Playing: {first.info.title}"
                        )
                    print(f"Now playing: {first.info.title}")
            print(f"Queued {count} tracks from \'{name}\'")
            return

        track = result.tracks[0]
        track.requester = "console"
        if not player.current:
            await player.play(track)
            if player.voice_channel_id:
                await bot.update_voice_status(
                    player.voice_channel_id, f"Playing: {track.info.title}"
                )
            print(
                f"Now playing: {track.info.title}"
                f" -- {track.info.author}  [{track.duration_str}]"
            )
        else:
            player.queue.add(track)
            print(f"Added to queue (#{player.queue.size}): {track.info.title}")

    async def _cmd_player_action(self, action: str, guild_ref: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if player is None:
            print("No active player in that guild.")
            return

        if action == "pause":
            if not player.current:
                print("Nothing is playing.")
                return
            await player.pause()
            print("Paused")

        elif action == "resume":
            await player.resume()
            print("Resumed")

        elif action == "skip":
            if not player.current:
                print("Nothing is playing.")
                return
            next_track = await player.skip()
            if next_track:
                if player.voice_channel_id:
                    await bot.update_voice_status(
                        player.voice_channel_id, f"Playing: {next_track.info.title}"
                    )
                print(f"Skipped. Now playing: {next_track.info.title}")
            else:
                print("Skipped. Queue is now empty.")

        elif action == "stop":
            await player.stop()
            print("Stopped and cleared queue")

        elif action == "dc":
            await player.stop()
            await bot.leave_voice(guild.id)
            print(f"Disconnected from voice in {guild.name}")

    def _cmd_np(self, guild_ref: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if not player or not player.current:
            print("Nothing is playing.")
            return
        t = player.current
        elapsed_s = player.position // 1000
        total_s   = t.info.length // 1000
        progress  = int((elapsed_s / max(total_s, 1)) * 20)
        bar = "#" * progress + "-" * (20 - progress)
        print(f"Now playing: {t.info.title}")
        print(f"  by {t.info.author}")
        print(
            f"  [{bar}]  "
            f"{elapsed_s // 60}:{elapsed_s % 60:02d} / "
            f"{total_s // 60}:{total_s % 60:02d}"
        )
        print(f"  Volume: {player.volume}%  Loop: {player.loop_mode.value}")
        if player.current_filter:
            print(f"  Filter: {player.current_filter}")

    def _cmd_queue(self, guild_ref: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if not player:
            print("No active player.")
            return
        if player.current:
            t = player.current
            print(f"Now playing: {t.info.title} -- {t.info.author}")
        tracks = player.queue.tracks
        if not tracks:
            print("Queue is empty.")
        else:
            print(f"Queue ({len(tracks)} track(s)):")
            for i, t in enumerate(tracks[:15], 1):
                print(f"  {i:2}. {t.info.title}")
            if len(tracks) > 15:
                print(f"  ... and {len(tracks) - 15} more")

    async def _cmd_volume(self, guild_ref: str, vol_str: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if not player:
            print("No active player.")
            return
        if not vol_str:
            print(f"Volume: {player.volume}%")
            return
        try:
            vol = int(vol_str)
        except ValueError:
            print("Usage: vol <guild> [0-200]")
            return
        await player.set_volume(vol)
        if bot.guild_settings:
            await bot.guild_settings.save_volume(guild.id, player.volume)
        print(f"Volume set to {player.volume}%")
