"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");

function datasetEtag(stat) {
  return `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
}

// Stream filePath into an Express response with the shared teardown plumbing:
// a failure before headers went out gets a JSON 500 (`errorMessage` is the
// user-visible body, so callers pass their exact route string); after headers
// the response can only be destroyed. The close handler matters: pipe() never
// destroys the source when the client disconnects, so every aborted multi-MB
// transfer would leak one open fd for the server's lifetime.
function streamFile(res, filePath, { logger = console, logLabel, errorMessage }) {
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    logger.error(logLabel, err);
    if (!res.headersSent) {
      res.status(500).json({ error: errorMessage });
    } else {
      res.destroy();
    }
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function createFileDelivery({ logger = console } = {}) {
  const gzipBuilds = new Map();

  async function ensureGzipSidecar(filePath, sourceStat) {
    const gzPath = `${filePath}.gz`;
    const gzStat = await fs.promises.stat(gzPath).catch(() => null);
    if (gzStat && gzStat.mtimeMs >= sourceStat.mtimeMs) return gzPath;

    if (!gzipBuilds.has(filePath)) {
      const tmpPath = `${gzPath}.${process.pid}.tmp`;
      const build = pipeline(
        fs.createReadStream(filePath),
        zlib.createGzip({ level: 6 }),
        fs.createWriteStream(tmpPath),
      )
        .then(() => fs.promises.rename(tmpPath, gzPath))
        // Stamp the sidecar with the mtime of the source AS READ. If the
        // source is atomically replaced while the gzip builds (exactly what
        // the precompute/build scripts do under a running dev server), the
        // new source's mtime is >= this stamp and the next request rebuilds —
        // a wall-clock mtime would have pinned the stale sidecar forever.
        .then(() => fs.promises.utimes(gzPath, sourceStat.atime, sourceStat.mtime))
        .catch(async (err) => {
          await fs.promises.unlink(tmpPath).catch(() => {});
          throw err;
        })
        .finally(() => gzipBuilds.delete(filePath));
      gzipBuilds.set(filePath, build);
    }

    await gzipBuilds.get(filePath);
    return gzPath;
  }

  async function serveGzippable(
    req,
    res,
    filePath,
    stat,
    cacheControl,
    label,
  ) {
    const etag = datasetEtag(stat);
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("ETag", etag);
    res.setHeader("Vary", "Accept-Encoding");
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    const srcExt = path.extname(filePath).toLowerCase();
    res.type(
      {
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
      }[srcExt] || "application/json",
    );

    let streamPath = filePath;
    if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      try {
        streamPath = await ensureGzipSidecar(filePath, stat);
        res.setHeader("Content-Encoding", "gzip");
      } catch (err) {
        logger.warn(`gzip sidecar unavailable for ${label}; serving raw.`, err);
        streamPath = filePath;
      }
    }

    streamFile(res, streamPath, {
      logger,
      logLabel: `Error streaming ${label}:`,
      errorMessage: "Failed to read file",
    });
  }

  return { serveGzippable };
}

module.exports = {
  createFileDelivery,
  datasetEtag,
  streamFile,
};
