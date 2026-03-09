"""
Discord Gateway monitor for vanity URL sniping.

Maintains a persistent WebSocket connection to Discord's gateway using a user
token, tracks every guild's vanity_url_code, and calls `on_vanity_available`
whenever a vanity is released (GUILD_UPDATE code change or GUILD_DELETE).

Features:
  • Automatic session RESUME on reconnect (no re-identify penalty)
  • Jittered heartbeat to match Discord client behaviour
  • Optional HTTP-CONNECT proxy
  • Thread-safe asyncio-native design
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Coroutine, Dict, Optional, Set

import aiohttp
import orjson

log = logging.getLogger(__name__)

# ── Gateway constants ─────────────────────────────────────────────────────────
GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"

OP_DISPATCH = 0
OP_HEARTBEAT = 1
OP_IDENTIFY = 2
OP_RESUME = 6
OP_HELLO = 10
OP_HEARTBEAT_ACK = 11

# Minimal properties that make Discord's gateway happy with a user token
_CLIENT_PROPERTIES = {
    "os": "Windows",
    "browser": "Discord Client",
    "device": "",
    "system_locale": "en-US",
    "browser_user_agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "browser_version": "122.0.0.0",
    "os_version": "10",
    "referrer": "",
    "referring_domain": "",
    "release_channel": "stable",
    "client_build_number": 281337,   # Discord stable build; update if gateway rejects IDENTIFY
}


class GatewayMonitor:
    """
    Lightweight Discord gateway client.

    `on_vanity_available(code, source_guild_id)` is called (as a coroutine)
    whenever a vanity URL becomes available.
    """

    def __init__(
        self,
        token: str,
        on_vanity_available: Callable[[str, str], Coroutine],
        proxy: Optional[str] = None,
        name: str = "Monitor",
    ) -> None:
        self.token = token
        self.on_vanity_available = on_vanity_available
        self.proxy = proxy
        self.name = name

        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._http: Optional[aiohttp.ClientSession] = None

        # Gateway state
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._sequence: Optional[int] = None
        self._session_id: Optional[str] = None
        self._resume_url: Optional[str] = None
        self._last_ack: float = 0.0
        self._latency: float = 0.0

        self._running: bool = False

        # Guild vanity tracking:  guild_id  ->  vanity_code (or "")
        self._vanity_map: Dict[str, str] = {}
        # All guild IDs this account belongs to (used for auto-leave)
        self.guilds: Set[str] = set()

    # ──────────────────────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Start the gateway loop (non-blocking — spawns a task)."""
        self._http = aiohttp.ClientSession()
        self._running = True
        asyncio.create_task(self._loop(), name=f"gateway-{self.name}")

    async def close(self) -> None:
        self._running = False
        self._cancel_heartbeat()
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._http and not self._http.closed:
            await self._http.close()

    @property
    def latency(self) -> float:
        """Round-trip latency to the gateway in milliseconds."""
        return self._latency

    # ──────────────────────────────────────────────────────────────────────────
    # Connection loop
    # ──────────────────────────────────────────────────────────────────────────

    async def _loop(self) -> None:
        backoff = 1.0
        while self._running:
            try:
                await self._connect_and_listen()
                backoff = 1.0
            except Exception as exc:
                log.warning("[%s] Gateway error: %s — reconnecting in %.0fs", self.name, exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _connect_and_listen(self) -> None:
        # Use resume URL if available (faster reconnect)
        url = self._resume_url or GATEWAY_URL
        connect_kwargs: Dict[str, Any] = {"max_msg_size": 0, "compress": 0}
        if self.proxy:
            connect_kwargs["proxy"] = self.proxy

        assert self._http is not None
        self._ws = await self._http.ws_connect(url, **connect_kwargs)
        log.debug("[%s] WebSocket connected (%s)", self.name, url)

        try:
            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle(orjson.loads(msg.data))
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    import zlib
                    await self._handle(orjson.loads(zlib.decompress(msg.data)))
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    log.debug("[%s] WS closed: %s", self.name, msg)
                    break
        finally:
            self._cancel_heartbeat()

    # ──────────────────────────────────────────────────────────────────────────
    # Opcode handling
    # ──────────────────────────────────────────────────────────────────────────

    async def _handle(self, data: dict) -> None:
        op: int = data.get("op", -1)
        seq = data.get("s")
        if seq is not None:
            self._sequence = seq

        if op == OP_HELLO:
            interval_ms: int = data["d"]["heartbeat_interval"]
            self._cancel_heartbeat()
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(interval_ms / 1000.0)
            )
            await self._identify_or_resume()

        elif op == OP_HEARTBEAT_ACK:
            self._latency = (time.perf_counter() - self._last_ack) * 1000

        elif op == OP_HEARTBEAT:
            # Server requesting a heartbeat immediately
            await self._send_heartbeat()

        elif op == OP_DISPATCH:
            await self._dispatch(data.get("t"), data.get("d") or {})

        elif op == 9:  # INVALID SESSION
            can_resume: bool = data.get("d", False)
            if not can_resume:
                self._session_id = None
                self._sequence = None
            log.warning("[%s] Invalid session (resumable=%s)", self.name, can_resume)
            await asyncio.sleep(2)

        elif op == 7:  # RECONNECT
            log.debug("[%s] Server requested reconnect", self.name)
            if self._ws and not self._ws.closed:
                await self._ws.close()

    # ──────────────────────────────────────────────────────────────────────────
    # Heartbeat
    # ──────────────────────────────────────────────────────────────────────────

    async def _heartbeat_loop(self, interval: float) -> None:
        # Jitter: first beat at a random offset [0, interval)
        import random
        await asyncio.sleep(random.uniform(0, interval))
        while True:
            await self._send_heartbeat()
            await asyncio.sleep(interval)

    async def _send_heartbeat(self) -> None:
        self._last_ack = time.perf_counter()
        await self._send({"op": OP_HEARTBEAT, "d": self._sequence})

    def _cancel_heartbeat(self) -> None:
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()

    # ──────────────────────────────────────────────────────────────────────────
    # Identify / Resume
    # ──────────────────────────────────────────────────────────────────────────

    async def _identify_or_resume(self) -> None:
        if self._session_id and self._sequence is not None:
            log.debug("[%s] Resuming session %s", self.name, self._session_id)
            await self._send({
                "op": OP_RESUME,
                "d": {
                    "token": self.token,
                    "session_id": self._session_id,
                    "seq": self._sequence,
                },
            })
        else:
            log.debug("[%s] Identifying", self.name)
            await self._send({
                "op": OP_IDENTIFY,
                "d": {
                    "token": self.token,
                    "capabilities": 16381,
                    "properties": _CLIENT_PROPERTIES,
                    "presence": {
                        "status": "online",
                        "since": 0,
                        "activities": [],
                        "afk": False,
                    },
                    "compress": False,
                    "client_state": {
                        "guild_versions": {},
                        "highest_last_message_id": "0",
                        "read_state_version": 0,
                        "user_guild_settings_version": -1,
                        "user_settings_version": -1,
                        "private_channels_version": "0",
                        "api_code_version": 0,
                    },
                },
            })

    # ──────────────────────────────────────────────────────────────────────────
    # Event dispatch
    # ──────────────────────────────────────────────────────────────────────────

    async def _dispatch(self, event: Optional[str], data: dict) -> None:
        if event == "READY":
            self._session_id = data.get("session_id")
            self._resume_url = data.get("resume_gateway_url")
            user = data.get("user", {})
            log.info(
                "[%s] Ready as %s#%s — tracking %d guilds",
                self.name,
                user.get("username", "?"),
                user.get("discriminator", "0"),
                len(data.get("guilds", [])),
            )
            # Seed initial vanity map from READY payload
            for g in data.get("guilds", []):
                gid = g.get("id", "")
                if gid:
                    self.guilds.add(gid)
                    code = g.get("vanity_url_code") or ""
                    if code:
                        self._vanity_map[gid] = code

        elif event == "RESUMED":
            log.debug("[%s] Session resumed", self.name)

        elif event == "GUILD_CREATE":
            gid = data.get("id", "")
            if gid:
                self.guilds.add(gid)
                code = data.get("vanity_url_code") or ""
                if code:
                    self._vanity_map[gid] = code

        elif event == "GUILD_UPDATE":
            await self._handle_guild_update(data)

        elif event == "GUILD_DELETE":
            await self._handle_guild_delete(data)

    async def _handle_guild_update(self, data: dict) -> None:
        gid = data.get("id", "")
        if not gid:
            return

        new_code = data.get("vanity_url_code") or ""
        old_code = self._vanity_map.get(gid, "")

        # Update stored code
        if new_code:
            self._vanity_map[gid] = new_code
        elif gid in self._vanity_map:
            del self._vanity_map[gid]

        # Vanity was released
        if old_code and old_code != new_code:
            log.info(
                "[%s] 🔓 Vanity '%s' released from guild %s", self.name, old_code, gid
            )
            asyncio.create_task(self.on_vanity_available(old_code, gid))

    async def _handle_guild_delete(self, data: dict) -> None:
        gid = data.get("id", "")
        if not gid:
            return
        code = self._vanity_map.pop(gid, "")
        self.guilds.discard(gid)
        if code:
            log.info(
                "[%s] 🔓 Guild %s deleted — vanity '%s' released", self.name, gid, code
            )
            asyncio.create_task(self.on_vanity_available(code, gid))

    # ──────────────────────────────────────────────────────────────────────────
    # WS send helper
    # ──────────────────────────────────────────────────────────────────────────

    async def _send(self, payload: dict) -> None:
        if self._ws and not self._ws.closed:
            try:
                # orjson encodes to bytes; send as a UTF-8 text frame
                await self._ws.send_str(orjson.dumps(payload).decode())
            except Exception as exc:
                log.debug("[%s] send error: %s", self.name, exc)
