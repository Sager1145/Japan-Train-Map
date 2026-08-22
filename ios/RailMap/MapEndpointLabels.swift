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
/// ## What the layout is for
///
/// It looks like over-engineering for two labels until the round-trip day:
/// 沼津 → 沼津, 札幌 → 札幌. The ride's origin and its destination are then the
/// SAME point, and a card drawn at each would print one name exactly on top of
/// the other. So each card is placed just above or just below its dot,
/// alternating and stacking outward until it finds clear space.
enum MapEndpointLabels {

    /// One card, before and after placement.
    struct Spec {
        /// `${lat},${lon}|${kind}` — the web app's dedup key, so a ride whose
        /// origin and destination differ only in kind still gets two cards
        /// while two rides sharing an endpoint get one.
        let key: String
        let trainID: String
        let coordinate: Coordinate
        let text: String
        let kind: Kind
        /// Estimated card size in points. The layout needs the real box, not
        /// the text: a wrapped name is taller and would otherwise be placed as
        /// though it were one line and covered by its neighbour.
        let width: CGFloat
        let height: CGFloat
        /// Filled in by ``layout(_:at:)``.
        var direction: Direction = .top
        var offset: CGPoint = .zero
    }

    enum Kind: String { case origin, destination }
    enum Direction { case top, bottom }

    // MARK: - measuring

    /// `700 11px system-ui`, as the web app's measuring canvas is configured.
    static var font: UIFont { .systemFont(ofSize: 11, weight: .bold) }

    /// The widest a card may grow before its text wraps — the CSS
    /// `max-width: 340px` the estimate is built around.
    static let maxWidth: CGFloat = 340

    static func measure(_ text: String) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        return (text as NSString)
            .size(withAttributes: [.font: font])
            .width
    }

    /// `buildEndpointLabelSpec`, for the fields a solved ride actually carries.
    ///
    /// The web app's card also holds a 起點/終點 badge, the stop's departure or
    /// arrival time, and the reader's enabled name readings stacked under the
    /// name. All three come off `train.stops`, which
    /// `RiddenRouteStore.DrawnRide` does not carry — so the estimate below runs
    /// with no badge and no reading lines rather than with invented ones, and
    /// the widths it produces are the widths of the card this app draws.
    static func spec(
        trainID: String, kind: Kind, name: String, at coordinate: Coordinate
    ) -> Spec? {
        guard !name.isEmpty else { return nil }
        // `+ 20` is the card's horizontal padding; the badge chip's `+ 38` has
        // no badge to belong to here.
        let mainWidth = measure(name) + 20
        let fullWidth = mainWidth
        let mainLines = max(1, min(3, Int(ceil(mainWidth / maxWidth))))
        return Spec(
            key: "\(String(format: "%.5f", coordinate.lat)),"
                + "\(String(format: "%.5f", coordinate.lon))|\(kind.rawValue)",
            trainID: trainID,
            coordinate: coordinate,
            text: name,
            kind: kind,
            width: min(maxWidth, fullWidth),
            // ~18 pt per name line, plus padding and border.
            height: CGFloat(6 + 18 * mainLines)
        )
    }

    /// The two endpoints of one ride: the first section's `from` and the last
    /// section's `to`.
    ///
    /// The web app reads `train.stops` for the entries whose `stop_type` is
    /// `origin` / `destination`. Those are the same two places, named by the
    /// same strings — a route section's ends ARE the stops the solver was
    /// given — so this is the same answer reached from the geometry.
    static func specs(for ride: RiddenRouteStore.DrawnRide) -> [Spec] {
        guard let first = ride.segments.first, let last = ride.segments.last,
              let origin = first.coordinates.first,
              let destination = last.coordinates.last else { return [] }
        var result: [Spec] = []
        var seen: Set<String> = []
        for candidate in [
            spec(trainID: ride.id, kind: .origin, name: first.from ?? "", at: origin),
            spec(
                trainID: ride.id, kind: .destination, name: last.to ?? "",
                at: destination),
        ] {
            guard let candidate, seen.insert(candidate.key).inserted else { continue }
            result.append(candidate)
        }
        return result
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
