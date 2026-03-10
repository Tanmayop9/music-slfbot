/**
 * discord.js-selfbot-v13 Client subclass.
 *
 * Responsibilities:
 *   - Only process commands from the configured owner_id.
 *   - Receive Discord gateway messages (voice state / server updates).
 *   - Forward voice credentials to Lavalink so it can stream audio.
 *   - Manage per-guild MusicPlayer / DirectPlayer instances.
 *   - Fall back to the official client.voice.joinChannel() + @distube/ytdl-core
 *     path (as shown in the discord.js-selfbot-v13 PlayAudio.js example) when
 *     no Lavalink node is reachable.
 *   - Update voice-channel status with the currently-playing track.
 */

import { Client } from 'discord.js-selfbot-v13';
import { NodePool }       from '../lavalink/pool.js';
import { MusicPlayer }    from '../music/player.js';
import { DirectPlayer }   from '../ytdl/directPlayer.js';
import { LoopMode }       from '../music/queue.js';
import { handleCommand }  from './commands.js';
import { createLogger }   from '../logger.js';

// How long to wait after broadcasting OP 4 for Discord to deliver both
// VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE before retrying the forward.
const VOICE_CREDENTIAL_WAIT_MS = 600;

const log = createLogger('MusicBot');

export class MusicBot extends Client {
  /**
   * @param {object} opts
   * @param {string} opts.token
   * @param {string} opts.prefix
   * @param {object[]} opts.nodeConfigs
   * @param {string|number} [opts.ownerId]
   * @param {number} [opts.defaultVolume]
   * @param {number} [opts.maxQueueSize]
   * @param {boolean} [opts.autoDisconnect]
   * @param {number} [opts.disconnectTimeout]
   * @param {object} [opts.ytdlConfig]          yt-dlp / ytdl-core options ({ apiKey, cookies })
   * @param {import('../storage/guildSettings.js').GuildSettings} [opts.guildSettings]
   * @param {import('../sniper/core.js').VanitySniper} [opts.sniper]
   */
  constructor({
    token,
    prefix        = '!',
    nodeConfigs   = [],
    ownerId       = 0,
    defaultVolume       = 100,
    maxQueueSize        = 500,
    autoDisconnect      = true,
    disconnectTimeout   = 300,
    ytdlConfig    = {},
    guildSettings = null,
    sniper        = null,
  }) {
    super();
    this._token           = token;
    this.prefix           = prefix;
    this._nodeConfigs     = nodeConfigs;
    this.ownerId          = String(ownerId);
    this.defaultVolume    = defaultVolume;
    this.maxQueueSize     = maxQueueSize;
    this.autoDisconnect   = autoDisconnect;
    this.disconnectTimeout = disconnectTimeout;
    /** ytdl-core / yt-dlp options forwarded to fallback resolver and DirectPlayer */
    this.ytdlConfig       = ytdlConfig;
    this.guildSettings    = guildSettings;
    this.sniper           = sniper;
    this._sniperData      = null; // attached externally after construction

    this.nodePool = new NodePool();
    /** @type {Map<string, MusicPlayer|DirectPlayer>} */
    this.players  = new Map();

    // Pending voice credentials per guild until both pieces arrive (Lavalink path)
    this._pendingVoice = new Map();

    this._setupListeners();
  }

  // ── Listeners ──────────────────────────────────────────────────────────────

  _setupListeners() {
    this.on('ready', () => this._onReady());
    this.on('messageCreate', (msg) => this._onMessage(msg).catch(() => {}));
    this.on('voiceStateUpdate', (oldState, newState) => {
      this._onVoiceStateUpdate(oldState, newState).catch(() => {});
    });

    // Capture raw VOICE_SERVER_UPDATE from the gateway
    this.ws.on('VOICE_SERVER_UPDATE', (data) => {
      this._onVoiceServerUpdate(data).catch(() => {});
    });
  }

  // ── Start / ready ──────────────────────────────────────────────────────────

