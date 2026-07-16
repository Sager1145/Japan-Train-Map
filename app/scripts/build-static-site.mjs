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

function rewriteStaticApp(source) {
  let rewritten = source
    .split("`${API_BASE}/${path}`")
    .join("`${API_BASE}/${path}.json`")
    .split("`${API_BASE}/${TRAIN_STORE_API}`")
    .join("`${API_BASE}/${TRAIN_STORE_API}.json`");

  const beforeBackendRewrite = rewritten;
  rewritten = rewritten
    .split("const HAS_BACKEND = true;")
    .join("const HAS_BACKEND = false;");
  if (rewritten === beforeBackendRewrite) {
    throw new Error(
      "HAS_BACKEND flag not found in app.js — refusing to ship a static build that would 404 on /api/events",
    );
  }
  return rewritten;
}

export async function buildStaticSite({
  appDir = DEFAULT_APP_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  logger = console,
} = {}) {
  const publicDir = path.join(appDir, "public");
  const dataDir = path.join(appDir, "data");
  const trainPartsDir = path.join(dataDir, "train-parts");
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

    const trainStorePath = path.join(dataDir, "train-store.json");
    if (await pathExists(trainStorePath)) {
      await fs.copyFile(trainStorePath, path.join(apiDir, "train-store.json"));
    }

    if (!(await pathExists(path.join(trainPartsDir, "manifest.json")))) {
      throw new Error(
        "Precomputed train parts are missing; run scripts/precompute-train-parts.mjs first.",
      );
    }
    await fs.cp(trainPartsDir, path.join(apiDir, "train-parts"), {
      recursive: true,
      dereference: true,
    });

    const appPath = path.join(stagingDir, "app.js");
    const appSource = await fs.readFile(appPath, "utf8");
    await fs.writeFile(appPath, rewriteStaticApp(appSource));

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
