# Samsung TV Remote — Backend Server

## Overview
Express.js server that provides:
1. WebSocket remote control for Samsung TV
2. Web dashboard for TV control
3. Overseerr API proxy for the Seerr TV Tizen app
4. YouTube trailer playback via Lounge API
5. Plex app launcher

## Key Configuration
| Setting | Value |
|---------|-------|
| Server port | 3200 (env: `PORT`) |
| TV IP | 192.168.1.163 (env: `TV_IP`) |
| TV REST API | port 8001 |
| TV WebSocket | port 8002 (wss://, `rejectUnauthorized: false`) |
| TV DIAL | port 8080 |
| TV SDB | port 26101 |
| TV MAC | A0:D7:F3:6F:24:F4 |
| Overseerr | `http://latitude:5055/api/v1` |
| Overseerr API Key | `MTc3MTc5NTI2NDIyMWViMjc4YTlhLWRhOTYtNDVkNy05NjMyLWNjNjZmNTc0MWFlYQ==` |
| Plex server | 192.168.1.64:32400 (hostname: latitude) |
| Plex machine ID | `4617e339cd653e5cf5723c42c610af76af36a8ef` |
| Plex token | `_RrFssZd9VFaF_gzqnqt` (from Preferences.xml on latitude) |

## API Endpoints

### TV Control
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tv/info` | GET | TV device info |
| `/api/tv/status` | GET | WebSocket connection status |
| `/api/tv/connect` | POST | Connect WebSocket to TV |
| `/api/tv/disconnect` | POST | Disconnect WebSocket |
| `/api/tv/key` | POST | Send remote key (`{"key":"KEY_VOLUP"}`) |
| `/api/tv/key/hold` | POST | Long-press key |
| `/api/tv/text` | POST | Send text input |
| `/api/tv/apps` | GET | List installed apps |
| `/api/tv/apps/:id/launch` | POST | Launch app by ID |
| `/api/tv/browser` | POST | Open URL in TV browser |
| `/api/tv/wake` | POST | Wake-on-LAN |
| `/api/tv/now-playing` | GET | Check running/visible apps |
| `/api/tv/youtube` | POST | Play YouTube video via Lounge API |
| `/api/tv/plex` | POST | Launch Plex app |

### Overseerr Proxy (`/api/seerr/*`)
All GET endpoints use server-side response caching (5-min TTL, max 200 entries).
| Endpoint | Description |
|----------|-------------|
| `/api/seerr/discover/movies` | Popular movies |
| `/api/seerr/discover/tv` | Popular TV shows |
| `/api/seerr/discover/movies/upcoming` | Upcoming movies |
| `/api/seerr/discover/tv/upcoming` | Upcoming TV shows |
| `/api/seerr/discover/trending` | Trending content |
| `/api/seerr/discover/watchlist` | User watchlist |
| `/api/seerr/search` | Search movies/TV |
| `/api/seerr/movie/:id` | Movie details |
| `/api/seerr/tv/:id` | TV show details |
| `/api/seerr/requests` | Request list (enriched with titles/posters) |
| `/api/seerr/request/count` | Request count stats |
| `/api/seerr/request` | POST — create new request |
| `/api/seerr/genres` | Genre lists (cached at startup) |

## YouTube Lounge API (Trailer Playback)
The YouTube app on Samsung TVs does NOT support deep linking via `metaTag`, DIAL POST, or Tizen ApplicationControl. The only working approach is the **YouTube Lounge API** — the same protocol YouTube mobile uses for casting.

### Flow (`POST /api/tv/youtube`)
1. Close YouTube via REST API DELETE, wait 2s
2. Launch YouTube via REST API POST
3. Poll DIAL (`GET :8080/ws/apps/YouTube`) every 1s until `<state>running</state>` + `<screenId>` present (up to 15 attempts)
4. Get lounge token via `POST https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch` with `screen_ids`
5. Bind session AND send `setPlaylist` command in a **single request** to `POST https://www.youtube.com/api/lounge/bc/bind`
   - Must include `loungeIdToken` in both URL params and `X-YouTube-LoungeId-Token` header
   - Body: `count=1&ofs=0&req0__sc=setPlaylist&req0_videoId=VIDEO_ID&req0_currentTime=0&req0_currentIndex=-1`

**Critical**: The bind and command MUST be in one request. The session (SID) expires immediately if you try to send the command in a separate request (410 Gone).

## Plex Integration
Samsung Plex app does NOT support deep linking through any available API:
- Samsung REST API `metaTag` — ignored
- DIAL POST — ignored
- WebSocket `ed.apps.launch` DEEP_LINK — ignored
- plex.tv companion relay — returns 200 but ignored by TV client
- Plex Companion protocol — TV doesn't expose companion ports

The `/api/tv/plex` endpoint simply launches the Plex app.

## WebSocket Connection
- Uses `wss://` on port 8002 (required for 2022+ Samsung TVs)
- Token-based auth — TV shows popup on first connect, token saved to `.tv-token`
- Auto-retry on unauthorized (up to 10 attempts, 3s delay)
- Supports: `SendRemoteKey` (Click/Press/Release), `SendInputString` (base64)

## Running
```bash
# Development
node server.js

# Production (PM2)
pm2 start server.js --name samsung-tv-remote

# The server also serves the Seerr TV app at /seerr
```

## Static File Serving
- `/` — Web dashboard (`public/index.html`)
- `/seerr` — Seerr TV Tizen app (`/home/ashkan/seerr-tv/`)

## Firewall
Port 3200 must be open for LAN access from the TV:
```bash
sudo ufw allow from 192.168.0.0/16 to any port 3200 proto tcp
```
