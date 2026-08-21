# ios/ — the Swift fork

Native iPhone app. Apple Maps for the basemap, the railway drawn over it, and
the pure logic ported from the web app one verified function at a time.

Open `RailMap.xcodeproj`. It builds with no setup: the local `RailKit` package
resolves from disk and the rail packages are copied into the bundle by a build
phase. There are no remote dependencies.

    ios/
      RailMap.xcodeproj      the app
      RailMap/               SwiftUI shell — the only place MapKit is imported
        ContentView          picks the layout from the window's shape
        BottomBar            tabs + three drag detents (tall windows)
        MapControlBar        the map's own controls, down the right edge
        RailMapView          MKMapView, batched overlays
        NetworkLOD           what is drawn at a zoom — ours, not a port
        GlassStyle           Liquid Glass on 26+, material below
      RailKit/               local package
        Sources/RailCore/    the ported pure tier (Foundation only)
        Tests/RailCoreTests/ parity against the JavaScript, via port-fixtures/
      PORTING.md             how a function gets ported
      verify.sh              the gate
      copy-rail-packages.sh  build phase: app/public/rail → app bundle

Built and run against **Xcode 27.0 beta (27A5237l), Swift 6.4, iOS 27 SDK**,
deployment target iOS 17.

## The rule this whole directory exists to enforce

`RailCore` imports Foundation and nothing else. No MapKit, no SwiftUI, no
storage. That is not tidiness — it is what makes the port checkable. Because
`RailCore` has no platform underneath it, the same functions can be run against
the same inputs as the JavaScript, and `port-fixtures/` at the repository root
holds those inputs and the answers the JavaScript gives.

    cd app && node scripts/build/build-port-fixtures.mjs   # regenerate
    cd ios/RailKit && swift test                           # check this port against them

The fixtures' expected values are *whatever the JavaScript returns today*, not
a second opinion about what is correct. A failure means this Swift disagrees
with the app it was forked from — which of the two is right is a separate
question, and one that cannot even be asked until the disagreement is visible.

## What porting this way has already caught

Two disagreements, both invisible to review and both found on the first run:

**Coordinate keys.** JavaScript prints an integral number without a fractional
part, so `quant5(139)` becomes `"139"`; Swift's `String(139.0)` is `"139.0"`.
Those keys are a *persisted* format — route caches, stats edge keys and overlap
buckets are all keyed on them — so a port that spells one coordinate
differently computes a different identity for the same point, splits every
graph node in two, and cannot read a cache the web app wrote. `JSNumber`
implements ECMAScript's `Number::toString` and `Math.round` for this reason,
and the fixtures lead with integral, negative-zero and `0.00001` cases so a
naive port fails immediately rather than in production.

**Haversine distance.** 24 of 803 cases differed by 1–2 ULP. The obvious
suspect was a transcription slip — the JavaScript writes `sin(x) ** 2`, the
first Swift draft wrote `pow(sin(x), 2)` — but rewriting it as a plain
multiplication changed nothing, so the residue is `sin`/`cos`/`asin`
themselves: V8 and Darwin ship different implementations and neither promises
the other's last bit. The test therefore carries a 2 ULP ceiling *measured*,
not a tolerance chosen to make it pass. At these magnitudes that is about
6 × 10⁻¹⁴ m on a 300 m interval, far below the app's tightest threshold (the
2.5 m overlap snap), and a ULP ceiling — unlike a relative epsilon — still
fails if someone mistypes the Earth radius.

Everything else matches bit for bit: quantisation, coordinate keys, segment
keys, Douglas–Peucker vertex selection, and the decoded interval geometry.

## Why Apple Maps and not MapLibre

The plan originally assumed MapLibre Native, since the web app is built on
MapLibre GL JS and the style JSON would have carried over. Apple Maps is the
better fit, and not only because it is native: this project's drawing rules
were derived from Apple Maps in the first place. The stroke weight and station
bead diameter in `railmap-style.js` are measured against macOS 「地圖」→
大眾運輸 at 東京駅. Putting the railway back over the reference it was designed
against is the shorter distance.

The basemap asks for `.muted` emphasis — MapKit's own term for "something is
being drawn over me" — and excludes points of interest, so Apple's transit
lines do not compete with ours for the same ink.

The cost is that the S tier does not port as data. MapLibre style JSON would
have been read by both renderers; MapKit has no style spec, so the design
tokens have to become renderer parameters instead. That is a real loss and it
is worth being explicit about it.

## The interface

Two layouts, chosen by the window's shape rather than the device. A phone in
landscape has almost no height for a bottom sheet but plenty of width for a
sidebar, and it reports a *compact* horizontal size class on every model but
the largest — so size class alone would put a sheet there and leave the map a
letterbox.

    tall windows   a sheet over the map, dragged between three stops
    wide windows   the same tabs at the foot of a sidebar, always open

The sidebar is a plain `HStack`, not `NavigationSplitView`, which collapses to
a stack at compact width — exactly the case it would be needed for.

The map's controls run down the right edge in both, because they act on the map
rather than on the app: network, 定位, zoom in, zoom out, compass, and the
device's own position. That last is new here. The web app's 定位 (`fit-selected`)
frames the *selected railway* and says nothing about where the reader is
standing, so the two are separate buttons rather than one with two meanings.
In the sheet layout the panel publishes its live height and the controls keep
clear of it — a control the panel slides over is one that stops working without
ever looking broken.

Dark mode is not just a darker basemap. The packages carry a `colorDark` per
line (`rail-network.js` reads `colorDark || color`), so the overlays are rebuilt
with the other palette when the trait flips. Ignoring it would make dark mode a
different map rather than a darker one.

