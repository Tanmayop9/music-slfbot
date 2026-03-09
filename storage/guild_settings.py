"""
Per-guild persistent settings.

Keys stored per guild:
  volume     int   (0-200,  default 100)
  loop_mode  str   ("none"|"track"|"queue",  default "none")
  prefix     str   (optional per-guild prefix override)
"""
from __future__ import annotations

from typing import Any, Optional

from storage.store import JSONStore

_DEFAULTS: dict = {
    "volume": 100,
    "loop_mode": "none",
}


class GuildSettings:
    """Thin wrapper around JSONStore for per-guild settings."""

    def __init__(self, store: JSONStore) -> None:
        self._store = store

    # ──────────────────────────────────────────────────────────────────────────
    # Read
    # ──────────────────────────────────────────────────────────────────────────

    def get(self, guild_id: int, key: str, default: Any = None) -> Any:
        guild_data: dict = self._store.get(str(guild_id)) or {}
        if key in guild_data:
            return guild_data[key]
        if key in _DEFAULTS:
            return _DEFAULTS[key]
        return default

    def get_all(self, guild_id: int) -> dict:
        base = dict(_DEFAULTS)
        base.update(self._store.get(str(guild_id)) or {})
        return base

    # ──────────────────────────────────────────────────────────────────────────
    # Write
    # ──────────────────────────────────────────────────────────────────────────

    async def set(self, guild_id: int, key: str, value: Any) -> None:
        guild_data: dict = dict(self._store.get(str(guild_id)) or {})
        guild_data[key] = value
        await self._store.set(str(guild_id), guild_data)

    async def set_many(self, guild_id: int, **kwargs: Any) -> None:
        guild_data: dict = dict(self._store.get(str(guild_id)) or {})
        guild_data.update(kwargs)
        await self._store.set(str(guild_id), guild_data)

    async def reset(self, guild_id: int) -> None:
        await self._store.delete(str(guild_id))

    # ──────────────────────────────────────────────────────────────────────────
    # Convenience shortcuts
    # ──────────────────────────────────────────────────────────────────────────

    def volume(self, guild_id: int) -> int:
        return int(self.get(guild_id, "volume", 100))

    def loop_mode(self, guild_id: int) -> str:
        return str(self.get(guild_id, "loop_mode", "none"))

    def prefix(self, guild_id: int) -> Optional[str]:
        return self.get(guild_id, "prefix", None)

    async def save_volume(self, guild_id: int, volume: int) -> None:
        await self.set(guild_id, "volume", volume)

    async def save_loop_mode(self, guild_id: int, mode: str) -> None:
        await self.set(guild_id, "loop_mode", mode)
