# 🎵 music-slfbot

The ultimate multi-account Discord music selfbot + vanity URL sniper.  
Written in Python — built for power and speed.

---

## Features

### Music Bot
| Feature | Details |
|---|---|
| Multi-token support | Run unlimited accounts in parallel |
| Lavalink HQ audio | v4 protocol, multi-node failover (4 nodes) |
| Multi-source search | YouTube, Spotify, SoundCloud, JioSaavn, Apple Music, Deezer |
| 14 audio filters | nightcore, bassboost, 8d, lofi, earrape, chipmunk, vaporwave, karaoke, tremolo, vibrato, rotation, distortion, soft, pop |
| Queue management | skip, shuffle, loop (track/queue), clear, move, remove |
| Live CLI dashboard | Real-time Rich table of all bots and their players |
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
| Proxy support | HTTP CONNECT tunnelling per account |
| Parallel claim mode | Every claimer fires simultaneously; fastest win |
| Pre-warmed connections | TCP + TLS open before the race starts |
| Auto leave | Optionally leave source guild after a successful snipe |
| Webhook notifications | Rich embeds for spotted / sniped / failed events |
| Hot-reload | Edit `targets:` in `config.yaml` — no restart needed |
| Persistent history | Claim log stored in `data/sniper.json` |

---

## Requirements

- Python ≥ 3.11  
- A running Lavalink v4 server (public nodes provided in the example config)  
- Discord user token(s)

---

## Installation

```bash
git clone https://github.com/Tanmayop9/music-slfbot
cd music-slfbot
pip install -r requirements.txt
cp config.example.yaml config.yaml
# Edit config.yaml — fill in your tokens and owner_id
python main.py
```

---

## Configuration (`config.yaml`)

```yaml
# YOUR Discord user ID (right-click name → Copy User ID, Dev Mode on)
owner_id: 123456789012345678

# One selfbot token per line
tokens:
  - "YOUR_TOKEN_HERE"

prefix: "!"

lavalink:
  nodes:
    - name: "Node-1"
      host: "lavalink.devamop.in"
      port: 443
      password: "DevamOP"
      secure: true
    # … 3 more nodes in config.example.yaml

settings:
  default_volume: 100
  max_queue_size: 500
  auto_disconnect: true
  disconnect_timeout: 300

sniper:           # remove this entire block to disable the sniper
  accounts:
    - name: "Sniper-1"
      token: "YOUR_SNIPER_TOKEN"
      claim_guilds:
        - id: 987654321098765432
  targets: []           # empty = snipe everything; or list specific codes
  webhook_url: ""
  auto_leave: false
  proxies: []
  mfa:
    enabled: false
    totp_secret: ""     # base32 secret from authenticator app setup
    password: ""
```

---

## Running

```bash
# Music bot + sniper (combined)
python main.py

# Sniper only
python sniper.py
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

All persistent data is written atomically to the `data/` folder using **orjson** (10–20× faster than Python's stdlib `json`):

| File | Contents |
|---|---|
| `data/guild_settings.json` | Per-guild volume and loop mode |
| `data/sniper.json` | Sniper watch list and full claim history |

- Reads are **O(1) in-memory** — zero disk I/O after startup.  
- Writes are atomic (`write → temp file → os.replace`) — the file is never corrupt.  
- The `data/` directory is git-ignored.

---

## Architecture

```
main.py                    ← combined entry point
├── storage/               ← orjson-backed persistent key-value stores
│   ├── store.py           ← JSONStore (atomic writes, in-memory cache)
│   ├── guild_settings.py  ← per-guild volume / loop
│   └── sniper_data.py     ← targets + claim history
├── core/
│   ├── bot.py             ← discord.py-self client (owner-only, voice forwarding)
│   └── commands.py        ← all music + sniper command handlers
├── lavalink/
│   ├── node.py            ← Lavalink v4 WebSocket + REST (orjson)
│   ├── pool.py            ← node pool / failover
│   └── models.py          ← Track, Playlist, LoadResult
├── music/
│   ├── player.py          ← MusicPlayer (queue advancement, filters, seek)
│   ├── queue.py           ← Queue with loop modes
│   └── filters.py         ← 14 filter presets
├── sniper/
│   ├── gateway.py         ← Discord gateway monitor (orjson, RESUME support)
│   ├── claimer.py         ← pre-warmed REST claimer (TOTP, proxy)
│   ├── core.py            ← VanitySniper orchestrator
│   ├── webhook.py         ← Discord webhook notifications
│   └── watcher.py         ← config hot-reload
├── cli/
│   └── dashboard.py       ← Rich live terminal dashboard
└── sniper.py              ← standalone sniper entry point
```

---

## ⚠️ Disclaimer

Using selfbots (user-token bots) violates Discord's Terms of Service.  
This project is provided for **educational purposes only**.  
Use at your own risk.
