const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const wol = require("wake_on_lan");

const app = express();
const server = http.createServer(app);

const TV_IP = process.env.TV_IP || "192.168.1.163";
const TV_PORT = 8001;
const TV_WS_PORT = 8002;
const REMOTE_NAME = Buffer.from("Ashkan Remote").toString("base64");
const PORT = process.env.PORT || 3200;
const TV_MAC = "A0:D7:F3:6F:24:F4";
const TAILSCALE_HOST = "optiplex-1.taile9c3be.ts.net";

// --- Seerr (Overseerr) Proxy ---
const SEERR_BASE = "http://latitude:5055/api/v1";
const SEERR_API_KEY = "MTc3MTc5NTI2NDIyMWViMjc4YTlhLWRhOTYtNDVkNy05NjMyLWNjNjZmNTc0MWFlYQ==";
let genreCache = { movie: [], tv: [] };

app.use(express.json());

// CORS for Seerr TV app (served from different origin during dev/TV)
app.use("/api", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Serve Seerr TV app at /seerr
app.use("/seerr", express.static("/home/ashkan/seerr-tv"));

// --- TV WebSocket Connection ---
const TOKEN_FILE = path.join(__dirname, ".tv-token");
let tvSocket = null;
let tvToken = (() => {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return null; }
})();
let connectionStatus = "disconnected";
let retryTimer = null;
let retryCount = 0;
const MAX_RETRIES = 10;

function connectToTV() {
  if (tvSocket && tvSocket.readyState === WebSocket.OPEN) return;

  connectionStatus = "connecting";

  // Use wss:// on port 8002 — required by 2022+ Samsung TVs to trigger auth popup
  let url = `wss://${TV_IP}:${TV_WS_PORT}/api/v2/channels/samsung.remote.control?name=${REMOTE_NAME}`;
  if (tvToken) url += `&token=${tvToken}`;

  console.log("Connecting to:", url);
  tvSocket = new WebSocket(url, {
    rejectUnauthorized: false,
    handshakeTimeout: 10000,
  });

  tvSocket.on("open", () => {
    console.log("WebSocket open to Samsung TV");
    connectionStatus = "connected";
  });

  tvSocket.on("message", (data) => {
    const raw = data.toString();
    console.log("TV msg:", raw.substring(0, 200));
    try {
      const msg = JSON.parse(raw);
      if (msg.data && msg.data.token) {
        tvToken = msg.data.token;
        console.log("Received TV token:", tvToken);
        try { fs.writeFileSync(TOKEN_FILE, tvToken); } catch (e) { /* ignore */ }
      }
      if (msg.event === "ms.channel.connect") {
        console.log("TV channel connected successfully");
        connectionStatus = "connected";
      }
      if (msg.event === "ms.channel.unauthorized") {
        console.log("TV requires authorization — check TV screen to allow this device");
        connectionStatus = "unauthorized";
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  tvSocket.on("close", (code, reason) => {
    console.log(`TV connection closed: code=${code} reason=${reason || 'none'}`);
    tvSocket = null;

    // Auto-retry if unauthorized (TV might show popup on next attempt)
    if (connectionStatus === "unauthorized" && retryCount < MAX_RETRIES) {
      retryCount++;
      const delay = 3000;
      console.log(`Retrying connection in ${delay / 1000}s (attempt ${retryCount}/${MAX_RETRIES})...`);
      retryTimer = setTimeout(connectToTV, delay);
    } else if (connectionStatus !== "unauthorized") {
      connectionStatus = "disconnected";
    }
  });

  tvSocket.on("error", (err) => {
    // Suppress 1005 status code errors — Samsung TVs send these after unauthorized
    if (err.message.includes("1005")) {
      console.log("TV sent status 1005 (expected after unauthorized)");
      return;
    }
    console.error("TV connection error:", err.message);
    if (connectionStatus !== "connected" && connectionStatus !== "unauthorized") {
      connectionStatus = "error";
    }
    tvSocket = null;
  });
}

function sendKey(key) {
  return new Promise((resolve, reject) => {
    if (!tvSocket || tvSocket.readyState !== WebSocket.OPEN) {
      connectToTV();
      setTimeout(() => {
        if (!tvSocket || tvSocket.readyState !== WebSocket.OPEN) {
          return reject(new Error("Not connected to TV"));
        }
        doSend();
      }, 1500);
    } else {
      doSend();
    }

    function doSend() {
      const payload = JSON.stringify({
        method: "ms.remote.control",
        params: {
          Cmd: "Click",
          DataOfCmd: key,
          Option: "false",
          TypeOfRemote: "SendRemoteKey",
        },
      });
      tvSocket.send(payload);
      resolve();
    }
  });
}

function sendText(text) {
  return new Promise((resolve, reject) => {
    if (!tvSocket || tvSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error("Not connected to TV"));
    }
    const b64 = Buffer.from(text).toString("base64");
    const payload = JSON.stringify({
      method: "ms.remote.control",
      params: {
        Cmd: b64,
        DataOfCmd: b64,
        TypeOfRemote: "SendInputString",
      },
    });
    tvSocket.send(payload);
    resolve();
  });
}

function holdKey(key, duration = 1000) {
  return new Promise((resolve, reject) => {
    if (!tvSocket || tvSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error("Not connected to TV"));
    }

    const press = JSON.stringify({
      method: "ms.remote.control",
      params: {
        Cmd: "Press",
        DataOfCmd: key,
        Option: "false",
        TypeOfRemote: "SendRemoteKey",
      },
    });

    const release = JSON.stringify({
      method: "ms.remote.control",
      params: {
        Cmd: "Release",
        DataOfCmd: key,
        Option: "false",
        TypeOfRemote: "SendRemoteKey",
      },
    });

    tvSocket.send(press);
    setTimeout(() => {
      tvSocket.send(release);
      resolve();
    }, duration);
  });
}

// --- REST API ---

// TV info
app.get("/api/tv/info", async (req, res) => {
  try {
    const resp = await fetch(`http://${TV_IP}:${TV_PORT}/api/v2/`);
    const data = await resp.json();
    data._connectionStatus = connectionStatus;
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "Cannot reach TV", details: e.message });
  }
});

