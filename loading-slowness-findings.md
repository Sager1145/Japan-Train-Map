# Why the loading process is slow — and fixes

Diagnosis of the boot/load path for the Japan rail map, with fixes framed
around the **railprint (jp-2025)** rail package.

## What actually loads at boot

The boot sequence (`app.js` `DOMContentLoaded`) runs, in order:

1. `loadAppData()` — **awaits `Promise.all` of 5 datasets before anything else runs**:
   | endpoint | raw | gzipped | used for |
   |---|---|---|---|
   | `rail-sections` | 12.1 MB | 2.4 MB | route-solver graph (built **lazily**, not at boot) |
   | `stations` | 3.3 MB | 456 KB | station candidate index |
   | `default-trains` | 4 KB | 1 KB | fallback store |
   | `matched-routes` | 151 KB | 42 KB | prematched routes |
   | `matched-stops` | 0.2 KB | 0.2 KB | prematched stops |
2. `initMap()` — downloads the railprint package **`rail/jp-2025.json` (7.4 MB, 594 lines / 9,442 segments / 10,034 stations)** + basemap, then transforms it into GeoJSON on the main thread.
3. Route cache warm + progressive route solve + render.

## Root causes (ranked by impact)

### 1. The railprint package `jp-2025.json` is served **uncompressed** — the single biggest miss
`server.js` gzips the `/api/*` datasets (lazy `.gz` sidecars + ETag), but
`jp-2025.json` is served by `express.static(PUBLIC_DIR)` (line 391) with **no
compression middleware**. So the railprint package goes over the wire as the
full **7.4 MB** instead of ~1.3–1.5 MB. It is the only large asset in the app
not compressed. On a typical connection this alone is several seconds.

### 2. `cache: "no-store"` defeats the server's own caching
`fetchJson()` (app.js ~line 955) fetches every `/api` dataset with
`{ cache: "no-store" }`. The server sets `Cache-Control: max-age=3600` **and** a
weak ETag specifically so reloads get a `304`. `no-store` throws all of that
away — **every reload re-downloads rail-sections (2.4 MB) + stations (456 KB)
in full**, and the ETag revalidation never fires.

### 3. Boot blocks on `rail-sections.json` (12 MB) that it doesn't need yet
`loadAppData` awaits **all five** datasets before `initMap` runs. But
`rail-sections` is only consumed by `getRuntimeRouteGraph()` /
`scheduleRouteGraphPrebuild()`, which are explicitly built **lazily / in the
background** (see comments at app.js ~5250: "never eagerly at startup"). So the
map render is blocked behind a 2.4 MB download whose data isn't touched until a
route actually needs solving. The critical path pays for it twice over: the
gzipped rail-sections **and** the uncompressed jp-2025 both sit in front of
first paint.

### 4. Main-thread transform of the railprint package
`RailMap.loadNetwork()` (railmap.js ~136) does `await res.json()` (~130 ms
parse) then rebuilds 9,442 segment features + 10,034 station features into
GeoJSON across several `Map`s synchronously. Not the headline cost, but it lands
on the main thread right when the map is trying to appear.

## Recommended fixes (in priority order)

1. **Compress `jp-2025.json`.** Fastest win. Either add `compression` middleware
   for static files, or — to match the pattern already in `server.js` — serve
   the railprint package through the same gzip-sidecar + ETag code path as the
   `/api` datasets instead of `express.static`. Expected: 7.4 MB → ~1.4 MB.

2. **Drop `cache: "no-store"` in `fetchJson`.** Use the default (or
   `cache: "no-cache"` if you want mandatory revalidation). The ETag +
   `max-age=3600` already guarantee freshness, and reloads become `304`s instead
   of multi-MB downloads.

3. **Defer `rail-sections` (and ideally `stations`) off the boot critical path.**
   Load the map + railprint network first so pixels appear, then fetch
   `rail-sections` in the background before the first route solve (it's already
   lazy on the consume side). Keep only the small datasets
   (`default-trains`, `matched-routes`, `matched-stops`) in the blocking
   `Promise.all`.

4. **Give `jp-2025.json` the same `Cache-Control`/ETag** as the API datasets so
   the railprint package is a `304` on reload too.

5. **(Optional) Lighten the railprint transform.** Have the railprint export
   ship render-ready GeoJSON (pre-split, colors baked in) so `loadNetwork` does
   less main-thread work, or move the transform into a Web Worker.

### Net effect
Fixes 1–3 remove roughly **9+ MB of uncompressed / redundant transfer from the
critical path** and make reloads near-instant via `304`s — without changing any
map behavior or the railprint styling.

## Verification checklist
- DevTools Network on cold + warm reload: confirm `jp-2025.json` shows
  `Content-Encoding: gzip` and warm loads return `304` for the datasets.
- Confirm first map paint no longer waits on the `rail-sections` response.
- Confirm route solving still works after `rail-sections` is deferred (trigger a
  route that isn't in `matched-routes`).
