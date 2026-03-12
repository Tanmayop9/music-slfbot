/**
 * Entry point — SS Selfbot with premium system.
 *
 * Boot order:
 *   1. Load config (config.json)
 *   2. Load premium store from  data/premium.json
 *   3. Create SelfBot and start
 */

import { setLogFile, createLogger } from './src/logger.js';
import { JSONStore }    from './src/storage/store.js';
import { PremiumData } from './src/storage/premiumData.js';
import { SelfBot }     from './src/core/bot.js';
import { loadConfig }  from './src/config.js';

setLogFile('bot.log');
const log = createLogger('main');

async function main() {
  const config = loadConfig();

  // ── Required ──────────────────────────────────────────────────────────────
  const token = (config.token || '').trim();
  if (!token) {
    log.error("No token found in config — set 'token' to your Discord user token.");
    process.exit(1);
  }

  const ownerId = String(config.owner_id || '0');
  if (ownerId === '0') {
    log.warn("owner_id not set — owner commands will only work for the logged-in account.");
  }

  const prefix = (config.prefix || '!').trim();

  // ── Premium store ─────────────────────────────────────────────────────────
  const premiumStore = new JSONStore('data/premium.json');
  await premiumStore.load();
  const premiumData = new PremiumData(premiumStore);

  log.info(`Starting | ownerId=${ownerId !== '0' ? ownerId : 'self'} | prefix=${prefix}`);

  // ── Bot ───────────────────────────────────────────────────────────────────
  const bot = new SelfBot({ token, prefix, ownerId, premiumData });

  const shutdown = async (sig) => {
    log.info(`${sig} — shutting down…`);
    await bot.close();
    process.exit(0);
  };
  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await bot.startBot();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
