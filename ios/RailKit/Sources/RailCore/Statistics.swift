import Foundation

/// Mileage statistics — the port of `app/public/app-stats.js` §23a.
///
/// This is the tier that turns "which rails did you actually travel on" into
/// the numbers in the 統計 panel: which bucket a stretch of track belongs to,
/// how long every bucket is, how much of it has been ridden, and which
/// station-to-station sections have been ridden most.
///
/// **The rule the whole file rests on: coverage is a deduped UNION, not a
/// sum.** Every train's ridden geometry is matched onto the N02 RailroadSection
/// edge set, and those edge ids are folded into one Set. Riding 東京–品川 forty
/// times puts the same ids into the Set forty times and into the total once,
/// which is why the percentage is a percentage of the network rather than a
/// running tally. ``aggregateMileageStats(index:entries:country:)`` is where
/// that happens, and it is the one function in here whose contract cannot be
/// relaxed without the panel becoming a different claim.
///
/// The per-train km on ``TrainEntry/km`` is the deliberate opposite: it
/// accumulates repeats, because it pairs with ride time and ride count in the
/// service-tier rows.
///
/// What is *not* here is everything `app-stats-render.js` does with the
/// result — number formatting, `Intl.Collator` line ordering, the HTML. Nor
/// the browser-side scheduling around the pure logic: the sliced index build's
/// 12 ms yield budget, `_statsTrainCache`'s per-train signature (which keys on
/// `getTrainRouteTemplateKey`, a different file's port) and
/// `ensureStatsEdgeIndexAsync`'s single-flight guard are all about not
/// freezing a browser tab, and none of them change an answer.
public enum Statistics {

    // MARK: - category masks

    // The mask bits are shared by every country — a bit means the same KIND of
    // track everywhere (high speed, incumbent conventional, metro, light rail,
    // other) so all the accumulation code stays country-generic. What differs
    // per country is which buckets exist and what they are called.
    public static let maskHSR = 1
    public static let maskCONV = 2
    public static let maskJR = 4
    public static let maskMETRO = 8
    public static let maskPRIV = 16
    public static let maskTRAM = 32

    public struct Category: Sendable, Equatable {
        public let mask: Int
        /// The i18n key, which resolves through the country variants
        /// (`stat.conv` → `stat.conv.tw` = 臺鐵) in the render tier.
        public let i18n: String
    }

    /// The rows one country's coverage panel has, in display order.
    ///
    /// Read this as a getter, never as a snapshot: the active country can
    /// change without a reload, and a value captured once would keep the old
    /// country's rows forever.
    public static func categories(country: String) -> [Category] {
        switch country {
        case "tw":
            return [
                Category(mask: maskHSR, i18n: "stat.hsr"),
                Category(mask: maskCONV, i18n: "stat.conv"),
                Category(mask: maskMETRO, i18n: "stat.metro"),
                Category(mask: maskTRAM, i18n: "stat.tram"),
                Category(mask: maskPRIV, i18n: "stat.priv"),
            ]
        // Hong Kong: MTR's two service families — heavy rail and Light Rail —
        // plus the Hong Kong Island street tramway, a separate operator that
        // takes the "other railway" slot because 輕鐵 already holds the
        // light-rail one. Macao is a single LRT system.
        case "hk":
            return [
                Category(mask: maskMETRO, i18n: "stat.metro"),
                Category(mask: maskTRAM, i18n: "stat.tram"),
                Category(mask: maskPRIV, i18n: "stat.priv"),
            ]
        case "mo":
            return [Category(mask: maskMETRO, i18n: "stat.metro")]
        case "kr":
            return [
                Category(mask: maskHSR, i18n: "stat.hsr"),
                Category(mask: maskCONV, i18n: "stat.conv"),
                Category(mask: maskMETRO, i18n: "stat.metro"),
                Category(mask: maskTRAM, i18n: "stat.tram"),
                Category(mask: maskPRIV, i18n: "stat.priv"),
            ]
        default:
            return [
                Category(mask: maskHSR, i18n: "stat.hsr"),
                Category(mask: maskCONV, i18n: "stat.conv"),
                Category(mask: maskJR, i18n: "stat.jr"),
                Category(mask: maskMETRO, i18n: "stat.metro"),
                Category(mask: maskPRIV, i18n: "stat.priv"),
                Category(mask: maskTRAM, i18n: "stat.tram"),
            ]
        }
    }

    /// The coverage masks deliberately OVERLAP (JR is the union of 新幹線 and
    /// JR在來線, and 普通鐵道 means "everything that is not 新幹線"), which is right
    /// for percentages and wrong for asking "what kind of track is this?".
    /// This collapses a mask to exactly ONE bucket, most specific first.
    public static func exclusiveTrackBucket(_ mask: Int) -> Int {
        if mask & maskHSR != 0 { return maskHSR }
        if mask & maskMETRO != 0 { return maskMETRO }
        if mask & maskTRAM != 0 { return maskTRAM }
        if mask & maskPRIV != 0 { return maskPRIV }
        return maskCONV  // JR 在來線 (and any unclassified conventional track)
    }

    /// Collapse a section mask to the ONE 已乘路線 checkbox it belongs to.
    ///
    /// This is the single rule behind both the ridden-line classifier and the
    /// station-dot classifier, so hiding a category always hides its lines and
    /// its dots together. Taiwan records no JR-style union, so its incumbent
    /// conventional railway (臺鐵, CONV-only masks) fills the slot the filter
    /// calls "jr" — the national-railway toggle.
    public static func filterCategoryForMask(_ mask: Int, country: String) -> String {
        if mask & maskHSR != 0 { return "hsr" }
        if mask & maskMETRO != 0 { return "metro" }
        if mask & maskJR != 0 { return "jr" }
        if mask & maskCONV != 0 && country == "tw" { return "jr" }
        return "priv"
    }

    // MARK: - section attributes

    /// One JSON value, kept in the shape JavaScript sees it in.
    ///
    /// The section readers are `props.N02_001 || props.railway_class_code || ""`
    /// — a chain of `||`, which is JavaScript *truthiness*, not a nil check.
    /// A numeric `0` in `N02_001` therefore falls through to the neutral alias
    /// while the string `"0"` does not, and `String(21)` must spell `"21"`
    /// rather than `"21.0"`. Modelling the field as `String?` would quietly
    /// lose both distinctions, so the raw value is kept.
    public enum JSValue: Sendable, Equatable {
        case string(String)
        case number(Double)
        case bool(Bool)
        case null

        /// JavaScript truthiness: `""`, `0`, `NaN`, `false` and `null` are falsy.
        public var isTruthy: Bool {
            switch self {
            case .string(let s): return !s.isEmpty
            case .number(let d): return d != 0 && !d.isNaN
            case .bool(let b): return b
            case .null: return false
            }
        }

        /// `String(value)` — via ``JSNumber/string(_:)`` for numbers, because
        /// Swift spells an integral `Double` with a fractional part and
        /// JavaScript does not.
        public var jsString: String {
            switch self {
            case .string(let s): return s
            case .number(let d): return JSNumber.string(d)
            case .bool(let b): return b ? "true" : "false"
            case .null: return "null"
            }
        }
    }

    /// The attributes every country's dataset answers under, read by one
    /// reader for both spellings: Japan writes the historical `N02_*` property
    /// names, the others the neutral aliases.
    public struct SectionProperties: Decodable, Sendable, Equatable {
        public var n02_001: JSValue?
        public var n02_002: JSValue?
        public var n02_003: JSValue?
        public var n02_004: JSValue?
        public var railwayClassCode: JSValue?
        public var institutionTypeCode: JSValue?
        public var lineName: JSValue?
        public var operatorName: JSValue?

