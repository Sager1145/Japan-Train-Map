# Code Optimization Review — 2026-07-02

> **Status update:** Fixes 1–3 were implemented and verified on 2026-07-02.
> 1. `appendImportedTrain` now validates only the incoming train (full-store validation still runs once in `finalizeProgressiveLoad`).
> 2. `server.js` serves datasets gzip-encoded from lazily built `.gz` sidecars (12.1 MB → 2.4 MB rail-sections, 3.3 MB → 0.45 MB stations) with weak ETags and If-None-Match → 304 revalidation. Sidecars are gitignored.
> 3. `dijkstraBetweenExactNodes` replaced by `dijkstraFromCandidateSources` — one multi-source→multi-target run per solve attempt instead of up to 144 per-pair runs; verified equivalent to the per-pair best on 200 randomized graphs.

Scope: all first-party code — `app/public/app.js` (7,446 lines, ~230 functions), `app/public/deckgl-routes.js`, `app/public/i18n.js`, `app/server.js`, `app/scripts/*.py`. Vendor files (leaflet, deck.gl, polylineoffset) excluded. Every function and its call paths were traced across the boot, import, route-solve, render, and persist pipelines.

## Verdict

The codebase is already heavily and deliberately optimized. The deck.gl GPU route/marker path, Douglas-Peucker pre-decimation with WeakMap caching, IndexedDB route-geometry cache, on-demand regional subgraphs with LRU budget, signature-cached route items, debounced/dirty-flagged autosave, and time-budgeted progressive import are all sound and correctly implemented. The remaining issues below are ranked by real-world impact. Items 1–3 are worth fixing; the rest are diminishing returns.

---

## High impact

### 1. O(N²) validation inside the progressive import — `appendImportedTrain()` (app.js:2342)

Each appended train runs:

```js
const tempStore = buildCanonicalTrainStore();   // normalizeExportTrain × ALL trains
tempStore.trains.push(normalizeExportTrain(train));
validateTrainStore(tempStore);                   // validateTrain × ALL trains
```

`validateTrain` calls `warnBranchLeak`, which resolves station candidates for **every route_section endpoint** of every train (~30 resolutions/train, each running `dedupeStationFeatures` with a `JSON.stringify` signature). For 70 trains that is ~70²/2 × 30 ≈ **70k+ station resolutions** during one import, plus 70 full canonical re-serializations. This is the dominant JS cost of the import loop (the frame-budget scheduler hides it as more yielded frames, not less work).

Fix: validate only the incoming train (id uniqueness is already guaranteed by `makeUniqueTrainId`); run `warnBranchLeak` once per new train; keep the single full `validateTrainStore` in `finalizeProgressiveLoad`. Turns import validation into O(N).

### 2. No HTTP compression or conditional revalidation for the 15 MB dataset — server.js:51–67

`rail-sections.json` (12.1 MB) and `stations.json` (3.3 MB) are streamed raw. Express adds no gzip and, because the response is a manual `createReadStream` pipe, no ETag/Last-Modified — so after the 1-hour `max-age` expires the full 15 MB is re-downloaded, never a 304. Coordinate-heavy GeoJSON compresses ~85 %.

Fix (either):
- `app.use(require("compression")())`, or pre-generate `.json.gz`/`.json.br` at deploy time and serve with `Content-Encoding` when the client accepts it (zero CPU per request);
- set `ETag`/`Last-Modified` from the file stat so revalidation returns 304.

Boot payload drops from ~15 MB to ~2 MB.

### 3. Up-to-144 Dijkstra runs per candidate attempt — `solveRouteSectionOnN02Graph()` (app.js:5638)

On a cache miss, each solve attempt runs `dijkstraBetweenExactNodes` for every from×to candidate pair (12 × 12), and up to ~7 attempts per section. Worst case ≈ 1,000 full Dijkstra runs on a 100k+-node regional graph for one section.

Fix: one **multi-source → multi-target** Dijkstra per attempt — seed the heap with all from-candidates at their snap-penalty cost, stop at the first settled to-candidate (or settle all 12 targets and keep the best scored). Identical result, ~100× fewer runs. Optionally add A* with the haversine straight-line heuristic (admissible: every edge weight ≥ its length, penalties only add).

---

## Medium impact

### 4. `buildDeckOverlapMap` rebuilt from scratch on every route re-render (app.js:4241, 4277)

The segment-key → train-set map is O(total simplified vertices) with string keys, and is rebuilt by `buildDeckRouteRecords` on **every** `renderRoutesInView` — every selection change, every visibility toggle, every zoomend while overlaps exist. Additionally `infoFor` sorts the id set per vertex inside the record loop. The map depends only on the item set (already fingerprinted by `cachedRouteSignature`); only `spacingDeg` depends on zoom.

Fix: cache the overlap map (and a precomputed `(key, trainId) → {count, slot}` lookup) keyed by `cachedRouteSignature`; recompute only offsets on zoom.

### 5. Station re-resolution on every marker rebuild — `getStopFeature` → `resolveStationForTrain` (app.js:6738, 1193)

