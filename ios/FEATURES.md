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

> Read as of commit `2097d64`, plus the region merge described below. An
> earlier revision of this file had drifted badly — it still marked playback,
> video export, the statistics panel, station dots, the C5 popup and runtime
> route solving as absent, months after they shipped. The rows below were
> re-derived by reading the code rather than by editing the old table, so a ⚠️
> or ❌ here is a claim someone checked.

## The one place this app is deliberately not the web app

**There is no region switch.** The web app has one package loaded, one store
open, and an `activeCountry` every function reads. This app draws all five
networks at once and each itinerary carries its own `region` (see
`RegionCatalog.swift`), which is what lets one store hold rides in five
countries. The consequences are listed where they land — samples, statistics,
the editor, import — and the reasoning is in `RegionCatalog`'s and
`MergedStore`'s own documentation. Everything else on this page is still
measured against the web app.

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
declined. A tap over crossing rides asks instead — see §2.

**And therefore not the corridor curve either.** `OverlapLanes`' fitted
representative geometry and `StationJoinSmoothing` have no caller here, and
that is now a decision rather than a gap. Traced in the JavaScript: the drawn
ride path is `records.push({ ...base, path: runLine })` — the solved section
geometry — in `app-deck-records.js:1150`, and `gi.curve` is read by exactly
three things, all of them unported by the rules above: `_setExpandedGroup`'s
fan (`railmap.js:1925`), the `showFitCurves` debug wireframe
(`railmap-geometry.js:348`), and the geometry validation sweeps. **Wiring the
curve into this renderer would make the two clients draw different lines, not
the same ones.** Both files stay because they are verified against the
JavaScript and because a hover-equivalent gesture would need them.

**Not applicable to a native app.** `#download-html`, the server autosave and
its SSE live refresh (`app-live-refresh.js`), and the UI-mode override
(auto/mobile/desktop) — the last because the layout here is chosen from the
window's shape, which is the thing the override existed to correct.

**The accessibility text sizes.** Dynamic Type is followed exactly up to
`xxxLarge`, the top of the standard ladder, and clamped there —
`railTypeCeiling()` in `RailMapApp.swift`, applied at the app root and at every
sheet's content root. An earlier revision of this file claimed AX5 "re-lays-out
rather than clips"; driven on the simulator at AX5 it does not. The panel title,
the date heading and one journey name are laid out against a sheet whose height
is a fraction of the window, and at AX5 the subtitle truncated mid-word and the
first journey row was cut off by the tab bar. Clamping is a decision, not a gap:
every size a reader is likely to set is honoured, and the sizes that break the
panel are not offered a broken panel.

Note that the ceiling has to be applied per sheet as well as at the root. A
sheet is hosted by its own controller and takes its content size category from
the **window**, not from the presenting view's SwiftUI environment — set once at
the root it held for the map and nothing else, and in this app every panel the
reader reads is inside a sheet.

The `isAccessibilitySize` branches that used to sit in `ContentView`,
`RideCard`, `JourneyComponents`, `StatisticsComponents`, `StatisticsView` and
`RideDetailView` have been removed along with it. With the ceiling in place
`dynamicTypeSize.isAccessibilitySize` is false everywhere in the app, so those
were eleven unreachable layouts reading as supported behaviour — the thing this
file exists to stop. Each site keeps the branch that actually ran. One
occurrence remains, in `RideSheetMetrics.mediumHeight`, and it is dead for a
different reason: **nothing constructs a `RideSheetMetrics`**. Only its static
members (`cornerRadius`, `handleHeight`) are referenced, so the whole instance
side of that type is a leftover of the layout `BottomChromeMetrics` replaced.
That is its own cleanup, not this one.

