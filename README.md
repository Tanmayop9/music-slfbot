# 🎵 music-slfbot

The ultimate multi-account Discord music selfbot + vanity URL sniper.  
Written in **JavaScript (Node.js)** — built for power and speed.

---

## Features

### Music Bot
| Feature | Details |
|---|---|
| Multi-token support | Run unlimited accounts in parallel |
| Lavalink HQ audio | v4 protocol, single configurable node |
| @distube/ytdl-core backup | Automatic fallback when Lavalink fails — pure JS, no compilation, ideal for Termux |
| yt-dlp backup | Secondary fallback CLI (`pip install yt-dlp`) for search + age-restricted content |
| Direct voice fallback | When no Lavalink node is reachable, streams via `client.voice.joinChannel()` + `connection.playAudio()` (official discord.js-selfbot-v13 API) |
| YouTube Data API v3 | Optional `ytdl.api_key` for higher-quality search results |
| Cookie auth | Optional `ytdl.cookies` for age-restricted / login-required tracks |
| Multi-source search | YouTube, Spotify, SoundCloud, JioSaavn, Apple Music, Deezer |
| 14 audio filters | nightcore, bassboost, 8d, lofi, earrape, chipmunk, vaporwave, karaoke, tremolo, vibrato, rotation, distortion, soft, pop |
| Queue management | skip, shuffle, loop (track/queue), clear, move, remove |
| Live CLI dashboard | Interactive terminal console for all bots |
| Volume & seek | 0–200 % volume; seek by seconds or `MM:SS` |
| Voice-channel status | Auto-updates to "🎵 Now Playing: …" |
| Persistent settings | Per-guild volume and loop mode survive restarts (JSON store) |
| Owner-only commands | Only `owner_id` can send commands |

### Vanity Sniper
| Feature | Details |
|---|---|
| Real-time monitoring | Discord gateway WebSocket — zero polling delay |
| Instant claim | `GUILD_UPDATE` / `GUILD_DELETE` triggers parallel claim attempts |
| MFA / 2FA bypass | TOTP (RFC 6238) generated inline; or password fallback |
| Parallel claim mode | Every claimer fires simultaneously; fastest win |
| Pre-warmed connections | TCP + TLS open before the race starts |
| Auto leave | Optionally leave source guild after a successful snipe |
| Webhook notifications | Rich embeds for spotted / sniped / failed events |
| Hot-reload | Edit `targets:` in `config.yaml` — no restart needed |
| Persistent history | Claim log stored in `data/sniper.json` |

---

## Requirements

- Node.js >= 18.0.0
- A running Lavalink v4 server (configured in `config.yaml`)
- Discord user token(s)

---

## Installation

```bash
git clone https://github.com/Tanmayop9/music-slfbot
cd music-slfbot
npm install
cp config.example.yaml config.yaml
# Edit config.yaml — fill in your token and owner_id
node main.js
```

### Termux (Android)

```bash
# 1. Install system packages
pkg update && pkg install nodejs python ffmpeg git

# 2. Clone & install JS deps  (opusscript + libsodium-wrappers included — no native compilation needed)
git clone https://github.com/Tanmayop9/music-slfbot
cd music-slfbot
npm install

# 3. Install yt-dlp (optional but recommended for backup search)
pip install yt-dlp

# 4. Configure
cp config.example.yaml config.yaml
nano config.yaml   # fill in token, owner_id, and optionally ytdl.api_key

# 5. Keep the session alive and start
termux-wake-lock
node main.js
```

> **Tip:** Run `termux-wake-lock` before starting to prevent Android from killing the process.

---

## Configuration (`config.yaml`)

```yaml
# YOUR Discord user ID (right-click name → Copy User ID, Dev Mode on)
owner_id: 123456789012345678

# Your Discord user account token
token: "YOUR_DISCORD_USER_TOKEN"

prefix: "!"

lavalink:
  nodes:
    - name: "Node-3"
      host: "n1.pulledtheirlife.support"
      port: 2015
      password: "2MPHosting"
      secure: false

settings:
  default_volume: 100
  max_queue_size: 500
  auto_disconnect: true
  disconnect_timeout: 300

# yt-dlp / @distube/ytdl-core backup (optional)
ytdl:
  api_key: ""    # YouTube Data API v3 key — improves search quality
  cookies: ""    # Raw YouTube Cookie header — unlocks age-restricted tracks

sniper: false     # set to false to disable; replace with a config block to enable
```

### ytdl backup explained

| Situation | What happens |
|---|---|
| Lavalink finds the track | Normal Lavalink playback |
| Lavalink returns no results | Bot tries `@distube/ytdl-core` → yt-dlp CLI to find a YouTube URL and re-feeds it to Lavalink |
| No Lavalink node reachable | Bot falls back to `client.voice.joinChannel()` + `connection.playAudio()` streaming via `@distube/ytdl-core` (official discord.js-selfbot-v13 API) |

