"""
VanitySniper — main orchestrator.

Wires together:
  • Multiple GatewayMonitor instances (one per account) for real-time monitoring
  • Multiple VanityClaimer instances (one per account × claim-guild) for instant claiming
  • WebhookNotifier for notifications
  • ConfigWatcher for live hot-reload of targets
  • Public command API so the music bot (or sniper.py) can control everything

Claim strategy
──────────────
When a watched vanity becomes available every claimer fires in parallel.
The first successful result wins.  Failed codes can be re-attempted.
De-duplication prevents double-claim of the same code within the same session.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Dict, List, Optional, Set

from sniper.claimer import ClaimResult, VanityClaimer
from sniper.gateway import GatewayMonitor
from sniper.watcher import ConfigWatcher
from sniper.webhook import WebhookNotifier

log = logging.getLogger(__name__)


class SniperStatus:
    """Snapshot of current sniper state (for status commands)."""

    def __init__(
        self,
        paused: bool,
        targets: Set[str],
        monitors: int,
        claimers: int,
        claimed: List[str],
    ) -> None:
        self.paused = paused
        self.targets = targets
        self.monitors = monitors
        self.claimers = claimers
        self.claimed = claimed


class VanitySniper:
    """
    Top-level sniper controller.

    Instantiate, call `start()`, and optionally call the command API
    (`add_target`, `remove_target`, `pause`, `resume`, `status`) from
    Discord command handlers.
    """

    def __init__(self, config: dict) -> None:
        self._config = config
        self._sniper_cfg: dict = config.get("sniper", {})

        self._targets: Set[str] = set(self._sniper_cfg.get("targets") or [])
        self._paused: bool = False
        self._claimed: Set[str] = set()          # codes claimed this session
        self._claim_log: List[str] = []          # human-readable log of snipes

        self._monitors: List[GatewayMonitor] = []
        self._claimers: List[VanityClaimer] = []
        self._notifier: Optional[WebhookNotifier] = None
        self._watcher: Optional[ConfigWatcher] = None

        self._running = False

    # ──────────────────────────────────────────────────────────────────────────
    # Lifecycle
    # ──────────────────────────────────────────────────────────────────────────

    async def start(self, config_path: str = "config.yaml") -> None:
        """Build all components and start monitoring."""
        self._running = True
        self._build_components(self._sniper_cfg)

        # Pre-warm all claimers concurrently
        if self._claimers:
            await asyncio.gather(
                *(c.warm_up() for c in self._claimers),
                return_exceptions=True,
            )

        # Config hot-reload
        self._watcher = ConfigWatcher(config_path, self._on_config_change)
        self._watcher.start()

        log.info(
            "[Sniper] Ready — %d target(s) | %d monitor(s) | %d claimer(s)",
            len(self._targets),
            len(self._monitors),
            len(self._claimers),
        )

    def _build_components(self, cfg: dict) -> None:
        # Webhook
        webhook_url: Optional[str] = cfg.get("webhook_url")
        if webhook_url:
            self._notifier = WebhookNotifier(webhook_url)

        # Proxy round-robin
        proxies: List[Optional[str]] = cfg.get("proxies") or [None]

        # MFA
        mfa: dict = cfg.get("mfa") or {}
        mfa_enabled: bool = bool(mfa.get("enabled"))
        mfa_totp_secret: Optional[str] = mfa.get("totp_secret") if mfa_enabled else None
        mfa_password: Optional[str] = mfa.get("password") if mfa_enabled else None

        # Accounts
        accounts: List[dict] = cfg.get("accounts") or []
        for idx, acc in enumerate(accounts):
            token: Optional[str] = acc.get("token")
            if not token:
                continue

            proxy = proxies[idx % len(proxies)]
            label = acc.get("name") or f"Account-{idx + 1}"

            # Gateway monitor
            monitor = GatewayMonitor(
                token=token,
                on_vanity_available=self._on_vanity_available,
                proxy=proxy,
                name=label,
            )
            self._monitors.append(monitor)
            asyncio.create_task(monitor.connect(), name=f"monitor-{label}")

            # Claimers — one per (account × claim_guild)
            for g in acc.get("claim_guilds") or []:
                guild_id = str(g.get("id") if isinstance(g, dict) else g)
                claimer = VanityClaimer(
                    token=token,
                    guild_id=guild_id,
                    proxy=proxy,
                    mfa_totp_secret=mfa_totp_secret,
                    mfa_password=mfa_password,
                )
                self._claimers.append(claimer)

    async def close(self) -> None:
        self._running = False
        if self._watcher:
            self._watcher.stop()
        await asyncio.gather(
            *(m.close() for m in self._monitors),
            *(c.close() for c in self._claimers),
            return_exceptions=True,
        )
        if self._notifier:
            await self._notifier.close()

    # ──────────────────────────────────────────────────────────────────────────
    # Core claim flow
    # ──────────────────────────────────────────────────────────────────────────

    async def _on_vanity_available(self, code: str, source_guild_id: str) -> None:
        # Ignore if paused
        if self._paused:
            log.debug("[Sniper] Paused — ignoring '%s'", code)
            return

        # Filter to watched targets (empty = snipe everything)
        if self._targets and code not in self._targets:
            return

        # De-duplicate within this session
        if code in self._claimed:
            return
        self._claimed.add(code)

        log.info("[Sniper] 🎯 Spotted '%s' from guild %s", code, source_guild_id)
        if self._notifier:
            asyncio.create_task(self._notifier.notify_spotted(code, source_guild_id))

        if not self._claimers:
            log.warning("[Sniper] No claimers configured — cannot claim!")
            self._claimed.discard(code)
            return

        # Fire all claimers in parallel — first success wins
        t0 = time.perf_counter()
        results: List[ClaimResult] = await asyncio.gather(
            *(c.claim(code) for c in self._claimers),
            return_exceptions=False,
        )

        winner: Optional[ClaimResult] = None
        for r in results:
            if r.success and (winner is None or r.latency_ms < winner.latency_ms):
                winner = r

        if winner:
            entry = f"discord.gg/{code} → guild {winner.guild_id} ({winner.latency_ms:.0f} ms)"
            self._claim_log.append(entry)
            log.info("[Sniper] ✅ %s", entry)
            if self._notifier:
                asyncio.create_task(
                    self._notifier.notify_success(
                        code, winner.guild_id, winner.latency_ms, source_guild_id
                    )
                )
            # Auto-leave the source guild (was monitoring it)
            if self._sniper_cfg.get("auto_leave"):
                await self._auto_leave(source_guild_id)
        else:
            total_ms = (time.perf_counter() - t0) * 1000
            first = next((r for r in results), None)
            reason = (first.error if first else None) or "unknown"
            log.warning("[Sniper] ❌ Failed to claim '%s': %s", code, reason)
            if self._notifier:
                asyncio.create_task(self._notifier.notify_failure(code, reason, total_ms))
            # Allow retry
            self._claimed.discard(code)

    async def _auto_leave(self, guild_id: str) -> None:
        """Leave a guild (source of released vanity) after a successful snipe."""
        for monitor in self._monitors:
            if guild_id not in monitor.guilds:
                continue
            try:
                import aiohttp as _aio
                async with _aio.ClientSession() as s:
                    async with s.delete(
                        f"https://discord.com/api/v10/users/@me/guilds/{guild_id}",
                        headers={"Authorization": monitor.token},
                    ) as resp:
                        if resp.status in (200, 204):
                            log.info("[Sniper] Auto-left guild %s", guild_id)
                            return
            except Exception as exc:
                log.debug("[Sniper] auto_leave error: %s", exc)

    # ──────────────────────────────────────────────────────────────────────────
    # Hot-reload
    # ──────────────────────────────────────────────────────────────────────────

    def _on_config_change(self, new_config: dict) -> None:
        new_targets = set(new_config.get("sniper", {}).get("targets") or [])
        added = new_targets - self._targets
        removed = self._targets - new_targets
        self._targets = new_targets
        if added:
            log.info("[Sniper] Hot-reload ➕ new targets: %s", added)
        if removed:
            log.info("[Sniper] Hot-reload ➖ removed targets: %s", removed)

    # ──────────────────────────────────────────────────────────────────────────
    # Public command API (used by Discord commands and sniper.py)
    # ──────────────────────────────────────────────────────────────────────────

    def add_target(self, code: str) -> bool:
        """Add a vanity code to the watch list. Returns True if newly added."""
        code = code.lower().strip()
        if code in self._targets:
            return False
        self._targets.add(code)
        return True

    def remove_target(self, code: str) -> bool:
        """Remove a vanity code. Returns True if it was present."""
        code = code.lower().strip()
        if code not in self._targets:
            return False
        self._targets.discard(code)
        self._claimed.discard(code)   # allow re-snipe if re-added later
        return True

    def pause(self) -> None:
        self._paused = True
        log.info("[Sniper] Paused")

    def resume(self) -> None:
        self._paused = False
        log.info("[Sniper] Resumed")

    def status(self) -> SniperStatus:
        return SniperStatus(
            paused=self._paused,
            targets=set(self._targets),
            monitors=len(self._monitors),
            claimers=len(self._claimers),
            claimed=list(self._claim_log),
        )

    def clear_history(self) -> None:
        self._claim_log.clear()
        self._claimed.clear()

    @property
    def targets(self) -> Set[str]:
        return set(self._targets)

    @property
    def paused(self) -> bool:
        return self._paused

    @property
    def claimer_guilds(self) -> List[str]:
        return [c.guild_id for c in self._claimers]
