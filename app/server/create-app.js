"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { DATA_FILES, PART_DATASETS } = require("./datasets");
const { createFileDelivery, streamFile } = require("./file-delivery");
const { createLiveEvents } = require("./live-events");
const {
  DEFAULT_SCHEMA_VERSION,
  coerceStore,
  createTrainStore,
} = require("./train-store");
const { countrySuffixed } = require("../public/app-core.js");

// Countries the server hosts a train store for (the frontend's
// SUPPORTED_COUNTRIES mirrors this list in app-config.js).
const STORE_COUNTRIES = ["jp", "tw", "hk", "mo"];

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
  // One fully separate store per country, named by the shared rule in
  // app-core.js (Japan keeps its historical unsuffixed file and endpoint).
  // The frontend targets one store at a time via its TRAIN_STORE_API binding.
  const trainStores = {};
  const AGENT_IMPORT_COUNTRY_STORES = {};
  for (const country of STORE_COUNTRIES) {
    const name = countrySuffixed("train-store", country);
    const store = createTrainStore(path.join(dataDir, `${name}.json`));
    trainStores[name] = store;
    AGENT_IMPORT_COUNTRY_STORES[country] = store;
  }
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

  for (const dataset of PART_DATASETS) {
    const datasetDir = path.join(dataDir, dataset.dir);
    app.get(`/api/${dataset.dir}/:name`, async (req, res) => {
      const name = String(req.params.name || "").replace(/\.json$/, "");
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        return res.status(400).json({ error: dataset.invalidNameError });
      }
      const filePath = path.join(datasetDir, `${name}.json`);
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        return res
          .status(404)
          .json({ error: `${dataset.notFoundLabel} file not found: ${name}` });
      }
      await serveGzippable(
        req,
        res,
        filePath,
        stat,
        "no-cache",
        `${dataset.dir}/${name}.json`,
      );
    });
  }

  app.get("/api", (req, res) => {
    res.json({
      name: "n02-train-manager API",
      datasets: Object.keys(DATA_FILES).map((route) => `/api/${route}`),
      train_store: "/api/train-store",
      train_stores: Object.keys(trainStores).map((name) => `/api/${name}`),
      events: "/api/events",
      agent_import: "/api/agent/import?country=jp|tw|hk|mo",
      live_clients: liveEvents.clientCount,
    });
  });

  app.get("/api/events", liveEvents.handleEvents);

  for (const [storeName, store] of Object.entries(trainStores)) {
    const fileLabel = path.basename(store.filePath);

    app.get(`/api/${storeName}`, async (req, res) => {
      const stat = await fs.promises.stat(store.filePath).catch(() => null);
      if (!stat) {
        return res.status(404).json({ error: "No saved train store yet." });
      }

      // Deliberately NOT serveGzippable: user data must never be cached (no
      // ETag, no-store) and never gets a .gz sidecar written next to it.
      res.type("application/json");
      res.setHeader("Cache-Control", "no-store");
      streamFile(res, store.filePath, {
        logger,
        logLabel: `Error reading ${fileLabel}:`,
        errorMessage: "Failed to read train store.",
      });
    });

    app.put(
      `/api/${storeName}`,
      express.json({ limit: "25mb" }),
      async (req, res) => {
        let incoming;
        try {
          incoming = coerceStore(req.body);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }

        try {
          await store.write(incoming);
          liveEvents.broadcastStoreChanged({
            origin: req.get("X-Client-Id") || null,
            source: "ui",
            store: storeName,
            trains: incoming.trains.length,
          });
          res.json({ ok: true, trains: incoming.trains.length });
        } catch (err) {
          logger.error(`Error writing ${fileLabel}:`, err);
          res.status(500).json({ error: "Failed to save train store." });
        }
      },
    );

    app.delete(`/api/${storeName}`, async (req, res) => {
      try {
        const { existed } = await store.remove();
        if (existed) {
          liveEvents.broadcastStoreChanged({
            origin: req.get("X-Client-Id") || null,
            source: "delete",
            store: storeName,
            cleared: true,
          });
        }
        res.json(existed ? { ok: true } : { ok: true, alreadyEmpty: true });
      } catch (err) {
        logger.error(`Error deleting ${fileLabel}:`, err);
        res.status(500).json({ error: "Failed to clear train store." });
      }
    });
  }

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
      const country = (req.query.country || "jp").toString().toLowerCase();
      const agentStore = AGENT_IMPORT_COUNTRY_STORES[country];
      if (!agentStore) {
        return res.status(400).json({
          error: `country must be one of: ${Object.keys(
            AGENT_IMPORT_COUNTRY_STORES,
          ).join(", ")}.`,
        });
      }
      const agentStoreName = countrySuffixed("train-store", country);

      let incoming;
      try {
        incoming = coerceStore(req.body, {
          lenient: true,
          // Append is deliberately an upsert: repeated ids, whether already
          // stored or repeated in one incoming batch, resolve last-one-wins.
          // Replace must remain a canonical store and therefore rejects them.
          allowDuplicateIds: mode === "append",
        });
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
          finalStore = await agentStore.update((existing) => {
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
          await agentStore.write(finalStore);
        }
        liveEvents.broadcastStoreChanged({
          origin: req.get("X-Client-Id") || null,
          source: "agent",
          mode,
          store: agentStoreName,
          trains: finalStore.trains.length,
        });
        res.json({
          ok: true,
          mode,
          country,
          trains_total: finalStore.trains.length,
          trains_added: added,
          trains_replaced: replaced,
          live_clients: liveEvents.clientCount,
          ids: finalStore.trains
            .map((train) => train && train.id)
            .filter(Boolean),
        });
      } catch (err) {
        if (err instanceof SyntaxError) {
          // The append's read-modify-write choked on the stored file, not on
          // this request — surface that instead of a misleading save failure.
          logger.error("Stored train-store.json is not valid JSON:", err);
          return res.status(500).json({
            error:
              "Stored train-store.json is not valid JSON; fix or clear it before appending.",
          });
        }
        logger.error("Error writing train-store.json (agent import):", err);
        res.status(500).json({ error: "Failed to save train store." });
      }
    },
  );

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

  // Shape body-parser failures as JSON like every other 4xx in this API.
  // Without this, Express's default handler returns an HTML page with a full
  // stack trace (NODE_ENV is usually unset in dev), which breaks any client
  // that parses error bodies as JSON and leaks absolute filesystem paths.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body is not valid JSON." });
    }
    if (err && err.type === "entity.too.large") {
      return res
        .status(413)
        .json({ error: "Request body exceeds the 25 MB limit." });
    }
    logger.error("Unhandled request error:", err);
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

module.exports = {
  DATA_FILES,
  createApp,
};
