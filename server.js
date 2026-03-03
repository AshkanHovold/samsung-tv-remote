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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
    const payload = JSON.stringify({
      method: "ms.remote.control",
      params: {
        Cmd: text,
        DataOfCmd: "base64",
        Option: "false",
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
    res.json({ ok: resp.ok, url });
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

// --- Start ---
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Samsung TV Remote running at http://localhost:${PORT}`);
  console.log(`TV IP: ${TV_IP}`);
  connectToTV();
});
