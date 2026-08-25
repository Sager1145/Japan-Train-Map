import CoreGraphics
import Foundation
import RailCore
import UIKit

/// The origin / destination name cards a ride puts on the map, and the
/// pixel-space layout that keeps two of them from covering each other.
///
/// Ported from `app/public/app-display-features.js` — `measureLabelTextWidth`,
/// `buildEndpointLabelSpec` and `layoutEndpointLabels`. The `handleDeckHover` /
/// `hoverLabelTrainId` channel is deliberately NOT ported: it exists to follow
/// a pointer, and there is no pointer here.
///
/// ## What one card says
///
/// `buildEndpointLabelSpec` builds four pieces and this builds the same four:
///
///   * a **badge** — `tag.start` / `tag.end`, and only on the selected DAY's
///     first origin and last destination, which is the one thing on the map
///     that says where a day of travel began and ended;
///   * the station's **name**, localised (`I18N.stationName`);
///   * the stop's own **time**, prefixed `tag.dep` for an origin and `tag.arr`
///     for a destination — the departure and the arrival, never both;
///   * the reader's enabled **readings**, one per line under the name.
///
/// All four come off `train.stops`, which `RiddenRouteStore.DrawnRide` now
/// carries. The station identities are resolved the same way the dots are —
/// see ``MapRideMarkers/stopPositions(of:)`` — so a card and its terminal dot
/// can never disagree about where the ride ended.
///
/// ## The one deviation: the time is a SUBLINE, not a suffix
///
/// The web app writes `起點 我孫子 着 08:17` on one row. Here the time is
/// stacked under the name, with the readings under it, so the card reads as a
/// name with what qualifies it beneath — the shape every other stacked label
/// on this map already has. A row that grows sideways also has to be pushed
/// sideways to stay on screen (`clampHorizontally`), and on a phone that is
/// the common case rather than the edge one.
///
/// The card is also now the ONLY thing that names its station: the ride's own
/// label at that stop is suppressed by the renderer (see
/// `RailMapView.Coordinator.rebuild`), because a card that carries the name
/// and a caption beside the dot carrying it again is the same word twice.
enum MapEndpointLabels {

    /// One card, before and after placement.
    struct Spec {
        /// `${lat},${lon}|${kind}` — the web app's dedup key, so a ride whose
        /// origin and destination differ only in kind still gets two cards
        /// while two rides sharing an endpoint get one.
        let key: String
        let trainID: String
        let coordinate: Coordinate
        /// The localised station name.
        let name: String
        /// The package's own spelling of the same station.
        ///
        /// The identity the "one place, one name" claim is made under: the
        /// ride labels and the network's are elected on package names, so a
        /// localised spelling would fail to match the very labels this card
        /// has to silence.
        let rawName: String
        /// `起點` / `終點`, or empty. Only the selected day's own endpoints
        /// carry one — an ordinary selected ride's two ends do not.
        let badge: String
        /// `発 16:14`, already joined with its tag. Empty when the stop has no
        /// time on the side this card shows.
        let time: String
        /// The enabled readings, in `nameReadingsTyped` order.
        let readings: [String]
        let kind: Kind
        /// Estimated card size in points. The layout needs the real box, not
        /// the text: a wrapped name is taller and would otherwise be placed as
        /// though it were one line and covered by its neighbour.
        let width: CGFloat
        let height: CGFloat
        /// Filled in by ``layout(_:at:)``.
        var direction: Direction = .top
        var offset: CGPoint = .zero

        /// The badge, the name and the time on one line. No longer how the
        /// card is DRAWN — it is what a reader hears, and one utterance is
        /// what a caption should be however many rows it occupies.
        var mainLine: String {
            [badge, name, time].filter { !$0.isEmpty }.joined(separator: " ")
        }
    }

    enum Kind: String { case origin, destination }
    /// `Equatable` so a placement pass can tell whether a card actually moved
    /// — see `RailMapView.Coordinator.layoutEndpointLabels(on:)`.
    enum Direction: Equatable { case top, bottom }

    // MARK: - measuring

    /// The card's three type sizes, from `.station-label` and its two children
    /// in `railprint-base.css`, taken at the mobile end of the token scale
    /// (`device-layout.css`: 12 / 10 / 9) because that is the device this
    /// draws on.
    ///
    /// The web app measures with one canvas font (`700 11px system-ui`) for
    /// every piece because it cannot measure the DOM before it lays the card
    /// out. Here each piece is measured in the font it is actually drawn in,
    /// which can only make the box more accurate — the layout below is the
    /// same, and the HEIGHT still uses the ported per-line estimate.
    static var font: UIFont { .systemFont(ofSize: 12, weight: .semibold) }
    static var badgeFont: UIFont { .systemFont(ofSize: 9, weight: .bold) }
    static var timeFont: UIFont { .systemFont(ofSize: 10, weight: .medium) }
    static var readingFont: UIFont { .systemFont(ofSize: 9, weight: .regular) }

