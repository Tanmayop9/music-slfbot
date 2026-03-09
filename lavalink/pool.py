"""
Node pool — manages multiple Lavalink nodes and provides best-node selection.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from .node import LavalinkNode

log = logging.getLogger(__name__)


class NodePool:
    """Holds all Lavalink nodes for a single selfbot account."""

    def __init__(self) -> None:
        self._nodes: List[LavalinkNode] = []

    # ──────────────────────────────────────────────────────────────────────────
    # Node management
    # ──────────────────────────────────────────────────────────────────────────

    async def add_node(
        self,
        *,
        host: str,
        port: int,
        password: str,
        secure: bool = False,
        name: str = "Node",
        user_id: int = 0,
    ) -> LavalinkNode:
        node = LavalinkNode(
            host=host,
            port=port,
            password=password,
            secure=secure,
            name=name,
            user_id=user_id,
        )
        await node.connect()
        self._nodes.append(node)
        log.info("NodePool: added node '%s' (%s:%s)", name, host, port)
        return node

    # ──────────────────────────────────────────────────────────────────────────
    # Node selection
    # ──────────────────────────────────────────────────────────────────────────

    def get_best_node(self) -> Optional[LavalinkNode]:
        """Return the least-loaded available node, or None if all are down."""
        available = [n for n in self._nodes if n.available]
        if not available:
            return None

        def _score(node: LavalinkNode) -> float:
            s = node.stats
            if s:
                return s.playing_players + s.cpu_lavalink_load * 100
            return 0.0

        return min(available, key=_score)

    def get_node(self, name: str) -> Optional[LavalinkNode]:
        for node in self._nodes:
            if node.name == name:
                return node
        return None

    # ──────────────────────────────────────────────────────────────────────────
    # Properties
    # ──────────────────────────────────────────────────────────────────────────

    @property
    def nodes(self) -> List[LavalinkNode]:
        return list(self._nodes)

    @property
    def available_nodes(self) -> List[LavalinkNode]:
        return [n for n in self._nodes if n.available]

    # ──────────────────────────────────────────────────────────────────────────
    # Cleanup
    # ──────────────────────────────────────────────────────────────────────────

    async def close(self) -> None:
        for node in self._nodes:
            await node.close()
        self._nodes.clear()
