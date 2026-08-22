# Every feature of the web app, and where the iOS app stands

The web app is *N02 特急列車管理* — a tool for recording which trains you have
ridden and seeing the result on a map. The iOS app currently draws the network
and nothing else, which is the least of what it does.

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
| Station dots | `railmap-style.js` §5 | ❌ | ❌ |
| Station names, by role tier | `railmap-geometry.js` `markerLabelWinners` | ❌ | ❌ |
| C5 bilingual station popup | `railmap-popup.js` (146) | ❌ | ❌ |
| Hover/tap fan for overlapping lines | `railmap.js` `_setExpandedGroup` | ❌ | ❌ |
| Basemap opacity, endpoint labels | `app-display-features.js` (493) | ❌ | ❌ |

## 2 · Rides — the point of the app

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Train (itinerary) model | `jsonspec.md`, `app-validation.js` | ✅ | ❌ |
| Validation on import/edit | `app-validation.js` (273) | ✅ | ❌ |
| Station resolution by name | `app-stations.js` (271) | ✅ | ❌ |
| Route graph + spatial index | `app-route-graph.js` (1450) | ✅ | ❌ |
| Canonical route feature | `rail-network.js:1622` | ✅ | ❌ |
| **Route solving (Dijkstra + rules)** | `app-route-solver.js` (1375) | ❌ | ❌ |
| Draw ridden routes | `app-route-render.js` (299) | ❌ | ❌ |
| Overlap lanes / corridor smoothing | `app-overlap-lanes.js` (2319) | ❌ | ❌ |
| Deck records | `app-deck-records.js` (1590) | ❌ | ❌ |
| Ride station labels | `app-deck-records.js` `markerRecordsToFC` | ❌ | ❌ |
| Select a train, clear selection | `#fit-selected`, `#clear-selection` | — | ❌ |
| Fit to selection (定位) | `app-map-fit.js` (216) | ❌ | ⚠️ fits the network, not a selection |

## 3 · The itinerary list and editor

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Date bar, add/remove dates | `app-dates.js` (192), `#add-date` | ✅ | ❌ |
| Train list, grouped by date | `app-render.js` (492) | ✅ | ✅ |
| Read one ride, stop by stop | `app-editor.js` `renderStopsTable` | ✅ | ✅ |
| Add / duplicate / delete train | `app-store-ops.js` (775) | ✅ | ❌ |
| Edit fields (套用欄位) | `app-editor.js` (519) | ❌ | ❌ |
| Show/hide a train | `#toggle-visible` | ✅ | ❌ |
| Reorder (上移/下移) | `#move-up`, `#move-down` | ✅ | ❌ |
| Stops table, add stop | `app-editor.js` `renderStopsTable` | ❌ | ❌ |
| Rebuild route from stops | `#rebuild-route` | ❌ | ❌ |

## 4 · Statistics

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Section classification | `app-stats.js` (989) | ✅ | ❌ |
| Mileage aggregation (deduped union) | `app-stats.js` | ✅ | ❌ |
| Per-category breakdown, coverage % | `app-stats.js` | ✅ | ❌ |
| Top ridden segments | `app-stats.js` `topRiddenSegments` | ✅ | ❌ |
| The 統計 panel | `app-stats-render.js` (359) | — | ❌ |

## 5 · Data in and out

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Progressive import | `app-import.js` (935) | ❌ | ❌ |
| Validate import JSON | `app-validation.js` | ✅ | ❌ |
| Open / save local JSON | `app-persistence.js` (1366) | ❌ | ❌ |
| Export / download JSON | `#export-json`, `#download-json` | ✅ | ⚠️ used for saving, no export UI |
| Load sample data (7 buttons) | `#load-sample-*` | — | ✅ |
| Save / restore my rides, locally | `#save-as-user-store`, `#restore-user-store` | — | ✅ |
| Delete my rides | `#clear-storage` | — | ✅ |
| Delete all / reset | `#delete-all-trains`, `#reset-defaults` | ❌ | ❌ |
| Server autosave + SSE live refresh | `app-live-refresh.js` (135) | ❌ | n/a |

## 6 · Playback

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Play an itinerary | `app-playback.js` (1180) | ❌ | ❌ |
| Prev / next / pause / stop | `#playback-*` | ❌ | ❌ |
| Auto-focus zoom | `#toggle-focus-zoom` | ❌ | ❌ |
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
| Four UI languages | `i18n.js`, `i18n-strings.js` | ✅ | ❌ not wired |
| Country-variant strings (`.tw`) | `i18n.js` `tc()` | ✅ | ❌ |
| Station name readings | `station-readings.json` | ✅ | ❌ |
| Display settings panel | `app-display-settings.js` (547) | ❌ | ❌ |
| Dark mode | — | ✅ | ✅ |
| Adaptive phone/tablet layout | `styles/device-layout.css` | — | ✅ |

## Where that leaves it

Of roughly 60 features, **12 work in the app**. Eleven more have their logic
ported and verified but nothing on screen yet — those are the cheapest wins,
because the hard half is already done and checked.

The order that gets the app usable fastest, each step being the prerequisite of
the next:

1. **Load a train store and list it.** `Train` is ported; this is app work only.
2. **Draw ridden routes.** Needs the route solver ported — the largest single
   remaining piece, and the one that makes the map show *your* rides rather
   than the whole network.
3. **The statistics panel.** All the logic is ported; this is a SwiftUI view.
4. **Editor and persistence**, so the app can create rides rather than only
   display them.
5. Playback, then the two genuinely new pieces: trail gradient and video.
