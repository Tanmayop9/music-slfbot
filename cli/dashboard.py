"""
Live CLI dashboard using Rich.
Displays all active selfbot accounts, their guilds, and playback state
in real-time — refreshed twice per second.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import TYPE_CHECKING, List

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
        self._task: asyncio.Task | None = None

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
        )
        return Panel(f"[dim]{cmds}[/dim]", box=box.HORIZONTALS)
