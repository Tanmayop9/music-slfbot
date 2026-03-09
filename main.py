"""
Music SelfBot entry point.
Loads config.yaml, starts one MusicBot per token, and launches the CLI dashboard.
"""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import yaml

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────
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


# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────
def load_config() -> dict:
    path = Path("config.yaml")
    if not path.exists():
        log.error(
            "config.yaml not found! "
            "Copy config.example.yaml to config.yaml and fill in your details."
        )
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────
async def main() -> None:
    config = load_config()

    tokens = config.get("tokens", [])
    if not tokens:
        log.error("No tokens found in config.yaml under 'tokens:'!")
        sys.exit(1)

    prefix = config.get("prefix", "!")
    node_configs = config.get("lavalink", {}).get("nodes", [])
    if not node_configs:
        log.error("No Lavalink nodes configured under 'lavalink.nodes:'!")
        sys.exit(1)

    settings = config.get("settings", {})
    default_volume = settings.get("default_volume", 100)
    max_queue_size = settings.get("max_queue_size", 500)
    auto_disconnect = settings.get("auto_disconnect", True)
    disconnect_timeout = settings.get("disconnect_timeout", 300)

    from core.bot import MusicBot
    from cli.dashboard import Dashboard

    bots = [
        MusicBot(
            token=token,
            prefix=prefix,
            node_configs=node_configs,
            default_volume=default_volume,
            max_queue_size=max_queue_size,
            auto_disconnect=auto_disconnect,
            disconnect_timeout=disconnect_timeout,
        )
        for token in tokens
    ]

    dashboard = Dashboard(bots)
    dashboard.start()

    log.info("Starting %d bot account(s)…", len(bots))

    try:
        await asyncio.gather(
            *(bot.start_bot() for bot in bots),
            return_exceptions=True,
        )
    except KeyboardInterrupt:
        pass
    finally:
        log.info("Shutting down…")
        await asyncio.gather(*(bot.close() for bot in bots), return_exceptions=True)
        dashboard.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutdown complete.")
