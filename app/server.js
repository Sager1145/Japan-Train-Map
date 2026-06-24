"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// Live-refresh channel (Server-Sent Events).
// Any open frontend subscribes to /api/events. Whenever the saved store
// changes (a UI autosave PUT, or an agent import) we push a "store-changed"
// event so every open map reloads, re-solves and re-renders the routes
// automatically — no manual reload needed. Each event carries the `origin`
// client id of whoever caused the change, so that client can ignore its own
// write and avoid a needless reload / feedback loop.
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcastStoreChanged(detail = {}) {
  const payload = JSON.stringify({
    type: "store-changed",
    at: new Date().toISOString(),
    ...detail,
  });
  for (const res of sseClients) {
    try {
      res.write(`event: store-changed\ndata: ${payload}\n\n`);
    } catch (err) {
      // Best-effort: a dead socket is cleaned up by its own 'close' handler.
    }
  }
}

// Map API route -> data file. These were previously embedded as
// <script type="application/json"> blocks inside index.html.
const DATA_FILES = {
  "rail-sections": "rail-sections.json",
  stations: "stations.json",
  "default-trains": "default-trains.json",
  "matched-routes": "matched-routes.json",
  "matched-stops": "matched-stops.json",
};

// Serve each dataset from disk. Files are sent as-is (already valid JSON)
// to avoid parsing the large (~12 MB) rail-sections payload on every request.
for (const [route, file] of Object.entries(DATA_FILES)) {
  const filePath = path.join(DATA_DIR, file);
  app.get(`/api/${route}`, (req, res) => {
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Dataset not found: ${route}` });
    }
    res.type("application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    fs.createReadStream(filePath)
      .on("error", (err) => {
        console.error(`Error streaming ${file}:`, err);
        if (!res.headersSent)
          res.status(500).json({ error: "Failed to read dataset" });
      })
      .pipe(res);
  });
}

// Simple health/listing endpoint.
app.get("/api", (req, res) => {
  res.json({
    name: "n02-train-manager API",
    datasets: Object.keys(DATA_FILES).map((r) => `/api/${r}`),
    train_store: "/api/train-store",
    events: "/api/events",
    agent_import: "/api/agent/import",
    live_clients: sseClients.size,
  });
});

// SSE stream of store-change notifications. The frontend connects here once on
// boot; the server keeps the socket open and pushes a "store-changed" event on
// every write. Heartbeat comments keep proxies from closing the idle socket.
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (err) {
      /* socket gone; cleaned up below */
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Persistent train store. This is the single source of truth for the WebUI:
// the editor auto-saves here (PUT) and loads from here on every boot (GET),
// replacing the old browser-localStorage backup.
// ---------------------------------------------------------------------------
const TRAIN_STORE_FILE = path.join(DATA_DIR, "train-store.json");
// Stores are written as 1.3 (per-train `date`); 1.2 is still accepted so old
// saved stores and exports keep loading/saving without a migration step.
const ACCEPTED_SCHEMA_VERSIONS = ["1.2", "1.3"];
const DEFAULT_SCHEMA_VERSION = "1.3";

// Validate a parsed body into a canonical store object, or throw a 400-style
// error. Strict by default (must be { schema_version, trains:[...] }); when
// `lenient` is set (agent import) we also accept a bare train array or a single
// train object and wrap it, mirroring the frontend's import leniency.
function coerceStore(body, { lenient = false } = {}) {
  let store = body;
  if (lenient) {
    if (Array.isArray(body)) {
      store = { schema_version: DEFAULT_SCHEMA_VERSION, trains: body };
    } else if (
      body &&
      typeof body === "object" &&
      body.id &&
      Array.isArray(body.stops) &&
      !Array.isArray(body.trains)
    ) {
      store = { schema_version: DEFAULT_SCHEMA_VERSION, trains: [body] };
    }
  }
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new Error("Body must be a train store object.");
  }
  if (!store.schema_version && lenient) {
    store.schema_version = DEFAULT_SCHEMA_VERSION;
  }
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(store.schema_version)) {
    throw new Error(
      `schema_version must be one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }
  if (!Array.isArray(store.trains)) {
    throw new Error("trains must be an array.");
  }
  return store;
}

// Atomically write a store to disk (temp file + rename) so a crash mid-write
// cannot corrupt the saved data. Compact serialization avoids the ~3x size
// inflation pretty-printing added to every save.
async function writeTrainStore(store) {
  const tmpFile = `${TRAIN_STORE_FILE}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmpFile, JSON.stringify(store), "utf8");
    await fs.promises.rename(tmpFile, TRAIN_STORE_FILE);
  } catch (err) {
    fs.promises.unlink(tmpFile).catch(() => {});
    throw err;
  }
}

// Read + parse the saved store, or return null when nothing has been saved.
async function readTrainStore() {
  try {
    const text = await fs.promises.readFile(TRAIN_STORE_FILE, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Read the saved store. 404 (not 500) when nothing has been saved yet, so the
// frontend can cleanly fall back to its built-in defaults.
app.get("/api/train-store", (req, res) => {
  if (!fs.existsSync(TRAIN_STORE_FILE)) {
    return res.status(404).json({ error: "No saved train store yet." });
  }
  res.type("application/json");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(TRAIN_STORE_FILE)
    .on("error", (err) => {
      console.error("Error reading train-store.json:", err);
      if (!res.headersSent)
        res.status(500).json({ error: "Failed to read train store." });
    })
    .pipe(res);
});

// Persist the store. Body must be a canonical store object. Written atomically
// (temp file + rename) so a crash mid-write cannot corrupt the saved data.
app.put(
  "/api/train-store",
  express.json({ limit: "25mb" }),
  async (req, res) => {
    let store;
    try {
      store = coerceStore(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      await writeTrainStore(store);
      // Tell every other open map to reload. The originating client passes its
      // own id (X-Client-Id) so it can skip reloading what it just saved.
      broadcastStoreChanged({
        origin: req.get("X-Client-Id") || null,
        source: "ui",
        trains: store.trains.length,
      });
      res.json({ ok: true, trains: store.trains.length });
    } catch (err) {
      console.error("Error writing train-store.json:", err);
      res.status(500).json({ error: "Failed to save train store." });
    }
  },
);

// ---------------------------------------------------------------------------
// Agent import endpoint. This is the door an AI agent (e.g. Claude) uses to
// drive the app: POST a full schema_version 1.3 store and the route shows up
// on every open map automatically.
//   - default (replace): the posted store becomes the whole store.
//   - ?mode=append: posted trains are merged into the existing store; a posted
//     train whose id already exists replaces that train (upsert by id).
// On success we broadcast a store-changed event so open maps reload, re-solve
// the route geometry and render it without any manual action.
// ---------------------------------------------------------------------------
app.post(
  "/api/agent/import",
  express.json({ limit: "25mb" }),
  async (req, res) => {
    const mode = (req.query.mode || "replace").toString().toLowerCase();
    if (mode !== "replace" && mode !== "append") {
      return res
        .status(400)
        .json({ error: "mode must be 'replace' or 'append'." });
    }

    let incoming;
    try {
      incoming = coerceStore(req.body, { lenient: true });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let finalStore = incoming;
    let added = incoming.trains.length;
    let replaced = 0;

    if (mode === "append") {
      let existing;
      try {
        existing = await readTrainStore();
      } catch (err) {
        console.error("Error reading train-store.json for append:", err);
        return res
          .status(500)
          .json({ error: "Failed to read existing train store." });
      }
      const base =
        existing && Array.isArray(existing.trains) ? existing.trains : [];
      const byId = new Map(base.map((t) => [t && t.id, t]));
      added = 0;
      for (const train of incoming.trains) {
        if (train && train.id && byId.has(train.id)) replaced++;
        else added++;
        byId.set(train && train.id, train);
      }
      finalStore = {
        schema_version: DEFAULT_SCHEMA_VERSION,
        trains: Array.from(byId.values()),
      };
    }

    try {
      await writeTrainStore(finalStore);
      broadcastStoreChanged({
        origin: req.get("X-Client-Id") || null,
        source: "agent",
        mode,
        trains: finalStore.trains.length,
      });
      res.json({
        ok: true,
        mode,
        trains_total: finalStore.trains.length,
        trains_added: added,
        trains_replaced: replaced,
        live_clients: sseClients.size,
        ids: finalStore.trains.map((t) => t && t.id).filter(Boolean),
      });
    } catch (err) {
      console.error("Error writing train-store.json (agent import):", err);
      res.status(500).json({ error: "Failed to save train store." });
    }
  },
);

// Clear the saved store so the next boot falls back to built-in defaults.
app.delete("/api/train-store", async (req, res) => {
  try {
    await fs.promises.unlink(TRAIN_STORE_FILE);
    broadcastStoreChanged({
      origin: req.get("X-Client-Id") || null,
      source: "delete",
      cleared: true,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ENOENT")
      return res.json({ ok: true, alreadyEmpty: true });
    console.error("Error deleting train-store.json:", err);
    res.status(500).json({ error: "Failed to clear train store." });
  }
});

// Serve the static frontend (index.html, styles.css, app.js).
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`N02 Train Manager running at http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api`);
  console.log(`  Frontend: http://localhost:${PORT}/`);
});
