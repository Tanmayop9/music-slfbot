/**
 * Combined entry point — starts the music selfbot AND the vanity sniper
 * in a single Node.js process.
 *
 * Boot order:
 *   1. Load JSON stores (guild_settings, sniper_data) — in-memory after load
 *   2. Build VanitySniper (loads persisted targets from JSON)
 *   3. Build MusicBot instance (pass ownerId, guildSettings, sniper ref)
 *   4. Start everything concurrently
 */

import { setLogFile, createLogger } from './src/logger.js';
import { JSONStore }       from './src/storage/store.js';
import { GuildSettings }   from './src/storage/guildSettings.js';
import { SniperData }      from './src/storage/sniperData.js';
import { MusicBot }        from './src/core/bot.js';
import { VanitySniper }    from './src/sniper/core.js';
import { ConsoleCLI }      from './src/cli/dashboard.js';
import { loadConfig }      from './src/config.js';

setLogFile('bot.log');
const log = createLogger('main');

async function main() {
  const config = await loadConfig();

  // ── Required fields ─────────────────────────────────────────────────────────
  const token = (config.token || '').trim();
  if (!token) {
    log.error("No token found in config — set 'token' to your Discord user token.");
    process.exit(1);
  }

  const nodeConfigs = config.lavalink?.nodes || [];
  if (!nodeConfigs.length) {
    log.error("No Lavalink nodes under 'lavalink.nodes'!");
    process.exit(1);
  }

  const ownerId = String(config.owner_id || '0');
  if (ownerId === '0') {
    log.warn('owner_id is not set in config — bot will only respond to its own messages.');
  }

  // ── Settings ─────────────────────────────────────────────────────────────────
  const s = config.settings || {};
  const defaultVolume     = Number(s.default_volume   ?? 100);
  const maxQueueSize      = Number(s.max_queue_size   ?? 500);
  const autoDisconnect    = Boolean(s.auto_disconnect ?? true);
  const disconnectTimeout = Number(s.disconnect_timeout ?? 300);
  const prefix            = config.prefix || '!';

  // ── JSON stores ───────────────────────────────────────────────────────────────
  const gsStore = new JSONStore('data/guild_settings.json');
  const snStore = new JSONStore('data/sniper.json');
  await Promise.all([gsStore.load(), snStore.load()]);

  const guildSettings = new GuildSettings(gsStore);
  const sniperData    = new SniperData(snStore);

  // ── Sniper (optional) ─────────────────────────────────────────────────────────
  let sniper = null;
  if (config.sniper) {
    sniper = new VanitySniper(config, sniperData);
  }

  // ── yt-dlp / ytdl-core settings ───────────────────────────────────────────────
  const ytdlRaw    = config.ytdl || {};
  const ytdlConfig = {
    apiKey:  (ytdlRaw.api_key  || '').trim(),
    cookies: (ytdlRaw.cookies  || '').trim(),
  };

  // ── Music bot ─────────────────────────────────────────────────────────────────
  const bot = new MusicBot({
    token,
    prefix,
    nodeConfigs,
    ownerId,
    defaultVolume,
    maxQueueSize,
    autoDisconnect,
    disconnectTimeout,
    ytdlConfig,
    guildSettings,
    sniper,
  });
  // Attach sniperData so !sniper commands can access the JSON store
  bot._sniperData = sniperData;

  // ── Console ────────────────────────────────────────────────────────────────────
  const consoleCLI = new ConsoleCLI([bot]);
  consoleCLI.start();

  // ── Start everything ───────────────────────────────────────────────────────────
  log.info(
    `Starting bot | ownerId=${ownerId !== '0' ? ownerId : 'own messages'} | sniper=${sniper ? 'enabled' : 'disabled'}`,
  );

  const tasks = [bot.startBot()];
  if (sniper) {
    tasks.push(sniper.start(config._configPath || 'config.yaml'));
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info(`${signal} — shutting down…`);
    consoleCLI.stop();
    await Promise.allSettled([
      bot.close(),
      sniper ? sniper.close() : Promise.resolve(),
    ]);
    process.exit(0);
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await Promise.allSettled(tasks);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
