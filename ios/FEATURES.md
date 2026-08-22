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

> Read as of commit `c30b876`. An earlier revision of this file had drifted
> badly — it still marked playback, video export, the statistics panel, station
> dots, the C5 popup and runtime route solving as absent, months after they
> shipped. The rows below were re-derived by reading the code rather than by
> editing the old table, so a ⚠️ or ❌ here is a claim someone checked.

## 0 · What is deliberately not ported

Three groups, so they stop being re-discovered as gaps.

**Withdrawn from the web app.** Screen-space lane offsets — the `lanes` table's
render consumption, `line-offset`, `icon-offset`, the laned-platform layer and
its 42 contract tests — were removed end to end by commit `38cf0a8`
(2026-08-19) at the user's direction, and rule R14 is marked 廢止 in
`RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md`. Every line now draws on
its own surveyed geometry. The `lanes` key is still generated into each package
(198 rows for jp) but **nothing reads it**. Porting it here would not close a
gap; it would fork the two clients apart.

**No pointer to hover with.** The overlapping-line fan (`railmap.js`
`_setExpandedGroup`) exists because a mouse can rest on a line without
committing to it. So do `showHoverRegions` and the hover branch of the endpoint
labels. A phone has no such gesture, and inventing a long-press for it was
declined.

**Not applicable to a native app.** `#download-html`, the server autosave and
its SSE live refresh (`app-live-refresh.js`), and the UI-mode override
(auto/mobile/desktop) — the last because the layout here is chosen from the
window's shape, which is the thing the override existed to correct.

## 1 · The map

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Draw the national network | `rail-network.js`, `railmap-style.js` | ✅ | ✅ |
| Switch country (jp/tw/hk/mo/kr) | `app-country-session.js` | ✅ | ✅ |
| Zoom-tiered visibility | `rail-network.js` `minZoomFor*` | ✅ | ✅ off-by-one fixed, rank ladder recalibrated |
| Official line colours, light and dark | package `color`/`colorDark` | ✅ | ✅ |
| Display parts — branches split from trunks | `rail-network.js:908` | ✅ | ✅ `RailNetworkStore` builds every line through `DisplayParts.parts` |
| Station dots | `railmap-style.js` §5 | ✅ | ✅ |
| Station names, by role tier | `railmap-geometry.js` `markerLabelWinners` | ✅ | ✅ `stationLabelWinners` elects them at decode |
| C5 bilingual station popup | `railmap-popup.js` (146) | ✅ | ⚠️ readings wired; the operator logo is still absent |
| The weight ramp — one factor for every mark | `railmap-style.js` `railwayScale` | — | ✅ every weight is one token × `RailStyle.scale` |
| Endpoint labels, with collision layout | `app-display-features.js` (493) | ✅ | ✅ badge, times and reading lines |
| Basemap opacity | `app-display-features.js` `applyMapOpacity` | — | ✅ |
| Hover fan for overlapping lines | `railmap.js` `_setExpandedGroup` | — | — not ported, see §0 |

**The zoom convention, resolved.** `railmap-style.js` measures zoom against
MapLibre's 512-px tiles; `RailMapView.Coordinator.zoomLevel(of:)` measures
against 256-pt tiles, which reports the same ground scale **one level higher**
(78271.52·cos35°/2⁷ and 156543.03·cos35°/2⁸ are both 500.9 m per unit). Every
threshold ported out of the web app is therefore a MapLibre number and has to
be converted before it is read here — `RailStyle.zoom(fromMapLibre:)` and its
inverse. Two places had not been, and both were measured over all 652 jp lines
before they were changed: the station gate drew 3,963 dots at a city view where
the web app draws 348, and `NetworkLOD` drew 652 lines at a national view
against 431. Fixing the lines needed a second fix — it was being handed each
line's own length where `Visibility.minZoomByLineId` deliberately uses the
line's visibility GROUP — after which the rank ladder was recalibrated to
3,3,4,5,6: identical to the web app from a national view up, deliberately
stricter only at the widest views.

## 2 · Rides — the point of the app

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Train (itinerary) model | `jsonspec.md`, `app-validation.js` | ✅ | ✅ |
| Validation on import/edit | `app-validation.js` (273) | ✅ | ⚠️ full on import; the editor gates core fields only |
| Station resolution by name | `app-stations.js` (271) | ✅ | ✅ |
| Route graph + spatial index | `app-route-graph.js` (1450) | ✅ | ✅ |
| Canonical route feature | `rail-network.js:1622` | ✅ | ✅ |
| **Route solving (Dijkstra + rules)** | `app-route-solver.js` (1375) | ✅ | ✅ official-interval fast path, then on-demand regional/full-graph solve, cached to disk by the web app's own cache-key digest |
| Draw ridden routes | `app-route-render.js` (299) | ✅ | ✅ precomputed and runtime-solved rides both draw; **no straight-line fallback** |
| Deck marker records | `app-deck-records.js` (1590) | ✅ | ✅ terminal / stop / pass / xday, with the name election |
| Corridor fitting in `OverlapLanes.swift` | `app-overlap-lanes.js` (2319) | ✅ 3,105 lines | ❌ still no caller — see below |
| Station-join curve smoothing | `app-overlap-lanes.js` `smoothCurveStationJoins` | ✅ 26-case fixture | ❌ no caller |
| Ride station labels | `app-deck-records.js` `markerRecordsToFC` | ✅ | ✅ three tiers, elected, haloed |
| Select a train, clear selection | `#fit-selected`, `#clear-selection` | — | ✅ |
| Fit to selection (定位) | `app-map-fit.js` (216) | — | ✅ |

