"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

// Map API route -> data file. These were previously embedded as
// <script type="application/json"> blocks inside index.html.
const DATA_FILES = {
  "rail-sections": "rail-sections.json",
  "stations": "stations.json",
  "default-trains": "default-trains.json",
  "matched-routes": "matched-routes.json",
  "matched-stops": "matched-stops.json"
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
        if (!res.headersSent) res.status(500).json({ error: "Failed to read dataset" });
      })
      .pipe(res);
  });
}

// Simple health/listing endpoint.
app.get("/api", (req, res) => {
  res.json({
    name: "n02-train-manager API",
    datasets: Object.keys(DATA_FILES).map((r) => `/api/${r}`),
    train_store: "/api/train-store"
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
      if (!res.headersSent) res.status(500).json({ error: "Failed to read train store." });
    })
    .pipe(res);
});

// Persist the store. Body must be a canonical store object. Written atomically
// (temp file + rename) so a crash mid-write cannot corrupt the saved data.
app.put("/api/train-store", express.json({ limit: "25mb" }), async (req, res) => {
  const store = req.body;
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    return res.status(400).json({ error: "Body must be a train store object." });
  }
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(store.schema_version)) {
    return res.status(400).json({ error: `schema_version must be one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}.` });
  }
  if (!Array.isArray(store.trains)) {
    return res.status(400).json({ error: "trains must be an array." });
  }
  const tmpFile = `${TRAIN_STORE_FILE}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmpFile, JSON.stringify(store, null, 2), "utf8");
    await fs.promises.rename(tmpFile, TRAIN_STORE_FILE);
    res.json({ ok: true, trains: store.trains.length });
  } catch (err) {
    console.error("Error writing train-store.json:", err);
    fs.promises.unlink(tmpFile).catch(() => {});
    res.status(500).json({ error: "Failed to save train store." });
  }
});

// Clear the saved store so the next boot falls back to built-in defaults.
app.delete("/api/train-store", async (req, res) => {
  try {
    await fs.promises.unlink(TRAIN_STORE_FILE);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ENOENT") return res.json({ ok: true, alreadyEmpty: true });
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
