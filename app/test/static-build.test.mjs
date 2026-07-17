import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DATASET_NAMES,
  buildStaticSite,
} from "../scripts/build-static-site.mjs";

async function createFixture({ includeTrainStore = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "train-map-build-"));
  const appDir = path.join(root, "app");
  const publicDir = path.join(appDir, "public");
  const dataDir = path.join(appDir, "data");
  const partsDir = path.join(dataDir, "sample-data");
  const outputDir = path.join(root, "_site");
  await fs.mkdir(publicDir, { recursive: true });
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
  await fs.writeFile(path.join(publicDir, "styles.css"), "body {}\n");
  await fs.writeFile(path.join(publicDir, "styles.css.gz"), "ignored");

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
  await fs.writeFile(
    path.join(partsDir, "part-000.json"),
    JSON.stringify({ format: 1, train: {}, route: null }),
  );

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
    await fs.access(
      path.join(fixture.outputDir, "api", "sample-data", "manifest.json"),
    );
    await fs.access(
      path.join(fixture.outputDir, "api", "sample-data", "part-000.json"),
    );
    await assert.rejects(
      fs.access(
        path.join(fixture.outputDir, "api", "sample-data", "part-000.json.gz"),
      ),
      { code: "ENOENT" },
    );
    await fs.access(path.join(fixture.outputDir, ".nojekyll"));
    await assert.rejects(
      fs.access(path.join(fixture.outputDir, "styles.css.gz")),
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
