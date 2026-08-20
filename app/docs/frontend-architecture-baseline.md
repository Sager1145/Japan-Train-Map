# Frontend architecture baseline

This is the pre-refactor contract for the ordered classic-script frontend. Run
`npm run report:frontend` for the deterministic function inventory, file-level
dependency map, shared mutable binding readers/writers, side-effect hints, and
conservative reachability classifications. The report follows the script list
in `public/index.html`, which is also replayed by
`scripts/lib/app-family-sandbox.mjs`.

The report is evidence, not a dead-code oracle. In particular, `uncertain`
means that a declaration has no caller the static pass can prove. It must still
be checked against global property access, UMD exports, DOM wiring, workers,
the VM harness, build scripts, tests, and generated/static artifacts before it
can be removed.

## Runtime flows

### Application boot

`boot()` in `app.js` resolves the persisted country first, starts basemap and
rail-package fetches, then loads the active country's store, readings, solver
datasets, and matched-route data. `initMap()` consumes the prestarted map
assets. Event binding and the first render happen only after the shared data
needed by those paths has been installed.

### Store mutation, persistence, and rendering

Event handlers call operations in `app-store-ops.js` or editor helpers. Those
operations mutate `trainStore` and generally converge on
`persistAndRender()`. That function schedules persistence and refreshes the
date workspace, train list, editor, routes, statistics, and export state. This
broad invalidation is intentionally retained in the first cleanup stage.

### Import and progressive loading

`app-events.js` selects an import command. `app-import.js` coordinates source
fetching or file text, validation and normalization through
`app-validation.js`/`app-store-ops.js`, progressive train append, route-cache
seeding or warming, incremental rendering, and final persistence.
`CountrySession` owns the cross-domain country transition instead of the
import module.

### Route cache miss, solve, and repaint

`app-route-render.js` asks `app-route-features.js` for display features.
`app-route-graph.js` builds the deterministic solve context and route-cache key.
A hit returns cached template features. A miss is queued by `app.js`, solved by
the route graph/solver family, published to the positive or negative cache,
persisted when applicable, and followed by another route render. Cache key and
feature generation are compatibility contracts.

### Country switch

`CountrySession.switchTo()` flushes the current persistence state, changes
`activeCountry`, resets store/selection/import and solver state, swaps map
constraints and the rail package, reloads readings and country datasets,
restores the target country's store/cache, then renders. Country datasets and
IndexedDB namespaces remain isolated.

### Backend write, SSE, and external-tab reload

Backend persistence stages a recovery journal before the debounced write.
`saveTrainStoreToServer()` writes the canonical store through the public API.
The server serializes file mutations and broadcasts store-change SSE events.
The browser ignores its own origin token; another tab queues or performs a
reload depending on whether an import/save transition is active.

### Static build and precompute

`build-static-site.mjs` copies the deployable tree, rewrites the backend/API
configuration contract, and stamps asset references. `precompute-train-parts.mjs`
uses `app-family-sandbox.mjs` to replay the real ordered app scripts in a Node
VM, installs country datasets into their lexical state, invokes the production
normalization and route solver, and exports deterministic cache entries. A
future module migration must replace both hidden contracts before changing the
script model.

## State ownership baseline

`app-state.js` is the declaration owner for the main train store,
selection/date, map, import, data-source, and route-render cache bindings. The
train-store write group has named `AppActions`; remaining groups retain their
classic-script bindings and are migrated incrementally. The generated report
lists every statically visible writer and makes those remaining multi-writer
exceptions explicit. Dataset loading and route-solve scheduling still live in
`app.js`. Persistence timers, journals, recovery flags, and
IndexedDB coordination are private to `PersistenceService` in
`app-persistence.js`; route caches and
regional graph caches are declared by `app-route-graph.js`; every
signature-keyed deck cache — overlap map, record bundle, route items, marker
records, and the two "last uploaded" guards — is declared by
`app-overlap-lanes.js` next to the invalidators that clear them.

The desired direction is one named owner per state group and named actions at
cross-file boundaries. This baseline does not claim that ownership has already
been centralized.

## Dead-code classifications

- **Definitely dead:** only items manually verified against every dynamic and
  build surface; none are inferred solely by the report.
- **Dynamically referenced:** reached through a global property lookup or a
  similar non-lexical call captured by the report.
- **Test/build/precompute-only:** retained when repository consumers use it even
  if browser runtime code does not.
- **Compatibility surface:** exported UMD/global names and public schemas or
  endpoints.
- **Uncertain:** no proven caller; requires manual review and is retained by
  default.
