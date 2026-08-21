import MapKit
import RailCore

/// How much of the network is drawn at a given zoom, and where.
///
/// **This is not a port.** `RailCore.Visibility` is the web app's own rule and
/// is verified against it; this is an iOS-side policy layered on top, and it
/// deliberately draws *less* than the web app does at low zoom. It is kept out
/// of `RailCore` for exactly that reason — there is no JavaScript to check it
/// against, and mixing a policy of our own into the ported tier would make the
/// parity fixtures meaningless.
///
/// Three rules, in the order they matter:
///
/// 1. **A line waits for both its length and its rank.** The web app hides a
///    line only by the length of its group. That is enough for a vector
///    basemap that can draw a hairline, but Apple Maps at z4 is a
///    country-outline map with a few motorways, and a national network drawn
///    over it reads as a coloured smear. So a line now appears only when the
///    zoom clears *both* thresholds: how long it is, and how important its
///    operator says it is. Trunks survive the wide views; branches wait.
///
/// 2. **Nothing far off screen is built.** Overlays outside the visible rect
///    cost geometry, Metal buffers and decimation time to produce something
///    nobody can see. Building is done for a padded rect rather than the exact
///    one so that panning does not rebuild constantly.
///
/// 3. **A vertex budget is the backstop.** The first two rules are tuned
///    against the five packages that ship today. A denser country, or a zoom
///    where an unusual number of long lines coincide, would slip past them —
///    so if a build would exceed the budget, the threshold is raised until it
///    fits. That makes the worst case a function of the budget rather than of
///    the data.
enum NetworkLOD {

    /// Roughly what the renderer can submit without the frame budget showing.
    ///
    /// Derived from measurement, not taste: Japan at a national view drew
    /// 12,433 vertices in 98 ms, and the city view's 89,785 in 229 ms was
    /// already visible as a hitch when crossing a zoom bucket. 40,000 sits
    /// between them with room to spare.
    static let vertexBudget = 40_000

    /// How far outside the visible rect to build, as a fraction of its size.
    ///
    /// Half a screen in each direction. Small enough that a nationwide view
    /// does not build the whole country twice over; large enough that ordinary
    /// panning stays inside what was already built, which is what keeps the
    /// pan gesture free of work.
    static let padding = 0.5

    /// The zoom at which a line may first be drawn.
    ///
    /// `Visibility.minZoomForLength` is the ported rule and supplies the
    /// floor. The rank term is the addition: `rank` is the package's own
    /// editorial ordering, 0 for a trunk, and `minZoomForRank` already maps it
    /// to 3…7. Taking the larger of the two means a line has to be both long
    /// enough and important enough, where the web app asks only the first.
    static func minZoom(lengthKm: Double, rank: Int?) -> Double {
        let byLength = Double(Visibility.minZoomForLength(totalKm: lengthKm))
        let byRank = Double(Visibility.minZoomForRank(rank))
        return max(byLength, byRank)
    }

    /// The rect to build for: the visible one, grown by ``padding``.
    static func buildRect(for visible: MKMapRect) -> MKMapRect {
        visible.insetBy(
            dx: -visible.size.width * padding,
            dy: -visible.size.height * padding
        )
    }

    /// Chooses which lines are eligible: near enough to be seen, and
    /// important enough for this zoom.
    ///
    /// The vertex budget is deliberately *not* applied here. What a line costs
    /// to draw is its decimated vertex count, which is not known until it has
    /// been decimated — and it varies by more than an order of magnitude with
    /// zoom. Budgeting on the raw count instead cut a national view of Japan
    /// from 262 lines to 7, because it was weighing 394,285 stored vertices
    /// against a budget meant for the ~12,000 actually drawn.
    static func select<Line: LODLine>(
        from lines: [Line],
        zoom: Double,
        buildRect: MKMapRect
    ) -> (lines: [Line], culledOffScreen: Int) {
        // Off-screen first: it is a cheap test and it shrinks everything after.
        let onScreen = lines.filter { $0.mapRect.intersects(buildRect) }
        return (onScreen.filter { $0.lodMinZoom <= zoom }, lines.count - onScreen.count)
    }

    /// Applies the vertex budget to what the decimation actually produced.
    ///
    /// Least important first, where importance is the threshold a line had to
    /// clear to be drawn at all — so a budget squeeze sheds branches and keeps
    /// trunks, which is the same ordering the zoom rule uses. Ties are broken
    /// by the cheaper line surviving, because at that point the only question
    /// left is how much map fits in the budget.
    ///
    /// Returns the kept builds and the threshold that was effectively in force,
    /// which is worth reporting: when it is below the zoom, the map is showing
    /// less than the zoom alone would allow, and that should be visible rather
    /// than silent.
    static func fitToBudget<Build: LODBuild>(
        _ builds: [Build],
        zoom: Double
    ) -> (kept: [Build], threshold: Double) {
        let total = builds.reduce(0) { $0 + $1.drawnVertexCount }
        guard total > vertexBudget else { return (builds, zoom) }

        let ordered = builds.sorted {
            $0.line.lodMinZoom == $1.line.lodMinZoom
                ? $0.drawnVertexCount < $1.drawnVertexCount
                : $0.line.lodMinZoom < $1.line.lodMinZoom
        }

        var kept: [Build] = []
        var spent = 0
        var threshold = zoom
        for build in ordered {
            let next = spent + build.drawnVertexCount
            if next > vertexBudget { break }
            spent = next
            kept.append(build)
            threshold = build.line.lodMinZoom
        }
        return (kept, threshold)
    }
}

/// What ``NetworkLOD`` needs to know about a line. A protocol so the policy can
/// be reasoned about — and tested — without the whole rendering stack.
protocol LODLine {
    var mapRect: MKMapRect { get }
    var lodMinZoom: Double { get }
}

/// One line after decimation: what it will actually cost to draw.
protocol LODBuild {
    associatedtype Line: LODLine
    var line: Line { get }
    var drawnVertexCount: Int { get }
}
