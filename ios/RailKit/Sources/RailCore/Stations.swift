import Foundation

/// The route-specific preferences `configureStationRouteResolver` injects into
/// `app-stations.js`.
///
/// The three functions behind this seam live in the route modules, not here.
/// This port owns only *when* each is consulted and what wins when one comes
/// back empty — which is why the seam stays a seam instead of becoming three
/// more ported functions.
public protocol StationRouteResolver {
    /// nil is the JavaScript's `null`; an EMPTY ARRAY is not the same thing.
    /// `null` skips the preference filter entirely, while `[]` is truthy and
    /// does call it — with no codes to prefer, so it keeps everything. The two
    /// reach the same pool by different routes, and only one of them consults
    /// the filter.
    func allowedInstitutionCodes(_ train: Stations.Train) -> [String]?

    /// The positions of the candidates worth preferring, within the array
    /// given. The JavaScript returns the feature objects; a Swift struct has no
    /// identity, so positions carry the same information.
    func filterPreferredStations(_ candidates: [Stations.Feature], allowedCodes: [String]) -> [Int]

    func distanceMeters(_ a: [Double], _ b: [Double]) -> Double
}

/// Station resolution — ported from `app-stations.js`, with
/// `normalizeStationName` from `shared/app-core.js`.
///
/// This is the step that turns a name somebody wrote in an itinerary into a
/// feature in the network. Everything after it — the route solve, the mileage
/// totals, the marker a passenger taps — is built on whichever feature came
/// back, so a resolution that differs by one candidate is not a cosmetic
/// difference, it is a different journey.
///
/// **Why this file re-implements string comparison.** The whole of resolution
/// is a lookup by whole string, and JavaScript compares strings by UTF-16 code
/// unit. Swift does not: `String` equality — and therefore `Dictionary`, `Set`,
/// `hasPrefix` and `==` — is defined on *canonical equivalence*, so two
/// spellings JavaScript keeps apart are one string here. That is not a
/// theoretical hazard in this data. The shipped `jp` package spells 笹塚 (Keio,
/// station 003806) with U+FA10 CJK COMPATIBILITY IDEOGRAPH-585A, whose
/// canonical decomposition is U+585A, so:
///
///   - the index holds `笹\u{FA10}` and `笹\u{585A}` as two separate keys,
///     because `stationLookupKeys` stores the raw name and its NFKC-normalized
///     alias and `new Set` finds them different;
///   - a query for the composed spelling *misses* the raw key and *hits* the
///     normalized one, which is the alias doing exactly the job it exists for;
///   - a Swift port keyed on `String` would collapse the two, produce one key
///     instead of two, and answer the composed query from the wrong branch.
///
/// `CharacterSet.whitespacesAndNewlines` is wrong in both directions too: it
/// omits U+FEFF, which ECMAScript trims, and includes U+0085, which ECMAScript
/// does not. Both appear below because both change where a name begins. So the
/// tables are keyed on code units and trim, strip and comparison are written
/// out longhand at the bottom of the file. A port that leaned on Swift's
/// defaults would compile, read correctly, and route a different train.
public enum Stations {

    // MARK: - JSON, and JavaScript's rules about it

