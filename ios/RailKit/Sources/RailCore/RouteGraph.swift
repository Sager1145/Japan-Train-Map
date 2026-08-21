import Foundation

/// The routable graph, its spatial index, and the keys that decide whether
/// either has to be built.
///
/// Ported from `app/public/app-route-graph.js` §27–28. That file is two
/// things wearing one hat, and only one of them is here: the data-structure
/// half — nodes and edges from rail-section geometry, the coarse bbox index,
/// the LRU of regional subgraphs, the nearest-node lookup, and the
/// template/cache keys. Dijkstra, the institution rules and the route hints
/// live in `app-route-solver.js` and are a separate port. The seam between
/// them in the JavaScript is the `routeSolverApi` object that
/// `app-route-service.js` wires up; here it is ``Graph`` itself, plus the
/// `augment` hook on ``RouteGraphStore``.
///
/// Two properties are load-bearing far beyond their appearance.
///
/// **A node's identity is its coordinate.** The key is `coordKey` of the
/// quantised pair, so two vertices become one node exactly when both
/// languages *spell* that pair identically. JavaScript writes an integral
/// coordinate `"139"`; Swift's `String(139.0)` is `"139.0"`. Seven node keys
/// in the shipped data — five Japanese, two Korean — have an integral half,
/// and under a naive port each of them becomes two nodes at the same place
/// with no edge between them. Everything goes through ``Grid``.
///
/// **Order is an answer, not an accident.** Grid buckets and adjacency lists
/// are JavaScript arrays walked in insertion order; `nearbyGraphNodes` sorts
/// by distance with `Array.prototype.sort`, which is *stable*, so equal
/// distances keep grid-scan order; and the regional cache is a `Map` whose
/// insertion order chooses the eviction victim. Swift's `Dictionary` and
/// `Set` have no order and `sort` is not stable, so each of those is
/// reproduced explicitly below rather than inherited.
public enum RouteGraph {

    // =====================================================================
    //  §27 — route template and cache keys
    // =====================================================================

    /// A 53-bit digest of a route key, in base 36.
    ///
    /// Both route keys enumerate every route section, so they grow with the
    /// train: a 195-stop round-island itinerary produces about 35 KB of each.
    /// The two feature properties that carry them are only ever compared for
    /// equality, so stamping the full key onto every feature multiplied 35 KB
    /// by the feature count and made one precomputed part 6.8 MB. This has
    /// identical equality semantics at constant size — and it is purely
    /// deterministic, which is what lets the browser and the offline exporter
    /// each read a part written by the other. Stamping and comparing must
    /// both go through it.
    ///
    /// The arithmetic is `Math.imul` and `>>>`, i.e. wrapping 32-bit
    /// multiplication and unsigned shifts, so it is done in `UInt32` here.
    /// The input is walked by UTF-16 code unit (`charCodeAt`), which means a
    /// character outside the BMP is *two* iterations — `String.utf16` rather
    /// than `unicodeScalars`.
    public static func keyDigest(_ key: String) -> String {
        var h1: UInt32 = 0xdead_beef
        var h2: UInt32 = 0x41c6_ce57
        for unit in key.utf16 {
            let ch = UInt32(unit)
            h1 = (h1 ^ ch) &* 2_654_435_761
            h2 = (h2 ^ ch) &* 1_597_334_677
        }
        let mixed1 = ((h1 ^ (h1 >> 16)) &* 2_246_822_507) ^ ((h2 ^ (h2 >> 13)) &* 3_266_489_909)
        let mixed2 = ((h2 ^ (h2 >> 16)) &* 2_246_822_507) ^ ((mixed1 ^ (mixed1 >> 13)) &* 3_266_489_909)
        let value = UInt64(2_097_151 & mixed2) * 4_294_967_296 + UInt64(mixed1)
        return String(value, radix: 36)
    }

    /// One leg of a train's itinerary, as the template key reads it.
    ///
    /// The fields are optional because the JavaScript tests them for
    /// *falsiness*: `section.from_n02_station_code || section.from || ""`
    /// falls through on an empty string exactly as it does on `null`.
    public struct RouteSection: Sendable, Equatable {
        public var from: String?
        public var to: String?
        public var fromStationCode: String?
        public var toStationCode: String?
        public var lineNames: [String]
        public var operatorNames: [String]

        public init(
            from: String? = nil,
            to: String? = nil,
            fromStationCode: String? = nil,
            toStationCode: String? = nil,
            lineNames: [String] = [],
            operatorNames: [String] = []
        ) {
            self.from = from
            self.to = to
            self.fromStationCode = fromStationCode
            self.toStationCode = toStationCode
            self.lineNames = lineNames
            self.operatorNames = operatorNames
        }
    }

    /// JavaScript's `a || b`, for the strings these keys are built from.
    private static func or(_ a: String?, _ b: String?) -> String {
        if let a, !a.isEmpty { return a }
        if let b, !b.isEmpty { return b }
        return ""
    }

    /// The identity of a train's *route*, independent of the train.
    ///
    /// `line_names` / `operator_names` are part of the key because they change
    /// the solver's constraints: without them, editing only the line names
    /// would let an earlier path for the same endpoints be reused.
    public static func templateKey(sections: [RouteSection]) -> String {
        sections.map { section in
            let from = or(section.fromStationCode, section.from)
            let to = or(section.toStationCode, section.to)
            let lines = jsSorted(section.lineNames.filter { !$0.isEmpty }).joined(separator: ",")
            let operators = jsSorted(section.operatorNames.filter { !$0.isEmpty })
                .joined(separator: ",")
            return "\(from)->\(to)|lines:\(lines)|operators:\(operators)"
        }
        .joined(separator: "|")
    }

    /// The fields of a train that a cache key is made of.
    ///
    /// Deliberately not the whole train: everything else about it — stops,
    /// times, name — changes nothing about which path the solver finds, and a
    /// key that moved when they changed would throw away a valid cache entry.
    public struct CacheKeyTrain: Sendable {
        public var trainType: String
        public var company: String
        public var preferredLineNames: [String]
        public var preferredOperatorNames: [String]
        public var allowedInstitutionTypeCodes: [String]?
        public var institutionFilterMode: String?

