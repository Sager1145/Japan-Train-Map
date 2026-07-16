"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp, DATA_FILES } = require("../server/create-app");

const FIXED_NOW = new Date("2026-07-17T12:34:56.000Z");

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "train-map-server-"));
  const dataDir = path.join(root, "data");
  const publicDir = path.join(root, "public");
  await fs.mkdir(path.join(dataDir, "train-parts"), { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });

  for (const file of Object.values(DATA_FILES)) {
    await fs.writeFile(
      path.join(dataDir, file),
      JSON.stringify({ file, values: [1, 2, 3] }),
    );
  }
  await fs.writeFile(
    path.join(dataDir, "train-parts", "part-000.json"),
    JSON.stringify({ format: 1, train: { id: "sample" }, route: null }),
  );
  await fs.writeFile(
    path.join(publicDir, "index.html"),
    "<!doctype html><title>Fixture</title>",
  );
  await fs.writeFile(path.join(publicDir, "app.js"), "window.fixture = true;\n");
  await fs.writeFile(
    path.join(publicDir, "asset.json"),
    JSON.stringify({ static: true }),
  );

  return { root, dataDir, publicDir };
}

async function withServer(run) {
  const fixture = await createFixture();
  const logs = [];
  const logger = {
    warn: (...args) => logs.push(["warn", ...args]),
    error: (...args) => logs.push(["error", ...args]),
  };
  const app = createApp({
    dataDir: fixture.dataDir,
    publicDir: fixture.publicDir,
    logger,
    now: () => FIXED_NOW,
    heartbeatMs: 1000,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ ...fixture, baseUrl, logs });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

async function rawRequest(baseUrl, requestPath) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: requestPath,
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, body });
        });
      },
    );
    request.on("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for server event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTimeout(promise, message, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("health endpoint preserves the API listing contract", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api`);
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), {
      name: "n02-train-manager API",
      datasets: [
        "/api/rail-sections",
        "/api/stations",
        "/api/default-trains",
        "/api/matched-routes",
        "/api/matched-stops",
        "/api/station-readings",
      ],
      train_store: "/api/train-store",
      events: "/api/events",
      agent_import: "/api/agent/import",
      live_clients: 0,
    });
  });
});

test("datasets preserve gzip, cache, ETag, and 304 behavior", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    const response = await fetch(`${baseUrl}/api/stations`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.match(response.headers.get("etag"), /^W\/"\d+-\d+"$/);
    assert.deepEqual(await responseJson(response), {
      file: "stations.json",
      values: [1, 2, 3],
    });
    await fs.access(path.join(dataDir, "stations.json.gz"));

    const unchanged = await fetch(`${baseUrl}/api/stations`, {
      headers: { "If-None-Match": response.headers.get("etag") },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
  });
});

test("train store validates, persists, streams, and deletes canonically", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    const missing = await fetch(`${baseUrl}/api/train-store`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await responseJson(missing), {
      error: "No saved train store yet.",
    });

    const invalid = await fetch(`${baseUrl}/api/train-store`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema_version: "1.2", trains: [] }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await responseJson(invalid), {
      error: "schema_version must be one of 1.3.",
    });

    const store = {
      schema_version: "1.3",
      trains: [{ id: "a", stops: [] }, { id: "b", stops: [] }],
    };
    const saved = await fetch(`${baseUrl}/api/train-store`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": "fixture-client",
      },
      body: JSON.stringify(store),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await responseJson(saved), { ok: true, trains: 2 });
    assert.equal(
      await fs.readFile(path.join(dataDir, "train-store.json"), "utf8"),
      JSON.stringify(store),
    );

    const loaded = await fetch(`${baseUrl}/api/train-store`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.headers.get("cache-control"), "no-store");
    assert.deepEqual(await responseJson(loaded), store);

    const deleted = await fetch(`${baseUrl}/api/train-store`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await responseJson(deleted), { ok: true });

    const alreadyEmpty = await fetch(`${baseUrl}/api/train-store`, {
      method: "DELETE",
    });
    assert.equal(alreadyEmpty.status, 200);
    assert.deepEqual(await responseJson(alreadyEmpty), {
      ok: true,
      alreadyEmpty: true,
    });
  });
});

