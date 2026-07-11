# Performance optimizations applied — 2026-07-11

Implements priorities **P2–P6** from the diagnosis. **P1 (route solving → Web
Worker) was deferred** by decision: it forces the synchronous solve path to
become async through the whole render pipeline and can't be browser-verified in
this environment, so it belongs in a dedicated, verified follow-up.

## What changed

### P6 — `jp-2025.json` (and other static JSON) now gzipped + cached · `server.js`
The 9.2 MB rail package was served raw with `Cache-Control: max-age=0`, so every
reload re-downloaded it in full. It now goes through the same gzip-sidecar + weak
ETag path as the `/api` datasets.
- **9.18 MB → 1.68 MB** over the wire (measured), `max-age=86400`, revalidates to **304**.
- Generalized into a shared `serveGzippable()` helper reused by the datasets and a
  new static-JSON handler (path-traversal guarded) placed before `express.static`.
- New `.gz` sidecars are gitignored.

### P5 — first paint no longer blocks on the 12 MB solver dataset · `app.js`
- `loadAppData()` now blocks boot only on the small render-critical datasets;
  `rail-sections.json` is fetched in parallel and awaited by `ensureRailSectionsLoaded()`
  right before the IndexedDB cache warm / first solve (both need it for the railHash).
  The map paints without waiting on it.
- `fetchJson()` dropped `cache: "no-store"`, so reloads use the server's ETag +
  `max-age` (304 / from-cache) instead of re-downloading rail-sections + stations in full.

### P4 — selection no longer costs ~4 s · `app.js`, `railmap.js`
- **Auto-focus now defaults OFF.** The fitBounds zoom on selection was what forced
  the overlap-offset recompute + full-route GPU re-upload (~4 s). Off → ~270 ms.
  Existing users keep their saved choice (persisted in localStorage).
- On a genuine zoom with overlaps, `renderRoutesInView()` now calls a new
  `RailMap.updateLaneSpacing()` that re-uploads **only** the invisible pick source,
  skipping the byte-identical base route source — halving the zoom re-upload.

### P3 — regional-graph cache thrash · `app.js`
- Steady node budget **140k → 300k** (a single cross-Japan region is 50k–72k nodes,
  so the old budget guaranteed evict-then-rebuild; the full-Japan graph is ~377k, so
  300k stays well within the tolerated envelope).
- During a progressive load, eviction is **suspended up to a 600k transient cap** so a
  region built for an early train survives for a later one; `finalizeProgressiveLoad()`
  trims back to the steady budget. Extracted `trimRegionalGraphCache(target)`.

### P2 — negative cache for unsolvable routes · `app.js`
- New in-memory `runtimeRouteNegativeCache` + IndexedDB marker (`__neg__::` prefix,
  namespaced by railHash). A train that solves to zero geometry is remembered, so
  prewarm / final render / live refresh / future sessions skip the doomed
  graph-build + Dijkstra. Editing a train changes its cacheKey, so a real fix
  re-solves automatically. This is the main lever on the ~53 s hot reload.
- **Data-fix finding:** analysis of the current `train-store.json` against
  `stations.json` (faithful replica of the app's endpoint resolver) found **no
  station code/name typos**. The only endpoints that resolve to zero candidates are
  8 stops across 4 **羽後交通 bus routes** around Lake Tazawa (乳頭線 / 田沢湖一周線) —
  legitimately not on the N02 rail network. Fabricating stations for them would be
  wrong; the negative cache is the correct handling. The report's 132/149/25 counts
  were runtime accumulations across repeated solve passes, not distinct data errors.

## Verification done
- `node --check` on all three edited files — pass.
- Server boots; `/`, `/app.js`, `/railmap.js`, `/api/*`, `/rail/jp-2025.json` all 200.
- `jp-2025.json`: `Content-Encoding: gzip`, 1.68 MB, `If-None-Match` → 304.
- HTML/JS passthrough unaffected by the new static-JSON handler.

## To verify in your browser (needs the server running locally)
1. `cd app && npm start`, open the app, DevTools → Network:
   - `jp-2025.json` shows `content-encoding: gzip`; warm reload shows **304s** for datasets.
   - First map paint appears before `rail-sections` finishes.
2. Route solving still works (open a train not in the matched-routes cache).
3. Click a train card → view stays put (auto-focus off), selection feels instant.
   The auto-focus toggle button still turns zoom-on-select back on.

## Notes
- Pre-edit backups are in `app/.perf-backup/` (gitignored) — delete when satisfied.
- **P1** remains open: move `solveRouteSectionOnDemand` + graph build + Dijkstra into a
  Web Worker with the two datasets transferred once, and make the solve path async
  with a main-thread fallback. Verify route geometry byte-matches the current output
  on a full cold solve before enabling by default.