## Performance: what the simulator said, and what fixed it

The first version drew one SwiftUI `MapPolyline` per station interval. On
Japan that is 9,568 overlays, and the simulator was explicit about the result:

    Exceeded Metal Buffer threshold of 50000 with a count of 50796 resources,
    pruning resources now
    _UIInterruptScrollDecelerationGestureRecognizer has been in possible phase
    for 21.899041125 seconds

Every overlay carries its own renderer and its own Metal buffers. VectorKit hit
its ceiling and began pruning mid-render, and the gesture recogniser stalled for
twenty-two seconds. SwiftUI's `Map` cannot fix this: `MapPolyline` initialises
from coordinates, `MKMapPoint`s, an `MKPolyline` or an `MKRoute`, and there is
no batch form — one polyline is always one overlay.

So the map moved to `MKMapView` behind `UIViewRepresentable`, where
`MKMultiPolyline` exists. Three changes, in order of how much they bought:

1. **Batching.** Every line sharing a colour becomes one `MKMultiPolyline`
   drawn by one `MKMultiPolylineRenderer`.
2. **Level of detail.** `RailCore.Visibility` is the web app's own rule ported
   over, not an iOS invention — a line whose group is short drops out of the
   wide views. Reproducing it is what keeps both apps showing the *same*
   railway at a given zoom; the culling is a side effect.
3. **Decimation.** Douglas–Peucker with epsilon set to half a pixel at the
   current zoom. This one *is* ours — MapLibre gets it free from geojson-vt and
   MapKit has no equivalent. Bounded at half a pixel it cannot change what a
   reader sees.

Japan (652 lines / 9,568 intervals / 394,285 vertices), measured on the iPhone
17 Pro simulator:

| | before | after, national view (z4.7) | after, city view (z13.3) |
| --- | ---: | ---: | ---: |
| overlays | 9,568 | **165** | 340 |
| drawn vertices | 394,285 | **12,433** | 89,785 |
| lines drawn | 652 | 262 | 652 |
| rebuild | — | 98 ms | 229 ms |
| Metal prune events | yes | **0** | **0** |
| gesture stalls | 21.9 s | **0** | **0** |

Package decode is unchanged at ~270 ms and happens off the main actor.

### Then: only what the zoom warrants, and only what is on screen

Batching made a national view *possible*; it was still drawing 262 lines over a
basemap that, at z4, is a country outline with a few motorways. `NetworkLOD`
adds three rules — and lives outside `RailCore` on purpose, because there is no
JavaScript to check it against and mixing a policy of our own into the ported
tier would make the parity fixtures meaningless.

1. **A line waits for both its length and its rank.** The web app hides by
   group length alone, which is enough over a vector basemap that can draw a
   hairline. Requiring both leaves the trunk corridors at a national view and
   holds branches back until there is a map under them to make sense of.
2. **Nothing far off screen is built.** The build covers the visible rect plus
   half a screen each way and is remembered, so panning inside it does no work.
3. **A vertex budget is the backstop**, shedding least-important first, so the
   worst case is a function of the budget rather than of the data.

| Japan, national view | batched only | with LOD |
| --- | ---: | ---: |
| lines drawn | 262 | **33** |
| drawn vertices | 12,433 | **3,192** |
| rebuild | 98 ms | **19 ms** |

Panned away from Japan, all 652 lines cull to nothing rather than being built
off screen.

The budget was wrong on the first attempt, instructively: applied to the
*stored* vertex count it cut that same view to 7 lines, weighing 394,285 stored
vertices against a budget meant for the ~12,000 actually drawn. It now runs
after decimation, on what the lines will really cost.

Still unmeasured: a sustained pinch across many zoom tiers in quick succession.
That is the next thing to put a number on rather than assume.

## Two environment notes that cost time

**Build outside the repository.** The repo lives under `~/Documents`, which is
file-provider backed (iCloud). The provider re-adds `com.apple.FinderInfo`
to build products, and `codesign` refuses to sign anything carrying it:

    error: resource fork, Finder information, or similar detritus not allowed

So `swift test` needs a scratch path off the synced volume:

    swift test --scratch-path /tmp/railkit-build

Xcode's own derived data is already outside the repository and is unaffected.

**First launch shows no basemap.** MapKit's tile requests time out on a fresh
simulator (`ActiveTileGroup.pbd` missing, then `NSURLErrorTimedOut`) and the
map draws only its graticule. Relaunching once fixes it. The region here is
`zh_TW`, so MapKit resolves to Apple's China tile host and attributes to
高德地图; the tile requests carry `vertical_datum=wgs84`, and the Macao
overlay lands on the correct viaduct, so WGS84 coordinates need no datum
correction for the covered countries.

## What is not here yet

The pure tier is 20 files. Ported and verified: coordinates and keys, haversine
distance, Douglas–Peucker, compact-package intervals, the visibility ladder,
station-dot level of detail, micro-kink grooming, operator branding, the date
rules, and `canonicalizeRouteFeature` — 50 parity tests over roughly 8,600
fixture cases.

Not ported: the route solver, overlap lanes and corridor smoothing, mileage
statistics, display parts, station resolution, the train model and validation,
and the i18n catalogs — several of those are in flight. Nothing of persistence,
import, the editor or playback exists yet, and playback's video export has no
MapKit equivalent at all, so it will be new work rather than a port.

The order to continue in, and the reasoning behind it, is in
[`../REFACTOR_FOR_SWIFT_FORK_PROMPT.md`](../REFACTOR_FOR_SWIFT_FORK_PROMPT.md)
§四 Phase 7, and the recipe for one port is [`PORTING.md`](PORTING.md).
