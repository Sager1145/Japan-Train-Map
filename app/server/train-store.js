"use strict";

const fs = require("fs");

const ACCEPTED_SCHEMA_VERSIONS = ["1.3"];
const DEFAULT_SCHEMA_VERSION = "1.3";

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

  return {
    filePath,
    read,
    write,
    update,
  };
}

module.exports = {
  ACCEPTED_SCHEMA_VERSIONS,
  DEFAULT_SCHEMA_VERSION,
  coerceStore,
  createTrainStore,
};
