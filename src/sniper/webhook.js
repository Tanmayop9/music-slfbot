/**
 * Discord webhook notifications for the vanity sniper.
 * Sends rich embeds for: spotted, sniped (success), failed.
 */

import { createLogger } from '../logger.js';

const log = createLogger('WebhookNotifier');

function utcIso() {
  return new Date().toISOString();
}

export class WebhookNotifier {
  constructor(url) {
    this._url = url;
  }

  async notifySpotted(code, sourceGuildId) {
    await this._send({
      embeds: [{
        title: '👁️  Vanity Spotted',
        color: 0xFFAA00,
        fields: [
          { name: 'Vanity',        value: `\`discord.gg/${code}\``,   inline: true },
          { name: 'Released From', value: `\`${sourceGuildId}\``,     inline: true },
        ],
        timestamp: utcIso(),
      }],
    });
  }

  async notifySuccess(code, claimedGuildId, latencyMs, sourceGuildId = null) {
    const fields = [
      { name: 'Vanity',     value: `\`discord.gg/${code}\``,        inline: true },
      { name: 'Claimed In', value: `\`${claimedGuildId}\``,         inline: true },
      { name: 'Latency',    value: `\`${latencyMs.toFixed(1)} ms\``, inline: true },
    ];
    if (sourceGuildId) {
      fields.push({ name: 'Released From', value: `\`${sourceGuildId}\``, inline: true });
    }
    await this._send({
      embeds: [{
        title:     '✅  Vanity Sniped!',
        color:     0x00FF7F,
        fields,
        timestamp: utcIso(),
      }],
    });
  }

  async notifyFailure(code, reason, latencyMs) {
    await this._send({
      embeds: [{
        title: '❌  Snipe Failed',
        color: 0xFF4444,
        fields: [
          { name: 'Vanity',  value: `\`discord.gg/${code}\``,         inline: true },
          { name: 'Reason',  value: String(reason).slice(0, 256),     inline: true },
          { name: 'Latency', value: `\`${latencyMs.toFixed(1)} ms\``, inline: true },
        ],
        timestamp: utcIso(),
      }],
    });
  }

  async _send(payload) {
    try {
      const resp = await fetch(this._url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (resp.status !== 200 && resp.status !== 204) {
        log.warn(`[Webhook] HTTP ${resp.status}`);
      }
    } catch (err) {
      log.error(`[Webhook] send failed: ${err.message}`);
    }
  }

  async close() {}
}
