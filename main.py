"""
Combined entry point — starts the music selfbot(s) AND the vanity sniper
in a single asyncio event loop.

Boot order:
  1. Load JSON stores (guild_settings, sniper_data) — in-memory after load
  2. Build VanitySniper (loads persisted targets from JSON)
  3. Build MusicBot instances (pass owner_id, guild_settings, sniper ref)
  4. Start everything concurrently
"""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import yaml

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("bot.log"),
    ],
)
log = logging.getLogger(__name__)
logging.getLogger("discord").setLevel(logging.WARNING)
logging.getLogger("aiohttp").setLevel(logging.WARNING)


# ── Config ─────────────────────────────────────────────────────────────────────
def _load_config() -> dict:
    path = Path("config.yaml")
    if not path.exists():
        log.error(
            "config.yaml not found — copy config.example.yaml and fill in your details."
        )
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


# ── Main ───────────────────────────────────────────────────────────────────────
async def main() -> None:
    config = _load_config()

    # ── Required fields ────────────────────────────────────────────────────────
    tokens = config.get("tokens") or []
    if not tokens:
        log.error("No tokens found in config.yaml under 'tokens:'!")
        sys.exit(1)

    node_configs = config.get("lavalink", {}).get("nodes") or []
    if not node_configs:
        log.error("No Lavalink nodes under 'lavalink.nodes:'!")
        sys.exit(1)

    owner_id_raw = config.get("owner_id")
    try:
        owner_id: int = int(owner_id_raw) if owner_id_raw else 0
    except (TypeError, ValueError):
        log.error("owner_id in config.yaml must be a numeric Discord user ID (got: %r)", owner_id_raw)
        sys.exit(1)
    if not owner_id:
        log.warning(
            "owner_id is not set in config.yaml — "
            "bots will only respond to their own messages."
        )

    # ── Settings ───────────────────────────────────────────────────────────────
    s = config.get("settings") or {}
    default_volume:      int  = int(s.get("default_volume", 100))
    max_queue_size:      int  = int(s.get("max_queue_size", 500))
    auto_disconnect:     bool = bool(s.get("auto_disconnect", True))
    disconnect_timeout:  int  = int(s.get("disconnect_timeout", 300))
    prefix: str = config.get("prefix", "!")

    # ── JSON stores ────────────────────────────────────────────────────────────
    from storage.store import JSONStore
    from storage.guild_settings import GuildSettings
    from storage.sniper_data import SniperData

    gs_store = JSONStore("data/guild_settings.json")
    sn_store = JSONStore("data/sniper.json")
    await asyncio.gather(gs_store.load(), sn_store.load())

    guild_settings = GuildSettings(gs_store)
    sniper_data    = SniperData(sn_store)

    # ── Sniper (optional) ──────────────────────────────────────────────────────
    sniper = None
    if config.get("sniper"):
        from sniper.core import VanitySniper
        sniper = VanitySniper(config, sniper_data=sniper_data)

    # ── Music bots ─────────────────────────────────────────────────────────────
    from core.bot import MusicBot
    from cli.dashboard import Dashboard

    bots = []
    for token in tokens:
        bot = MusicBot(
            token=token,
            prefix=prefix,
            node_configs=node_configs,
            owner_id=owner_id,
            default_volume=default_volume,
            max_queue_size=max_queue_size,
            auto_disconnect=auto_disconnect,
            disconnect_timeout=disconnect_timeout,
            guild_settings=guild_settings,
            sniper=sniper,
        )
        # Attach sniper_data so !sniper commands can access the JSON store
        bot._sniper_data = sniper_data
        bots.append(bot)

    # ── Dashboard ──────────────────────────────────────────────────────────────
    dashboard = Dashboard(bots)
    dashboard.start()

    # ── Start everything ───────────────────────────────────────────────────────
    log.info(
        "Starting %d bot account(s) | owner_id=%s | sniper=%s",
        len(bots),
        owner_id or "own messages",
        "enabled" if sniper else "disabled",
    )

    tasks = [asyncio.create_task(bot.start_bot()) for bot in bots]
    if sniper:
        tasks.append(
            asyncio.create_task(sniper.start(config_path="config.yaml"))
        )

    try:
        await asyncio.gather(*tasks, return_exceptions=True)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        log.info("Shutting down…")
        dashboard.stop()
        cleanup = [bot.close() for bot in bots]
        if sniper:
            cleanup.append(sniper.close())
        await asyncio.gather(*cleanup, return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutdown complete.")
