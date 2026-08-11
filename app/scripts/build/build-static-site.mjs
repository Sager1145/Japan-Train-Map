import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// The server's dataset registry is the single owner of what api/ contains.
const { DATA_FILES, PART_DATASETS } = require("../../server/datasets.js");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_DIR = path.join(SCRIPT_DIR, "..", "..");
const DEFAULT_OUTPUT_DIR = path.join(DEFAULT_APP_DIR, "..", "_site");

export const DATASET_NAMES = Object.keys(DATA_FILES);

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function copyPrecomputedDataDir(sourceDir, destinationDir) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const dataNames = new Set([
    ...(manifest.full ? [manifest.full] : []),
    ...(manifest.parts || []),
  ]);

  if (![...dataNames].every((name) => typeof name === "string" && name)) {
    throw new Error(`Invalid precomputed-data manifest at ${manifestPath}`);
  }

  await fs.mkdir(destinationDir, { recursive: true });
  await fs.copyFile(manifestPath, path.join(destinationDir, "manifest.json"));
  for (const name of dataNames) {
    await fs.copyFile(
      path.join(sourceDir, `${name}.json`),
      path.join(destinationDir, `${name}.json`),
    );
  }
}

// On Pages the API endpoints are plain files, so the ${API_BASE} fetch
// templates need a `.json` suffix. Applied to EVERY staged app*.js file:
// the templates have already migrated between app modules once (app.js →
// app-persistence.js/app-events.js during the frontend split), and rewriting
// the whole family keeps the contract immune to that drift. Returns the
// replacement count so the caller can verify the templates still exist
// SOMEWHERE in the family (a zero total would ship backend-shaped URLs that
// 404 on Pages).
function rewriteApiTemplates(source) {
  let rewritten = source;
  let count = 0;
  for (const [from, to] of [
    ["`${API_BASE}/${path}`", "`${API_BASE}/${path}.json`"],
    ["`${API_BASE}/${TRAIN_STORE_API}`", "`${API_BASE}/${TRAIN_STORE_API}.json`"],
  ]) {
    const pieces = rewritten.split(from);
    count += pieces.length - 1;
    rewritten = pieces.join(to);
  }
  return { source: rewritten, count };
}

// app.js additionally carries the HAS_BACKEND flag that gates every
// backend-only call (SSE live refresh, server autosave/clear).
function rewriteStaticApp(appSource) {
  const { source: rewritten, count } = rewriteApiTemplates(appSource);
  const flipped = rewritten
    .split("const HAS_BACKEND = true;")
    .join("const HAS_BACKEND = false;");
  if (flipped === rewritten) {
    throw new Error(
      "HAS_BACKEND flag not found in app.js — refusing to ship a static build that would 404 on /api/events",
    );
  }
  return { source: flipped, count };
}

