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
///    line only by the length of its group. At the widest native-map views an
///    additional, finer length ladder keeps only genuinely long corridors.
///    That is enough for a vector basemap that can draw a hairline, but Apple
///    Maps at z4 is a country-outline map with a few motorways, and a national
///    network drawn
///    over it reads as a coloured smear. So a line now appears only when the
///    zoom clears *all three* thresholds: the ported length tier, the finer
///    wide-view length tier, and how important its operator says it is. Trunks
///    survive the wide views; branches wait.
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
    ///
    /// "Room to spare" is thinner since 2026-08-24, and deliberately so.
    /// Bringing decimation onto the web app's geometry contract — see
    /// `RailStyle.simplifyTolerance`, which was eight times too loose — raised
    /// the worst build measured anywhere in the five packages from 25,000
    /// drawn vertices to 38,698 (largest iPad, app zoom 8, over the Kansai and
    /// Chugoku density). That is still under the budget, so nothing is dropped
    /// today, but the backstop is now within a few per cent of binding, and if
    /// a denser package pushes it past, this is where it shows: branches shed
    /// first, ``fitToBudget`` reports the threshold it stopped at, and the
    /// diagnostics panel shows a threshold below the zoom. The measured lever
    /// if that happens is clipping each interval to the build rect before
    /// decimating rather than raising the number — it takes a city view from
    /// 22,185 vertices to 2,460, though it does little at the wide zooms where
    /// the worst case actually sits.
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
    /// The rank ladder, recalibrated 2026-08-22. **Not**
    /// `Visibility.minZoomForRank`, which is the web app's own 3,4,5,6,7 and is
    /// fixture-protected; this is the iOS-side policy and it has to be free to
    /// move, because the two bugs fixed alongside it changed what it was
    /// compensating for.
    ///
    /// Those bugs, both measured over all 652 jp lines:
    ///
    /// 1. the threshold was compared against this app's zoom, which is one
    ///    level above MapLibre's (see `RailMapView.zoomLevel(of:)`), so every
    ///    ported number fired one step wider than the web app fires it;
    /// 2. it was handed each line's OWN length, where
    ///    `Visibility.minZoomByLineId` deliberately uses the length of the
    ///    line's visibility GROUP — so a railway the package stores as several
    ///    administrative entries appeared in fragments, which is the exact
    ///    thing that grouping exists to prevent.
    ///
    /// Lines drawn at the same ground scale, before and after, against the web
    /// app as the reference:
    ///
    ///     app zoom     4     5     6     7     8
    ///     web         66   140   262   431   652
    ///     before      33    67   386   652   652
    ///     after       41    62   262   431   652
    ///
    /// That rank-only recalibration agreed with the web app from app z6
    /// upward. The finer length ladder below deliberately tightens z4–z7
    /// further; z8 remains the unchanged all-lines stop. The old rank ladder
    /// had it backwards: it over-drew by half at z6/z7 and under-drew at
    /// z4/z5.
    ///
    /// The ladder was chosen by measurement, not taste: 3,3,4,4,5 and 3,3,3,4,5
    /// also land on 262/431 but give the web app's own z5 count back, and
    /// 0,0,0,0,0 is simply the web app with no policy of ours at all.
    private static let rankMinZoom = [3, 3, 4, 5, 6]

    /// A finer length ladder for the widest Apple Maps views, in MapLibre's
    /// zoom convention.
    ///
    /// The ported ladder groups every line over 150 km together. That makes a
    /// 160 km regional line and a 1,000 km national trunk equally eligible at
    /// the largest scale. These extra stops retain the same complete-group
    /// length input while spreading those long lines over the low zooms:
    ///
    ///     app zoom       4       5       6       7       8
    ///     minimum km   300     120      50      20       0
    ///     jp before     41      62     262     431     652
    ///     jp after      24      51     195     337     652
    ///
    /// Near detail is unchanged: every line is still present by app zoom 8.
    /// These are iOS rendering thresholds, not changes to RailCore's
    /// fixture-protected web parity rule.
    private static func wideViewMinZoom(visibilityLengthKm: Double) -> Int {
        if visibilityLengthKm >= 300 { return 3 }
        if visibilityLengthKm >= 120 { return 4 }
        if visibilityLengthKm >= 50 { return 5 }
        if visibilityLengthKm >= 20 { return 6 }
        return 7
    }

    /// The zoom at which a line may first be drawn, in **this app's** zoom.
    ///
    /// `portedMinZoom` is `Visibility.minZoomByLineId`'s answer for this line —
    /// a MapLibre zoom, computed from the line's visibility group. The rank
    /// terms are the native additions: taking the largest means a line has to
    /// be long enough at both levels and important enough, where the web app
    /// asks only the first. The result is then converted once, here, so no
    /// caller has to remember which convention it is holding.
    static func minZoom(
        portedMinZoom: Int,
        rank: Int?,
        visibilityLengthKm: Double
    ) -> Double {
        let byRank = rank.flatMap {
            $0 >= 0 && $0 < rankMinZoom.count ? rankMinZoom[$0] : nil
        } ?? 0
        let byWideViewLength = wideViewMinZoom(visibilityLengthKm: visibilityLengthKm)
        return RailStyle.zoom(
            fromMapLibre: Double(max(max(portedMinZoom, byRank), byWideViewLength)))
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
