# Every feature of the web app, and where the iOS app stands

The web app is *N02 特急列車管理* — a tool for recording which trains you have
ridden and seeing the result on a map. This ledger is checked against the
current SwiftUI shell and `RailCore`, not against the state of an earlier
prototype.

This is the checklist, taken from `app/public/index.html` (the authoritative
list of what a user can press) and `app/public/app.js`'s module map (the
authoritative list of what implements it). Every row names the source. Nothing
here is aspiration: a row is **done** only when it works in the app, not when
the logic behind it is ported.

Two columns, because they fail differently:

- **logic** — is it in `RailCore`, verified against the JavaScript by fixtures?
- **app** — can a person actually use it on the phone?

A ported function nobody can reach is not a feature.

## 1 · The map

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Draw the national network | `rail-network.js`, `railmap-style.js` | ✅ | ✅ |
| Switch country (jp/tw/hk/mo/kr) | `app-country-session.js` | ✅ | ✅ |
| Zoom-tiered visibility | `rail-network.js` `minZoomFor*` | ✅ | ✅ |
| Official line colours, light and dark | package `color`/`colorDark` | ✅ | ✅ |
| Display parts — branches split from trunks | `rail-network.js:908` | ✅ | ❌ |
| Station dots | `railmap-style.js` §5 | ✅ | ❌ |
| Station names, by role tier | `railmap-geometry.js` `markerLabelWinners` | ✅ | ❌ |
| C5 bilingual station popup | `railmap-popup.js` (146) | ✅ | ❌ |
| Hover/tap fan for overlapping lines | `railmap.js` `_setExpandedGroup` | ❌ | ❌ |
| Basemap opacity, endpoint labels | `app-display-features.js` (493) | ❌ | ❌ |

## 2 · Rides — the point of the app

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Train (itinerary) model | `jsonspec.md`, `app-validation.js` | ✅ | ✅ |
| Validation on import/edit | `app-validation.js` (273) | ✅ | ⚠️ full import validation; editor gates core fields |
| Station resolution by name | `app-stations.js` (271) | ✅ | ❌ |
| Route graph + spatial index | `app-route-graph.js` (1450) | ✅ | ❌ |
| Canonical route feature | `rail-network.js:1622` | ✅ | ⚠️ decoded from bundled progressive route datasets |
| **Route solving (Dijkstra + rules)** | `app-route-solver.js` (1375) | ✅ endpoint expansion, station snapping, transfer connectors, hint attempts and regional/full-graph Dijkstra are parity-tested | ⚠️ automatic background rebuild works; Taiwan exact-interval fast path remains |
| Draw ridden routes | `app-route-render.js` (299) | ⚠️ canonical display-line slicing remains | ✅ precomputed and runtime-solved rides render without straight-line fallback |
| Overlap lanes / corridor smoothing | `app-overlap-lanes.js` (2319) | ✅ | ❌ |
| Deck records | `app-deck-records.js` (1590) | ✅ | ❌ |
| Station-join curve smoothing | `app-overlap-lanes.js` `smoothCurveStationJoins` | ❌ | ❌ |
| Ride station labels | `app-deck-records.js` `markerRecordsToFC` | ✅ | ❌ |
| Select a train, clear selection | `#fit-selected`, `#clear-selection` | — | ✅ selection highlights the corresponding map route |
| Fit to selection (定位) | `app-map-fit.js` (216) | ❌ | ✅ fits a routed selection and otherwise falls back to the network |

## 3 · The itinerary list and editor

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Date bar, add/remove dates | `app-dates.js` (192), `#add-date` | ✅ | ⚠️ filter exists; standalone date CRUD does not |
| Train list, grouped by date | `app-render.js` (492) | ✅ | ✅ |
| Read one ride, stop by stop | `app-editor.js` `renderStopsTable` | ✅ | ✅ |
| Add / duplicate / delete train | `app-store-ops.js` (775) | ✅ | ✅ |
| Edit fields (套用欄位) | `app-editor.js` (519) | ✅ | ✅ |
| Show/hide a train | `#toggle-visible` | ✅ | ✅ |
| Reorder (上移/下移) | `#move-up`, `#move-down` | ✅ | ✅ |
| Stops table, add stop | `app-editor.js` `renderStopsTable` | ✅ | ✅ |
| Rebuild route from stops | `#rebuild-route` | ✅ | ⚠️ edits/imports automatically invalidate and rebuild; explicit rebuild control/status remains |