    /// A property or coordinate value, kept as JSON rather than as a typed
    /// field.
    ///
    /// The accessors below are `||` chains over properties that are spelled two
    /// ways (the N02_* originals in Japan, neutral names elsewhere) and are
    /// sometimes present but empty. `||` tests *truthiness*, not presence, so
    /// the chain has to be able to see an empty string and a zero and keep
    /// going — which a `String?` cannot express.
    ///
    /// There is deliberately no `object` case. The only place a value is
    /// re-serialised is the dedupe signature, which stringifies a coordinate,
    /// and `JSON.stringify` of an object depends on key insertion order that
    /// `JSONDecoder` does not preserve. Nothing in the shipped data or in the
    /// fixture's synthetic features puts an object there, so decoding one
    /// fails loudly instead of silently ordering it wrong.
    public indirect enum Value: Sendable, Equatable {
        case string(String)
        case number(Double)
        case bool(Bool)
        case array([Value])
        case null

        /// ECMAScript `ToBoolean`. A string is falsy only when it is empty —
        /// measured in code units, since that is what `length` counts.
        public var isTruthy: Bool {
            switch self {
            case .string(let text): return !text.utf16.isEmpty
            case .number(let value): return value != 0 && !value.isNaN
            case .bool(let value): return value
            case .array: return true  // even an empty one
            case .null: return false
            }
        }

        /// ECMAScript `ToString`, which is what a template literal and
        /// `String(x)` both apply.
        public var jsString: String {
            switch self {
            case .string(let text): return text
            case .number(let value): return JSNumber.string(value)
            case .bool(let value): return value ? "true" : "false"
            // `Array.prototype.join`, whose separator is a comma and whose
            // null and undefined elements become empty strings.
            case .array(let items):
                return items.map { $0 == .null ? "" : $0.jsString }.joined(separator: ",")
            case .null: return "null"
            }
        }

        /// `JSON.stringify`. Numbers go through the same `ToString` a template
        /// literal would use, which is the rule that prints 139 as `139` and
        /// not `139.0`.
        public var jsonStringified: String {
            switch self {
            case .string(let text): return Self.quote(text)
            case .number(let value):
                return value.isFinite ? JSNumber.string(value) : "null"
            case .bool(let value): return value ? "true" : "false"
            case .array(let items):
                return "[" + items.map(\.jsonStringified).joined(separator: ",") + "]"
            case .null: return "null"
            }
        }

        private static func quote(_ text: String) -> String {
            var out = "\""
            for unit in text.unicodeScalars {
                switch unit {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\u{08}": out += "\\b"
                case "\u{0C}": out += "\\f"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                default:
                    if unit.value < 0x20 {
                        out += String(format: "\\u%04x", unit.value)
                    } else {
                        out.unicodeScalars.append(unit)
                    }
                }
            }
            return out + "\""
        }
    }

    // MARK: - The two record shapes

    /// One station feature of a `stations*.json` collection.
    ///
    /// Property NAMES are ASCII identifiers from this app's own schema, so a
    /// `String`-keyed dictionary is safe for them — no ASCII character has a
    /// canonical decomposition, and nothing can collapse. Property VALUES are
    /// the CJK data, and those never become dictionary keys here.
    public struct Feature: Sendable, Equatable, Decodable {
        public var properties: [String: Value]
        public var geometry: Geometry?

        public init(properties: [String: Value] = [:], geometry: Geometry? = nil) {
            self.properties = properties
            self.geometry = geometry
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            properties =
                try container.decodeIfPresent([String: Value].self, forKey: .properties) ?? [:]
            geometry = try container.decodeIfPresent(Geometry.self, forKey: .geometry)
        }

        private enum CodingKeys: String, CodingKey { case properties, geometry }
    }

    public struct Geometry: Sendable, Equatable, Decodable {
        public var type: String?
        public var coordinates: Value?

        public init(type: String?, coordinates: Value?) {
            self.type = type
            self.coordinates = coordinates
        }
    }

    public struct FeatureCollection: Sendable, Decodable {
        public var features: [Feature]

        public init(features: [Feature]) { self.features = features }

        public static func load(contentsOf url: URL) throws -> FeatureCollection {
            try JSONDecoder().decode(FeatureCollection.self, from: Data(contentsOf: url))
        }
    }

    /// One stop of a train.
    ///
    /// A **class**, because `trainAnchorCoordinates` excludes the stop being
    /// resolved with `stop === excludeStop` — JavaScript object identity, not
    /// equality. A train may legitimately call at the same station twice
    /// (a loop service, a reversal), and with a value type the second visit
    /// would exclude the first as well.
    public final class Stop: Sendable, Hashable {
        /// nil where the JavaScript field is absent, `null`, or `""` — the
        /// three cases its `||` chains cannot tell apart.
        public let name: String?
        public let n02StationCode: String?
        public let n02_005c: String?

        public init(name: String? = nil, n02StationCode: String? = nil, n02_005c: String? = nil) {
            self.name = name
            self.n02StationCode = n02StationCode
            self.n02_005c = n02_005c
        }

