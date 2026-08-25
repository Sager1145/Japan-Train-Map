import Foundation
import Testing

@testable import RailCore

/// `port-fixtures/stats.json` — the mileage statistics of `app-stats.js` §23a.
///
/// The headline case is `unionIsNotASum`: the fixture contains a scenario that
/// lists the SAME ridden entry twice, and its deduped total is bit-for-bit the
/// total of listing it once, while the accumulating sum beside it is exactly
/// double. A port that adds instead of folding into a set passes every other
/// case here and fails that one.
///
/// Everything is compared on `Double.bitPattern`. Kilometre totals are sums of
/// hundreds of thousands of terms, so they only match if every term matches
/// and the terms are added in the same order — which is the point: an
/// approximate comparison here would hide both a wrong constant and a wrong
/// iteration order, and the second of those is a real hazard (see
/// `summationOrderIsLoadBearing`).
struct StatisticsParityTests {

    // MARK: - fixture shapes

    /// A JSON value whose type is part of the case.
    ///
    /// `ride_segment` arrives as `true`, `false`, `1`, `"true"` or absent, and
    /// section codes as either `"21"` or `21`. Decoding those into `Bool` or
    /// `String` would erase exactly the distinction under test.
    enum AnyJSON: Decodable, Sendable {
        case string(String)
        case number(Double)
        case bool(Bool)
        case null

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() {
                self = .null
            } else if let b = try? c.decode(Bool.self) {
                self = .bool(b)
            } else if let d = try? c.decode(Double.self) {
                self = .number(d)
            } else if let s = try? c.decode(String.self) {
                self = .string(s)
            } else {
                self = .null
            }
        }

        /// `x === true`, which is what the ride filter asks.
        var isExactlyTrue: Bool {
            if case .bool(true) = self { return true }
            return false
        }