        public init(
            n02_001: JSValue? = nil, n02_002: JSValue? = nil,
            n02_003: JSValue? = nil, n02_004: JSValue? = nil,
            railwayClassCode: JSValue? = nil, institutionTypeCode: JSValue? = nil,
            lineName: JSValue? = nil, operatorName: JSValue? = nil
        ) {
            self.n02_001 = n02_001
            self.n02_002 = n02_002
            self.n02_003 = n02_003
            self.n02_004 = n02_004
            self.railwayClassCode = railwayClassCode
            self.institutionTypeCode = institutionTypeCode
            self.lineName = lineName
            self.operatorName = operatorName
        }

        private enum CodingKeys: String, CodingKey {
            case n02_001 = "N02_001"
            case n02_002 = "N02_002"
            case n02_003 = "N02_003"
            case n02_004 = "N02_004"
            case railwayClassCode = "railway_class_code"
            case institutionTypeCode = "institution_type_code"
            case lineName = "line_name"
            case operatorName = "operator"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            func read(_ key: CodingKeys) throws -> JSValue? {
                guard container.contains(key) else { return nil }
                if try container.decodeNil(forKey: key) { return .null }
                if let s = try? container.decode(String.self, forKey: key) { return .string(s) }
                if let d = try? container.decode(Double.self, forKey: key) { return .number(d) }
                if let b = try? container.decode(Bool.self, forKey: key) { return .bool(b) }
                return nil
            }
            n02_001 = try read(.n02_001)
            n02_002 = try read(.n02_002)
            n02_003 = try read(.n02_003)
            n02_004 = try read(.n02_004)
            railwayClassCode = try read(.railwayClassCode)
            institutionTypeCode = try read(.institutionTypeCode)
            lineName = try read(.lineName)
            operatorName = try read(.operatorName)
        }

        /// `a || b || ""`.
        private static func firstTruthy(_ a: JSValue?, _ b: JSValue?) -> JSValue? {
            if let a, a.isTruthy { return a }
            if let b, b.isTruthy { return b }
            return nil
        }

        /// `String(props.N02_001 || props.railway_class_code || "")`
        public var railwayClassCodeString: String {
            Self.firstTruthy(n02_001, railwayClassCode)?.jsString ?? ""
        }

        /// `String(props.N02_002 || props.institution_type_code || "")`
        public var institutionTypeCodeString: String {
            Self.firstTruthy(n02_002, institutionTypeCode)?.jsString ?? ""
        }

        /// `props.N02_003 || props.line_name || ""`.
        ///
        /// The JavaScript does *not* wrap this one in `String()`, so in
        /// principle a numeric line name would stay a number and miss the
        /// string-keyed corridor Maps. Every caller either interpolates it
        /// into a template or compares it with a string literal, and no
        /// shipped dataset carries a non-string here, so the coerced form is
        /// what is kept — with the one behaviour that depended on the raw
        /// value, its truthiness, preserved as "not empty".
        public var lineNameString: String {
            Self.firstTruthy(n02_003, lineName)?.jsString ?? ""
        }

        /// `props.N02_004 || props.operator || ""`
        public var operatorString: String {
            Self.firstTruthy(n02_004, operatorName)?.jsString ?? ""
        }
    }

    // MARK: - classification

    /// 地下鐵 operators (`N02_004` names): the two metro companies plus every
    /// municipal subway operator in Japan.
    static let metroOperatorNames: Set<String> = [
        "東京地下鉄",  // 東京メトロ
        "大阪市高速電気軌道",  // Osaka Metro
        "東京都",  // 都営地下鉄 (都電 excluded via the tram class below)
        "札幌市", "仙台市", "横浜市", "名古屋市", "京都市", "神戸市", "福岡市",
    ]

    /// Only class 21 (軌道) is a street tram. Class 22 is a SUSPENDED MONORAIL
    /// built under the same 軌道法 — 千葉都市モノレール is its only holder in N02,
    /// and it belongs with the other monorails in 私鐵・第三部門.
    static let tramRailwayClasses: Set<String> = ["21"]

    /// Heavy-rail lines licensed under 軌道法 (class 21) that are nothing like a
    /// street tram: full-size trains, mostly through-running onto subways.
    /// Without this they would all count as 路面電車.
    static let tramClassHeavyRailLines: Set<String> = [
        "北大阪急行電鉄|南北線",  // through-service with Osaka Metro 御堂筋線
        "近畿日本鉄道|けいはんな線",  // through-service with Osaka Metro 中央線
        "名古屋鉄道|豊川線",  // ordinary 名鉄 line, 軌道法 for historic reasons only
    ]

    /// Which buckets a section belongs to, for the given country. The mask
    /// bits are shared; how a country's own official codes map onto them is not.
    public static func classifySectionMask(_ props: SectionProperties, country: String) -> Int {
        switch country {
        case "tw": return classifyTwSectionMask(props)
        case "hk": return classifyHkSectionMask(props)
        case "mo": return maskMETRO  // Macao's whole network is one automated LRT system.
        case "kr": return classifyKrSectionMask(props)
        default: return classifyJpSectionMask(props)
        }
    }

    /// Taiwan, over the code space the package build assigns: institution 1 =
    /// 高鐵, 2 = 臺鐵, 3 = publicly operated, with the railway class separating
    /// 捷運 (普通鐵道) from 輕軌 (軌道) and the 阿里山林業鐵路 (特殊鐵道). Unlike Japan's
    /// overlapping masks these buckets are exclusive.
    static func classifyTwSectionMask(_ props: SectionProperties) -> Int {
        let code = props.institutionTypeCodeString
        let cls = props.railwayClassCodeString
        if code == "1" { return maskHSR }
        if cls == "21" { return maskTRAM }
        if cls == "31" { return maskPRIV }
        if code == "3" { return maskMETRO }
        return maskCONV
    }

    static let hongKongTramOperator = "香港電車"

    /// Hong Kong ships one flat code pair (institution 4 / class 21) across the
    /// whole territory, so its buckets ride on the operator and the official
    /// line names instead: the tramway is the only network 香港電車 runs, and
    /// within MTR's own network every Light Rail route is named 輕鐵NNN綫 by the
    /// package build while everything else is a heavy-rail line.
    static func classifyHkSectionMask(_ props: SectionProperties) -> Int {
        if props.operatorString == hongKongTramOperator { return maskPRIV }
        return props.lineNameString.hasPrefix("輕鐵") ? maskTRAM : maskMETRO
    }

    /// South Korea: 고속철도 / 일반철도 / 도시철도 / 경전철 / 모노레일·자기부상. Like Taiwan
    /// the buckets are exclusive — but note the class tests come BEFORE the
    /// institution ones, which is the opposite order to Taiwan's class 21.
    static func classifyKrSectionMask(_ props: SectionProperties) -> Int {
        let code = props.institutionTypeCodeString
        let cls = props.railwayClassCodeString
        if code == "1" { return maskHSR }
        if cls == "31" { return maskPRIV }
        if cls == "21" { return maskTRAM }
        if code == "3" { return maskMETRO }
        if code == "4" { return maskMETRO }
        return maskCONV
    }

    static func classifyJpSectionMask(_ props: SectionProperties) -> Int {
        let code = props.institutionTypeCodeString
        let cls = props.railwayClassCodeString
        let op = props.operatorString
        var mask = 0
        if code == "1" { mask |= maskHSR } else { mask |= maskCONV }
        if code == "1" || code == "2" { mask |= maskJR }
        // 都電荒川線 is the ONLY street tram run by a metro-list operator (東京都).
        // Osaka Metro's subway lines are legally 軌道 (class 21) too, so the tram
        // exclusion must be scoped to 東京都 — never applied operator-wide.
        let isMetro =
            metroOperatorNames.contains(op)
            && !(op == "東京都" && tramRailwayClasses.contains(cls))
        if isMetro { mask |= maskMETRO }
        // 路面電車 is its own category: every 軌道 line that is not one of the
        // metro operators'. Trams are then held OUT of 私鐵・第三部門 so the two
        // rows do not double-count each other.
        let isTram =
            tramRailwayClasses.contains(cls)
            && !isMetro
            && !tramClassHeavyRailLines.contains("\(op)|\(props.lineNameString)")
        if isTram { mask |= maskTRAM }
        if (code == "4" || code == "5") && !isMetro && !isTram { mask |= maskPRIV }
        return mask
    }