## 1 · The map

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Draw the national network | `rail-network.js`, `railmap-style.js` | ✅ | ✅ |
| All five regions drawn at once | — | ✅ | ✅ replaces the region switch; `RailNetworkStore.loadAll` decodes the five packages concurrently and publishes each as it lands |
| Zoom-tiered visibility | `rail-network.js` `minZoomFor*` | ✅ | ✅ off-by-one fixed; rank plus a finer native wide-view length ladder |
| Official line colours, light and dark | package `color`/`colorDark` | ✅ | ✅ |
| Display parts — branches split from trunks | `rail-network.js:908` | ✅ | ✅ `RailNetworkStore` builds every line through `DisplayParts.parts` |
| Station dots | `railmap-style.js` §5 | ✅ | ✅ |
| Station names, by role tier | `railmap-geometry.js` `markerLabelWinners` | ✅ | ✅ `stationLabelWinners` elects them at decode |
| C5 bilingual station popup | `railmap-popup.js` (146) | ✅ | ✅ readings, operator badges and colour swatches — as a card in a sheet (`StationCardView`) rather than a callout anchored to the bead |
| …from a ride's own stations too | `app-deck-records.js` `handleDeckMarkerClick` | ✅ stop data grid | ✅ the same station card, resolved back to the network platform by station-group code and then by name; the journey selection is left alone (see `gestureRecognizer(_:shouldReceive:)`) |
| …opened and shared as a real Apple Maps place | — | — | ✅ `StationPlaceStore` resolves the station to its own map item; `StationPlaceLink` picks the winner and writes `/place?place-id=`, falling back to the captioned pin where no service can answer (`audit-station-places.swift`) |
| The weight ramp — one factor for every mark | `railmap-style.js` `railwayScale` | — | ✅ every weight is one token × `RailStyle.scale` |
| Endpoint labels, with collision layout | `app-display-features.js` (493) | ✅ | ✅ badge, times and reading lines |
| Basemap opacity | `app-display-features.js` `applyMapOpacity` | — | ✅ |
| Legend and data sources, with licences | `app-map-init.js` `buildMapInfoControl` | — | ✅ `MapInfoView`, plus a Korean article the web app has never had and an Apple-Maps basemap article in place of OpenFreeMap's |
| Map layer toggles (routes / stops / terminals / pass / four ridden categories) | `app-map-init.js` `buildMapLayersControl` | ✅ | ✅ `MapLayersView`, all nine — the categories classify through the ported `Statistics.riddenFeatureCategory`, and are labelled from the BASE keys because each filter acts on all five networks |
| Statistics scope: one region, or 全部 | — | — | ✅ native-only. The five networks are disjoint, so their edge indexes merge into one denominator (`EdgeIndexCache.merged`); switching the scope frames that network on the map, and 全部 frames all of them |
| Basemap picker (Positron / none) | `buildMapLayersControl` | — | — Apple Maps is the basemap; the opacity slider covers "less of it" |
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
3,3,4,5,6. The native renderer now also reads the unbucketed group length and
uses 300/120/50/20 km floors across app zoom 4/5/6/7; zoom 8 remains the
unchanged all-lines stop.

## 2 · Rides — the point of the app

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Train (itinerary) model | `jsonspec.md`, `app-validation.js` | ✅ | ✅ |
| Validation on import/edit | `app-validation.js` (273) | ✅ | ✅ every `validateTrain` rule the editor can break now speaks next to its field — route sections and the two policy fields included |
| Station resolution by name | `app-stations.js` (271) | ✅ | ✅ |
| Route graph + spatial index | `app-route-graph.js` (1450) | ✅ | ✅ |
| Canonical route feature | `rail-network.js:1622` | ✅ | ✅ |
| **Route solving (Dijkstra + rules)** | `app-route-solver.js` (1375) | ✅ | ✅ official-interval fast path, then on-demand regional/full-graph solve, cached to disk by the web app's own cache-key digest |
| Draw ridden routes | `app-route-render.js` (299) | ✅ | ✅ precomputed and runtime-solved rides both draw; **no straight-line fallback** |
| Deck marker records | `app-deck-records.js` (1590) | ✅ | ✅ terminal / stop / pass / xday, with the name election |
| Corridor fitting in `OverlapLanes.swift` | `app-overlap-lanes.js` (2319) | ✅ 3,105 lines | — deliberately uncalled: it feeds the hover fan, not the drawn line (§0) |
| Station-join curve smoothing | `app-overlap-lanes.js` `smoothCurveStationJoins` | ✅ 26-case fixture | — same |
| Ambiguous tap over crossing rides | `app-map-init.js` `handleDeckRouteChoices` | — | ✅ lists every ride under the finger; picking one activates its day |
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
| Which region a ride belongs to | — | ✅ | ✅ a row in 記錄資訊; it picks the solver, the statistics and the station picker |

## 4 · Statistics

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Section classification | `app-stats.js` (989) | ✅ | ✅ |
| Mileage aggregation (deduped union) | `app-stats.js` | ✅ | ✅ |
| Per-category breakdown, coverage % | `app-stats.js` | ✅ | ✅ |
| Per-line drill-down | `app-stats-render.js` `categoryLineBreakdownHtml` | ✅ | ✅ including 新幹線's list-the-unridden rule |
| Top ridden segments | `app-stats.js` `topRiddenSegments` | ✅ | ✅ overall and per category |
| **當日統計 — the day's own numbers** | `app-stats-render.js` `renderMileageStatsDom` | ✅ | ✅ stamped inside the passport page; absent, never `0`, when no day is in scope |
| The 統計 panel | `app-stats-render.js` (359) | — | ✅ counts, time, service mix, mileage, coverage, top sections |
| Date + region scope | — | — | ✅ both in the panel header (§5.3.1), one owner each; the region decides the categories and the coverage denominator |
| Passport stationery | — | — | ✅ §6.1's Memory personality: one feature card, tinted chart cards, plain lists (`PassportCardStyle.swift`) |