        public static func == (lhs: Stop, rhs: Stop) -> Bool { lhs === rhs }
        public func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }
    }

    public struct Train: Sendable {
        public var stops: [Stop]
        public init(stops: [Stop] = []) { self.stops = stops }
    }

    /// What `resolveStationCandidates` accepts: a bare name, or a stop object.
    ///
    /// The difference is not only where the name comes from. `excludeStop` is
    /// set only when the caller passed an object, so a stop resolved as an
    /// object is left out of its own anchor set while the same stop resolved by
    /// name anchors against itself.
    public enum Query: Sendable {
        case name(String)
        case stop(Stop)
    }

    // MARK: - Name normalization

    /// Tolerant station-name normalization — the ONE key rule for every
    /// station-name identity in the system: the resolution index here, the
    /// reading table's by-name lookup, and the build scripts' station-code
    /// lookup.
    ///
    /// NFKC folds full/half-width differences; internal whitespace and the
    /// small/large kana variants (柳ヶ浦 vs 柳ケ浦) that N02, hand-written JSON
    /// and the readings table spell inconsistently are unified.
    ///
    /// The order is load-bearing. NFKC runs FIRST, so by the time the
    /// whitespace strip and the kana fold see the string, U+3000 has already
    /// become a plain space and half-width katakana has already become
    /// full-width. The four kana replacements come last because NFKC does not
    /// touch them: ヶ U+30F6 has no compatibility decomposition, so nothing but
    /// an explicit substitution unifies it with ケ.
    public static func normalizeStationName(_ value: String?) -> String {
        // `value === null || value === undefined` — every other type is
        // stringified by the JavaScript, and every caller here passes a string.
        guard let value else { return "" }

        // NFKC — and it takes BOTH calls.
        //
        // `precomposedStringWithCompatibilityMapping` alone is not NFKC. NFKC
        // is "compatibility-decompose, then canonically compose", and Foundation
        // skips the composition for a combining mark that its own compatibility
        // mapping produced. Measured on Darwin:
        //
        //     ｸﾞ  U+FF78 U+FF9E  →  U+30AF U+3099   (not composed)
        //     グ  U+30AF U+3099  →  U+30B0          (composed)
        //
        // The first is what the half-width spelling of グ decomposes to and the
        // second is the same two code points arriving directly, so the rule is
        // not about the pair — it is about where the mark came from.
        // JavaScript's `normalize("NFKC")` returns U+30B0 for both. Chaining
        // `precomposedStringWithCanonicalMapping` (NFC) supplies the missing
        // step, and it cannot do harm: NFKC output is by definition already in
        // NFC, so the second call is the identity wherever the first was right —
        // including on U+FA10, the compatibility ideograph in 笹塚, which both
        // languages already map to U+585A.
        //
        // NO shipped station name reaches this: all 10,335 names in the five
        // packages and five stores are already full-width, so the first call
        // alone answers them correctly. What reaches it is the half-width
        // spelling of one — ｸﾞﾗﾝﾄﾞ通 for グランド通, ﾅｺﾞﾔﾄﾞｰﾑ前矢田 for
        // ナゴヤドーム前矢田 — which is precisely the imperfect JSON this
        // function exists to tolerate, and precisely what an imported itinerary
        // typed on a Japanese IME can contain. Without the second call such a
        // stop normalizes to a decomposed グ, misses the index, and resolves to
        // nothing.
        //
        // Worth recording how it was found: no volume of real names would have
        // caught it, because real names never take this path. The adversarial
        // width-variant block in the fixture did.
        var units = Array(
            value
                .precomposedStringWithCompatibilityMapping
                .precomposedStringWithCanonicalMapping
                .utf16)

        // `.trim()` and then `.replace(/\s+/g, "")`. The second subsumes the
        // first — ECMAScript's `\s` is exactly `TrimString`'s WhiteSpace ∪
        // LineTerminator — but both are written out so the sequence can be read
        // against the JavaScript line for line.
        var start = 0
        var end = units.count
        while start < end, isJSWhiteSpace(units[start]) { start += 1 }
        while end > start, isJSWhiteSpace(units[end - 1]) { end -= 1 }
        units = Array(units[start..<end])
        units.removeAll(where: isJSWhiteSpace)

        for index in units.indices {
            switch units[index] {
            case 0x30F6: units[index] = 0x30B1  // ヶ → ケ
            case 0x30F5: units[index] = 0x30AB  // ヵ → カ
            case 0x3096: units[index] = 0x3051  // ゖ → け
            case 0x3095: units[index] = 0x304B  // ゕ → か
            default: break
            }
        }
        return String(decoding: units, as: UTF16.self)
    }

    // MARK: - Feature accessors

    /// JavaScript's `a || b || c`: the first truthy value, or the LAST one when
    /// none is truthy — which may itself be absent.
    private static func firstTruthy(_ values: [Value?]) -> Value? {
        for value in values.dropLast() where value?.isTruthy == true { return value }
        return values.last ?? nil
    }

    /// `stationName`, exactly as the `||` chain leaves it. nil is JavaScript's
    /// `undefined` (no such property) or `null`; `.string("")` is a property
    /// that is present and empty, which the chain reached and rejected. Those
    /// two are different values and the fixture records them differently, even
    /// though every consumer treats both as "no name".
    public static func stationNameValue(_ feature: Feature) -> Value? {
        let properties = feature.properties
        return firstTruthy([
            properties["station_name"], properties["name"], properties["N02_005"],
        ])
    }

    /// The same, flattened: nil where the chain ended in `undefined` or `null`.
    public static func stationName(_ feature: Feature) -> String? {
        guard let value = stationNameValue(feature), value != .null else { return nil }
        return value.jsString
    }

    /// jsonspec 1.3 keeps the historical key `n02_station_code`, but the value
    /// follows the active official source: six-digit N02_005c in Japan, TDX
    /// StationUID in Taiwan. nil is the JavaScript's explicit `null`.
    public static func stationCode(_ feature: Feature) -> String? {
        let properties = feature.properties
        return truthyString(
            firstTruthy([properties["n02_station_code"], properties["N02_005c"]]))
    }

    public static func stationGroupCode(_ feature: Feature) -> String? {
        let properties = feature.properties
        return truthyString(
            firstTruthy([
                properties["n02_group_code"], properties["N02_005g"],
                properties["official_station_group_id"], properties["stationGroupId"],
            ]))
    }

    public static func stationLineName(_ feature: Feature) -> String {
        let properties = feature.properties
        return firstTruthy([properties["line_name"], properties["N02_003"], .string("-")])!
            .jsString
    }

    public static func stationOperator(_ feature: Feature) -> String {
        let properties = feature.properties
        return firstTruthy([properties["operator"], properties["N02_004"], .string("-")])!
            .jsString
    }

    /// `String(p.institution_type_code || p.N02_002 || "")`. The `String(…)`
    /// matters: the fixture carries a feature whose code is the *number* 3, and
    /// JavaScript prints that as `"3"`, not `"3.0"`.
    public static func stationInstitutionTypeCode(_ feature: Feature) -> String {
        let properties = feature.properties
        return firstTruthy([
            properties["institution_type_code"], properties["N02_002"], .string(""),
        ])!.jsString
    }

    /// The value when it is truthy, otherwise nil — the shape of a chain that
    /// ends in an explicit `|| null`.
    private static func truthyString(_ value: Value?) -> String? {
        guard let value, value.isTruthy else { return nil }
        return value.jsString
    }

    // MARK: - Stop accessors

    public static func stopName(_ stop: Stop) -> String {
        guard let name = stop.name, !name.utf16.isEmpty else { return "" }
        return name
    }

    public static func stopStationCode(_ stop: Stop) -> String? {
        if let code = stop.n02StationCode, !code.utf16.isEmpty { return code }
        if let code = stop.n02_005c, !code.utf16.isEmpty { return code }
        return nil
    }

    // MARK: - Where a feature is

    /// An explicit `display_point` wins, then a Point's own coordinates, then
    /// the first vertex of its path.
    ///
    /// nil is JavaScript's `undefined` or `null` — which every caller tests for
    /// with a plain `if (coord)`, so an EMPTY array is a point as far as they
    /// are concerned and is returned as one here.
    public static func displayCoordinate(_ feature: Feature) -> [Double]? {
        if case .array(let point)? = feature.properties["display_point"] {
            return numbers(point)
        }
        if feature.geometry?.type == "Point" {
            // The JavaScript returns `geometry.coordinates` whatever it holds;
            // anything that is not an array of numbers is falsy or unusable at
            // every call site, which is what nil means here.
            guard case .array(let point)? = feature.geometry?.coordinates else { return nil }
            return numbers(point)
        }
        return firstPathCoordinate(feature)
    }

    /// `getFeaturePathCoordinates(feature)[0]`.
    ///
    /// A LineString's own first coordinate, or a MultiLineString's first line's
    /// first vertex — its `flatMap` concatenates the lines, so the first
    /// element of the result is exactly that. Any other geometry (a Polygon, a
    /// null geometry) has no path, and neither does an empty one.
    ///
    /// The JavaScript's `clone`/`flatMap` would also pass a malformed element
    /// straight through — a bare number where a position belongs. Nothing in
    /// the five shipped collections does that, and modelling it would mean
    /// giving this a return type no caller could use.
    private static func firstPathCoordinate(_ feature: Feature) -> [Double]? {
        guard let geometry = feature.geometry, case .array(let coordinates)? = geometry.coordinates
        else { return nil }
        switch geometry.type {
        case "LineString":
            guard case .array(let position)? = coordinates.first else { return nil }
            return numbers(position)
        case "MultiLineString":
            for line in coordinates {
                guard case .array(let vertices) = line, let first = vertices.first else { continue }
                guard case .array(let position) = first else { return nil }
                return numbers(position)
            }
            return nil
        default:
            return nil
        }
    }

    /// The array as coordinates, or nil when any element is not a number.
    private static func numbers(_ values: [Value]) -> [Double]? {
        var out: [Double] = []
        out.reserveCapacity(values.count)
        for value in values {
            guard case .number(let scalar) = value else { return nil }
            out.append(scalar)
        }
        return out
    }

    // MARK: - Station codes

    /// Which official source a code came from, or nil when it matches neither
    /// shape. Both patterns are ASCII-only — `\d` in a JavaScript regular
    /// expression is `[0-9]` and nothing wider — so a full-width spelling of a
    /// six-digit code is NOT an N02 code, and a port whose digit test accepts
    /// U+FF10…U+FF19 labels a Taiwanese code as a Japanese one.
    public static func stationCodeSystem(_ code: String?) -> String? {
        let value = jsTrim(code ?? "")
        let units = Array(value.utf16)

        // /^\d{6}$/
        if units.count == 6, units.allSatisfy({ (0x30...0x39).contains($0) }) { return "N02" }

        // /^[A-Z][A-Z0-9]*-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
        //
        // Scanned rather than backtracked: neither character class contains a
        // hyphen, so each `-` deterministically ends the run before it and the
        // greedy quantifiers never have to give anything back.
        func isUpper(_ unit: UInt16) -> Bool { (0x41...0x5A).contains(unit) }
        func isUpperOrDigit(_ unit: UInt16) -> Bool { isUpper(unit) || (0x30...0x39).contains(unit) }
        func isAlnum(_ unit: UInt16) -> Bool {
            isUpperOrDigit(unit) || (0x61...0x7A).contains(unit)
        }
        var index = 0
        guard index < units.count, isUpper(units[index]) else { return nil }
        index += 1
        while index < units.count, isUpperOrDigit(units[index]) { index += 1 }
        guard index < units.count, units[index] == 0x2D else { return nil }  // "-"
        index += 1
        guard index < units.count, isAlnum(units[index]) else { return nil }
        while index < units.count, isAlnum(units[index]) { index += 1 }
        while index < units.count, units[index] == 0x2D {
            index += 1
            guard index < units.count, isAlnum(units[index]) else { return nil }
            while index < units.count, isAlnum(units[index]) { index += 1 }
        }
        return index == units.count ? "TDX" : nil
    }

    /// A stop need not carry a source code at all, so absent is valid — but the
    /// EMPTY STRING is not, because it belongs to no system. nil here stands for
    /// both `null` and `undefined`, which the JavaScript treats identically.
    public static func isValidSourceStationCode(_ code: String?) -> Bool {
        code == nil || stationCodeSystem(code) != nil
    }

    public static func stationCodeFieldLabel(_ code: String?) -> String {
        stationCodeSystem(code) == "TDX" ? "TDX StationUID" : "N02_005c"
    }

    // MARK: - The index keys

    /// Every key one feature (or one written stop) is filed under: its code,
    /// its trimmed raw name, and its normalized alias when that differs — so a
    /// stop written 柳ケ浦 still finds 柳ヶ浦.
    ///
    /// The alias is added only when it is a *different string*, and the result
    /// is deduplicated. Both of those are code-unit comparisons in JavaScript,
    /// which is what makes 笹塚 file under two keys: the U+FA10 spelling the
    /// package ships and the U+585A spelling NFKC produces from it. A `Set<
    /// String>` would keep one.
    public static func stationLookupKeys(name: String?, code: String?) -> [String] {
        var keys: [String] = []
        if let code, !code.utf16.isEmpty {
            let cleanCode = jsTrim(code)
            if !cleanCode.utf16.isEmpty { keys.append(cleanCode) }
        }
        if let name, !name.utf16.isEmpty {
            let cleanName = jsTrim(name)
            if !cleanName.utf16.isEmpty { keys.append(cleanName) }
            let normalized = normalizeStationName(name)
            if !normalized.utf16.isEmpty, !sameCodeUnits(normalized, cleanName) {
                keys.append(normalized)
            }
        }
        // `[...new Set(keys)]` — SameValueZero, which for strings is code-unit
        // equality.
        var seen = Set<CodeUnits>()
        return keys.filter { seen.insert(CodeUnits($0)).inserted }
    }

    // MARK: - dedupe

    /// The signature that decides two features are the same station: code,
    /// name, line, operator and the JSON spelling of the first coordinate.
    ///
    /// That last part is the JavaScript number-printing rule. `JSON.stringify`
    /// renders a finite number with `ToString`, so 139 is `139` and never
    /// `139.0`, and a port that spells it the other way keeps duplicates this
    /// one drops. It also inherits `||`: for a Point at longitude 0 the first
    /// coordinate is the number `0`, which is falsy, so the signature records
    /// `[]` — the same as a feature with no geometry at all.
    private static func dedupeSignature(_ feature: Feature) -> String {
        var head = Value.array([]).jsonStringified
        if case .array(let coordinates)? = feature.geometry?.coordinates,
            let first = coordinates.first, first.isTruthy
        {
            head = first.jsonStringified
        }
        return [
            stationCode(feature) ?? "",
            stationName(feature) ?? "",
            stationLineName(feature),
            stationOperator(feature),
            head,
        ].joined(separator: "|")
    }

    /// The positions of the features that survive deduplication, in order.
    ///
    /// Positions rather than the features themselves: `Feature` is a value
    /// type and has no identity, so "which one was kept" can only be said as
    /// "which position".
    public static func dedupeStationFeatureIndices(_ features: [Feature]) -> [Int] {
        var seen = Set<CodeUnits>()
        var kept: [Int] = []
        for (index, feature) in features.enumerated()
        where seen.insert(CodeUnits(dedupeSignature(feature))).inserted {
            kept.append(index)
        }
        return kept
    }

    // The JavaScript's own name for this is `dedupeStationFeatures`, and a
    // wrapper carrying that name used to sit here returning the features
    // themselves. Nothing called it: both consumers — `RouteSolver`'s
    // candidate list and the parity test — want the POSITIONS, because they
    // are deduplicating one array in order to subscript another one with the
    // same shape. The behaviour is the same behaviour; only the surviving
    // spelling is different.

    // MARK: - The route seam

    // MARK: - The index

    /// Both station-resolution indexes, built in one pass over the feature list
    /// — the name/code candidate index, and the code → name map.
    ///
    /// The JavaScript builds these in ~12 ms slices and yields between them, so
    /// a boot in a hidden tab is not stretched by the background-timer clamp.
    /// That is a scheduling concern with no effect on the result, and there is
    /// nothing to schedule around here.
    ///
    /// ONE country is resident at a time. The countries share station names
    /// (松山, 板橋, 岡山 …), so a stop resolved against the wrong network would
    /// not look like an error — it would look like a route.
    public struct Index: Sendable {
        public let features: [Feature]
        private let candidates: [CodeUnits: [Int]]
        private let nameByCode: [CodeUnits: String]

        public init(_ collection: FeatureCollection) { self.init(collection.features) }

        public init(_ features: [Feature]) {
            self.features = features
            var candidates: [CodeUnits: [Int]] = [:]
            var nameByCode: [CodeUnits: String] = [:]
            for (index, feature) in features.enumerated() {
                let name = stationName(feature)
                let code = stationCode(feature)
                for key in stationLookupKeys(name: name, code: code) {
                    candidates[CodeUnits(key), default: []].append(index)
                }
                // Last writer wins, as `Map.prototype.set` does — two features
                // sharing a code are a data question, not a resolution one.
                if let code { nameByCode[CodeUnits(code)] = name ?? "" }
            }
            self.candidates = candidates
            self.nameByCode = nameByCode
        }

        /// How many distinct keys the pass produced. A port that keys on
        /// `String` instead of code units produces fewer, because it merges
        /// spellings JavaScript keeps apart.
        public var keyCount: Int { candidates.count }
        public var codeCount: Int { nameByCode.count }

        /// N02_005c → N02_005. The station name is a per-station constant kept
        /// once on each stop; route sections carry only codes and resolve their
        /// names through this. Note that it does NOT trim its argument — a code
        /// with stray spaces finds nothing.
        public func name(forCode code: String?) -> String {
            guard let code, !code.utf16.isEmpty else { return "" }
            return nameByCode[CodeUnits(code)] ?? ""
        }

        private func features(forKey key: String) -> [Int]? { candidates[CodeUnits(key)] }

        // MARK: Resolution

        /// The candidate features for a written name or stop, as positions in
        /// `features`.
        ///
        /// A source station code is line- and operator-specific, so code
        /// matches are NEVER unioned with same-name matches: an inconsistent
        /// imported pair such as `{ name: "千葉", n02_station_code: "003859" }`
        /// would otherwise mix 越中島 and 千葉 candidates and send the solver to
        /// the wrong city.
        public func candidateIndices(for query: Query?) -> [Int] {
            candidateIndices(for: query, warned: nil)
        }

        /// - Parameter warned: set to true when the code and the name disagree
        ///   and the resolution falls back to the name pool. The JavaScript
        ///   reports that with `console.warn`; it is a real branch, so it is
        ///   observable here rather than invisible.
        public func candidateIndices(for query: Query?, warned: UnsafeMutablePointer<Bool>?)
            -> [Int]
        {
            warned?.pointee = false
            // `if (!stopOrName) return []` — and an empty NAME is falsy, so a
            // bare "" never reaches the index at all.
            guard let query else { return [] }
            let name: String
            let code: String?
            switch query {
            case .name(let text):
                guard !text.utf16.isEmpty else { return [] }
                name = text
                code = nil
            case .stop(let stop):
                name = stopName(stop)
                code = stopStationCode(stop)
            }

            let cleanName = name.utf16.isEmpty ? "" : jsTrim(name)
            let cleanCode = (code?.utf16.isEmpty ?? true) ? "" : jsTrim(code!)
            let normalizedQueryName = normalizeStationName(cleanName)

            let codeCandidates =
                cleanCode.utf16.isEmpty ? [] : dedupe(features(forKey: cleanCode) ?? [])
            if !codeCandidates.isEmpty {
                if cleanName.utf16.isEmpty { return codeCandidates }
                let agreeing = codeCandidates.filter {
                    sameCodeUnits(
                        normalizeStationName(stationName(features[$0])), normalizedQueryName)
                }
                if !agreeing.isEmpty { return agreeing }
                warned?.pointee = true
            }

            // Exact name first, then the normalized alias. The index never
            // stores an empty bucket, so the JavaScript's `||` chain over the
            // two lookups is a plain "first hit wins".
            let nameCandidates: [Int]
            if cleanName.utf16.isEmpty {
                nameCandidates = []
            } else {
                nameCandidates = dedupe(
                    features(forKey: cleanName) ?? features(forKey: normalizedQueryName) ?? [])
            }
            return nameCandidates.isEmpty ? codeCandidates : nameCandidates
        }

        public func candidates(for query: Query?) -> [Feature] {
            candidateIndices(for: query).map { features[$0] }
        }

        private func dedupe(_ indices: [Int]) -> [Int] {
            var seen = Set<CodeUnits>()
            return indices.filter {
                seen.insert(CodeUnits(dedupeSignature(features[$0]))).inserted
            }
        }

        // MARK: Train-aware resolution

        /// Display coordinates of a train's UNAMBIGUOUS stops — the ones with a
        /// single candidate, or carrying a station code.
        ///
        /// These anchor the geographic disambiguation of any same-name stop, so
        /// 池田 on a Hokkaido train resolves to 根室線 池田 rather than 阪急 池田
        /// in Osaka. `excludeStop` skips the stop currently being resolved, and
        /// it is compared by IDENTITY: a train that calls at one station twice
        /// must not lose both visits.
        public func trainAnchorCoordinates(_ train: Train?, excluding excludeStop: Stop?)
            -> [[Double]]
        {
            var coordinates: [[Double]] = []
            for stop in train?.stops ?? [] {
                if stop === excludeStop { continue }
                let candidates = candidateIndices(for: .stop(stop))
                guard !candidates.isEmpty else { continue }
                guard candidates.count == 1 || stopStationCode(stop) != nil else { continue }
                if let coordinate = displayCoordinate(features[candidates[0]]) {
                    coordinates.append(coordinate)
                }
            }
            return coordinates
        }

        /// Train-aware single-station resolution, as a position in `features`.
        ///
        /// Prefers candidates in the train's allowed institution class and,
        /// when a name is still ambiguous, picks the one nearest the train's
        /// anchor stops. With no train context it returns the first by-name
        /// candidate.
        public func resolveStationForTrain(
            _ query: Query?, train: Train?, resolver: StationRouteResolver?
        ) -> Int? {
            let candidates = candidateIndices(for: query)
            if candidates.count <= 1 { return candidates.first }

            // `train && resolver` on one side, `allowedCodes && resolver` on
            // the other: an empty array of codes is TRUTHY, so it still calls
            // the filter, while a null does not.
            let allowedCodes: [String]? =
                (train != nil && resolver != nil)
                ? resolver!.allowedInstitutionCodes(train!) : nil
            var preferred: [Int] = []
            if let allowedCodes, let resolver {
                preferred = resolver.filterPreferredStations(
                    candidates.map { features[$0] }, allowedCodes: allowedCodes
                ).map { candidates[$0] }
            }
            let pool = preferred.isEmpty ? candidates : preferred
            if pool.count == 1 { return pool[0] }

            let excludeStop: Stop?
            if case .stop(let stop)? = query { excludeStop = stop } else { excludeStop = nil }
            let anchors = train != nil ? trainAnchorCoordinates(train, excluding: excludeStop) : []
            guard !anchors.isEmpty, let resolver else { return pool[0] }

            // Strictly `<` on both comparisons, so a tie keeps whichever
            // candidate the index listed first.
            var best = pool[0]
            var bestDistance = Double.infinity
            for index in pool {
                guard let coordinate = displayCoordinate(features[index]) else { continue }
                var nearest = Double.infinity
                for anchor in anchors {
                    let distance = resolver.distanceMeters(coordinate, anchor)
                    if distance < nearest { nearest = distance }
                }
                if nearest < bestDistance {
                    bestDistance = nearest
                    best = index
                }
            }
            return best
        }
    }

    // MARK: - Station readings

    /// The station reading table — kana, romaji and the four-language official
    /// names — keyed the way `setStationReadings` keys it.
    ///
    /// The table lives in `i18n.js`, but its KEYING is a station-name
    /// resolution rule and it is the same rule as the index above:
    /// `byName` is re-keyed through ``normalizeStationName`` at load so that a
    /// hit can never depend on how the external table happened to spell its
    /// keys. That is not a no-op on the shipped data — five Hong Kong keys and
    /// one Korean one change, because they contain internal spaces the
    /// normalization strips.
    ///
    /// WHICH of the four languages a caller then shows, and whether a name gets
    /// a reading subline at all, is a display preference and is not ported.
    public struct Readings: Sendable {
        public typealias Row = [String: Value]

        private let byCode: [CodeUnits: Row]
        private let byName: [CodeUnits: Row]
        /// `String(data.country || "JP").toUpperCase()`, narrowed to the four
        /// countries whose table localizes the base NAME rather than annotating
        /// a Japanese one — anything else, a missing field included, is "JP".
        public let declaredCountry: String

        public static let localizedNameCountries: Set<String> = ["TW", "HK", "MO", "KR"]

        public init(byCode: [String: Row], byName: [String: Row], country: String?) {
            var codes: [CodeUnits: Row] = [:]
            for (key, value) in byCode { codes[CodeUnits(key)] = value }
            var names: [CodeUnits: Row] = [:]
            for (key, value) in byName { names[CodeUnits(normalizeStationName(key))] = value }
            self.byCode = codes
            self.byName = names
            let declared = (country?.isEmpty == false ? country! : "JP").uppercased()
            self.declaredCountry =
                Self.localizedNameCountries.contains(declared) ? declared : "JP"
        }

        public var codeKeyCount: Int { byCode.count }
        public var nameKeyCount: Int { byName.count }

        /// The exact code first, then the normalized name. A code is
        /// unambiguous and a name is not, so a stop that carries both is
        /// answered by the code even when the name belongs elsewhere.
        public func reading(code: String?, name: String?) -> Row? {
            if let code, !code.utf16.isEmpty, let row = byCode[CodeUnits(code)] { return row }
            if let name, !name.utf16.isEmpty,
                let row = byName[CodeUnits(normalizeStationName(name))]
            {
                return row
            }
            return nil
        }

        /// The on-disk shape of `station-readings*.json`.
        public struct Table: Decodable {
            public let country: String?
            public let byCode: [String: Row]?
            public let byName: [String: Row]?
        }

        public static func load(contentsOf url: URL) throws -> (Readings, Table) {
            let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
            return (
                Readings(
                    byCode: table.byCode ?? [:], byName: table.byName ?? [:],
                    country: table.country),
                table
            )
        }
    }
}

// MARK: - JavaScript string semantics, written out

extension Stations.Value: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([Stations.Value].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription:
                    "Stations.Value has no object case on purpose: JSON.stringify of an object "
                    + "depends on key insertion order, which JSONDecoder does not preserve, and "
                    + "nothing in the station data puts one where that would matter."
            )
        }
    }
}

/// ``JSString/isWhiteSpace(_:)`` under this file's own name.
///
/// `OperatorBranding.swift` spelled the identical switch; both moved to
/// `JSString.swift` when the parallel ports landed. The local name stays
/// because it reads as the predicate three scanners in this file pass to
/// `removeAll(where:)`.
private func isJSWhiteSpace(_ unit: UInt16) -> Bool { JSString.isWhiteSpace(unit) }

/// ECMAScript `TrimString`.
private func jsTrim(_ value: String) -> String { JSString.trimCodeUnits(value) }
