# Codebase Audit Report — Japan Train Map (N02 Train Manager)

Date: 2026-07-06 · Scope: all first-party code. Every file below was read in full: `app/server.js` (397), `app/public/app.js` (7,709), `app/public/railmap.js` (1,401), `app/public/i18n.js` (609), `app/public/index.html` (199), `app/public/styles.css` (749), `app/scripts/*.py` (220), plus `AGENT.md`, `package.json`, `run-app.sh`, data-file inventories, and the two prior review docs (`optimization-review.md`, `route-display-optimization-plan.md`). Vendor code (`public/vendor/maplibre`) excluded. **No source files were modified.**

---

## 1. Executive summary

The codebase is in strong shape. The prior optimization pass (2026-07-02) and the route-display refactor (2026-07-06) landed correctly: gzip sidecars + ETag on the server, multi-source Dijkstra, signature-keyed overlap/record/marker caches, zero-rebuild selection, and per-train O(1) import validation are all present and consistent in the current code.

What remains falls into four buckets:

1. **A small set of provably dead code** — one unused constant, one unused function, one dead DOM lookup that silently breaks the "Download HTML" feature, a dead `focusActive` parameter chain, one dead CSS block, and stray build artifacts.
2. **Three real correctness/interconnection gaps** — (a) SSE store-change events are dropped when they arrive during a *user-initiated* import (known issue, still open); (b) the server accepts stores the client will reject (validation asymmetry), so an agent can get `ok:true` for a plan that never renders; (c) `AGENT.md`'s "minimal valid train" example omits `number`, which the client requires — following the docs verbatim produces a saved-but-unrenderable store *and wipes the current map view in the process*.
3. **Open medium-impact optimizations** carried over from the previous review that are still valid: stop-feature memoization, `matchedRoutesGeoJson` growth, `clone()` JSON round-trips, and dirty-gated export-textarea refresh.
4. **Fragility notes** — duplicated schema constants between server and client, the weight-6 "legacy default" migration, a stale-`detail` retry, and a machine-specific path in `run-app.sh`.

Nothing found requires urgent action; the highest-value fixes are the three interconnection gaps (Phase 3 below), which are all small, isolated patches.

---

## 2. Project structure and data-flow map

```
Japan-Train-Map/
├── AGENT.md, README.md, jsonspec.md      docs (agent API, schema spec)
├── optimization-review.md,               prior audits (partially superseded)
│   route-display-optimization-plan.md,
│   route_break_audit.*                   route-break investigation artifacts
├── *.xlsx, 大大纵贯路线*.json             itinerary source data (not code)
├── run-app.sh                            launcher (hardcoded Node path — see §7)
├── __pycache__/                          ORPHAN: pyc for a deleted script
├── samples/                              example importable store (78 trains)
└── app/
    ├── server.js          Express: 5 dataset GETs (gzip sidecar + ETag),
    │                      train-store GET/PUT/DELETE, POST /api/agent/import,
    │                      GET /api/events (SSE), GET /api, static frontend
    ├── package.json       express only; npm start = node server.js
    ├── data/              rail-sections (12.1 MB), stations (3.3 MB),
    │                      default-trains, matched-routes (14 stale features),
    │                      matched-stops (EMPTY — 0 features), train-store.json,
    │                      N02-25_GML.zip (15 MB source archive, unserved)
    ├── scripts/           build-offline-tiles.py, gen_tiles.py (+ orphan pyc)
    └── public/
        ├── index.html     static shell; scripts: maplibre → i18n → railmap → app
        ├── i18n.js        zh/en strings + romaji/kana dictionaries (window.I18N)
        ├── railmap.js     MapLibre style/layer manager (window.RailMap)
        ├── app.js         everything else (35 numbered sections)
        ├── styles.css
        ├── basemap/, rail/, tiles/ (98 MB), vendor/maplibre
```

**Boot flow** (app.js §9): `DOMContentLoaded` → `loadAppData()` (5 parallel dataset fetches) → `restoreUiDateState()` → `initMap()` (basemap + rail package in parallel, bounded 9 s wait, `RailMap.attach`) → `bindEvents()` → `renderAll()` → `warmRouteCacheFromIndexedDb()` → progressive load of server store (or built-in defaults) → `scheduleRouteGraphPrebuild()` (idle) → `subscribeToStoreEvents()` (SSE).

