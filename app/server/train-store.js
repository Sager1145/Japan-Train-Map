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
  async function write(store) {
    const tmpFile = `${filePath}.${process.pid}.tmp`;
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

  return {
    filePath,
    read,
    write,
  };
}

module.exports = {
  ACCEPTED_SCHEMA_VERSIONS,
  DEFAULT_SCHEMA_VERSION,
  coerceStore,
  createTrainStore,
};
