"""
Discord webhook notifications for the vanity sniper.
Sends rich embeds for: spotted, sniped (success), failed.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import aiohttp

log = logging.getLogger(__name__)


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class WebhookNotifier:
    def __init__(self, url: str) -> None:
        self._url = url
        self._session: Optional[aiohttp.ClientSession] = None

    async def _session_get(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    # ──────────────────────────────────────────────────────────────────────────

    async def notify_spotted(self, code: str, source_guild_id: str) -> None:
        await self._send({
            "embeds": [{
                "title": "👁️  Vanity Spotted",
                "color": 0xFFAA00,
                "fields": [
                    {"name": "Vanity",        "value": f"`discord.gg/{code}`",   "inline": True},
                    {"name": "Released From", "value": f"`{source_guild_id}`",   "inline": True},
                ],
                "timestamp": _utc_iso(),
            }]
        })

    async def notify_success(
        self,
        code: str,
        claimed_guild_id: str,
        latency_ms: float,
        source_guild_id: Optional[str] = None,
    ) -> None:
        fields = [
            {"name": "Vanity",      "value": f"`discord.gg/{code}`",     "inline": True},
            {"name": "Claimed In",  "value": f"`{claimed_guild_id}`",     "inline": True},
            {"name": "Latency",     "value": f"`{latency_ms:.1f} ms`",    "inline": True},
        ]
        if source_guild_id:
            fields.append({"name": "Released From", "value": f"`{source_guild_id}`", "inline": True})
        await self._send({
            "embeds": [{
                "title": "✅  Vanity Sniped!",
                "color": 0x00FF7F,
                "fields": fields,
                "timestamp": _utc_iso(),
            }]
        })

    async def notify_failure(self, code: str, reason: str, latency_ms: float) -> None:
        await self._send({
            "embeds": [{
                "title": "❌  Snipe Failed",
                "color": 0xFF4444,
                "fields": [
                    {"name": "Vanity",   "value": f"`discord.gg/{code}`",  "inline": True},
                    {"name": "Reason",   "value": reason[:256],             "inline": True},
                    {"name": "Latency",  "value": f"`{latency_ms:.1f} ms`", "inline": True},
                ],
                "timestamp": _utc_iso(),
            }]
        })

    # ──────────────────────────────────────────────────────────────────────────

    async def _send(self, payload: dict) -> None:
        try:
            s = await self._session_get()
            async with s.post(self._url, json=payload) as resp:
                if resp.status not in (200, 204):
                    log.warning("[Webhook] HTTP %d", resp.status)
        except Exception as exc:
            log.error("[Webhook] send failed: %s", exc)

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