**Data flow**: `trainStore` (in-memory) is the single source of truth for the UI. Mutations go through `persistAndRender()` / `saveTrainStore()` → debounced (450 ms) `PUT /api/train-store` with `X-Client-Id`. The server writes atomically and broadcasts `store-changed` over SSE; every *other* tab (and this tab for agent imports) reloads via `handleExternalStoreChange` → `replaceTrainStoreFromStoreProgressive`. Route geometry is solved client-side (Dijkstra on regional N02 subgraphs), cached in `runtimeRouteCache` (memory) and IndexedDB (cross-session, namespaced by rail-content hash), and deliberately **not** persisted in the store. Rendering: `renderTrainLayers` → signature-cached `buildRouteItems`/`buildDeckRouteRecords`/`buildDeckMarkerRecords` → `RailMap.setData/setMarkers/setSelected` (GeoJSON sources + paint/filter-only selection).

---

## 3. Function/module dependency map

Grouped by app.js section; classification: **[U]** definitely used, **[D]** probably used dynamically, **[?]** needs verification, **[X]** definitely unused (proof in §5).

| Area | Key functions | Status |
|---|---|---|
| §1 perf | `perfMeasure` (14 call sites), `installLongTaskObserver` | [U] |
| §3 display panel | `loadDisplaySettings`, `persistDisplaySettings`, `applyDisplaySettings`, `setupDisplaySettingsPanel` | [U] — wired in `bindEvents` |
| §4 labels/tooltip | `applyMapOpacity`, `computeGlobalEndpoints`, `computeScopedEndpoints`, `passesOnlyEndpoints`, `buildEndpointLabelSpec`, `updateEndpointLabels`, `layoutEndpointLabels`, `handleDeckHover`, `deckGetTooltip`, `hexToRgb` | [U] |
| §4 | `USE_DECKGL_ROUTES` | **[X]** |
| §5 simplify | `perpDistanceMeters`, `douglasPeuckerIndices`, `getRouteLinePairs` | [U] |
| §6 dates | `isValidDateString` … `reconcileSelectedDate` (12 fns) | [U] |
| §7–10 | `fetchJson`, `loadAppData`, boot handler, `subscribeToStoreEvents`, `handleExternalStoreChange`, `scheduleRouteGraphPrebuild` | [U] |
| §11 stations | `stationName`…`resolveStationCandidates` (15 fns) | [U] |
| §12–15 persist | `saveTrainStore`, `flushServerStoreSave`, `scheduleExportTextareaRefresh`, `loadTrainStoreFromServer`, IndexedDB helpers, `writeLocalJsonFile`, `openLocalJsonFile` | [U] |
| §16–20 import/CRUD | `runProgressiveAppend`, `warmRouteCacheForTrain`, `finalizeProgressiveLoad`, both `replaceTrainStore*`, `importCanonicalStoreAppendProgressive`, CRUD fns, export/import normalizers | [U] |
| §21–22 map/events | `buildMapLayersControl`, `initMap`, `handleDeckRouteClick`, `bindEvents` | [U] — every `getElementById` in `bindEvents` resolves to an existing HTML id (verified: 0 missing, 0 unreferenced ids) |
| §23–24 sidebar/editor | `renderAll`, `renderDateButtons`, `pickTrain`, `selectTrain`, `renderTrainList`, `renderEditor`, `renderStopsTable`, `deriveTrainBranches`, stop mutators | [U] |
| §25–26 render | `renderTrainLayers`, `renderTrainMarkers`, `computeRouteSignature`, `buildRouteItems`, `renderRoutesInView`, `buildDeckOverlapMap`, `buildDeckRouteRecords`, `deckMarkerRecord`, `buildDeckMarkerRecords`, `invalidateDeckRouteCaches` | [U]; `focusActive` **parameter chain is dead** (see §5) |
| §27–29 solving | `generateMatchedRouteFeaturesForTrain`, graph builders, regional-graph LRU, `solveRouteSectionOnDemand`, hint builders, `dijkstraFromCandidateSources`, `MinHeap` | [U] |
| §30–32 geometry/fit | `iterateGeometryLines`, `getMatchedRouteFeatures`, `getStopFeature`, style helpers, bounds/fit fns, progress UI | [U] |
| §33 validation | `validateTextareaJson`, `validateTrainStore`, `validateTrain`, `warnBranchLeak` | [U] |
| §34 popups | `buildStopPopup`, `buildTrainSegmentPopup`, `popupHtml`, `routeSectionForSegment` | [U] |
| §34 | `stopTooltipHtml` | **[X]** |
| §35 utils | `setStatus`, `normalizeColor`, `downloadText`, `escapeHtml`, `escapeAttr` | [U] |
| §35 | `buildPortableHtml` | [U] by the button, but **internally broken** (see §4.5) |
| i18n.js | `t`, `placeName`, `trainName`, `setLang`, `getLang`, `onChange`, `applyStatic` | [U] |
| i18n.js | `nameEn` | [?] — exported on `window.I18N`, zero callers in repo; public API, keep |
| railmap.js | entire `RailMap` API (`attach/setData/setMarkers/setSelected/setFocusBoost/setVisible/setMarkerVisibility/setNetworkVisible/setNetworkStationsVisible/setBasemapMode/setFadeOpacity/loadBasemap/loadNetwork/buildBaseStyle`) | [U] — every method called from app.js |

