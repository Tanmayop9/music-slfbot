/**
 * Node pool — manages multiple Lavalink nodes and provides best-node selection.
 */

import { LavalinkNode } from './node.js';
import { createLogger } from '../logger.js';

const log = createLogger('NodePool');

export class NodePool {
  constructor() {
    this._nodes = [];
  }

  // ── Node management ────────────────────────────────────────────────────────

  async addNode({ host, port, password, secure = false, name = 'Node', userId = 0 }) {
    const node = new LavalinkNode({ host, port, password, secure, name, userId });
    await node.connect();
    this._nodes.push(node);
    log.info(`NodePool: added node '${name}' (${host}:${port})`);
    return node;
  }

  // ── Node selection ─────────────────────────────────────────────────────────

  getBestNode() {
    const available = this._nodes.filter(n => n.available);
    if (available.length === 0) return null;

    return available.reduce((best, node) => {
      const score = (node) => {
        const s = node.stats;
        return s ? s.playingPlayers + s.cpuLavalinkLoad * 100 : 0;
      };
      return score(node) < score(best) ? node : best;
    });
  }

  getNode(name) {
    return this._nodes.find(n => n.name === name) ?? null;
  }

  // ── Properties ─────────────────────────────────────────────────────────────

  get nodes() { return [...this._nodes]; }
  get availableNodes() { return this._nodes.filter(n => n.available); }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async close() {
    for (const node of this._nodes) await node.close();
    this._nodes.length = 0;
  }
}
