import CoreGraphics
import Foundation
import RailCore

/// The dots a recorded ride puts on the stations it called at, as the marker
/// RECORDS `RailCore.StationDisplay` already knows how to elect names for.
///
/// The web app flattens every visible train's stops into
/// `buildDeckMarkerRecords` → `deckMarkerRecord` → `markerRecordsToFC`
/// (`app/public/app-deck-records.js`), and the middle two of those are already
/// ported: ``StationDisplay/markerLabelWinners(_:)``,
/// ``StationDisplay/markerRecordsToFC(_:)`` and the three
/// ``StationDisplay/RideLabelTier`` floors. What was missing was a caller. This
/// is it.
///
/// ## Why the record set is smaller here than in the web app
///
/// `deckMarkerRecord` is fed a STOP FEATURE — one entry of `train.stops`,
/// carrying `stop_type`, `ride_segment` and the station it resolved to — plus
/// the computed pass-through stations the route rolled through without
/// calling. `RiddenRouteStore.DrawnRide` carries none of that: it is solved
/// GEOMETRY, one `DrawnSegment` per route section, and the only station
/// identities on it are the section's own `from` / `to` names.
///
/// So the roles this can honestly emit are the ones a section boundary proves:
///
/// | web role      | here                                                     |
/// |---------------|----------------------------------------------------------|
/// | `terminal`    | the ride's first `from` and last `to`                     |
/// | `stop`        | every other section boundary                              |
/// | `stop-center` | its black core, as in the web app                         |
/// | `pass`        | **not emitted** — needs the computed pass-throughs        |
/// | `xday`        | **not emitted** — needs the train's day span              |
///
/// Nothing is invented to fill the gap: a `pass` record built from a section
/// boundary would be a lie about which stations the train rolled through, and
/// the three-tier label election would then hand names out on it. What is here
/// is exactly what the drawn geometry knows.
enum MapRideMarkers {

    // MARK: - the neutral dot palette (railprint C4: hue is reserved for LINES)

    /// `RP_INK_RGB` / `RP_WHITE_RGB`. Kept as the `[Double]` channel arrays
    /// `MarkerRecord` takes, because `rgbCss` indexes three elements without
    /// checking and the port reproduces that.
    static let ink: [Double] = [26, 26, 26]
    static let white: [Double] = [255, 255, 255]

    /// The 顯示調節 numbers this builder reads, snapshotted off the main actor
    /// so the record build is a pure function of its inputs.
    struct Settings: Equatable {
        var terminalRadius: Double
        var passRadius: Double
        /// The radius the stop-centre slider's stored number actually sets —
        /// `DisplaySettings.stopCentreRadius`, not the raw legacy slider value.
        var stopCentreRadius: Double
        var markerStrokeScale: Double
        var focusBoost: Double
    }

    // MARK: - the style numbers, from app-style.js

    /// `markerRingWidth` — the ring around every dot on a ride is the
    /// network's OWN station ring times the reader's 標記邊框粗細 multiplier,
    /// never a whole point of its own. It used to round to an integer in the
    /// web app, which drew a 1 px ring around a 6 px dot beside the network's
    /// 0.75 px ring around the same dot.
    static func ringWidth(_ scale: Double, settings: Settings) -> Double {
        Double(RailStyle.stationRing) * scale * settings.markerStrokeScale
    }

    /// `stopCenterRadius` — keep the stop visibly filled while retaining
    /// enough white around the centre to distinguish it from the solid
    /// origin/destination marker.
    static func stopCentreRadius(outer: Double, settings: Settings) -> Double {
        max(0.75, min(outer * 0.72, settings.stopCentreRadius))
    }

    /// `stopMarkerStyleValues`, with `focused` and `dimmed` left out.
    ///
    /// Both are deliberate: `buildDeckMarkerRecords` is documented
    /// SELECTION-INDEPENDENT — focus flags are never baked into a record, so
    /// selecting a ride does not rebuild one — and the date-scope dim became
    /// paint-level in the web app too. The renderer applies both, off
    /// ``StationDisplay/MarkerFeature/focusScale``.
    private static func stopStyle(
        isBoundary: Bool, settings: Settings
    ) -> (radius: Double, lineWidth: Double, fill: [Double], stroke: [Double]) {
        // An intermediate stop renders at PASS-THROUGH size; only the true
        // boarding/alighting boundary keeps the large terminal dot. The black
        // centre added below is what tells the two apart.
        (
            radius: isBoundary ? settings.terminalRadius : settings.passRadius,
            lineWidth: ringWidth(1, settings: settings),
            fill: isBoundary ? ink : white,
            stroke: isBoundary ? white : ink
        )
    }

    // MARK: - level of detail