## 5 · Data in and out

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Progressive import | `app-import.js` (935) | ✅ | ✅ staged progress from the engine's own events |
| Import preflight — scope and mode | `app-import.js` | ✅ | ✅ counts, renames and per-row JSON paths before commit |
| Validate import JSON, without importing | `#validate-import-json` | ✅ | ✅ |
| Open / save local JSON | `app-persistence.js` (1366) | — | ✅ native document picker/exporter |
| Export / download JSON | `#export-json`, `#download-json` | ✅ | ✅ |
| Load sample data (7 buttons) | `#load-sample-*` | — | ✅ all seven, grouped by region; loading one FOLDS it into the working set (long-press replaces everything, which is the web's 重置示例) |
| Boot into a sample | `app-datasets.js` | — | — deliberately not: the app starts empty, and a sample is an action |
| Save / restore my rides, locally | `#save-as-user-store`, `#restore-user-store` | — | ✅ one merged store; per-region files from earlier builds are folded in once on first launch |
| Delete my rides | `#clear-storage` | — | ✅ |
| Delete all / reset to sample | `#delete-all-trains`, `#reset-defaults` | ✅ | ✅ |

## 6 · Playback

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Play an itinerary | `app-playback.js` (1180) | ✅ | ✅ |
| Prev / next / pause / stop, speed | `#playback-*` | ✅ | ✅ |
| Auto-focus zoom | `#toggle-focus-zoom` | ✅ | ✅ the transport's own follow, **and** `focusZoomEnabled` — choosing a journey or a day frames it (`auto-focus-zoom`, off by default) |
| Queue excludes hidden journeys | `resolveQueue` | ✅ | ✅ a journey chosen by name still plays, hidden or not |
| Arm, then run | `start()` → `begin()` | ✅ | ✅ play opens on the whole scope; the transport's ▶ starts the clock |
| Intro ease onto the first journey | `beginTrain({intro:true})` | ✅ | ✅ the clock waits for the camera |
| Closing panorama | `finaleFit` | ✅ | ✅ the playhead holds at the terminus through it |
| Finished journeys stay lit | `trailDone` | ✅ | ✅ each in its own colour, under the running trail |
| Stopping restores the selection | `restoreSelected` | ✅ | ✅ held on the controller, so all four entry points get it |
| A cancelled export keeps its film | `video.readyPartial` | ✅ | ✅ the writer is finished rather than cancelled |
| Trail gradient along the route | `line-gradient` + `line-progress` | — | ✅ as a per-segment alpha ramp — see below |
| **Video export** | `app-playback-video.js` (835) | — | ✅ `AVAssetWriter` — see below |
| Export shape / quality / bitrate | `#playback-shape`, `-quality`, `-bitrate` | ✅ | ✅ four frames, four ceilings, three bitrates |

Neither of the last two is a port, and both are better here than in the web app
because the web app's versions are workarounds. Video export exists there
because a WebGL canvas cannot be read back, so it captures a stream and
composites it; here every frame is rendered straight into an `AVAssetWriter`.
The trail gradient is a MapKit gap — there is no gradient stroke — so the trail
is split into segments carrying an alpha ramp instead. Both produce the
intended result by a different mechanism, which is why they are ✅ rather than
「ported」.

**One difference in the closing panorama.** The web app films it: its recorder
captures a stream continuously, so the pull-back at the end of a run is in the
exported file. Here every frame is rendered from a playback frame, and the
clock has stopped by then — so the film ends on the terminus rather than on the
panorama. The run itself is unaffected; only the export is shorter than the
web's by the length of the finale.

## 7 · Interface and language

| Feature | Source | logic | app |
| --- | --- | :-: | :-: |
| Four UI languages | `i18n.js`, `i18n-strings.js` | ✅ | ✅ from the generated catalog |
| Country-variant strings (`.tw`) | `i18n.js` `tc()` | ✅ | ✅ every catalog key resolves through `countryText` |
| Station name readings | `station-readings.json` | ✅ | ✅ per country, in labels, cards and callouts |
| Display settings panel | `app-display-settings.js` (547) | — | ✅ the knobs that drive this renderer; four fit-curve sliders deliberately absent |
| Dark mode | — | ✅ | ✅ overlays rebuild with the other palette |
| Adaptive phone/tablet layout | `styles/device-layout.css` | — | ✅ chosen from the window's shape |
| Motion, one set of parameters | spec §9.2 | — | ✅ `RailMotion` — every spring, duration and transition in the app |
| Reduce Motion | spec §9.4 | — | ✅ panels and bars cross-fade, the camera arrives instead of travelling, press feedback survives |
| Reduce Transparency / Increase Contrast | spec §10.5 | — | ✅ glass becomes an opaque surface; a hairline edge appears |
| Dynamic Type, up to `xxxLarge` | spec §10.1 | — | ✅ every standard size is followed exactly; the accessibility sizes are deliberately **not** — see below |
| Hardware keyboard (iPad) | spec §10.3 | — | ✅ ⌘N, ⌘F (iOS 18+), ⌘S, Space, Escape |
| VoiceOver | spec §10.2 | — | ✅ one summary per journey then its verbs, labelled map annotations, spoken statistics values, an announcement when an import lands |

## Where that leaves it

The list is now short enough to read in one go.

**Ported and deliberately uncalled.** The corridor-fitting half of
`OverlapLanes.swift` and all of `StationJoinSmoothing.swift`. This used to be
listed as the last block of verified code that nothing exercises, with the
implication that a caller was missing. It was traced instead: what those
functions produce is `gi.curve`, and the web app reads `gi.curve` only from the
hover fan, the `showFitCurves` debug overlay and the geometry validation
sweeps. The line the web app DRAWS is `runLine` — the same solved section
geometry this app draws. Calling them here would introduce a difference rather
than remove one. See §0.

**The map's layer menu** is a sheet behind the control bar's layers button
(`MapLayersView`), and it carries all nine switches: 列車路線, the three
marker-type toggles, 全部鐵路線, and the four ridden-category filters
(新幹線 / JR在來線 / 地下鐵 / 私鐵).

Two differences from the web app, both consequences of drawing five regions at
once:

- The category filter needs an N02 edge index per region, and building one
  reads a whole region's network. It is therefore built only once a category is
  actually switched off, shared with the statistics screen through
  `EdgeIndexCache`, and until it lands every ride stays drawn — which is the
  web app's own rule for "the index is not there yet".
- The web app hides a hidden category's station DOTS per station, from the
  attributes its station dataset repeats on each one. The ride markers here are
  built from the journey's stops, which carry no such attributes, so a dot is
  dropped only when every ridden segment of the journey it belongs to is
  hidden. A dot is never removed while any part of its line is still drawn.

Nothing else structural is left. The interface spec's last slice — motion,
Dynamic Type, keyboard and VoiceOver as one pass rather than per screen — is
**Slice 8**, not Slice 6; an earlier revision of this file called it Slice 6,
which is the Data Library / Settings slice and had already shipped. That pass
is the block of ✅ rows at the end of §7.

**What has and has not been run.** Everything below has been driven on an
iPhone 17 Pro simulator by `simctl` and the DEBUG-only `RAILMAP_UI_TEST_*`
hooks — the five networks, the merged store, the sample merge, the legend
sheet, the data screen, the statistics screen at two regions, the
ambiguous-tap chooser, the editor's region row, and the whole journey panel at
AX5 with Increase Contrast on.

Three things that harness reaches only halfway, and what stands in for the
other half:

  - **The tap itself.** The hooks can raise the chooser but cannot put a finger
    on two crossing lines. The decision underneath — which rides are within 18
    points of a tap, in what order — was moved out of the map coordinator into
    `RailPresentation.RideTapResolver` and unit-tested there, including the
    cases a hand-run reaches by luck: coincident rides, a tap past the end of a
    line, and a zero-length segment.
  - **Menus.** A `Menu` cannot be opened programmatically, so the statistics
    region picker was verified through its binding instead: launched at `tw`,
    the screen reports 1,395 km / 78 % of 1,790 km · 台湾 rather than Japan's
    numbers.
  - **VoiceOver itself** has not been driven. The labels, values, traits and
    the import announcement are in the code and read correctly as structure;
    nobody has listened to them.

`./verify.sh --swift` passes: 267 tests, no warnings, the app builds. The
JavaScript half currently fails `npm run lint` for reasons in another session's
in-flight web work — `app-events.js` calls `renderNetworkWorkspace` and
`renderPassportJourneyLog`, neither of which exists yet.