        public init(
            trainType: String = "",
            company: String = "",
            preferredLineNames: [String] = [],
            preferredOperatorNames: [String] = [],
            allowedInstitutionTypeCodes: [String]? = nil,
            institutionFilterMode: String? = nil
        ) {
            self.trainType = trainType
            self.company = company
            self.preferredLineNames = preferredLineNames
            self.preferredOperatorNames = preferredOperatorNames
            self.allowedInstitutionTypeCodes = allowedInstitutionTypeCodes
            self.institutionFilterMode = institutionFilterMode
        }
    }

    /// `DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES`, from `app-config.js`.
    public static let defaultAllowedInstitutionTypeCodes = ["1", "2", "3", "4", "5"]

    /// `ROUTE_SOLVER_CACHE_VERSION`, from `app-config.js`. Bumping it in the
    /// web app retires every persisted route cache entry, so it is a
    /// parameter here rather than a constant this file owns.
    public static let routeSolverCacheVersion = "17"

    /// The operators a `company` field names, split on `/`.
    ///
    /// Several operators separated by `/` marks a 直通 through-running
    /// service. Taiwan's names go through the branding table first, because
    /// the store spells the same company several ways.
    public static func companyParts(company: String, country: String) -> [String] {
        company.components(separatedBy: "/")
            .map { part -> String in
                let name = part.trimmingCharacters(in: jsTrimSet)
                return country == "tw"
                    ? OperatorBranding.normalizeTaiwanCompanyName(name) : name
            }
            .filter { !$0.isEmpty }
    }

    /// `COMPANY_OPERATOR_ALIASES` — the human `company` field mapped onto the
    /// N02_004 operator names the solver biases towards. Both marketing names
    /// and official names are accepted, which is why the table is one-way.
    static let companyOperatorAliases: [String: String] = [
        "JR北海道": "北海道旅客鉄道",
        "JR東日本": "東日本旅客鉄道",
        "JR东日本": "東日本旅客鉄道",
        "JR東海": "東海旅客鉄道",
        "JR西日本": "西日本旅客鉄道",
        "JR四国": "四国旅客鉄道",
        "JR四國": "四国旅客鉄道",
        "JR九州": "九州旅客鉄道",
        "東京メトロ": "東京地下鉄",
        "东京地下铁": "東京地下鉄",
        "都営地下鉄": "東京都",
        "都営": "東京都",
        "京急": "京浜急行電鉄",
        "京急電鉄": "京浜急行電鉄",
        "東急": "東急電鉄",
        "小田急": "小田急電鉄",
        "京王": "京王電鉄",
        "京成": "京成電鉄",
        "西武": "西武鉄道",
        "東武": "東武鉄道",
        "相鉄": "相模鉄道",
        "近鉄": "近畿日本鉄道",
        "阪急": "阪急電鉄",
        "阪神": "阪神電気鉄道",
        "名鉄": "名古屋鉄道",
        "西鉄": "西日本鉄道",
        "台鐵": "國營臺灣鐵路股份有限公司",
        "臺鐵": "國營臺灣鐵路股份有限公司",
        "台灣高鐵": "台灣高速鐵路股份有限公司",
        "臺灣高鐵": "台灣高速鐵路股份有限公司",
        "台北捷運": "臺北大眾捷運股份有限公司",
        "臺北捷運": "臺北大眾捷運股份有限公司",
        "新北捷運": "新北大眾捷運股份有限公司",
        "桃園捷運": "桃園大眾捷運股份有限公司",
        "台中捷運": "臺中捷運股份有限公司",
        "臺中捷運": "臺中捷運股份有限公司",
        "高雄捷運": "高雄捷運股份有限公司",
        "阿里山林鐵": "阿里山林業鐵路及文化資產管理處",
    ]

    /// Operator names derived from the `company` field, in the order the
    /// company field lists them.
    ///
    /// The order is the JavaScript's `Set` insertion order, kept because the
    /// solver reads this list as it stands; the cache key happens to sort it
    /// afterwards, but that is the caller's doing.
    ///
    /// One JavaScript behaviour is deliberately *not* reproduced: the lookup
    /// is a plain object literal, so a company literally named `constructor`
    /// or `toString` would resolve through `Object.prototype` and be replaced
    /// by a function. No shipped store contains such a value, and reproducing
    /// prototype pollution would be reproducing an accident rather than a
    /// rule.
    public static func derivedPreferredOperatorNames(company: String, country: String) -> [String] {
        var seen = Set<String>()
        var names: [String] = []
        for part in companyParts(company: company, country: country) {
            let name = companyOperatorAliases[part] ?? part
            if seen.insert(name).inserted { names.append(name) }
        }
        return names
    }

