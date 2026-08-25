import Foundation

/// Which lines a given zoom is allowed to draw.
///
/// Ported from `rail-network.js`. This is not a performance heuristic bolted
/// on for iOS — it is the web app's own level-of-detail rule, and reproducing
/// it is what makes the two apps show the *same* railway at the same zoom.
/// That it also happens to be the difference between drawing 652 lines and
/// drawing 30 at a national view is a consequence, not the motive.
public enum Visibility {

    /// `RANK_MINZOOM` — a line's editorial importance, 0 being a trunk.
    private static let rankMinZoom = [3, 4, 5, 6, 7]

    public static func minZoomForRank(_ rank: Int?) -> Int {
        guard let rank, rank >= 0, rank < rankMinZoom.count else { return 0 }
        return rankMinZoom[rank]
    }

    /// Zoom-out visibility is decided by the COMPLETE line length: long trunks
    /// survive the widest views and short lines drop out first.
    public static func minZoomForLength(totalKm: Double) -> Int {
        if totalKm >= 150 { return 3 }
        if totalKm >= 70 { return 4 }
        if totalKm >= 30 { return 5 }
        if totalKm >= 12 { return 6 }
        return 7
    }

    /// Groups the pieces of one physical line that the package happens to
    /// store as several administrative entries.
    ///
    /// Both operator and display name must agree. The JavaScript is explicit
    /// about why: grouping on a generic name such as 本線 alone would bind
    /// unrelated railways across the country into one visibility unit. The
    /// separator is a NUL so a name containing the separator cannot forge a
    /// different key.
    public static func visibilityGroupKey(_ line: CompactPackage.Line) -> String {
        "\(line.operator ?? "")\u{0000}\(line.name)"
    }

    /// The complete physical-line length assigned to every administrative
    /// line id in the package.
    ///
    /// Exposed separately from the coarse web visibility tier because native
    /// renderers may need a finer low-zoom policy while preserving the exact
    /// same grouping rule. Returning the group total keeps those policies
    /// length-based without reimplementing operator + name grouping elsewhere.
    public static func groupLengthByLineId(_ package: CompactPackage) -> [String: Double] {
        var groupKm: [String: Double] = [:]
        for line in package.lines {
            let km = line.segments.reduce(0) { $0 + $1.distanceKm }
            groupKm[visibilityGroupKey(line), default: 0] += km
        }
        return Dictionary(uniqueKeysWithValues: package.lines.map { line in
            (line.id, groupKm[visibilityGroupKey(line)] ?? 0)
        })
    }

    /// The minimum zoom for every line in a package.
    ///
    /// The length that decides a line's fate is its **group's** total, not its
    /// own, so that all the pieces of one physical railway appear and vanish
    /// together instead of the map growing a line in fragments.
    public static func minZoomByLineId(_ package: CompactPackage) -> [String: Int] {
        groupLengthByLineId(package).mapValues { minZoomForLength(totalKm: $0) }
    }
}