// Now playing — check which app is visible/running
const KNOWN_APPS = [
  { id: "3201907018807", name: "Netflix", icon: "netflix", color: "#E50914" },
  { id: "111299001912", name: "YouTube", icon: "youtube", color: "#FF0000" },
  { id: "MCmYXNxgcu.DisneyPlus", name: "Disney+", icon: "disneyplus", color: "#113CCF" },
  { id: "3201901017640", name: "Disney+", icon: "disneyplus", color: "#113CCF" },
  { id: "3201807016597", name: "Apple TV", icon: "appletv", color: "#000000" },
  { id: "3201606009684", name: "Spotify", icon: "spotify", color: "#1DB954" },
  { id: "kIciSQlYEM.plex", name: "Plex", icon: "plex", color: "#E5A00D" },
  { id: "3201512006963", name: "Plex", icon: "plex", color: "#E5A00D" },
  { id: "3201710015037", name: "Gallery", icon: "gallery", color: "#444444" },
];

app.get("/api/tv/now-playing", async (req, res) => {
  try {
    const results = await Promise.all(
      KNOWN_APPS.map(async (app) => {
        try {
          const resp = await fetch(
            `http://${TV_IP}:${TV_PORT}/api/v2/applications/${app.id}`,
            { signal: AbortSignal.timeout(2000) }
          );
          const data = await resp.json();
          return { ...app, running: data.running, visible: data.visible, version: data.version };
        } catch {
          return { ...app, running: false, visible: false };
        }
      })
    );

    const visible = results.find((a) => a.visible);
    const running = results.filter((a) => a.running && !a.visible);

    // Dedupe by name
    const seen = new Set();
    const deduped = running.filter((a) => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });

    res.json({
      foreground: visible || null,
      background: deduped,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Connection status
app.get("/api/tv/status", (req, res) => {
  res.json({ status: connectionStatus, hasToken: !!tvToken, retryCount, maxRetries: MAX_RETRIES });
});

// Connect to TV
app.post("/api/tv/connect", (req, res) => {
  retryCount = 0;
  clearTimeout(retryTimer);
  connectToTV();
  res.json({ status: "connecting" });
});

// Disconnect from TV
app.post("/api/tv/disconnect", (req, res) => {
  clearTimeout(retryTimer);
  retryCount = MAX_RETRIES; // prevent auto-retry
  if (tvSocket) {
    tvSocket.close();
    tvSocket = null;
  }
  connectionStatus = "disconnected";
  res.json({ status: "disconnected" });
});

// Send key command
app.post("/api/tv/key", async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: "key is required" });
  try {
    await sendKey(key);
    res.json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hold key (long press)
app.post("/api/tv/key/hold", async (req, res) => {
  const { key, duration = 1000 } = req.body;
  if (!key) return res.status(400).json({ error: "key is required" });
  try {
    await holdKey(key, duration);
    res.json({ ok: true, key, duration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send text
app.post("/api/tv/text", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    await sendText(text);
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List apps
app.get("/api/tv/apps", async (req, res) => {
  try {
    const resp = await fetch(
      `http://${TV_IP}:${TV_PORT}/api/v2/applications`
    );
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    // Try via WebSocket
    if (tvSocket && tvSocket.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        method: "ms.channel.emit",
        params: {
          event: "ed.installedApp.get",
          to: "host",
        },
      });
      tvSocket.send(payload);

      const timeout = setTimeout(() => {
        res.json({ apps: [], note: "Timeout waiting for app list" });
      }, 3000);

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (
            msg.event === "ed.installedApp.get" &&
            msg.data &&
            msg.data.data
          ) {
            clearTimeout(timeout);
            tvSocket.off("message", handler);
            res.json({ apps: msg.data.data });
          }
        } catch (e) {
          // ignore
        }
      };
      tvSocket.on("message", handler);
    } else {
      res.json({ apps: [], error: "Cannot fetch apps" });
    }
  }
});

// Launch app
app.post("/api/tv/apps/:appId/launch", async (req, res) => {
  const { appId } = req.params;
  try {
    const resp = await fetch(
      `http://${TV_IP}:${TV_PORT}/api/v2/applications/${appId}`,
      { method: "POST" }
    );
    if (resp.ok) {
      res.json({ ok: true, appId });
    } else {
      // Try via key-based deep link
      if (tvSocket && tvSocket.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({
          method: "ms.channel.emit",
          params: {
            event: "ed.apps.launch",
            to: "host",
            data: {
              appId: appId,
              action_type: "DEEP_LINK",
            },
          },
        });
        tvSocket.send(payload);
        res.json({ ok: true, appId, method: "websocket" });
      } else {
        res.status(resp.status).json({ error: "Failed to launch app" });
      }
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open browser
app.post("/api/tv/browser", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    // First close the browser if it's already open
    try {
      await fetch(
        `http://${TV_IP}:${TV_PORT}/api/v2/applications/org.tizen.browser`,
        { method: "DELETE" }
      );
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      /* ignore close errors */
    }

    // Try REST API launch with metaTag
    const resp = await fetch(
      `http://${TV_IP}:${TV_PORT}/api/v2/applications/org.tizen.browser`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metaTag: url,
        }),
      }
    );

    // Also try WebSocket deep link as backup
    if (tvSocket && tvSocket.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        method: "ms.channel.emit",
        params: {
          event: "ed.apps.launch",
          to: "host",
          data: {
            appId: "org.tizen.browser",
            action_type: "DEEP_LINK",
            metaTag: url,
          },
        },
      });
      tvSocket.send(payload);
    }

    res.json({ ok: resp.ok, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Launch YouTube on TV with video ID via Lounge API
app.post("/api/tv/youtube", async (req, res) => {
  const { videoId } = req.body;
  console.log("[YouTube] Request received, videoId:", videoId);
  if (!videoId) return res.status(400).json({ error: "videoId is required" });
  try {
    // Step 1: Close YouTube if running, then relaunch
    console.log("[YouTube] Closing YouTube...");
    await fetch(`http://${TV_IP}:${TV_PORT}/api/v2/applications/111299001912`, { method: "DELETE" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    console.log("[YouTube] Launching YouTube...");
    await fetch(`http://${TV_IP}:${TV_PORT}/api/v2/applications/111299001912`, { method: "POST" }).catch(() => {});

    // Step 2: Poll DIAL until YouTube is running and has a screenId
    let screenId = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const dialResp = await fetch(`http://${TV_IP}:8080/ws/apps/YouTube`);
        const dialXml = await dialResp.text();
        const stateMatch = dialXml.match(/<state>([^<]+)<\/state>/);
        const screenIdMatch = dialXml.match(/<screenId>([^<]+)<\/screenId>/);
        console.log(`[YouTube] Poll ${i + 1}: state=${stateMatch ? stateMatch[1] : "?"}, screenId=${screenIdMatch ? "yes" : "no"}`);
        if (stateMatch && stateMatch[1] === "running" && screenIdMatch) {
          screenId = screenIdMatch[1];
          break;
        }
      } catch (e) {
        console.log(`[YouTube] Poll ${i + 1}: DIAL error`, e.message);
      }
    }
    if (!screenId) throw new Error("YouTube did not start in time");

    // Step 3: Get lounge token
    const tokenResp = await fetch("https://www.youtube.com/api/lounge/pairing/get_lounge_token_batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `screen_ids=${screenId}`,
    });
    const tokenData = await tokenResp.json();
    const loungeToken = tokenData.screens[0].loungeToken;

    // Step 4: Bind session AND send setPlaylist in one request (session expires between separate requests)
    const params = new URLSearchParams({
      device: "REMOTE_CONTROL",
      id: "seerr-tv-remote",
      name: "SeerrTV",
      app: "seerr-tv-remote",
      "mdx-version": "3",
      VER: "8",
      v: "2",
      loungeIdToken: loungeToken,
      RID: "1",
      t: "1",
    });

    const body = new URLSearchParams({
      count: "1",
      ofs: "0",
      req0__sc: "setPlaylist",
      req0_videoId: videoId,
      req0_currentTime: "0",
      req0_currentIndex: "-1",
    });

    const loungeResp = await fetch(`https://www.youtube.com/api/lounge/bc/bind?${params}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-YouTube-LoungeId-Token": loungeToken,
      },
      body: body.toString(),
    });

    const loungeText = await loungeResp.text();
    console.log("[YouTube] Lounge response status:", loungeResp.status);
    console.log("[YouTube] Lounge response contains videoId:", loungeText.includes(videoId));
    console.log("[YouTube] Lounge response snippet:", loungeText.substring(0, 300));
    const success = loungeText.includes(videoId) || loungeText.includes("playlistModified");
    res.json({ ok: success, videoId, loungeStatus: loungeResp.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Launch Plex on TV (deep linking not supported on Samsung Plex app)
app.post("/api/tv/plex", async (req, res) => {
  console.log("[Plex] Launch request received");
  try {
    const resp = await fetch(
      `http://${TV_IP}:${TV_PORT}/api/v2/applications/kIciSQlYEM.plex`,
      { method: "POST" }
    );
    if (!resp.ok) {
      const resp2 = await fetch(
        `http://${TV_IP}:${TV_PORT}/api/v2/applications/3201512006963`,
        { method: "POST" }
      );
      res.json({ ok: resp2.ok, appId: "3201512006963" });
    } else {
      res.json({ ok: true, appId: "kIciSQlYEM.plex" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Wake on LAN
app.post("/api/tv/wake", (req, res) => {
  wol.wake(TV_MAC, (err) => {
    if (err) {
      res.status(500).json({ error: "WOL failed", details: err.message });
    } else {
      res.json({ ok: true, mac: TV_MAC });
    }
  });
});

// --- Seerr Proxy Routes ---

// --- Response cache (TTL in ms) ---
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  if (entry) responseCache.delete(key);
  return null;
}

function setCache(key, data) {
  responseCache.set(key, { data, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (responseCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now - v.ts > CACHE_TTL) responseCache.delete(k);
    }
  }
}

async function seerrFetch(endpoint, options = {}) {
  const url = `${SEERR_BASE}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: { "X-Api-Key": SEERR_API_KEY, "Content-Type": "application/json", ...options.headers },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Seerr ${resp.status}: ${text.substring(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// Cached version for GET endpoints
async function seerrFetchCached(endpoint) {
  const cached = getCached(endpoint);
  if (cached) return cached;
  const data = await seerrFetch(endpoint);
  setCache(endpoint, data);
  return data;
}

// Load genre cache at startup
async function loadGenres() {
  try {
    const [movie, tv] = await Promise.all([
      seerrFetch("/genres/movie"),
      seerrFetch("/genres/tv"),
    ]);
    genreCache = { movie, tv };
    console.log(`Seerr genres cached: ${movie.length} movie, ${tv.length} tv`);
  } catch (e) {
    console.error("Failed to load Seerr genres:", e.message);
  }
}

app.get("/api/seerr/genres", (req, res) => res.json(genreCache));

app.get("/api/seerr/discover/movies", async (req, res) => {
  try {
    const { page = 1, genre } = req.query;
    let endpoint = `/discover/movies?page=${page}`;
    if (genre) endpoint += `&genre=${genre}`;
    res.json(await seerrFetchCached(endpoint));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/discover/tv", async (req, res) => {
  try {
    const { page = 1, genre } = req.query;
    let endpoint = `/discover/tv?page=${page}`;
    if (genre) endpoint += `&genre=${genre}`;
    res.json(await seerrFetchCached(endpoint));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/discover/movies/upcoming", async (req, res) => {
  try {
    res.json(await seerrFetchCached(`/discover/movies/upcoming?page=${req.query.page || 1}`));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/discover/tv/upcoming", async (req, res) => {
  try {
    res.json(await seerrFetchCached(`/discover/tv/upcoming?page=${req.query.page || 1}`));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/discover/watchlist", async (req, res) => {
  try {
    res.json(await seerrFetchCached(`/discover/watchlist?page=${req.query.page || 1}`));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/discover/trending", async (req, res) => {
  try {
    res.json(await seerrFetchCached(`/discover/trending?page=${req.query.page || 1}`));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/search", async (req, res) => {
  try {
    const { query, page = 1 } = req.query;
    if (!query) return res.status(400).json({ error: "query is required" });
    res.json(await seerrFetchCached(`/search?query=${encodeURIComponent(query)}&page=${page}`));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/movie/:tmdbId", async (req, res) => {
  try {
    res.json(await seerrFetchCached(`/movie/${req.params.tmdbId}`));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/tv/:tmdbId", async (req, res) => {
  try {
    res.json(await seerrFetchCached(`/tv/${req.params.tmdbId}`));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/requests", async (req, res) => {
  try {
    const { take = 20, skip = 0 } = req.query;
    const cacheKey = `/request?take=${take}&skip=${skip}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await seerrFetch(`/request?take=${take}&skip=${skip}&sort=added&filter=all`);
    if (data.results) {
      await Promise.all(data.results.map(async (r) => {
        if (!r.media || !r.media.tmdbId) return;
        try {
          const type = r.type === "tv" ? "tv" : "movie";
          const detail = await seerrFetchCached(`/${type}/${r.media.tmdbId}`);
          r.media.title = detail.title || detail.name || null;
          r.media.name = detail.name || detail.title || null;
          r.media.posterPath = detail.posterPath || null;
        } catch (e) { /* skip enrichment on error */ }
      }));
    }
    setCache(cacheKey, data);
    res.json(data);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/api/seerr/request/count", async (req, res) => {
  try {
    res.json(await seerrFetchCached("/request/count"));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post("/api/seerr/request", async (req, res) => {
  try {
    const { mediaType, mediaId } = req.body;
    if (!mediaType || !mediaId) return res.status(400).json({ error: "mediaType and mediaId required" });
    res.json(await seerrFetch("/request", {
      method: "POST",
      body: JSON.stringify({ mediaType, mediaId }),
    }));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// --- Start ---
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Samsung TV Remote running at http://localhost:${PORT}`);
  console.log(`TV IP: ${TV_IP}`);
  loadGenres();
  connectToTV();
});