Dynamically-referenced items verified as **used** (do not remove): `I18N.t("stoptype." + type)` covers the five `stoptype.*` keys that plain grep reports as unused; `data-stop-field`/`data-stop-action`/`data-branch-ride` dataset handlers; `.maplibregl-popup-content` CSS (MapLibre-generated class); `route_geometry_cache` in the import allow-list (legacy-file compatibility — accepted then intentionally dropped).

i18n coverage: 140 string keys defined; **all 140 are referenced** (135 statically, 5 via the dynamic `stoptype.` prefix).

---

## 4. Interconnection correctness report

### 4.1 Frontend ⇄ server routes — ✅ consistent
Every frontend call resolves to a defined route: `./api/{rail-sections,stations,default-trains,matched-routes,matched-stops}` ⇄ the `DATA_FILES` loop; `./api/train-store` GET/PUT/DELETE; `./api/events` SSE (`store-changed` event name matches on both sides); `X-Client-Id` sent on PUT/DELETE and echoed as `origin` — self-echo suppression works. `API_BASE = "./api"` (document-relative) is honored by every call including `EventSource`.

### 4.2 Server accepts what the client rejects — ⚠️ validation asymmetry (**highest-priority finding**)
`server.js coerceStore()` checks only `{schema_version ∈ [1.2,1.3], trains: Array}`. The client (`validateTrainStore` → `assertOnlyKeys` + `validateTrain`) additionally rejects: unknown top-level keys, unknown train/stop/section keys, missing `id/number/name/origin/destination`, `<2` stops, non-boolean `ride_segment`, bad `route_policy`, bad colors.

Consequence chain for an agent import that passes the server but fails the client:
1. `POST /api/agent/import` → server saves it, returns `ok:true`, broadcasts SSE.
2. Every open tab runs `handleExternalStoreChange` → `replaceTrainStoreFromStoreProgressive` → **`resetTrainStoreForProgressiveLoad()` empties the in-memory store and repaints** → `appendImportedTrain` throws on the first invalid train → caught in `handleExternalStoreChange`'s `catch` as a console warning only.
3. Result: the map goes blank (or partially loaded), the invalid store remains saved on disk, and on the next boot `loadTrainStoreFromServer` → `validateTrainStore` throws → silently falls back to built-in defaults while `data/train-store.json` still holds the agent's plan.

The agent believes the import succeeded (`ok:true`, `live_clients ≥ 1`); the user sees defaults. **State desynchronization with no visible error.**

### 4.3 AGENT.md contradicts client validation — ⚠️ doc/code mismatch
`AGENT.md`'s "Minimal valid train" example has no `number` field, but `normalizeImportedTrain` throws `"Train … must contain number."` (app.js:2464). Posting the documented example triggers exactly the failure chain in §4.2. (The `samples/` store is fine — every train carries `number`.) Fix either the doc or relax the client (the doc fix is zero-risk).

### 4.4 SSE events dropped during a user-initiated import — ⚠️ still open (was optimization-review #9)
`handleExternalStoreChange` early-returns with `liveReloadPending = true` when `importInProgress` (app.js:1173-1176). The flag is only consumed in the `finally` of an invocation that got **past** the guard. A store change arriving while the *user's* textarea/file import holds `importInProgress` is therefore dropped until the next SSE event. Additionally, the retry at app.js:1211 re-dispatches with the **stale `detail`** — if the missed event was `{cleared:true}` and the retried one wasn't (or vice versa), the wrong branch runs (a cleared store re-fetch gets 404 → `savedStore` null → silent return → stale map).

