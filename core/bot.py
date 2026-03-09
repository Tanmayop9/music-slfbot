"""
discord.py-self Client subclass.

Responsibilities:
  • Only process commands from the configured owner_id.
  • Receive Discord gateway messages (voice state / server updates).
  • Forward voice credentials to Lavalink so it can stream audio.
  • Manage per-guild MusicPlayer instances, restoring saved settings on create.
  • Update voice-channel status with the currently-playing track.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional

import discord

try:
    import orjson as _orjson
    _json_loads = _orjson.loads
except ImportError:
    import json as _json_stdlib  # type: ignore[no-redef]

    def _json_loads(data):  # type: ignore[misc]
        if isinstance(data, (bytes, bytearray, memoryview)):
            data = bytes(data).decode()
        return _json_stdlib.loads(data)

from lavalink.pool import NodePool
from music.player import MusicPlayer
from music.queue import LoopMode

if TYPE_CHECKING:
    from sniper.core import VanitySniper
    from storage.guild_settings import GuildSettings

log = logging.getLogger(__name__)


class MusicBot(discord.Client):
    """Single selfbot instance for one user token."""

    def __init__(
        self,
        token: str,
        prefix: str,
        node_configs: List[Dict[str, Any]],
        owner_id: int = 0,
        default_volume: int = 100,
        max_queue_size: int = 500,
        auto_disconnect: bool = True,
        disconnect_timeout: int = 300,
        guild_settings: Optional["GuildSettings"] = None,
        sniper: Optional["VanitySniper"] = None,
    ) -> None:
        super().__init__()
        self._token = token
        self.prefix = prefix
        self._node_configs = node_configs
        self.owner_id = owner_id
        self.default_volume = default_volume
        self.max_queue_size = max_queue_size
        self.auto_disconnect = auto_disconnect
        self.disconnect_timeout = disconnect_timeout
        self.guild_settings = guild_settings   # shared GuildSettings store
        self.sniper = sniper                   # shared VanitySniper (may be None)

        self.node_pool: NodePool = NodePool()
        self.players: Dict[int, MusicPlayer] = {}

        # Pending voice credentials per guild until both pieces arrive
        self._pending_voice: Dict[int, Dict[str, str]] = {}

    # ──────────────────────────────────────────────────────────────────────────
    # Start / ready
    # ──────────────────────────────────────────────────────────────────────────

    async def start_bot(self) -> None:
        await self.start(self._token)

    async def on_ready(self) -> None:
        assert self.user is not None
        log.info("Logged in as %s (%s)", self.user, self.user.id)
        await self._init_nodes()

    async def _init_nodes(self) -> None:
        assert self.user is not None
        for nc in self._node_configs:
            try:
                await self.node_pool.add_node(
                    host=nc["host"],
                    port=nc["port"],
                    password=nc["password"],
                    secure=nc.get("secure", False),
                    name=nc.get("name", "Node"),
                    user_id=self.user.id,
                )
            except Exception as exc:
                log.warning("Could not add node '%s': %s", nc.get("name", "?"), exc)

    # ──────────────────────────────────────────────────────────────────────────
    # Message handling — owner-only
    # ──────────────────────────────────────────────────────────────────────────

    async def on_message(self, message: discord.Message) -> None:
        # Determine whose messages to accept.
        # • If owner_id is configured: accept messages from that account only.
        # • Otherwise: accept only own messages (classic selfbot mode).
        if self.user is None:
            return
        expected_id = self.owner_id if self.owner_id else self.user.id
        if message.author.id != expected_id:
            return

        # Check for per-guild prefix override, fall back to global prefix
        effective_prefix = self.prefix
        if message.guild and self.guild_settings:
            effective_prefix = (
                self.guild_settings.prefix(message.guild.id) or self.prefix
            )

        if not message.content.startswith(effective_prefix):
            return

        content = message.content[len(effective_prefix):]
        parts = content.split(None, 1)
        command = parts[0].lower()
        args = parts[1].strip() if len(parts) > 1 else ""
        try:
            from core.commands import handle_command
            await handle_command(self, message, command, args)
        except Exception as exc:
            log.error("Command '%s' raised: %s", command, exc)
            try:
                await message.channel.send(f"❌ Unexpected error: {exc}")
            except Exception:
                pass

    # ──────────────────────────────────────────────────────────────────────────
    # Voice credential capture & forwarding to Lavalink
    # ──────────────────────────────────────────────────────────────────────────

    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        if self.user is None or member.id != self.user.id:
            return
        guild_id = member.guild.id
        entry = self._pending_voice.setdefault(guild_id, {})
        if after.session_id:
            entry["session_id"] = after.session_id
        await self._try_voice_update(guild_id)

    async def on_socket_raw_receive(self, msg: Any) -> None:
        """Intercept raw gateway messages to capture VOICE_SERVER_UPDATE."""
        # _json_loads accepts bytes and str
        try:
            data: dict = _json_loads(msg)
        except Exception:
            return

        if data.get("t") != "VOICE_SERVER_UPDATE":
            return

        d = data.get("d") or {}
        try:
            guild_id = int(d.get("guild_id", 0))
        except (TypeError, ValueError):
            return

        token = d.get("token", "")
        endpoint = d.get("endpoint", "")
        if not (guild_id and token and endpoint):
            return

        entry = self._pending_voice.setdefault(guild_id, {})
        entry["token"] = token
        entry["endpoint"] = endpoint
        await self._try_voice_update(guild_id)

    async def _try_voice_update(self, guild_id: int) -> None:
        """Send voice update to Lavalink once we have all three credentials."""
        entry = self._pending_voice.get(guild_id, {})
        session_id = entry.get("session_id")
        token = entry.get("token")
        endpoint = entry.get("endpoint")
        if not (session_id and token and endpoint):
            return

        player = self.players.get(guild_id)
        if player is None:
            return

        try:
            await player.node.send_voice_update(guild_id, session_id, token, endpoint)
            log.debug("Voice update sent for guild %s", guild_id)
        except Exception as exc:
            log.error("send_voice_update failed for guild %s: %s", guild_id, exc)

    # ──────────────────────────────────────────────────────────────────────────
    # Player management
    # ──────────────────────────────────────────────────────────────────────────

    def get_player(self, guild_id: int) -> Optional[MusicPlayer]:
        return self.players.get(guild_id)

    async def get_or_create_player(self, guild_id: int) -> Optional[MusicPlayer]:
        player = self.players.get(guild_id)
        if player:
            return player
        node = self.node_pool.get_best_node()
        if node is None:
            log.warning("No available Lavalink nodes for guild %s", guild_id)
            return None

        player = MusicPlayer(guild_id, node)
        player.queue.max_size = self.max_queue_size

        # Restore saved settings from JSON store
        if self.guild_settings:
            player.volume = self.guild_settings.volume(guild_id)
            saved_loop = self.guild_settings.loop_mode(guild_id)
            try:
                player.set_loop(LoopMode(saved_loop))
            except ValueError:
                pass
        else:
            player.volume = self.default_volume

        if self.auto_disconnect:
            player.on_queue_end(self._on_queue_end)

        self.players[guild_id] = player
        return player

    async def _on_queue_end(self, guild_id: int) -> None:
        if not self.auto_disconnect:
            return
        log.info("Queue empty in guild %s — disconnecting in %ds", guild_id, self.disconnect_timeout)
        await asyncio.sleep(self.disconnect_timeout)
        player = self.players.get(guild_id)
        if player and player.current is None and player.queue.is_empty:
            await self.leave_voice(guild_id)

    # ──────────────────────────────────────────────────────────────────────────
    # Voice channel helpers
    # ──────────────────────────────────────────────────────────────────────────

    async def join_voice(self, channel: discord.VoiceChannel) -> bool:
        guild = channel.guild
        try:
            await guild.change_voice_state(channel=channel, self_deaf=True)
            await asyncio.sleep(0.5)
            player = await self.get_or_create_player(guild.id)
            if player:
                player.connected = True
                player.voice_channel_id = channel.id
            return True
        except Exception as exc:
            log.error("join_voice failed for guild %s: %s", guild.id, exc)
            return False

    async def leave_voice(self, guild_id: int) -> None:
        guild = self.get_guild(guild_id)
        if guild:
            try:
                await guild.change_voice_state(channel=None)
            except Exception as exc:
                log.debug("leave_voice change_voice_state error: %s", exc)
        player = self.players.pop(guild_id, None)
        if player:
            await player.destroy()
        self._pending_voice.pop(guild_id, None)

    # ──────────────────────────────────────────────────────────────────────────
    # Voice channel status updates (Discord feature)
    # ──────────────────────────────────────────────────────────────────────────

    async def update_voice_status(self, channel_id: int, status: str) -> None:
        """Set the voice-channel status shown below the channel name."""
        try:
            await self.http.request(
                discord.http.Route(
                    "PUT",
                    "/channels/{channel_id}/voice-status",
                    channel_id=channel_id,
                ),
                json={"status": status},
            )
        except Exception as exc:
            log.debug("update_voice_status error: %s", exc)

    # ──────────────────────────────────────────────────────────────────────────
    # Cleanup
    # ──────────────────────────────────────────────────────────────────────────

    async def close(self) -> None:
        for guild_id in list(self.players.keys()):
            player = self.players.pop(guild_id)
            await player.destroy()
        await self.node_pool.close()
        await super().close()

