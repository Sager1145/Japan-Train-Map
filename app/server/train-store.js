"use strict";

const fs = require("fs");

const ACCEPTED_SCHEMA_VERSIONS = ["1.3"];
const DEFAULT_SCHEMA_VERSION = "1.3";
// Same charset the frontend enforces (jsonspec §3.2): ids feed route_id,
// cache keys and the append upsert's Map key, so an id-less train must be
// rejected here instead of collapsing onto the `undefined` key.
const TRAIN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function coerceStore(body, { lenient = false } = {}) {
  let store = body;
  if (lenient) {
    if (Array.isArray(body)) {
      store = { schema_version: DEFAULT_SCHEMA_VERSION, trains: body };
    } else if (
      body &&
      typeof body === "object" &&
      body.id &&
      Array.isArray(body.stops) &&
      !Array.isArray(body.trains)
    ) {
      store = { schema_version: DEFAULT_SCHEMA_VERSION, trains: [body] };
    }
  }

  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new Error("Body must be a train store object.");
  }
  if (!store.schema_version && lenient) {
    store.schema_version = DEFAULT_SCHEMA_VERSION;
  }
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(store.schema_version)) {
    throw new Error(
      `schema_version must be one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }
  if (!Array.isArray(store.trains)) {
    throw new Error("trains must be an array.");
  }
  // The frontend rejects unknown top-level keys on load (assertOnlyKeys), so
  // persisting them here would only brick the next boot into recovery mode.
  for (const key of Object.keys(store)) {
    if (key !== "schema_version" && key !== "trains") {
      throw new Error(`Store contains unsupported field: ${key}.`);
    }
  }
  // Minimal per-train shape check. The browser does the full jsonspec
  // validation; this backstop only rejects what the frontend could never
  // load (and what the append upsert cannot key), so an agent gets a 400
  // instead of ok:true followed by every open map entering recovery mode.
  store.trains.forEach((train, index) => {
    if (!train || typeof train !== "object" || Array.isArray(train)) {
      throw new Error(`trains[${index}] must be an object.`);
    }
    if (typeof train.id !== "string" || !TRAIN_ID_PATTERN.test(train.id)) {
      throw new Error(
        `trains[${index}].id must be a string of letters, digits, "_" or "-".`,
      );
    }
    if (!Array.isArray(train.stops)) {
      throw new Error(`trains[${index}] (${train.id}): stops must be an array.`);
    }
  });
  return store;
}

function createTrainStore(filePath) {
  // All writes flow through ONE FIFO queue. Concurrent writes used to share a
  // single per-process tmp path (`.<pid>.tmp`), so two overlapping multi-MB
  // writeFile calls could interleave on the same file and rename corrupted
  // JSON into place. The queue also makes update()'s read-modify-write (agent
  // append) atomic with respect to other writes. A failed task never blocks
  // the queue: the chain continues via the swallowed branch below, while the
  // caller still receives the rejection.
  let queue = Promise.resolve();
  let writeCounter = 0;

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function writeNow(store) {
    writeCounter += 1;
    const tmpFile = `${filePath}.${process.pid}.${writeCounter}.tmp`;
    try {
      await fs.promises.writeFile(tmpFile, JSON.stringify(store), "utf8");
      await fs.promises.rename(tmpFile, filePath);
    } catch (err) {
      fs.promises.unlink(tmpFile).catch(() => {});
      throw err;
    }
  }

  async function read() {
    try {
      const text = await fs.promises.readFile(filePath, "utf8");
      return JSON.parse(text);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  function write(store) {
    return enqueue(() => writeNow(store));
  }

  // Atomic read-modify-write: `mutator` receives the current store (null when
  // none is saved yet) and returns the store to persist. Runs inside the
  // write queue so no other write can land between the read and the write.
  function update(mutator) {
    return enqueue(async () => {
      const current = await read();
      const next = await mutator(current);
      await writeNow(next);
      return next;
    });
  }

  // Deletion MUST flow through the same FIFO queue as writes: a direct unlink
  // could land between a queued write's writeFile and its rename, letting the
  // rename resurrect the "cleared" store after DELETE already returned ok.
  function remove() {
    return enqueue(async () => {
      try {
        await fs.promises.unlink(filePath);
        return { existed: true };
      } catch (err) {
        if (err.code === "ENOENT") return { existed: false };
        throw err;
      }
    });
  }

  return {
    filePath,
    read,
    write,
    update,
    remove,
  };
}

module.exports = {
  ACCEPTED_SCHEMA_VERSIONS,
  DEFAULT_SCHEMA_VERSION,
  coerceStore,
  createTrainStore,
};
