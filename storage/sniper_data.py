"""
Persistent sniper data — targets and claim history.

JSON layout (data/sniper.json):
  {
    "targets": ["code1", "code2", ...],
    "history": [
      {"code": "...", "guild_id": "...", "latency_ms": 12.3, "ts": "ISO8601"},
      ...
    ]
  }
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Set

from storage.store import JSONStore

_MAX_HISTORY = 200


class SniperData:
    """Thin wrapper around JSONStore for sniper state persistence."""

    def __init__(self, store: JSONStore) -> None:
        self._store = store

    # ──────────────────────────────────────────────────────────────────────────
    # Targets
    # ──────────────────────────────────────────────────────────────────────────

    def get_targets(self) -> Set[str]:
        return set(self._store.get("targets") or [])

    async def add_target(self, code: str) -> bool:
        """Returns True if newly added, False if already present."""
        code = code.lower().strip()
        targets = self.get_targets()
        if code in targets:
            return False
        targets.add(code)
        await self._store.set("targets", sorted(targets))
        return True

    async def remove_target(self, code: str) -> bool:
        """Returns True if removed, False if not found."""
        code = code.lower().strip()
        targets = self.get_targets()
        if code not in targets:
            return False
        targets.discard(code)
        await self._store.set("targets", sorted(targets))
        return True

    async def set_targets(self, codes: Set[str]) -> None:
        await self._store.set("targets", sorted(c.lower() for c in codes))

    # ──────────────────────────────────────────────────────────────────────────
    # Claim history
    # ──────────────────────────────────────────────────────────────────────────

    def get_history(self) -> List[Dict[str, Any]]:
        return list(self._store.get("history") or [])

    async def add_history(
        self,
        code: str,
        guild_id: str,
        latency_ms: float,
        source_guild_id: str = "",
    ) -> None:
        history = self.get_history()
        history.insert(0, {
            "code": code,
            "guild_id": guild_id,
            "source_guild_id": source_guild_id,
            "latency_ms": round(latency_ms, 2),
            "ts": datetime.now(timezone.utc).isoformat(),
        })
        if len(history) > _MAX_HISTORY:
            history = history[:_MAX_HISTORY]
        await self._store.set("history", history)

    async def clear_history(self) -> None:
        await self._store.set("history", [])

    def history_summary(self, limit: int = 10) -> List[str]:
        """Return human-readable lines for the most recent `limit` snipes."""
        lines: List[str] = []
        for entry in self.get_history()[:limit]:
            ts = entry.get("ts", "")[:19].replace("T", " ")
            lines.append(
                f"`discord.gg/{entry['code']}`  →  guild `{entry['guild_id']}`"
                f"  `{entry['latency_ms']:.0f} ms`  *{ts} UTC*"
            )
        return lines