    /// N02_002 institution-type codes implied by 車輛類型 + 營運公司.
    ///
    /// An empty result means "no signal", and the caller then keeps the full
    /// default set. The JavaScript spells these as regular expressions, but
    /// every one of them is a plain alternation with no metacharacter, so
    /// substring search is exactly equivalent and avoids handing the answer to
    /// a regex engine whose Unicode tables are not V8's.
    public static func derivedInstitutionTypeCodes(
        trainType: String, company: String, country: String
    ) -> [String] {
        let type = trainType
        let text =
            "\(type) \(companyParts(company: company, country: country).joined(separator: " "))"
        // `i` in the JavaScript canonicalises by upper-casing, so this does
        // too. It matters only for the two ASCII alternatives; CJK has no
        // case.
        let upper = text.uppercased()
        let has = { (needles: [String]) in needles.contains { text.contains($0) } }

        var codes = Set<String>()
        if has(["台灣高鐵", "臺灣高鐵", "高速鐵路"]) { codes.insert("1") }
        if has(["台鐵", "臺鐵", "臺灣鐵路", "台灣鐵路"]) { codes.insert("2") }
        if has(["捷運", "林鐵", "林業鐵路"]) { codes.insert("3") }
        if has(["新幹線", "新干线"]) || upper.contains("SHINKANSEN") { codes.insert("1") }
        if (upper.contains("JR") || has(["旅客鉄道", "旅客铁道"]))
            && !(type.contains("新幹線") || type.contains("新干线"))
        {
            codes.insert("2")
        }
        if has(["都営", "東京都交通局", "市営", "公営", "市交通局"]) { codes.insert("3") }
        if has([
            "メトロ", "地下鉄", "地下铁", "私鉄", "私铁", "電鉄", "电铁", "電気鉄道", "京急", "京成",
            "東急", "小田急", "近鉄", "阪急", "阪神", "名鉄", "西鉄", "西武", "東武", "モノレール",
            "ゆりかもめ", "長野電鉄", "富士山麓", "富士急",
        ]) { codes.insert("4") }
        if has([
            "第三セクター", "三セク", "三陸鉄道", "しなの鉄道", "あいの風", "IGR", "青い森",
            "肥薩おれんじ", "道南いさりび", "IRいしかわ", "松浦鉄道", "横浜高速鉄道",
        ]) { codes.insert("5") }
        return jsSorted(codes)
    }

    /// The institution codes a solve is allowed — or, under the default
    /// filter mode, merely biased towards.
    ///
    /// When `route_policy` has not narrowed the codes itself (the set is
    /// still the full default), a soft narrowing is derived from
    /// 車輛類型/公司 instead. With the default `"soft"` filter mode that only
    /// biases the solver, so it can never open a gap in the drawn route.
    public static func allowedInstitutionTypeCodes(
        _ train: CacheKeyTrain, country: String
    ) -> [String] {
        let explicit = train.allowedInstitutionTypeCodes ?? []
        let codes = explicit.isEmpty ? defaultAllowedInstitutionTypeCodes : explicit
        let unique = jsSorted(orderedUnique(codes))
        let fullDefault = jsSorted(defaultAllowedInstitutionTypeCodes)
        if unique.joined(separator: ",") == fullDefault.joined(separator: ",") {
            let derived = derivedInstitutionTypeCodes(
                trainType: train.trainType, company: train.company, country: country)
            if !derived.isEmpty { return derived }
        }
        return unique
    }

    /// Everything that identifies one deterministic route solve.
    public struct SolveContext: Sendable, Equatable {
        public let templateKey: String
        public let allowedCodes: [String]
        public let policyKey: String
        public let cacheKey: String
    }

    /// The cache key of one solve.
    ///
    /// `routeSections` is a parameter rather than something derived here:
    /// `buildTrainRouteSolveContext` gets them from
    /// `getRideRouteSectionsForTrain`, which lives in `app-store-ops.js` and
    /// belongs to the train store. That is the boundary of this port on that
    /// side; the graph does not know how a train's stops become sections, only
    /// what the sections identify.
    ///
    /// The `sort()` on the policy list is the reason ``jsSorted`` exists. Its
    /// members are line and operator names in Japanese, Chinese and Korean,
    /// JavaScript's default comparator orders strings by UTF-16 code unit, and
    /// this key is a persisted format — so the ordering rule is stated rather
    /// than inherited from whatever `String` comparison the standard library
    /// happens to implement.
    public static func solveContext(
        train: CacheKeyTrain,
        routeSections: [RouteSection],
        country: String,
        cacheVersion: String = routeSolverCacheVersion
    ) -> SolveContext? {
        guard !routeSections.isEmpty else { return nil }
        let templateKey = templateKey(sections: routeSections)
        let allowedCodes = allowedInstitutionTypeCodes(train, country: country)
        var policyParts = train.preferredLineNames.map { "line:\($0)" }
        policyParts += train.preferredOperatorNames.map { "operator:\($0)" }
        policyParts += derivedPreferredOperatorNames(
            company: train.company, country: country
        ).map { "operator:\($0)" }
        // Duplicates are NOT removed — a preferred operator that is also
        // derived from the company field appears twice, and does so in the
        // shipped Taiwanese store.
        policyParts.append("institution_filter:\(train.institutionFilterMode ?? "soft")")
        let policyKey = jsSorted(policyParts).joined(separator: "|")
        let cacheKey =
            "solver:\(cacheVersion)|\(allowedCodes.joined(separator: ","))|\(policyKey)|\(templateKey)"
        return SolveContext(
            templateKey: templateKey, allowedCodes: allowedCodes,
            policyKey: policyKey, cacheKey: cacheKey)
    }

    // =====================================================================
    //  §27 — graph construction
    // =====================================================================

    /// The four rail-section attributes an edge carries, after the property
    /// fallback chain has been applied.
    ///
    /// Japan's sections are raw N02 and spell them `N02_001`…`N02_004`; the
    /// other four countries' sections are derived by the build scripts and
    /// spell them out. The JavaScript resolves `N02_003 || line_name || ""`
    /// at every edge; resolving once at decode is the same answer.
    public struct SectionProperties: Sendable, Equatable {
        public var lineName: String
        public var `operator`: String
        public var institutionTypeCode: String
        public var railwayClassCode: String

        public init(
            lineName: String = "", operator: String = "",
            institutionTypeCode: String = "", railwayClassCode: String = ""
        ) {
            self.lineName = lineName
            self.operator = `operator`
            self.institutionTypeCode = institutionTypeCode
            self.railwayClassCode = railwayClassCode
        }
    }

    /// One rail-section feature: its attributes and its raw, *un-quantised*
    /// geometry.
    ///
    /// Quantisation happens where the JavaScript does it —
    /// `iterateGeometryLines`, on the way into the graph — because that is
    /// also where `featureBBox` gets its coordinates, and a bbox measured on
    /// raw vertices is a different bbox.
    public struct SectionFeature: Sendable {
        public var properties: SectionProperties
        public var lines: [[Coordinate]]