    /// The widest a card may grow before its text wraps — the CSS
    /// `max-width: 340px` the estimate is built around.
    static let maxWidth: CGFloat = 340

    static func measure(_ text: String, font: UIFont = MapEndpointLabels.font) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        return (text as NSString).size(withAttributes: [.font: font]).width
    }

    /// `buildEndpointLabelSpec`.
    static func spec(
        trainID: String,
        kind: Kind,
        at coordinate: Coordinate,
        name: String,
        rawName: String,
        badge: String = "",
        time: String = "",
        readings: [String] = []
    ) -> Spec? {
        guard !name.isEmpty else { return nil }
        // `+ 20` is the card's horizontal padding; a badge chip costs `+ 38`.
        let badgeWidth = badge.isEmpty ? 0 : measure(badge, font: badgeFont) + 4
        let mainWidth = badgeWidth + measure(name) + (badge.isEmpty ? 20 : 38)
        // Its own row now, so it widens the card only when it is the widest
        // thing on it rather than always adding to the name's row.
        let timeWidth = time.isEmpty ? 0 : measure(time, font: timeFont) + 20
        let readingsWidth = readings.reduce(CGFloat(0)) {
            max($0, measure($1, font: readingFont))
        } + (readings.isEmpty ? 0 : 20)
        let fullWidth = max(mainWidth, max(timeWidth, readingsWidth))
        let mainLines = max(1, min(3, Int(ceil(mainWidth / maxWidth))))
        return Spec(
            key: "\(String(format: "%.5f", coordinate.lat)),"
                + "\(String(format: "%.5f", coordinate.lon))|\(kind.rawValue)",
            trainID: trainID,
            coordinate: coordinate,
            name: name,
            rawName: rawName,
            badge: badge,
            time: time,
            readings: readings,
            kind: kind,
            width: min(maxWidth, fullWidth),
            // ~18 pt per name line and ~15 pt per subline, plus padding and
            // border — `buildEndpointLabelSpec`'s own estimate, with the time
            // counted as one more subline now that it stands on its own row.
            height: CGFloat(
                6 + 18 * mainLines + 15 * (time.isEmpty ? 0 : 1) + 15 * readings.count))
    }

    /// The stop a card is built from, and where the ride's geometry puts it.
    ///
    /// `buildEndpointLabelSpec` finds it as `stops.find(stop_type === kind)`,
    /// which is the definition of an origin and a destination in jsonspec §7.2
    /// — not "the first and last stop", and not the ends of the drawn line.
    /// The two normally coincide; where they do not, the reader's own labelling
    /// is the answer and the geometry is not.
    static func endpointStop(
        of ride: RiddenRouteStore.DrawnRide, kind: Kind
    ) -> (index: Int, stop: Stop, position: Coordinate)? {
        guard let index = ride.stops.firstIndex(where: { $0.stopType == kind.rawValue })
        else { return fallbackEndpoint(of: ride, kind: kind) }
        guard let position = MapRideMarkers.stopPositions(of: ride)[index] else {
            return fallbackEndpoint(of: ride, kind: kind)
        }
        return (index, ride.stops[index], position)
    }

    /// Where the stop itself has no drawn position, the ends of the drawn line
    /// stand in — but ONLY for a ride whose route came back whole.
    ///
    /// ``RiddenRouteStore/RouteOutcome`` is what makes that distinction
    /// possible. On a `resolved` ride the first section's start IS the origin,
    /// so the substitution says nothing new. On a `partial` one it would be a
    /// guess: the drawn line begins wherever the first section that solved
    /// begins, which is not where the reader boarded, and printing 起點 there
    /// would name the wrong station.
    private static func fallbackEndpoint(
        of ride: RiddenRouteStore.DrawnRide, kind: Kind
    ) -> (index: Int, stop: Stop, position: Coordinate)? {
        guard ride.route.isResolved else { return nil }
        let ordered = ride.segments.sorted { $0.segmentIndex < $1.segmentIndex }
        switch kind {
        case .origin:
            guard let segment = ordered.first, let position = segment.coordinates.first
            else { return nil }
            let name = segment.from ?? ride.stops.first?.name ?? ""
            guard !name.isEmpty else { return nil }
            return (0, Stop(name: name, stopType: Kind.origin.rawValue), position)
        case .destination:
            guard let segment = ordered.last, let position = segment.coordinates.last
            else { return nil }
            let name = segment.to ?? ride.stops.last?.name ?? ""
            guard !name.isEmpty else { return nil }
            return (
                max(ride.stops.count - 1, 0),
                Stop(name: name, stopType: Kind.destination.rawValue), position
            )
        }
    }

    // MARK: - the overlap-avoidance layout

    /// Gap from the dot to the first card.
    static let base: CGFloat = 10
    /// Gap kept between neighbouring boxes.
    static let padding: CGFloat = 4
    /// How many rings out a card may be pushed before it gives up.
    static let rings = 8

    private static func hits(_ a: CGRect, _ b: CGRect) -> Bool {
        a.minX < b.maxX + padding && a.maxX > b.minX - padding
            && a.minY < b.maxY + padding && a.maxY > b.minY - padding
    }

    /// Places each card just above or just below its dot, alternating and
    /// stacking outward, so cards that would collide get pushed apart and all
    /// stay readable.
    ///
    /// It looks like over-engineering for two labels until the round-trip day:
    /// 沼津 → 沼津, 札幌 → 札幌. The ride's origin and its destination are then
    /// the SAME point, and a card drawn at each would print one name exactly
    /// on top of the other.
    ///
    /// Pure pixel-space layout, and `points` is the caller's projection of
    /// `specs` — relative distances only change on zoom, which is why the web
    /// app recomputes this on render and on `zoomend` rather than per pan.
    ///
    /// `direction` is kept as well as `offset` because the card has a pointer:
    /// a top card's tail hangs off its bottom edge and a bottom card's off its
    /// top, so the two are not the same card mirrored.
    static func layout(_ specs: inout [Spec], at points: [CGPoint]) {
        var placed: [CGRect] = []
        for index in specs.indices {
            let point = index < points.count ? points[index] : .zero
            let halfWidth = specs[index].width / 2
            let height = specs[index].height > 0 ? specs[index].height : 20
            var picked: (direction: Direction, offset: CGPoint)?
            var ring = 0
            while ring < rings, picked == nil {
                let step = base + CGFloat(ring) * (height + padding)
                for candidate: (Direction, CGFloat) in [(.top, -step), (.bottom, step)] {
                    let top = candidate.0 == .top
                        ? point.y + candidate.1 - height
                        : point.y + candidate.1
                    let box = CGRect(
                        x: point.x - halfWidth, y: top,
                        width: halfWidth * 2, height: height)
                    guard !placed.contains(where: { hits(box, $0) }) else { continue }
                    placed.append(box)
                    picked = (candidate.0, CGPoint(x: 0, y: candidate.1))
                    break
                }
                ring += 1
            }
            let resolved = picked
                ?? (
                    .top,
                    CGPoint(x: 0, y: -(base + CGFloat(rings) * (height + padding)))
                )
            specs[index].direction = resolved.direction
            specs[index].offset = resolved.offset
        }
    }

    /// The card's centre relative to its dot, which is what `MKAnnotationView`
    /// wants where the web app hands MapLibre an anchor plus an offset.
    ///
    /// A `top` card's box runs from `offset.y − height` to `offset.y`; a
    /// `bottom` card's from `offset.y` to `offset.y + height`. Both centre half
    /// a height further out.
    static func centreOffset(for spec: Spec) -> CGPoint {
        CGPoint(
            x: spec.offset.x,
            y: spec.direction == .top
                ? spec.offset.y - spec.height / 2
                : spec.offset.y + spec.height / 2)
    }

    /// The horizontal viewport clamp: a station near the container edge would
    /// centre its card half off-screen, so the whole card is shifted sideways
    /// until it fits. Re-run whenever the projection moves, exactly as the web
    /// app re-runs it on `zoomend` / `moveend`.
    static func clampHorizontally(
        _ spec: inout Spec, at point: CGPoint, containerWidth: CGFloat
    ) {
        let half = spec.width / 2
        let left = point.x + spec.offset.x - half
        let right = point.x + spec.offset.x + half
        var dx: CGFloat = 0
        if left < 4 {
            dx = 4 - left
        } else if right > containerWidth - 4 {
            dx = containerWidth - 4 - right
        }
        guard dx != 0 else { return }
        spec.offset.x += dx
    }
}
