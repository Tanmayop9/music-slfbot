"""
Lavalink v4 node — WebSocket + REST client with automatic reconnection.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional

import aiohttp

try:
    import orjson as _orjson
    _json_loads = _orjson.loads
except ImportError:
    import json as _json_stdlib  # type: ignore[no-redef]

    def _json_loads(data):  # type: ignore[misc]
        if isinstance(data, (bytes, bytearray, memoryview)):
            data = bytes(data).decode()
        return _json_stdlib.loads(data)

from .models import LoadResult, LoadType, PlaylistInfo, Track

log = logging.getLogger(__name__)


class NodeStats:
    def __init__(self, data: dict) -> None:
        self.players: int = data.get("players", 0)
        self.playing_players: int = data.get("playingPlayers", 0)
        self.uptime: int = data.get("uptime", 0)
        memory = data.get("memory", {})
        self.memory_used: int = memory.get("used", 0)
        self.memory_free: int = memory.get("free", 0)
        cpu = data.get("cpu", {})
        self.cpu_cores: int = cpu.get("cores", 0)
        self.cpu_system_load: float = cpu.get("systemLoad", 0.0)
        self.cpu_lavalink_load: float = cpu.get("lavalinkLoad", 0.0)


class LavalinkNode:
    """
    Single Lavalink v4 node.  Maintains a persistent WebSocket connection,
    provides REST helpers, and dispatches player events to registered hooks.
    """

    def __init__(
        self,
        *,
        host: str,
        port: int,
        password: str,
        secure: bool = False,
        name: str = "Node",
        user_id: int = 0,
    ) -> None:
        self.host = host
        self.port = port
        self.password = password
        self.secure = secure
        self.name = name
        self.user_id = user_id

        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._http: Optional[aiohttp.ClientSession] = None
        self._session_id: Optional[str] = None
        self._available: bool = False
        self._stats: Optional[NodeStats] = None

        # Registered hooks: event_type -> list[coroutine_func(guild_id, data)]
        self._event_hooks: Dict[str, List[Callable]] = {}
        # Registered hooks: list[coroutine_func(guild_id, state)]
        self._player_update_hooks: List[Callable] = []

        self._ws_task: Optional[asyncio.Task] = None

    # ──────────────────────────────────────────────────────────────────────────
    # Properties
    # ──────────────────────────────────────────────────────────────────────────

    @property
    def ws_url(self) -> str:
        scheme = "wss" if self.secure else "ws"
        return f"{scheme}://{self.host}:{self.port}/v4/websocket"

    @property
    def rest_url(self) -> str:
        scheme = "https" if self.secure else "http"
        return f"{scheme}://{self.host}:{self.port}"

    @property
    def available(self) -> bool:
        return self._available

    @property
    def stats(self) -> Optional[NodeStats]:
        return self._stats

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    # ──────────────────────────────────────────────────────────────────────────
    # Connection lifecycle
    # ──────────────────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession()
        await self._connect_ws()

    async def _connect_ws(self) -> None:
        headers: Dict[str, str] = {
            "Authorization": self.password,
            "User-Id": str(self.user_id),
            "Client-Name": "MusicSelfBot/1.0",
        }
        if self._session_id:
            headers["Session-Id"] = self._session_id

        try:
            self._ws = await self._http.ws_connect(
                self.ws_url,
                headers=headers,
                heartbeat=30,
            )
            self._available = True
            log.info("[%s] WebSocket connected", self.name)
            # Cancel old listen task if any
            if self._ws_task and not self._ws_task.done():
                self._ws_task.cancel()
            self._ws_task = asyncio.create_task(self._listen())
        except Exception as exc:
            self._available = False
            log.warning("[%s] Connection failed: %s — retrying in 5 s", self.name, exc)
            asyncio.create_task(self._reconnect())

    async def _reconnect(self) -> None:
        await asyncio.sleep(5)
        await _safe_close_ws(self._ws)
        await self._connect_ws()

    async def _listen(self) -> None:
        try:
            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._dispatch(_json_loads(msg.data))
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
        except Exception as exc:
            log.error("[%s] Listener error: %s", self.name, exc)
        finally:
            self._available = False
            log.warning("[%s] Disconnected — scheduling reconnect", self.name)
            asyncio.create_task(self._reconnect())

    # ──────────────────────────────────────────────────────────────────────────
    # Message dispatch
    # ──────────────────────────────────────────────────────────────────────────

    async def _dispatch(self, data: dict) -> None:
        op = data.get("op")

        if op == "ready":
            self._session_id = data["sessionId"]
            self._available = True
            log.info("[%s] Ready — session %s", self.name, self._session_id)

        elif op == "stats":
            self._stats = NodeStats(data)

        elif op == "playerUpdate":
            guild_id: str = data.get("guildId", "")
            state: dict = data.get("state", {})
            for hook in self._player_update_hooks:
                asyncio.create_task(hook(guild_id, state))

        elif op == "event":
            event_type: str = data.get("type", "")
            guild_id = data.get("guildId", "")
            for hook in self._event_hooks.get(event_type, []):
                asyncio.create_task(hook(guild_id, data))

    # ──────────────────────────────────────────────────────────────────────────
    # Hook registration
    # ──────────────────────────────────────────────────────────────────────────

    def on_event(self, event_type: str, hook: Callable) -> None:
        self._event_hooks.setdefault(event_type, []).append(hook)

    def on_player_update(self, hook: Callable) -> None:
        self._player_update_hooks.append(hook)

    # ──────────────────────────────────────────────────────────────────────────
    # REST helpers
    # ──────────────────────────────────────────────────────────────────────────

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        if self._http is None:
            raise RuntimeError("Node HTTP session not initialised")
        url = f"{self.rest_url}{path}"
        async with self._http.request(
            method,
            url,
            headers={"Authorization": self.password},
            **kwargs,
        ) as resp:
            if resp.status == 204:
                return None
            resp.raise_for_status()
            return await resp.json()

    # ──────────────────────────────────────────────────────────────────────────
    # Track loading
    # ──────────────────────────────────────────────────────────────────────────

    async def load_tracks(self, identifier: str) -> LoadResult:
        try:
            data = await self._request(
                "GET",
                "/v4/loadtracks",
                params={"identifier": identifier},
            )
        except Exception as exc:
            log.error("[%s] load_tracks error: %s", self.name, exc)
            return LoadResult(load_type=LoadType.ERROR, exception={"message": str(exc)})

        load_type: str = data.get("loadType", "empty")

        if load_type == "track":
            track = Track.from_data(data["data"])
            return LoadResult(load_type=LoadType.TRACK, tracks=[track])

        if load_type == "playlist":
            pd = data["data"]
            tracks = [Track.from_data(t) for t in pd.get("tracks", [])]
            pinfo = PlaylistInfo(
                name=pd["info"]["name"],
                selected_track=pd["info"].get("selectedTrack", -1),
            )
            return LoadResult(load_type=LoadType.PLAYLIST, tracks=tracks, playlist_info=pinfo)

        if load_type == "search":
            tracks = [Track.from_data(t) for t in data.get("data", [])]
            return LoadResult(load_type=LoadType.SEARCH, tracks=tracks)

        if load_type == "error":
            return LoadResult(load_type=LoadType.ERROR, exception=data.get("data"))

        return LoadResult(load_type=LoadType.EMPTY)

    # ──────────────────────────────────────────────────────────────────────────
    # Player control
    # ──────────────────────────────────────────────────────────────────────────

    async def update_player(self, guild_id: int, *, no_replace: bool = False, **payload: Any) -> Optional[dict]:
        if not self._session_id:
            raise RuntimeError(f"[{self.name}] No session — not yet connected")
        params = {"noReplace": "true" if no_replace else "false"}
        return await self._request(
            "PATCH",
            f"/v4/sessions/{self._session_id}/players/{guild_id}",
            json=payload,
            params=params,
        )

    async def destroy_player(self, guild_id: int) -> None:
        if not self._session_id:
            return
        try:
            await self._request(
                "DELETE",
                f"/v4/sessions/{self._session_id}/players/{guild_id}",
            )
        except Exception as exc:
            log.debug("[%s] destroy_player: %s", self.name, exc)

    # ──────────────────────────────────────────────────────────────────────────
    # Voice update forwarding
    # ──────────────────────────────────────────────────────────────────────────

    async def send_voice_update(
        self,
        guild_id: int,
        session_id: str,
        token: str,
        endpoint: str,
    ) -> None:
        await self.update_player(
            guild_id,
            voice={"token": token, "endpoint": endpoint, "sessionId": session_id},
        )

    # ──────────────────────────────────────────────────────────────────────────
    # Cleanup
    # ──────────────────────────────────────────────────────────────────────────

    async def close(self) -> None:
        self._available = False
        if self._ws_task and not self._ws_task.done():
            self._ws_task.cancel()
        await _safe_close_ws(self._ws)
        if self._http and not self._http.closed:
            await self._http.close()


async def _safe_close_ws(ws: Optional[aiohttp.ClientWebSocketResponse]) -> None:
    if ws and not ws.closed:
        try:
            await ws.close()
        except Exception:
            pass
