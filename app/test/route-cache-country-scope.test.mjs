// Regression tests for the persisted route-geometry cache across country
// switches (the REAL app family evaluated in a Node vm over fake-indexeddb).
//
// Two bugs are pinned here:
//  1. The cache DB used to be shared across countries while the warm pass
//     evicts every key outside the ACTIVE country's rail-hash namespace — so
//     warming Taiwan wiped Japan's persisted geometry and vice versa,
//     contradicting switchActiveCountry's "persisted entries stay" promise.
//     openRouteCacheDb now scopes the DB via countryDbName.
//  2. railContentHashCache survived an in-session switch, so the next warm
//     ran under the OLD country's hash — loading the old country's geometry
//     into the new session's runtime cache. resetPersistenceStateForCountry-
//     Switch now clears the memo.
// The unbounded-growth guard must survive the fix: within one country's DB,
// entries from a superseded rail hash or an older ROUTE_SOLVER_CACHE_VERSION
// are still evicted by the same warm pass.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import {
  evaluateAppScripts,
  makeSandbox,
} from "../scripts/lib/app-family-sandbox.mjs";

const ROUTES_STORE = "routes";
const JP_DB = "n02-route-geometry-cache";
const TW_DB = "n02-route-geometry-cache-tw";

function loadAppFamily(indexedDB) {
  const context = makeSandbox({
    userAgent: "node-route-cache-test",
    fetchErrorMessage: "fetch is not available in the route-cache test",
    indexedDB,
  });
  evaluateAppScripts(context);
  return context;
}

// Minimal per-country dataset stand-ins: different coordinates give the two
// countries different rail-content hashes, exactly like the real datasets.
const SECTIONS = {
  jp: [
    [139.7, 35.6],
    [139.8, 35.7],
  ],
  tw: [
    [121.5, 25.0],
    [121.6, 25.1],
  ],
};

function activateCountry(context, country) {
  context.__sections = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: SECTIONS[country] },
      },
    ],
  };
  return vm.runInContext(
    `
      resetPersistenceStateForCountrySwitch();
      activeCountry = ${JSON.stringify(country)};
      railSectionsGeoJson = __sections;
      stationsGeoJson = { type: "FeatureCollection", features: [] };
      RouteService.resetForCountry();
      getRailContentHash();
    `,
    context,
  );
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

function dbKeys(factory, name) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROUTES_STORE)) {
        db.close();
        resolve(null); // DB exists but without the store (or never created)
        return;
      }
      const tx = db.transaction(ROUTES_STORE, "readonly");
      const rq = tx.objectStore(ROUTES_STORE).getAllKeys();
      rq.onsuccess = () => {
        const keys = rq.result.map(String);
        db.close();
        resolve(keys);
      };
      rq.onerror = () => {
        db.close();
        reject(rq.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

function dbPut(factory, name, key, value) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(ROUTES_STORE, "readwrite");
      tx.objectStore(ROUTES_STORE).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    req.onerror = () => reject(req.error);
  });
}

test("country switch keeps the other country's persisted route cache", async () => {
  const factory = new IDBFactory();
  const context = loadAppFamily(factory);

  // Japan session: persist one solved route.
  const jpHash = activateCountry(context, "jp");
  vm.runInContext(
    `persistRouteCacheEntry("solver:" + ROUTE_SOLVER_CACHE_VERSION + "|jp-route", [{ country: "jp" }]);`,
    context,
  );
  await tick();
  const jpKeys = await dbKeys(factory, JP_DB);
  assert.equal(jpKeys.length, 1, "JP entry persisted");
  assert.ok(jpKeys[0].startsWith(`${jpHash}::`));

  // Switch to Taiwan: hash memo must be recomputed from the NEW datasets —
  // a stale memo would run the warm under Japan's namespace (bug 2).
  const twHash = activateCountry(context, "tw");
  assert.notEqual(twHash, jpHash, "hash memo recomputed after switch");
  vm.runInContext(
    `persistRouteCacheEntry("solver:" + ROUTE_SOLVER_CACHE_VERSION + "|tw-route", [{ country: "tw" }]);`,
    context,
  );
  await tick();

  // Warming Taiwan must not touch Japan's DB (bug 1: the shared DB let this
  // warm evict every Japan-hash entry as "previous rail-data namespace").
  await vm.runInContext(`warmRouteCacheFromIndexedDb()`, context);
  assert.deepEqual(
    await dbKeys(factory, JP_DB),
    jpKeys,
    "Japan's persisted entries survive the Taiwan warm",
  );
  assert.equal(
    vm.runInContext(
      `RouteService.has("solver:" + ROUTE_SOLVER_CACHE_VERSION + "|tw-route")`,
      context,
    ),
    true,
    "Taiwan warm loads Taiwan's own entry",
  );
  assert.equal(
    vm.runInContext(`RouteService.cacheSize()`, context),
    1,
    "no cross-country entries warmed",
  );

  // Round trip back to Japan: the promised bulk re-warm still works.
  activateCountry(context, "jp");
  await vm.runInContext(`warmRouteCacheFromIndexedDb()`, context);
  assert.equal(
    vm.runInContext(
      `RouteService.has("solver:" + ROUTE_SOLVER_CACHE_VERSION + "|jp-route")`,
      context,
    ),
    true,
    "JP→TW→JP re-warms Japan's persisted geometry instead of a cold re-solve",
  );
  // ...and Taiwan's DB was equally untouched by the Japan warm.
  assert.equal((await dbKeys(factory, TW_DB)).length, 1);
});

test("within one country, superseded namespaces are still evicted", async () => {
  const factory = new IDBFactory();
  const context = loadAppFamily(factory);
  const twHash = activateCountry(context, "tw");
  const solverVersion = vm.runInContext(`ROUTE_SOLVER_CACHE_VERSION`, context);

  // Live entry + two stranded ones: a superseded rail hash, and the current
  // hash with an older solver version. The warm pass is the growth guard —
  // both stranded entries must be deleted (storage-tight iPhone target).
  vm.runInContext(
    `persistRouteCacheEntry("solver:" + ROUTE_SOLVER_CACHE_VERSION + "|live", [{ ok: 1 }]);`,
    context,
  );
  await tick();
  await dbPut(
    factory,
    TW_DB,
    `rSTALEHASH-9::solver:${solverVersion}|old-namespace`,
    [1],
  );
  await dbPut(factory, TW_DB, `${twHash}::solver:0|old-version`, [1]);
  assert.equal((await dbKeys(factory, TW_DB)).length, 3);

  await vm.runInContext(`warmRouteCacheFromIndexedDb()`, context);
  assert.deepEqual(
    await dbKeys(factory, TW_DB),
    [`${twHash}::solver:${solverVersion}|live`],
    "stale-hash and old-solver-version entries evicted, live entry kept",
  );
});
