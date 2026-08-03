"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp, DATA_FILES } = require("../server/create-app");
const { createTrainStore } = require("../server/train-store");

const FIXED_NOW = new Date("2026-07-17T12:34:56.000Z");

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "train-map-server-"));
  const dataDir = path.join(root, "data");
  const publicDir = path.join(root, "public");
  await fs.mkdir(path.join(dataDir, "sample-data"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "new-year-grand-loop-data"), {
    recursive: true,
  });
  await fs.mkdir(path.join(dataDir, "tokyo-limited-express-loop-data"), {
    recursive: true,
  });
  await fs.mkdir(publicDir, { recursive: true });

  for (const file of Object.values(DATA_FILES)) {
    await fs.writeFile(
      path.join(dataDir, file),
      JSON.stringify({ file, values: [1, 2, 3] }),
    );
  }
  await fs.writeFile(
    path.join(dataDir, "sample-data", "part-000.json"),
    JSON.stringify({ format: 1, train: { id: "sample" }, route: null }),
  );
  await fs.writeFile(
    path.join(dataDir, "new-year-grand-loop-data", "part-000.json"),
    JSON.stringify({
      format: 1,
      train: { id: "new-year-grand-loop" },
      route: null,
    }),
  );
  await fs.writeFile(
    path.join(dataDir, "tokyo-limited-express-loop-data", "part-000.json"),
    JSON.stringify({
      format: 1,
      train: { id: "tokyo-limited-express-loop" },
      route: null,
    }),
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
      train_stores: ["/api/train-store", "/api/train-store-tw"],
      events: "/api/events",
      agent_import: "/api/agent/import?country=jp|tw",
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

test("per-country train stores are fully separate", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    const jpStore = {
      schema_version: "1.3",
      trains: [{ id: "jp-a", stops: [] }],
    };
    const twStore = {
      schema_version: "1.3",
      trains: [{ id: "tw-a", stops: [] }, { id: "tw-b", stops: [] }],
    };
    const savedJp = await fetch(`${baseUrl}/api/train-store`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jpStore),
    });
    assert.equal(savedJp.status, 200);
    const savedTw = await fetch(`${baseUrl}/api/train-store-tw`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(twStore),
    });
    assert.equal(savedTw.status, 200);
    assert.deepEqual(await responseJson(savedTw), { ok: true, trains: 2 });

    // Separate files on disk, separate reads back.
    assert.equal(
      await fs.readFile(path.join(dataDir, "train-store.json"), "utf8"),
      JSON.stringify(jpStore),
    );
    assert.equal(
      await fs.readFile(path.join(dataDir, "train-store-tw.json"), "utf8"),
      JSON.stringify(twStore),
    );
    assert.deepEqual(
      await responseJson(await fetch(`${baseUrl}/api/train-store`)),
      jpStore,
    );
    assert.deepEqual(
      await responseJson(await fetch(`${baseUrl}/api/train-store-tw`)),
      twStore,
    );

    // Agent import routed by country touches only that country's file.
    const agentTw = await fetch(
      `${baseUrl}/api/agent/import?mode=append&country=tw`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ id: "tw-c", stops: [] }]),
      },
    );
    assert.equal(agentTw.status, 200);
    const agentBody = await responseJson(agentTw);
    assert.equal(agentBody.country, "tw");
    assert.deepEqual(agentBody.ids, ["tw-a", "tw-b", "tw-c"]);
    assert.deepEqual(
      await responseJson(await fetch(`${baseUrl}/api/train-store`)),
      jpStore,
    );

    const badCountry = await fetch(
      `${baseUrl}/api/agent/import?country=us`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      },
    );
    assert.equal(badCountry.status, 400);

    // Deleting one store leaves the other intact.
    const deletedTw = await fetch(`${baseUrl}/api/train-store-tw`, {
      method: "DELETE",
    });
    assert.equal(deletedTw.status, 200);
    assert.equal(
      (await fetch(`${baseUrl}/api/train-store-tw`)).status,
      404,
    );
    assert.deepEqual(
      await responseJson(await fetch(`${baseUrl}/api/train-store`)),
      jpStore,
    );
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
      country: "jp",
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

