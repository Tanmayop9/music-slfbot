"""
discord.py-self Client subclass.

Responsibilities:
  • Receive Discord gateway messages (voice state / server updates).
  • Forward voice credentials to Lavalink so it can stream audio.
  • Manage per-guild MusicPlayer instances.
  • Update voice-channel status with the currently-playing track.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

import discord

from lavalink.pool import NodePool
from music.player import MusicPlayer

log = logging.getLogger(__name__)

# Source-search prefix mapping (command shorthand -> Lavalink search prefix)
SOURCE_PREFIXES: Dict[str, str] = {
    "youtube": "ytsearch:",
    "yt": "ytsearch:",
    "spotify": "spsearch:",
    "sp": "spsearch:",
    "soundcloud": "scsearch:",
    "sc": "scsearch:",
    "jiosaavn": "jssearch:",
    "js": "jssearch:",
    "apple": "amsearch:",
    "am": "amsearch:",
    "deezer": "dzsearch:",
    "dz": "dzsearch:",
}


class MusicBot(discord.Client):
    """Single selfbot instance for one user token."""

    def __init__(
        self,
        token: str,
        prefix: str,
        node_configs: List[Dict[str, Any]],
        default_volume: int = 100,
        max_queue_size: int = 500,
        auto_disconnect: bool = True,
        disconnect_timeout: int = 300,
    ) -> None:
        super().__init__()
        self._token = token
        self.prefix = prefix
        self._node_configs = node_configs
        self.default_volume = default_volume
        self.max_queue_size = max_queue_size
        self.auto_disconnect = auto_disconnect
        self.disconnect_timeout = disconnect_timeout

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
    # Message handling
    # ──────────────────────────────────────────────────────────────────────────

    async def on_message(self, message: discord.Message) -> None:
        # Selfbot: only react to own messages
        if self.user is None or message.author.id != self.user.id:
            return
        if not message.content.startswith(self.prefix):
            return
        content = message.content[len(self.prefix):]
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
        if isinstance(msg, bytes):
            try:
                msg = msg.decode()
            except Exception:
                return
        try:
            data = json.loads(msg)
        except Exception:
            return

        if data.get("t") != "VOICE_SERVER_UPDATE":
            return

        d = data.get("d", {})
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
        player.volume = self.default_volume
        player.queue.max_size = self.max_queue_size
        if self.auto_disconnect:
            player.on_queue_end(self._on_queue_end)
        self.players[guild_id] = player
        return player

    async def _on_queue_end(self, guild_id: int) -> None:
        if not self.auto_disconnect:
            return
        log.info("Queue empty in guild %s — disconnecting in %ds", guild_id, self.disconnect_timeout)
        await asyncio.sleep(self.disconnect_timeout)
        # Only disconnect if queue is still empty
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
            # Allow a moment for VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE
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
        """Set the voice-channel status displayed below the channel name."""
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
