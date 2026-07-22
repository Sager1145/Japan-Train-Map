import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_DIR = path.join(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_DIR = path.join(DEFAULT_APP_DIR, "..", "_site");

export const DATASET_NAMES = [
  "rail-sections",
  "stations",
  "default-trains",
  "matched-routes",
  "matched-stops",
  "station-readings",
];

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
// the whole family keeps the contract immune to that drift.
function rewriteApiTemplates(source) {
  return source
    .split("`${API_BASE}/${path}`")
    .join("`${API_BASE}/${path}.json`")
    .split("`${API_BASE}/${TRAIN_STORE_API}`")
    .join("`${API_BASE}/${TRAIN_STORE_API}.json`");
}

// app.js additionally carries the HAS_BACKEND flag that gates every
// backend-only call (SSE live refresh, server autosave/clear).
function rewriteStaticApp(source) {
  const rewritten = rewriteApiTemplates(source);
  const flipped = rewritten
    .split("const HAS_BACKEND = true;")
    .join("const HAS_BACKEND = false;");
  if (flipped === rewritten) {
    throw new Error(
      "HAS_BACKEND flag not found in app.js — refusing to ship a static build that would 404 on /api/events",
    );
  }
  return flipped;
}

export async function buildStaticSite({
  appDir = DEFAULT_APP_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  logger = console,
} = {}) {
  const publicDir = path.join(appDir, "public");
  const dataDir = path.join(appDir, "data");
  const sampleDataDir = path.join(dataDir, "sample-data");
  const newYearGrandLoopDataDir = path.join(
    dataDir,
    "new-year-grand-loop-data",
  );
  const tokyoLimitedExpressLoopDataDir = path.join(
    dataDir,
    "tokyo-limited-express-loop-data",
  );
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
    if (!(await pathExists(path.join(sampleDataDir, "manifest.json")))) {
      throw new Error(
        "Precomputed sample data is missing; run scripts/precompute-train-parts.mjs first.",
      );
    }
    await copyPrecomputedDataDir(
      sampleDataDir,
      path.join(apiDir, "sample-data"),
    );
    if (!(await pathExists(path.join(newYearGrandLoopDataDir, "manifest.json")))) {
      throw new Error(
        "Precomputed New Year grand-loop data is missing; run npm run precompute:new-year-grand-loop first.",
      );
    }
    await copyPrecomputedDataDir(
      newYearGrandLoopDataDir,
      path.join(apiDir, "new-year-grand-loop-data"),
    );
    if (
      !(await pathExists(
        path.join(tokyoLimitedExpressLoopDataDir, "manifest.json"),
      ))
    ) {
      throw new Error(
        "Precomputed Tokyo limited-express loop data is missing; run npm run precompute:tokyo-limited-express-loop first.",
      );
    }
    await copyPrecomputedDataDir(
      tokyoLimitedExpressLoopDataDir,
      path.join(apiDir, "tokyo-limited-express-loop-data"),
    );

    for (const name of await fs.readdir(stagingDir)) {
      if (!(name.startsWith("app") && name.endsWith(".js"))) continue;
      const filePath = path.join(stagingDir, name);
      const source = await fs.readFile(filePath, "utf8");
      const rewritten =
        name === "app.js" ? rewriteStaticApp(source) : rewriteApiTemplates(source);
      if (rewritten !== source) await fs.writeFile(filePath, rewritten);
    }

    const indexPath = path.join(stagingDir, "index.html");
    const indexSource = await fs.readFile(indexPath, "utf8");
    await fs.writeFile(
      indexPath,
      indexSource
        .split('href="api/stations"')
        .join('href="api/stations.json"'),
    );

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
