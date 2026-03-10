/**
 * Standalone vanity-sniper entry point.
 * Run:  node sniper.js
 * The music bot is NOT started here; for the combined experience use main.js.
 */

import { setLogFile, createLogger } from './src/logger.js';
import { JSONStore }    from './src/storage/store.js';
import { SniperData }  from './src/storage/sniperData.js';
import { VanitySniper } from './src/sniper/core.js';
import { loadConfig }  from './src/config.js';

setLogFile('sniper.log');
const log = createLogger('sniper');

async function main() {
  const config = await loadConfig();

  const sniperCfg = config.sniper || {};
  if (!sniperCfg.accounts?.length) {
    log.error("No accounts under 'sniper.accounts' in config.yaml!");
    process.exit(1);
  }

  const snStore   = new JSONStore('data/sniper.json');
  await snStore.load();
  const sniperData = new SniperData(snStore);

  const sniper = new VanitySniper(config, sniperData);

  const shutdown = async (signal) => {
    log.info(`${signal} — shutting down sniper…`);
    await sniper.close();
    process.exit(0);
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await sniper.start(config._configPath || 'config.yaml');
  log.info('Sniper running — press Ctrl+C to stop.');

  // Run forever
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
