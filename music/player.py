"""
MusicPlayer — wraps a Lavalink node player for one guild.
Handles playback, queue advancement, volume, seek, and filters.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, List, Optional

from lavalink.models import Track
from lavalink.node import LavalinkNode
from music.filters import get_filter_payload, reset_filters_payload
from music.queue import LoopMode, Queue

log = logging.getLogger(__name__)


class MusicPlayer:
    def __init__(self, guild_id: int, node: LavalinkNode) -> None:
        self.guild_id = guild_id
        self.node = node

        self.queue: Queue = Queue()
        self.current: Optional[Track] = None
        self.volume: int = 100
        self.paused: bool = False
        self.position: int = 0          # milliseconds, updated by playerUpdate
        self.connected: bool = False
        self.voice_channel_id: Optional[int] = None
        self._current_filter: Optional[str] = None

        # Callbacks invoked after the queue empties (guild_id: int)
        self._queue_end_callbacks: List[Callable] = []

        # Register Lavalink hooks
        node.on_event("TrackStartEvent", self._on_track_start)
        node.on_event("TrackEndEvent", self._on_track_end)
        node.on_event("TrackExceptionEvent", self._on_track_exception)
        node.on_event("TrackStuckEvent", self._on_track_stuck)
        node.on_player_update(self._on_player_update)

    # ──────────────────────────────────────────────────────────────────────────
    # Lavalink event handlers
    # ──────────────────────────────────────────────────────────────────────────

    async def _on_track_start(self, guild_id: str, data: dict) -> None:
        if guild_id != str(self.guild_id):
            return
        log.debug("[Player %s] TrackStart: %s", self.guild_id, data.get("track", {}).get("info", {}).get("title"))

    async def _on_track_end(self, guild_id: str, data: dict) -> None:
        if guild_id != str(self.guild_id):
            return
        reason = data.get("reason", "")
        if reason in ("finished", "loadFailed", "stopped"):
            await self._advance()

    async def _on_track_exception(self, guild_id: str, data: dict) -> None:
        if guild_id != str(self.guild_id):
            return
        log.warning("[Player %s] TrackException: %s", self.guild_id, data.get("exception"))
        await self._advance()

    async def _on_track_stuck(self, guild_id: str, data: dict) -> None:
        if guild_id != str(self.guild_id):
            return
        log.warning("[Player %s] TrackStuck", self.guild_id)
        await self._advance()

    async def _on_player_update(self, guild_id: str, state: dict) -> None:
        if guild_id != str(self.guild_id):
            return
        self.position = state.get("position", self.position)

    # ──────────────────────────────────────────────────────────────────────────
    # Internal helpers
    # ──────────────────────────────────────────────────────────────────────────

    async def _advance(self) -> None:
        """Play the next track in the queue, or fire queue-end callbacks."""
        next_track = self.queue.get_next(self.current)
        if next_track:
            await self.play(next_track)
        else:
            self.current = None
            for cb in self._queue_end_callbacks:
                try:
                    await cb(self.guild_id)
                except Exception as exc:
                    log.error("[Player %s] queue_end callback error: %s", self.guild_id, exc)

    # ──────────────────────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────────────────────

    def on_queue_end(self, callback: Callable) -> None:
        self._queue_end_callbacks.append(callback)

    async def play(self, track: Track) -> None:
        self.current = track
        self.paused = False
        await self.node.update_player(
            self.guild_id,
            track={"encoded": track.encoded},
            volume=self.volume,
        )

    async def pause(self) -> None:
        self.paused = True
        await self.node.update_player(self.guild_id, paused=True)

    async def resume(self) -> None:
        self.paused = False
        await self.node.update_player(self.guild_id, paused=False)

    async def stop(self) -> None:
        self.current = None
        self.queue.clear()
        await self.node.update_player(self.guild_id, track={"encoded": None})

    async def skip(self) -> Optional[Track]:
        """Skip current track; returns the next track or None if queue empty."""
        next_track = self.queue.get_next(self.current)
        if next_track:
            await self.play(next_track)
            return next_track
        await self.stop()
        return None

    async def set_volume(self, volume: int) -> None:
        self.volume = max(0, min(200, volume))
        await self.node.update_player(self.guild_id, volume=self.volume)

    async def seek(self, position_ms: int) -> None:
        await self.node.update_player(self.guild_id, position=position_ms)

    async def set_filter(self, filter_name: str) -> bool:
        payload = get_filter_payload(filter_name)
        if payload is None:
            return False
        self._current_filter = filter_name
        await self.node.update_player(self.guild_id, filters=payload)
        return True

    async def clear_filters(self) -> None:
        self._current_filter = None
        await self.node.update_player(self.guild_id, filters=reset_filters_payload())

    async def destroy(self) -> None:
        self.connected = False
        self.current = None
        self.queue.clear()
        try:
            await self.node.destroy_player(self.guild_id)
        except Exception as exc:
            log.debug("[Player %s] destroy error: %s", self.guild_id, exc)

    # ──────────────────────────────────────────────────────────────────────────
    # Properties
    # ──────────────────────────────────────────────────────────────────────────

    @property
    def current_filter(self) -> Optional[str]:
        return self._current_filter

    @property
    def loop_mode(self) -> LoopMode:
        return self.queue.loop_mode

    def set_loop(self, mode: LoopMode) -> None:
        self.queue.loop_mode = mode