    /// `STOP_MIN_ZOOM` — below this, only the `terminal` dots draw.
    ///
    /// In MapLibre's convention, like everything ported: feed it through
    /// ``RailStyle/zoom(fromMapLibre:)`` before comparing. The web app cannot
    /// express this as a layer `minzoom` because one layer carries both the
    /// stops and the terminals, and the terminals must stay visible at every
    /// zoom — a ride's two ends are the whole of what it says at a national
    /// view, while its intermediate calls at that scale are a smear.
    static let stopDotMapLibreMinZoom: Double = 7

    /// `PASSTHROUGH_MIN_ZOOM`. Carried for the roles this cannot emit yet, so
    /// that whoever wires the computed pass-throughs finds the number here
    /// rather than having to go looking for it again.
    static let passDotMapLibreMinZoom: Double = 9

    static func drawsStopDots(atZoom zoom: Double) -> Bool {
        zoom >= RailStyle.zoom(fromMapLibre: stopDotMapLibreMinZoom)
    }

    // MARK: - building

    /// One station a ride's solved geometry proves it was at.
    private struct Call {
        let name: String
        let position: Coordinate
    }

    /// The ordered stations of one ride, from its section boundaries.
    ///
    /// A section's own ends are the only station identities the solved
    /// geometry carries. Consecutive sections normally share one — section
    /// *n*'s `to` IS section *n+1*'s `from` — and where they do the pair is
    /// collapsed, so a through station is one call rather than two dots on top
    /// of each other. Where they do NOT (a ride whose sections do not join,
    /// which the solver can produce when a leg was left unsolved) both survive,
    /// because at that point they really are two different places.
    private static func calls(of ride: RiddenRouteStore.DrawnRide) -> [Call] {
        var result: [Call] = []
        for segment in ride.segments {
            guard let first = segment.coordinates.first,
                  let last = segment.coordinates.last else { continue }
            let entry = Call(name: segment.from ?? "", position: first)
            if let previous = result.last,
               previous.name == entry.name,
               Grid.coordKey(previous.position) == Grid.coordKey(entry.position) {
                // Already standing here.
            } else {
                result.append(entry)
            }
            result.append(Call(name: segment.to ?? "", position: last))
        }
        return result
    }

    /// Every visible ride's calls, flattened into marker records.
    ///
    /// The order matters and is the web app's: rides in the order they are
    /// drawn, each ride's calls in travel order, and a stop's black centre
    /// immediately after the dot it sits in. ``StationDisplay/markerLabelWinners(_:)``
    /// resolves ties in favour of whichever record arrived FIRST, so a
    /// different order would hand a shared station's name to a different ride.
    static func records(
        rides: [RiddenRouteStore.DrawnRide], settings: Settings
    ) -> [StationDisplay.MarkerRecord] {
        var records: [StationDisplay.MarkerRecord] = []
        for ride in rides where ride.visible {
            let calls = Self.calls(of: ride)
            guard !calls.isEmpty else { continue }
            for (index, call) in calls.enumerated() {
                let isBoundary = index == 0 || index == calls.count - 1
                let style = stopStyle(isBoundary: isBoundary, settings: settings)
                let record = StationDisplay.MarkerRecord(
                    position: call.position,
                    name: call.name,
                    category: "stop",
                    role: isBoundary ? "terminal" : "stop",
                    radius: style.radius,
                    lineWidth: style.lineWidth,
                    fillColor: style.fill,
                    lineColor: style.stroke,
                    alpha: 1,
                    // A terminal takes the whole focus boost; an intermediate
                    // stop grows by exactly what a pass-through would.
                    focusScale: isBoundary ? 1 : 0.5,
                    trainID: ride.id
                )
                records.append(record)
                guard !isBoundary else { continue }
                // 中途停靠站: a pass-through-sized circle plus a BLACK centre,
                // which is a second record on the same layer drawn on top.
                let centre = stopCentreRadius(outer: style.radius, settings: settings)
                var core = record
                core.radius = centre
                core.lineWidth = 0
                core.fillColor = ink
                core.lineColor = ink
                core.role = "stop-center"
                // Preserve the centre/outer ratio when a selection enlarges
                // both. `style.radius` is a display setting and could be zero.
                core.focusScale = style.radius > 0 ? (centre / style.radius) * 0.5 : 0
                records.append(core)
            }
        }
        return records
    }

    /// The records with their elected names, as the renderer draws them.
    ///
    /// Returned zipped rather than as bare features because
    /// ``StationDisplay/MarkerFeature`` carries its colours as the CSS strings
    /// deck.gl wanted, and parsing `"rgb(26,26,26)"` back into a `UIColor`
    /// would be a round trip through text for numbers this side already holds.
    static func drawn(
        rides: [RiddenRouteStore.DrawnRide], settings: Settings
    ) -> [(record: StationDisplay.MarkerRecord, feature: StationDisplay.MarkerFeature)] {
        let records = Self.records(rides: rides, settings: settings)
        return Array(zip(records, StationDisplay.markerRecordsToFC(records)))
    }
}