### 4.5 "Download HTML" produces a non-portable file — ⚠️ silently degraded feature
`buildPortableHtml()` (app.js:7671) looks up `#data-default-trains`, which no longer exists anywhere (verified: only reference in the repo is this lookup; the embedded-JSON-in-HTML era ended when datasets moved to `/api/*`). The guard makes it a silent no-op, so the button downloads a copy of the live DOM whose `<script src>`/`fetch("./api/…")` references cannot resolve when opened from disk. The feature can't work as named in the current architecture.

### 4.6 UI wiring — ✅
All 24 button/checkbox/input handlers in `bindEvents` and the dynamically-built controls (display sliders/toggles, date buttons, train cards, stops-table inputs, branch master checkboxes, layers control) connect to existing state mutators, and every mutator ends in the correct persist/render combination (`persistAndRender`, or the narrower `saveTrainStore` + targeted re-render for hot paths). `focusZoomEnabled`, `mapFollowsSelectedDate`, `selectedDate`, `manualDates` persist and restore correctly through `persistUiDateState`/`restoreUiDateState`. Language switching re-renders both static (`applyStatic`) and dynamic (`I18N.onChange`) UI.

Minor inconsistencies (cosmetic, not broken):
- `buildMapLayersControl` labels ("Limited Express Routes", "Stops", …) and `rebuildSelectedRoute`/`generateMatchedRouteFeaturesForTrain` status strings are hardcoded English, bypassing i18n.
- Two toolbar buttons do the same thing: `#save-local-json` and `#download-json` handlers are byte-identical (`writeLocalJsonFile(exportTrainStore(), true)` + same status). Despite its label, "下載 JSON" never plain-downloads when the FS Access API exists. Duplicate logic + misleading label.
- `selectedTrainId` vs `focusedTrainId`: maintained in parallel, always set together except `deleteTrain` (selection moves to a neighbor, focus clears) — intentional but undocumented hidden coupling; `RailMap.setSelected(focusedTrainId)` while list highlight uses `selectedTrainId`.

### 4.7 i18n internals — two micro-bugs
- `setLang()` (i18n.js:550-554): the same-language early-exit is broken — `if (!SUPPORTED.includes(lang) || lang === currentLang) { if (!SUPPORTED.includes(lang)) return; }` falls through when `lang === currentLang`, re-running `applyStatic` + all listeners (full `renderAll`) for a no-op change. The comment says the opposite.
- `applyStatic` iterates `[data-i18n-html]` and `[data-i18n-title]`; neither attribute exists anywhere (verified) — two dead `querySelectorAll` loops. Harmless; keep only if future markup will use them.

### 4.8 Persistence / reload / clear paths — mostly ✅
- Debounced autosave + in-flight re-flush + `visibilitychange` flush: correct, no lost-write window found in the happy path.
- `#clear-storage`: cancels the pending debounce correctly, but a PUT already **in flight** when DELETE is issued can land after it server-side and resurrect the store. Narrow race (450 ms window + network), worth a guard.
- Clearing from another tab: `cleared:true` → defaults fallback — correct.
- The clearing tab itself intentionally keeps its in-memory trains (message tells the user a reload restores defaults) — consistent with the status text.

### 4.9 Schema/back-compat — ✅ with a fragility
1.2 and 1.3 both accepted everywhere; stores always written as 1.3; `route_geometry_cache` tolerated on import. But `ACCEPTED_SCHEMA_VERSIONS`/default-version constants are **duplicated** in server.js and app.js — a future 1.4 bump must touch both or agent imports and UI loads will disagree (same failure mode as §4.2).

### 4.10 Data-file observations
- `matched-stops.json` has **0 features** — `getStopFeature`'s explicit-feature lookup always misses and every stop falls to `resolveStationForTrain`. Endpoint kept for compatibility; the per-call cost is trivial (empty array) but the code path is effectively vestigial.
- `matched-routes.json` has 14 features with template ids from an old build; they only matter via the `getMatchedRouteFeatures` fallback filters. Harmless, but stale data in the repo.

---

## 5. Dead code / unused candidates (with proof)