        public init(properties: SectionProperties, lines: [[Coordinate]]) {
            self.properties = properties
            self.lines = lines
        }

        /// `iterateGeometryLines` — every vertex on the 5-decimal grid.
        public var quantisedLines: [[Coordinate]] {
            lines.map { $0.map(Grid.normalizeGraphCoord) }
        }
    }

    /// Extra payload the *solver* hangs on the connector edges it adds
    /// between platforms of one station group.
    ///
    /// Nothing in graph construction ever sets this. It is declared here
    /// because `addStationTransferConnectorEdges` pushes its edges into the
    /// same adjacency lists, and the alternative to naming the seam is a
    /// later port having to edit this file.
    public struct StationConnector: Sendable, Equatable {
        public var institutionTypeCodes: [String]
        public var stationName: String
        public var groupCode: String

        public init(
            institutionTypeCodes: [String] = [], stationName: String = "",
            groupCode: String = ""
        ) {
            self.institutionTypeCodes = institutionTypeCodes
            self.stationName = stationName
            self.groupCode = groupCode
        }
    }

    public struct Edge: Sendable, Equatable {
        public var to: String
        /// Metres, floored at 0.01 so a zero-length edge cannot make a
        /// zero-cost cycle.
        public var length: Double
        public var institutionTypeCode: String
        public var railwayClassCode: String
        public var lineName: String
        public var `operator`: String
        /// Non-nil only on the solver's station-transfer edges.
        public var connector: StationConnector?
    }

    /// What is known about the railways meeting at one node. Used only for
    /// membership tests, so a `Set` is faithful — the JavaScript never
    /// iterates these in a way that reaches an answer.
    public struct NodeMeta: Sendable, Equatable {
        public var lineNames: Set<String> = []
        public var operators: Set<String> = []
        public var institutionTypeCodes: Set<String> = []
        public var railwayClassCodes: Set<String> = []
        public init() {}
    }

    /// The routable graph.
    ///
    /// A reference type on purpose. In the JavaScript this is a plain object
    /// that the LRU, the solver and the caller all hold the *same* copy of:
    /// `addStationTransferConnectorEdges` mutates it after it is cached, and
    /// the solver memoises station snaps into `stationSnapCache` on it during
    /// a solve. A value type would silently give each of those its own copy
    /// and the memo would never hit.
    ///
    /// `stationSnapCache` itself is deliberately absent: its entries are
    /// solver-shaped snap candidates, and modelling them here would be
    /// modelling the solver. Because this is a class, the solver's port can
    /// keep that memo in its own store keyed by `ObjectIdentifier` of the
    /// graph and get the same lifetime — no edit to this file required.
    public final class Graph {
        /// Node key → its quantised coordinate.
        public var nodes: [String: Coordinate] = [:]
        /// Node key → its edges, **in insertion order**. Dijkstra relaxes an
        /// adjacency list in order, so this is a sequence, not a set.
        public var adjacency: [String: [Edge]] = [:]
        /// `graphGridKey` cell → the node keys in it, in insertion order.
        /// ``nearbyNodes`` leans on that order to break distance ties.
        public var grid: [String: [String]] = [:]
        public var nodeMeta: [String: NodeMeta] = [:]
        public let cellSize: Double
        /// Set only on a regional subgraph: the quantised bbox it covers.
        public var regionBBox: BBox?

        init(cellSize: Double) { self.cellSize = cellSize }

        public var nodeCount: Int { nodes.count }
    }

    /// The cell size of a graph's own node grid. Not the same grid as the
    /// rail-section index (``railIndexCellDeg``), which is ten times coarser
    /// and indexes features rather than nodes.
    public static let graphCellSize = 0.01

    /// Nodes and edges from rail-section features, and nothing else.
    ///
    /// The Python pipeline's rule, kept: the routable graph is built ONLY
    /// from RailroadSection geometry. An N02 Station LineString is a snap
    /// candidate, never a train-runnable edge.
    public static func build(from features: [SectionFeature]) -> Graph {
        let graph = Graph(cellSize: graphCellSize)

        func ensureNode(_ coord: Coordinate) -> String {
            // Quantised twice, exactly as the JavaScript does: once by
            // `iterateGeometryLines` on the way in, once here by
            // `normalizeGraphCoord`, and `coordKey` quantises a third time.
            // Idempotent in practice, but "in practice" is not a reason to
            // drop a step from a function that decides node identity.
            let normalized = Grid.normalizeGraphCoord(coord)
            let key = Grid.coordKey(normalized)
            if graph.nodes[key] == nil {
                graph.nodes[key] = normalized
                graph.adjacency[key] = []
                graph.nodeMeta[key] = NodeMeta()
                graph.grid[graphGridKey(normalized, cellSize: graph.cellSize), default: []]
                    .append(key)
            }
            return key
        }

        func recordNodeMeta(_ key: String, _ properties: SectionProperties) {
            guard graph.nodeMeta[key] != nil else { return }
            if !properties.lineName.isEmpty {
                graph.nodeMeta[key]!.lineNames.insert(properties.lineName)
            }
            if !properties.operator.isEmpty {
                graph.nodeMeta[key]!.operators.insert(properties.operator)
            }
            if !properties.institutionTypeCode.isEmpty {
                graph.nodeMeta[key]!.institutionTypeCodes.insert(properties.institutionTypeCode)
            }
            if !properties.railwayClassCode.isEmpty {
                graph.nodeMeta[key]!.railwayClassCodes.insert(properties.railwayClassCode)
            }
        }

        func addRailEdge(_ a: Coordinate, _ b: Coordinate, _ properties: SectionProperties) {
            let keyA = ensureNode(a)
            let keyB = ensureNode(b)
            // Two vertices that quantise to one node produce no edge — which
            // is the whole reason the spelling of a key matters.
            if keyA == keyB { return }
            recordNodeMeta(keyA, properties)
            recordNodeMeta(keyB, properties)
            let length = Geometry.distanceMeters(graph.nodes[keyA]!, graph.nodes[keyB]!)
            let edge = Edge(
                to: keyB,
                length: max(length, 0.01),
                institutionTypeCode: properties.institutionTypeCode,
                railwayClassCode: properties.railwayClassCode,
                lineName: properties.lineName,
                operator: properties.operator,
                connector: nil)
            graph.adjacency[keyA]!.append(edge)
            var reverse = edge
            reverse.to = keyA
            graph.adjacency[keyB]!.append(reverse)
        }

        for feature in features {
            for line in feature.quantisedLines {
                guard line.count >= 2 else { continue }
                for i in 0..<(line.count - 1) {
                    addRailEdge(line[i], line[i + 1], feature.properties)
                }
            }
        }
        return graph
    }

