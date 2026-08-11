"use strict";

const fs = require("fs");
const os = require("os");
// shared/app-core.js owns the browser/Node protocol constants, so a schema bump
// or an id-charset change (jsonspec §3.2: ids
// feed route_id, cache keys and the append upsert's Map key) can never drift
// between the two sides. The store's write default is the current version.
const {
  ACCEPTED_SCHEMA_VERSIONS,
  SCHEMA_VERSION: DEFAULT_SCHEMA_VERSION,
  TRAIN_ID_PATTERN,
} = require("../shared/app-core.js");

const FILE_LOCK_RETRY_MS = 15;
const FILE_LOCK_TIMEOUT_MS = 15000;
const FILE_LOCK_STALE_MS = 120000;

function coerceStore(
  body,
  { lenient = false, allowDuplicateIds = false } = {},
) {
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
  const ids = new Set();
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
    if (!allowDuplicateIds && ids.has(train.id)) {
      throw new Error(`trains[${index}]: duplicate id ${train.id}.`);
    }
    ids.add(train.id);
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
  const lockPath = `${filePath}.lock`;

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

  async function acquireFileLock() {
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await fs.promises.open(lockPath, "wx");
        const lockRecord = {
          pid: process.pid,
          hostname: os.hostname(),
          token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
          created_at: Date.now(),
        };
        try {
          await handle.writeFile(JSON.stringify(lockRecord), "utf8");
        } catch (err) {
          await fs.promises.unlink(lockPath).catch(() => {});
          throw err;
        } finally {
          await handle.close();
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            // If this lock was reclaimed after this process stalled, never
            // unlink the newer owner's lock during our late cleanup.
            const current = JSON.parse(
              await fs.promises.readFile(lockPath, "utf8"),
            );
            if (current.token !== lockRecord.token) return;
            await fs.promises.unlink(lockPath);
          } catch (err) {
            if (err.code !== "ENOENT" && !(err instanceof SyntaxError))
              throw err;
          }
        };
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        // A killed process cannot clean up its lock. On this host, reclaim a
        // lock as soon as its recorded PID is gone; for a shared filesystem
        // owned by another host, use the conservative age threshold.
        const [stat, recordText] = await Promise.all([
          fs.promises.stat(lockPath).catch(() => null),
          fs.promises.readFile(lockPath, "utf8").catch(() => null),
        ]);
        let ownerDead = false;
        if (recordText) {
          try {
            const record = JSON.parse(recordText);
            if (
              record.hostname === os.hostname() &&
              Number.isInteger(record.pid) &&
              record.pid > 0
            ) {
              try {
                process.kill(record.pid, 0);
              } catch (ownerError) {
                ownerDead = ownerError.code !== "EPERM";
              }
            }
          } catch (_) {
            // A just-created lock can be temporarily empty/partial; age-based
            // cleanup below handles a genuinely abandoned malformed file.
          }
        }
        const stale =
          stat && Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS;
        if (ownerDead || stale) {
          await fs.promises.unlink(lockPath).catch(() => {});
          continue;
        }
        if (Date.now() - startedAt >= FILE_LOCK_TIMEOUT_MS) {
          const timeout = new Error(
            `Timed out waiting for train-store lock: ${lockPath}`,
          );
          timeout.code = "ELOCKTIMEOUT";
          throw timeout;
        }
        await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
      }
    }
  }

  async function withFileLock(task) {
    const release = await acquireFileLock();
    try {
      return await task();
    } finally {
      await release();
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
    return enqueue(() => withFileLock(() => writeNow(store)));
  }

  // Atomic read-modify-write: `mutator` receives the current store (null when
  // none is saved yet) and returns the store to persist. Runs inside the
  // write queue so no other write can land between the read and the write.
  function update(mutator) {
    return enqueue(() =>
      withFileLock(async () => {
        const current = await read();
        const next = await mutator(current);
        await writeNow(next);
        return next;
      }),
    );
  }

  // Deletion MUST flow through the same FIFO queue as writes: a direct unlink
  // could land between a queued write's writeFile and its rename, letting the
  // rename resurrect the "cleared" store after DELETE already returned ok.
  function remove() {
    return enqueue(() =>
      withFileLock(async () => {
        try {
          await fs.promises.unlink(filePath);
          return { existed: true };
        } catch (err) {
          if (err.code === "ENOENT") return { existed: false };
          throw err;
        }
      }),
    );
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
