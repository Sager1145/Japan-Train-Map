import Foundation
import Testing

@testable import RailCore

/// `app-route-graph.js` §27–28 against `port-fixtures/route-graph.json`.
///
/// The fixture is the running JavaScript's own answers for all five shipped
/// countries — 377,098 Japanese nodes and 765,426 directed edges among them —
/// so a failure here means this Swift disagrees with the app it was forked
/// from, and the fixture's `contract` field says what the disagreement would
/// cost.
///
/// Whole node and edge lists cannot be written out at that size, so each is
/// frozen as its ``RouteGraph/keyDigest`` over the sorted list. Using the
/// app's own digest rather than an invented hash means the digest is itself
/// under test: `keyDigests` below gives it its own cases, so a failure there
/// and a failure in a list digest together read as "the digest moved", and a
/// clean `keyDigests` with a failing list digest reads as "the list moved".
struct RouteGraphParityTests {

    // MARK: - fixture

    struct Fixture: Decodable {
        struct Constants: Decodable {
            let railIndexCellDeg: Double
            let regionQuantDeg: Double
            let regionalGraphNodeBudget: Int
            let regionalGraphLoadNodeBudget: Int
            let routeSolverCacheVersion: String
        }
        struct Digests: Decodable {
            let nodeKeys: String
            let undirectedEdgeKeys: String
            let adjacency: String
            let nodeMeta: String
            let grid: String
        }
        struct SampledKey: Decodable {
            let index: Int
            let value: String
        }
        struct SampledCell: Decodable {
            let index: Int
            let cell: String
            let nodeKeys: [String]
        }
        struct EdgeRecord: Decodable {
            let to: String
            let length: Double
            let institution_type_code: String
            let railway_class_code: String
            let line_name: String
            let `operator`: String
        }
        struct NodeRecord: Decodable {
            let key: String
            let coordinate: [Double]
            let line_names: [String]
            let operators: [String]
            let institution_type_codes: [String]
            let railway_class_codes: [String]
            let edges: [EdgeRecord]
        }
        struct GraphCase: Decodable {
            let country: String
            let sectionFeatureCount: Int
            let nodeCount: Int
            let directedEdgeCount: Int
            let undirectedEdgeCount: Int
            let gridCellCount: Int
            let cellSize: Double
            let digests: Digests
            let nodeKeySample: [SampledKey]
            let gridCellSample: [SampledCell]
            let integralSpellingCount: Int
            let integralSpellingSample: [String]
            let nodeSample: [NodeRecord]
        }
        struct KeyDigestCase: Decodable {
            let input: String
            let digest: String
        }
        struct SpatialCase: Decodable {
            let country: String
            let bbox: [Double]
            let diagonalMeters: Double
            let padded30km: [Double]
            let quantized: [Double]
            let featureIndices: [Int]
            let quantizedFeatureIndices: [Int]
            let stationIndicesInQuantized: [Int]
        }
        struct NearbyResult: Decodable {
            let key: String
            let distance: Double
        }
        struct NearbyCase: Decodable {
            let country: String
            let coord: [Double]
            let radiusDeg: Double
            let limit: Int
            let result: [NearbyResult]
        }
        struct TieCase: Decodable {
            let country: String
            let coord: [Double]
            let radiusDeg: Double
            let limit: Int
            let tiedDistanceCount: Int
            let result: [NearbyResult]
        }
        struct RegionStep: Decodable {
            let bbox: [Double]
            let margin: Double
            let padded: [Double]
            let regionBbox: [Double]
            let nodeCount: Int
            let cacheKeys: [String]
            let residentNodes: Int
        }
        struct RegionTrim: Decodable {
            let target: Int
            let cacheKeys: [String]
            let residentNodes: Int
        }
        struct RegionCase: Decodable {
            let country: String
            let importInProgress: Bool
            let budget: Int
            let steps: [RegionStep]
            let trims: [RegionTrim]
        }
        struct Policy: Decodable {
            let preferred_line_names: [String]?
            let preferred_operator_names: [String]?
            let allowed_institution_type_codes: [String]?
            let institution_filter_mode: String?
        }
        struct TrainProjection: Decodable {
            let id: String
            let train_type: String?
            let company: String?
            let route_policy: Policy
        }
        struct SectionRow: Decodable {
            let from: String?
            let to: String?
            let from_n02_station_code: String?
            let to_n02_station_code: String?
            let line_names: [String]?
            let operator_names: [String]?
        }
        struct CacheKeyCase: Decodable {
            let country: String
            let train: TrainProjection
            let routeSections: [SectionRow]
            let allowedCodes: [String]
            let derivedInstitutionTypeCodes: [String]
            let derivedPreferredOperatorNames: [String]
            let templateKey: String
            let templateKeyDigest: String
            let cacheKey: String
            let cacheKeyDigest: String
        }