## 3 · The itinerary list and editor

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Date bar, add/remove dates | `app-dates.js` (192), `#add-date` | ✅ | ✅ filter, add date, remove empty dates |
| Map follows the selected date | `#map-date-filter` | ✅ | ✅ |
| Train list, grouped by date | `app-render.js` (492) | ✅ | ✅ |
| Search | `#search-input` | — | ✅ |
| Read one ride, stop by stop | `app-editor.js` `renderStopsTable` | ✅ | ✅ |
| Add / duplicate / delete train | `app-store-ops.js` (775) | ✅ | ✅ |
| Edit fields (套用欄位) | `app-editor.js` (519) | ✅ | ✅ |
| Show/hide a train | `#toggle-visible` | ✅ | ✅ |
| Reorder (上移/下移) | `#move-up`, `#move-down` | ✅ | ✅ |
| Stops table, add stop | `app-editor.js` `renderStopsTable` | ✅ | ✅ |
| Rebuild route from stops | `#rebuild-route` | ✅ | ✅ |

## 4 · Statistics

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Section classification | `app-stats.js` (989) | ✅ | ✅ |
| Mileage aggregation (deduped union) | `app-stats.js` | ✅ | ✅ |
| Per-category breakdown, coverage % | `app-stats.js` | ✅ | ✅ |
| Per-line drill-down | `app-stats-render.js` `categoryLineBreakdownHtml` | ✅ | ✅ including 新幹線's list-the-unridden rule |
| Top ridden segments | `app-stats.js` `topRiddenSegments` | ✅ | ✅ overall and per category |
| **當日統計 — the day's own numbers** | `app-stats-render.js` `renderMileageStatsDom` | ✅ | ✅ with its own date scope; `--` on 全部, never `0` |
| The 統計 panel | `app-stats-render.js` (359) | — | ✅ counts, time, service mix, mileage, coverage, top sections |

## 5 · Data in and out

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Progressive import | `app-import.js` (935) | ✅ | ✅ staged progress from the engine's own events |
| Import preflight — scope and mode | `app-import.js` | ✅ | ✅ counts, renames and per-row JSON paths before commit |
| Validate import JSON, without importing | `#validate-import-json` | ✅ | ✅ |
| Open / save local JSON | `app-persistence.js` (1366) | — | ✅ native document picker/exporter |
| Export / download JSON | `#export-json`, `#download-json` | ✅ | ✅ |
| Load sample data (7 buttons) | `#load-sample-*` | — | ✅ all seven, filtered by country |
| Save / restore my rides, locally | `#save-as-user-store`, `#restore-user-store` | — | ✅ |
| Delete my rides | `#clear-storage` | — | ✅ |
| Delete all / reset to sample | `#delete-all-trains`, `#reset-defaults` | ✅ | ✅ |

## 6 · Playback

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Play an itinerary | `app-playback.js` (1180) | ✅ | ✅ |
| Prev / next / pause / stop, speed | `#playback-*` | ✅ | ✅ |
| Auto-focus zoom | `#toggle-focus-zoom` | ✅ | ✅ |
| Trail gradient along the route | `line-gradient` + `line-progress` | — | ✅ as a per-segment alpha ramp — see below |
| **Video export** | `app-playback-video.js` (835) | — | ✅ `AVAssetWriter` — see below |
| Export shape / quality / bitrate | `#playback-shape`, `-quality`, `-bitrate` | — | ❌ export runs at one fixed setting |

Neither of the last two is a port, and both are better here than in the web app
because the web app's versions are workarounds. Video export exists there
because a WebGL canvas cannot be read back, so it captures a stream and
composites it; here every frame is rendered straight into an `AVAssetWriter`.
The trail gradient is a MapKit gap — there is no gradient stroke — so the trail
is split into segments carrying an alpha ramp instead. Both produce the
intended result by a different mechanism, which is why they are ✅ rather than
「ported」.

## 7 · Interface and language

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Four UI languages | `i18n.js`, `i18n-strings.js` | ✅ | ✅ from the generated catalog |
| Country-variant strings (`.tw`) | `i18n.js` `tc()` | ✅ | ✅ every catalog key resolves through `countryText` |
| Station name readings | `station-readings.json` | ✅ | ✅ per country, in labels, cards and callouts |
| Display settings panel | `app-display-settings.js` (547) | — | ✅ the knobs that drive this renderer; four fit-curve sliders deliberately absent |
| Dark mode | — | ✅ | ✅ overlays rebuild with the other palette |
| Adaptive phone/tablet layout | `styles/device-layout.css` | — | ✅ chosen from the window's shape |

## Where that leaves it

The list is now short enough to read in one go.

**Ported and still unreachable.** The corridor-fitting half of
`OverlapLanes.swift` — the representative geometry, the endpoint joins, the
fitted curve, and `smoothCurveStationJoins` on top of it — has no caller. Its
marker-record half does, and the two are one file only because they are one
thing in the JavaScript. This is the last large block of verified code that
nothing exercises.

**Present but incomplete.** The C5 popup still has no operator logo, though
`OperatorBranding.swift` is ported and verified. The editor validates core
fields inline and falls back to the validator's own untranslated message for
rules no field check explains. Video export runs at one fixed setting.

**Not ported.** Nothing structural is left. What remains is the `.tw` variant
strings for keys that do not yet declare variants, and Slice 6 of the interface
spec — motion, Dynamic Type, keyboard and VoiceOver as a single pass rather
than per screen.

**What has and has not been run.** The map layers, the journey panel and its
three detents have been driven in the simulator in both themes; the numbers in
this file that say "measured" were read off a device or out of the packages.
The statistics, data and settings screens have been checked by the compiler and
by their parity fixtures, not by a person using them. Four of the five regions
have never been switched to on a device.