// index.html's `?v=` tokens are hand-maintained, and the whole point of the
// app-*.js family is that its members share ONE global scope — so a browser
// that revalidates half the family and serves the other half from cache runs
// a mix that never existed. That is not theoretical: app.js's boot calls
// setRouteSolveReporter(), defined in app-route-graph.js, so a stale token on
// EITHER file is a ReferenceError during DOMContentLoaded.
//
// Deriving the token from the staged bytes removes the human step entirely:
// a file that changed gets a new URL, a file that didn't keeps its cache
// entry. Runs LAST, after the ${API_BASE}/HAS_BACKEND rewrites, so the hash
// covers exactly what ships. Local `npm start` still serves the hand-written
// tokens — that path is a hard refresh away, the deployed one is not.
async function stampScriptVersions(html, stagingDir) {
  const hashes = new Map();
  let stamped = 0;
  const pattern = /(<script\s+src="|<link\s+rel="stylesheet"\s+href=")([^"?#]+)(\?[^"]*)?"/g;
  const matches = [...html.matchAll(pattern)];
  for (const [, , asset] of matches) {
    if (hashes.has(asset) || /^[a-z]+:|^\/\//i.test(asset)) continue;
    const assetPath = path.join(stagingDir, asset);
    try {
      const bytes = await fs.readFile(assetPath);
      hashes.set(
        asset,
        createHash("sha256").update(bytes).digest("hex").slice(0, 8),
      );
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // check-source.mjs already fails the build on a missing local asset;
      // leaving the tag untouched here keeps this step non-destructive.
    }
  }
  const out = html.replace(pattern, (whole, open, asset, query) => {
    const hash = hashes.get(asset);
    if (!hash) return whole;
    stamped += 1;
    const kept = (query || "")
      .replace(/^\?/, "")
      .split("&")
      .filter((part) => part && !part.startsWith("v="));
    const search = [...kept, `v=${hash}`].join("&");
    return `${open}${asset}?${search}"`;
  });
  return { html: out, stamped };
}

export async function buildStaticSite({
  appDir = DEFAULT_APP_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  logger = console,
} = {}) {
  const publicDir = path.join(appDir, "public");
  const dataDir = path.join(appDir, "data");
  const outputParent = path.dirname(outputDir);
  const outputName = path.basename(outputDir);
  const buildId = `${process.pid}-${Date.now()}`;
  const stagingDir = path.join(outputParent, `.${outputName}.build-${buildId}`);
  const previousDir = path.join(
    outputParent,
    `.${outputName}.previous-${buildId}`,
  );
  const apiDir = path.join(stagingDir, "api");

  await fs.mkdir(outputParent, { recursive: true });
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.rm(previousDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    await fs.cp(publicDir, stagingDir, {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => !sourcePath.endsWith(".gz"),
    });
    // app-core is source-owned by shared/ because both the browser and Node
    // server consume it. Keep its historical public URL in the built artifact.
    await fs.copyFile(
      path.join(appDir, "shared", "app-core.js"),
      path.join(stagingDir, "app-core.js"),
    );

    await fs.mkdir(apiDir, { recursive: true });
    for (const name of DATASET_NAMES) {
      await fs.copyFile(
        path.join(dataDir, `${name}.json`),
        path.join(apiDir, `${name}.json`),
      );
    }

    // train-store.json is deliberately NOT published: on the static site it is
    // only the source the sample-data parts are generated from. User data lives
    // in the browser (IndexedDB); the sample is served from api/sample-data/.
    for (const dataset of PART_DATASETS) {
      const sourceDir = path.join(dataDir, dataset.dir);
      if (!(await pathExists(path.join(sourceDir, "manifest.json")))) {
        throw new Error(dataset.missingDataError);
      }
      await copyPrecomputedDataDir(sourceDir, path.join(apiDir, dataset.dir));
    }

    let apiTemplateRewrites = 0;
    for (const name of await fs.readdir(stagingDir)) {
      if (!(name.startsWith("app") && name.endsWith(".js"))) continue;
      const filePath = path.join(stagingDir, name);
      const source = await fs.readFile(filePath, "utf8");
      const { source: rewritten, count } =
        name === "app.js" ? rewriteStaticApp(source) : rewriteApiTemplates(source);
      apiTemplateRewrites += count;
      if (rewritten !== source) await fs.writeFile(filePath, rewritten);
    }
    if (apiTemplateRewrites === 0) {
      throw new Error(
        "No ${API_BASE} fetch template found in the app*.js family — refusing to ship a static build whose API URLs would 404 on Pages.",
      );
    }

    const indexPath = path.join(stagingDir, "index.html");
    const indexSource = await fs.readFile(indexPath, "utf8");
    const withStationsJson = indexSource
      .split('href="api/stations"')
      .join('href="api/stations.json"');
    const { html: hashedIndex, stamped } =
      await stampScriptVersions(withStationsJson, stagingDir);
    await fs.writeFile(indexPath, hashedIndex);
    logger.log(`Stamped ${stamped} script tags with content hashes`);

    await fs.writeFile(path.join(stagingDir, ".nojekyll"), "");

    const hadPreviousBuild = await pathExists(outputDir);
    if (hadPreviousBuild) {
      await fs.rename(outputDir, previousDir);
    }
    try {
      await fs.rename(stagingDir, outputDir);
    } catch (err) {
      if (hadPreviousBuild && (await pathExists(previousDir))) {
        await fs.rename(previousDir, outputDir).catch(() => {});
      }
      throw err;
    }
    if (hadPreviousBuild) {
      await fs.rm(previousDir, { recursive: true, force: true });
    }
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw err;
  }

  logger.log(
    `Assembled static site at ${path.relative(process.cwd(), outputDir) || "."}`,
  );
}

async function main() {
  const outputArg = process.argv[2];
  const outputDir = outputArg
    ? path.resolve(process.cwd(), outputArg)
    : DEFAULT_OUTPUT_DIR;
  await buildStaticSite({ outputDir });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(`Static site build failed: ${err.message}`);
    process.exit(1);
  });
}
