"""
Standalone vanity-sniper entry point.
Run:  python sniper.py
The music bot is NOT started here; for the combined experience use main.py.
"""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import yaml

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("sniper.log"),
    ],
)
log = logging.getLogger(__name__)
logging.getLogger("aiohttp").setLevel(logging.WARNING)


def _load_config() -> dict:
    path = Path("config.yaml")
    if not path.exists():
        log.error("config.yaml not found — copy config.example.yaml and fill in your details.")
        sys.exit(1)
    with open(path) as f:
        cfg = yaml.safe_load(f)
    cfg["_config_path"] = str(path)
    return cfg


async def main() -> None:
    config = _load_config()

    sniper_cfg: dict = config.get("sniper") or {}
    if not sniper_cfg.get("accounts"):
        log.error("No accounts under 'sniper.accounts' in config.yaml!")
        sys.exit(1)

    from sniper.core import VanitySniper

    sniper = VanitySniper(config)
    try:
        await sniper.start(config_path=config.get("_config_path", "config.yaml"))
        log.info("Sniper running — press Ctrl+C to stop.")
        await asyncio.Event().wait()          # run forever
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        log.info("Shutting down sniper…")
        await sniper.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutdown complete.")