    /// Category of ONE station, classified from the line attributes its own
    /// station feature carries (both schemas repeat the line's
    /// institution/class/operator on every station). Used to hide a hidden
    /// category's STATION DOTS along with its lines.
    public static func markerCategoryForStation(
        _ props: SectionProperties?, country: String
    ) -> String? {
        guard let props else { return nil }
        if props.railwayClassCodeString.isEmpty && props.institutionTypeCodeString.isEmpty {
            return nil
        }
        return filterCategoryForMask(classifySectionMask(props, country: country), country: country)
    }

    // MARK: - JavaScript's own arithmetic


    /// `AppCore.equirectKm` — the cheap distance used for graph edge weights
    /// and every stats sum. (The route solver's haversine `distanceMeters`
    /// stays separate on purpose: a different accuracy class.)
    public static func equirectKm(
        _ ax: Double, _ ay: Double, _ bx: Double, _ by: Double
    ) -> Double {
        let kx = 111.32 * JSMath.cos(((ay + by) / 2) * Double.pi / 180)
        return JSMath.hypot((ax - bx) * kx, (ay - by) * 110.574)
    }

    /// `AppCore.edgeKey5` — a direction-independent segment key: the two
    /// 5-decimal node keys, smaller first.
    ///
    /// "Smaller" is decided NUMERICALLY on the quantised coordinates, which is
    /// what separates this from `Grid.routeCoordinateSegmentKey`'s string
    /// ordering. The two produce different keys for the same pair and are not
    /// interchangeable.
    public static func edgeKey(_ a: Coordinate, _ b: Coordinate) -> String {
        let ax = Grid.quant5(a.lon)
        let ay = Grid.quant5(a.lat)
        let bx = Grid.quant5(b.lon)
        let by = Grid.quant5(b.lat)
        let aFirst = ax < bx || (ax == bx && ay < by)
        let (px, py, qx, qy) = aFirst ? (ax, ay, bx, by) : (bx, by, ax, ay)
        return JSNumber.string(px) + "," + JSNumber.string(py)
            + "|" + JSNumber.string(qx) + "," + JSNumber.string(qy)
    }

    // MARK: - insertion-ordered collections

    /// A dictionary that remembers the order its keys were first written in.
    ///
    /// Not a convenience. Every `Map` and `Set` in app-stats.js is iterated at
    /// least once, JavaScript iterates both in insertion order, and three of
    /// those iterations decide an answer: the ridden-edge Set decides the
    /// ORDER hundreds of thousands of doubles are summed in (and therefore the
    /// last bits of the total), while the per-line operator table and the
    /// per-section bucket table are both scanned for a maximum with `>`, which
    /// keeps whichever candidate was seen first. A Swift `Dictionary` iterates
    /// in hash order and would answer differently on all three.
    public struct OrderedDictionary<Key: Hashable & Sendable, Value: Sendable>: Sendable {
        public private(set) var keys: [Key] = []
        private var storage: [Key: Value] = [:]

        public init() {}

        public subscript(key: Key) -> Value? {
            get { storage[key] }
            set {
                if let newValue {
                    if storage.updateValue(newValue, forKey: key) == nil { keys.append(key) }
                } else if storage.removeValue(forKey: key) != nil {
                    keys.removeAll { $0 == key }
                }
            }
        }

        public var count: Int { keys.count }
        public var isEmpty: Bool { keys.isEmpty }
        public var values: [Value] { keys.map { storage[$0]! } }
        public var pairs: [(key: Key, value: Value)] { keys.map { ($0, storage[$0]!) } }
    }

    // MARK: - the N02 edge index

    /// One RailroadSection: the untouched N02-25 attributes plus its geometry.
    public struct Section: Sendable {
        public var properties: SectionProperties
        public var coordinates: [Coordinate]

        public init(properties: SectionProperties, coordinates: [Coordinate]) {
            self.properties = properties
            self.coordinates = coordinates
        }
    }

    /// Decodes `rail-sections*.json` into the exact flattened line list the
    /// statistics edge-index sweep consumes. Kept in RailCore so the iOS app
    /// and parity tests do not grow separate GeoJSON readers.
    public struct SectionFeatureCollection: Decodable, Sendable {
        public let sections: [Section]

        private struct Feature: Decodable {
            let properties: SectionProperties
            let geometry: Geometry?
        }

        private struct Geometry: Decodable {
            let lines: [[Coordinate]]
            private enum CodingKeys: String, CodingKey { case type, coordinates }

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                switch try container.decode(String.self, forKey: .type) {
                case "LineString":
                    let raw = try container.decode([[Double]].self, forKey: .coordinates)
                    lines = [raw.compactMap(Coordinate.init(pair:))]
                case "MultiLineString":
                    let raw = try container.decode([[[Double]]].self, forKey: .coordinates)
                    lines = raw.map { $0.compactMap(Coordinate.init(pair:)) }
                default:
                    lines = []
                }
            }
        }

