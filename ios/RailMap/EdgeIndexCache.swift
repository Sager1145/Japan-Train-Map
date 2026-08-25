import Foundation
import RailCore

/// The N02 edge index, built once per region and then shared.
///
/// Building one means parsing the whole of `rail-sections*.json` and walking
/// every edge in it — seconds, not milliseconds, which is why the statistics
/// screen has a `readingNetwork` stage to show for it. The network itself
/// never changes while the app is running, so building it more than once per
/// region is pure waste, and there are now two callers that want the same
/// answer:
///
/// - `MileageStatisticsStore`, which rebuilds its numbers whenever the rides
///   change — and since the shell's route key started covering the whole
///   record rather than ids and visibility, that is every edit, not only an
///   add or a delete. Re-reading the network on each one would put seconds
///   between saving a journey and seeing its statistics move.
/// - the ridden-line category filter, which classifies a drawn segment by
///   dominant km over these same edges.
///
/// An `actor` rather than a lock: the build is the expensive part and it has
/// to be joinable, so two callers asking for the same region at once wait on
/// one build instead of starting two.
actor EdgeIndexCache {
    static let shared = EdgeIndexCache()

    private var indexes: [String: Statistics.EdgeIndex] = [:]
    private var inFlight: [String: Task<Statistics.EdgeIndex, Error>] = [:]

    /// The index for one region, building it if this is the first ask.
    func index(country: String) async throws -> Statistics.EdgeIndex {
        if let ready = indexes[country] { return ready }
        // Joined rather than started again: the second caller of a region
        // whose build is already running is exactly the case this exists for.
        if let running = inFlight[country] { return try await running.value }

        let task = Task.detached(priority: .userInitiated) {
            try Self.build(country: country)
        }
        inFlight[country] = task
        defer { inFlight[country] = nil }
        // Detached, so a caller that is cancelled while waiting does not take
        // the build down with it — the other caller is still waiting on it.
        let built = try await task.value
        indexes[country] = built
        return built
    }

    /// One index covering several regions.
    ///
    /// The all-regions statistics scope needs a single index: coverage is a
    /// fraction of a denominator, and five denominators is five answers rather
    /// than one. The networks are geographically disjoint, so laying the
    /// finished indexes side by side is arithmetic rather than a judgement —
    /// each region's masks were already decided by its OWN country's rules
    /// when its index was built, and nothing here re-decides them.
    ///
    /// The one thing that is not arithmetic is a line NAME. The packages share
    /// exactly one — 海岸線, which is a Kobe subway line in Japan and a
    /// Taiwanese main line — and a breakdown keyed on the bare name would fuse
    /// the two into one row whose kilometres belong to neither. Any name that
    /// arrives from more than one region is therefore qualified with its
    /// region, and names that are unique are left exactly as they are so the
    /// single-region case is untouched.
    func merged(countries: [String]) async throws -> Statistics.EdgeIndex {
        var built: [(country: String, index: Statistics.EdgeIndex)] = []
        for country in countries {
            built.append((country, try await index(country: country)))
        }
        return Self.merge(built)
    }

    nonisolated static func merge(
        _ parts: [(country: String, index: Statistics.EdgeIndex)]
    ) -> Statistics.EdgeIndex {
        if parts.count == 1 { return parts[0].index }

        // Which line names arrive from more than one region.
        var seenIn: [String: Set<String>] = [:]
        for part in parts {
            for name in part.index.lineTotByCat.keys where !name.isEmpty {
                seenIn[name, default: []].insert(part.country)
            }
        }
        let shared = Set(seenIn.filter { $0.value.count > 1 }.keys)
        func qualified(_ name: String, _ country: String) -> String {
            guard !name.isEmpty, shared.contains(name) else { return name }
            return "\(name)（\(country.uppercased())）"
        }

        var map: [String: Int] = [:]
        var km: [Double] = []
        var mask: [Int] = []
        var lineName: [String] = []
        var lineMask: [Int] = []
        var totalKm = 0.0
        var totalsByMask: [Int: Double] = [:]
        var lineTotByCat = Statistics.OrderedDictionary<String, [Int: Double]>()
        var lineOperator = Statistics.OrderedDictionary<String, String>()

        for part in parts {
            let offset = km.count
            km += part.index.km
            mask += part.index.mask
            lineName += part.index.lineName.map { qualified($0, part.country) }
            lineMask += part.index.lineMask
            totalKm += part.index.totalKm
            // Edge keys are built from coordinates, so two regions cannot
            // produce the same one — but `merging` states what happens rather
            // than trusting that, and keeping the FIRST matches the order the
            // regions were asked for.
            map.merge(part.index.map.mapValues { $0 + offset }) { first, _ in first }
            for (bucket, value) in part.index.totalsByMask {
                totalsByMask[bucket, default: 0] += value
            }
            for (name, byCategory) in part.index.lineTotByCat.pairs {
                let key = qualified(name, part.country)
                var merged = lineTotByCat[key] ?? [:]
                for (bucket, value) in byCategory { merged[bucket, default: 0] += value }
                lineTotByCat[key] = merged
            }
            for (name, owner) in part.index.lineOperator.pairs {
                let key = qualified(name, part.country)
                if lineOperator[key] == nil { lineOperator[key] = owner }
            }
        }

        return Statistics.EdgeIndex(
            map: map, km: km, mask: mask, lineName: lineName, lineMask: lineMask,
            totalKm: totalKm, totalsByMask: totalsByMask,
            lineTotByCat: lineTotByCat, lineOperator: lineOperator)
    }

    /// The index for one region if it is already built, without building one.
    ///
    /// For callers that cannot wait — the render path, which must answer
    /// "is this segment's category hidden?" synchronously and treats a missing
    /// index as "undetermined, stays visible", exactly as the web app does.
    func ready(country: String) -> Statistics.EdgeIndex? { indexes[country] }

    private nonisolated static func build(
        country: String
    ) throws -> Statistics.EdgeIndex {
        let suffix = country == "jp" ? "" : "-\(country)"
        guard let url = Bundle.main.url(
            forResource: "rail-sections\(suffix)", withExtension: "json")
        else { throw MissingSections(country: country) }
        let sections = try Statistics.SectionFeatureCollection.load(contentsOf: url).sections
        return Statistics.buildEdgeIndex(sections: sections, country: country)
    }

    struct MissingSections: LocalizedError {
        let country: String
        var errorDescription: String? {
            "Statistics rail sections for \(country) are missing from the app bundle."
        }
    }
}