---

## Running

```bash
# Music bot + sniper (combined)
node main.js

# Sniper only
node sniper.js
```

---

## Music Commands

> All commands are owner-only. Default prefix: `!`

| Command | Description |
|---|---|
| `!play <query\|URL>` | Play or queue a track. Supports `yt:`, `sp:`, `sc:`, `js:`, `am:`, `dz:` prefixes |
| `!pause` | Pause playback |
| `!resume` / `!r` | Resume playback |
| `!stop` | Stop and clear the queue |
| `!skip` / `!s` | Skip to the next track |
| `!queue` / `!q` | Show current queue |
| `!clear` | Clear the queue |
| `!shuffle` | Shuffle the queue |
| `!loop [track\|queue\|off]` | Cycle or set loop mode |
| `!volume <0-200>` / `!vol` | Set or show volume (persisted) |
| `!seek <sec\|MM:SS>` | Seek to position |
| `!nowplaying` / `!np` | Show now-playing card with progress bar |
| `!filter <name>` / `!f` | Apply an audio filter |
| `!filters` | List all 14 filters |
| `!clearfilter` / `!cf` | Remove active filter |
| `!remove <pos>` | Remove track at queue position |
| `!move <from> <to>` | Move track in queue |
| `!search <query>` | Search and show top 5 results |
| `!disconnect` / `!dc` | Leave voice channel |

### Source prefixes for `!play`

```
yt:query        YouTube
sp:query        Spotify
sc:query        SoundCloud
js:query        JioSaavn
am:query        Apple Music
dz:query        Deezer
```

### Audio filters

`nightcore` `bassboost` `8d` `lofi` `earrape` `chipmunk` `vaporwave`
`karaoke` `tremolo` `vibrato` `rotation` `distortion` `soft` `pop`

---

## Sniper Commands

| Command | Description |
|---|---|
| `!sniper status` | Show sniper state (targets, monitors, claimers, session count) |
| `!sniper add <code>` | Add a vanity code to the watch list (persisted) |
| `!sniper remove <code>` | Remove a vanity code (persisted) |
| `!sniper list` | List all watched vanity codes |
| `!sniper pause` | Pause the sniper |
| `!sniper resume` | Resume the sniper |
| `!sniper history [N]` | Show last N (default 10) snipes from persistent log |
| `!sniper clear` | Clear claim history |
| `!sniper guilds` | List configured claimer guilds |

---

## JSON Data Storage

All persistent data is written atomically to the `data/` folder.

| File | Contents |
|---|---|
| `data/guild_settings.json` | Per-guild volume and loop mode |
| `data/sniper.json` | Sniper watch list and full claim history |

- Reads are **O(1) in-memory** — zero disk I/O after startup.
- Writes are atomic (`write -> temp file -> rename`) — the file is never corrupt.
- The `data/` directory is git-ignored.

---

## Architecture

```
main.js                      <- combined entry point (config.yaml or config.json)
├── src/
│   ├── config.js            <- config loader (YAML / JSON)
│   ├── logger.js            <- simple logger (stdout + file)
│   ├── storage/             <- JSON persistent key-value stores
│   │   ├── store.js         <- JSONStore (atomic writes, in-memory cache)
│   │   ├── guildSettings.js <- per-guild volume / loop
│   │   └── sniperData.js    <- targets + claim history
│   ├── core/
│   │   ├── bot.js           <- discord.js-selfbot-v13 client (owner-only, voice forwarding)
│   │   └── commands.js      <- all music + sniper command handlers
│   ├── lavalink/
│   │   ├── node.js          <- Lavalink v4 WebSocket + REST
│   │   ├── pool.js          <- node pool / failover
│   │   └── models.js        <- Track, Playlist, LoadResult
│   ├── music/
│   │   ├── player.js        <- MusicPlayer (queue advancement, filters, seek)
│   │   ├── queue.js         <- Queue with loop modes
│   │   └── filters.js       <- 14 filter presets
│   ├── sniper/
│   │   ├── gateway.js       <- Discord gateway monitor (RESUME support)
│   │   ├── claimer.js       <- pre-warmed REST claimer (TOTP, proxy)
│   │   ├── core.js          <- VanitySniper orchestrator
│   │   ├── webhook.js       <- Discord webhook notifications
│   │   └── watcher.js       <- config hot-reload (yaml or json)
│   └── cli/
│       └── dashboard.js     <- interactive terminal console
└── sniper.js                <- standalone sniper entry point
```

---

## ⚠️ Disclaimer

Using selfbots (user-token bots) violates Discord's Terms of Service.  
This project is provided for **educational purposes only**.  
Use at your own risk.