        var asString: String? {
            if case .string(let s) = self { return s }
            return nil
        }
    }

    struct Fixture: Decodable {
        let cases: [ClassificationCase]
        let stationCategories: [StationCase]
        let indexes: [IndexCase]
        let geometries: [PooledGeometry]
        let trains: [TrainCase]
        let aggregates: [AggregateCase]
        let tops: [TopCase]
        let views: [ViewCase]
        let subsets: [SubsetCase]
        let containment: [ContainmentCase]
        let rideTimes: [RideTimeCase]
        let adversarialTrains: [RideTimeCase]
        let serviceSums: [ServiceSumCase]
        let filters: [FilterCase]
    }

    struct ClassificationCase: Decodable {
        let country: String
        let props: Statistics.SectionProperties
        let classCode: String
        let institutionCode: String
        let lineName: String
        let `operator`: String
        let mask: Int
        let exclusiveBucket: Int
        let filterCategory: String
    }

    struct StationCase: Decodable {
        let country: String
        let props: Statistics.SectionProperties?
        let category: String?
    }

    struct IndexCase: Decodable {
        struct LineRow: Decodable {
            let line: String
            let byCat: [String: Double]
        }
        struct OperatorRow: Decodable {
            let line: String
            let `operator`: String
        }
        struct SampledEdge: Decodable {
            let index: Int
            let km: Double
            let mask: Int
            let line: String
            let lineMask: Int
        }
        struct SampledKey: Decodable {
            let key: String
            let index: Int
        }
        let country: String
        let sectionCount: Int
        let edgeCount: Int
        let totalKm: Double
        let totalsByMask: [String: Double]
        let lineTotByCat: [LineRow]
        let lineOperator: [OperatorRow]
        let sampledEdges: [SampledEdge]
        let sampledKeys: [SampledKey]
    }

    struct PooledGeometry: Decodable {
        let id: Int
        let type: String?
        let lines: [String]
    }

    struct FixtureFeature: Decodable {
        let geometry: Int
        let rideSegment: AnyJSON
        let from: String?
        let to: String?
    }

    struct EntrySpan: Decodable {
        let key: String
        let km: Double
        let mask: Int
    }

    struct EntrySegment: Decodable {
        let from: String
        let to: String
        let km: Double
        let bucket: Int
        let edgeIds: [Int]
    }

    struct Entry: Decodable {
        let km: Double
        let edges: [Int]
        let spans: [EntrySpan]
        let segments: [EntrySegment]
    }

    struct TrainCase: Decodable {
        let country: String
        let id: String
        let why: String
        let trainType: String?
        let date: String?
        let stops: [RideTimeCase.StopJSON]
        let features: [FixtureFeature]
        let entry: Entry
    }

    struct Aggregate: Decodable {
        let riddenAll: Double
        let unmatchedKm: Double
        let riddenByMask: [String: Double]
        let lineRidByCat: [IndexCase.LineRow]
    }

    struct ServiceGroupJSON: Decodable {
        let km: Double
        let minutes: Double
        let count: Int
    }

    struct ServicesJSON: Decodable {
        let hsr: ServiceGroupJSON
        let ltd: ServiceGroupJSON
        let other: ServiceGroupJSON
    }

    struct AggregateCase: Decodable {
        let country: String
        let label: String
        let why: String
        let trainIndexes: [Int]
        let summedTrainKm: Double
        let aggregate: Aggregate
        let services: ServicesJSON
        let sumRideMinutes: Double
    }

    struct TopRowJSON: Decodable {
        let from: String
        let to: String
        let count: Int
        let km: Double
        let bucket: Int
        let edgeIdCount: Int?
    }

    struct TopJSON: Decodable {
        struct Bucket: Decodable {
            let mask: Int
            let rows: [TopRowJSON]
        }
        let byMask: [Bucket]
        let all: [TopRowJSON]
    }

    struct TopCase: Decodable {
        let country: String
        let label: String
        let trainIndexes: [Int]
        let top: TopJSON
    }

    struct ViewCase: Decodable {
        struct Overall: Decodable {
            let riddenAll: Double
            let unmatchedKm: Double
            let riddenByMask: [String: Double]
            let lineRidByCat: [IndexCase.LineRow]
            let rideMinutes: Double
            let services: ServicesJSON
            let topRowCount: Int
        }
        struct Daily: Decodable {
            let date: String
            let trainCount: Int
            let stats: DailyStats
            struct DailyStats: Decodable {
                let riddenAll: Double
                let unmatchedKm: Double
                let riddenByMask: [String: Double]
                let lineRidByCat: [IndexCase.LineRow]
                let rideMinutes: Double
                let services: ServicesJSON
            }
        }
        let country: String
        let selectedDate: String?
        let categories: [Int]
        let overall: Overall
        let daily: Daily?
    }

    struct SubsetCase: Decodable {
        let inner: [Int]
        let outer: [Int]
        let isSubset: Bool
    }

    struct ContainmentCase: Decodable {
        struct Row: Decodable {
            let from: String
            let to: String
            let count: Int
            let km: Double
            let bucket: Int
            let edgeIds: [Int]
        }
        struct Kept: Decodable {
            let from: String
            let to: String
        }
        let why: String
        let rows: [Row]
        let kept: [Kept]
    }

    struct RideTimeCase: Decodable {
        struct StopJSON: Decodable {
            let arrival: String?
            let departure: String?
            let stopType: String?
            let rideSegment: AnyJSON

            private enum CodingKeys: String, CodingKey {
                case arrival, departure
                case stopType = "stop_type"
                case rideSegment = "ride_segment"
            }
        }
        let country: String
        let trainType: String?
        let stops: [StopJSON]
        let rideMinutes: Double?
        let serviceGroup: String
        let why: String?
    }

    struct ServiceSumCase: Decodable {
        let country: String
        let trainCount: Int
        let sumRideMinutes: Double
    }

    struct FilterCase: Decodable {
        let country: String
        let rideId: String
        let feature: FixtureFeature
        let category: String?
        let visibleWithAllOn: Bool
    }

    // MARK: - loading

    static let fixture: Fixture = {
        // A load failure here is not a parity failure, so it is loud.
        try! PortFixtures.decode(Fixture.self, "stats.json")
    }()

    static func geometry(_ id: Int) -> (lines: [[Coordinate]], hasGeometry: Bool) {
        let pooled = fixture.geometries[id]
        let lines: [[Coordinate]] = pooled.lines.map { encoded in
            encoded.isEmpty
                ? []
                : encoded.split(separator: ";").map { pair in
                    let parts = pair.split(separator: " ")
                    return Coordinate(lon: Double(parts[0])!, lat: Double(parts[1])!)
                }
        }
        return (lines, pooled.type != nil)
    }

    static func routeFeature(_ f: FixtureFeature) -> Statistics.RouteFeature {
        let g = geometry(f.geometry)
        return Statistics.RouteFeature(
            lines: g.lines, hasGeometry: g.hasGeometry,
            rideSegment: f.rideSegment.isExactlyTrue, from: f.from, to: f.to)
    }

    /// The very same file `stats.mjs` read — the untouched N02-25 sections.
    ///
    /// Decoded with `JSONSerialization` rather than `Codable`: Japan's table is
    /// 21,933 features and 404,646 vertices, and the keyed-container path costs
    /// more than the whole index build.
    static func sections(country: String) throws -> [Statistics.Section] {
        if let cached = cachedSections(country) { return cached }
        let base = country == "jp" ? "rail-sections.json" : "rail-sections-\(country).json"
        let url = try PortFixtures.repositoryRoot().appending(path: "app/data/\(base)")
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        guard let object = root as? [String: Any],
            let features = object["features"] as? [[String: Any]]
        else { throw CocoaError(.fileReadCorruptFile) }

        func value(_ any: Any?) -> Statistics.JSValue? {
            switch any {
            case nil: return nil
            case is NSNull: return .null
            case let s as String: return .string(s)
            case let b as Bool where (any as? NSNumber)?.objCType.pointee == 0x63: return .bool(b)
            case let n as NSNumber: return .number(n.doubleValue)
            default: return nil
            }
        }

        var out: [Statistics.Section] = []
        out.reserveCapacity(features.count)
        for feature in features {
            let props = feature["properties"] as? [String: Any] ?? [:]
            let geometry = feature["geometry"] as? [String: Any]
            let raw = geometry?["coordinates"] as? [[Double]] ?? []
            out.append(
                Statistics.Section(
                    properties: Statistics.SectionProperties(
                        n02_001: value(props["N02_001"]),
                        n02_002: value(props["N02_002"]),
                        n02_003: value(props["N02_003"]),
                        n02_004: value(props["N02_004"]),
                        railwayClassCode: value(props["railway_class_code"]),
                        institutionTypeCode: value(props["institution_type_code"]),
                        lineName: value(props["line_name"]),
                        operatorName: value(props["operator"])),
                    coordinates: raw.map { Coordinate(lon: $0[0], lat: $0[1]) }))
        }
        publishSections(country, out)
        return out
    }

    /// Split in two so `sections(country:)` never takes the cache lock while
    /// `index(country:)` is holding it — the parse happens outside the lock,
    /// and only the read and the publish are guarded.
    private static func cachedSections(_ country: String) -> [Statistics.Section]? {
        sectionLock.lock()
        defer { sectionLock.unlock() }
        return sectionCache[country]
    }

    private static func publishSections(_ country: String, _ value: [Statistics.Section]) {
        sectionLock.lock()
        defer { sectionLock.unlock() }
        sectionCache[country] = value
    }

    private static let sectionLock = NSLock()

    /// Countries are re-read by several tests and Japan is 12 MB of sections
    /// and 377,620 edges, so both are memoised.
    ///
    /// Behind a lock because Swift Testing runs the tests in this suite
    /// concurrently: an unsynchronised dictionary here is a data race, and it
    /// crashes the whole bundle rather than failing a case.
    nonisolated(unsafe) private static var sectionCache: [String: [Statistics.Section]] = [:]
    nonisolated(unsafe) private static var indexCache: [String: Statistics.EdgeIndex] = [:]
    private static let cacheLock = NSLock()

    static func index(country: String) throws -> Statistics.EdgeIndex {
        cacheLock.lock()
        if let cached = indexCache[country] {
            cacheLock.unlock()
            return cached
        }
        defer { cacheLock.unlock() }
        let built = Statistics.buildEdgeIndex(
            sections: try sections(country: country), country: country)
        indexCache[country] = built
        return built
    }

    /// Rebuilds one country's ridden entries from the fixture's own inputs, so
    /// every downstream case is fed exactly what the JavaScript was fed.
    static func entries(country: String) throws -> [Statistics.TrainEntry] {
        let idx = try index(country: country)
        return fixture.trains.filter { $0.country == country }.map { train in
            Statistics.collectTrainStatsEntry(
                features: train.features.map(routeFeature), index: idx)
        }
    }

    /// The trains that pair with `entries(country:)` — the same rides, in the
    /// same order, carrying the type the service tiers read, the date the
    /// daily split filters on and the stops the ride time comes from.
    /// `serviceGroupStats` pairs trains with entries BY INDEX, so this order
    /// is part of the input, not a convenience.
    static func trains(country: String) -> [Statistics.Train] {
        fixture.trains.filter { $0.country == country }.map { ride in
            Statistics.Train(
                id: ride.id, trainType: ride.trainType, date: ride.date,
                stops: ride.stops.map {
                    Statistics.Stop(
                        arrival: $0.arrival, departure: $0.departure, stopType: $0.stopType,
                        rideSegment: $0.rideSegment.isExactlyTrue)
                })
        }
    }

    // MARK: - classification

    @Test("classifySectionMask agrees on every property tuple in every country")
    func classification() throws {
        let cases = Self.fixture.cases
        #expect(cases.count > 700)
        for item in cases {
            #expect(
                item.props.railwayClassCodeString == item.classCode,
                "railway class of \(item.country) \(item.lineName)")
            #expect(item.props.institutionTypeCodeString == item.institutionCode)
            #expect(item.props.lineNameString == item.lineName)
            #expect(item.props.operatorString == item.operator)
            let mask = Statistics.classifySectionMask(item.props, country: item.country)
            #expect(
                mask == item.mask,
                """
                \(item.country) \(item.operator)|\(item.lineName)                 (class \(item.classCode), institution \(item.institutionCode))
                """)
            #expect(Statistics.exclusiveTrackBucket(mask) == item.exclusiveBucket)
            #expect(
                Statistics.filterCategoryForMask(mask, country: item.country)
                    == item.filterCategory)
        }
    }

    @Test("markerCategoryForStation classifies a station from its own line attributes")
    func stationCategories() throws {
        let cases = Self.fixture.stationCategories
        #expect(cases.count > 500)
        for item in cases {
            #expect(
                Statistics.markerCategoryForStation(item.props, country: item.country)
                    == item.category)
        }
    }

    // MARK: - the edge index

    @Test("the N02 edge index matches, edge for edge and total for total", arguments: PortFixtures.countries)
    func edgeIndex(country: String) throws {
        let expected = try #require(Self.fixture.indexes.first { $0.country == country })
        #expect(try Self.sections(country: country).count == expected.sectionCount)
        let idx = try Self.index(country: country)

        #expect(idx.km.count == expected.edgeCount, "edge count for \(country)")
        #expect(
            idx.totalKm.bitPattern == expected.totalKm.bitPattern,
            """
            \(country) network total: \(idx.totalKm) vs \(expected.totalKm) \
            (\(idx.totalKm.ulpDistance(to: expected.totalKm)) ULP over \
            \(idx.km.count) summed edges)
            """)
        for (mask, km) in expected.totalsByMask {
            let got = try #require(idx.totalsByMask[Int(mask)!])
            #expect(got.bitPattern == km.bitPattern, "\(country) denominator for mask \(mask)")
        }

        // The parallel arrays, sampled — and the keys they are reached by,
        // which is the part a port can get subtly wrong and still look right.
        for edge in expected.sampledEdges {
            #expect(idx.km[edge.index].bitPattern == edge.km.bitPattern, "km of edge \(edge.index)")
            #expect(idx.mask[edge.index] == edge.mask, "mask of edge \(edge.index)")
            #expect(idx.lineName[edge.index] == edge.line, "line of edge \(edge.index)")
            #expect(idx.lineMask[edge.index] == edge.lineMask)
        }
        for key in expected.sampledKeys {
            #expect(idx.map[key.key] == key.index, "edge key \(key.key)")
        }

        // The per-line breakdown, in full: this is the table the coverage rows
        // expand into, and it is where the mini-Shinkansen reclassification
        // becomes visible (山形新幹線 / 秋田新幹線 / 博多南線 appear as lines with
        // 新幹線 km even though N02-25 files their track as 在来線).
        #expect(idx.lineTotByCat.count == expected.lineTotByCat.count, "\(country) line count")
        for row in expected.lineTotByCat {
            let got = try #require(idx.lineTotByCat[row.line], "line \(row.line) missing")
            for (mask, km) in row.byCat {
                #expect(
                    got[Int(mask)!]?.bitPattern == km.bitPattern,
                    "\(country) \(row.line) category \(mask)")
            }
        }
        #expect(idx.lineOperator.count == expected.lineOperator.count)
        for row in expected.lineOperator {
            #expect(idx.lineOperator[row.line] == row.operator, "operator of \(row.line)")
        }
    }

    @Test("the mini-Shinkansen corridors are traced and moved out of 在來線")
    func miniShinkansenReclassification() throws {
        // Not a second opinion about the km — those are checked above — but a
        // named assertion that the Dijkstra trace found the corridors at all.
        // Without it the two 奥羽線 sub-corridors would simply be absent, and
        // absence is the failure mode that reads as "everything matched".
        let idx = try Self.index(country: "jp")
        for display in ["山形新幹線", "秋田新幹線", "博多南線"] {
            let byCat = try #require(idx.lineTotByCat[display], "\(display) was not reclassified")
            #expect((byCat[Statistics.maskHSR] ?? 0) > 0, "\(display) has no 新幹線 km")
            #expect(byCat[Statistics.maskCONV] == 0, "\(display) kept 在來線 km")
            #expect((byCat[Statistics.maskJR] ?? 0) > 0, "\(display) lost its JR全線 bit")
        }
    }

    // MARK: - walking a train onto the index

    @Test("collectTrainStatsEntry walks the same edges, spans and sections")
    func trainEntries() throws {
        for country in ["jp", "tw", "mo"] {
            let idx = try Self.index(country: country)
            for train in Self.fixture.trains where train.country == country {
                let entry = Statistics.collectTrainStatsEntry(
                    features: train.features.map(Self.routeFeature), index: idx)
                let why = "\(train.id): \(train.why)"
                #expect(entry.edges == train.entry.edges, "\(why)")
                #expect(entry.km.bitPattern == train.entry.km.bitPattern, "\(why)")
                #expect(entry.spans.count == train.entry.spans.count, "\(why)")
                for (got, want) in zip(entry.spans, train.entry.spans) {
                    #expect(got.key == want.key, "\(why)")
                    #expect(got.km.bitPattern == want.km.bitPattern, "\(why)")
                    #expect(got.mask == want.mask, "\(why)")
                }
                #expect(entry.segments.count == train.entry.segments.count, "\(why)")
                for (got, want) in zip(entry.segments, train.entry.segments) {
                    #expect(got.from == want.from, "\(why)")
                    #expect(got.to == want.to, "\(why)")
                    #expect(got.km.bitPattern == want.km.bitPattern, "\(why)")
                    #expect(got.bucket == want.bucket, "\(why)")
                    #expect(got.edgeIds == want.edgeIds, "\(why)")
                }
            }
        }
    }

    @Test("a short station-anchor tail inherits the edge it leaves")
    func terminalStationAnchorConnector() throws {
        let a = Coordinate(lon: 139.0, lat: 35.0)
        let b = Coordinate(lon: 139.01, lat: 35.0)
        let stationAnchor = Coordinate(lon: 139.0105, lat: 35.0)
        let properties = Statistics.SectionProperties(
            n02_001: .string("11"), n02_002: .string("2"),
            n02_003: .string("test"), n02_004: .string("東日本旅客鉄道"))
        let index = Statistics.buildEdgeIndex(
            sections: [.init(properties: properties, coordinates: [a, b])],
            country: "jp")
        let entry = Statistics.collectTrainStatsEntry(
            features: [.init(
                lines: [[a, b, stationAnchor]], rideSegment: true,
                from: "A", to: "B")],
            index: index)

        let tail = try #require(entry.spans.first)
        #expect(tail.mask == index.mask[0])
        let stats = Statistics.aggregateMileageStats(
            index: index, entries: [entry], country: "jp")
        #expect(stats.unmatchedKm == 0)
        #expect(stats.riddenByMask[Statistics.maskCONV] == entry.km)
    }

    // MARK: - the deduped union

    @Test("aggregateMileageStats folds repeat rides into one union")
    func aggregates() throws {
        for item in Self.fixture.aggregates {
            let all = try Self.entries(country: item.country)
            let picked = item.trainIndexes.map { all[$0] }
            let stats = Statistics.aggregateMileageStats(
                index: try Self.index(country: item.country), entries: picked,
                country: item.country)
            let why = "\(item.country)/\(item.label): \(item.why)"

            #expect(
                stats.riddenAll.bitPattern == item.aggregate.riddenAll.bitPattern,
                """
                \(why)
                  deduped union: \(stats.riddenAll) vs \(item.aggregate.riddenAll) \
                (\(stats.riddenAll.ulpDistance(to: item.aggregate.riddenAll)) ULP)
                """)
            #expect(
                stats.unmatchedKm.bitPattern == item.aggregate.unmatchedKm.bitPattern, "\(why)")
            for (mask, km) in item.aggregate.riddenByMask {
                #expect(
                    stats.riddenByMask[Int(mask)!]?.bitPattern == km.bitPattern,
                    "\(why) — mask \(mask)")
            }
            #expect(stats.lineRidByCat.count == item.aggregate.lineRidByCat.count, "\(why)")
            for row in item.aggregate.lineRidByCat {
                let got = try #require(stats.lineRidByCat[row.line], "\(why) — line \(row.line)")
                for (mask, km) in row.byCat {
                    #expect(got[Int(mask)!]?.bitPattern == km.bitPattern, "\(why) — \(row.line)")
                }
            }

            // The per-train km, which accumulates on purpose.
            var summed = 0.0
            for entry in picked { summed += entry.km }
            #expect(summed.bitPattern == item.summedTrainKm.bitPattern, "\(why)")

            let countryTrains = Self.trains(country: item.country)
            let pickedTrains = item.trainIndexes.map { countryTrains[$0] }
            let services = Statistics.serviceGroupStats(
                trains: pickedTrains, entries: picked, country: item.country)
            // Tier by tier: the km each tier accumulates depends on which
            // trains landed in it, so a re-summed grand total would hide a
            // mis-tiered train behind identical arithmetic.
            for (got, want, tier) in [
                (services.hsr, item.services.hsr, "hsr"),
                (services.ltd, item.services.ltd, "ltd"),
                (services.other, item.services.other, "other"),
            ] {
                #expect(got.km.bitPattern == want.km.bitPattern, "\(why) — \(tier) km")
                #expect(got.minutes.bitPattern == want.minutes.bitPattern, "\(why) — \(tier)")
                #expect(got.count == want.count, "\(why) — \(tier) count")
            }
            #expect(
                Statistics.sumRideMinutes(pickedTrains).bitPattern
                    == item.sumRideMinutes.bitPattern, "\(why)")
        }
    }

    /// The single most important property in this file, stated on its own so
    /// that a failure names it rather than merely listing a number.
    @Test("riding the same track twice does not count it twice")
    func unionIsNotASum() throws {
        let once = try #require(
            Self.fixture.aggregates.first { $0.label == "single" })
        let twice = try #require(
            Self.fixture.aggregates.first { $0.label == "same-entry-listed-twice" })

        let entries = try Self.entries(country: "jp")
        let idx = try Self.index(country: "jp")
        let oncePicked = once.trainIndexes.map { entries[$0] }
        let twicePicked = twice.trainIndexes.map { entries[$0] }

        let a = Statistics.aggregateMileageStats(index: idx, entries: oncePicked, country: "jp")
        let b = Statistics.aggregateMileageStats(index: idx, entries: twicePicked, country: "jp")

        #expect(
            a.riddenAll.bitPattern == b.riddenAll.bitPattern,
            """
            Listing the same ridden entry twice changed the deduped total \
            (\(a.riddenAll) → \(b.riddenAll)). Coverage is a union over N02 \
            edge ids: a repeat ride adds nothing.
            """)
        // …while the accumulating per-train sum does double, which is what
        // makes the first assertion a real distinction rather than a tautology.
        #expect(twice.summedTrainKm.bitPattern == (once.summedTrainKm * 2).bitPattern)
        #expect(a.riddenAll > 0)
    }

    /// Why the ridden set is kept in insertion order rather than in a `Set`.
    @Test("summation order changes the total's last bits")
    func summationOrderIsLoadBearing() throws {
        let forward = try #require(Self.fixture.aggregates.first { $0.label == "everything" })
        let reversed = try #require(
            Self.fixture.aggregates.first { $0.label == "everything-reversed" })
        let gap = forward.aggregate.riddenAll.ulpDistance(to: reversed.aggregate.riddenAll)
        #expect(
            gap > 0,
            """
            The fixture's two orderings of the same rides produced identical \
            totals, so this test no longer demonstrates anything. That is not \
            a failure of the port — but the ordered ridden set in \
            aggregateMileageStats is now unjustified by any case here, and a \
            future refactor to a plain Set would go unnoticed.
            """)
        #expect(gap <= 4, "the two orders should differ in the last bits, not materially")
    }

    // MARK: - most-ridden sections

    @Test("topRiddenSegments ranks, dedupes and drops contained sections")
    func topSegments() throws {
        for item in Self.fixture.tops {
            let all = try Self.entries(country: item.country)
            let picked = item.trainIndexes.map { all[$0] }
            let top = Statistics.topRiddenSegments(entries: picked, country: item.country)
            let why = "\(item.country)/\(item.label)"

            #expect(top.all.count == item.top.all.count, "\(why)")
            for (got, want) in zip(top.all, item.top.all) {
                #expect(got.from == want.from, "\(why)")
                #expect(got.to == want.to, "\(why)")
                #expect(got.count == want.count, "\(why)")
                #expect(got.km.bitPattern == want.km.bitPattern, "\(why)")
                #expect(got.bucket == want.bucket, "\(why)")
                #expect(got.edgeIds.count == want.edgeIdCount, "\(why)")
            }
            #expect(top.byMask.count == item.top.byMask.count, "\(why)")
            for (got, want) in zip(top.byMask, item.top.byMask) {
                #expect(got.mask == want.mask, "\(why)")
                #expect(got.rows.count == want.rows.count, "\(why) mask \(want.mask)")
                for (r, w) in zip(got.rows, want.rows) {
                    #expect(r.from == w.from && r.to == w.to, "\(why) mask \(want.mask)")
                    #expect(r.count == w.count, "\(why)")
                    #expect(r.km.bitPattern == w.km.bitPattern, "\(why)")
                }
            }
        }
    }

    @Test("isEdgeSubset is the linear merge the containment pass rests on")
    func edgeSubsets() throws {
        for item in Self.fixture.subsets {
            #expect(
                Statistics.isEdgeSubset(item.inner, item.outer) == item.isSubset,
                "\(item.inner) ⊆ \(item.outer)")
        }
    }

    @Test("dropContainedSections keeps the section a reader should see")
    func containment() throws {
        for item in Self.fixture.containment {
            let rows = item.rows.map {
                Statistics.TopRow(
                    from: $0.from, to: $0.to, count: $0.count, km: $0.km, bucket: $0.bucket,
                    edgeIds: $0.edgeIds)
            }
            let kept = Statistics.dropContainedSections(rows)
            #expect(kept.count == item.kept.count, "\(item.why)")
            for (got, want) in zip(kept, item.kept) {
                #expect(got.from == want.from && got.to == want.to, "\(item.why)")
            }
        }
    }

    // MARK: - ride time and service tiers

    @Test("trainRideMinutes and serviceGroupOfTrain agree over the real stores")
    func rideTimes() throws {
        let cases = Self.fixture.rideTimes + Self.fixture.adversarialTrains
        #expect(cases.count > 200)
        for item in cases {
            let train = Statistics.Train(
                trainType: item.trainType,
                stops: item.stops.map {
                    Statistics.Stop(
                        arrival: $0.arrival, departure: $0.departure, stopType: $0.stopType,
                        rideSegment: $0.rideSegment.isExactlyTrue)
                })
            let why = item.why ?? "\(item.country) \(item.trainType ?? "nil")"
            let minutes = Statistics.trainRideMinutes(train)
            #expect(minutes?.bitPattern == item.rideMinutes?.bitPattern, "\(why)")
            #expect(
                Statistics.serviceGroupOfTrain(trainType: item.trainType, country: item.country)
                    == item.serviceGroup, "\(why)")
        }
    }

    @Test("sumRideMinutes over each committed store")
    func serviceSums() throws {
        for item in Self.fixture.serviceSums {
            let trains = Self.fixture.rideTimes.filter { $0.country == item.country }
                .map { c in
                    Statistics.Train(
                        trainType: c.trainType,
                        stops: c.stops.map {
                            Statistics.Stop(
                                arrival: $0.arrival, departure: $0.departure,
                                stopType: $0.stopType,
                                rideSegment: $0.rideSegment.isExactlyTrue)
                        })
                }
            #expect(trains.count == item.trainCount, "\(item.country)")
            #expect(
                Statistics.sumRideMinutes(trains).bitPattern == item.sumRideMinutes.bitPattern,
                "\(item.country)")
        }
    }

    // MARK: - the view model

    @Test("buildMileageStatsView composes the same overall and daily aggregates")
    func views() throws {
        for item in Self.fixture.views {
            let idx = try Self.index(country: item.country)
            let entries = try Self.entries(country: item.country)
            let trains = Self.trains(country: item.country)
            // `trainDate` and `dateLabel` are injected because they belong to
            // app-dates.js and to I18N respectively. The fixture's own stubs
            // read the ride's `date` field and returned the date unchanged, so
            // these match them exactly.
            let view = Statistics.buildMileageStatsView(
                index: idx, trains: trains, entries: entries, country: item.country,
                selectedDate: item.selectedDate,
                trainDate: { $0.date ?? "undated" }, dateLabel: { $0 })

            let why = "\(item.country) selectedDate=\(item.selectedDate ?? "nil")"
            #expect(view.categories.map(\.mask) == item.categories, "\(why)")
            #expect(
                view.overall.riddenAll.bitPattern == item.overall.riddenAll.bitPattern,
                "\(why)")
            #expect(
                view.overall.unmatchedKm.bitPattern == item.overall.unmatchedKm.bitPattern,
                "\(why)")
            #expect(
                view.overall.rideMinutes.bitPattern == item.overall.rideMinutes.bitPattern,
                "\(why)")
            #expect(view.overall.topSegments?.all.count == item.overall.topRowCount, "\(why)")
            for (mask, km) in item.overall.riddenByMask {
                #expect(
                    view.overall.riddenByMask[Int(mask)!]?.bitPattern == km.bitPattern,
                    "\(why) — mask \(mask)")
            }
            for row in item.overall.lineRidByCat {
                let got = try #require(view.overall.lineRidByCat[row.line], "\(why)")
                for (mask, km) in row.byCat {
                    #expect(got[Int(mask)!]?.bitPattern == km.bitPattern, "\(why) \(row.line)")
                }
            }
            for (got, want, tier) in [
                (view.overall.services.hsr, item.overall.services.hsr, "hsr"),
                (view.overall.services.ltd, item.overall.services.ltd, "ltd"),
                (view.overall.services.other, item.overall.services.other, "other"),
            ] {
                #expect(got.km.bitPattern == want.km.bitPattern, "\(why) — \(tier) km")
                #expect(got.minutes.bitPattern == want.minutes.bitPattern, "\(why) — \(tier)")
                #expect(got.count == want.count, "\(why) — \(tier) count")
            }

            // The daily branch: present only for a concrete date bucket, and
            // then holding that day's own aggregate over the SAME entries.
            guard let expectedDaily = item.daily else {
                #expect(view.daily == nil, "\(why)")
                continue
            }
            let daily = try #require(view.daily, "\(why)")
            #expect(daily.date == expectedDaily.date, "\(why)")
            #expect(daily.trainCount == expectedDaily.trainCount, "\(why)")
            // A day bucket that selected nothing would make every assertion
            // below trivially true, so the filter is asserted to have fired.
            #expect(daily.trainCount > 0, "\(why) — the day bucket selected no trains")
            #expect(
                daily.stats.riddenAll.bitPattern == expectedDaily.stats.riddenAll.bitPattern,
                "\(why)")
            #expect(
                daily.stats.unmatchedKm.bitPattern
                    == expectedDaily.stats.unmatchedKm.bitPattern, "\(why)")
            #expect(
                daily.stats.rideMinutes.bitPattern
                    == expectedDaily.stats.rideMinutes.bitPattern, "\(why)")
            for (mask, km) in expectedDaily.stats.riddenByMask {
                #expect(
                    daily.stats.riddenByMask[Int(mask)!]?.bitPattern == km.bitPattern,
                    "\(why) — daily mask \(mask)")
            }
            for row in expectedDaily.stats.lineRidByCat {
                let got = try #require(daily.stats.lineRidByCat[row.line], "\(why) daily")
                for (mask, km) in row.byCat {
                    #expect(got[Int(mask)!]?.bitPattern == km.bitPattern, "\(why) \(row.line)")
                }
            }
            for (got, want, tier) in [
                (daily.stats.services.hsr, expectedDaily.stats.services.hsr, "hsr"),
                (daily.stats.services.ltd, expectedDaily.stats.services.ltd, "ltd"),
                (daily.stats.services.other, expectedDaily.stats.services.other, "other"),
            ] {
                #expect(got.km.bitPattern == want.km.bitPattern, "\(why) — daily \(tier)")
                #expect(got.count == want.count, "\(why) — daily \(tier)")
            }
        }
    }

    // MARK: - the ridden-line display filter

    @Test("riddenFeatureCategory picks the dominant mode, or refuses to guess")
    func riddenCategoryFilter() throws {
        for item in Self.fixture.filters {
            let idx = try Self.index(country: item.country)
            let feature = Self.routeFeature(item.feature)
            #expect(
                Statistics.riddenFeatureCategory(feature, index: idx, country: item.country)
                    == item.category, "\(item.country)/\(item.rideId)")
            #expect(
                Statistics.riddenFeatureVisible(
                    feature, index: idx, country: item.country,
                    filter: Statistics.RiddenCategoryFilter())
                    == item.visibleWithAllOn, "\(item.country)/\(item.rideId)")
        }
        // An undetermined feature stays visible, and so does everything while
        // the network is still loading and there is no index at all.
        let noIndex = Statistics.riddenFeatureVisible(
            Statistics.RouteFeature(lines: [], rideSegment: true, from: nil, to: nil),
            index: nil, country: "jp", filter: Statistics.RiddenCategoryFilter(hsr: false))
        #expect(noIndex)
    }

    // MARK: - the arithmetic underneath

    /// `equirectKm` is the term every kilometre total is a sum of, so it is
    /// worth an assertion of its own that does not depend on the sums.
    ///
    /// It also records the measurement that made the port possible: neither
    /// `Foundation.cos` nor `Foundation.hypot` reproduces V8's answers, so
    /// ``Statistics/JSMath`` carries V8's own implementations of both.
    @Test("equirectKm reproduces V8's cos and hypot, not the platform's")
    func equirectKmParity() throws {
        let idx = try Self.index(country: "jp")
        let expected = try #require(Self.fixture.indexes.first { $0.country == "jp" })

        var platformDisagreements = 0
        var worstPlatformUlp: Int64 = 0
        for edge in expected.sampledEdges {
            #expect(idx.km[edge.index].bitPattern == edge.km.bitPattern)
        }
        // Recompute the same distances the platform way, to keep the reason
        // JSMath exists measurable rather than merely asserted.
        for section in try Self.sections(country: "jp").prefix(400) {
            guard section.coordinates.count >= 2 else { continue }
            for i in 1..<section.coordinates.count {
                let a = section.coordinates[i - 1]
                let b = section.coordinates[i]
                let ours = Statistics.equirectKm(a.lon, a.lat, b.lon, b.lat)
                let kx = 111.32 * cos(((a.lat + b.lat) / 2) * Double.pi / 180)
                let platform = hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * 110.574)
                if platform.bitPattern != ours.bitPattern {
                    platformDisagreements += 1
                    worstPlatformUlp = max(worstPlatformUlp, platform.ulpDistance(to: ours))
                }
            }
        }
        #expect(
            platformDisagreements > 0,
            """
            Foundation's cos/hypot now agree with V8's everywhere in this \
            sample. If that is genuinely true on every platform this ships to, \
            Statistics.JSMath could be deleted — but verify it on the oldest \
            supported OS first, because it was 1,800 disagreements of up to 2 \
            ULP when it was written.
            """)
    }

    // MARK: - edge-key spelling

    @Test("edgeKey orders its two node keys numerically, not as strings")
    func edgeKeySpelling() throws {
        // AppCore.edgeKey5 compares the quantised numbers; the overlap caches'
        // routeCoordinateSegmentKey compares the printed strings. Both are
        // "smaller first", and they disagree — 9 < 10 numerically, "10" < "9"
        // as text — so a port that reuses one for the other silently matches
        // nothing.
        let a = Coordinate(lon: 9, lat: 35)
        let b = Coordinate(lon: 10, lat: 35)
        #expect(Statistics.edgeKey(a, b) == "9,35|10,35")
        #expect(Statistics.edgeKey(b, a) == "9,35|10,35")
        #expect(Grid.routeCoordinateSegmentKey(a, b) == "10,35|9,35")
        // Integral coordinates print without a fractional part, which is the
        // whole reason JSNumber exists.
        #expect(Statistics.edgeKey(Coordinate(lon: 139, lat: 35), Coordinate(lon: 139, lat: 36))
            == "139,35|139,36")
    }
}