test("concurrent train-store writes are serialized and never corrupt the file", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    // Multi-hundred-KB bodies force writeFile into several write syscalls —
    // the regime where the old shared per-process tmp path interleaved.
    const bodies = Array.from({ length: 8 }, (_, index) => ({
      schema_version: "1.3",
      trains: [
        { id: `writer-${index}`, stops: [], payload: "x".repeat(200000 + index) },
      ],
    }));
    const responses = await Promise.all(
      bodies.map((store) =>
        fetch(`${baseUrl}/api/train-store`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(store),
        }),
      ),
    );
    for (const response of responses) assert.equal(response.status, 200);

    const text = await fs.readFile(
      path.join(dataDir, "train-store.json"),
      "utf8",
    );
    JSON.parse(text); // must parse: no interleaved/truncated content
    assert.ok(
      bodies.some((store) => JSON.stringify(store) === text),
      "final file must equal exactly one of the written stores",
    );
    const leftovers = (await fs.readdir(dataDir)).filter((name) =>
      name.includes(".tmp"),
    );
    assert.deepEqual(leftovers, [], "no tmp files may be left behind");
  });
});

test("parallel agent appends lose no trains (atomic read-modify-write)", async () => {
  await withServer(async ({ baseUrl, dataDir }) => {
    await fs.writeFile(
      path.join(dataDir, "train-store.json"),
      JSON.stringify({
        schema_version: "1.3",
        trains: [{ id: "base", stops: [] }],
      }),
    );
    const ids = Array.from({ length: 6 }, (_, index) => `agent-${index}`);
    const responses = await Promise.all(
      ids.map((id) =>
        fetch(`${baseUrl}/api/agent/import?mode=append`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{ id, stops: [] }]),
        }),
      ),
    );
    for (const response of responses) assert.equal(response.status, 200);

    const stored = JSON.parse(
      await fs.readFile(path.join(dataDir, "train-store.json"), "utf8"),
    );
    assert.deepEqual(
      stored.trains.map((train) => train.id).sort(),
      ["agent-0", "agent-1", "agent-2", "agent-3", "agent-4", "agent-5", "base"],
      "every parallel append must survive (no lost update)",
    );
  });
});

