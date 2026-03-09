"""
Queue with loop modes (none / track / queue), shuffle, remove, and move.
"""
from __future__ import annotations

import random
from enum import Enum
from typing import List, Optional

from lavalink.models import Track


class LoopMode(Enum):
    NONE = "none"
    TRACK = "track"
    QUEUE = "queue"


class Queue:
    def __init__(self, max_size: int = 500) -> None:
        self._tracks: List[Track] = []
        self._history: List[Track] = []
        self.loop_mode: LoopMode = LoopMode.NONE
        self.max_size: int = max_size

    # ──────────────────────────────────────────────────────────────────────────
    # Properties
    # ──────────────────────────────────────────────────────────────────────────

    @property
    def tracks(self) -> List[Track]:
        return list(self._tracks)

    @property
    def size(self) -> int:
        return len(self._tracks)

    @property
    def is_empty(self) -> bool:
        return not self._tracks

    @property
    def total_duration_ms(self) -> int:
        return sum(t.info.length for t in self._tracks)

    @property
    def history(self) -> List[Track]:
        return list(self._history)

    # ──────────────────────────────────────────────────────────────────────────
    # Adding tracks
    # ──────────────────────────────────────────────────────────────────────────

    def add(self, track: Track) -> bool:
        if len(self._tracks) >= self.max_size:
            return False
        self._tracks.append(track)
        return True

    def add_many(self, tracks: List[Track]) -> int:
        added = 0
        for track in tracks:
            if self.add(track):
                added += 1
            else:
                break
        return added

    # ──────────────────────────────────────────────────────────────────────────
    # Consuming tracks
    # ──────────────────────────────────────────────────────────────────────────

    def get_next(self, current: Optional[Track] = None) -> Optional[Track]:
        """
        Dequeue the next track, honouring the current loop mode.
        `current` is the track that just finished; it is pushed to history
        (and re-queued if QUEUE loop is on).
        """
        if self.loop_mode == LoopMode.TRACK and current is not None:
            return current

        if not self._tracks:
            return None

        track = self._tracks.pop(0)

        if current is not None:
            self._history.append(current)
            if len(self._history) > 50:
                self._history.pop(0)

        if self.loop_mode == LoopMode.QUEUE:
            self._tracks.append(track)

        return track

    def remove(self, index: int) -> Optional[Track]:
        if 0 <= index < len(self._tracks):
            return self._tracks.pop(index)
        return None

    def clear(self) -> None:
        self._tracks.clear()

    # ──────────────────────────────────────────────────────────────────────────
    # Reordering
    # ──────────────────────────────────────────────────────────────────────────

    def shuffle(self) -> None:
        random.shuffle(self._tracks)

    def move(self, from_index: int, to_index: int) -> bool:
        if 0 <= from_index < len(self._tracks) and 0 <= to_index < len(self._tracks):
            track = self._tracks.pop(from_index)
            self._tracks.insert(to_index, track)
            return True
        return False
