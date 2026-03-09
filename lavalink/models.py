"""
Lavalink v4 data models — Track, Playlist, LoadResult.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class TrackInfo:
    identifier: str
    is_seekable: bool
    author: str
    length: int          # milliseconds
    is_stream: bool
    position: int
    title: str
    uri: Optional[str]
    artwork_url: Optional[str]
    isrc: Optional[str]
    source_name: str


@dataclass
class Track:
    encoded: str
    info: TrackInfo
    plugin_info: Dict[str, Any] = field(default_factory=dict)
    user_data: Dict[str, Any] = field(default_factory=dict)
    requester: Optional[str] = None

    @classmethod
    def from_data(cls, data: dict) -> "Track":
        i = data.get("info", {})
        info = TrackInfo(
            identifier=i.get("identifier", ""),
            is_seekable=i.get("isSeekable", False),
            author=i.get("author", "Unknown"),
            length=i.get("length", 0),
            is_stream=i.get("isStream", False),
            position=i.get("position", 0),
            title=i.get("title", "Unknown"),
            uri=i.get("uri"),
            artwork_url=i.get("artworkUrl"),
            isrc=i.get("isrc"),
            source_name=i.get("sourceName", "unknown"),
        )
        return cls(
            encoded=data.get("encoded", ""),
            info=info,
            plugin_info=data.get("pluginInfo", {}),
            user_data=data.get("userData", {}),
        )

    @property
    def duration_str(self) -> str:
        ms = self.info.length
        seconds = ms // 1000
        minutes = seconds // 60
        hours = minutes // 60
        if hours > 0:
            return f"{hours}:{minutes % 60:02d}:{seconds % 60:02d}"
        return f"{minutes}:{seconds % 60:02d}"


@dataclass
class PlaylistInfo:
    name: str
    selected_track: int = -1


@dataclass
class LoadResult:
    load_type: str
    tracks: List[Track] = field(default_factory=list)
    playlist_info: Optional[PlaylistInfo] = None
    exception: Optional[Dict[str, Any]] = None

    @property
    def is_empty(self) -> bool:
        return self.load_type in ("empty", "error") or not self.tracks


class LoadType:
    TRACK = "track"
    PLAYLIST = "playlist"
    SEARCH = "search"
    EMPTY = "empty"
    ERROR = "error"