test("separate train-store processes serialize append read-modify-write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "train-map-process-lock-"));
  const filePath = path.join(root, "train-store.json");
  const modulePath = path.join(__dirname, "..", "server", "train-store.js");
  const readyA = path.join(root, "a.ready");
  const readyB = path.join(root, "b.ready");
  await fs.writeFile(
    filePath,
    JSON.stringify({
      schema_version: "1.3",
      trains: [{ id: "base", stops: [] }],
    }),
  );

  const childSource = `
    const fs = require("node:fs");
    const { createTrainStore } = require(process.argv[1]);
    const store = createTrainStore(process.argv[2]);
    const id = process.argv[3];
    const ownReady = process.argv[4];
    const otherReady = process.argv[5];
    fs.writeFileSync(ownReady, id);
    (async () => {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(otherReady) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return store.update(async (current) => {
        // Hold the process-local mutator open briefly. Without a cross-process
        // lock both processes read the same baseline and one append is lost.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          schema_version: "1.3",
          trains: [...current.trains, { id, stops: [] }],
        };
      });
    })().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  const runChild = (id, ownReady, otherReady) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        "-e",
        childSource,
        modulePath,
        filePath,
        id,
        ownReady,
        otherReady,
      ]);
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `child ${id} exited with ${code}`));
      });
    });

  try {
    await Promise.all([
      runChild("append-a", readyA, readyB),
      runChild("append-b", readyB, readyA),
    ]);
    const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.deepEqual(
      stored.trains.map((train) => train.id).sort(),
      ["append-a", "append-b", "base"],
    );
    await assert.rejects(fs.access(`${filePath}.lock`), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a dead local process cannot strand the cross-process lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "train-map-dead-lock-"));
  const filePath = path.join(root, "train-store.json");
  const lockPath = `${filePath}.lock`;
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: 2147483647,
      hostname: os.hostname(),
      token: "dead-owner",
      created_at: Date.now(),
    }),
  );
  try {
    const store = createTrainStore(filePath);
    await store.write({
      schema_version: "1.3",
      trains: [{ id: "recovered", stops: [] }],
    });
    assert.equal(
      JSON.parse(await fs.readFile(filePath, "utf8")).trains[0].id,
      "recovered",
    );
    await assert.rejects(fs.access(lockPath), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sample data and static assets preserve validation and delivery headers", async () => {
  await withServer(async ({ baseUrl }) => {
    const invalid = await rawRequest(baseUrl, "/api/sample-data/%2e%2e");
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.body), {
      error: "Invalid sample data name.",
    });

    const part = await fetch(`${baseUrl}/api/sample-data/part-000.json`);
    assert.equal(part.status, 200);
    assert.equal(part.headers.get("cache-control"), "no-cache");
    assert.deepEqual(await responseJson(part), {
      format: 1,
      train: { id: "sample" },
      route: null,
    });

    const grandLoopPart = await fetch(
      `${baseUrl}/api/new-year-grand-loop-data/part-000.json`,
    );
    assert.equal(grandLoopPart.status, 200);
    assert.equal(grandLoopPart.headers.get("cache-control"), "no-cache");
    assert.equal(
      (await responseJson(grandLoopPart)).train.id,
      "new-year-grand-loop",
    );
    const tokyoLoopPart = await fetch(
      `${baseUrl}/api/tokyo-limited-express-loop-data/part-000.json`,
    );
    assert.equal(tokyoLoopPart.status, 200);
    assert.equal(tokyoLoopPart.headers.get("cache-control"), "no-cache");
    assert.equal(
      (await responseJson(tokyoLoopPart)).train.id,
      "tokyo-limited-express-loop",
    );

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
        /event: store-changed\ndata: {"type":"store-changed","at":"2026-07-17T12:34:56.000Z","origin":"sse-origin","source":"ui","store":"train-store","trains":0}/,
      );
    } finally {
      request.destroy();
    }
  });
});

test("coerceStore backstop rejects shapes the frontend could never load", async () => {
  await withServer(async ({ baseUrl }) => {
    // Non-object trains used to persist verbatim with ok:true, after which
    // every open browser dropped into read-only recovery mode on reload.
    const garbage = await fetch(`${baseUrl}/api/train-store`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema_version: "1.3", trains: [1, "two", null] }),
    });
    assert.equal(garbage.status, 400);
    assert.deepEqual(await responseJson(garbage), {
      error: "trains[0] must be an object.",
    });

    // Unknown top-level keys are rejected on load by the frontend
    // (assertOnlyKeys), so persisting them would only brick the next boot.
    const unknownKey = await fetch(`${baseUrl}/api/train-store`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema_version: "1.3", trains: [], extra: 1 }),
    });
    assert.equal(unknownKey.status, 400);
    assert.deepEqual(await responseJson(unknownKey), {
      error: "Store contains unsupported field: extra.",
    });

    // Id-less trains used to collapse onto the Map key `undefined` in append
    // mode: only the last one survived while trains_added counted them all.
    const idless = await fetch(`${baseUrl}/api/agent/import?mode=append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { stops: [], marker: "no-id-1" },
        { stops: [], marker: "no-id-2" },
      ]),
    });
    assert.equal(idless.status, 400);
    assert.deepEqual(await responseJson(idless), {
      error: 'trains[0].id must be a string of letters, digits, "_" or "-".',
    });

    const duplicatePut = await fetch(`${baseUrl}/api/train-store`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.3",
        trains: [
          { id: "duplicate", stops: [] },
          { id: "duplicate", stops: [] },
        ],
      }),
    });
    assert.equal(duplicatePut.status, 400);
    assert.deepEqual(await responseJson(duplicatePut), {
      error: "trains[1]: duplicate id duplicate.",
    });

    const duplicateReplace = await fetch(`${baseUrl}/api/agent/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { id: "duplicate", stops: [] },
        { id: "duplicate", stops: [] },
      ]),
    });
    assert.equal(duplicateReplace.status, 400);
    assert.deepEqual(await responseJson(duplicateReplace), {
      error: "trains[1]: duplicate id duplicate.",
    });

    // None of the rejected bodies may have been persisted.
    const saved = await fetch(`${baseUrl}/api/train-store`);
    assert.equal(saved.status, 404);
  });
});

test("body-parser failures return JSON errors, not HTML stack traces", async () => {
  await withServer(async ({ baseUrl }) => {
    const malformed = await fetch(`${baseUrl}/api/train-store`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"schema_version": "1.3", trains: BROKEN',
    });
    assert.equal(malformed.status, 400);
    assert.match(
      malformed.headers.get("content-type") || "",
      /application\/json/,
    );
    assert.deepEqual(await responseJson(malformed), {
      error: "Request body is not valid JSON.",
    });
  });
});

test("store deletion is serialized behind queued writes", async () => {
  // A direct unlink could land between a queued write's writeFile and its
  // rename, letting the rename resurrect the "cleared" store after DELETE
  // already answered ok — remove() must flow through the same FIFO queue.
  const { createTrainStore } = require("../server/train-store");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "train-map-store-"));
  try {
    const filePath = path.join(root, "train-store.json");
    const store = createTrainStore(filePath);
    const big = {
      schema_version: "1.3",
      trains: Array.from({ length: 2000 }, (_, index) => ({
        id: `t${index}`,
        stops: [],
        payload: "x".repeat(1024),
      })),
    };
    const writePromise = store.write(big); // enqueued first
    const removePromise = store.remove(); // must run strictly after the write
    const [, removed] = await Promise.all([writePromise, removePromise]);
    assert.deepEqual(removed, { existed: true });
    await assert.rejects(fs.access(filePath), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
