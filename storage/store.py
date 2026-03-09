"""
Atomic async JSON key-value store powered by orjson.

Why orjson?
  • 10-20× faster than stdlib json on encode/decode
  • Native bytes output — zero intermediate string allocation
  • Handles datetime, dataclasses, numpy arrays out of the box

Design choices for speed and safety:
  • All data kept in a plain dict in memory → O(1) get with zero I/O
  • Every mutation is flushed to disk atomically (write temp → os.replace)
    so the file is never partially written
  • Disk I/O is off-loaded to a thread pool via asyncio.to_thread so the
    event-loop never blocks
  • A single asyncio.Lock serialises concurrent writes (last-write-wins order)
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import orjson

log = logging.getLogger(__name__)


class JSONStore:
    """
    Thread-safe, async, persistent JSON key-value store.

    Usage::

        store = JSONStore("data/guild_settings.json")
        await store.load()                    # once at startup
        val = store.get("key", default=None)  # O(1) in-memory
        await store.set("key", value)         # in-memory + async disk flush
    """

    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._data: Dict[str, Any] = {}
        self._lock = asyncio.Lock()

    # ──────────────────────────────────────────────────────────────────────────
    # Lifecycle
    # ──────────────────────────────────────────────────────────────────────────

    async def load(self) -> None:
        """Load persisted data from disk into the in-memory cache."""
        if not self._path.exists():
            self._data = {}
            return
        try:
            raw: bytes = await asyncio.to_thread(self._path.read_bytes)
            self._data = orjson.loads(raw) if raw.strip() else {}
        except Exception as exc:
            log.error("[JSONStore] Failed to load %s: %s — starting empty", self._path, exc)
            self._data = {}

    # ──────────────────────────────────────────────────────────────────────────
    # Read (in-memory, no I/O)
    # ──────────────────────────────────────────────────────────────────────────

    def get(self, key: str, default: Any = None) -> Any:
        """O(1) in-memory read."""
        return self._data.get(key, default)

    def all(self) -> Dict[str, Any]:
        """Return a shallow copy of the entire store."""
        return dict(self._data)

    def __contains__(self, key: str) -> bool:
        return key in self._data

    # ──────────────────────────────────────────────────────────────────────────
    # Write (in-memory + async disk flush)
    # ──────────────────────────────────────────────────────────────────────────

    async def set(self, key: str, value: Any) -> None:
        async with self._lock:
            self._data[key] = value
            await self._flush()

    async def set_many(self, updates: Dict[str, Any]) -> None:
        """Set multiple keys in one atomic write."""
        async with self._lock:
            self._data.update(updates)
            await self._flush()

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._data.pop(key, None)
            await self._flush()

    async def clear(self) -> None:
        async with self._lock:
            self._data.clear()
            await self._flush()

    # ──────────────────────────────────────────────────────────────────────────
    # Internal
    # ──────────────────────────────────────────────────────────────────────────

    async def _flush(self) -> None:
        """Atomically serialise self._data to disk using orjson."""
        payload: bytes = orjson.dumps(
            self._data,
            option=orjson.OPT_INDENT_2 | orjson.OPT_SORT_KEYS,
        )
        await asyncio.to_thread(self._atomic_write, payload)

    def _atomic_write(self, data: bytes) -> None:
        """Write-to-temp + os.replace so the file is never corrupt."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=self._path.parent, suffix=".tmp")
        try:
            os.write(fd, data)
            os.close(fd)
            os.replace(tmp_path, self._path)
        except Exception:
            try:
                os.close(fd)
            except OSError as e:
                log.debug("[JSONStore] fd close error during cleanup: %s", e)
            try:
                os.unlink(tmp_path)
            except OSError as e:
                log.debug("[JSONStore] tmp unlink error during cleanup: %s", e)
            raise
