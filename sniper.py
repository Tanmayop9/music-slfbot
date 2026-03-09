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
    """Load config from config.yaml (preferred) or config.json (Termux fallback)."""
    yaml_path = Path("config.yaml")
    json_path = Path("config.json")

    if yaml_path.exists():
        try:
            import yaml
            with open(yaml_path) as f:
                cfg = yaml.safe_load(f)
            cfg["_config_path"] = str(yaml_path)
            return cfg
        except ImportError:
            log.warning(
                "PyYAML is not installed — falling back to JSON config.\n"
                "On Termux: cp config.example.json config.json  then fill in your details."
            )

    if json_path.exists():
        import json
        with open(json_path) as f:
            cfg = json.load(f)
        cfg["_config_path"] = str(json_path)
        return cfg

    if yaml_path.exists():
        log.error(
            "config.yaml found but PyYAML is not installed.\n"
            "Install it:  pip install PyYAML\n"
            "Or on Termux use JSON config:  cp config.example.json config.json"
        )
    else:
        log.error(
            "No config file found.\n"
            "Copy config.example.yaml → config.yaml\n"
            "  (or config.example.json → config.json on Termux)\n"
            "and fill in your details."
        )
    sys.exit(1)


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
