"""
Pre-warmed Discord REST claimer for ultra-low-latency vanity URL claiming.

Key design choices for speed:
  • One persistent aiohttp.TCPConnector per claimer — TCP+TLS already open.
  • DNS resolved once and cached (ttl_dns_cache=300).
  • Pre-warm GET keeps the connection alive before the race starts.
  • MFA/TOTP generated inline (<1 µs) — no subprocess or external library needed.
  • Proxy support via aiohttp's built-in HTTP-CONNECT tunnelling.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import struct
import time
from dataclasses import dataclass
from typing import Dict, Optional

import aiohttp

log = logging.getLogger(__name__)

DISCORD_API = "https://discord.com/api/v10"

# ──────────────────────────────────────────────────────────────────────────────
# TOTP (RFC 6238) — generated inline, no external libraries required
# ──────────────────────────────────────────────────────────────────────────────


def _totp(secret_b32: str, interval: int = 30) -> str:
    """Generate a 6-digit TOTP code from a base32 secret (RFC 6238 / SHA-1)."""
    try:
        key = base64.b32decode(secret_b32.upper().replace(" ", ""))
    except Exception as exc:
        raise ValueError(f"Invalid TOTP secret (must be base32): {exc}") from exc
    counter = struct.pack(">Q", int(time.time()) // interval)
    digest = hmac.new(key, counter, digestmod=hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFF_FFFF
    return str(code % 10**6).zfill(6)


# ──────────────────────────────────────────────────────────────────────────────
# Result type
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class ClaimResult:
    success: bool
    code: str
    guild_id: str
    latency_ms: float
    error: Optional[str] = None

    def __str__(self) -> str:
        status = "✅" if self.success else "❌"
        return (
            f"{status} discord.gg/{self.code}  guild={self.guild_id}"
            f"  {self.latency_ms:.1f} ms"
            + (f"  [{self.error}]" if self.error else "")
        )


# ──────────────────────────────────────────────────────────────────────────────
# Claimer
# ──────────────────────────────────────────────────────────────────────────────

_CLAIM_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "X-Super-Properties": (
        "eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRGlzY29yZCBDbGllbnQiLCJyZWxlYXNlX2NoYW5uZWwiOiJzdGFibGUifQ=="
    ),
}


class VanityClaimer:
    """
    One claimer = one Discord account × one target guild.

    Call `warm_up()` at startup to pre-open the TCP/TLS connection.
    Then call `claim(code)` as fast as possible when a vanity drops.
    """

    def __init__(
        self,
        *,
        token: str,
        guild_id: str,
        proxy: Optional[str] = None,
        mfa_totp_secret: Optional[str] = None,
        mfa_password: Optional[str] = None,
    ) -> None:
        self.token = token
        self.guild_id = str(guild_id)
        self.proxy = proxy
        self.mfa_totp_secret = mfa_totp_secret
        self.mfa_password = mfa_password

        self._url = f"{DISCORD_API}/guilds/{self.guild_id}/vanity-url"
        self._session: Optional[aiohttp.ClientSession] = None

    # ──────────────────────────────────────────────────────────────────────────
    # Lifecycle
    # ──────────────────────────────────────────────────────────────────────────

    async def warm_up(self) -> None:
        """
        Open the aiohttp session and pre-warm the TCP+TLS connection to
        discord.com by issuing a GET to the vanity-url endpoint.
        The response is discarded — we just need the socket open.
        """
        if self._session and not self._session.closed:
            return  # Already warmed

        connector = aiohttp.TCPConnector(
            limit=4,
            ttl_dns_cache=300,
            use_dns_cache=True,
            force_close=False,
            enable_cleanup_closed=True,
        )
        headers = dict(_CLAIM_HEADERS)
        headers["Authorization"] = self.token

        self._session = aiohttp.ClientSession(
            connector=connector,
            headers=headers,
        )

        try:
            kwargs: Dict = {}
            if self.proxy:
                kwargs["proxy"] = self.proxy
            async with self._session.get(self._url, **kwargs) as resp:
                await resp.read()  # drain so the socket is reused
            log.debug("[Claimer %s] Connection pre-warmed", self.guild_id)
        except Exception as exc:
            # Non-fatal: the first real claim will open the connection
            log.debug("[Claimer %s] Pre-warm GET: %s (harmless)", self.guild_id, exc)

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    # ──────────────────────────────────────────────────────────────────────────
    # Claim
    # ──────────────────────────────────────────────────────────────────────────

    async def claim(self, code: str) -> ClaimResult:
        """
        Attempt to claim `code` for this guild.
        Returns a ClaimResult regardless of outcome.
        """
        if self._session is None or self._session.closed:
            await self.warm_up()

        extra_headers: Dict[str, str] = {}
        if self.mfa_totp_secret:
            try:
                extra_headers["X-Discord-MFA-Authorization"] = _totp(self.mfa_totp_secret)
            except ValueError as exc:
                log.warning("[Claimer %s] TOTP error: %s", self.guild_id, exc)
        elif self.mfa_password:
            extra_headers["X-Discord-MFA-Authorization"] = self.mfa_password

        request_kwargs: Dict = {}
        if self.proxy:
            request_kwargs["proxy"] = self.proxy

        t0 = time.perf_counter()
        assert self._session is not None
        try:
            async with self._session.patch(
                self._url,
                json={"code": code},
                headers=extra_headers,
                **request_kwargs,
            ) as resp:
                latency_ms = (time.perf_counter() - t0) * 1000
                body: dict = await resp.json(content_type=None)

                if resp.status == 200:
                    log.info(
                        "[Claimer %s] ✅ Claimed 'discord.gg/%s' in %.1f ms",
                        self.guild_id, code, latency_ms,
                    )
                    return ClaimResult(
                        success=True,
                        code=code,
                        guild_id=self.guild_id,
                        latency_ms=latency_ms,
                    )

                error = body.get("message") or str(body)
                log.warning(
                    "[Claimer %s] ❌ HTTP %d — %s (%.1f ms)",
                    self.guild_id, resp.status, error, latency_ms,
                )
                return ClaimResult(
                    success=False,
                    code=code,
                    guild_id=self.guild_id,
                    latency_ms=latency_ms,
                    error=f"HTTP {resp.status}: {error}",
                )

        except Exception as exc:
            latency_ms = (time.perf_counter() - t0) * 1000
            log.error("[Claimer %s] Request exception: %s", self.guild_id, exc)
            return ClaimResult(
                success=False,
                code=code,
                guild_id=self.guild_id,
                latency_ms=latency_ms,
                error=str(exc),
            )