| # | Item | Location | Evidence | Risk | Plan |
|---|---|---|---|---|---|
| D1 | `const USE_DECKGL_ROUTES = true` | app.js:620 | grep: single occurrence in repo; never read | None | Delete constant + its comment sentence |
| D2 | `function stopTooltipHtml(props)` | app.js:7570-7577 | grep: single occurrence; superseded by `deckGetTooltip`'s marker branch | None | Delete |
| D3 | `focusActive` parameter chain | app.js:4105 (`computeRouteSignature`), 4125 (`buildRouteItems`), 4548 (`buildDeckRouteRecords`), + `cachedRouteFocusActive` (1019, 4050, 4164) | Parameter is never referenced inside any of the three bodies (selection was deliberately removed from the signature in the P1 refactor); `cachedRouteFocusActive` is written and passed but never influences output | Low | Remove the parameter from the three signatures and call sites; keep the local `focusActive` in `renderTrainLayers` (still used for `scopeActive` ordering) |
| D4 | `#data-default-trains` lookup | app.js:7672 | grep: id exists nowhere in HTML/JS; guard makes it a silent no-op | None alone | See §4.5 — decide the feature's fate first |
| D5 | `.leaflet-tooltip.line-label` CSS (2 rules) | styles.css:600-613 | Leaflet fully removed (index.html loads only MapLibre); class generated nowhere | None | Delete both rules |
| D6 | `applyStatic`'s `data-i18n-html` / `data-i18n-title` loops | i18n.js:531-539 | Neither attribute occurs in HTML or generated JS (verified programmatically) | None | Optional delete; harmless to keep for future markup |
| D7 | `I18N.nameEn` | i18n.js:502-504, 603 | Zero callers in repo | Low (public API) | **Needs verification** — keep unless you confirm no external consumer |
| D8 | `__pycache__/_build_trains_data.cpython-310.pyc` (repo root), `app/scripts/__pycache__/` | filesystem | Source `_build_trains_data.py` no longer exists; pyc artifacts committed | None | Delete dirs; add `__pycache__/` to `.gitignore` |
| D9 | Duplicate `#download-json` handler body | app.js:3050-3059 vs 2972-2981 | Identical statements | Low | Phase 1: extract shared helper; do **not** remove the button (public UI) |
| D10 | Duplicated HTML-escape helpers | `escapeHtml` (app.js) vs `escHtml` (railmap.js, IIFE-scoped) | Same table; railmap is deliberately dependency-free | None | Keep (module isolation is intentional); note only |
| D11 | Stale `matched-routes.json` template features / empty `matched-stops.json` | app/data | See §4.10 | Low | Keep endpoints (API compat); optionally regenerate/empty the stale features |

Everything else that superficially looks removable was proven live: the five `stoptype.*` keys (dynamic key construction), `route_geometry_cache` allow-list entry (legacy import compat), `PERF_DEBUG` machinery (opt-in flag), `.maplibregl-popup-content` (library-generated class), the `raster` basemap option (offline tiles exist, 98 MB), and all 55 HTML ids (0 unreferenced).

---

## 6. Optimization opportunities

Confirmed fixed since the last review (no action): gzip+ETag dataset delivery, multi-source Dijkstra, O(N) import validation, overlap-map/record/marker signature caches, zero-rebuild selection (paint/filter only), pass-dot LOD via layer `minzoom`, debounced search/autosave/textarea.

Still open, ordered by impact:

| # | Impact | Item | Why | Proposed fix | Regression risk |
|---|---|---|---|---|---|
| O1 | Medium | `getStopFeature` re-resolves stations on every marker rebuild (app.js:7038) | `buildDeckMarkerRecords` calls it for every stop whenever the route signature changes; ambiguous names trigger `trainAnchorCoordinates` = O(stops²) `resolveStationCandidates` per train. The pass-through twin is memoized (`_computedPassThroughCache`); explicit stops are not | Memoize per `(train.id, stop name/code, template key)` with the same key style as `_computedPassThroughCache` | Low — pure cache; invalidation key must include stop name + code |
| O2 | Medium | `matchedRoutesGeoJson.features` grows unbounded (app.js:5080) | Every cache-miss solve appends concrete features; editing sections re-solves and appends again, old `train_id` entries never removed. Memory leak + the fallback filter can walk stale entries | Before push, remove existing features with same `train_id`; or stop mirroring (runtime cache + IndexedDB are authoritative) — keep the fallback read path intact | Low; verify the `route_id` fallback still finds pre-seeded routes for trains whose solve fails |
| O3 | Medium-low | `clone()` = JSON round-trip in warm paths | `getFeaturePathCoordinates` (app.js:7188) clones coordinates on every bounds/fit call; `saveSelectedFields` (3818) clones the entire store to validate one train | Return `coordinates` without cloning (callers only read — verified for `featureCollectionBounds`, `toLatLng`); in `saveSelectedFields`, validate `next` alone + id-uniqueness instead of cloning the store | Low-medium — must confirm no caller mutates; do under a quick manual test |
| O4 | Medium-low | `selectTrain` schedules a full-store serialization on every click (app.js:3405) | `scheduleExportTextareaRefresh` → `exportTrainStore()` runs `getRideRouteSectionsForTrain` (station resolution for unmatched pairs) for all trains, 300 ms after every selection, though nothing changed | Gate on a store-revision counter / `storeSaveDirty`; cache last serialized text | Low — textarea content unchanged by definition when store is clean |
| O5 | Low | `warnBranchLeak` runs twice per imported train | Once in `appendImportedTrain`'s `validateTrain`, again in `finalizeProgressiveLoad`'s full `validateTrainStore` | Skip `warnBranchLeak` in the final full pass (advisory-only console output) | None (console noise only) |
| O6 | Low | `validateTextareaJson` is O(N²) (app.js:7351) | `validateTrainStore(nextStore)` inside the per-train append loop | Validate each train once, then one full pass | None — button-triggered only |
| O7 | Low | `dedupeStationFeatures` builds `JSON.stringify` signatures per call (app.js:1397) | Runs inside `resolveStationCandidates`, the hottest resolver | Cache the signature on the feature object (WeakMap), or key on `code|name|line|operator` + first coord directly | Low |
| O8 | Low | Unbounded session caches | `_computedPassThroughCache`, `runtimeRouteCache`, `regionalGraphCache` (this one IS budgeted), `graph.stationSnapCache` accumulate across edits | Size-cap the first two (simple LRU like `regionalGraphCache`) | Low |
| O9 | Low | Sort comparator recomputes date/departure per comparison (app.js:840) | Regex + parse per compare; N≈90 fine, grows with N log N × cost | Decorate-sort-undecorate when it shows up in a profile | None |
| O10 | Info | `ensureGzipSidecar` rebuilds when mtimes are equal (server.js:71) | `gzStat.mtimeMs > sourceStat.mtimeMs` strict; equal-mtime (coarse FS clocks) rebuilds each request | Use `>=` | None |

Not worth doing now (documented, deliberate trade-offs): full-coordinate rail hash at boot (tens of ms, exact invalidation); progressive-import per-batch overlap rebuild (bounded by the 120 ms batcher + final authoritative render); main-thread solving (IndexedDB warm cache makes cold solves rare; a Worker is a Phase-4 item).

---

## 7. Risky or fragile logic

1. **Validation asymmetry server⇄client** (§4.2) — the top correctness risk; silent state divergence.
2. **`liveReloadPending` drop + stale `detail` retry** (§4.4).
3. **Failed progressive replace leaves an emptied in-memory store** — `resetTrainStoreForProgressiveLoad()` runs before any train is validated; one bad train aborts mid-load with a partial/empty map while the server store is intact. A pre-validation pass (dry-run `normalizeImportedTrain` over all trains before reset) would make replace transactional.
4. **Duplicated protocol constants** — `ACCEPTED_SCHEMA_VERSIONS`, `DEFAULT/SCHEMA_VERSION` defined in both server.js and app.js; must be bumped in lockstep.
5. **`canonicalStyle` weight-6 migration** (app.js:2160) — any train explicitly set to `weight: 6` or `unridden_opacity: 0.22` is silently rewritten to the new defaults forever. Documented, but a user-visible surprise; consider a one-time migration flag instead of value-sniffing.
6. **`#clear-storage` vs in-flight PUT race** (§4.8).
7. **`run-app.sh`** hardcodes `/Users/sager/.cache/codex-runtimes/.../node` — breaks on any other machine/runtime relocation; fall back to `command -v node`.
8. **`buildPortableHtml`** (§4.5) — feature silently produces a broken artifact.
9. **`i18n.setLang` same-language re-render** (§4.7) — no data risk, just a wasted full re-render if ever triggered programmatically.
10. **`stationName()` falls back to `properties.id`** — returns undefined-ish labels if a feature has none of the five name fields; never observed in current data, defensive only.

