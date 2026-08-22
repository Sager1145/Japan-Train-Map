import CoreGraphics
import Foundation
import RailCore

/// The dots a recorded ride puts on the stations it called at — and on the
/// ones it rolled through — as the marker RECORDS `RailCore.StationDisplay`
/// already knows how to elect names for.
///
/// The web app flattens every visible train's stops into
/// `buildDeckMarkerRecords` → `deckMarkerRecord` → `markerRecordsToFC`
/// (`app/public/app-deck-records.js`). The middle two are ported into
/// `RailCore` — ``StationDisplay/markerLabelWinners(_:)``,
/// ``StationDisplay/markerRecordsToFC(_:)`` and the three
/// ``StationDisplay/RideLabelTier`` floors — and this is the caller.
///
/// ## Where a stop's position comes from
///
/// `deckMarkerRecord` is fed a STOP FEATURE: one entry of `train.stops`
/// resolved against the national station table by `resolveStationForTrain`.
/// This app resolves it against the ride's own drawn geometry instead, which
/// is both cheaper and *more* accurate — jsonspec §6.1 makes a route section
/// one physically adjacent stop pair, so section `n` runs `stops[n] →
/// stops[n + 1]` and `DrawnSegment.segmentIndex` names the stop at each end.
/// Verified against every part of all seven bundled datasets (287 journeys,
/// five countries): not one `segment_index` disagrees with the stop pair its
/// `from`/`to` name.
///
/// The consequence is a deliberate difference from the web app rather than an
/// approximation of it: a stop whose section did not solve has **no drawn
/// position**, so it gets no dot. The web app would place one at the station's
/// own coordinate, off the route it failed to draw. Saying nothing is the
/// honest answer — see ``RiddenRouteStore/RouteOutcome``, which is what tells
/// a partly-solved ride from a whole one.
///
/// ## The roles, and what proves each of them
///
/// | web role      | here                                                      |
/// |---------------|-----------------------------------------------------------|
/// | `terminal`    | the first and last EFFECTIVELY RIDDEN stopping station     |
/// | `stop`        | every other drawn stopping station                         |
/// | `stop-center` | its black core, as in the web app                          |
/// | `pass`        | `stop_type == "pass_through"`, plus computed pass-throughs |
/// | `xday`        | the stop each `Dates.DayBreak` lands on                     |
///
/// Nothing is invented. A stop that is not effectively ridden is dropped
/// entirely, exactly as `buildDeckMarkerRecords` drops it, so a marker on the
/// map is a claim the reader's own `ride_segment` flags support.
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

    /// One built marker: the record, the feature its name election produced,
    /// and the station identity neither of them carries.
    ///
    /// The code travels with the record because the readings table is keyed by
    /// it first and by name second (`Localization.stationReadingRow`), and
    /// same-named stations are common enough that dropping it would annotate
    /// the wrong 中山. `stopIndex` is what lets the endpoint card reach back
    /// for the stop's own departure or arrival time.
    struct Drawn {
        var record: StationDisplay.MarkerRecord
        var feature: StationDisplay.MarkerFeature
        var stationCode: String?
        /// The ride's own day span, so the renderer can apply the date scope
        /// without looking the ride up again.
        var daySpan: Dates.DaySpan
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

    /// One dot's raw style numbers.
    private struct DotStyle {
        var radius: Double
        var lineWidth: Double
        var fill: [Double]
        var stroke: [Double]
        var alpha: Double
    }

    /// `stopMarkerStyleValues`, with `focused` and `dimmed` left out.
    ///
    /// Both are deliberate: `buildDeckMarkerRecords` is documented
    /// SELECTION-INDEPENDENT — focus flags are never baked into a record, so
    /// selecting a ride does not rebuild one — and the date-scope dim became
    /// paint-level in the web app too. The renderer applies both, off
    /// ``StationDisplay/MarkerFeature/focusScale`` and ``MapDateScope``.
    private static func stopStyle(isBoundary: Bool, settings: Settings) -> DotStyle {
        // An intermediate stop renders at PASS-THROUGH size; only the true
        // boarding/alighting boundary keeps the large terminal dot. The black
        // centre added below is what tells the two apart.
        DotStyle(
            radius: isBoundary ? settings.terminalRadius : settings.passRadius,
            lineWidth: ringWidth(1, settings: settings),
            fill: isBoundary ? ink : white,
            stroke: isBoundary ? white : ink,
            alpha: 1)
    }

    /// `passThroughMarkerStyleValues`. The outer circle is an intermediate
    /// stop's exactly; the stop's black centre is their sole visual delta.
    ///
    /// `active` is `ride_segment !== false`, and it is not decoration: an
    /// inactive pass-through draws at 0.4. Nothing here can currently produce
    /// one — a stop that is not effectively ridden is dropped before it gets
    /// this far — but the record set is the web app's and so is this.
    private static func passStyle(active: Bool, settings: Settings) -> DotStyle {
        DotStyle(
            radius: settings.passRadius,
            lineWidth: ringWidth(1, settings: settings),
            fill: white,
            stroke: ink,
            alpha: active ? 1 : 0.4)
    }

    /// The cross-day diamond REPLACES its station's dot.
    ///
    /// A diamond of half-diagonal *r* covers half the area of a circle of the
    /// same *r*, so the radius grows to match a terminal dot's visual weight —
    /// `Math.max(rec.radius, DISPLAY.terminalRadius) * 1.35`.
    static let crossDayRadiusRatio: Double = 1.35

    static func crossDayRadius(_ radius: Double, settings: Settings) -> Double {
        max(radius, settings.terminalRadius) * crossDayRadiusRatio
    }

    /// The white rim around the diamond, as a proportion of its half-diagonal.
    ///
    /// `_ensureXDayIcon` draws `rim = 2 * ratio` device pixels into a canvas
    /// built from `XDAY_ICON_BASE_RADIUS = 10` at `ratio = 2`, which is 2 CSS
    /// pixels on a 10-pixel radius, and `icon-size` then scales the whole
    /// image by `radius / 10`. So the rim is a fifth of the radius at every
    /// size, which is the number rather than the pixel count.
    static let crossDayRimRatio: Double = 0.2

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

    /// `PASSTHROUGH_MIN_ZOOM` — the numerous white pass-through dots follow at
    /// a HIGHER threshold, so pulling back sheds pass-throughs first and stops
    /// second while the terminals never leave.
    static let passDotMapLibreMinZoom: Double = 9

    static func drawsStopDots(atZoom zoom: Double) -> Bool {
        zoom >= RailStyle.zoom(fromMapLibre: stopDotMapLibreMinZoom)
    }

    static func drawsPassDots(atZoom zoom: Double) -> Bool {
        zoom >= RailStyle.zoom(fromMapLibre: passDotMapLibreMinZoom)
    }

    /// Whether a role's dot draws at this zoom. The cross-day diamond rides
    /// with the terminals: it is a boundary of the same kind, and a day break
    /// is exactly what a wide view of a multi-day trip is for.
    static func drawsDot(role: String, atZoom zoom: Double) -> Bool {
        switch role {
        case "terminal", "xday": return true
        case "pass": return drawsPassDots(atZoom: zoom)
        default: return drawsStopDots(atZoom: zoom)
        }
    }

    // MARK: - the ride flags

    /// The ride flags of one journey, in the reduced form `RailCore` reads
    /// them in — so the ported rules and the one mirrored below are looking at
    /// exactly the same array rather than at two views of it.
    static func rideFlags(_ stops: [Stop]) -> [Statistics.Stop] {
        stops.map {
            Statistics.Stop(
                arrival: $0.arrival, departure: $0.departure,
                stopType: $0.stopType, rideSegment: $0.rideSegment)
        }
    }

    // MARK: - positions

    /// Where each of a ride's stops stands, taken from the ride's own drawn
    /// geometry.
    ///
    /// Section `n` runs `stops[n] → stops[n + 1]` (jsonspec §6.1), so a
    /// segment's first vertex is its `from` stop and its last is its `to`. The
    /// earliest claim wins, which makes a through station the ARRIVING end of
    /// the section before it — the two are the same place, joined by the
    /// solver's continuity anchor, and fixing the tie keeps the answer
    /// independent of the order the segments arrived in.
    ///
    /// The name carried alongside is a check, not a lookup: where a segment
    /// declares its endpoint names, a disagreement with the stop at that index
    /// means the index is not the stop's, and the position is not used.
    static func stopPositions(of ride: RiddenRouteStore.DrawnRide) -> [Int: Coordinate] {
        var result: [Int: Coordinate] = [:]
        let stops = ride.stops
        guard !stops.isEmpty else { return [:] }
        for segment in ride.segments.sorted(by: { $0.segmentIndex < $1.segmentIndex }) {
            guard let first = segment.coordinates.first,
                  let last = segment.coordinates.last else { continue }
            let index = segment.segmentIndex
            guard index >= 0, index + 1 < stops.count else { continue }
            if agrees(segment.from, stops[index].name), result[index] == nil {
                result[index] = first
            }
            if agrees(segment.to, stops[index + 1].name), result[index + 1] == nil {
                result[index + 1] = last
            }
        }
        return result
    }

    /// A declared endpoint name against the stop the index says it is. An
    /// absent name is not a disagreement: `leanExportSection` drops `from`/`to`
    /// wherever the station table can reconstruct them (jsonspec §13.4).
    private static func agrees(_ declared: String?, _ stopName: String) -> Bool {
        guard let declared, !declared.isEmpty else { return true }
        return Stations.normalizeStationName(declared)
            == Stations.normalizeStationName(stopName)
    }

    // MARK: - building

    /// Every visible ride's calls, flattened into marker records.
    ///
    /// The order matters and is the web app's: rides in the order they are
    /// drawn, each ride's own stops in travel order, its computed
    /// pass-throughs after them, and a stop's black centre immediately after
    /// the dot it sits in. ``StationDisplay/markerLabelWinners(_:)`` resolves
    /// ties in favour of whichever record arrived FIRST, so a different order
    /// would hand a shared station's name to a different ride.
    static func records(
        rides: [RiddenRouteStore.DrawnRide], settings: Settings
    ) -> [(record: StationDisplay.MarkerRecord, code: String?, ride: RiddenRouteStore.DrawnRide)] {
        var records:
            [(record: StationDisplay.MarkerRecord, code: String?, ride: RiddenRouteStore.DrawnRide)] = []
        for ride in rides where ride.visible {
            let stops = ride.stops
            let flags = rideFlags(stops)
            let positions = stopPositions(of: ride)
            // First + last effectively-ridden STOPPING station: the black-dot
            // pair. Pass-throughs are excluded from the pair by construction —
            // a ride does not begin at a station it rolled through.
            let ridden = Statistics.effectivelyRiddenStopIndexes(flags)
            let boundaries: Set<Int> = ridden.isEmpty
                ? [] : [ridden[0], ridden[ridden.count - 1]]
            // Cross-day break stations (jsonspec §13.6): the last station of
            // each outgoing day gets ONE diamond instead of its ordinary dot —
            // the same station reads as "day D ends here" and "day D+1 starts
            // here".
            let breaks = Set(ride.daySpan.breaks.map(\.index))
            // Every identity the ride names explicitly, collected before the
            // ride flags are consulted: `getComputedPassThroughFeatures` builds
            // its exclusion set from `train.stops` whole, not from the drawn
            // subset of it.
            var claimedNames = Set<String>()
            for stop in stops { claimedNames.insert(Stations.normalizeStationName(stop.name)) }

            func seed(
                _ position: Coordinate, name: String, code: String?,
                category: String, role: String, style: DotStyle, focusScale: Double
            ) -> StationDisplay.MarkerRecord {
                StationDisplay.MarkerRecord(
                    position: position,
                    name: name,
                    category: category,
                    role: role,
                    radius: style.radius,
                    lineWidth: style.lineWidth,
                    fillColor: style.fill,
                    lineColor: style.stroke,
                    alpha: style.alpha,
                    focusScale: focusScale,
                    trainID: ride.id,
                    tdate: ride.daySpan.date,
                    dspan: ride.daySpan.key)
            }

            for (index, stop) in stops.enumerated() {
                guard let position = positions[index] else { continue }
                // Hidden (not effectively ridden) markers are dropped entirely.
                let effective = Statistics.effectiveStopRide(flags, index)
                guard effective else { continue }
                let isPass = stop.stopType == "pass_through"
                let isBoundary = boundaries.contains(index)
                let style = isPass
                    ? passStyle(active: effective, settings: settings)
                    : stopStyle(isBoundary: isBoundary, settings: settings)
                let role = isPass ? "pass" : (isBoundary ? "terminal" : "stop")
                var record = seed(
                    position, name: stop.name, code: stop.n02StationCode,
                    category: isPass ? "pass" : "stop", role: role,
                    style: style,
                    // A terminal takes the whole focus boost; everything else
                    // grows by exactly what a pass-through would.
                    focusScale: role == "terminal" ? 1 : 0.5)

                if breaks.contains(index) {
                    // The diamond REPLACES this station's dot: one underneath
                    // would only peek out around the icon.
                    record.category = "xday"
                    record.role = "xday"
                    record.radius = crossDayRadius(record.radius, settings: settings)
                    // `_ensureXDayIcon` rasterises ONE image — an ink lozenge
                    // with a white rim — so the diamond wears the ride
                    // boundary's colour pair whatever the stop underneath it
                    // was. The record's own fill/stroke are overwritten here
                    // rather than in the renderer, because the icon is where
                    // that decision is made in the web app.
                    record.fillColor = ink
                    record.lineColor = white
                    record.lineWidth = record.radius * crossDayRimRatio
                    // `focusScale` is deliberately left as the ORIGINAL role
                    // set it: `deckMarkerRecord` computes it before
                    // `buildDeckMarkerRecords` rewrites the role, so a break
                    // that lands on an intermediate stop keeps that stop's
                    // half-boost. Reproduced rather than tidied.
                    records.append((record, stop.n02StationCode, ride))
                    continue
                }

                records.append((record, stop.n02StationCode, ride))
                guard !isPass, !isBoundary else { continue }
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
                records.append((core, stop.n02StationCode, ride))
            }

            // `getComputedPassThroughFeatures` — a station a route SECTION
            // names that the reader's own stop list does not.
            //
            // For every dataset this app ships the set is empty, because a
            // section is an adjacent stop pair and both of its ends are stops.
            // It is still built, because a store written by hand can carry
            // route sections that skip stations, and a station the route runs
            // through is worth a dot whether or not anybody wrote it down.
            for segment in ride.segments.sorted(by: { $0.segmentIndex < $1.segmentIndex }) {
                for (name, position) in [
                    (segment.from, segment.coordinates.first),
                    (segment.to, segment.coordinates.last),
                ] {
                    guard let name, !name.isEmpty, let position else { continue }
                    let key = Stations.normalizeStationName(name)
                    guard !claimedNames.contains(key) else { continue }
                    claimedNames.insert(key)
                    let style = passStyle(active: true, settings: settings)
                    records.append((
                        seed(
                            position, name: name, code: nil, category: "pass",
                            role: "pass", style: style, focusScale: 0.5),
                        nil, ride))
                }
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
    ) -> [Drawn] {
        let built = records(rides: rides, settings: settings)
        let features = StationDisplay.markerRecordsToFC(built.map(\.record))
        return zip(built, features).map { entry, feature in
            Drawn(
                record: entry.record, feature: feature, stationCode: entry.code,
                daySpan: entry.ride.daySpan)
        }
    }
}