## 4 · Statistics

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Section classification | `app-stats.js` (989) | ✅ | ✅ |
| Mileage aggregation (deduped union) | `app-stats.js` | ✅ | ✅ |
| Per-category breakdown, coverage % | `app-stats.js` | ✅ | ⚠️ category coverage is live; per-line drill-down remains |
| Top ridden segments | `app-stats.js` `topRiddenSegments` | ✅ | ⚠️ overall top five are shown; per-category expansion remains |
| The 統計 panel | `app-stats-render.js` (359) | — | ✅ counts, time, service mix, mileage, coverage and top sections are live |

## 5 · Data in and out

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Progressive import | `app-import.js` (935) | ✅ | ⚠️ atomic document/paste import UI; progress UI awaits route warming |
| Validate import JSON | `app-validation.js` | ✅ | ✅ |
| Open / save local JSON | `app-persistence.js` (1366) | — | ✅ native document picker/exporter |
| Export / download JSON | `#export-json`, `#download-json` | ✅ | ✅ |
| Load sample data (7 buttons) | `#load-sample-*` | — | ✅ |
| Save / restore my rides, locally | `#save-as-user-store`, `#restore-user-store` | — | ✅ |
| Delete my rides | `#clear-storage` | — | ✅ |
| Delete all / reset | `#delete-all-trains`, `#reset-defaults` | ✅ | ⚠️ delete-all exists; reset-defaults does not |
| Server autosave + SSE live refresh | `app-live-refresh.js` (135) | ❌ | n/a |

## 6 · Playback

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Play an itinerary | `app-playback.js` (1180) | ✅ | ❌ |
| Prev / next / pause / stop | `#playback-*` | ✅ | ❌ |
| Auto-focus zoom | `#toggle-focus-zoom` | ✅ | ❌ |
| Trail gradient along the route | `line-gradient` + `line-progress` | ❌ | ❌ |
| **Video export** | `app-playback-video.js` (835) | ❌ | ❌ |

Video export is **not a port**. It exists because a WebGL canvas cannot be read
back, so the web app captures a stream and composites it. iOS has no equivalent
path and no equivalent problem: it would be `AVAssetWriter` over rendered
frames, which is new work. The trail gradient is a second known gap — MapKit
has no gradient stroke, so it needs segment colouring or a custom overlay.

## 7 · Interface and language

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Four UI languages | `i18n.js`, `i18n-strings.js` | ✅ | ✅ main native surfaces use the verified catalog |
| Country-variant strings (`.tw`) | `i18n.js` `tc()` | ✅ | ⚠️ runtime is wired; remaining variant-specific surfaces are not built |
| Station name readings | `station-readings.json` | ✅ | ❌ |
| Display settings panel | `app-display-settings.js` (547) | ❌ | ⚠️ region, network, fit, language and theme exist |
| Dark mode | — | ✅ | ✅ |
| Adaptive phone/tablet layout | `styles/device-layout.css` | — | ✅ |

## Where that leaves it

The native shell now covers the complete list/detail/editor and local-data
workflow. It also draws bundled sample rides over the national network and can
highlight and fit a selected ride. Runtime route solving is still the critical
dependency for edited/imported rides, full coverage statistics, and playback;
precomputed sample geometry does not make those features complete.

The order that gets the app usable fastest, each step being the prerequisite of
the next:

1. ~~**Load a train store and list it.**~~ Complete in SwiftUI.
2. **Finish runtime route solving.** Bundled sample rides now draw, but the
   Dijkstra/rules port remains the largest single piece and is required to draw
   routes created or imported on the phone.
3. **Finish the statistics panel** once routed geometry is available.
4. ~~**Editor and persistence.**~~ CRUD, local storage and JSON documents are
   reachable; route rebuilding remains coupled to step 2.
5. Playback, then the two genuinely new pieces: trail gradient and video.