`buildDeckMarkerRecords` runs on every selection change and every `PASSTHROUGH_MIN_ZOOM` crossing, calling `getStopFeature` for all ~700 stops. Each ambiguous stop triggers `trainAnchorCoordinates`, which itself calls `resolveStationCandidates` for **every other stop** of the train — O(stops²) resolutions per train per rebuild. The computed pass-throughs are memoized (`getComputedPassThroughFeaturesCached`) but explicit stop features are not.

Fix: memoize the resolved stop feature per `(train.id, stop name/code)` with the same invalidation key style as `_computedPassThroughCache`.

### 6. Full store serialization triggered by pure selection changes (app.js:3329)

`selectTrain` calls `scheduleExportTextareaRefresh()`, which serializes the whole store (`normalizeExportTrain` → `getRideRouteSectionsForTrain` for every train) 300 ms after every train click, even though nothing changed.

Fix: skip the refresh when the store isn't dirty (reuse `storeSaveDirty` or a store-revision counter, and cache the last serialized text).

### 7. Unbounded growth of `matchedRoutesGeoJson.features` (app.js:4819)

Every cache-miss solve appends the train's concrete features to the global collection. Editing a train's sections (new templateKey → new solve) appends again; the previous features for the same `train_id` are never removed. Long editing sessions leak memory, and the `getMatchedRouteFeatures` fallback filter walks an ever-growing array and could pick stale geometry (mitigated only by the `route_id` group filter).

Fix: before pushing, drop existing features with the same `train_id`; or stop mirroring into the global collection entirely (the runtime cache is authoritative).

### 8. `clone()` = JSON round-trip in a warm path (app.js:1074, 6978)

`getFeaturePathCoordinates` deep-clones coordinates via `JSON.parse(JSON.stringify(...))` on every call; it backs `getFeatureDisplayCoordinate` for LineString station features, which runs during station resolution and marker builds.

Fix: `geometry.coordinates.map(c => c.slice())` (or return read-only without cloning — callers don't mutate).

### 9. Live-reload events can be dropped during an import — `handleExternalStoreChange` (app.js:1004)

When `importInProgress` is true the handler sets `liveReloadPending = true` and returns — but the only code that consumes `liveReloadPending` is the `finally` block of a *completed* handler run. Nothing re-checks the flag when the import finishes, so an external store change arriving mid-import is silently lost until the next SSE event. (Correctness, not perf.)

Fix: check `liveReloadPending` at the end of `runProgressiveAppend`/`finalizeProgressiveLoad` (or in the two `finally { importInProgress = false }` blocks) and re-dispatch.

---

## Low impact (fine at current scale; listed for completeness)

- **Sort comparator recomputes keys** — `compareTrainsByDateAndDeparture` re-runs `getTrainDate` (regex) and `getTrainDepartureMinutes` (time parsing) per comparison. Precompute a sort key per train (decorate-sort-undecorate). (app.js:674)
- **`fitDateBounds` / `fitTrainBounds` allocate `L.geoJSON` layers just to get bounds** — `featureBbox()` already exists and is cached on the feature; union the bboxes instead. (app.js:3353, 7016)
- **`trainTripIndex` is `indexOf` over the store inside a per-train loop** → O(N²) in `computeGlobalEndpoints`; trivial at N=70 but a Map fixes it. (app.js:319)
- **`stationFeaturesInBbox` scans all 10k stations linearly** per regional graph build; rails got a grid index, stations didn't. Builds are rare and LRU-cached, so acceptable. (app.js:5095)
- **Unbounded caches**: `_computedPassThroughCache` and `runtimeRouteCache` never evict; keys accumulate across edits. Bounded in practice by session length — add a simple size cap if sessions grow. (app.js:4396, 4680)
- **`renderStopsTable`** rebuilds all rows and re-attaches per-input listeners on each render; event delegation on `stopsBody` would halve the work. Fine at ≤ ~40 rows. (app.js:3549)
- **`getRailContentHash`** mixes every coordinate (~405k points) at boot; documented one-time tens-of-ms cost — acceptable, matches its comment. (app.js:1465)
- **server.js `fs.existsSync` (sync) per request** — negligible; could stat once and cache.
- **Dead code retained knowingly**: the Leaflet overlap-split path (`getRouteSegmentRecords`, `buildRouteOverlapMap`, `splitRouteFeatureIntoStyledRuns`, `getRouteOverlapInfoForKey`) is unreachable with `splitForOverlap` pinned `false`; already documented with a TODO at app.js:4102. Remove if the SVG split path is formally dropped.
- **Route-solve on the main thread** — `warmRouteCacheForTrain` runs regional graph builds + Dijkstra between frames; the time-budget scheduler bounds jank, but a Web Worker would remove it entirely. Larger refactor; only worth it if cold-cache imports feel slow after fix #3.

## Files with no significant findings

- **deckgl-routes.js** — well done: stable `data` array references to avoid GPU attribute re-uploads, hover early-return, fresh-layer-instance compose is the idiomatic deck.gl pattern.
- **i18n.js** — dictionary lookups, no hot paths.
- **scripts/*.py** — offline tooling; resumable, politely throttled; performance irrelevant.

## Suggested fix order

1 → 2 → 3 (measurable wins: import time, boot bandwidth, cold-cache solve time), then 4–6 (interaction latency), then 7 and 9 (memory/correctness). Everything else is optional polish.