Checked and found sound: autosave debounce/in-flight re-flush; import lock (`importInProgress`) across all three entry paths; SSE self-echo suppression; EventSource auto-reconnect; atomic temp-file+rename writes on the server (UI and agent paths share `writeTrainStore`); the append-mode upsert; IndexedDB best-effort failure handling; the hover-expand engage/release crossfade state machine in railmap.js (including the queued-collapse cancellation at `_expandT === 1`); wheel/gesture pinch handling; map bound clamping on resize.

---

## 8. Recommended cleanup/refactor plan

### Phase 1 — no-risk cleanup (pure deletions/doc fixes, zero behavior change)
1. Delete `USE_DECKGL_ROUTES` (app.js:620) and `stopTooltipHtml` (app.js:7570-7577).
2. Delete `.leaflet-tooltip.line-label` rules (styles.css:600-613).
3. Delete `__pycache__/` dirs; add `__pycache__/` to `.gitignore`.
4. Fix `AGENT.md` minimal example: add `"number": "1"` (and note that `number/name/origin/destination` are required by the renderer).
5. `run-app.sh`: fall back to `command -v node` when the hardcoded path is missing.
6. Extract the shared body of `#save-local-json`/`#download-json` into one helper (buttons unchanged).

*Expectation: byte-identical UI/API behavior. Test: boot, import sample store, click every toolbar button.*

### Phase 2 — low-risk optimization
1. Remove the dead `focusActive` params (D3) — mechanical signature change, callers updated in the same commit.
2. O4 dirty-gated export-textarea refresh; O5 skip duplicate `warnBranchLeak`; O6 linear `validateTextareaJson`; O10 server mtime `>=`.
3. O1 stop-feature memoization; O2 `matchedRoutesGeoJson` dedupe-on-push.

*Expectation: identical rendered output; faster selection clicks and imports. Test: import 78-train sample, click through 10 trains, edit a stop name, verify markers/routes/popups unchanged; edit a train's sections twice and confirm no duplicate features (`matchedRoutesGeoJson.features` count stable).*

### Phase 3 — interconnection fixes (behavior-preserving hardening)
1. **Server-side full validation**: port `validateTrainStore`'s rules into `coerceStore` (or a shared check) so `PUT` and `/api/agent/import` reject what the client rejects, with a descriptive 400. Keeps every valid payload working; only currently-broken payloads change outcome (from silent divergence to explicit error).
2. **Consume `liveReloadPending` after user imports**: check the flag in both `finally { importInProgress = false }` blocks and re-dispatch; store the latest SSE `detail` in a variable instead of closing over the stale one.
3. **Transactional replace**: dry-run-normalize all incoming trains before `resetTrainStoreForProgressiveLoad()`.
4. **Clear-vs-inflight guard**: have `#clear-storage` await any in-flight save (`serverStoreSaveInFlight`) before DELETE.
5. Decide `#download-html`: either remove the button + `buildPortableHtml` (a behavior change — needs your sign-off) or re-implement by inlining the current store into a self-contained file.

*Test: agent-import an invalid store → expect 400 and unchanged map; import mid-edit from a second tab → first tab catches up; clear while editing rapidly → store stays cleared.*

### Phase 4 — larger refactors (need tests first)
1. Share schema constants/validators between server and client (single module consumed by both, or generated).
2. Web Worker for route solving (only if cold-cache imports still feel slow).
3. i18n the layers control + solver status strings; fix `setLang` early-exit.
4. Event delegation for the stops table.

---

## 9. Manual regression test checklist

