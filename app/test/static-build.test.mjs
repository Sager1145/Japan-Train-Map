import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DATASET_NAMES,
  buildStaticSite,
} from "../scripts/build/build-static-site.mjs";

const require = createRequire(import.meta.url);
const { PART_DATASETS } = require("../server/datasets.js");

async function createFixture({ includeTrainStore = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "train-map-build-"));
  const appDir = path.join(root, "app");
  const publicDir = path.join(appDir, "public");
  const sharedDir = path.join(appDir, "shared");
  const stylesDir = path.join(publicDir, "styles");
  const dataDir = path.join(appDir, "data");
  const partsDir = path.join(dataDir, "sample-data");
  const outputDir = path.join(root, "_site");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(stylesDir, { recursive: true });
  await fs.mkdir(partsDir, { recursive: true });

  await fs.writeFile(
    path.join(publicDir, "app.js"),
    [
      "const HAS_BACKEND = true;",
      "fetch(`${API_BASE}/${path}`);",
      "fetch(`${API_BASE}/${TRAIN_STORE_API}`);",
    ].join("\n"),
  );
  // The API templates live in several files of the app*.js family; every one
  // of them must get the .json rewrite. Non-app scripts must stay untouched.
  await fs.writeFile(
    path.join(publicDir, "app-persistence.js"),
    "fetch(`${API_BASE}/${TRAIN_STORE_API}`);\n",
  );
  await fs.writeFile(
    path.join(publicDir, "railmap.js"),
    "// not part of the app family: `${API_BASE}/${path}` stays as-is\n",
  );
  await fs.writeFile(
    path.join(publicDir, "index.html"),
    '<link rel="preload" href="api/stations">',
  );
  await fs.writeFile(path.join(stylesDir, "device-layout.css"), "body {}\n");
  await fs.writeFile(path.join(stylesDir, "device-layout.css.gz"), "ignored");
  await fs.writeFile(
    path.join(sharedDir, "app-core.js"),
    "globalThis.AppCore = { fixture: true };\n",
  );

  for (const name of DATASET_NAMES) {
    await fs.writeFile(
      path.join(dataDir, `${name}.json`),
      JSON.stringify({ name }),
    );
  }
  if (includeTrainStore) {
    await fs.writeFile(
      path.join(dataDir, "train-store.json"),
      JSON.stringify({ schema_version: "1.3", trains: [] }),
    );
  }
  await fs.writeFile(
    path.join(partsDir, "manifest.json"),
    JSON.stringify({
      format: 1,
      total: 1,
      parts: ["part-000"],
      dates: { "2026-07-03": ["part-000"] },
    }),
  );
  await fs.writeFile(path.join(partsDir, "part-000.json.gz"), "ignored");
  await fs.writeFile(path.join(partsDir, "part-000 2.json"), "stray copy");
  await fs.writeFile(
    path.join(partsDir, "part-000.json"),
    JSON.stringify({ format: 1, train: {}, route: null }),
  );
  // Every other part dataset (Taiwan sample + special loops) needs only a
  // minimal manifest + part pair. Iterate the server's own PART_DATASETS
  // list so a dataset added there is exercised here automatically — only
  // sample-data keeps the hand-built fixture above for its negative-space
  // checks (.gz sidecar, stray copy).
  for (const { dir } of PART_DATASETS) {
    if (dir === "sample-data") continue;
    const partDir = path.join(dataDir, dir);
    await fs.mkdir(partDir, { recursive: true });
    await fs.writeFile(
      path.join(partDir, "manifest.json"),
      JSON.stringify({ format: 1, total: 1, parts: ["part-000"] }),
    );
    await fs.writeFile(
      path.join(partDir, "part-000.json"),
      JSON.stringify({ format: 1, train: { id: dir }, route: null }),
    );
  }

  return { root, appDir, outputDir };
}

