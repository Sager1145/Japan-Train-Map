# ios/ — the Swift fork

Native iPhone app. Apple Maps for the basemap, the railway drawn over it, and
the pure logic ported from the web app one verified function at a time.

Open `RailMap.xcodeproj`. It builds with no setup: the local `RailKit` package
resolves from disk and the rail packages are copied into the bundle by a build
phase. There are no remote dependencies.

    ios/
      RailMap.xcodeproj      the app
      RailMap/               SwiftUI shell — the only place MapKit is imported
      RailKit/               local package
        Sources/RailCore/    the ported pure tier (Foundation only)
        Tests/RailCoreTests/ parity against the JavaScript, via port-fixtures/
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

Rebuilds are keyed to the integer zoom bucket, so panning within a zoom level
does no work at all; only crossing a bucket boundary re-decimates. What is
still unmeasured is a sustained pinch across many buckets in quick succession —
that is the next thing to put a number on rather than assume.

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

The pure tier is 20 files; four are ported. Route solving, overlap lanes,
corridor smoothing and mileage statistics are not, and neither is any of the
persistence, import or playback. The order to continue in, and the reasoning
behind it, is in [`../REFACTOR_FOR_SWIFT_FORK_PROMPT.md`](../REFACTOR_FOR_SWIFT_FORK_PROMPT.md)
§四 Phase 7.
