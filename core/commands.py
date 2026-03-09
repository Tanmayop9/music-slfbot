"""
Command handlers for the music selfbot.

Supported commands:
  play (p), pause, resume (r), stop, skip (s), queue (q), clear, shuffle,
  loop, volume (vol), seek, nowplaying (np), filter (f), filters,
  clearfilter (cf), remove, disconnect (dc), move, search
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

import discord

from lavalink.models import LoadType
from music.filters import list_filters
from music.queue import LoopMode

if TYPE_CHECKING:
    from core.bot import MusicBot

log = logging.getLogger(__name__)

# Mapping of source shorthand to Lavalink search prefix
_SOURCE_MAP = {
    "youtube": "ytsearch:",
    "yt":      "ytsearch:",
    "spotify": "spsearch:",
    "sp":      "spsearch:",
    "soundcloud": "scsearch:",
    "sc":      "scsearch:",
    "jiosaavn": "jssearch:",
    "js":      "jssearch:",
    "apple":   "amsearch:",
    "am":      "amsearch:",
    "deezer":  "dzsearch:",
    "dz":      "dzsearch:",
}

COMMAND_MAP = {
    "play": "_cmd_play",
    "p":    "_cmd_play",
    "pause":    "_cmd_pause",
    "resume":   "_cmd_resume",
    "r":        "_cmd_resume",
    "stop":     "_cmd_stop",
    "skip":     "_cmd_skip",
    "s":        "_cmd_skip",
    "queue":    "_cmd_queue",
    "q":        "_cmd_queue",
    "clear":    "_cmd_clear_queue",
    "shuffle":  "_cmd_shuffle",
    "loop":     "_cmd_loop",
    "volume":   "_cmd_volume",
    "vol":      "_cmd_volume",
    "seek":     "_cmd_seek",
    "nowplaying": "_cmd_nowplaying",
    "np":       "_cmd_nowplaying",
    "filter":   "_cmd_filter",
    "f":        "_cmd_filter",
    "filters":  "_cmd_filters",
    "clearfilter": "_cmd_clearfilter",
    "cf":       "_cmd_clearfilter",
    "remove":   "_cmd_remove",
    "disconnect": "_cmd_disconnect",
    "dc":       "_cmd_disconnect",
    "move":     "_cmd_move",
    "search":   "_cmd_search",
}


async def handle_command(
    bot: "MusicBot",
    message: discord.Message,
    command: str,
    args: str,
) -> None:
    func_name = COMMAND_MAP.get(command)
    if func_name is None:
        return
    handler = globals().get(func_name)
    if handler is None:
        return
    await handler(bot, message, args)


# ──────────────────────────────────────────────────────────────────────────────
# Shared helpers
# ──────────────────────────────────────────────────────────────────────────────

async def _ensure_voice(bot: "MusicBot", message: discord.Message):
    """
    Returns a ready MusicPlayer, joining voice if needed.
    Sends an error message and returns None on failure.
    """
    guild = message.guild
    if guild is None:
        return None

    member = guild.get_member(message.author.id)
    if member is None or member.voice is None or member.voice.channel is None:
        await message.channel.send("❌ You must be in a voice channel first!")
        return None

    player = bot.get_player(guild.id)
    if player is None or not player.connected:
        ok = await bot.join_voice(member.voice.channel)
        if not ok:
            await message.channel.send("❌ Failed to join your voice channel!")
            return None

    return bot.get_player(guild.id)


def _build_identifier(args: str) -> str:
    """Convert user input to a Lavalink identifier (URL or search query)."""
    # Direct URL
    if args.startswith(("http://", "https://")):
        return args

    # source:query shorthand
    for shorthand, prefix in _SOURCE_MAP.items():
        if args.lower().startswith(shorthand + ":"):
            query = args[len(shorthand) + 1:]
            return f"{prefix}{query}"

    # Default: YouTube search
    return f"ytsearch:{args}"


def _fmt_ms(ms: int) -> str:
    s = ms // 1000
    m = s // 60
    h = m // 60
    if h:
        return f"{h}:{m % 60:02d}:{s % 60:02d}"
    return f"{m}:{s % 60:02d}"


# ──────────────────────────────────────────────────────────────────────────────
# Command implementations
# ──────────────────────────────────────────────────────────────────────────────

async def _cmd_play(bot: "MusicBot", message: discord.Message, args: str) -> None:
    if not args:
        # No args: resume if paused
        player = bot.get_player(message.guild.id)
        if player and player.paused:
            await player.resume()
            await message.channel.send("▶️ Resumed!")
        else:
            await message.channel.send(f"❌ Usage: `{bot.prefix}play <song name or URL>`")
        return

    player = await _ensure_voice(bot, message)
    if player is None:
        return

    identifier = _build_identifier(args)
    status = await message.channel.send(f"🔍 Searching for `{args}`…")

    result = await player.node.load_tracks(identifier)

    if result.is_empty:
        await status.edit(content="❌ No results found!")
        return

    if result.load_type == LoadType.PLAYLIST:
        count = player.queue.add_many(result.tracks)
        name = result.playlist_info.name if result.playlist_info else "Playlist"
        if not player.current:
            first = player.queue.get_next()
            if first:
                first.requester = str(message.author)
                await player.play(first)
                await _set_voice_status(bot, player, first.info.title)
        await status.edit(content=f"📋 Queued **{count}** tracks from **{name}**!")
        return

    track = result.tracks[0]
    track.requester = str(message.author)

    if not player.current:
        await player.play(track)
        await _set_voice_status(bot, player, track.info.title)
        await status.edit(
            content=f"🎵 Now playing: **{track.info.title}** — *{track.info.author}* `[{track.duration_str}]`"
        )
    else:
        player.queue.add(track)
        pos = player.queue.size
        await status.edit(content=f"➕ Added **{track.info.title}** to queue (position #{pos})")


async def _set_voice_status(bot: "MusicBot", player, title: str) -> None:
    if player.voice_channel_id:
        await bot.update_voice_status(player.voice_channel_id, f"🎵 {title}")


async def _cmd_pause(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or not player.current:
        await message.channel.send("❌ Nothing is playing!")
        return
    await player.pause()
    await message.channel.send("⏸️ Paused!")


async def _cmd_resume(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player:
        await message.channel.send("❌ No active player!")
        return
    await player.resume()
    await message.channel.send("▶️ Resumed!")


async def _cmd_stop(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player:
        await message.channel.send("❌ No active player!")
        return
    await player.stop()
    await message.channel.send("⏹️ Stopped and cleared the queue!")


async def _cmd_skip(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or not player.current:
        await message.channel.send("❌ Nothing is playing!")
        return
    next_track = await player.skip()
    if next_track:
        await _set_voice_status(bot, player, next_track.info.title)
        await message.channel.send(f"⏭️ Skipped! Now playing: **{next_track.info.title}**")
    else:
        await message.channel.send("⏭️ Skipped! Queue is empty.")


async def _cmd_queue(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player:
        await message.channel.send("❌ No active player!")
        return

    lines = []

    if player.current:
        elapsed_s = player.position // 1000
        total_s = player.current.info.length // 1000
        lines += [
            "**🎵 Now Playing:**",
            f"  `{player.current.info.title}` — `{elapsed_s // 60}:{elapsed_s % 60:02d}` / `{total_s // 60}:{total_s % 60:02d}`",
            "",
        ]

    tracks = player.queue.tracks
    if not tracks:
        lines.append("📋 Queue is empty.")
    else:
        total_ms = player.queue.total_duration_ms
        lines.append(f"**📋 Queue — {len(tracks)} track(s) [{_fmt_ms(total_ms)}]:**")
        for i, t in enumerate(tracks[:10], 1):
            lines.append(f"  `{i:2}.` {t.info.title} `[{t.duration_str}]`")
        if len(tracks) > 10:
            lines.append(f"  *…and {len(tracks) - 10} more*")

    extras = []
    if player.loop_mode != LoopMode.NONE:
        extras.append(f"🔁 Loop: `{player.loop_mode.value}`")
    if player.current_filter:
        extras.append(f"🎛️ Filter: `{player.current_filter}`")
    extras.append(f"🔊 Volume: `{player.volume}%`")

    lines.append("")
    lines.append("  ".join(extras))
    await message.channel.send("\n".join(lines))


async def _cmd_clear_queue(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player:
        await message.channel.send("❌ No active player!")
        return
    player.queue.clear()
    await message.channel.send("🗑️ Queue cleared!")


async def _cmd_shuffle(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or player.queue.is_empty:
        await message.channel.send("❌ Queue is empty!")
        return
    player.queue.shuffle()
    await message.channel.send("🔀 Queue shuffled!")


async def _cmd_loop(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player:
        await message.channel.send("❌ No active player!")
        return

    arg = args.lower().strip()
    mode_map = {
        "track": LoopMode.TRACK,
        "queue": LoopMode.QUEUE,
        "off":   LoopMode.NONE,
        "none":  LoopMode.NONE,
        "":      None,  # cycle
    }
    if arg not in mode_map:
        await message.channel.send("❌ Usage: `loop [track|queue|off]`")
        return

    if mode_map[arg] is None:
        # Cycle through modes
        cycle = [LoopMode.NONE, LoopMode.TRACK, LoopMode.QUEUE]
        new_mode = cycle[(cycle.index(player.loop_mode) + 1) % len(cycle)]
    else:
        new_mode = mode_map[arg]

    player.set_loop(new_mode)
    icons = {LoopMode.NONE: "➡️", LoopMode.TRACK: "🔂", LoopMode.QUEUE: "🔁"}
    await message.channel.send(f"{icons[new_mode]} Loop: **{new_mode.value}**")


async def _cmd_volume(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player:
        await message.channel.send("❌ No active player!")
        return
    if not args:
        await message.channel.send(f"🔊 Volume: **{player.volume}%**")
        return
    try:
        vol = int(args)
    except ValueError:
        await message.channel.send("❌ Volume must be a number between 0 and 200!")
        return
    await player.set_volume(vol)
    await message.channel.send(f"🔊 Volume set to **{player.volume}%**")


async def _cmd_seek(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or not player.current:
        await message.channel.send("❌ Nothing is playing!")
        return
    if not args:
        await message.channel.send("❌ Usage: `seek <seconds>` or `seek <MM:SS>`")
        return
    try:
        if ":" in args:
            parts = args.split(":", 1)
            seconds = int(parts[0]) * 60 + int(parts[1])
        else:
            seconds = int(args)
    except ValueError:
        await message.channel.send("❌ Invalid time format! Use seconds or `MM:SS`.")
        return
    await player.seek(seconds * 1000)
    await message.channel.send(f"⏩ Seeked to **{seconds // 60}:{seconds % 60:02d}**")


async def _cmd_nowplaying(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or not player.current:
        await message.channel.send("❌ Nothing is playing!")
        return

    track = player.current
    elapsed_ms = player.position
    total_ms = track.info.length
    elapsed_s = elapsed_ms // 1000
    total_s = total_ms // 1000

    # Progress bar
    bar_len = 20
    progress = int((elapsed_s / total_s) * bar_len) if total_s else 0
    bar = "▓" * progress + "░" * (bar_len - progress)

    lines = [
        "**🎵 Now Playing**",
        f"**{track.info.title}**",
        f"by *{track.info.author}*",
        "",
        f"`[{bar}]`",
        f"`{elapsed_s // 60}:{elapsed_s % 60:02d} / {total_s // 60}:{total_s % 60:02d}`",
        "",
        f"🔊 Vol: `{player.volume}%`  🔁 Loop: `{player.loop_mode.value}`",
    ]
    if player.current_filter:
        lines.append(f"🎛️ Filter: `{player.current_filter}`")
    if track.requester:
        lines.append(f"👤 Requested by: {track.requester}")
    await message.channel.send("\n".join(lines))


async def _cmd_filter(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or not player.current:
        await message.channel.send("❌ Nothing is playing!")
        return
    if not args:
        await message.channel.send(
            f"❌ Usage: `{bot.prefix}filter <name>` — use `{bot.prefix}filters` for the full list."
        )
        return
    ok = await player.set_filter(args.lower().strip())
    if ok:
        await message.channel.send(f"🎛️ Filter applied: **{args.lower().strip()}**")
    else:
        await message.channel.send(
            f"❌ Unknown filter `{args}`! Use `{bot.prefix}filters` for the full list."
        )


async def _cmd_filters(bot: "MusicBot", message: discord.Message, args: str) -> None:
    names = list_filters()
    joined = "  ".join(f"`{n}`" for n in names)
    await message.channel.send(f"🎛️ **Available filters ({len(names)}):**\n{joined}")


async def _cmd_clearfilter(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player:
        await message.channel.send("❌ No active player!")
        return
    await player.clear_filters()
    await message.channel.send("🎛️ Filters cleared!")


async def _cmd_remove(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or player.queue.is_empty:
        await message.channel.send("❌ Queue is empty!")
        return
    try:
        idx = int(args.strip()) - 1
    except ValueError:
        await message.channel.send("❌ Usage: `remove <position>`")
        return
    removed = player.queue.remove(idx)
    if removed:
        await message.channel.send(f"🗑️ Removed **{removed.info.title}** from the queue.")
    else:
        await message.channel.send("❌ Invalid queue position!")


async def _cmd_disconnect(bot: "MusicBot", message: discord.Message, args: str) -> None:
    guild = message.guild
    player = bot.get_player(guild.id)
    if player:
        await player.stop()
    await bot.leave_voice(guild.id)
    await message.channel.send("👋 Disconnected!")


async def _cmd_move(bot: "MusicBot", message: discord.Message, args: str) -> None:
    player = bot.get_player(message.guild.id)
    if not player or player.queue.is_empty:
        await message.channel.send("❌ Queue is empty!")
        return
    try:
        parts = args.split()
        from_pos = int(parts[0]) - 1
        to_pos = int(parts[1]) - 1
    except (ValueError, IndexError):
        await message.channel.send("❌ Usage: `move <from> <to>`")
        return
    if player.queue.move(from_pos, to_pos):
        await message.channel.send(f"↕️ Moved track from position **{from_pos + 1}** to **{to_pos + 1}**.")
    else:
        await message.channel.send("❌ Invalid positions!")


async def _cmd_search(bot: "MusicBot", message: discord.Message, args: str) -> None:
    if not args:
        await message.channel.send("❌ Usage: `search <query>`")
        return
    player = await _ensure_voice(bot, message)
    if player is None:
        return

    status = await message.channel.send(f"🔍 Searching for `{args}`…")
    result = await player.node.load_tracks(f"ytsearch:{args}")

    if result.is_empty:
        await status.edit(content="❌ No results found!")
        return

    tracks = result.tracks[:5]
    lines = ["🔍 **Search Results — reply with `play <number>`:**"]
    for i, t in enumerate(tracks, 1):
        lines.append(f"  `{i}.` **{t.info.title}** — *{t.info.author}* `[{t.duration_str}]`")
    await status.edit(content="\n".join(lines))