    /// `graphGridKey` — which cell of the graph's node grid a coordinate is
    /// in. Declared in `app-route-solver.js`, but it is graph construction's
    /// only primitive that lives over there, and the graph cannot be built
    /// without it.
    static func graphGridKey(_ coord: Coordinate, cellSize: Double) -> String {
        let normalized = Grid.normalizeGraphCoord(coord)
        return JSNumber.string((normalized.lon / cellSize).rounded(.down)) + ","
            + JSNumber.string((normalized.lat / cellSize).rounded(.down))
    }

    /// The nodes near a coordinate, nearest first — the station snap's
    /// candidate list.
    ///
    /// `radiusDeg` sizes the block of cells scanned; it does **not** filter
    /// the results, so a returned node can be further away than the radius,
    /// and with `cellRadius` floored at 1 even a radius of zero scans a 3×3
    /// block. Both are relied on: a platform whose nearest rail is 400 m away
    /// still finds it.
    ///
    /// The sort is by distance and `Array.prototype.sort` is stable, so equal
    /// distances keep the order the scan found them in — which is the cell
    /// order (dx outer, dy inner) and, within a cell, the bucket's insertion
    /// order. Swift's `sort` is not stable, so the original index is carried
    /// as an explicit tiebreaker.
    public static func nearbyNodes(
        _ coord: Coordinate, in graph: Graph, radiusDeg: Double = 0.0015, limit: Int = 30
    ) -> [(key: String, distance: Double)] {
        let normalized = Grid.normalizeGraphCoord(coord)
        let baseX = (normalized.lon / graph.cellSize).rounded(.down)
        let baseY = (normalized.lat / graph.cellSize).rounded(.down)
        let cellRadius = Int(max(1, (radiusDeg / graph.cellSize).rounded(.up)))

        var found: [(key: String, distance: Double, order: Int)] = []
        var seen = Set<String>()
        for dx in -cellRadius...cellRadius {
            for dy in -cellRadius...cellRadius {
                let cell =
                    JSNumber.string(baseX + Double(dx)) + ","
                    + JSNumber.string(baseY + Double(dy))
                guard let bucket = graph.grid[cell] else { continue }
                for key in bucket {
                    guard seen.insert(key).inserted else { continue }
                    let distance = Geometry.distanceMeters(normalized, graph.nodes[key]!)
                    found.append((key, distance, found.count))
                }
            }
        }
        found.sort { $0.distance == $1.distance ? $0.order < $1.order : $0.distance < $1.distance }
        // `Array.prototype.slice(0, limit)`, negative limit and all.
        let end = limit < 0 ? max(0, found.count + limit) : min(limit, found.count)
        return found[0..<end].map { ($0.key, $0.distance) }
    }

    /// `intersects` — do these two sets share a member? Exported to the
    /// solver, which uses it for the hint and institution filters.
    public static func intersects(_ a: Set<String>?, _ b: Set<String>?) -> Bool {
        guard let a, let b else { return false }
        for value in a where b.contains(value) { return true }
        return false
    }

    // =====================================================================
    //  §28 — bounding boxes, the rail-section index and regional subgraphs
    // =====================================================================

    /// `[minX, minY, maxX, maxY]` — longitude first, matching every bbox the
    /// JavaScript passes around.
    public struct BBox: Sendable, Equatable {
        public var minX: Double
        public var minY: Double
        public var maxX: Double
        public var maxY: Double

        public init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
            self.minX = minX
            self.minY = minY
            self.maxX = maxX
            self.maxY = maxY
        }

        public init?(array: [Double]) {
            guard array.count == 4 else { return nil }
            self.init(minX: array[0], minY: array[1], maxX: array[2], maxY: array[3])
        }

