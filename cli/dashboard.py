"""
Live CLI dashboard using Rich.
Displays all active selfbot accounts, their guilds, and playback state
in real-time — refreshed twice per second.

Also provides ConsoleCLI — an interactive terminal command interface that
lets you control the music bot directly from the console:
  join <guild> <channel>   — join a voice channel
  play <guild> <query>     — search and play a song
  pause / resume / skip / stop / dc / np / queue / vol  [guild]
  guilds / channels <guild>  — discover guilds and voice channels
  help  /  quit
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import sys
from datetime import datetime
from typing import TYPE_CHECKING, List, Optional, Tuple

import discord
from lavalink.models import LoadType

if TYPE_CHECKING:
    from core.bot import MusicBot

log = logging.getLogger(__name__)

try:
    from rich import box
    from rich.console import Console
    from rich.layout import Layout
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table

    _RICH = True
except ImportError:
    _RICH = False
    log.warning("'rich' is not installed — dashboard disabled (pip install rich)")


class Dashboard:
    """Async Rich live dashboard for all running MusicBot instances."""

    def __init__(self, bots: List["MusicBot"]) -> None:
        self.bots = bots
        self._running = False
        self._task: Optional[asyncio.Task] = None

    # ──────────────────────────────────────────────────────────────────────────

    def start(self) -> None:
        if not _RICH:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()

    # ──────────────────────────────────────────────────────────────────────────

    async def _run(self) -> None:
        console = Console()
        with Live(
            self._render(),
            console=console,
            refresh_per_second=2,
            screen=False,
        ) as live:
            while self._running:
                live.update(self._render())
                await asyncio.sleep(0.5)

    # ──────────────────────────────────────────────────────────────────────────

    def _render(self) -> "Layout":
        from rich.layout import Layout  # local to satisfy linters

        layout = Layout()
        layout.split_column(
            Layout(self._header(), size=3),
            Layout(self._body()),
            Layout(self._footer(), size=3),
        )
        return layout

    def _header(self) -> "Panel":
        now = datetime.now().strftime("%H:%M:%S")
        active = sum(1 for b in self.bots if b.user is not None)
        return Panel(
            f"[bold cyan]🎵  Music SelfBot — Dashboard[/bold cyan]"
            f"   [dim]{now}[/dim]"
            f"   [green]{active}[/green]/[white]{len(self.bots)}[/white] accounts online",
            box=box.HORIZONTALS,
        )

    def _body(self) -> "Panel":
        table = Table(box=box.SIMPLE, expand=True, show_header=True)
        table.add_column("Account",     style="cyan",    no_wrap=True, min_width=18)
        table.add_column("Guild",       style="white",   no_wrap=True, min_width=16)
        table.add_column("Now Playing", style="green",   min_width=28)
        table.add_column("Queue",       style="yellow",  justify="right", min_width=5)
        table.add_column("Vol",         style="blue",    justify="right", min_width=4)
        table.add_column("Loop",        style="magenta", min_width=6)
        table.add_column("Filter",      style="magenta", min_width=8)
        table.add_column("Node",        style="dim",     min_width=8)

        for bot in self.bots:
            username = str(bot.user) if bot.user else "[dim]connecting…[/dim]"

            if not bot.players:
                table.add_row(username, "—", "—", "—", "—", "—", "—", "—")
                continue

            for guild_id, player in bot.players.items():
                guild = bot.get_guild(guild_id)
                guild_name = guild.name if guild else str(guild_id)

                if player.current:
                    title = player.current.info.title
                    title = (title[:25] + "…") if len(title) > 26 else title
                else:
                    title = "[dim]—[/dim]"

                table.add_row(
                    username,
                    guild_name,
                    title,
                    str(player.queue.size),
                    f"{player.volume}%",
                    player.loop_mode.value,
                    player.current_filter or "—",
                    player.node.name,
                )

        return Panel(table, title="[bold]Active Players[/bold]", box=box.ROUNDED)

    def _footer(self) -> "Panel":
        cmds = (
            "!play  !pause  !resume  !skip  !stop  !queue  "
            "!loop  !volume  !seek  !filter  !filters  !np  !dc"
            "   |   console: type [bold]help[/bold]"
        )
        return Panel(f"[dim]{cmds}[/dim]", box=box.HORIZONTALS)


# ──────────────────────────────────────────────────────────────────────────────
# Interactive console CLI
# ──────────────────────────────────────────────────────────────────────────────

class ConsoleCLI:
    """
    Interactive terminal command interface.

    While the live dashboard is running you can type commands at the prompt
    to control any bot account directly from the console — no Discord message
    needed.

    Commands
    --------
    guilds                     list all guilds across all bot accounts
    channels <guild>           list voice channels in a guild
    join <guild> <channel>     join a voice channel
    play <guild> <query>       search & play a song (join first with 'join')
    pause   [guild]            pause playback
    resume  [guild]            resume / unpause
    skip    [guild]            skip current track
    stop    [guild]            stop & clear queue
    dc      [guild]            disconnect from voice
    np      [guild]            now-playing info
    queue   [guild]            show queue
    vol     <guild> [0-200]    get / set volume
    help                       show this help
    quit                       shut down all bots

    <guild> may be a guild name (or partial name) or numeric ID.
    If only one guild has an active player you can omit [guild].
    """

    _HELP = """\
