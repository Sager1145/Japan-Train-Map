"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { createFileDelivery } = require("./file-delivery");
const { createLiveEvents } = require("./live-events");
const {
  DEFAULT_SCHEMA_VERSION,
  coerceStore,
  createTrainStore,
} = require("./train-store");

const DATA_FILES = {
  "rail-sections": "rail-sections.json",
  stations: "stations.json",
  "default-trains": "default-trains.json",
  "matched-routes": "matched-routes.json",
  "matched-stops": "matched-stops.json",
  "station-readings": "station-readings.json",
};

const STATIC_GZIP_EXTS = new Set([".json", ".js", ".css"]);
const STATIC_CACHE_CONTROL = {
  ".json": "public, max-age=86400",
  ".js": "no-cache",
  ".css": "no-cache",
};

function createApp({
  dataDir = path.join(__dirname, "..", "data"),
  publicDir = path.join(__dirname, "..", "public"),
  logger = console,
  now,
  heartbeatMs,
} = {}) {
  const app = express();
  const trainStore = createTrainStore(path.join(dataDir, "train-store.json"));
  const sampleDataDir = path.join(dataDir, "sample-data");
  const newYearGrandLoopDataDir = path.join(
    dataDir,
    "new-year-grand-loop-data",
  );
  const tokyoLimitedExpressLoopDataDir = path.join(
    dataDir,
    "tokyo-limited-express-loop-data",
  );
  const { serveGzippable } = createFileDelivery({ logger });
  const liveEvents = createLiveEvents({ now, heartbeatMs });

  for (const [route, file] of Object.entries(DATA_FILES)) {
    const filePath = path.join(dataDir, file);
    app.get(`/api/${route}`, async (req, res) => {
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        return res.status(404).json({ error: `Dataset not found: ${route}` });
      }
      await serveGzippable(
        req,
        res,
        filePath,
        stat,
        "public, max-age=3600",
        file,
      );
    });
  }

  app.get("/api/sample-data/:name", async (req, res) => {
    const name = String(req.params.name || "").replace(/\.json$/, "");
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: "Invalid sample data name." });
    }

    const filePath = path.join(sampleDataDir, `${name}.json`);
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      return res
        .status(404)
        .json({ error: `Sample data file not found: ${name}` });
    }
    await serveGzippable(
      req,
      res,
      filePath,
      stat,
      "no-cache",
      `sample-data/${name}.json`,
    );
  });

  app.get("/api/new-year-grand-loop-data/:name", async (req, res) => {
    const name = String(req.params.name || "").replace(/\.json$/, "");
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: "Invalid grand-loop data name." });
    }
    const filePath = path.join(newYearGrandLoopDataDir, `${name}.json`);
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      return res
        .status(404)
        .json({ error: `Grand-loop data file not found: ${name}` });
    }
    await serveGzippable(
      req,
      res,
      filePath,
      stat,
      "no-cache",
      `new-year-grand-loop-data/${name}.json`,
    );
  });

  app.get("/api/tokyo-limited-express-loop-data/:name", async (req, res) => {
    const name = String(req.params.name || "").replace(/\.json$/, "");
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: "Invalid Tokyo loop data name." });
    }
    const filePath = path.join(tokyoLimitedExpressLoopDataDir, `${name}.json`);
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      return res
        .status(404)
        .json({ error: `Tokyo loop data file not found: ${name}` });
    }
    await serveGzippable(
      req,
      res,
      filePath,
      stat,
      "no-cache",
      `tokyo-limited-express-loop-data/${name}.json`,
    );
  });

  app.get("/api", (req, res) => {
    res.json({
      name: "n02-train-manager API",
      datasets: Object.keys(DATA_FILES).map((route) => `/api/${route}`),
      train_store: "/api/train-store",
      events: "/api/events",
      agent_import: "/api/agent/import",
      live_clients: liveEvents.clientCount,
    });
  });

  app.get("/api/events", liveEvents.handleEvents);

  app.get("/api/train-store", async (req, res) => {
    const stat = await fs.promises.stat(trainStore.filePath).catch(() => null);
    if (!stat) {
      return res.status(404).json({ error: "No saved train store yet." });
    }

    res.type("application/json");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(trainStore.filePath)
      .on("error", (err) => {
        logger.error("Error reading train-store.json:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read train store." });
        }
      })
      .pipe(res);
  });

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
        await trainStore.write(store);
        liveEvents.broadcastStoreChanged({
          origin: req.get("X-Client-Id") || null,
          source: "ui",
          trains: store.trains.length,
        });
        res.json({ ok: true, trains: store.trains.length });
      } catch (err) {
        logger.error("Error writing train-store.json:", err);
        res.status(500).json({ error: "Failed to save train store." });
      }
    },
  );

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

      try {
        if (mode === "append") {
          // The read-modify-write runs inside the store's write queue, so a
          // concurrent PUT or a second append can never interleave between
          // the read and the write (lost update).
          finalStore = await trainStore.update((existing) => {
            const base =
              existing && Array.isArray(existing.trains) ? existing.trains : [];
            const byId = new Map(
              base.map((train) => [train && train.id, train]),
            );
            added = 0;
            replaced = 0;
            for (const train of incoming.trains) {
              if (train && train.id && byId.has(train.id)) replaced++;
              else added++;
              byId.set(train && train.id, train);
            }
            return {
              schema_version: DEFAULT_SCHEMA_VERSION,
              trains: Array.from(byId.values()),
            };
          });
        } else {
          await trainStore.write(finalStore);
        }
        liveEvents.broadcastStoreChanged({
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
          live_clients: liveEvents.clientCount,
          ids: finalStore.trains
            .map((train) => train && train.id)
            .filter(Boolean),
        });
      } catch (err) {
        logger.error("Error writing train-store.json (agent import):", err);
        res.status(500).json({ error: "Failed to save train store." });
      }
    },
  );

  app.delete("/api/train-store", async (req, res) => {
    try {
      await fs.promises.unlink(trainStore.filePath);
      liveEvents.broadcastStoreChanged({
        origin: req.get("X-Client-Id") || null,
        source: "delete",
        cleared: true,
      });
      res.json({ ok: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        return res.json({ ok: true, alreadyEmpty: true });
      }
      logger.error("Error deleting train-store.json:", err);
      res.status(500).json({ error: "Failed to clear train store." });
    }
  });

  app.get(/.*/, async (req, res, next) => {
    let pathname;
    try {
      pathname = decodeURIComponent(req.path);
    } catch (err) {
      return next();
    }
    const extension = path.extname(pathname).toLowerCase();
    if (!STATIC_GZIP_EXTS.has(extension)) {
      return next();
    }

    const filePath = path.normalize(path.join(publicDir, pathname));
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
      return next();
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      return next();
    }
    if (!stat.isFile()) return next();

    await serveGzippable(
      req,
      res,
      filePath,
      stat,
      STATIC_CACHE_CONTROL[extension] || "no-cache",
      pathname,
    );
  });

  app.use(express.static(publicDir));

  return app;
}

module.exports = {
  DATA_FILES,
  createApp,
};