  async startBot() {
    const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
    let retryDelay = 5000;

    while (true) {
      try {
        await this.login(this._token);
        return; // clean shutdown

      } catch (err) {
        if (err.message?.includes('TOKEN_INVALID') || err.code === 4004) {
          log.error(`Login failed — check your token: ${err.message}`);
          return;
        }

        if (err.code && FATAL_CODES.has(err.code)) {
          log.error(`Connection closed permanently (code ${err.code}): ${err.message}`);
          return;
        }

        log.warn(`Connection lost (${err.constructor?.name || 'Error'}) — reconnecting in ${Math.round(retryDelay / 1000)}s`);
      }

      // Cleanup before retrying
      for (const [guildId, player] of this.players) {
        this.players.delete(guildId);
        player.destroy().catch(() => {});
      }
      await this.nodePool.close().catch(() => {});
      this.nodePool = new NodePool();
      this._pendingVoice.clear();

      try { await this.destroy(); } catch {}

      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 300000);
    }
  }

  async _onReady() {
    log.info(`Logged in as ${this.user.tag} (${this.user.id})`);
    await this._initNodes();
  }

  async _initNodes() {
    for (const nc of this._nodeConfigs) {
      try {
        await this.nodePool.addNode({
          host:     nc.host,
          port:     nc.port,
          password: nc.password,
          secure:   nc.secure ?? false,
          name:     nc.name   ?? 'Node',
          userId:   this.user.id,
        });
      } catch (err) {
        log.warn(`Could not add node '${nc.name ?? '?'}': ${err.message}`);
      }
    }
  }

  // ── Message handling — owner-only ──────────────────────────────────────────

  async _onMessage(message) {
    if (!this.user) return;
    const expectedId = this.ownerId !== '0' ? this.ownerId : this.user.id;
    if (message.author.id !== expectedId) return;

    // Check for per-guild prefix override
    let effectivePrefix = this.prefix;
    if (message.guild && this.guildSettings) {
      effectivePrefix = this.guildSettings.prefix(message.guild.id) || this.prefix;
    }

    if (!message.content.startsWith(effectivePrefix)) return;

    const content = message.content.slice(effectivePrefix.length);
    const spaceIdx = content.search(/\s/);
    const command = spaceIdx === -1 ? content.toLowerCase() : content.slice(0, spaceIdx).toLowerCase();
    const args    = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1).trimStart();

    try {
      await handleCommand(this, message, command, args);
    } catch (err) {
      log.error(`Command '${command}' raised: ${err.message}`);
      try {
        await message.channel.send(`❌ Unexpected error: ${err.message}`);
      } catch {}
    }
  }

  // ── Voice credential capture & forwarding to Lavalink ─────────────────────

  async _onVoiceStateUpdate(oldState, newState) {
    if (!this.user || newState.member?.id !== this.user.id) return;
    const guildId = newState.guild.id;
    const entry   = this._pendingVoice.get(guildId) || {};
    if (newState.sessionId) entry.session_id = newState.sessionId;
    this._pendingVoice.set(guildId, entry);
    await this._tryVoiceUpdate(guildId);
  }

  async _onVoiceServerUpdate(data) {
    const guildId  = data.guild_id;
    const token    = data.token;
    const endpoint = data.endpoint;
    if (!guildId || !token || !endpoint) return;

    const entry = this._pendingVoice.get(guildId) || {};
    entry.token    = token;
    entry.endpoint = endpoint;
    this._pendingVoice.set(guildId, entry);
    await this._tryVoiceUpdate(guildId);
  }

  async _tryVoiceUpdate(guildId) {
    const entry     = this._pendingVoice.get(guildId) || {};
    const sessionId = entry.session_id;
    const token     = entry.token;
    const endpoint  = entry.endpoint;
    if (!sessionId || !token || !endpoint) return;

    const player = this.players.get(guildId);
    if (!player) return;

    try {
      await player.node.sendVoiceUpdate(guildId, sessionId, token, endpoint);
      log.debug(`Voice update sent for guild ${guildId}`);
    } catch (err) {
      log.error(`sendVoiceUpdate failed for guild ${guildId}: ${err.message}`);
    }
  }

  // ── Player management ──────────────────────────────────────────────────────

  getPlayer(guildId) {
    return this.players.get(String(guildId)) ?? null;
  }

  async getOrCreatePlayer(guildId) {
    const key = String(guildId);
    let player = this.players.get(key);
    if (player) return player;

    const node = this.nodePool.getBestNode();
    if (!node) {
      log.warn(`No available Lavalink nodes for guild ${guildId}`);
      return null;
    }

    player = new MusicPlayer(key, node);
    player.queue.maxSize = this.maxQueueSize;

    // Restore saved settings
    if (this.guildSettings) {
      player.volume = this.guildSettings.volume(key);
      const savedLoop = this.guildSettings.loopMode(key);
      if (Object.values(LoopMode).includes(savedLoop)) {
        player.setLoop(savedLoop);
      }
    } else {
      player.volume = this.defaultVolume;
    }

    if (this.autoDisconnect) {
      player.onQueueEnd((gid) => this._onQueueEnd(gid));
    }

    this.players.set(key, player);
    return player;
  }

  async _onQueueEnd(guildId) {
    if (!this.autoDisconnect) return;
    log.info(`Queue empty in guild ${guildId} — disconnecting in ${this.disconnectTimeout}s`);
    await sleep(this.disconnectTimeout * 1000);
    const player = this.players.get(String(guildId));
    if (player && !player.current && player.queue.isEmpty) {
      await this.leaveVoice(guildId);
    }
  }

  // ── Voice channel helpers ──────────────────────────────────────────────────

  /**
   * Join a voice channel using the official discord.js-selfbot-v13 API
   * (client.voice.joinChannel), exactly as shown in the library's PlayAudio.js
   * example.  Always creates a DirectPlayer so @distube/ytdl-core can stream
   * audio directly — this is the primary/preferred path.
   *
   * If ytdl-core cannot resolve a track, call switchToLavalink() to tear down
   * this connection and reconnect via the Lavalink raw-OP4 path instead.
   */
  async joinVoice(channel) {
    const guild   = channel.guild;
    const guildId = String(guild.id);

    // ── Primary path: direct voice via official API + @distube/ytdl-core ──────
    try {
      const connection = await this.voice.joinChannel(channel, {
        selfMute:  false,
        selfDeaf:  true,
        selfVideo: false,
      });

      const cookies = this.ytdlConfig?.cookies || '';
      const player  = new DirectPlayer(guildId, connection, { cookies });
      player.voiceChannelId = channel.id;
      player.queue.maxSize  = this.maxQueueSize;
      player.volume         = this.defaultVolume;

      if (this.guildSettings) {
        player.volume = this.guildSettings.volume(guildId);
        const savedLoop = this.guildSettings.loopMode(guildId);
        if (Object.values(LoopMode).includes(savedLoop)) player.setLoop(savedLoop);
      }
      if (this.autoDisconnect) {
        player.onQueueEnd((gid) => this._onQueueEnd(gid));
      }

      this.players.set(guildId, player);
      log.info(`[${guildId}] Joined voice (direct / ytdl-core)`);
      return true;
    } catch (err) {
      log.error(`joinVoice (direct) failed for guild ${guildId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Switch an existing DirectPlayer session to Lavalink.
   *
   * Called by _cmdPlay / _cmdSearch when @distube/ytdl-core cannot resolve the
   * requested track and a Lavalink node is available as a fallback.
   *
   * Steps:
   *   1. Destroy the DirectPlayer (disconnects library's voice connection).
   *   2. Broadcast raw OP 4 so Lavalink can capture the new voice credentials.
   *   3. Create a MusicPlayer backed by the best available Lavalink node.
   *
   * @param {string|number} guildId
   * @param {object} channel  Discord VoiceChannel to reconnect to.
   * @returns {Promise<import('../music/player.js').MusicPlayer|null>}
   */
  async switchToLavalink(guildId, channel) {
    const key = String(guildId);

    const node = this.nodePool.getBestNode();
    if (!node) {
      log.warn(`switchToLavalink: no Lavalink node available for guild ${key}`);
      return null;
    }

    // Tear down the existing DirectPlayer / voice connection.
    const existing = this.players.get(key);
    if (existing) {
      this.players.delete(key);
      await existing.destroy().catch(() => {});
    }
    this._pendingVoice.delete(key);

    // Create a MusicPlayer (Lavalink).  Must exist BEFORE broadcasting OP 4
    // so voice credentials are captured as soon as they arrive.
    const player = await this.getOrCreatePlayer(key);
    if (!player) return null;
    player.connected      = true;
    player.voiceChannelId = channel.id;

    // Raw OP 4 broadcast — required for Lavalink credential forwarding.
    // client.voice.joinChannel() would conflict with Lavalink's session.
    this.ws.broadcast({
      op: 4,
      d: {
        guild_id:   key,
        channel_id: channel.id,
        self_mute:  false,
        self_deaf:  true,
      },
    });

    await sleep(VOICE_CREDENTIAL_WAIT_MS);
    await this._tryVoiceUpdate(key);

    log.info(`[${key}] Switched from direct to Lavalink`);
    return player;
  }

  async leaveVoice(guildId) {
    const key    = String(guildId);
    const player = this.players.get(key);

    if (player instanceof DirectPlayer) {
      // Direct path: destroy() calls connection.disconnect() internally.
      this.players.delete(key);
      await player.destroy().catch(() => {});
    } else {
      // Lavalink path: send OP 4 with channel_id null to leave.
      const guild = this.guilds.cache.get(key);
      if (guild) {
        try {
          this.ws.broadcast({
            op: 4,
            d: {
              guild_id:   key,
              channel_id: null,
              self_mute:  false,
              self_deaf:  false,
            },
          });
        } catch {}
      }
      this.players.delete(key);
      if (player) await player.destroy().catch(() => {});
    }

    this._pendingVoice.delete(key);
  }

  // ── Voice channel status updates ───────────────────────────────────────────

  async updateVoiceStatus(channelId, status) {
    try {
      await this.api.channels(channelId)['voice-status'].put({ data: { status } });
    } catch (err) {
      log.debug(`updateVoiceStatus error: ${err.message}`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async close() {
    for (const [guildId, player] of this.players) {
      this.players.delete(guildId);
      await player.destroy().catch(() => {});
    }
    await this.nodePool.close().catch(() => {});
    try { await this.destroy(); } catch {}
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