Boot & data: server starts; `/api` lists datasets; page loads with saved store (or defaults + warning); date bar restores last selection; display sliders restore.
Import: paste sample JSON → validate → apply (progress bar, one train at a time, final sorted list); open local JSON; append-mode agent import (`?mode=append`) upserts by id; invalid JSON → error status, store unchanged.
Live refresh: two tabs, edit in one → other reloads; agent import → open tab redraws; DELETE store → open tabs fall back to defaults; editing tab does not self-reload.
Editing: add/duplicate/delete/delete-all; move up/down; field save incl. id change; stop add/edit/move/delete; ride-segment toggle mirrors adjacent pass-throughs; branch master checkbox; rebuild route.
Map: click route → select + popup; click marker → stop popup; hover → tooltip + spotlight dim; overlapped stretch → parallel-lane fan, lane tooltip "並行 i/n", lane click selects; zoom across z9 → pass dots appear/disappear with no stutter; layers control (basemap modes, 4 toggles); auto-focus toggle; date click → dim others + fit; "地圖僅顯示當前日期" hides others.
Persistence: edits autosave (status line); reload restores; clear-storage → reload shows defaults; save/download JSON writes the file; export textarea matches store.
i18n: switch zh⇄en → all sections, buttons, placeholders, tooltips, on-map labels update; reload keeps language.
Display settings: every slider live-updates both lines and dots; reset restores defaults; settings survive reload.

---

## 10. Proposed patches (not applied)

Only Phase-1/2 samples are given as diffs; Phase-3 items should land with the tests above.

**P1 — dead constant/function/CSS** (behavior: none)
```diff
--- app/public/app.js
-// GPU route rendering. Train routes, markers, ... The old Leaflet SVG fallback path is gone with Leaflet itself.
-const USE_DECKGL_ROUTES = true;
-
@@
-function stopTooltipHtml(props) {
-  const pr = props || {};
-  const name = escapeHtml(pr.name || "");
-  const times = [];
-  if (pr.arrival) times.push(`到 ${escapeHtml(pr.arrival)}`);
-  if (pr.departure) times.push(`发 ${escapeHtml(pr.departure)}`);
-  return times.length ? `${name}<br>${times.join("　")}` : name;
-}
--- app/public/styles.css
-.leaflet-tooltip.line-label { ... }
-.leaflet-tooltip.line-label::before { display: none; }
```

**P2 — AGENT.md minimal example** (doc-only)
```diff
     {
       "id": "20260703_test_001",
       "date": "2026-07-03",
+      "number": "1",
       "name": "踊り子1号",
```

**P3 — consume pending live-reload after any import** (behavior: missed SSE events now applied; store the latest detail)
```diff
--- app/public/app.js
-let liveReloadPending = false;
+let liveReloadPending = false;
+let liveReloadPendingDetail = null;
@@ handleExternalStoreChange
-  if (importInProgress) {
-    liveReloadPending = true;
-    return;
-  }
+  if (importInProgress) {
+    liveReloadPending = true;
+    liveReloadPendingDetail = detail;   // keep the LATEST event
+    return;
+  }
@@ (shared helper, called from all three `finally { importInProgress = false }` sites)
+function drainPendingLiveReload() {
+  if (!liveReloadPending) return;
+  liveReloadPending = false;
+  const d = liveReloadPendingDetail;
+  liveReloadPendingDetail = null;
+  setTimeout(() => handleExternalStoreChange(d || {}), 0);
+}
```
(then `finally { importInProgress = false; drainPendingLiveReload(); }` in `replaceTrainStoreFromJsonText`, `replaceTrainStoreFromStoreProgressive`, `importCanonicalStoreAppendProgressive`, and the existing `finally` in `handleExternalStoreChange` simplifies to the same helper.)

**P4 — server-side validation parity** (behavior: invalid payloads get 400 instead of silently corrupting; valid payloads unchanged). Port the client's `assertOnlyKeys`/per-train checks into `coerceStore`; recommended as a shared function to avoid a third copy of the rules.

**P5 — `matchedRoutesGeoJson` dedupe** 
```diff
-  concrete.forEach((feature) => matchedRoutesGeoJson.features.push(feature));
+  matchedRoutesGeoJson.features = matchedRoutesGeoJson.features.filter(
+    (f) => (f.properties || {}).train_id !== train.id,
+  );
+  concrete.forEach((feature) => matchedRoutesGeoJson.features.push(feature));
```

**P6 — dirty-gated export textarea** — add a monotonically increasing `storeRevision` bumped in `saveTrainStore`; `scheduleExportTextareaRefresh` caches `{revision, text}` and skips serialization when unchanged.

---

*Marked "needs verification" and left untouched: `I18N.nameEn` (public API, possible external consumers), the `raster` basemap mode (used offline), `matched-routes.json` stale features (fallback read path), and the `#download-html` button (removal is a feature decision, not a cleanup).*
