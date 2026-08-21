"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");

// Size + mtime: this module's answer to "which version of the file is on
// disk". The ETag and the gzip cache key are both built from it, so a source
// the browser must re-fetch is also a source this server must re-compress —
// the two cannot drift apart and disagree about what "current" means.
function statIdentity(stat) {
  return `${stat.size}-${Math.round(stat.mtimeMs)}`;
}

function datasetEtag(stat) {
  return `W/"${statIdentity(stat)}"`;
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

function createFileDelivery({ logger = console, cacheDir } = {}) {
  const gzipBuilds = new Map();

  // Name a cache entry after the source it was built from: the basename (so
  // the directory can be read by a human), a hash of the absolute path (so two
  // sources with one basename stay apart) and the size+mtime identity.
  //
  // Nothing here compares timestamps — a hit is an exact name match. That is
  // what lets a source move BACKWARDS in time and still be served correctly: a
  // .bak restored with `mv`, a `git checkout`/`git stash`, an rsync --times
  // all hand back an older mtime, and the old "gz.mtime >= source.mtime" test
  // read that as fresh and pinned the superseded copy forever.
  //
  // It also keeps the property the mtime-stamped sidecar had: the name comes
  // from the stat as READ, so a source atomically replaced while its gzip
  // builds (exactly what the precompute/build scripts do under a running dev
  // server) lands on a different name and rebuilds on the very next request.
  function cacheKeyFor(filePath, sourceStat) {
    const hash = crypto
      .createHash("sha1")
      .update(filePath)
      .digest("hex")
      .slice(0, 12);
    const base = path.basename(filePath).replace(/[^A-Za-z0-9._-]+/g, "_");
    const prefix = `${base}-${hash}-`;
    return {
      prefix,
      cachePath: path.join(cacheDir, `${prefix}${statIdentity(sourceStat)}.gz`),
    };
  }

  // Keep one live entry per source: without this, every edit in a dev session
  // would leave its compressed copy behind. Best effort — a reader that
  // already opened an entry keeps its fd, and a failure here only costs disk.
  // Only ".gz" names are touched, never another process's in-flight ".tmp".
  async function pruneSuperseded(prefix, cachePath) {
    const keep = path.basename(cachePath);
    const entries = await fs.promises.readdir(cacheDir).catch(() => []);
    await Promise.all(
      entries
        .filter(
          (name) =>
            name !== keep && name.startsWith(prefix) && name.endsWith(".gz"),
        )
        .map((name) =>
          fs.promises.unlink(path.join(cacheDir, name)).catch(() => {}),
        ),
    );
  }

  async function ensureGzipCopy(filePath, sourceStat) {
    const { cachePath, prefix } = cacheKeyFor(filePath, sourceStat);
    const hit = await fs.promises.stat(cachePath).catch(() => null);
    if (hit) return cachePath;

    if (!gzipBuilds.has(cachePath)) {
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      const build = fs.promises
        .mkdir(cacheDir, { recursive: true })
        .then(() =>
          pipeline(
            fs.createReadStream(filePath),
            zlib.createGzip({ level: 6 }),
            fs.createWriteStream(tmpPath),
          ),
        )
        .then(() => fs.promises.rename(tmpPath, cachePath))
        .then(() => pruneSuperseded(prefix, cachePath))
        .catch(async (err) => {
          await fs.promises.unlink(tmpPath).catch(() => {});
          throw err;
        })
        .finally(() => gzipBuilds.delete(cachePath));
      gzipBuilds.set(cachePath, build);
    }

    await gzipBuilds.get(cachePath);
    return cachePath;
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
        streamPath = await ensureGzipCopy(filePath, stat);
        res.setHeader("Content-Encoding", "gzip");
      } catch (err) {
        logger.warn(`gzip copy unavailable for ${label}; serving raw.`, err);
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
  statIdentity,
  streamFile,
};