test("agent append import preserves upsert order and response counts", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    const initialStore = {
      schema_version: "1.3",
      trains: [
        { id: "a", stops: [], marker: "original-a" },
        { id: "b", stops: [], marker: "original-b" },
      ],
    };
    await fs.writeFile(
      path.join(dataDir, "train-store.json"),
      JSON.stringify(initialStore),
    );

    const response = await fetch(`${baseUrl}/api/agent/import?mode=APPEND`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": "agent-client",
      },
      body: JSON.stringify([
        { id: "b", stops: [], marker: "replacement-b" },
        { id: "c", stops: [], marker: "new-c" },
      ]),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await responseJson(response), {
      ok: true,
      mode: "append",
      trains_total: 3,
      trains_added: 1,
      trains_replaced: 1,
      live_clients: 0,
      ids: ["a", "b", "c"],
    });

    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDir, "train-store.json"), "utf8"),
      ),
      {
        schema_version: "1.3",
        trains: [
          { id: "a", stops: [], marker: "original-a" },
          { id: "b", stops: [], marker: "replacement-b" },
          { id: "c", stops: [], marker: "new-c" },
        ],
      },
    );

    const invalidMode = await fetch(
      `${baseUrl}/api/agent/import?mode=merge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      },
    );
    assert.equal(invalidMode.status, 400);
    assert.deepEqual(await responseJson(invalidMode), {
      error: "mode must be 'replace' or 'append'.",
    });
  });
});

test("train parts and static assets preserve validation and delivery headers", async () => {
  await withServer(async ({ baseUrl }) => {
    const invalid = await rawRequest(baseUrl, "/api/train-parts/%2e%2e");
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.body), {
      error: "Invalid train part name.",
    });

    const part = await fetch(`${baseUrl}/api/train-parts/part-000.json`);
    assert.equal(part.status, 200);
    assert.equal(part.headers.get("cache-control"), "no-cache");
    assert.deepEqual(await responseJson(part), {
      format: 1,
      train: { id: "sample" },
      route: null,
    });

    const staticJson = await fetch(`${baseUrl}/asset.json`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(staticJson.status, 200);
    assert.equal(
      staticJson.headers.get("cache-control"),
      "public, max-age=86400",
    );
    assert.equal(staticJson.headers.get("content-encoding"), "gzip");
    assert.deepEqual(await responseJson(staticJson), { static: true });

    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), "<!doctype html><title>Fixture</title>");
  });
});

test("SSE clients receive hello and store-change events with origin metadata", async () => {
  await withServer(async ({ baseUrl }) => {
    const eventsUrl = new URL("/api/events", baseUrl);
    const chunks = [];
    let request;

    const received = new Promise((resolve, reject) => {
      request = http.get(eventsUrl, (response) => {
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["content-type"], "text/event-stream");
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          chunks.push(chunk);
          const text = chunks.join("");
          if (
            text.includes("event: hello") &&
            text.includes("event: store-changed")
          ) {
            resolve(text);
          }
        });
        response.on("error", reject);
      });
      request.on("error", reject);
    });

    try {
      await waitFor(() => chunks.join("").includes("event: hello"));

      const health = await fetch(`${baseUrl}/api`);
      assert.equal((await responseJson(health)).live_clients, 1);

      const saved = await fetch(`${baseUrl}/api/train-store`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Id": "sse-origin",
        },
        body: JSON.stringify({ schema_version: "1.3", trains: [] }),
      });
      assert.equal(saved.status, 200);

      const streamText = await withTimeout(
        received,
        "Timed out waiting for store-change event.",
      );
      assert.match(streamText, /event: hello\ndata: {"ok":true}/);
      assert.match(
        streamText,
        /event: store-changed\ndata: {"type":"store-changed","at":"2026-07-17T12:34:56.000Z","origin":"sse-origin","source":"ui","trains":0}/,
      );
    } finally {
      request.destroy();
    }
  });
});
