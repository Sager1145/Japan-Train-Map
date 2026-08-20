// Serve the built _site directory the way GitHub Pages serves it.
//
// WHY THIS EXISTS: `npm run dev` starts the Express app server, which is a
// DIFFERENT product from what Pages publishes — it has /api/* endpoints, an SSE
// live-refresh stream and server-side autosave, and its runtime config makes
// the frontend boot with HAS_BACKEND = true. That flag changes the boot path:
// backend build loads the whole train store and solves every route in the
// browser, while the published build streams precomputed per-train parts and
// never touches the solver. Testing against `npm run dev` therefore cannot tell
// you how the deployed site behaves.
//
// This server removes the guesswork: it serves the SAME _site artifact the
// deploy workflow uploads, so local behavior is identical to production by
// construction rather than by imitation. Nothing here is allowed to be smarter
// than Pages — no API routes, no fallbacks that would mask a broken link.
//
//   node scripts/build/serve-static.mjs [--port 4000] [--dir ../_site]
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(SCRIPT_DIR, "..", "..", "..", "_site");

function readArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(readArg("--dir", process.env.STATIC_DIR || DEFAULT_DIR));
const PORT = Number(readArg("--port", process.env.PORT || 4000));

// Pages serves by extension; anything unknown goes out as octet-stream rather
// than being guessed at, so a wrong Content-Type shows up here too.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

async function resolveFile(urlPath) {
  // Strip the query/hash and decode, then contain the result inside ROOT so a
  // ../ traversal can't read outside the published tree.
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const target = path.resolve(ROOT, "." + clean);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const index = path.join(target, "index.html");
      await fs.access(index);
      return index;
    }
    return target;
  } catch (err) {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const file = await resolveFile(req.url || "/");
  if (!file) {
    // Pages answers a missing path with 404 — NOT with index.html. Keeping that
    // behavior is the point: a link that 404s in production 404s here too.
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
      // The published site is immutable per deploy; locally we always want the
      // newest build, so revalidation is forced rather than cached.
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("500 Internal Server Error");
  }
});

async function main() {
  try {
    await fs.access(path.join(ROOT, "index.html"));
  } catch (err) {
    console.error(
      `No index.html in ${ROOT}.\nBuild the site first:  npm run build:static`,
    );
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`Static site (production build) on http://localhost:${PORT}`);
    console.log(`Serving ${ROOT}`);
  });
}

main();
