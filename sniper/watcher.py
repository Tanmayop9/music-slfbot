"""
Config hot-reload watcher.
Polls the config file every `interval` seconds and calls `on_change(new_cfg)`
whenever the file's SHA-256 hash changes.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from pathlib import Path
from typing import Callable, Optional

import yaml

log = logging.getLogger(__name__)


class ConfigWatcher:
    def __init__(
        self,
        path: str,
        on_change: Callable[[dict], None],
        interval: float = 2.0,
    ) -> None:
        self._path = Path(path)
        self._on_change = on_change
        self._interval = interval
        self._last_hash: Optional[str] = None
        self._task: Optional[asyncio.Task] = None
        self._running = False

    def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(self._run(), name="config-watcher")

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()

    async def _run(self) -> None:
        while self._running:
            try:
                current_hash = self._file_hash()
                if current_hash != self._last_hash:
                    if self._last_hash is not None:
                        new_cfg = self._load()
                        if new_cfg is not None:
                            log.info("[ConfigWatcher] Config changed — hot-reloading sniper targets")
                            self._on_change(new_cfg)
                    self._last_hash = current_hash
            except Exception as exc:
                log.error("[ConfigWatcher] error: %s", exc)
            await asyncio.sleep(self._interval)

    def _file_hash(self) -> str:
        return hashlib.sha256(self._path.read_bytes()).hexdigest()

    def _load(self) -> Optional[dict]:
        try:
            with open(self._path) as f:
                return yaml.safe_load(f)
        except Exception as exc:
            log.error("[ConfigWatcher] parse error: %s", exc)
            return None