        public var array: [Double] { [minX, minY, maxX, maxY] }
    }

    public static func bboxIntersects(_ a: BBox, _ b: BBox) -> Bool {
        !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
    }

    /// The bbox of one feature's **quantised** geometry.
    ///
    /// Quantised because `iterateGeometryLines` is what the JavaScript walks
    /// here, and the index this feeds is compared against query boxes derived
    /// from the same grid. Returns nil for a feature with no vertices.
    public static func featureBBox(_ feature: SectionFeature) -> BBox? {
        var minX = Double.infinity
        var minY = Double.infinity
        var maxX = -Double.infinity
        var maxY = -Double.infinity
        for line in feature.quantisedLines {
            for point in line {
                if point.lon < minX { minX = point.lon }
                if point.lon > maxX { maxX = point.lon }
                if point.lat < minY { minY = point.lat }
                if point.lat > maxY { maxY = point.lat }
            }
        }
        return minX == .infinity ? nil : BBox(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
    }

    /// Expand a bbox by a metric margin, longitude scaled by latitude.
    ///
    /// The `max(0.2, cos …)` floor stops the longitude margin exploding near
    /// the poles; none of the five countries goes anywhere near it, but the
    /// clamp is part of the answer and is kept.
    public static func padBBoxMeters(_ bbox: BBox, meters: Double) -> BBox {
        let latPad = meters / 111_320
        let midLat = (bbox.minY + bbox.maxY) / 2
        let lonPad = meters / (111_320 * max(0.2, cos(midLat * .pi / 180)))
        return BBox(
            minX: bbox.minX - lonPad, minY: bbox.minY - latPad,
            maxX: bbox.maxX + lonPad, maxY: bbox.maxY + latPad)
    }

    public static func bboxDiagonalMeters(_ bbox: BBox) -> Double {
        Geometry.distanceMeters(
            Coordinate(lon: bbox.minX, lat: bbox.minY),
            Coordinate(lon: bbox.maxX, lat: bbox.maxY))
    }

    /// `REGION_QUANT_DEG` — regional bboxes are snapped outward to this grid
    /// so that nearby route sections share one subgraph instead of each
    /// building its own.
    public static let regionQuantDeg = 0.25

    public static func quantizeBBoxOutward(_ bbox: BBox) -> BBox {
        BBox(
            minX: (bbox.minX / regionQuantDeg).rounded(.down) * regionQuantDeg,
            minY: (bbox.minY / regionQuantDeg).rounded(.down) * regionQuantDeg,
            maxX: (bbox.maxX / regionQuantDeg).rounded(.up) * regionQuantDeg,
            maxY: (bbox.maxY / regionQuantDeg).rounded(.up) * regionQuantDeg)
    }

    /// The LRU key of a quantised region: `qbbox.map(v => v.toFixed(2))`.
    static func regionKey(_ qbbox: BBox) -> String {
        qbbox.array.map(fixed2).joined(separator: ",")
    }

    /// `Number.prototype.toFixed(2)` over the only values this key sees.
    ///
    /// Two places where the obvious `String(format: "%.2f", value)` is wrong.
    /// ECMAScript takes the sign off with `x < 0`, which is **false** for
    /// negative zero, so JavaScript writes `"0.00"` where `%.2f` writes
    /// `"-0.00"` — and negative zero is reachable, because `Math.ceil` of
    /// anything in `(-0.25, 0]` is `-0`. (Not reachable with these five
    /// countries' coordinates, all of which are 113–145°E and 22–45°N, but
    /// the rule is the rule.) The other is rounding: `toFixed` rounds a tie
    /// away from zero and `%.2f` rounds it to even. That one cannot bite
    /// here, because every input is an integer times 0.25 and 0.25 is a power
    /// of two, so the value is exact and no tie exists.
    static func fixed2(_ value: Double) -> String {
        let negative = value < 0
        let text = String(format: "%.2f", negative ? -value : value)
        return negative ? "-" + text : text
    }

    /// Something with a display point — a station feature, as far as the
    /// regional builder is concerned. A protocol rather than a concrete
    /// station type because the station model belongs to the solver's port,
    /// and all this needs is where the thing is.
    public protocol DisplayLocatable {
        var displayCoordinate: Coordinate? { get }
    }

    /// Stations inside a bbox, in the order they appear in the dataset.
    ///
    /// Note the bounds are inclusive on all four sides, and that the
    /// coordinate used is the display point — **not** quantised, unlike the
    /// rail-section bboxes this is called beside.
    public static func stationsInBBox<T: DisplayLocatable>(_ stations: [T], _ bbox: BBox) -> [T] {
        stations.filter { station in
            guard let c = station.displayCoordinate else { return false }
            return c.lon >= bbox.minX && c.lon <= bbox.maxX && c.lat >= bbox.minY
                && c.lat <= bbox.maxY
        }
    }

    /// True if any vertex of a solved feature lies within `marginDeg` of the
    /// region edge — the signal that the true optimum might leave the region,
    /// so the search should widen or fall back to the full graph. This is what
    /// makes an on-demand regional result provably equal to the all-Japan one.
    ///
    /// It iterates by geometry type rather than assuming a LineString: the
    /// solver emits only LineStrings today, but comparing a nested coordinate
    /// array against a number is always false, so a MultiLineString would
    /// silently pass the check and a truncated path would be accepted.
    public static func pathTouchesRegionEdge(
        lines: [[Coordinate]], regionBBox: BBox?, marginDeg: Double
    ) -> Bool {
        guard let regionBBox else { return false }
        for line in lines {
            for c in line {
                if c.lon <= regionBBox.minX + marginDeg || c.lon >= regionBBox.maxX - marginDeg
                    || c.lat <= regionBBox.minY + marginDeg
                    || c.lat >= regionBBox.maxY - marginDeg
                {
                    return true
                }
            }
        }
        return false
    }

    /// `RAIL_INDEX_CELL_DEG` — the rail-section index's cell size.
    public static let railIndexCellDeg = 0.1

    /// `REGIONAL_GRAPH_NODE_BUDGET` — the steady-state cap on total resident
    /// regional-graph nodes.
    ///
    /// It was 140,000, which is smaller than a single cross-Japan region
    /// (50k–72k nodes), so a multi-region load evicted a region and then
    /// rebuilt the identical one two or three times in one pass. The
    /// full-Japan graph is ~377k nodes and is already a tolerated fallback, so
    /// holding four or five regions is well inside that envelope.
    public static let regionalGraphNodeBudget = 300_000

    /// `REGIONAL_GRAPH_LOAD_NODE_BUDGET` — while a progressive load or one
    /// interactive solve is building regions back to back, eviction is
    /// suspended up to this larger transient, so a region built for an early
    /// train is still resident when a later train needs it.
    public static let regionalGraphLoadNodeBudget = 600_000
}

// =========================================================================
//  The module-level mutable state of app-route-graph.js §28
// =========================================================================

extension RouteGraph {

    /// The rail-section dataset, its spatial index, the memoised full-network
    /// graph and the LRU of regional subgraphs.
    ///
    /// In the JavaScript these are four module-level `let`s plus
    /// `invalidateRouteGraphIndexes()`, which the country switch calls to drop
    /// all of them at once. Making them one object is the only liberty taken:
    /// the alternative in Swift is global mutable state, and the country
    /// switch's rule — never leave two countries' networks loaded, because
    /// they share station names and a stop resolved against the wrong network
    /// looks like a route rather than an error — is far easier to keep when
    /// dropping a country means dropping an object.
    public final class RouteGraphStore {