[bold cyan]Console Commands[/bold cyan]
  [bold]guilds[/bold]                     list all guilds (across all bot accounts)
  [bold]channels[/bold] <guild>           list voice channels in a guild
  [bold]join[/bold] <guild> <channel>     join a voice channel
  [bold]play[/bold] <guild> <query>       search & play a song  (join VC first!)
  [bold]pause[/bold]   [guild]            pause playback
  [bold]resume[/bold]  [guild]            resume playback
  [bold]skip[/bold]    [guild]            skip current track
  [bold]stop[/bold]    [guild]            stop & clear queue
  [bold]dc[/bold]      [guild]            disconnect from voice
  [bold]np[/bold]      [guild]            now-playing info
  [bold]queue[/bold]   [guild]            show queue
  [bold]vol[/bold]     <guild> [0-200]    get / set volume
  [bold]help[/bold]                       show this help
  [bold]quit[/bold]                       shut down all bots

[dim]<guild> = name (partial ok) or numeric ID.
Omit [guild] when only one guild has an active player.[/dim]"""

    def __init__(self, bots: List["MusicBot"]) -> None:
        self.bots = bots
        self._running = False
        self._task: Optional[asyncio.Task] = None
        # Shared Rich console — set by Dashboard if available, else plain print
        self._console: Optional["Console"] = None

    def set_console(self, console: "Console") -> None:
        self._console = console

    def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._run(), name="console-cli")

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()

    # ──────────────────────────────────────────────────────────────────────────
    # Output helper
    # ──────────────────────────────────────────────────────────────────────────

    def _out(self, msg: str) -> None:
        if self._console and _RICH:
            self._console.print(msg)
        else:
            # Strip Rich markup for plain output
            plain = re.sub(r"\[/?[^\]]*\]", "", msg)
            print(plain)

    # ──────────────────────────────────────────────────────────────────────────
    # Input loop
    # ──────────────────────────────────────────────────────────────────────────

    async def _run(self) -> None:
        self._out(
            "[bold green]Console ready.[/bold green]  "
            "Type [bold]help[/bold] for commands, "
            "or use [bold]![/bold]commands in Discord."
        )
        while self._running:
            try:
                print(">>> ", end="", flush=True)
                line: str = await asyncio.to_thread(sys.stdin.readline)
                line = line.strip()
                if line:
                    await self._dispatch(line)
            except (asyncio.CancelledError, EOFError, KeyboardInterrupt):
                break
            except Exception as exc:
                self._out(f"[red]Console error:[/red] {exc}")

    # ──────────────────────────────────────────────────────────────────────────
    # Command dispatch
    # ──────────────────────────────────────────────────────────────────────────

    async def _dispatch(self, line: str) -> None:
        parts = line.split(None, 2)
        cmd  = parts[0].lower() if parts else ""
        arg1 = parts[1] if len(parts) > 1 else ""
        arg2 = parts[2] if len(parts) > 2 else ""

        if cmd in ("help", "h", "?"):
            self._out(self._HELP)
        elif cmd == "guilds":
            self._cmd_guilds()
        elif cmd == "channels":
            self._cmd_channels(arg1)
        elif cmd == "join":
            await self._cmd_join(arg1, arg2)
        elif cmd == "play":
            await self._cmd_play(arg1, arg2)
        elif cmd in ("pause",):
            await self._cmd_player_action("pause", arg1)
        elif cmd in ("resume", "r"):
            await self._cmd_player_action("resume", arg1)
        elif cmd in ("skip", "s"):
            await self._cmd_player_action("skip", arg1)
        elif cmd in ("stop",):
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
            self._out("[yellow]Shutting down…[/yellow]")
            self._running = False
            # Signal the process to shut down gracefully (same effect as Ctrl+C).
            # os.kill with SIGINT is the standard asyncio pattern for triggering
            # shutdown from inside a coroutine — it lets asyncio.run() cancel all
            # tasks and run finally blocks cleanly.
            os.kill(os.getpid(), signal.SIGINT)
        else:
            self._out(f"[red]Unknown command:[/red] {cmd!r}  (type [bold]help[/bold])")

    # ──────────────────────────────────────────────────────────────────────────
    # Guild / channel resolution helpers
    # ──────────────────────────────────────────────────────────────────────────

    def _find_guild(self, guild_ref: str) -> Tuple[Optional["MusicBot"], Optional[object]]:
        """Return (bot, guild) matching guild_ref (name, partial name, or ID)."""
        candidates = [
            (bot, g)
            for bot in self.bots
            if bot.user
            for g in bot.guilds
        ]
        # 1. Exact numeric ID
        for bot, g in candidates:
            if guild_ref == str(g.id):
                return bot, g
        # 2. Exact name (case-insensitive)
        for bot, g in candidates:
            if guild_ref.lower() == g.name.lower():
                return bot, g
        # 3. Partial name (case-insensitive)
        for bot, g in candidates:
            if guild_ref.lower() in g.name.lower():
                return bot, g
        return None, None

    def _single_active(self) -> Tuple[Optional["MusicBot"], Optional[object]]:
        """Return (bot, guild) when exactly one guild has an active player."""
        active = [
            (bot, bot.get_guild(gid))
            for bot in self.bots
            if bot.user
            for gid in bot.players
            if bot.get_guild(gid)
        ]
        if len(active) == 1:
            return active[0]
        return None, None

    def _resolve(self, guild_ref: str) -> Tuple[Optional["MusicBot"], Optional[object]]:
        """Resolve guild_ref, or fall back to the single active player's guild."""
        if guild_ref:
            bot, guild = self._find_guild(guild_ref)
            if guild is None:
                self._out(f"[red]Guild not found:[/red] {guild_ref!r}  (type [bold]guilds[/bold] to list)")
            return bot, guild
        bot, guild = self._single_active()
        if guild is None:
            self._out(
                "[red]No active guild.[/red]  Specify a guild name/ID, "
                "or use [bold]join[/bold] to enter a voice channel first."
            )
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

    # ──────────────────────────────────────────────────────────────────────────
    # Individual commands
    # ──────────────────────────────────────────────────────────────────────────

    def _cmd_guilds(self) -> None:
        found = False
        for bot in self.bots:
            if bot.user is None:
                continue
            for guild in bot.guilds:
                player = bot.get_player(guild.id)
                if player and player.current:
                    status = "[green]▶ playing[/green]"
                elif player and player.connected:
                    status = "[dim]🔇 in VC[/dim]"
                else:
                    status = ""
                self._out(
                    f"  [cyan]{guild.name}[/cyan] [dim]({guild.id})[/dim]"
                    + (f"  {status}" if status else "")
                    + f"  via [bold]{bot.user}[/bold]"
                )
                found = True
        if not found:
            self._out("[dim]No guilds yet — bot may still be connecting.[/dim]")

    def _cmd_channels(self, guild_ref: str) -> None:
        if not guild_ref:
            self._out("[red]Usage:[/red] channels <guild>")
            return
        bot, guild = self._find_guild(guild_ref)
        if guild is None:
            self._out(f"[red]Guild not found:[/red] {guild_ref!r}")
            return
        vcs = sorted(
            [c for c in guild.channels if isinstance(c, discord.VoiceChannel)],
            key=lambda c: c.position,
        )
        if not vcs:
            self._out(f"[dim]No voice channels in {guild.name}[/dim]")
            return
        self._out(f"[bold]Voice channels in [cyan]{guild.name}[/cyan]:[/bold]")
        for c in vcs:
            members = len(c.members)
            self._out(
                f"  [green]{c.name}[/green] [dim]({c.id})[/dim]"
                + (f"  [dim]{members} member(s)[/dim]" if members else "")
            )

    async def _cmd_join(self, guild_ref: str, channel_ref: str) -> None:
        if not guild_ref or not channel_ref:
            self._out("[red]Usage:[/red] join <guild> <channel>")
            return
        bot, guild = self._find_guild(guild_ref)
        if guild is None:
            return
        channel = self._find_voice_channel(guild, channel_ref)
        if channel is None:
            self._out(
                f"[red]Voice channel not found:[/red] {channel_ref!r}  "
                f"(use [bold]channels {guild.name}[/bold] to list)"
            )
            return
        self._out(f"[dim]Joining {channel.name} in {guild.name}…[/dim]")
        ok = await bot.join_voice(channel)
        if ok:
            self._out(
                f"[green]✓[/green] Joined [bold]{channel.name}[/bold] "
                f"in [cyan]{guild.name}[/cyan]"
            )
        else:
            self._out(f"[red]✗[/red] Failed to join {channel.name}")

    async def _cmd_play(self, guild_ref: str, query: str) -> None:
        if not guild_ref or not query:
            self._out("[red]Usage:[/red] play <guild> <song name or URL>")
            return
        bot, guild = self._find_guild(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if player is None or not player.connected:
            self._out(
                "[red]✗[/red] Bot is not in a voice channel.  "
                "Use [bold]join <guild> <channel>[/bold] first."
            )
            return

        identifier = query if query.startswith(("http://", "https://")) else f"ytsearch:{query}"
        self._out(f"🔍 Searching for [italic]{query}[/italic]…")

        try:
            result = await player.node.load_tracks(identifier)
        except Exception as exc:
            self._out(f"[red]Load error:[/red] {exc}")
            return

        if result.is_empty or result.load_type == LoadType.ERROR:
            self._out("[red]✗ No results found.[/red]")
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
                        await bot.update_voice_status(player.voice_channel_id, f"🎵 {first.info.title}")
                    self._out(f"[green]▶[/green] Now playing: [bold]{first.info.title}[/bold]")
            self._out(f"[green]📋[/green] Queued [bold]{count}[/bold] tracks from [bold]{name}[/bold]")
            return

        track = result.tracks[0]
        track.requester = "console"
        if not player.current:
            await player.play(track)
            if player.voice_channel_id:
                await bot.update_voice_status(player.voice_channel_id, f"🎵 {track.info.title}")
            self._out(
                f"[green]▶[/green] Now playing: [bold]{track.info.title}[/bold]"
                f" — {track.info.author}  [{track.duration_str}]"
            )
        else:
            player.queue.add(track)
            self._out(
                f"[green]➕[/green] Added [bold]{track.info.title}[/bold]"
                f" to queue (position #{player.queue.size})"
            )

    async def _cmd_player_action(self, action: str, guild_ref: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if player is None:
            self._out("[red]✗[/red] No active player in that guild.")
            return

        if action == "pause":
            if not player.current:
                self._out("[red]✗[/red] Nothing is playing.")
                return
            await player.pause()
            self._out("⏸  Paused")

        elif action == "resume":
            await player.resume()
            self._out("▶  Resumed")

        elif action == "skip":
            if not player.current:
                self._out("[red]✗[/red] Nothing is playing.")
                return
            next_track = await player.skip()
            if next_track:
                if player.voice_channel_id:
                    await bot.update_voice_status(player.voice_channel_id, f"🎵 {next_track.info.title}")
                self._out(f"⏭  Skipped! Now playing: [bold]{next_track.info.title}[/bold]")
            else:
                self._out("⏭  Skipped. Queue is now empty.")

        elif action == "stop":
            await player.stop()
            self._out("⏹  Stopped and cleared queue")

        elif action == "dc":
            await player.stop()
            await bot.leave_voice(guild.id)
            self._out(f"👋 Disconnected from voice in [cyan]{guild.name}[/cyan]")

    def _cmd_np(self, guild_ref: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if not player or not player.current:
            self._out("[dim]Nothing is playing.[/dim]")
            return
        t = player.current
        elapsed_s = player.position // 1000
        total_s   = t.info.length // 1000
        progress  = int((elapsed_s / max(total_s, 1)) * 20)
        bar = "▓" * progress + "░" * (20 - progress)
        self._out(
            f"[green]▶[/green] [bold]{t.info.title}[/bold]\n"
            f"  by {t.info.author}\n"
            f"  [{bar}]  {elapsed_s // 60}:{elapsed_s % 60:02d} / "
            f"{total_s // 60}:{total_s % 60:02d}\n"
            f"  🔊 {player.volume}%  🔁 {player.loop_mode.value}"
            + (f"  🎛 {player.current_filter}" if player.current_filter else "")
        )

    def _cmd_queue(self, guild_ref: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if not player:
            self._out("[dim]No active player.[/dim]")
            return
        lines = []
        if player.current:
            t = player.current
            lines.append(
                f"[green]▶ Now:[/green] [bold]{t.info.title}[/bold] — {t.info.author}"
            )
        tracks = player.queue.tracks
        if not tracks:
            lines.append("[dim]Queue is empty.[/dim]")
        else:
            lines.append(f"[yellow]Queue — {len(tracks)} track(s):[/yellow]")
            for i, t in enumerate(tracks[:15], 1):
                lines.append(f"  {i:2}. {t.info.title}")
            if len(tracks) > 15:
                lines.append(f"  … and {len(tracks) - 15} more")
        self._out("\n".join(lines))

    async def _cmd_volume(self, guild_ref: str, vol_str: str) -> None:
        bot, guild = self._resolve(guild_ref)
        if guild is None:
            return
        player = bot.get_player(guild.id)
        if not player:
            self._out("[dim]No active player.[/dim]")
            return
        if not vol_str:
            self._out(f"🔊 Volume: [bold]{player.volume}%[/bold]")
            return
        try:
            vol = int(vol_str)
        except ValueError:
            self._out("[red]Usage:[/red] vol <guild> [0-200]")
            return
        await player.set_volume(vol)
        if bot.guild_settings:
            await bot.guild_settings.save_volume(guild.id, player.volume)
        self._out(f"🔊 Volume → [bold]{player.volume}%[/bold]")