test("static build preserves the Pages file and rewrite contract", async () => {
  const fixture = await createFixture();
  try {
    await buildStaticSite({
      appDir: fixture.appDir,
      outputDir: fixture.outputDir,
      logger: { log() {} },
    });

    const app = await fs.readFile(
      path.join(fixture.outputDir, "app.js"),
      "utf8",
    );
    assert.match(app, /const HAS_BACKEND = false;/);
    assert.match(app, /`\$\{API_BASE\}\/\$\{path\}\.json`/);
    assert.match(app, /`\$\{API_BASE\}\/\$\{TRAIN_STORE_API\}\.json`/);
    assert.match(
      await fs.readFile(
        path.join(fixture.outputDir, "app-persistence.js"),
        "utf8",
      ),
      /`\$\{API_BASE\}\/\$\{TRAIN_STORE_API\}\.json`/,
    );
    assert.match(
      await fs.readFile(path.join(fixture.outputDir, "railmap.js"), "utf8"),
      /`\$\{API_BASE\}\/\$\{path\}`/,
    );
    assert.equal(
      await fs.readFile(path.join(fixture.outputDir, "index.html"), "utf8"),
      '<link rel="preload" href="api/stations.json">',
    );
    assert.equal(
      await fs.readFile(path.join(fixture.outputDir, "app-core.js"), "utf8"),
      "globalThis.AppCore = { fixture: true };\n",
    );

    for (const name of DATASET_NAMES) {
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(
            path.join(fixture.outputDir, "api", `${name}.json`),
            "utf8",
          ),
        ),
        { name },
      );
    }
    // train-store.json must NOT be published: it is only the sample source.
    await assert.rejects(
      fs.access(path.join(fixture.outputDir, "api", "train-store.json")),
      { code: "ENOENT" },
    );
    for (const { dir } of PART_DATASETS) {
      await fs.access(
        path.join(fixture.outputDir, "api", dir, "manifest.json"),
      );
      await fs.access(
        path.join(fixture.outputDir, "api", dir, "part-000.json"),
      );
    }
    await assert.rejects(
      fs.access(
        path.join(fixture.outputDir, "api", "sample-data", "part-000.json.gz"),
      ),
      { code: "ENOENT" },
    );
    await assert.rejects(
      fs.access(
        path.join(fixture.outputDir, "api", "sample-data", "part-000 2.json"),
      ),
      { code: "ENOENT" },
    );
    await fs.access(path.join(fixture.outputDir, ".nojekyll"));
    await assert.rejects(
      fs.access(path.join(fixture.outputDir, "styles", "device-layout.css.gz")),
      { code: "ENOENT" },
    );

    await fs.writeFile(path.join(fixture.outputDir, "stale-file.txt"), "stale");
    await buildStaticSite({
      appDir: fixture.appDir,
      outputDir: fixture.outputDir,
      logger: { log() {} },
    });
    await assert.rejects(
      fs.access(path.join(fixture.outputDir, "stale-file.txt")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("static build works without a train-store.json present", async () => {
  const fixture = await createFixture({ includeTrainStore: false });
  try {
    await buildStaticSite({
      appDir: fixture.appDir,
      outputDir: fixture.outputDir,
      logger: { log() {} },
    });
    await assert.rejects(
      fs.access(path.join(fixture.outputDir, "api", "train-store.json")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

// The app-*.js family shares ONE global scope, so a browser that revalidates
// half of it and serves the rest from cache runs a combination that never
// existed — app.js's boot calling a function a stale app-route-graph.js does
// not define yet. Hand-maintained `?v=` tokens made that a matter of
// remembering; the build now derives them from the shipped bytes.
test("static build stamps script/style tags with content hashes", async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(
      path.join(fixture.appDir, "public", "index.html"),
      [
        '<link rel="stylesheet" href="styles/device-layout.css?v=20260101-handwritten" />',
        '<link rel="preload" href="api/stations" as="fetch" />',
        '<script src="app.js?v=20260101-stale"></script>',
        '<script src="app-persistence.js"></script>',
        '<script src="railmap.js?v=keep&flag=1"></script>',
        '<script src="https://cdn.example.com/x.js?v=external"></script>',
      ].join("\n"),
    );

    await buildStaticSite({
      appDir: fixture.appDir,
      outputDir: fixture.outputDir,
      logger: { log() {} },
    });

    const html = await fs.readFile(
      path.join(fixture.outputDir, "index.html"),
      "utf8",
    );
    const tokenOf = (asset) =>
      html.match(new RegExp(`["/]${asset}\\?[^"]*v=([a-f0-9]{8})`))?.[1];
    const hashOf = async (asset) =>
      createHash("sha256")
        .update(await fs.readFile(path.join(fixture.outputDir, asset)))
        .digest("hex")
        .slice(0, 8);

    // Every local asset is stamped with the hash of what actually shipped —
    // i.e. AFTER the ${API_BASE}/HAS_BACKEND rewrites, not the source bytes.
    for (const asset of [
      "styles/device-layout.css",
      "app.js",
      "app-persistence.js",
    ]) {
      assert.equal(tokenOf(asset), await hashOf(asset), `${asset} token`);
    }
    // A file with no token at all still gets one.
    assert.ok(tokenOf("app-persistence.js"), "untokenized tag gets stamped");
    // Distinct contents must not collide onto one token.
    assert.notEqual(tokenOf("app.js"), tokenOf("app-persistence.js"));
    // Non-version query params survive; the old v= is replaced, not appended.
    assert.match(html, /railmap\.js\?flag=1&v=[a-f0-9]{8}"/);
    assert.doesNotMatch(html, /v=20260101-stale|v=20260101-handwritten|\?v=keep/);
    // Cross-origin and non-stylesheet links are left alone.
    assert.match(html, /https:\/\/cdn\.example\.com\/x\.js\?v=external/);
    assert.match(html, /href="api\/stations\.json" as="fetch"/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