        public let sections: [SectionFeature]

        /// The solver's `addStationTransferConnectorEdges`, if it has been
        /// ported. Called with the freshly built graph and the region it
        /// covers, exactly where `getRegionalRouteGraph` and
        /// `getRuntimeRouteGraph` call it. Left nil, the store builds the pure
        /// rail graph and nothing else — which is what an offline exporter
        /// with no station dataset wants, and what the parity fixture records.
        public var augment: ((Graph, BBox?) -> Void)?

        private var bboxes: [BBox?]?
        private var spatialIndex: [String: [Int]]?
        private var fullGraphCache: Graph?
        /// Region key → graph, plus the key order that makes it an LRU. A
        /// JavaScript `Map` is both; a Swift `Dictionary` is neither.
        private var regionalGraphs: [String: Graph] = [:]
        private var regionalOrder: [String] = []
        private var residentNodes = 0

        public init(sections: [SectionFeature], augment: ((Graph, BBox?) -> Void)? = nil) {
            self.sections = sections
            self.augment = augment
        }

        /// Drops every memo. The country switch's single call.
        public func invalidate() {
            spatialIndex = nil
            bboxes = nil
            fullGraphCache = nil
            regionalGraphs.removeAll()
            regionalOrder.removeAll()
            residentNodes = 0
        }

        /// Cached per-feature bboxes — the JavaScript stashes these on the
        /// feature object itself as `__railBbox`.
        private func featureBBoxes() -> [BBox?] {
            if let bboxes { return bboxes }
            let computed = sections.map { RouteGraph.featureBBox($0) }
            bboxes = computed
            return computed
        }

        /// A coarse grid over feature bboxes: cheap (bboxes and indices only),
        /// built once, so a regional build never scans all 22k features.
        ///
        /// Feature identity is the index in the shipped file, because that is
        /// the only identity a feature has. The JavaScript de-duplicates by
        /// object identity, which is the same thing.
        public func railSectionSpatialIndex() -> [String: [Int]] {
            if let spatialIndex { return spatialIndex }
            var grid: [String: [Int]] = [:]
            let boxes = featureBBoxes()
            for (index, bbox) in boxes.enumerated() {
                guard let bbox else { continue }
                let x0 = (bbox.minX / railIndexCellDeg).rounded(.down)
                let x1 = (bbox.maxX / railIndexCellDeg).rounded(.down)
                let y0 = (bbox.minY / railIndexCellDeg).rounded(.down)
                let y1 = (bbox.maxY / railIndexCellDeg).rounded(.down)
                var x = x0
                while x <= x1 {
                    var y = y0
                    while y <= y1 {
                        grid[JSNumber.string(x) + "," + JSNumber.string(y), default: []]
                            .append(index)
                        y += 1
                    }
                    x += 1
                }
            }
            spatialIndex = grid
            return grid
        }

        /// The indices of every feature whose bbox meets `bbox`.
        ///
        /// The ORDER is part of the answer. Cells are scanned x outer, y
        /// inner, and a feature is emitted the first time it is seen — so the
        /// graph built from this list gets its adjacency lists in this order,
        /// and Dijkstra relaxes them in it.
        public func featureIndicesInBBox(_ bbox: BBox) -> [Int] {
            let grid = railSectionSpatialIndex()
            let boxes = featureBBoxes()
            let x0 = (bbox.minX / railIndexCellDeg).rounded(.down)
            let x1 = (bbox.maxX / railIndexCellDeg).rounded(.down)
            let y0 = (bbox.minY / railIndexCellDeg).rounded(.down)
            let y1 = (bbox.maxY / railIndexCellDeg).rounded(.down)
            var seen = Set<Int>()
            var out: [Int] = []
            var x = x0
            while x <= x1 {
                var y = y0
                while y <= y1 {
                    if let bucket = grid[JSNumber.string(x) + "," + JSNumber.string(y)] {
                        for index in bucket {
                            guard seen.insert(index).inserted else { continue }
                            if let fb = boxes[index], RouteGraph.bboxIntersects(fb, bbox) {
                                out.append(index)
                            }
                        }
                    }
                    y += 1
                }
                x += 1
            }
            return out
        }

        public func featuresInBBox(_ bbox: BBox) -> [SectionFeature] {
            featureIndicesInBBox(bbox).map { sections[$0] }
        }

        /// The full-network graph — ~377k nodes for Japan.
        ///
        /// Kept as the guaranteed-correct fallback for on-demand solving:
        /// built lazily and memoised only if a regional subgraph proves
        /// insufficient, never eagerly at startup.
        public func fullGraph() -> Graph {
            if let fullGraphCache { return fullGraphCache }
            let graph = RouteGraph.build(from: sections)
            augment?(graph, nil)
            fullGraphCache = graph
            return graph
        }

        /// Evict least-recently-used regional graphs until the resident node
        /// count is at or below `target` — always keeping at least one, so the
        /// in-flight solve still has its graph.
        public func trimRegionalGraphCache(target: Int) {
            while residentNodes > target && regionalGraphs.count > 1 {
                let oldestKey = regionalOrder.removeFirst()
                if let oldest = regionalGraphs.removeValue(forKey: oldestKey) {
                    residentNodes -= oldest.nodeCount
                }
            }
        }