        private enum CodingKeys: String, CodingKey { case features }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let features = try container.decode([Feature].self, forKey: .features)
            sections = features.flatMap { feature in
                (feature.geometry?.lines ?? []).map {
                    Section(properties: feature.properties, coordinates: $0)
                }
            }
        }

        public static func load(contentsOf url: URL) throws -> SectionFeatureCollection {
            try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        }
    }

    /// Built once from the rail sections and reused for every stats refresh:
    /// edge key → index into parallel km/mask arrays.
    public struct EdgeIndex: Sendable {
        /// Edge key → index. This is what a ridden route's vertices are looked
        /// up by, so its spelling is as load-bearing as its values.
        public let map: [String: Int]
        public let km: [Double]
        public let mask: [Int]
        /// Line name (`N02_003`) of the FIRST feature to claim each edge, `""`
        /// when unnamed.
        public let lineName: [String]
        /// The naming feature's own category mask, so a station edge shared
        /// with a Shinkansen does not file the conventional line under 新幹線.
        public let lineMask: [Int]
        public let totalKm: Double
        public let totalsByMask: [Int: Double]
        /// Line name → per-category total km, so a line's breakdown row
        /// reflects ONLY the track it has in that category.
        public let lineTotByCat: OrderedDictionary<String, [Int: Double]>
        /// Line name → the operator owning the MOST of its track. Not the
        /// first edge's operator: a line shares the odd edge with another
        /// company at a joint station, and first-wins let that one edge label
        /// the whole line wrongly.
        public let lineOperator: OrderedDictionary<String, String>

        /// Plumbing, not a rule.
        ///
        /// `buildEdgeIndex` is the only thing that computes one of these, and
        /// it stays the only thing that decides what an edge MEANS. The
        /// memberwise initialiser is published so a client that has several
        /// regions open at once can lay their finished indexes side by side —
        /// see `EdgeIndexCache.merged` in the iOS app, which is what the
        /// all-regions statistics scope is built on. The JavaScript has one
        /// country loaded at a time and therefore never needed it, which is
        /// why this is exposed rather than ported.
        public init(
            map: [String: Int],
            km: [Double],
            mask: [Int],
            lineName: [String],
            lineMask: [Int],
            totalKm: Double,
            totalsByMask: [Int: Double],
            lineTotByCat: OrderedDictionary<String, [Int: Double]>,
            lineOperator: OrderedDictionary<String, String>
        ) {
            self.map = map
            self.km = km
            self.mask = mask
            self.lineName = lineName
            self.lineMask = lineMask
            self.totalKm = totalKm
            self.totalsByMask = totalsByMask
            self.lineTotByCat = lineTotByCat
            self.lineOperator = lineOperator
        }
    }

    // ── Mini-Shinkansen reclassification (§23a-mini) ──────────────────────
    // 山形新幹線 / 秋田新幹線 run on gauge-converted track that N02-25 STILL files
    // as 在来線 (`N02_002 = "2"`) under the plain line names 奥羽線 / 田沢湖線 —
    // there is no Shinkansen attribute to key on. 博多南線 is the same story.
    // Track that ONLY carries Shinkansen must count as 新幹線 and NOT as 在来線,
    // or the 新幹線 denominator reads ~8 points high (~285 km missing) and these
    // lines can never appear in the breakdown.
    //
    // A corridor edge is MOVED, not copied: its 在来線 bit is cleared and its
    // 新幹線 bit set — the JR全線 bit is left intact, because it is still JR
    // track. Whole-line corridors match by name; the two 奥羽線 sub-corridors
    // are traced along the 奥羽線 subgraph between their gauge-conversion
    // endpoints.
    //
    // The ~1.8 km 越後湯沢–ガーラ湯沢 spur (Shinkansen-only, filed under 上越線) is
    // deliberately NOT reclassified: no separable N02 section geometry, and
    // unridden.
    //
    // Ordered as the JavaScript `Map` literal is: the display names are seeded
    // into the hit table in this order, and applied in it.
    struct FullLineReclass: Sendable {
        let line: String
        let display: String
    }
    static let hsrReclassifyFullLines: [FullLineReclass] = [
        FullLineReclass(line: "田沢湖線", display: "秋田新幹線"),  // 盛岡–大曲, ~75.6 km
        FullLineReclass(line: "博多南線", display: "博多南線"),  // 博多–博多南, ~8.9 km
    ]
    static let hsrReclassifyOuLine = "奥羽線"
    struct OuCorridor: Sendable {
        let display: String
        let from: Coordinate
        let to: Coordinate
    }
    static let hsrReclassifyOuCorridors: [OuCorridor] = [
        // 山形新幹線: 奥羽線 福島(001373) – 新庄(001004), ~148.6 km
        OuCorridor(
            display: "山形新幹線", from: Coordinate(lon: 140.45972, lat: 37.75341),
            to: Coordinate(lon: 140.3059, lat: 38.76386)),
        // 秋田新幹線: 奥羽線 大曲(000854) – 秋田(000783), ~51.7 km (盛岡–大曲 is 田沢湖線)
        OuCorridor(
            display: "秋田新幹線", from: Coordinate(lon: 140.47996, lat: 39.46546),
            to: Coordinate(lon: 140.12947, lat: 39.71836)),
    ]

    /// `buildStatsEdgeIndexSliced`, minus the slicing.
    ///
    /// The JavaScript is `async` only so that this sweep — several hundred
    /// thousand edges — parks every 12 ms instead of freezing the tab the
    /// moment the 統計 panel opens. Nothing about the result depends on where
    /// it parks, so the port is synchronous and the caller decides where it runs.
    public static func buildEdgeIndex(sections: [Section], country: String) -> EdgeIndex {
        var map: [String: Int] = [:]
        var kmArr: [Double] = []
        var maskArr: [Int] = []
        var lineArr: [String] = []
        var lineMaskArr: [Int] = []
        var lineOpArr: [String] = []

        // Reclassification accumulators, applied after the full pass. Every
        // edge is recorded against the CURRENT feature's line name (not the
        // first-wins lineArr), so a corridor edge co-located with another line
        // is still captured.
        var hsrFullHits = OrderedDictionary<String, [Int]>()
        var hsrFullSeen: [String: Set<Int>] = [:]
        for entry in hsrReclassifyFullLines where hsrFullHits[entry.display] == nil {
            hsrFullHits[entry.display] = []
            hsrFullSeen[entry.display] = []
        }
        var ouAdj: [String: [(node: String, edge: Int)]] = [:]
        var ouNodeXY = OrderedDictionary<String, Coordinate>()

        for section in sections {
            let props = section.properties
            let coords = section.coordinates
            let mask = classifySectionMask(props, country: country)
            let lineName = props.lineNameString
            let operatorName = props.operatorString
            let fullReclass = hsrReclassifyFullLines.first { $0.line == lineName }?.display
            let isOuLine = lineName == hsrReclassifyOuLine

            guard coords.count >= 2 else { continue }
            for i in 1..<coords.count {
                let a = coords[i - 1]
                let b = coords[i]
                let key = edgeKey(a, b)
                let ei: Int
                if let existing = map[key] {
                    ei = existing
                    maskArr[ei] |= mask
                    if lineArr[ei].isEmpty && !lineName.isEmpty {
                        lineArr[ei] = lineName
                        lineMaskArr[ei] = mask
                        lineOpArr[ei] = operatorName
                    }
                } else {
                    ei = kmArr.count
                    map[key] = ei
                    kmArr.append(equirectKm(a.lon, a.lat, b.lon, b.lat))
                    maskArr.append(mask)
                    lineArr.append(lineName)
                    lineMaskArr.append(lineName.isEmpty ? 0 : mask)
                    lineOpArr.append(lineName.isEmpty ? "" : operatorName)
                }

                if let fullReclass {
                    if hsrFullSeen[fullReclass]!.insert(ei).inserted {
                        hsrFullHits[fullReclass]!.append(ei)
                    }
                } else if isOuLine {
                    let ka = Grid.coordKey(a)
                    let kb = Grid.coordKey(b)
                    if ouNodeXY[ka] == nil {
                        ouNodeXY[ka] = Coordinate(lon: Grid.quant5(a.lon), lat: Grid.quant5(a.lat))
                    }
                    if ouNodeXY[kb] == nil {
                        ouNodeXY[kb] = Coordinate(lon: Grid.quant5(b.lon), lat: Grid.quant5(b.lat))
                    }
                    ouAdj[ka, default: []].append((kb, ei))
                    ouAdj[kb, default: []].append((ka, ei))
                }
            }
        }

        // Apply the reclassification BEFORE totals are summed, so the 新幹線 /
        // 在來線 denominators and the per-line breakdown all reflect it.
        func applyHsrCorridorOverride(_ ei: Int, _ display: String) {
            maskArr[ei] = (maskArr[ei] & ~maskCONV) | maskHSR
            lineArr[ei] = display
            lineMaskArr[ei] = maskHSR | maskJR
        }
        for (display, edges) in hsrFullHits.pairs {
            for ei in edges { applyHsrCorridorOverride(ei, display) }
        }
        for corridor in hsrReclassifyOuCorridors {
            guard
                let from = snapToNearestNode(corridor.from, ouNodeXY),
                let to = snapToNearestNode(corridor.to, ouNodeXY)
            else { continue }
            for ei in traceCorridorEdges(ouAdj, kmArr, from, to) {
                applyHsrCorridorOverride(ei, corridor.display)
            }
        }

        var totalKm = 0.0
        var totalsByMask: [Int: Double] = [:]
        let cats = categories(country: country)
        for category in cats { totalsByMask[category.mask] = 0 }
        var lineTotByCat = OrderedDictionary<String, [Int: Double]>()
        var lineOpKm = OrderedDictionary<String, OrderedDictionary<String, Double>>()

        for i in 0..<kmArr.count {
            totalKm += kmArr[i]
            let km = kmArr[i]
            let m = maskArr[i]
            for category in cats where m & category.mask != 0 {
                totalsByMask[category.mask]! += km
            }
            let ln = lineArr[i]
            guard !ln.isEmpty else { continue }
            let lm = lineMaskArr[i]
            var byCat = lineTotByCat[ln] ?? zeroCategoryKm(country: country)
            for category in cats where lm & category.mask != 0 {
                byCat[category.mask]! += km
            }
            lineTotByCat[ln] = byCat
            let op = lineOpArr[i]
            guard !op.isEmpty else { continue }
            var byOp = lineOpKm[ln] ?? OrderedDictionary<String, Double>()
            byOp[op] = (byOp[op] ?? 0) + km
            lineOpKm[ln] = byOp
        }

        // Resolve each line to its majority-km operator. The scan keeps the
        // FIRST candidate at the maximum, so the insertion order of byOp is
        // the tie-break.
        var lineOperator = OrderedDictionary<String, String>()
        for (line, byOp) in lineOpKm.pairs {
            var best = ""
            var bestKm = -1.0
            for (op, value) in byOp.pairs where value > bestKm {
                bestKm = value
                best = op
            }
            if !best.isEmpty { lineOperator[line] = best }
        }

        return EdgeIndex(
            map: map, km: kmArr, mask: maskArr, lineName: lineArr, lineMask: lineMaskArr,
            totalKm: totalKm, totalsByMask: totalsByMask,
            lineTotByCat: lineTotByCat, lineOperator: lineOperator)
    }

    /// Zero km accumulator keyed by category mask, for per-line-per-category sums.
    public static func zeroCategoryKm(country: String) -> [Int: Double] {
        var out: [Int: Double] = [:]
        for category in categories(country: country) { out[category.mask] = 0 }
        return out
    }

    /// Nearest subgraph node to an endpoint (station) coordinate, so a
    /// corridor snaps onto its line even when the station point is not itself
    /// a graph vertex. `nil` when the subgraph is empty.
    static func snapToNearestNode(
        _ coord: Coordinate, _ nodeXY: OrderedDictionary<String, Coordinate>
    ) -> String? {
        let x = Grid.quant5(coord.lon)
        let y = Grid.quant5(coord.lat)
        var best: String? = nil
        var bestKm = Double.infinity
        for (key, node) in nodeXY.pairs {
            let d = equirectKm(x, y, node.lon, node.lat)
            if d < bestKm {
                bestKm = d
                best = key
            }
        }
        return best
    }

    /// Minimal binary min-heap over `(priority, value)` tuples — `AppCore`'s
    /// shared heap, ported comparison for comparison because equal priorities
    /// are ordinary here and the pop order they resolve to decides which
    /// predecessor a node keeps.
    struct TupleMinHeap {
        private var items: [(priority: Double, value: String)] = []
        var size: Int { items.count }

        mutating func push(_ priority: Double, _ value: String) {
            items.append((priority, value))
            var i = items.count - 1
            while i > 0 {
                let p = (i - 1) >> 1
                if items[p].priority <= items[i].priority { break }
                items.swapAt(p, i)
                i = p
            }
        }

        mutating func pop() -> (priority: Double, value: String) {
            let top = items[0]
            let last = items.removeLast()
            if !items.isEmpty {
                items[0] = last
                var i = 0
                let n = items.count
                while true {
                    let l = 2 * i + 1
                    let r = l + 1
                    var s = i
                    if l < n && items[l].priority < items[s].priority { s = l }
                    if r < n && items[r].priority < items[s].priority { s = r }
                    if s == i { break }
                    items.swapAt(s, i)
                    i = s
                }
            }
            return top
        }
    }

    /// Dijkstra shortest path between two nodes of a single-line subgraph,
    /// returned as the edge indices it traverses.
    static func traceCorridorEdges(
        _ adj: [String: [(node: String, edge: Int)]], _ kmArr: [Double],
        _ fromKey: String, _ toKey: String
    ) -> [Int] {
        var edges: [Int] = []
        var seen = Set<Int>()
        if fromKey == toKey || adj[fromKey] == nil || adj[toKey] == nil { return edges }
        var dist: [String: Double] = [fromKey: 0]
        var prev: [String: (node: String, edge: Int)] = [:]
        var heap = TupleMinHeap()
        heap.push(0, fromKey)
        while heap.size > 0 {
            let (d, u) = heap.pop()
            if u == toKey { break }
            if d > (dist[u] ?? .infinity) { continue }
            for (v, ei) in adj[u] ?? [] {
                let nd = d + kmArr[ei]
                if nd < (dist[v] ?? .infinity) {
                    dist[v] = nd
                    prev[v] = (u, ei)
                    heap.push(nd, v)
                }
            }
        }
        var cur = toKey
        while let step = prev[cur] {
            if seen.insert(step.edge).inserted { edges.append(step.edge) }
            cur = step.node
        }
        return edges
    }

    // MARK: - walking one train onto the index

    /// One matched route feature, reduced to what the walk reads.
    public struct RouteFeature: Sendable {
        /// LineString → one entry; MultiLineString → one per part. Any other
        /// geometry type leaves this empty and is walked over in silence,
        /// exactly as the JavaScript's two-branch `if` does.
        public var lines: [[Coordinate]]
        /// Whether the feature carried a geometry object at all.
        ///
        /// This is not the same question as "does it have any lines". The
        /// JavaScript drops a feature with no geometry BEFORE the ride check,
        /// so such a feature contributes no ridden SECTION either — while a
        /// Point geometry survives that guard and does record a section, with
        /// zero km and bucket 0. Folding the two together would invent a
        /// section that the panel never shows.
        public var hasGeometry: Bool
        /// Must be **exactly** `true` to count. The JavaScript tests
        /// `properties.ride_segment !== true`, so `1` and `"true"` are unridden.
        public var rideSegment: Bool
        public var from: String?
        public var to: String?

        public init(
            lines: [[Coordinate]], hasGeometry: Bool = true, rideSegment: Bool,
            from: String?, to: String?
        ) {
            self.lines = lines
            self.hasGeometry = hasGeometry
            self.rideSegment = rideSegment
            self.from = from
            self.to = to
        }
    }

    /// One matched route feature = one station-to-station ridden interval,
    /// which is the unit the 最常乘坐區間 section counts.
    public struct RiddenSection: Sendable {
        public var from: String
        public var to: String
        public var km: Double
        public var bucket: Int
        /// Sorted ascending so containment can be tested as a set-subset.
        public var edgeIds: [Int]

        public init(from: String, to: String, km: Double, bucket: Int, edgeIds: [Int]) {
            self.from = from
            self.to = to
            self.km = km
            self.bucket = bucket
            self.edgeIds = edgeIds
        }
    }

    public struct Span: Sendable {
        public var key: String
        public var km: Double
        public var mask: Int

        public init(key: String, km: Double, mask: Int) {
            self.key = key
            self.km = km
            self.mask = mask
        }
    }

    public struct TrainEntry: Sendable {
        public var edges: [Int]
        public var spans: [Span]
        /// This train's OWN cumulative ridden distance — repeat sections count
        /// each time, because this pairs with ride time and ride count in the
        /// service-type rows, unlike the deduped network-coverage sums.
        public var km: Double
        public var segments: [RiddenSection]

        public init(edges: [Int] = [], spans: [Span] = [], km: Double = 0,
                    segments: [RiddenSection] = []) {
            self.edges = edges
            self.spans = spans
            self.km = km
            self.segments = segments
        }
    }

    static let maxBridgeKm = 4.0

    /// Walk ONE train's ridden geometry onto the edge index.
    ///
    /// Anchor-merge walk: the route solver densifies some N02 edges with
    /// interpolated points (station snaps, long-edge subdivision), so a naive
    /// pair-by-pair lookup misses them. Keep the last on-network anchor and try
    /// (anchor → current) at every vertex — a subdivided N02 edge re-matches as
    /// soon as the walk reaches its far endpoint. Off-network connector spans
    /// are recorded with the category mask of the edge they reconnect to
    /// (mask 0 = truly unattributable).
    public static func collectTrainStatsEntry(
        features: [RouteFeature], index: EdgeIndex
    ) -> TrainEntry {
        var edges: [Int] = []
        var spans: [Span] = []
        var segments: [RiddenSection] = []

        func recordSpan(_ from: Coordinate, _ to: Coordinate, _ km: Double, _ mask: Int) {
            if km > 0 { spans.append(Span(key: edgeKey(from, to), km: km, mask: mask)) }
        }

        func walk(_ coords: [Coordinate]) {
            guard coords.count >= 2 else { return }
            var anchor = coords[0]
            // Category of the edge the anchor most recently reached. The
            // display network deliberately finishes a station interval at
            // the station anchor, which can sit a short connector away from
            // the raw section edge. A leading connector already inherits the
            // edge it reconnects to below; keeping this makes the trailing
            // connector inherit the edge it just left, symmetrically.
            var anchorMask = 0
            var pendingKm = 0.0
            for i in 1..<coords.count {
                let prev = coords[i - 1]
                let v = coords[i]
                if anchor.lon == v.lon && anchor.lat == v.lat { continue }
                if let e = index.map[edgeKey(anchor, v)] {
                    edges.append(e)
                    anchor = v
                    anchorMask = index.mask[e]
                    pendingKm = 0  // pending hops were interior to this matched edge
                    continue
                }
                if let e2 = index.map[edgeKey(prev, v)] {
                    recordSpan(anchor, prev, pendingKm, index.mask[e2])
                    edges.append(e2)
                    anchor = v
                    anchorMask = index.mask[e2]
                    pendingKm = 0
                    continue
                }
                pendingKm += equirectKm(prev.lon, prev.lat, v.lon, v.lat)
                if pendingKm > maxBridgeKm {
                    recordSpan(anchor, v, pendingKm, 0)
                    anchor = v
                    anchorMask = 0
                    pendingKm = 0
                } else if i == coords.count - 1 {
                    recordSpan(anchor, v, pendingKm, anchorMask)
                    anchor = v
                    pendingKm = 0
                }
            }
        }

        for feature in features {
            guard feature.hasGeometry else { continue }
            guard feature.rideSegment else { continue }
            // Remember where this feature's contribution starts so its own km
            // and category mask can be summed back out of the shared
            // accumulators.
            let edgeStart = edges.count
            let spanStart = spans.count
            for line in feature.lines { walk(line) }

            guard let from = feature.from, let to = feature.to, from != to else { continue }
            var segKm = 0.0
            // Attribute the section to the mode carrying the MOST of its
            // distance. OR-ing every edge's mask instead would file a JR
            // section under 私鐵 and 地下鐵 the moment its geometry clipped one
            // parallel edge in a dense terminal area — which is what it used
            // to do.
            var kmByBucket = OrderedDictionary<Int, Double>()
            func addKm(_ mask: Int, _ km: Double) {
                let b = exclusiveTrackBucket(mask)
                kmByBucket[b] = (kmByBucket[b] ?? 0) + km
            }
            for i in edgeStart..<edges.count {
                segKm += index.km[edges[i]]
                addKm(index.mask[edges[i]], index.km[edges[i]])
            }
            for i in spanStart..<spans.count {
                segKm += spans[i].km
                if spans[i].mask != 0 { addKm(spans[i].mask, spans[i].km) }
            }
            var bucket = 0
            var bestKm = -1.0
            for (b, km) in kmByBucket.pairs where km > bestKm {
                bestKm = km
                bucket = b
            }
            // Edge ids are the unit of "same track": two intervals that share
            // none cannot contain one another, which is what keeps 新幹線 from
            // swallowing the 在來線 running beside it.
            let segEdges = edges[edgeStart...].sorted()
            segments.append(
                RiddenSection(from: from, to: to, km: segKm, bucket: bucket, edgeIds: segEdges))
        }

        var km = 0.0
        for e in edges { km += index.km[e] }
        for span in spans { km += span.km }
        return TrainEntry(edges: edges, spans: spans, km: km, segments: segments)
    }

    // MARK: - aggregation

    public struct MileageStats: Sendable {
        public var riddenAll: Double
        public var riddenByMask: [Int: Double]
        public var unmatchedKm: Double
        /// Deduped ridden km per line, split by category — the same ridden
        /// edge Set as the category sums.
        public var lineRidByCat: OrderedDictionary<String, [Int: Double]>
        public var rideMinutes: Double = 0
        public var services: ServiceGroups = ServiceGroups()
        public var topSegments: TopSegments? = nil
    }

    /// The deduped union. **This is the function the whole panel means.**
    ///
    /// Every entry's edge ids go into one Set, and `idx.km` is summed over that
    /// Set once. The order that Set is iterated in is JavaScript insertion
    /// order and it is load-bearing: floating-point addition is not
    /// associative, so the same edges summed in a different order give a total
    /// that differs in its last bits. Measured on the fixture's own cases,
    /// listing the same rides in reverse order moves `riddenAll` by 1 ULP —
    /// which is why the ridden set is kept as an array plus a membership set
    /// rather than as a `Set`.
    public static func aggregateMileageStats(
        index: EdgeIndex, entries: [TrainEntry], country: String
    ) -> MileageStats {
        var riddenOrder: [Int] = []
        var riddenSeen = Set<Int>()
        var extraSpans = OrderedDictionary<String, (km: Double, mask: Int)>()
        for entry in entries {
            for e in entry.edges where riddenSeen.insert(e).inserted { riddenOrder.append(e) }
            for span in entry.spans {
                if let current = extraSpans[span.key] {
                    // A repeat ride of the same connector only ORs its mask in;
                    // the km is counted once.
                    extraSpans[span.key] = (current.km, current.mask | span.mask)
                } else {
                    extraSpans[span.key] = (span.km, span.mask)
                }
            }
        }

        var riddenAll = 0.0
        var unmatchedKm = 0.0
        let cats = categories(country: country)
        var riddenByMask: [Int: Double] = [:]
        for category in cats { riddenByMask[category.mask] = 0 }
        var lineRidByCat = OrderedDictionary<String, [Int: Double]>()

        for e in riddenOrder {
            riddenAll += index.km[e]
            let km = index.km[e]
            let m = index.mask[e]
            for category in cats where m & category.mask != 0 {
                riddenByMask[category.mask]! += km
            }
            let ln = index.lineName[e]
            guard !ln.isEmpty else { continue }
            let lm = index.lineMask[e]
            var byCat = lineRidByCat[ln] ?? zeroCategoryKm(country: country)
            for category in cats where lm & category.mask != 0 { byCat[category.mask]! += km }
            lineRidByCat[ln] = byCat
        }

        // Connector spans: counted nationally, attributed to their reconnect
        // category when known; the mask-0 remainder is reported as unmatchedKm.
        for span in extraSpans.values {
            riddenAll += span.km
            if span.mask == 0 {
                unmatchedKm += span.km
                continue
            }
            for category in cats where span.mask & category.mask != 0 {
                riddenByMask[category.mask]! += span.km
            }
        }

        return MileageStats(
            riddenAll: riddenAll, riddenByMask: riddenByMask,
            unmatchedKm: unmatchedKm, lineRidByCat: lineRidByCat)
    }

    // MARK: - ride time

    /// One stop, reduced to what the ride rules read.
    public struct Stop: Sendable {
        public var arrival: String?
        public var departure: String?
        public var stopType: String?
        /// Must be exactly `true`; anything else — including a truthy `1` —
        /// is unridden, so this is decoded strictly and not coerced.
        public var rideSegment: Bool

        public init(arrival: String? = nil, departure: String? = nil,
                    stopType: String? = nil, rideSegment: Bool = false) {
            self.arrival = arrival
            self.departure = departure
            self.stopType = stopType
            self.rideSegment = rideSegment
        }
    }

    public struct Train: Sendable {
        public var id: String
        public var trainType: String?
        public var date: String?
        public var stops: [Stop]

        public init(id: String = "", trainType: String? = nil, date: String? = nil,
                    stops: [Stop] = []) {
            self.id = id
            self.trainType = trainType
            self.date = date
            self.stops = stops
        }
    }

    // The ride-flag rules live in app-editor.js, next to the editor that
    // toggles them; they are reproduced here because trainRideMinutes cannot
    // be ported without them. A pass-through (非停車站) is NOT individually
    // toggleable: it inherits the ride state of the stop-to-stop interval it
    // lies in, so hiding an interval hides every pass-through inside it.
    public static func isStoppingStation(_ stop: Stop) -> Bool {
        stop.stopType != "pass_through"
    }

    /// Public because the map draws from it too: a marker for a station the
    /// reader did not ride is a claim about the journey they did not make.
    /// It was mirrored into the app target while it was internal, and two
    /// copies of a rule are one bug waiting.
    public static func effectiveStopRide(_ stops: [Stop], _ index: Int) -> Bool {
        guard index >= 0, index < stops.count else { return false }
        let stop = stops[index]
        if isStoppingStation(stop) { return stop.rideSegment }
        let prev = (0..<index).last { isStoppingStation(stops[$0]) } ?? -1
        let next = ((index + 1)..<stops.count).first { isStoppingStation(stops[$0]) } ?? -1
        if prev < 0 || next < 0 { return stop.rideSegment }
        return stops[prev].rideSegment && stops[next].rideSegment
    }

    /// Ordered indexes of a train's effectively-ridden STOPPING stations
    /// (pass-throughs excluded). First and last entry are the ride boundary pair.
    public static func effectivelyRiddenStopIndexes(_ stops: [Stop]) -> [Int] {
        stops.indices.filter { stops[$0].stopType != "pass_through" && effectiveStopRide(stops, $0) }
    }

    /// Whether the route feature between `index` and `index + 1` is ridden.
    public static func isRideSegment(_ stops: [Stop], segmentIndex: Int) -> Bool {
        effectiveStopRide(stops, segmentIndex) && effectiveStopRide(stops, segmentIndex + 1)
    }

    /// Ride TIME of one train: first effectively-ridden stopping station's
    /// departure → last one's arrival, falling back to the other field when one
    /// is missing. `nil` = no usable times.
    ///
    /// A plain end-before-start wraps overnight; the `"+1"` day offsets are
    /// already folded in by `parseTimeToMinutes`, so they do not wrap twice.
    public static func trainRideMinutes(_ train: Train) -> Double? {
        let stops = train.stops
        let ridden = effectivelyRiddenStopIndexes(stops)
        guard ridden.count >= 2 else { return nil }
        let first = stops[ridden[0]]
        let last = stops[ridden[ridden.count - 1]]
        guard
            let start = Dates.parseTimeToMinutes(first.departure)
                ?? Dates.parseTimeToMinutes(first.arrival),
            var end = Dates.parseTimeToMinutes(last.arrival)
                ?? Dates.parseTimeToMinutes(last.departure)
        else { return nil }
        if end < start { end += 24 * 60 }
        return end - start
    }

    public static func sumRideMinutes(_ trains: [Train]) -> Double {
        var total = 0.0
        for train in trains { if let m = trainRideMinutes(train) { total += m } }
        return total
    }

    // MARK: - service-type rows

    public struct ServiceGroup: Sendable, Equatable {
        public var km: Double = 0
        public var minutes: Double = 0
        public var count: Int = 0
    }

    public struct ServiceGroups: Sendable, Equatable {
        public var hsr = ServiceGroup()
        public var ltd = ServiceGroup()
        public var other = ServiceGroup()
    }

    /// The three buckets are the same everywhere — high speed, the
    /// reserved-seat premium tier, everything else — but the service names that
    /// identify them are a country's own vocabulary, so the matching is per
    /// country. Every country other than Taiwan falls through to Japan's words.
    public static func serviceGroupOfTrain(trainType: String?, country: String) -> String {
        let t = trainType ?? ""
        if country == "tw" {
            // 高鐵 is Taiwan's high-speed service; 對號列車 (自強 — including 太魯閣
            // and 普悠瑪 — and 莒光) is the reserved-seat tier 有料特急 corresponds to.
            if containsAny(t, ["高鐵", "高铁"]) { return "hsr" }
            if containsAny(
                t, ["自強", "自强", "太魯閣", "太鲁阁", "普悠瑪", "普悠玛", "莒光", "對號", "对号"])
            { return "ltd" }
            return "other"
        }
        if contains(t, "新幹線") { return "hsr" }
        if contains(t, "特急") { return "ltd" }
        return "other"
    }

    /// `String.prototype.includes` — a search over UTF-16 code units.
    ///
    /// Swift's own `contains` matches by canonical equivalence, so a
    /// precomposed needle would find a decomposed haystack that JavaScript
    /// would miss. Train types are user-entered text, so the difference is
    /// reachable and the code-unit search is the faithful one.
    static func contains(_ haystack: String, _ needle: String) -> Bool {
        let h = Array(haystack.utf16)
        let n = Array(needle.utf16)
        if n.isEmpty { return true }
        if n.count > h.count { return false }
        for start in 0...(h.count - n.count) {
            var match = true
            for i in 0..<n.count where h[start + i] != n[i] {
                match = false
                break
            }
            if match { return true }
        }
        return false
    }

    static func containsAny(_ haystack: String, _ needles: [String]) -> Bool {
        needles.contains { contains(haystack, $0) }
    }

    public static func serviceGroupStats(
        trains: [Train], entries: [TrainEntry], country: String
    ) -> ServiceGroups {
        var groups = ServiceGroups()
        for i in trains.indices {
            let name = serviceGroupOfTrain(trainType: trains[i].trainType, country: country)
            var group = name == "hsr" ? groups.hsr : name == "ltd" ? groups.ltd : groups.other
            group.km += i < entries.count ? entries[i].km : 0
            if let m = trainRideMinutes(trains[i]) { group.minutes += m }
            group.count += 1
            if name == "hsr" { groups.hsr = group } else if name == "ltd" {
                groups.ltd = group
            } else {
                groups.other = group
            }
        }
        return groups
    }

    // MARK: - most-ridden sections

    public struct TopRow: Sendable {
        public var from: String
        public var to: String
        public var count: Int
        public var km: Double
        public var bucket: Int
        public var edgeIds: [Int]

        public init(from: String, to: String, count: Int, km: Double, bucket: Int,
                    edgeIds: [Int]) {
            self.from = from
            self.to = to
            self.count = count
            self.km = km
            self.bucket = bucket
            self.edgeIds = edgeIds
        }
    }

    public struct TopSegments: Sendable {
        public struct Bucket: Sendable {
            public var mask: Int
            public var rows: [TopRow]
        }
        /// One row lands in exactly one mode, keyed by the country's own
        /// category masks and listed in its category order.
        public var byMask: [Bucket]
        public var all: [TopRow]
    }

    public static func topRiddenSegments(
        entries: [TrainEntry], country: String
    ) -> TopSegments {
        var acc = OrderedDictionary<String, TopRow>()
        for entry in entries {
            for sg in entry.segments {
                let key = sortedPairKey(sg.from, sg.to)
                if var current = acc[key] {
                    current.count += 1
                    // Keep the longest measurement: a partially-solved repeat
                    // ride must not shrink the section's recorded length. The
                    // best-measured ride also decides the mode, and its edges
                    // define the section's extent.
                    if sg.km > current.km {
                        current.km = sg.km
                        current.bucket = sg.bucket
                        current.edgeIds = sg.edgeIds
                    }
                    acc[key] = current
                } else {
                    acc[key] = TopRow(
                        from: sg.from, to: sg.to, count: 1, km: sg.km,
                        bucket: sg.bucket, edgeIds: sg.edgeIds)
                }
            }
        }

        let cats = categories(country: country)
        var byMaskRows: [Int: [TopRow]] = [:]
        for category in cats { byMaskRows[category.mask] = [] }
        var all: [TopRow] = []
        for row in acc.values {
            all.append(row)
            if byMaskRows[row.bucket] != nil { byMaskRows[row.bucket]!.append(row) }
        }

        let byMask = cats.map { category in
            TopSegments.Bucket(
                mask: category.mask,
                rows: dropContainedSections(stableSortByRides(byMaskRows[category.mask]!)))
        }
        return TopSegments(byMask: byMask, all: dropContainedSections(stableSortByRides(all)))
    }

    /// `[from, to].sort().join("\u{0}")`.
    ///
    /// `Array.prototype.sort` with no comparator orders by UTF-16 code unit,
    /// not by Swift's canonical-equivalence `<`. Station names are the strings
    /// being compared, so the difference is reachable in real data.
    static func sortedPairKey(_ a: String, _ b: String) -> String {
        let ordered = utf16LessOrEqual(a, b) ? (a, b) : (b, a)
        return ordered.0 + "\u{0}" + ordered.1
    }

    static func utf16LessOrEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf16)
        let y = Array(b.utf16)
        for i in 0..<Swift.min(x.count, y.count) {
            if x[i] != y[i] { return x[i] < y[i] }
        }
        return x.count <= y.count
    }

    /// `rows.sort((a, b) => b.count - a.count || b.km - a.km)`.
    ///
    /// `Array.prototype.sort` is required to be stable, and Swift's `sorted`
    /// is not, so the original position is carried as the final tie-break.
    /// This is not cosmetic: `dropContainedSections` walks the sorted list and
    /// keeps whichever section it reaches first, so a reordering of two
    /// equal-ranking rows changes which section a reader is shown.
    static func stableSortByRides(_ rows: [TopRow]) -> [TopRow] {
        rows.enumerated()
            .sorted { l, r in
                if l.element.count != r.element.count { return l.element.count > r.element.count }
                if l.element.km != r.element.km { return l.element.km > r.element.km }
                return l.offset < r.offset
            }
            .map(\.element)
    }

    /// True when every edge of `inner` also appears in `outer` — i.e. `inner`
    /// is a stretch of the very same track. Both arrays are sorted ascending,
    /// so this is a linear merge rather than a Set build per comparison.
    public static func isEdgeSubset(_ inner: [Int], _ outer: [Int]) -> Bool {
        if inner.isEmpty || outer.isEmpty || inner.count > outer.count { return false }
        var j = 0
        for want in inner {
            while j < outer.count && outer[j] < want { j += 1 }
            if j >= outer.count || outer[j] != want { return false }
            j += 1
        }
        return true
    }

    /// Riding A→D necessarily rides B→C inside it, so listing both says the
    /// same trip twice. Walking the already ride-sorted list and dropping any
    /// section contained in one ALREADY KEPT means the longer section wins only
    /// when it is ridden at least as often; a short section ridden more than
    /// the long one it sits inside still ranks first and keeps the long one as
    /// a separate entry.
    ///
    /// The bucket check is belt-and-braces on top of the edge test: sections of
    /// different modes never share edges anyway.
    public static func dropContainedSections(_ rows: [TopRow]) -> [TopRow] {
        var kept: [TopRow] = []
        for row in rows {
            var contained = false
            for k in kept where k.bucket == row.bucket && isEdgeSubset(row.edgeIds, k.edgeIds) {
                contained = true
                break
            }
            if !contained { kept.append(row) }
        }
        return kept
    }

    // MARK: - the view model

    public struct DailyStats: Sendable {
        public var date: String
        public var trainCount: Int
        public var stats: MileageStats
    }

    public struct MileageStatsView: Sendable {
        public var overall: MileageStats
        public var daily: DailyStats?
        public var categories: [Category]
    }

    public static let allDates = "__all__"

    /// The all-time aggregate plus, when a concrete date bucket is active,
    /// that day's own km/time aggregate computed from the SAME per-train entries.
    ///
    /// `trainDate` and `dateLabel` are parameters rather than calls: the first
    /// is app-dates.js's business and the second resolves through I18N, i.e.
    /// presentation. The JavaScript's `yieldPoint` has no analogue — it exists
    /// to keep a browser tab responsive between phases, and parking somewhere
    /// else cannot change an answer.
    public static func buildMileageStatsView(
        index: EdgeIndex,
        trains: [Train],
        entries: [TrainEntry],
        country: String,
        selectedDate: String?,
        trainDate: (Train) -> String,
        dateLabel: (String) -> String
    ) -> MileageStatsView {
        var overall = aggregateMileageStats(index: index, entries: entries, country: country)
        overall.rideMinutes = sumRideMinutes(trains)
        overall.services = serviceGroupStats(trains: trains, entries: entries, country: country)
        overall.topSegments = topRiddenSegments(entries: entries, country: country)

        var daily: DailyStats? = nil
        if let selectedDate, selectedDate != allDates {
            var dayTrains: [Train] = []
            var dayEntries: [TrainEntry] = []
            for (i, train) in trains.enumerated() where trainDate(train) == selectedDate {
                dayTrains.append(train)
                if i < entries.count { dayEntries.append(entries[i]) }
            }
            var stats = aggregateMileageStats(
                index: index, entries: dayEntries, country: country)
            stats.rideMinutes = sumRideMinutes(dayTrains)
            stats.services = serviceGroupStats(
                trains: dayTrains, entries: dayEntries, country: country)
            daily = DailyStats(
                date: dateLabel(selectedDate), trainCount: dayTrains.count, stats: stats)
        }
        return MileageStatsView(
            overall: overall, daily: daily, categories: categories(country: country))
    }

    // MARK: - the ridden-line display filter

    /// Category of ONE ridden route feature, by dominant km over the same N02
    /// edge index the mileage stats use.
    ///
    /// `nil` means undetermined — either the feature has no line geometry, or
    /// none of it matched the network. The render tier keeps an undetermined
    /// feature visible rather than guessing, which is also what it does while
    /// the network is still loading and there is no index at all.
    public static func riddenFeatureCategory(
        _ feature: RouteFeature, index: EdgeIndex, country: String
    ) -> String? {
        var km: [String: Double] = ["hsr": 0, "jr": 0, "metro": 0, "priv": 0]
        for line in feature.lines {
            guard line.count >= 2 else { continue }
            for i in 1..<line.count {
                guard let e = index.map[edgeKey(line[i - 1], line[i])] else { continue }
                km[filterCategoryForMask(index.mask[e], country: country)]! += index.km[e]
            }
        }
        var best: String? = nil
        var bestKm = 0.0
        // Not the order the km object was built in: hsr, metro, jr, priv, so a
        // tie goes to the more specific mode.
        for c in ["hsr", "metro", "jr", "priv"] where km[c]! > bestKm {
            bestKm = km[c]!
            best = c
        }
        return best
    }

    /// The four checkboxes that hide/show RIDDEN route lines by category.
    /// Unridden intervals and the 全部鐵路線 network overlay are untouched.
    public struct RiddenCategoryFilter: Sendable, Equatable {
        public var hsr = true
        public var jr = true
        public var metro = true
        public var priv = true

        public init(hsr: Bool = true, jr: Bool = true, metro: Bool = true, priv: Bool = true) {
            self.hsr = hsr
            self.jr = jr
            self.metro = metro
            self.priv = priv
        }

        public subscript(category: String) -> Bool {
            switch category {
            case "hsr": return hsr
            case "jr": return jr
            case "metro": return metro
            case "priv": return priv
            default: return true  // an unknown key is `undefined !== false`
            }
        }

        public var anyHidden: Bool { !hsr || !jr || !metro || !priv }
    }

    public static func riddenFeatureVisible(
        _ feature: RouteFeature, index: EdgeIndex?, country: String,
        filter: RiddenCategoryFilter
    ) -> Bool {
        // Read-only: NEVER build the (expensive) edge index from the render
        // path. Until the stats job has built it, everything stays visible.
        guard let index,
            let category = riddenFeatureCategory(feature, index: index, country: country)
        else { return true }
        return filter[category]
    }
}