        let constants: Constants
        let cases: [GraphCase]
        let keyDigests: [KeyDigestCase]
        let spatialIndex: [SpatialCase]
        let nearbyNodes: [NearbyCase]
        let tieBreaking: [TieCase]
        let regions: [RegionCase]
        let cacheKeys: [CacheKeyCase]
    }

    static func fixture() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "route-graph.json")
    }

    // MARK: - the shipped datasets

    /// `countrySuffixed` — Japan is the unsuffixed original.
    static func dataURL(_ base: String, _ country: String) throws -> URL {
        let name = country == "jp" ? "\(base).json" : "\(base)-\(country).json"
        return try PortFixtures.repositoryRoot().appending(path: "app/data/\(name)")
    }

    static func sections(_ country: String) throws -> [RouteGraph.SectionFeature] {
        try RouteGraph.SectionFeatureCollection
            .load(contentsOf: dataURL("rail-sections", country)).features
    }

    /// Only what `stationFeaturesInBbox` reads: where the station is.
    struct StationFeature: Decodable, RouteGraph.DisplayLocatable {
        let displayCoordinate: Coordinate?

        private enum CodingKeys: String, CodingKey { case properties }
        private struct Properties: Decodable {
            let display_point: [Double]?
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let p = try c.decodeIfPresent(Properties.self, forKey: .properties)
            displayCoordinate = (p?.display_point).flatMap(Coordinate.init(pair:))
        }
    }
    struct StationCollection: Decodable { let features: [StationFeature] }

    static func stations(_ country: String) throws -> [StationFeature] {
        try JSONDecoder()
            .decode(StationCollection.self, from: Data(contentsOf: dataURL("stations", country)))
            .features
    }

    // MARK: - helpers

    /// `[...].sort()` — UTF-16 code-unit order, the comparator the fixture's
    /// lists were built with. Swift's own `<` on `String` is not it.
    static func jsSorted(_ values: [String]) -> [String] {
        values.sorted { !JSNumber.stringLessOrEqual($1, $0) }
    }

    static func digestSorted(_ values: [String]) -> String {
        RouteGraph.keyDigest(jsSorted(values).joined(separator: "\n"))
    }

    /// The libm budget measured in `FixtureParityTests.distances`: V8 and
    /// Darwin ship different `sin`/`cos`/`asin`, and neither promises the
    /// other's last bit. Every Double compared here descends from a haversine
    /// or a `cos`, so the same ceiling applies — stated in ULP rather than as
    /// a relative epsilon, because an epsilon loose enough to absorb a libm
    /// difference is also loose enough to absorb a wrong constant.
    static let ulpBudget: Int64 = 2

    static func expectClose(
        _ actual: Double, _ expected: Double, _ label: @autoclosure () -> String,
        _ sourceLocation: SourceLocation = #_sourceLocation
    ) {
        #expect(
            actual.ulpDistance(to: expected) <= ulpBudget,
            "\(label()): \(actual) vs \(expected) (\(actual.ulpDistance(to: expected)) ULP)",
            sourceLocation: sourceLocation)
    }

    // MARK: - the digest itself

    @Test("routeKeyDigest reproduces JavaScript's 53-bit base-36 key digest")
    func keyDigests() throws {
        let fixture = try Self.fixture()
        #expect(!fixture.keyDigests.isEmpty)
        for item in fixture.keyDigests {
            #expect(
                RouteGraph.keyDigest(item.input) == item.digest,
                "keyDigest of \(item.input.count) chars — a mismatch here also explains every list digest below"
            )
        }
    }

    // MARK: - graph construction

    @Test(
        "each country's rail sections build the JavaScript's graph, node for node",
        arguments: PortFixtures.countries)
    func graphConstruction(country: String) throws {
        let fixture = try Self.fixture()
        let expected = try #require(fixture.cases.first { $0.country == country })
        let features = try Self.sections(country)
        #expect(features.count == expected.sectionFeatureCount)

        let graph = RouteGraph.build(from: features)

        #expect(graph.nodes.count == expected.nodeCount)
        #expect(graph.grid.count == expected.gridCellCount)
        #expect(graph.cellSize == expected.cellSize)

        let nodeKeys = Self.jsSorted(Array(graph.nodes.keys))
        let cellKeys = Self.jsSorted(Array(graph.grid.keys))

        var directedEdgeCount = 0
        var undirected = Set<String>()
        var adjacencyText = ""
        var metaText = ""
        adjacencyText.reserveCapacity(nodeKeys.count * 100)
        metaText.reserveCapacity(nodeKeys.count * 60)
        for key in nodeKeys {
            let edges = graph.adjacency[key]!
            directedEdgeCount += edges.count
            for edge in edges {
                undirected.insert(
                    JSNumber.stringLessOrEqual(key, edge.to)
                        ? "\(key)|\(edge.to)" : "\(edge.to)|\(key)")
                if !adjacencyText.isEmpty { adjacencyText += "\n" }
                adjacencyText +=
                    "\(key)\t\(edge.to)\t\(edge.institutionTypeCode)\t"
                    + "\(edge.railwayClassCode)\t\(edge.lineName)\t\(edge.operator)"
            }
            let meta = graph.nodeMeta[key]!
            if !metaText.isEmpty { metaText += "\n" }
            metaText +=
                "\(key)\t\(Self.jsSorted(Array(meta.lineNames)).joined(separator: ","))\t"
                + "\(Self.jsSorted(Array(meta.operators)).joined(separator: ","))\t"
                + "\(Self.jsSorted(Array(meta.institutionTypeCodes)).joined(separator: ","))\t"
                + "\(Self.jsSorted(Array(meta.railwayClassCodes)).joined(separator: ","))"
        }
        #expect(directedEdgeCount == expected.directedEdgeCount)
        #expect(undirected.count == expected.undirectedEdgeCount)

        // The exact key strings, sorted, so iteration order cannot hide a
        // difference — and edge ATTRIBUTES and grid bucket ORDER with them.
        #expect(Self.digestSorted(nodeKeys) == expected.digests.nodeKeys)
        #expect(Self.digestSorted(Array(undirected)) == expected.digests.undirectedEdgeKeys)
        #expect(RouteGraph.keyDigest(adjacencyText) == expected.digests.adjacency)
        #expect(RouteGraph.keyDigest(metaText) == expected.digests.nodeMeta)
        #expect(
            RouteGraph.keyDigest(
                cellKeys.map { "\($0)\t\(graph.grid[$0]!.joined(separator: ","))" }
                    .joined(separator: "\n")) == expected.digests.grid)

        // Samples, so a failure names a node rather than only a digest.
        for sample in expected.nodeKeySample {
            #expect(nodeKeys[sample.index] == sample.value)
        }
        for sample in expected.gridCellSample {
            #expect(cellKeys[sample.index] == sample.cell)
            #expect(graph.grid[sample.cell] == sample.nodeKeys)
        }

        // The JSNumber trap, in production data: node keys with an integral
        // half. Under `"\(value)"` these would be spelled "139.0,36.50842",
        // matching nothing the JavaScript ever wrote, and the node would
        // silently become two nodes with no edge between them.
        let integral = nodeKeys.filter { key in
            key.split(separator: ",").contains { !$0.contains(".") }
        }
        #expect(integral.count == expected.integralSpellingCount)
        #expect(Array(integral.prefix(expected.integralSpellingSample.count))
            == expected.integralSpellingSample)

        for record in expected.nodeSample {
            let coordinate = try #require(graph.nodes[record.key], "missing node \(record.key)")
            #expect(coordinate.lon.bitPattern == record.coordinate[0].bitPattern)
            #expect(coordinate.lat.bitPattern == record.coordinate[1].bitPattern)
            // Node identity is coordinate identity: the key a node is filed
            // under must be the key its own coordinate spells.
            #expect(Grid.coordKey(coordinate) == record.key)

            let meta = graph.nodeMeta[record.key]!
            #expect(Self.jsSorted(Array(meta.lineNames)) == record.line_names)
            #expect(Self.jsSorted(Array(meta.operators)) == record.operators)
            #expect(
                Self.jsSorted(Array(meta.institutionTypeCodes)) == record.institution_type_codes)
            #expect(Self.jsSorted(Array(meta.railwayClassCodes)) == record.railway_class_codes)

            let edges = graph.adjacency[record.key]!
            #expect(edges.count == record.edges.count, "degree of \(record.key)")
            for (edge, expectedEdge) in zip(edges, record.edges) {
                #expect(edge.to == expectedEdge.to)
                #expect(edge.institutionTypeCode == expectedEdge.institution_type_code)
                #expect(edge.railwayClassCode == expectedEdge.railway_class_code)
                #expect(edge.lineName == expectedEdge.line_name)
                #expect(edge.operator == expectedEdge.operator)
                Self.expectClose(edge.length, expectedEdge.length, "edge \(record.key)→\(edge.to)")
                #expect(edge.connector == nil, "graph construction adds no connector edges")
            }
        }

        // Same graph, same country: the nearest-node lookup the station snap
        // runs on. Checked here rather than in its own test so Japan's graph
        // is built once.
        for item in fixture.nearbyNodes where item.country == country {
            let coordinate = try #require(Coordinate(pair: item.coord))
            let result = RouteGraph.nearbyNodes(
                coordinate, in: graph, radiusDeg: item.radiusDeg, limit: item.limit)
            #expect(
                result.map(\.key) == item.result.map(\.key),
                "nearbyNodes(\(item.coord), r=\(item.radiusDeg), limit=\(item.limit)) — the ORDER is the answer: the sort is stable, so ties keep grid-scan order"
            )
            for (actual, expected) in zip(result, item.result) {
                Self.expectClose(actual.distance, expected.distance, "distance to \(actual.key)")
            }
        }

        // The cases where stability is visible. Two nodes symmetric about the
        // query point are EXACTLY equidistant — the haversine's longitude term
        // is squared — so the order between them is decided purely by which
        // the grid scan reached first. Every other case in this fixture passes
        // with an unstable sort; these are the ones that do not, and they
        // exist only in Japan and Hong Kong.
        let ties = fixture.tieBreaking.filter { $0.country == country }
        if country == "jp" || country == "hk" {
            #expect(!ties.isEmpty, "the fixture lost its tie-breaking cases for \(country)")
        }
        for item in ties {
            #expect(item.tiedDistanceCount > 0)
            let coordinate = try #require(Coordinate(pair: item.coord))
            let result = RouteGraph.nearbyNodes(
                coordinate, in: graph, radiusDeg: item.radiusDeg, limit: item.limit)
            #expect(
                result.map(\.key) == item.result.map(\.key),
                "tie-breaking at \(item.coord) — equal distances must keep grid-scan order"
            )
        }
    }

    // MARK: - the rail-section spatial index

    @Test(
        "the coarse bbox index returns the same features, in the same order",
        arguments: PortFixtures.countries)
    func spatialIndex(country: String) throws {
        let fixture = try Self.fixture()
        #expect(RouteGraph.railIndexCellDeg == fixture.constants.railIndexCellDeg)
        #expect(RouteGraph.regionQuantDeg == fixture.constants.regionQuantDeg)

        let store = RouteGraph.RouteGraphStore(sections: try Self.sections(country))
        let stations = try Self.stations(country)

        for item in fixture.spatialIndex where item.country == country {
            let bbox = try #require(RouteGraph.BBox(array: item.bbox))
            Self.expectClose(
                RouteGraph.bboxDiagonalMeters(bbox), item.diagonalMeters, "diagonal")

            let padded = RouteGraph.padBBoxMeters(bbox, meters: 30000)
            for (actual, expected) in zip(padded.array, item.padded30km) {
                Self.expectClose(actual, expected, "padBBoxMeters")
            }

            let quantized = RouteGraph.quantizeBBoxOutward(bbox)
            #expect(quantized.array == item.quantized)

            // Order, not just membership: the graph built from this list
            // inherits it in every adjacency list.
            #expect(store.featureIndicesInBBox(bbox) == item.featureIndices)
            #expect(store.featureIndicesInBBox(quantized) == item.quantizedFeatureIndices)

            let inRegion = RouteGraph.stationsInBBox(
                stations.enumerated().map { StationIndexed(index: $0.offset, station: $0.element) },
                quantized)
            #expect(inRegion.map(\.index) == item.stationIndicesInQuantized)
        }
    }

    /// A station paired with its position in the shipped file — the only
    /// identity a station feature has, and what the fixture names them by.
    struct StationIndexed: RouteGraph.DisplayLocatable {
        let index: Int
        let station: StationFeature
        var displayCoordinate: Coordinate? { station.displayCoordinate }
    }

    // MARK: - regional subgraphs and their LRU

    @Test(
        "regional subgraphs are cached, touched and evicted in the same order",
        arguments: [false, true])
    func regionalGraphs(importInProgress: Bool) throws {
        let fixture = try Self.fixture()
        #expect(RouteGraph.regionalGraphNodeBudget == fixture.constants.regionalGraphNodeBudget)
        #expect(
            RouteGraph.regionalGraphLoadNodeBudget
                == fixture.constants.regionalGraphLoadNodeBudget)

        for item in fixture.regions where item.importInProgress == importInProgress {
            let store = RouteGraph.RouteGraphStore(sections: try Self.sections(item.country))
            for (stepIndex, step) in item.steps.enumerated() {
                let bbox = try #require(RouteGraph.BBox(array: step.bbox))
                // The margin and the padding are recomputed and checked, but
                // the region is then built from the JavaScript's own padded
                // bbox, so a last-bit libm difference in `cos` cannot turn
                // this into a test about the LRU failing.
                let margin = max(30000, RouteGraph.bboxDiagonalMeters(bbox) * 0.6)
                Self.expectClose(margin, step.margin, "\(item.country) step \(stepIndex) margin")
                let recomputed = RouteGraph.padBBoxMeters(bbox, meters: margin)
                for (actual, expected) in zip(recomputed.array, step.padded) {
                    Self.expectClose(actual, expected, "\(item.country) step \(stepIndex) padded")
                }

                let padded = try #require(RouteGraph.BBox(array: step.padded))
                let graph = store.regionalGraph(
                    for: padded, importInProgress: importInProgress)
                #expect(graph.regionBBox?.array == step.regionBbox)
                #expect(graph.nodeCount == step.nodeCount)
                #expect(
                    store.regionCacheKeys == step.cacheKeys,
                    "\(item.country) step \(stepIndex): the cache is a Map used as an LRU — a hit deletes and re-inserts its key, and the oldest key is the eviction victim"
                )
                #expect(store.residentNodeCount == step.residentNodes)
            }
            for (trimIndex, trim) in item.trims.enumerated() {
                store.trimRegionalGraphCache(target: trim.target)
                #expect(
                    store.regionCacheKeys == trim.cacheKeys,
                    "\(item.country) trim \(trimIndex) to \(trim.target)")
                #expect(store.residentNodeCount == trim.residentNodes)
            }
        }
    }

    // MARK: - template and cache keys

    @Test("every shipped train's route cache key is spelled identically")
    func cacheKeys() throws {
        let fixture = try Self.fixture()
        #expect(fixture.cacheKeys.count > 200)
        #expect(RouteGraph.routeSolverCacheVersion == fixture.constants.routeSolverCacheVersion)

        for item in fixture.cacheKeys {
            let policy = item.train.route_policy
            let train = RouteGraph.CacheKeyTrain(
                trainType: item.train.train_type ?? "",
                company: item.train.company ?? "",
                preferredLineNames: policy.preferred_line_names ?? [],
                preferredOperatorNames: policy.preferred_operator_names ?? [],
                allowedInstitutionTypeCodes: policy.allowed_institution_type_codes,
                institutionFilterMode: policy.institution_filter_mode)
            let sections = item.routeSections.map {
                RouteGraph.RouteSection(
                    from: $0.from, to: $0.to,
                    fromStationCode: $0.from_n02_station_code,
                    toStationCode: $0.to_n02_station_code,
                    lineNames: $0.line_names ?? [],
                    operatorNames: $0.operator_names ?? [])
            }
            let where_ = "\(item.country)/\(item.train.id)"

            #expect(
                RouteGraph.derivedInstitutionTypeCodes(
                    trainType: train.trainType, company: train.company, country: item.country)
                    == item.derivedInstitutionTypeCodes, "derived institution codes — \(where_)")
            #expect(
                RouteGraph.derivedPreferredOperatorNames(
                    company: train.company, country: item.country)
                    == item.derivedPreferredOperatorNames,
                "derived operator names keep the company field's order — \(where_)")

            let context = try #require(
                RouteGraph.solveContext(
                    train: train, routeSections: sections, country: item.country))
            #expect(context.templateKey == item.templateKey, "template key — \(where_)")
            #expect(context.allowedCodes == item.allowedCodes, "allowed codes — \(where_)")
            // The one that is a persisted format: a route cache written by
            // the web app is only readable here if these bytes agree.
            #expect(context.cacheKey == item.cacheKey, "cache key — \(where_)")
            #expect(
                RouteGraph.keyDigest(context.templateKey) == item.templateKeyDigest,
                "template key digest — \(where_)")
            #expect(
                RouteGraph.keyDigest(context.cacheKey) == item.cacheKeyDigest,
                "cache key digest — \(where_)")
        }
    }

    @Test("a train with no route sections has no solve context")
    func emptySections() {
        #expect(
            RouteGraph.solveContext(
                train: RouteGraph.CacheKeyTrain(), routeSections: [], country: "jp") == nil)
    }
}