        /// Build, or reuse from the LRU, the regional subgraph covering a
        /// bbox.
        ///
        /// A subgraph built from EVERY rail feature inside a bbox is
        /// structurally identical to the full graph restricted to that bbox,
        /// so Dijkstra returns the same optimal path as long as that path
        /// stays inside — which the caller checks with
        /// ``pathTouchesRegionEdge`` and widens or falls back to the full
        /// graph when it does not.
        public func regionalGraph(
            for bbox: BBox, importInProgress: Bool = false, routeSolveInProgress: Bool = false
        ) -> Graph {
            let qbbox = RouteGraph.quantizeBBoxOutward(bbox)
            let key = RouteGraph.regionKey(qbbox)
            if let cached = regionalGraphs[key] {
                // The LRU touch: delete then re-insert moves the key to the
                // young end. Reproducing it is the whole reason this cache
                // carries its own key order.
                if let position = regionalOrder.firstIndex(of: key) {
                    regionalOrder.remove(at: position)
                }
                regionalOrder.append(key)
                return cached
            }
            let graph = RouteGraph.build(from: featuresInBBox(qbbox))
            augment?(graph, qbbox)
            graph.regionBBox = qbbox
            regionalGraphs[key] = graph
            regionalOrder.append(key)
            residentNodes += graph.nodeCount
            trimRegionalGraphCache(
                target: importInProgress || routeSolveInProgress
                    ? RouteGraph.regionalGraphLoadNodeBudget
                    : RouteGraph.regionalGraphNodeBudget)
            return graph
        }

        /// The LRU's keys, oldest first — the order eviction follows.
        public var regionCacheKeys: [String] { regionalOrder }
        public var residentNodeCount: Int { residentNodes }
    }
}

// =========================================================================
//  JavaScript ordering and string rules these keys depend on
// =========================================================================

extension RouteGraph {

    /// `Array.prototype.sort()` with no comparator: strings ordered by UTF-16
    /// code unit.
    ///
    /// Not the same as Swift's `<` on `String`, which orders by Unicode
    /// canonical equivalence. Every list sorted here ends up inside a
    /// persisted cache key and most of them hold Japanese, Chinese or Korean
    /// names, so the rule is stated rather than inherited.
    static func jsSorted<S: Sequence>(_ values: S) -> [String] where S.Element == String {
        // a < b  ⟺  not (b <= a)
        values.sorted { !JSNumber.stringLessOrEqual($1, $0) }
    }

    /// `[...new Set(values)]` — first occurrence wins, insertion order kept.
    static func orderedUnique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    /// `String.prototype.trim`'s character set: Unicode whitespace and line
    /// terminators, plus U+FEFF, which JavaScript trims and Swift's
    /// `.whitespacesAndNewlines` does not.
    static let jsTrimSet = CharacterSet.whitespacesAndNewlines.union(
        CharacterSet(charactersIn: "\u{FEFF}"))
}

extension Coordinate: RouteGraph.DisplayLocatable {
    public var displayCoordinate: Coordinate? { self }
}

// =========================================================================
//  Reading the shipped rail-section datasets
// =========================================================================

extension RouteGraph {

    /// `app/data/rail-sections*.json` — the solver's own routable geometry,
    /// one feature per stretch of track.
    ///
    /// This is a *different* dataset from the compact display packages that
    /// ``CompactPackage`` reads. Japan's is raw N02 (`N02_001`…`N02_004`,
    /// 21,933 features); the other four are derived by
    /// `scripts/railway/rebuild-solver-sections.py` from the display package
    /// and spell their properties out. Both spellings are accepted here
    /// because the JavaScript accepts both, at every edge.
    public struct SectionFeatureCollection: Decodable {
        public let features: [SectionFeature]

        public static func load(contentsOf url: URL) throws -> SectionFeatureCollection {
            try JSONDecoder().decode(SectionFeatureCollection.self, from: Data(contentsOf: url))
        }
    }
}

extension RouteGraph.SectionFeature: Decodable {
    private enum CodingKeys: String, CodingKey { case properties, geometry }

    private struct Properties: Decodable {
        let lineName: String?
        let `operator`: String?
        let institutionTypeCode: String?
        let railwayClassCode: String?

        private enum CodingKeys: String, CodingKey {
            case n02_001 = "N02_001"
            case n02_002 = "N02_002"
            case n02_003 = "N02_003"
            case n02_004 = "N02_004"
            case line_name, `operator`, institution_type_code, railway_class_code
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            railwayClassCode = try c.decodeIfPresent(String.self, forKey: .n02_001)
                ?? c.decodeIfPresent(String.self, forKey: .railway_class_code)
            institutionTypeCode = try c.decodeIfPresent(String.self, forKey: .n02_002)
                ?? c.decodeIfPresent(String.self, forKey: .institution_type_code)
            lineName = try c.decodeIfPresent(String.self, forKey: .n02_003)
                ?? c.decodeIfPresent(String.self, forKey: .line_name)
            `operator` = try c.decodeIfPresent(String.self, forKey: .n02_004)
                ?? c.decodeIfPresent(String.self, forKey: .operator)
        }
    }

    private struct Geometry: Decodable {
        let type: String
        let lines: [[Coordinate]]

        private enum CodingKeys: String, CodingKey { case type, coordinates }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            // `iterateGeometryLines` handles exactly these three and returns
            // nothing for anything else.
            switch type {
            case "LineString":
                lines = [try c.decode([[Double]].self, forKey: .coordinates)
                    .compactMap(Coordinate.init(pair:))]
            case "MultiLineString":
                lines = try c.decode([[[Double]]].self, forKey: .coordinates)
                    .map { $0.compactMap(Coordinate.init(pair:)) }
            case "Point":
                lines = [[Coordinate(pair: try c.decode([Double].self, forKey: .coordinates))]
                    .compactMap { $0 }]
            default:
                lines = []
            }
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let properties = try c.decodeIfPresent(Properties.self, forKey: .properties)
        // The `||` fallback chain, resolved once: an empty string is falsy in
        // JavaScript, so it falls through to the next spelling just as a
        // missing key does.
        func nonEmpty(_ value: String?) -> String { (value?.isEmpty == false) ? value! : "" }
        self.init(
            properties: RouteGraph.SectionProperties(
                lineName: nonEmpty(properties?.lineName),
                operator: nonEmpty(properties?.operator),
                institutionTypeCode: nonEmpty(properties?.institutionTypeCode),
                railwayClassCode: nonEmpty(properties?.railwayClassCode)),
            lines: (try c.decodeIfPresent(Geometry.self, forKey: .geometry))?.lines ?? [])
    }
}
