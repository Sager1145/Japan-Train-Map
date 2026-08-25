import Foundation

// =========================================================================
//  Train.swift — the itinerary model, and the rules that decide what an
//  itinerary IS.
//
//  Ported from jsonspec.md (schema 1.3), app-validation.js §33 and the
//  app-store-ops.js §18–§19 canonical shapes the validator sits between.
//
//  There are two layers here and keeping them apart is the whole design:
//
//    * ``TrainStore`` / ``Train`` / ``Stop`` / ``RouteSection`` /
//      ``RoutePolicy`` / ``TrainStyle`` are a faithful mirror of the
//      CANONICAL shape — the shape the web app writes. They round-trip both
//      committed stores without loss, and they are strict: a field the
//      canonical writer always emits is non-optional, so a decode failure
//      means "this was not canonical", not "this was invalid".
//
//    * ``TrainValidation`` works on ``TrainValidation/JSON``, an
//      order-preserving dynamic value, because that is the only thing that
//      can represent what the validator actually receives. Half of what
//      makes validateTrain interesting is what it does with a `ride_segment`
//      that is the string "true", a `route_sections` that is the number 0,
//      or a `stops` row that is null — none of which a typed model can hold.
//      The lenient inbound path (``TrainValidation/normalizeImportedTrain``)
//      is what bridges the two: dynamic JSON in, a strict ``Train`` out.
//
//  Every rule below reproduces what the JavaScript does TODAY, including the
//  parts that look accidental. `port-fixtures/validation.json` records the
//  verdicts, and the ones worth knowing about are marked "ACCEPTS:" at the
//  line responsible. They are not bugs to fix here — a port that quietly
//  tightens a rule is a port whose disagreements can no longer be read, and
//  it would start rejecting itineraries the committed archive contains.
// =========================================================================

// MARK: - the canonical model

/// `{ "schema_version": "1.3", "trains": [...] }` — jsonspec §2.1.
///
/// The top level is an object and never an array, and it carries exactly
/// these two keys: jsonspec §2.3 rule 4 notes that 1.3 deliberately did *not*
/// add a `country` field, because the strict whitelist is what keeps an older
/// Japanese store loadable. Country comes from the active rail package.
public struct TrainStore: Codable, Equatable, Sendable {
    public var schemaVersion: String
    public var trains: [Train]

    public init(schemaVersion: String = TrainValidation.schemaVersion, trains: [Train] = []) {
        self.schemaVersion = schemaVersion
        self.trains = trains
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case trains
    }
}

/// One ridden itinerary — jsonspec §3.1.
///
/// ## What is optional, and why it is not obvious
///
/// `id`, `number`, `origin`, `destination` and `stops` are non-optional
/// because the export path always writes them and the validator always
/// requires them. Everything else is optional, and each for its own reason
/// rather than as a blanket policy:
///
///   - `date` may be genuinely absent: jsonspec §3.3 lets the date be
///     inferred from the id, and `validateTrain` accepts an absent `date`
///     while *rejecting* an explicit `null` one. Absent and null are
///     therefore not the same thing, which is why this is `String?` encoded
///     only when present rather than always written as null.
///   - `trainType`, `company`, `direction`, `visible`, `style`,
///     `routePolicy`, `routeSections` are all "filled with a default on
///     import, always written on export" (§3.1). The committed stores carry
///     every one of them, so the optionality here is about representing a
///     hand-authored file faithfully, not about the app's own output.
///
/// `direction` is a plain `String` and not an enum on purpose. jsonspec §3.1
/// *recommends* `up` / `down` / `unknown` and nothing validates it — the
/// committed Japanese store puts destination station names in it
/// (`"和光市・池袋"`, `"内回り"`), so an enum would reject 117 of the 201
/// real itineraries.
public struct Train: Codable, Equatable, Sendable {
    public var id: String
    public var date: String?
    public var number: String
    public var trainType: String?
    public var company: String?
    public var origin: String
    public var destination: String
    /// Recommended `up` / `down` / `unknown`, but free text in practice — see
    /// the type's documentation.
    public var direction: String?
    public var visible: Bool?
    public var style: TrainStyle?
    public var routePolicy: RoutePolicy?
    public var routeSections: [RouteSection]?
    public var stops: [Stop]
    /// Which regional package this itinerary belongs to — `"jp"`, `"tw"`,
    /// `"hk"`, `"mo"` or `"kr"`.
    ///
    /// **Not in the web app, and deliberately not in jsonspec.** The web app
    /// keeps one store per region and answers this question by asking which
    /// region is switched on; this app draws every region at once, so the
    /// question has to be answered per itinerary instead — the solver, the
    /// mileage statistics and the route cache each need to know which package
    /// a ride is measured against.
    ///
    /// Safe to add to the canonical file: `validateTrainStore` in
    /// app-validation.js applies `assertOnlyKeys` to the store ROOT only, and
    /// `validateTrain` checks the fields it knows without rejecting others, so
    /// a store written here still imports into the web app. Optional, and
    /// written only when set, so a file that never had one round-trips
    /// unchanged — and ``RegionCatalog`` can re-derive it from the stops when
    /// it is missing.
    public var region: String?

    public init(
        id: String,
        date: String? = nil,
        number: String,
        trainType: String? = nil,
        company: String? = nil,
        origin: String,
        destination: String,
        direction: String? = nil,
        visible: Bool? = nil,
        style: TrainStyle? = nil,
        routePolicy: RoutePolicy? = nil,
        routeSections: [RouteSection]? = nil,
        stops: [Stop],
        region: String? = nil
    ) {
        self.id = id
        self.date = date
        self.number = number
        self.trainType = trainType
        self.company = company
        self.origin = origin
        self.destination = destination
        self.direction = direction
        self.visible = visible
        self.style = style
        self.routePolicy = routePolicy
        self.routeSections = routeSections
        self.stops = stops
        self.region = region
    }

    private enum CodingKeys: String, CodingKey {
        case id, date, number, origin, destination, direction, visible, style, stops
        case trainType = "train_type"
        case company
        case routePolicy = "route_policy"
        case routeSections = "route_sections"
        case region
    }

    // Written out only when present, so that a store which omits a field
    // round-trips as one that omits it. The synthesised encoder would emit
    // `null` for every nil, which turns 46 route policies in the committed
    // Japanese store into policies that carry two null arrays they never had.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(date, forKey: .date)
        try container.encode(number, forKey: .number)
        try container.encodeIfPresent(trainType, forKey: .trainType)
        try container.encodeIfPresent(company, forKey: .company)
        try container.encode(origin, forKey: .origin)
        try container.encode(destination, forKey: .destination)
        try container.encodeIfPresent(direction, forKey: .direction)
        try container.encodeIfPresent(visible, forKey: .visible)
        try container.encodeIfPresent(style, forKey: .style)
        try container.encodeIfPresent(routePolicy, forKey: .routePolicy)
        try container.encodeIfPresent(routeSections, forKey: .routeSections)
        try container.encode(stops, forKey: .stops)
        try container.encodeIfPresent(region, forKey: .region)
    }
}

/// One station on the itinerary — jsonspec §7.1.
///
/// A canonical stop encodes all seven fields, `null` included. The bundled
/// 1.3 archives predate `platform_number`, so direct decode→encode preserves
/// that one legacy absence; every import, edit, or canonical export creates a
/// stop with the field present and writes an unknown value as explicit null.
///
/// `name`, `stopType` and `rideSegment` are non-optional for the same reason
/// — the canonical writer never leaves them out or null. A lean hand-written
/// stop (`{"name": "東京"}`) is legal *input*, and it reaches this type
/// through ``TrainValidation/normalizeImportedStop(_:)``, which applies the
/// §7.1 defaults. It is not decodable as a `Stop` directly, and that
/// asymmetry is deliberate: decoding is for canonical data, importing is for
/// everything else.
public struct Stop: Codable, Equatable, Sendable {
    public var name: String
    /// The official station code of the current country's rail data source —
    /// a six-digit Japanese `N02_005c`, a TDX-style `StationUID`, or nil.
    /// The key name is historical (jsonspec §2.3): the value has not been
    /// N02-only since Taiwan was added.
    public var n02StationCode: String?
    /// Passenger-facing platform/track number. `0` is valid; negative and
    /// fractional values are rejected. `nil` serializes as JSON `null` and is
    /// never rendered as the word "null".
    public var platformNumber: Int? {
        didSet { hasPlatformNumberField = true }
    }
    /// Distinguishes a legacy absent field from an explicit JSON null for
    /// lossless archive reads. It is intentionally not part of semantic
    /// equality: both spell the same unknown platform.
    var hasPlatformNumberField: Bool
    /// `"HH:MM"`, where hours run past 24 to spell the next day (§10.5:
    /// `25:10` is 01:10 tomorrow). Nothing validates the format — see
    /// ``TrainValidation/validateTrain(_:index:ids:)``.
    public var arrival: String?
    public var departure: String?
    /// One of ``TrainValidation/stopTypes`` (§7.2).
    public var stopType: String
    public var rideSegment: Bool

    public init(
        name: String,
        n02StationCode: String? = nil,
        platformNumber: Int? = nil,
        arrival: String? = nil,
        departure: String? = nil,
        stopType: String = "passenger_stop",
        rideSegment: Bool = false
    ) {
        self.name = name
        self.n02StationCode = n02StationCode
        self.platformNumber = platformNumber
        self.hasPlatformNumberField = true
        self.arrival = arrival
        self.departure = departure
        self.stopType = stopType
        self.rideSegment = rideSegment
    }

    private enum CodingKeys: String, CodingKey {
        case name, platformNumber = "platform_number", arrival, departure
        case n02StationCode = "n02_station_code"
        case stopType = "stop_type"
        case rideSegment = "ride_segment"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        n02StationCode = try container.decodeIfPresent(String.self, forKey: .n02StationCode)
        hasPlatformNumberField = container.contains(.platformNumber)
        platformNumber = try container.decodeIfPresent(Int.self, forKey: .platformNumber)
        arrival = try container.decodeIfPresent(String.self, forKey: .arrival)
        departure = try container.decodeIfPresent(String.self, forKey: .departure)
        stopType = try container.decode(String.self, forKey: .stopType)
        rideSegment = try container.decode(Bool.self, forKey: .rideSegment)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(n02StationCode, forKey: .n02StationCode)  // null, not absent
        if hasPlatformNumberField {
            try container.encode(platformNumber, forKey: .platformNumber)  // null, not absent
        }
        try container.encode(arrival, forKey: .arrival)
        try container.encode(departure, forKey: .departure)
        try container.encode(stopType, forKey: .stopType)
        try container.encode(rideSegment, forKey: .rideSegment)
    }

    public static func == (lhs: Stop, rhs: Stop) -> Bool {
        lhs.name == rhs.name
            && lhs.n02StationCode == rhs.n02StationCode
            && lhs.platformNumber == rhs.platformNumber
            && lhs.arrival == rhs.arrival
            && lhs.departure == rhs.departure
            && lhs.stopType == rhs.stopType
            && lhs.rideSegment == rhs.rideSegment
    }
}

/// One physically adjacent stop pair and the hard constraints on solving it —
/// jsonspec §6.1 and §6.1b.
///
/// The two codes are encoded every time (null included) and everything else
/// only when present, which is exactly what `leanExportSection` writes: the
/// endpoint names are dropped when the station table can reconstruct them
/// from the codes (§13.4), and the line/operator hints and the branch
/// number/name are dropped when empty. 1 861 of the 2 303 sections in the
/// committed Japanese store carry no `from`/`to` at all.
public struct RouteSection: Codable, Equatable, Sendable {
    public var from: String?
    public var to: String?
    public var fromN02StationCode: String?
    public var toN02StationCode: String?
    /// A **hard** constraint on which line the solver may traverse (§6.4).
    /// Empty or absent means unconstrained, which is a branch-leak risk at a
    /// junction rather than a neutral default.
    public var lineNames: [String]?
    public var operatorNames: [String]?
    /// A branch portion run under a different 号 — はやぶさ↔こまち (§6.1b).
    public var number: String?
    public var name: String?

    public init(
        from: String? = nil,
        to: String? = nil,
        fromN02StationCode: String? = nil,
        toN02StationCode: String? = nil,
        lineNames: [String]? = nil,
        operatorNames: [String]? = nil,
        number: String? = nil,
        name: String? = nil
    ) {
        self.from = from
        self.to = to
        self.fromN02StationCode = fromN02StationCode
        self.toN02StationCode = toN02StationCode
        self.lineNames = lineNames
        self.operatorNames = operatorNames
        self.number = number
        self.name = name
    }

    private enum CodingKeys: String, CodingKey {
        case from, to, number, name
        case fromN02StationCode = "from_n02_station_code"
        case toN02StationCode = "to_n02_station_code"
        case lineNames = "line_names"
        case operatorNames = "operator_names"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(from, forKey: .from)
        try container.encodeIfPresent(to, forKey: .to)
        try container.encode(fromN02StationCode, forKey: .fromN02StationCode)  // null, not absent
        try container.encode(toN02StationCode, forKey: .toN02StationCode)
        try container.encodeIfPresent(lineNames, forKey: .lineNames)
        try container.encodeIfPresent(operatorNames, forKey: .operatorNames)
        try container.encodeIfPresent(number, forKey: .number)
        try container.encodeIfPresent(name, forKey: .name)
    }
}

/// How this train's route may be solved — jsonspec §5.1.
///
/// Every field is optional even though `canonicalRoutePolicy` fills them all
/// in, because 46 of the 201 policies in the committed Japanese store predate
/// the current writer and carry no `preferred_line_names` /
/// `preferred_operator_names`. Encoding those as `null` would rewrite the
/// archive on the first save.
///
/// Note that `jrOnly` is advisory: jsonspec §17 rule 14 says the solver never
/// reads it. `allowedInstitutionTypeCodes` is what actually narrows the
/// search, and only in Japan — §17 rule 17 says Taiwan's packages carry no
/// N02_002 at all, so the array is kept for canonical shape and ignored.
public struct RoutePolicy: Codable, Equatable, Sendable {
    /// Must be `"single_primary_route"`; nothing else validates.
    public var mode: String?
    public var jrOnly: Bool?
    /// Must be `false`.
    public var allowAlternatives: Bool?
    /// Must be `false`. jsonspec §13.5 / §17 rule 11: drawing a straight line
    /// between two stations is forbidden under all circumstances.
    public var allowBrowserStraightLineFallback: Bool?
    /// N02_002 事業者種別: 1 = JR 新幹線, 2 = JR 在来線, 3 = 公営鉄道,
    /// 4 = 民営鉄道, 5 = 第三セクター.
    public var allowedInstitutionTypeCodes: [String]?
    /// Soft bias, not a constraint (§5.3) — a deviation is penalised in
    /// proportion to distance, never forbidden.
    public var preferredLineNames: [String]?
    public var preferredOperatorNames: [String]?
    /// `"soft"` or `"hard"` (§5.4).
    public var institutionFilterMode: String?

    public init(
        mode: String? = nil,
        jrOnly: Bool? = nil,
        allowAlternatives: Bool? = nil,
        allowBrowserStraightLineFallback: Bool? = nil,
        allowedInstitutionTypeCodes: [String]? = nil,
        preferredLineNames: [String]? = nil,
        preferredOperatorNames: [String]? = nil,
        institutionFilterMode: String? = nil
    ) {
        self.mode = mode
        self.jrOnly = jrOnly
        self.allowAlternatives = allowAlternatives
        self.allowBrowserStraightLineFallback = allowBrowserStraightLineFallback
        self.allowedInstitutionTypeCodes = allowedInstitutionTypeCodes
        self.preferredLineNames = preferredLineNames
        self.preferredOperatorNames = preferredOperatorNames
        self.institutionFilterMode = institutionFilterMode
    }

    private enum CodingKeys: String, CodingKey {
        case mode
        case jrOnly = "jr_only"
        case allowAlternatives = "allow_alternatives"
        case allowBrowserStraightLineFallback = "allow_browser_straight_line_fallback"
        case allowedInstitutionTypeCodes = "allowed_institution_type_codes"
        case preferredLineNames = "preferred_line_names"
        case preferredOperatorNames = "preferred_operator_names"
        case institutionFilterMode = "institution_filter_mode"
    }
}

/// The one per-train display value that survives — jsonspec §4.1.
///
/// `weight` and `unridden_opacity` were removed from the schema: line width
/// is a global setting and unridden intervals are hidden outright rather than
/// faded, so both are dropped on the way out by
/// ``TrainValidation/canonicalStyle(_:)``. They are not represented here at
/// all, which is what "dropped" means.
public struct TrainStyle: Codable, Equatable, Sendable {
    /// `#RRGGBB`. The only shape ``TrainValidation/isValidTrainColor(_:)``
    /// accepts.
    public var color: String?

    public init(color: String? = nil) { self.color = color }
}

// MARK: - the rules

/// `app-validation.js` §33 and the `app-store-ops.js` §18–§19 shapes.
///
/// ## What this accepts that it arguably should not
///
/// Reproduced deliberately; each is marked "ACCEPTS:" at the responsible
/// line and recorded in `port-fixtures/validation.json`.
///
///   - **A time is never parsed.** `arrival` and `departure` are only checked
///     to be a string or null, so `"banana"`, `"25:99"` and the legacy
///     `"10:00+1"` all validate. jsonspec §10 states a format; nothing
///     enforces it.
///   - **No two stops are ever compared.** An itinerary whose clock runs
///     backwards is valid.
///   - **`visible` is not type-checked** (jsonspec §15.2 says so outright).
///   - **A falsy-but-present `route_sections` or `route_policy` skips its
///     whole block.** `route_sections: 0` is not an error, it is an unchecked
///     section list.
///   - **`x || []` turns a null array into an empty one**, so a null
///     `line_names` or `allowed_institution_type_codes` passes.
///   - **A JSON number can be a station code.** `stationCodeSystem` coerces
///     with `String(code)` first, so `123456` is a valid `N02_005c`.
///   - **Nothing checks that any stop is ridden** (jsonspec §8.6.4): a train
///     with every `ride_segment` false validates, exports, and draws nothing.
///   - **A null row in `stops` crashes rather than rejects** — see
///     ``validateTrain(_:index:ids:)``.
///
/// ## Why there is not a single `NSRegularExpression` in here
///
/// The JavaScript spells four of these rules as regular expressions, and an
/// ICU translation of the same pattern text answers differently on real
/// input:
///
///   - ICU's `$` matches before a final line terminator; JavaScript's `$`
///     without `/m` matches only at the very end. So `"odr_001\n"` is a valid
///     train id under ICU and is rejected by the app.
///   - ICU's `\d` is `\p{Nd}`, which matches fullwidth and Arabic-Indic
///     digits. `"００３７７０"` would be a valid six-digit N02 station code.
///
/// Both are reachable from CJK data, so every matcher below is a hand-written
/// scan over UTF-16 code units.
public enum TrainValidation {

    // MARK: - constants

    /// `SCHEMA_VERSION` — the version this app writes.
    public static let schemaVersion = "1.3"

    /// `ACCEPTED_SCHEMA_VERSIONS` — the versions it will read.
    public static let acceptedSchemaVersions = ["1.3"]

    /// The five `stop_type` values of jsonspec §7.2, in the order the
    /// editor's `<select>` lists them (running order, not the spec's table
    /// order). The order is contractual because it is joined into the error
    /// message when a value is rejected.
    public static let stopTypes = [
        "origin", "passenger_stop", "pass_through", "operational_stop", "destination",
    ]

    /// `UNDATED` — the bucket for a train whose date could not be determined.
    /// Same value as ``Dates/undated``, which owns the date rules.
    public static let undated = Dates.undated

    /// `TRAIN_ID_PATTERN.source`, quoted verbatim into the error message.
    public static let trainIDPatternSource = "^[a-zA-Z0-9_-]+$"

    public static let defaultTrainColor = "#d9364f"

    /// N02_002 事業者種別 — 1 JR 新幹線, 2 JR 在来線, 3 公営鉄道,
    /// 4 民営鉄道, 5 第三セクター.
    public static let defaultAllowedInstitutionTypeCodes = ["1", "2", "3", "4", "5"]

    // MARK: - errors

    /// A throw out of the validator.
    ///
    /// `kind` is what separates a deliberate rejection from a crash. There is
    /// exactly one input shape that produces the latter, and collapsing the
    /// two would let a port that throws for the right reason look identical
    /// to one that reproduced the bug.
    public struct ValidationError: Error, Equatable, CustomStringConvertible {
        public enum Kind: String, Sendable, Equatable {
            /// `new Error(...)` — a schema rejection with a contractual message.
            case error = "Error"
            /// A `TypeError` the JavaScript did not intend to raise. The
            /// message is V8's own wording and is not a contract; only the
            /// kind is.
            case typeError = "TypeError"
            /// `JSON.parse` failed. Message likewise not contractual.
            case syntaxError = "SyntaxError"
        }

        public let kind: Kind
        public let message: String

        public init(kind: Kind = .error, message: String) {
            self.kind = kind
            self.message = message
        }

        public var description: String { message }
    }

    private static func fail(_ message: String) -> ValidationError {
        ValidationError(kind: .error, message: message)
    }

    // MARK: - JavaScript primitives

    /// ECMAScript `WhiteSpace` ∪ `LineTerminator`, which is what
    /// `String.prototype.trim` removes.
    ///
    /// Deliberately not `CharacterSet.whitespacesAndNewlines`, which differs
    /// at both ends: it omits U+FEFF (so a code with a leading byte-order
    /// mark, which the app accepts, would be rejected) and it includes U+0085
    /// (so a code with a leading NEL, which the app rejects, would be
    /// accepted). Both are in `port-fixtures/validation.json`.
    ///
    /// The same set is spelled privately in `Dates.swift`. Duplicated rather
    /// than shared because this file may not edit that one — if these ever
    /// need to move, they should move together into one internal helper.
    private static let jsWhitespace: Set<Unicode.Scalar> = {
        var set: Set<Unicode.Scalar> = [
            "\u{0009}", "\u{000A}", "\u{000B}", "\u{000C}", "\u{000D}",
            "\u{0020}", "\u{00A0}", "\u{1680}", "\u{2028}", "\u{2029}",
            "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
        ]
        for scalar in 0x2000...0x200A { set.insert(Unicode.Scalar(scalar)!) }
        return set
    }()

    /// ECMAScript `String.prototype.trim`.
    static func jsTrim(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end && jsWhitespace.contains(scalars[start]) { start += 1 }
        while end > start && jsWhitespace.contains(scalars[end - 1]) { end -= 1 }
        return String(String.UnicodeScalarView(scalars[start..<end]))
    }

    /// JavaScript's `===` between two strings.
    ///
    /// JavaScript compares strings by UTF-16 code unit; Swift's `==` compares
    /// by canonical equivalence, so `"が"` written as U+304C and as
    /// U+304B U+3099 are equal in Swift and not in JavaScript. Station names
    /// here are CJK and *are* compared — `leanExportSection` decides whether
    /// to keep a section's endpoint name by comparing it to the station
    /// table's, and `routeSectionMatchesStopPair` matches a section to a stop
    /// pair by name. Both committed stores happen to be entirely NFC today,
    /// so this changes no current answer; it is here so that the first
    /// decomposed name to arrive does not silently change one.
    static func jsStringEquals(_ a: String, _ b: String) -> Bool {
        var left = a.utf16.makeIterator()
        var right = b.utf16.makeIterator()
        while true {
            switch (left.next(), right.next()) {
            case (nil, nil): return true
            case (nil, _), (_, nil): return false
            case let (l?, r?): if l != r { return false }
            }
        }
    }

    private static func isASCIIDigit(_ unit: UInt16) -> Bool { unit >= 48 && unit <= 57 }
    private static func isASCIIUpper(_ unit: UInt16) -> Bool { unit >= 65 && unit <= 90 }
    private static func isASCIILower(_ unit: UInt16) -> Bool { unit >= 97 && unit <= 122 }
    private static func isASCIIAlnum(_ unit: UInt16) -> Bool {
        isASCIIDigit(unit) || isASCIIUpper(unit) || isASCIILower(unit)
    }
    private static func isASCIIHex(_ unit: UInt16) -> Bool {
        isASCIIDigit(unit) || (unit >= 65 && unit <= 70) || (unit >= 97 && unit <= 102)
    }

    // MARK: - predicates

    /// `TRAIN_ID_PATTERN` — `^[a-zA-Z0-9_-]+$`, jsonspec §3.2.
    ///
    /// Train ids flow into `route_id`, route cache keys and DOM ids, which is
    /// why the charset is closed rather than "any non-empty text".
    public static func matchesTrainIDPattern(_ value: String) -> Bool {
        let units = Array(value.utf16)
        guard !units.isEmpty else { return false }
        // `$` anchors at the very end of the input, so a trailing newline is
        // part of the string being matched and fails. See the type's notes.
        return units.allSatisfy { isASCIIAlnum($0) || $0 == 95 /* _ */ || $0 == 45 /* - */ }
    }

    /// `isValidTrainColor` — `^#[0-9a-fA-F]{6}$`, jsonspec §5.1.
    public static func isValidTrainColor(_ value: String?) -> Bool {
        // The JavaScript tests `value || ""`, so null and "" both fail here
        // rather than throwing.
        let units = Array((value ?? "").utf16)
        guard units.count == 7, units[0] == 35 /* # */ else { return false }
        return units[1...].allSatisfy(isASCIIHex)
    }

    /// Which official code system a station code belongs to, or nil.
    ///
    /// jsonspec §2.3: `N02` is Japan's six-digit `N02_005c`; `TDX` is the
    /// hyphenated form used by Taiwan (`TRA-1000`), Hong Kong
    /// (`TML-MTR-WKS`), Macao and Korea. The value is coerced with
    /// `String(code)` and trimmed first, which is where two of the fixture's
    /// surprises come from — a JSON *number* can be a valid code, and a
    /// leading U+FEFF is trimmed away while a leading U+0085 is not.
    public static func stationCodeSystem(_ code: JSON?) -> String? {
        let value = jsTrim(jsToString(code ?? .null))
        let units = Array(value.utf16)

        // ^\d{6}$ — ASCII digits only, because JavaScript's \d has no /u flag.
        if units.count == 6 && units.allSatisfy(isASCIIDigit) { return "N02" }

        // ^[A-Z][A-Z0-9]*-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$
        // Split on "-": the head may not contain one, and every tail segment
        // must be non-empty, so an empty segment anywhere fails — which is
        // what rejects "A-", "A--1" and "A-1-".
        let segments = units.split(separator: 45, omittingEmptySubsequences: false)
        if segments.count >= 2,
            let head = segments.first, head.count >= 1,
            isASCIIUpper(head[head.startIndex]),
            head.dropFirst().allSatisfy({ isASCIIUpper($0) || isASCIIDigit($0) }),
            segments.dropFirst().allSatisfy({ !$0.isEmpty && $0.allSatisfy(isASCIIAlnum) })
        {
            return "TDX"
        }
        return nil
    }

    /// Convenience for a code already known to be a string.
    public static func stationCodeSystem(_ code: String?) -> String? {
        stationCodeSystem(code.map(JSON.string) ?? JSON.null)
    }

    /// `isValidSourceStationCode` — null, absent, or a recognised system.
    ///
    /// Note that the empty string is *not* valid: it coerces to no system.
    /// jsonspec §2.3 rule 1 says to write `null` when there is no code.
    public static func isValidSourceStationCode(_ code: JSON?) -> Bool {
        guard let code, code != .null else { return true }
        return stationCodeSystem(code) != nil
    }

    /// `platform_number` — absent/null, zero, or a positive JSON integer.
    /// Booleans and numeric strings are not integers in JSON and are rejected.
    public static func isValidPlatformNumber(_ value: JSON?) -> Bool {
        guard let value, value != .null else { return true }
        guard case .number(let number) = value,
              number.isFinite,
              number >= 0,
              number.rounded(.towardZero) == number,
              // `Double(Int.max)` rounds up to 2^63 on 64-bit platforms, so
              // equality is already outside Int's representable range.
              number < Double(Int.max)
        else { return false }
        return true
    }

    /// `stopName(stop)` = `stop.name || ""`, as a truthiness test.
    ///
    /// ACCEPTS: the JavaScript returns the raw value rather than a string, so
    /// a numeric station name such as `12` is truthy and passes the
    /// "name is required" check.
    private static func stopNameIsTruthy(_ stop: JSON) -> Bool {
        stop["name"]?.isTruthy ?? false
    }

    // MARK: - assertOnlyKeys

    /// `assertOnlyKeys` — the strict inbound whitelist of §19.
    ///
    /// It throws on the **first** offending key in `Object.keys` order, so
    /// which key the message names depends on key order, and JavaScript's key
    /// order is not document order: integer-index keys come first in ascending
    /// *numeric* order, then every other key in insertion order. That rule
    /// lives in ``JSON/Object``, which is why this can just walk `keys`.
    ///
    /// A nil object is not an error — the JavaScript reads
    /// `Object.keys(object || {})`, so null and undefined both pass.
    public static func assertOnlyKeys(
        _ object: JSON?, _ allowedKeys: [String], _ label: String
    ) throws {
        guard let object else { return }
        for key in object.ownKeys {
            if !allowedKeys.contains(where: { jsStringEquals($0, key) }) {
                throw fail("\(label) contains unsupported field: \(key).")
            }
        }
    }

    // MARK: - validateTrainStore

    /// `validateTrainStore` — jsonspec §15.1.
    ///
    /// The `ids` set is rebuilt here and threaded through every train, which
    /// is what makes duplicate detection a property of the store rather than
    /// of a train.
    @discardableResult
    public static func validateTrainStore(_ store: JSON) throws -> Bool {
        // `!store || typeof store !== "object" || Array.isArray(store)`.
        // `typeof null` is "object" in JavaScript, so the falsiness test is
        // what actually rejects null.
        guard store.isTruthy, case .object = store else {
            throw fail("JSON root must be an object.")
        }
        try assertOnlyKeys(store, ["schema_version", "trains"], "Store")
        let version = store["schema_version"] ?? .null
        if !acceptedSchemaVersions.contains(where: { version == .string($0) }) {
            throw fail(
                "schema_version must be one of \(acceptedSchemaVersions.joined(separator: ", ")).")
        }
        guard case .array(let trains)? = store["trains"] else {
            throw fail("trains must be an array.")
        }
        var ids = Set<String>()
        for (index, train) in trains.enumerated() {
            try validateTrain(train, index: index, ids: &ids)
        }
        return true
    }

    // MARK: - validateTrain

    /// `validateTrain` — jsonspec §15.2/§15.3, the definition of an itinerary.
    ///
    /// `ids` is inout because the JavaScript mutates the caller's set: a train
    /// enters it only *after* its id has passed the charset check, so an
    /// invalid id never occupies a name.
    ///
    /// The `stops` handling below reproduces a genuine crash. The JavaScript
    /// reads `train.stops[0].departure` immediately after checking only that
    /// `stops` is an array of length ≥ 2 — nothing has established that a row
    /// is an object — so a `null` row leaves this function as a `TypeError`
    /// rather than as the schema error the import UI catches and shows. It is
    /// reachable from any hand-written or machine-generated file.
    public static func validateTrain(_ train: JSON, index: Int, ids: inout Set<String>) throws {
        let prefix = "Train \(index + 1)"

        for key in ["id", "number", "origin", "destination"] {
            let value = train[key] ?? .null
            guard value.isTruthy, case .string = value else {
                throw fail("\(prefix): \(key) is required.")
            }
        }
        // Optional metadata: 車輛類型 / 營運公司 ("/"-separated = 直通).
        for key in ["train_type", "company"] {
            // `undefined` is the only value that skips this. An explicit null
            // IS a value, and `typeof null !== "string"`, so null is rejected —
            // unlike `arrival`/`departure` below, which test for null first.
            if let value = train[key], !value.isString {
                throw fail("\(prefix): \(key) must be a string when present.")
            }
        }
        guard case .string(let id)? = train["id"] else {
            // Unreachable — the loop above already required a truthy string.
            throw fail("\(prefix): id is required.")
        }
        // §3.2: ids feed route_id / cache keys / DOM ids.
        if !matchesTrainIDPattern(id) {
            throw fail(
                "\(prefix): id must match \(trainIDPatternSource) (letters, digits, \"_\" and \"-\")."
            )
        }
        // Safe as a Swift Set despite its canonical-equality keys: the charset
        // check above has already restricted every member to ASCII, where
        // canonical equality and UTF-16 equality agree.
        if ids.contains(id) { throw fail("\(prefix): duplicate id \(id).") }
        ids.insert(id)

        // Absent is accepted; an explicit null is not. The guard is
        // `!== undefined`, and null is a value, so `{"date": null}` — the one
        // spelling JSON has for "no date" — is the shape that fails.
        if let date = train["date"], date != .string(undated) {
            let text: String? = if case .string(let value) = date { value } else { nil }
            if !Dates.isValidDateString(text) {
                throw fail("\(prefix): date must be \"YYYY-MM-DD\" or \"\(undated)\".")
            }
        }

        guard case .array(let stops)? = train["stops"], stops.count >= 2 else {
            throw fail("\(prefix): stops must contain at least 2 rows.")
        }
        // CRASHES on a null row, exactly as the JavaScript does. See above.
        if try member(stops[0], "departure").isTruthy, try member(stops[0], "arrival").isTruthy {
            throw fail("\(prefix): first stop should not need both arrival and departure.")
        }
        let last = stops[stops.count - 1]
        if try member(last, "departure").isTruthy, try member(last, "arrival").isTruthy {
            throw fail("\(prefix): final stop should not need both arrival and departure.")
        }

        for (stopIndex, stop) in stops.enumerated() {
            let at = "\(prefix) stop \(stopIndex + 1)"
            // Crashes on null for the same reason the guard above does —
            // stopName(null) reads `.name` off it.
            _ = try member(stop, "name")
            if !stopNameIsTruthy(stop) { throw fail("\(at): name is required.") }
            let stopType = stop["stop_type"] ?? .null
            if !stopType.isTruthy { throw fail("\(at): stop_type is required.") }
            // §7.2: an unrecognised stop_type silently falls through every
            // `=== "pass_through"` test and gets treated as a stopping
            // station, so it is rejected here rather than mis-rendered later.
            if !stopTypes.contains(where: { stopType == .string($0) }) {
                throw fail(
                    "\(at): stop_type must be one of \(stopTypes.joined(separator: " / ")).")
            }
            guard case .bool = stop["ride_segment"] ?? .null else {
                throw fail("\(at): ride_segment must be boolean.")
            }
            if !isValidSourceStationCode(stop["n02_station_code"]) {
                throw fail(
                    "\(at): n02_station_code must be a six-digit N02_005c, a TDX StationUID, or null."
                )
            }
            if !isValidPlatformNumber(stop["platform_number"]) {
                throw fail(
                    "\(at): platform_number must be a non-negative integer or null.")
            }
            for field in ["arrival", "departure"] {
                if let value = stop[field], value != .null, !value.isString {
                    throw fail("\(at): \(field) must be a string or null.")
                }
            }
        }

        // ACCEPTS: `if (train.route_sections)` — a falsy non-array (0, "",
        // false) skips this entire block instead of failing it, so a
        // `route_sections: 0` is an unchecked section list rather than an
        // invalid one.
        if let sections = train["route_sections"], sections.isTruthy {
            guard case .array(let rows) = sections else {
                throw fail("\(prefix): route_sections must be an array.")
            }
            for (sectionIndex, section) in rows.enumerated() {
                let at = "\(prefix) route section \(sectionIndex + 1)"
                // Crashes on a null row, third instance of the same pattern.
                let from = try member(section, "from")
                let fromCode = try member(section, "from_n02_station_code")
                let to = try member(section, "to")
                let toCode = try member(section, "to_n02_station_code")
                if !(from.isTruthy || fromCode.isTruthy) || !(to.isTruthy || toCode.isTruthy) {
                    throw fail(
                        "\(at): from/to names or official station codes are required.")
                }
                for field in ["from_n02_station_code", "to_n02_station_code"] {
                    if !isValidSourceStationCode(section[field]) {
                        throw fail(
                            "\(at): \(field) must be a six-digit N02_005c, a TDX StationUID, or null."
                        )
                    }
                }
                for field in ["line_names", "operator_names"] {
                    // ACCEPTS: `section[field] || []` — a null array becomes
                    // an empty one before the type check ever runs.
                    let values = (section[field] ?? .null).orEmptyArray
                    guard case .array(let items) = values,
                        items.allSatisfy({ $0.isString })
                    else {
                        throw fail("\(at): \(field) must be an array of strings.")
                    }
                }
            }
        }

        // ACCEPTS: the same falsy-skip as route_sections.
        if let policy = train["route_policy"], policy.isTruthy {
            if policy["mode"] != .string("single_primary_route") {
                throw fail("\(prefix): route_policy.mode must be single_primary_route.")
            }
            guard case .bool = policy["jr_only"] ?? .null else {
                throw fail("\(prefix): route_policy.jr_only must be boolean.")
            }
            // `!== false`, so 0 and absent are both rejected — only the
            // boolean false passes.
            if policy["allow_alternatives"] != .bool(false) {
                throw fail("\(prefix): route_policy.allow_alternatives must be false.")
            }
            if policy["allow_browser_straight_line_fallback"] != .bool(false) {
                throw fail(
                    "\(prefix): route_policy.allow_browser_straight_line_fallback must be false.")
            }
            let allowed = (policy["allowed_institution_type_codes"] ?? .null).orEmptyArray
            // One message covers both "not an array" and "bad code", because
            // the JavaScript joins the two tests with `||`.
            var allowedIsValid = false
            if case .array(let codes) = allowed {
                // ACCEPTS: the membership test is on `String(code)`, so the
                // JSON number 1 is the string "1".
                allowedIsValid = codes.allSatisfy { code in
                    defaultAllowedInstitutionTypeCodes.contains {
                        jsStringEquals($0, jsToString(code))
                    }
                }
            }
            if !allowedIsValid {
                throw fail(
                    "\(prefix): route_policy.allowed_institution_type_codes must contain only N02_002 codes 1/2/3/4/5."
                )
            }
            for field in ["preferred_line_names", "preferred_operator_names"] {
                let values = (policy[field] ?? .null).orEmptyArray
                guard case .array(let items) = values, items.allSatisfy({ $0.isString }) else {
                    throw fail("\(prefix): route_policy.\(field) must be an array of strings.")
                }
            }
            // ACCEPTS: guarded by the value's own truthiness, so "" means
            // "not supplied" rather than "invalid".
            if let mode = policy["institution_filter_mode"], mode.isTruthy,
                mode != .string("soft"), mode != .string("hard")
            {
                throw fail("\(prefix): route_policy.institution_filter_mode must be soft or hard.")
            }
        }

        // ACCEPTS: `train.style?.color` — a `style` that is a string, a
        // number or null yields undefined here rather than an error, and an
        // empty colour is falsy, so all of those skip the check.
        let color = train["style"]?["color"]
        if let color, color.isTruthy, !isValidTrainColor(jsToString(color)) {
            throw fail("\(prefix): style.color must be #RRGGBB.")
        }

        // warnBranchLeak (§6.4) is not ported: it is advisory, console-only,
        // wrapped in its own try/catch, and needs the station index. It
        // cannot change this function's result.
    }

    /// Property access that reproduces JavaScript's `TypeError` on null.
    ///
    /// Reading a property off `null` or `undefined` throws in JavaScript;
    /// reading one off a number, a string or a boolean quietly yields
    /// `undefined`. The validator relies on the second half by accident and
    /// falls over on the first.
    private static func member(_ value: JSON, _ key: String) throws -> JSON {
        if value == .null {
            throw ValidationError(
                kind: .typeError,
                message: "Cannot read properties of null (reading '\(key)')")
        }
        return value[key] ?? .null
    }

    // MARK: - §19: lenient inbound

    /// `parseImportedCanonicalStore` for a pasted string — jsonspec §1.2.
    public static func parseImportedCanonicalStore(text: String) throws -> JSON {
        try parseImportedCanonicalStore(value: JSON.parse(text))
    }

    /// `parseImportedCanonicalStore` for an already-parsed value.
    ///
    /// Three shapes are accepted: a full store, a bare trains array, and a
    /// single train object. The full-store branch is the only one that checks
    /// `schema_version` or applies the key whitelist — which is how a train
    /// object carrying a non-array `trains` key slips past both, since
    /// `Array.isArray` is the only thing that key is ever consulted through.
    public static func parseImportedCanonicalStore(value parsed: JSON) throws -> JSON {
        if case .array = parsed {
            return .object(JSON.Object([("schema_version", .string(schemaVersion)), ("trains", parsed)]))
        }
        guard parsed.isTruthy, case .object = parsed else {
            throw fail("JSON root must be a store object, a trains array, or one train object.")
        }
        if case .array? = parsed["trains"] {
            try assertOnlyKeys(parsed, ["schema_version", "trains"], "Store")
            let version = parsed["schema_version"] ?? .null
            if !acceptedSchemaVersions.contains(where: { version == .string($0) }) {
                throw fail(
                    "schema_version must be one of \(acceptedSchemaVersions.joined(separator: ", "))."
                )
            }
            return parsed
        }
        if parsed["id"]?.isTruthy == true, parsed["stops"]?.isTruthy == true {
            return .object(
                JSON.Object([("schema_version", .string(schemaVersion)), ("trains", .array([parsed]))]))
        }
        throw fail("JSON must contain a trains array, be a trains array, or be a single train object.")
    }

    /// `normalizeImportedStop` — the §7.1 whitelist plus the §18 defaults.
    public static func normalizeImportedStop(_ stop: JSON) throws -> Stop {
        guard stop.isTruthy, case .object = stop else {
            throw fail("Each stop must be an object.")
        }
        try assertOnlyKeys(
            stop,
            [
                "name", "n02_station_code", "platform_number", "arrival", "departure",
                "stop_type", "ride_segment",
            ],
            "Stop")
        // ACCEPTS: the guard is key PRESENCE, not a usable value, so
        // `{"name": null}` imports as a stop with an empty name and is only
        // caught later by validateTrain.
        guard stop.hasOwnKey("name") else { throw fail("Each stop must contain name.") }
        guard isValidPlatformNumber(stop["platform_number"]) else {
            throw fail("platform_number must be a non-negative integer or null.")
        }
        return canonicalStopShape(stop)
    }

    /// `normalizeImportedRouteSection` — §6.1/§6.1b whitelist and defaults.
    ///
    /// §13.4: `from`/`to` are optional, and when absent are resolved from the
    /// codes through the station table, so that name matching, the §6.4
    /// branch checks and the tooltips keep working on a lean stored section.
    public static func normalizeImportedRouteSection(
        _ section: JSON, stations: StationTable = .empty
    ) throws -> RouteSection {
        guard section.isTruthy, case .object = section else {
            throw fail("Each route_section must be an object.")
        }
        try assertOnlyKeys(
            section,
            [
                "from", "to", "from_n02_station_code", "to_n02_station_code",
                "line_names", "operator_names", "number", "name",
            ],
            "Route section")

        let fromCode = (section["from_n02_station_code"] ?? .null).orNullString
        let toCode = (section["to_n02_station_code"] ?? .null).orNullString
        var normalized = RouteSection(
            from: (section["from"] ?? .null).stringOrNilIfFalsy ?? stations.nameForCode(fromCode),
            to: (section["to"] ?? .null).stringOrNilIfFalsy ?? stations.nameForCode(toCode),
            fromN02StationCode: fromCode,
            toN02StationCode: toCode,
            // `Array.isArray(x) ? x.map(String).filter(Boolean) : []` — the
            // import path always produces an array, never an absent field, so
            // these are `?? []` and not left nil. A section that comes back
            // with no hints says "unconstrained" explicitly; leaving the key
            // out would be the export path's shape, not this one's.
            lineNames: mapStringFilterBoolean(section["line_names"]) ?? [],
            operatorNames: mapStringFilterBoolean(section["operator_names"]) ?? [])
        // Optional per-section branch train number / name: some limited
        // expresses run a branch portion under a DIFFERENT 号 (はやぶさ↔こまち,
        // しおかぜ↔いしづち).
        if let number = section["number"], number.isTruthy { normalized.number = jsToString(number) }
        if let name = section["name"], name.isTruthy { normalized.name = jsToString(name) }
        return normalized
    }

    /// `normalizeImportedTrain` — the §3.1 whitelist, then canonical defaults.
    ///
    /// This is a *different* front door from ``validateTrain(_:index:ids:)``
    /// and the two disagree on purpose-looking cases: this one enforces a key
    /// whitelist that the validator never applies, and coerces a numeric
    /// `train_type` to `""` where the validator rejects it outright.
    ///
    /// `country` decides only one thing — whether the company name goes
    /// through the Taiwanese canonicalisation (§3.4).
    public static func normalizeImportedTrain(
        _ train: JSON,
        fallbackDate: String? = nil,
        country: String = "jp",
        stations: StationTable = .empty
    ) throws -> Train {
        guard train.isTruthy, case .object = train else {
            throw fail("Each train must be an object.")
        }
        try assertOnlyKeys(
            train,
            [
                "id", "date", "number", "train_type", "company", "origin", "destination",
                "direction", "visible", "style", "route_policy", "route_sections", "stops",
            ],
            "Train")

        guard let idValue = train["id"], idValue.isTruthy else {
            throw fail("Each train must contain id.")
        }
        let id = jsToString(idValue)
        guard train["number"]?.isTruthy == true else { throw fail("Train \(id) must contain number.") }
        guard train["origin"]?.isTruthy == true else { throw fail("Train \(id) must contain origin.") }
        guard train["destination"]?.isTruthy == true else {
            throw fail("Train \(id) must contain destination.")
        }
        guard case .array(let stops)? = train["stops"], stops.count >= 2 else {
            throw fail("Train \(id) must contain at least 2 stops.")
        }

        return Train(
            id: id,
            date: Dates.normalizeTrainDate(
                Dates.Train(id: id, date: (train["date"] ?? .null).stringOrNilIfNotString),
                fallback: fallbackDate),
            number: jsToString(train["number"] ?? .null),
            // A non-string is dropped rather than coerced — which is exactly
            // where this path and validateTrain part company.
            trainType: (train["train_type"] ?? .null).stringOrNilIfNotString.map(jsTrim) ?? "",
            company: normalizeTrainCompany(train["company"], country: country),
            origin: jsToString(train["origin"] ?? .null),
            destination: jsToString(train["destination"] ?? .null),
            direction: (train["direction"] ?? .null).stringOrNilIfFalsy ?? "down",
            // `!== false`, so 0 and null both mean visible.
            visible: (train["visible"] ?? .null) != .bool(false),
            style: canonicalStyle(train["style"]),
            routePolicy: canonicalRoutePolicy(train["route_policy"]),
            routeSections: try {
                guard case .array(let rows)? = train["route_sections"] else { return [] }
                return try rows.map { try normalizeImportedRouteSection($0, stations: stations) }
            }(),
            stops: try stops.map(normalizeImportedStop))
    }

    /// `normalizeTrainCompany` — trim, then canonicalise for Taiwan only.
    ///
    /// jsonspec §3.4: Taiwanese legacy institution names migrate to the short
    /// forms (臺灣鐵路管理局 → 台鐵), while `operator_names` elsewhere keeps
    /// the full official name. Japan does not go through this at all, so the
    /// same train imports differently depending on the active country.
    public static func normalizeTrainCompany(_ value: JSON?, country: String) -> String {
        let company = (value ?? .null).stringOrNilIfNotString.map(jsTrim) ?? ""
        return country == "tw"
            ? OperatorBranding.normalizeTaiwanCompanyName(company) : company
    }

    // MARK: - §18: the canonical shapes

    /// `canonicalStopShape` — the seven fields, every time.
    public static func canonicalStopShape(_ stop: JSON) -> Stop {
        Stop(
            name: (stop["name"] ?? .null).isTruthy ? jsToString(stop["name"] ?? .null) : "",
            n02StationCode: (stop["n02_station_code"] ?? .null).orNullString,
            platformNumber: platformNumber(stop["platform_number"]),
            arrival: normalizeNullableTime(stop["arrival"]),
            departure: normalizeNullableTime(stop["departure"]),
            stopType: (stop["stop_type"] ?? .null).stringOrNilIfFalsy ?? "passenger_stop",
            rideSegment: (stop["ride_segment"] ?? .null).isTruthy)
    }

    /// `canonicalStopShape` for a stop that is already typed — the export
    /// path calls the same function on its in-memory stops.
    ///
    /// It is not the identity even here: an empty station code collapses to
    /// nil (`stop.n02_station_code || null`), a whitespace-only time collapses
    /// to nil, and an empty `stop_type` becomes `passenger_stop`.
    public static func canonicalStopShape(_ stop: Stop) -> Stop {
        Stop(
            name: stop.name,
            n02StationCode: stop.n02StationCode.flatMap { $0.isEmpty ? nil : $0 },
            platformNumber: stop.platformNumber.flatMap { $0 >= 0 ? $0 : nil },
            arrival: normalizeNullableTime(stop.arrival.map(JSON.string)),
            departure: normalizeNullableTime(stop.departure.map(JSON.string)),
            stopType: stop.stopType.isEmpty ? "passenger_stop" : stop.stopType,
            rideSegment: stop.rideSegment)
    }

    private static func platformNumber(_ value: JSON?) -> Int? {
        guard isValidPlatformNumber(value), case .number(let number)? = value else { return nil }
        return Int(number)
    }

    /// `normalizeNullableTime` — trim, and collapse a blank to null.
    ///
    /// It never parses. A non-string is returned unchanged by the JavaScript,
    /// which is how the number 830 survives import and is then rejected by
    /// the validator; here that shape simply cannot be represented by
    /// `Stop.arrival`, so it becomes nil. The fixture records the JavaScript's
    /// answer for that case and the test reads it as a documented divergence
    /// of the *typed model*, not of the rule.
    public static func normalizeNullableTime(_ value: JSON?) -> String? {
        guard let value, value != .null else { return nil }
        guard case .string(let text) = value else { return nil }
        let trimmed = jsTrim(text)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// `canonicalStyle` — only `color` is per-train now.
    ///
    /// Line width is a global setting and unridden intervals are hidden
    /// entirely, so `weight` / `unridden_opacity` are no longer stored per
    /// train; any inbound values are dropped here (§4.1).
    public static func canonicalStyle(_ style: JSON?) -> TrainStyle {
        let color = style?["color"]
        return TrainStyle(
            color: (color?.isTruthy ?? false) ? jsToString(color!) : defaultTrainColor)
    }

    /// `canonicalRoutePolicy` — every field written, defaults filled.
    public static func canonicalRoutePolicy(_ policy: JSON?) -> RoutePolicy {
        RoutePolicy(
            mode: "single_primary_route",
            // `=== true`, so a truthy 1 becomes false.
            jrOnly: policy?["jr_only"] == .bool(true),
            allowAlternatives: false,
            allowBrowserStraightLineFallback: false,
            allowedInstitutionTypeCodes: {
                // `|| [...DEFAULT]` — note this passes the inbound array
                // through untouched rather than mapping it through String(),
                // unlike the two preferred_* arrays below.
                guard case .array(let codes)? = policy?["allowed_institution_type_codes"],
                    policy?["allowed_institution_type_codes"]?.isTruthy == true
                else { return defaultAllowedInstitutionTypeCodes }
                return codes.map(jsToString)
            }(),
            preferredLineNames: mapStringFilterBoolean(policy?["preferred_line_names"]) ?? [],
            preferredOperatorNames: mapStringFilterBoolean(policy?["preferred_operator_names"]) ?? [],
            institutionFilterMode: (policy?["institution_filter_mode"] ?? .null).stringOrNilIfFalsy
                ?? "soft")
    }

    /// `values.map(String).filter(Boolean)` — nil when the input is not an
    /// array, which is how a non-array becomes `[]` at every call site.
    private static func mapStringFilterBoolean(_ value: JSON?) -> [String]? {
        guard case .array(let items)? = value else { return nil }
        return items.map(jsToString).filter { !$0.isEmpty }
    }

    // MARK: - §18: the export path

    /// The station lookups the export path reaches for through bare globals.
    ///
    /// Injected rather than assumed, because the answer genuinely differs
    /// between "the app has loaded its datasets" and "it has not", and both
    /// are real states — the second is what every boot and every import runs
    /// in until `app-datasets.js` has fetched anything. ``empty`` is that
    /// state, and it is what `port-fixtures/validation.json` was generated
    /// in, which is what makes the export path a pure function of the store.
    public struct StationTable: Sendable {
        /// What `resolveStationForTrain` answered.
        ///
        /// Two levels of "no", because the JavaScript distinguishes them:
        /// `from ? stationCode(from) : fromStop.n02_station_code || null`
        /// falls back to the stop's own code only when NO station resolved.
        /// A station that resolved but carries no code of its own yields
        /// null, and the stop's code is not consulted.
        public enum Resolution: Sendable, Equatable {
            /// `resolveStationForTrain` returned null.
            case unresolved
            /// A station feature, whose own `stationCode` may still be nil.
            case resolved(code: String?)
        }

        /// `stationNameForCode` — `""` when the code is unknown, never nil.
        public var nameForCode: @Sendable (String?) -> String
        /// `resolveStationForTrain(stop, train)`, reduced to its code.
        public var resolveStop: @Sendable (Stop, Train) -> Resolution

        public init(
            nameForCode: @escaping @Sendable (String?) -> String,
            resolveStop: @escaping @Sendable (Stop, Train) -> Resolution
        ) {
            self.nameForCode = nameForCode
            self.resolveStop = resolveStop
        }

        /// No station data loaded.
        public static let empty = StationTable(
            nameForCode: { _ in "" }, resolveStop: { _, _ in .unresolved })
    }

    /// `buildCanonicalTrainStore` — what the export textarea and the server
    /// save both write.
    public static func buildCanonicalTrainStore(
        _ trains: [Train], country: String = "jp", stations: StationTable = .empty
    ) -> TrainStore {
        TrainStore(
            schemaVersion: schemaVersion,
            trains: trains.map { normalizeExportTrain($0, country: country, stations: stations) })
    }

    /// `normalizeExportTrain`.
    ///
    /// Route geometry is deliberately not persisted: it is cached in
    /// IndexedDB and re-solved on a miss, and embedding it here was about
    /// 96 % of the file.
    public static func normalizeExportTrain(
        _ train: Train, country: String = "jp", stations: StationTable = .empty
    ) -> Train {
        Train(
            id: train.id,
            date: Dates.normalizeTrainDate(
                Dates.Train(id: train.id, date: train.date)),
            number: train.number,
            trainType: train.trainType ?? "",
            company: normalizeTrainCompany(train.company.map(JSON.string), country: country),
            origin: train.origin,
            destination: train.destination,
            direction: (train.direction?.isEmpty == false) ? train.direction : "down",
            visible: train.visible != false,
            style: canonicalStyle(train.style.map { .object(JSON.Object([("color", $0.color.map(JSON.string) ?? .null)])) }),
            routePolicy: canonicalRoutePolicy(routePolicyJSON(train.routePolicy)),
            routeSections: rideRouteSections(for: train, stations: stations)
                .map { leanExportSection($0, stations: stations) },
            stops: train.stops.map(canonicalStopShape),
            // Carried, not derived. `region` is this app's own field (see
            // `Train.region`) and the export is the only path to disk, so
            // dropping it here would lose the answer on every save and make
            // every load re-derive it.
            region: train.region)
    }

    /// `getRideRouteSectionsForTrain` — one section per adjacent stop pair.
    ///
    /// jsonspec §6.3/§18: the section list is *recomputed* from the stops on
    /// every export, and an already-written section is reused only when it
    /// matches that stop pair. That is what keeps a hand-edited stop list and
    /// its sections from drifting apart.
    static func rideRouteSections(for train: Train, stations: StationTable) -> [RouteSection] {
        let stops = train.stops
        let sections = train.routeSections ?? []
        var calculated: [RouteSection] = []
        for index in 0..<max(stops.count - 1, 0) {
            let fromStop = stops[index]
            let toStop = stops[index + 1]
            if let existing = findRouteSection(sections, fromStop, toStop, preferring: index) {
                calculated.append(normalizeExportRouteSection(existing))
                continue
            }
            let endpointCode = { (stop: Stop) -> String? in
                switch stations.resolveStop(stop, train) {
                case .resolved(let code): code
                case .unresolved: stop.n02StationCode.flatMap { $0.isEmpty ? nil : $0 }
                }
            }
            calculated.append(
                RouteSection(
                    from: fromStop.name,
                    to: toStop.name,
                    fromN02StationCode: endpointCode(fromStop),
                    toN02StationCode: endpointCode(toStop)))
        }
        return calculated
    }

    /// `findRouteSectionForStopPair` — the section at the same index if it
    /// matches, otherwise the first one anywhere that does.
    private static func findRouteSection(
        _ sections: [RouteSection], _ fromStop: Stop, _ toStop: Stop, preferring index: Int
    ) -> RouteSection? {
        if index < sections.count, matches(sections[index], fromStop, toStop) {
            return sections[index]
        }
        return sections.first { matches($0, fromStop, toStop) }
    }

    /// `routeSectionMatchesStopPair`.
    ///
    /// An official station code is line/operator-specific, so a stop may be
    /// displayed with one line's code while the section intentionally uses
    /// another for the same physical transfer point. A same-name adjacent
    /// pair therefore counts as the same section rather than forcing the two
    /// codes to be identical.
    private static func matches(_ section: RouteSection, _ fromStop: Stop, _ toStop: Stop) -> Bool {
        let fromCode = fromStop.n02StationCode.flatMap { $0.isEmpty ? nil : $0 }
        let toCode = toStop.n02StationCode.flatMap { $0.isEmpty ? nil : $0 }
        let sectionFrom = section.fromN02StationCode.flatMap { $0.isEmpty ? nil : $0 }
        let sectionTo = section.toN02StationCode.flatMap { $0.isEmpty ? nil : $0 }
        let codeMatches =
            if let fromCode, let toCode, let sectionFrom, let sectionTo {
                jsStringEquals(fromCode, sectionFrom) && jsStringEquals(toCode, sectionTo)
            } else { false }
        let nameMatches =
            !fromStop.name.isEmpty && !toStop.name.isEmpty
            && jsStringEquals(fromStop.name, section.from ?? "")
            && jsStringEquals(toStop.name, section.to ?? "")
        return codeMatches || nameMatches
    }

    /// `normalizeExportRouteSection` — names default to `""`, hint arrays are
    /// kept only when non-empty.
    private static func normalizeExportRouteSection(_ section: RouteSection) -> RouteSection {
        var normalized = RouteSection(
            from: section.from ?? "",
            to: section.to ?? "",
            fromN02StationCode: section.fromN02StationCode.flatMap { $0.isEmpty ? nil : $0 },
            toN02StationCode: section.toN02StationCode.flatMap { $0.isEmpty ? nil : $0 })
        if let lines = section.lineNames, !lines.isEmpty { normalized.lineNames = lines }
        if let operators = section.operatorNames, !operators.isEmpty {
            normalized.operatorNames = operators
        }
        if let number = section.number, !number.isEmpty { normalized.number = number }
        if let name = section.name, !name.isEmpty { normalized.name = name }
        return normalized
    }

    /// `leanExportSection` — drop an endpoint name the code can reconstruct.
    ///
    /// jsonspec §13.4: the station name is a per-station constant, kept once
    /// on the stop, so repeating it in every section only bloats the archive.
    /// A name with no code, or one that *disagrees* with the code's
    /// authoritative name (an alias or a deliberate override), is kept —
    /// which is why the empty station table keeps all of them.
    private static func leanExportSection(_ section: RouteSection, stations: StationTable)
        -> RouteSection
    {
        let fromCode = section.fromN02StationCode.flatMap { $0.isEmpty ? nil : $0 }
        let toCode = section.toN02StationCode.flatMap { $0.isEmpty ? nil : $0 }
        var out = RouteSection(fromN02StationCode: fromCode, toN02StationCode: toCode)
        if let from = section.from, !from.isEmpty,
            fromCode == nil || !jsStringEquals(stations.nameForCode(fromCode), from)
        {
            out.from = from
        }
        if let to = section.to, !to.isEmpty,
            toCode == nil || !jsStringEquals(stations.nameForCode(toCode), to)
        {
            out.to = to
        }
        if let lines = section.lineNames, !lines.isEmpty { out.lineNames = lines }
        if let operators = section.operatorNames, !operators.isEmpty { out.operatorNames = operators }
        if let number = section.number, !number.isEmpty { out.number = number }
        if let name = section.name, !name.isEmpty { out.name = name }
        return out
    }

    /// Re-projects a typed policy into the dynamic form
    /// ``canonicalRoutePolicy(_:)`` reads, so that the one implementation of
    /// the defaulting rule serves both the import and the export path — which
    /// is the property app-store-ops.js §18 exists to have.
    private static func routePolicyJSON(_ policy: RoutePolicy?) -> JSON? {
        guard let policy else { return nil }
        var pairs: [(String, JSON)] = []
        if let mode = policy.mode { pairs.append(("mode", .string(mode))) }
        if let jrOnly = policy.jrOnly { pairs.append(("jr_only", .bool(jrOnly))) }
        if let value = policy.allowAlternatives { pairs.append(("allow_alternatives", .bool(value))) }
        if let value = policy.allowBrowserStraightLineFallback {
            pairs.append(("allow_browser_straight_line_fallback", .bool(value)))
        }
        if let codes = policy.allowedInstitutionTypeCodes {
            pairs.append(("allowed_institution_type_codes", .array(codes.map(JSON.string))))
        }
        if let names = policy.preferredLineNames {
            pairs.append(("preferred_line_names", .array(names.map(JSON.string))))
        }
        if let names = policy.preferredOperatorNames {
            pairs.append(("preferred_operator_names", .array(names.map(JSON.string))))
        }
        if let mode = policy.institutionFilterMode {
            pairs.append(("institution_filter_mode", .string(mode)))
        }
        return .object(JSON.Object(pairs))
    }

    // MARK: - makeUniqueTrainId

    /// `makeUniqueTrainId` — `odr_001`, then `odr_001-2`, `odr_001-3`, …
    ///
    /// jsonspec §3.2/§11.2: import always appends, so a colliding id is
    /// renamed rather than refused. A blank base becomes `"train"`.
    public static func makeUniqueTrainId(_ baseID: String?, existingIDs: Set<String>) -> String {
        let trimmed = jsTrim(baseID ?? "train")
        // `String(baseId || "train").trim() || "train"` — the second fallback
        // is what catches a base that was only whitespace.
        let cleanBase = trimmed.isEmpty ? "train" : trimmed
        var id = cleanBase
        var counter = 2
        while existingIDs.contains(id) {
            id = "\(cleanBase)-\(counter)"
            counter += 1
        }
        return id
    }
}

// MARK: - the dynamic JSON value

extension TrainValidation {

    /// A JSON value that keeps its object keys in JavaScript's own order.
    ///
    /// A `[String: JSON]` would be wrong twice over. Order first:
    /// ``assertOnlyKeys(_:_:_:)`` throws on the *first* unsupported key, so
    /// the order decides which key the error names, and a Swift dictionary
    /// has none. Equality second: `Dictionary` keys compare by canonical
    /// equivalence, so two keys JavaScript keeps apart would collide.
    public indirect enum JSON: Equatable, Sendable {
        case null
        case bool(Bool)
        case number(Double)
        case string(String)
        case array([JSON])
        case object(Object)

        /// `===`, not Swift's `==`.
        ///
        /// Written out rather than synthesised so that two strings compare by
        /// UTF-16 code unit. Every `!==` in the validator that this stands in
        /// for compares against an ASCII literal today, but the values on the
        /// left are station names and imported text, and the day one of them
        /// arrives decomposed a synthesised `==` would start answering true
        /// where the app answers false.
        public static func == (lhs: JSON, rhs: JSON) -> Bool {
            switch (lhs, rhs) {
            case (.null, .null): true
            case let (.bool(a), .bool(b)): a == b
            // NaN is not equal to itself in JavaScript either, and `==` on
            // Double already agrees.
            case let (.number(a), .number(b)): a == b
            case let (.string(a), .string(b)): TrainValidation.jsStringEquals(a, b)
            case let (.array(a), .array(b)): a == b
            case let (.object(a), .object(b)): a == b
            default: false
            }
        }

        /// An insertion-ordered object with JavaScript's `OwnPropertyKeys`
        /// ordering already applied.
        public struct Object: Equatable, Sendable {
            /// Keys in `Object.keys` order — see ``init(_:)``.
            public private(set) var keys: [String]
            private var values: [JSON]

            /// Applies JavaScript's own key ordering: every **array-index**
            /// key first, in ascending numeric order, then all remaining keys
            /// in insertion order. That is why
            /// `{"zebra":1,"2":1,"10":1,"1":1}` reports `"1"` as its first
            /// key, not `"zebra"` and not `"10"`.
            ///
            /// A repeated key keeps the position of its first appearance and
            /// takes the value of its last, which is what `JSON.parse` does.
            public init(_ pairs: [(String, JSON)]) {
                var orderedKeys: [String] = []
                var orderedValues: [JSON] = []
                for (key, value) in pairs {
                    if let existing = orderedKeys.firstIndex(where: {
                        TrainValidation.jsStringEquals($0, key)
                    }) {
                        orderedValues[existing] = value
                    } else {
                        orderedKeys.append(key)
                        orderedValues.append(value)
                    }
                }
                // A stable partition, so the non-index keys keep their order.
                let indexed = orderedKeys.indices.filter { Object.arrayIndex(orderedKeys[$0]) != nil }
                    .sorted { Object.arrayIndex(orderedKeys[$0])! < Object.arrayIndex(orderedKeys[$1])! }
                let rest = orderedKeys.indices.filter { Object.arrayIndex(orderedKeys[$0]) == nil }
                let order = indexed + rest
                keys = order.map { orderedKeys[$0] }
                values = order.map { orderedValues[$0] }
            }

            /// An "array index" in the ECMAScript sense: the canonical
            /// decimal spelling of an integer in 0…2³²−2. `"01"`, `"-1"` and
            /// `"1.0"` are ordinary string keys.
            private static func arrayIndex(_ key: String) -> UInt32? {
                let units = Array(key.utf16)
                guard !units.isEmpty, units.count <= 10,
                    units.allSatisfy({ $0 >= 48 && $0 <= 57 })
                else { return nil }
                if units.count > 1 && units[0] == 48 { return nil }  // no leading zero
                // An array index is 0 ≤ i < 2³²−1, so the largest one is 4294967294.
                guard let value = UInt32(key), value < UInt32.max else { return nil }
                return value
            }

            public subscript(key: String) -> JSON? {
                guard
                    let index = keys.firstIndex(where: { TrainValidation.jsStringEquals($0, key) })
                else { return nil }
                return values[index]
            }

            public static func == (lhs: Object, rhs: Object) -> Bool {
                lhs.keys.count == rhs.keys.count
                    && zip(lhs.keys, rhs.keys).allSatisfy(TrainValidation.jsStringEquals)
                    && lhs.values == rhs.values
            }
        }

        /// Property access. Non-objects have no properties, which is exactly
        /// what JavaScript reports for a number, a string or a boolean —
        /// `null` is the one that throws, and that is handled at the two call
        /// sites that reach it.
        public subscript(key: String) -> JSON? {
            guard case .object(let object) = self else { return nil }
            return object[key]
        }

        /// `Object.keys(value)` — empty for everything that is not an object.
        public var ownKeys: [String] {
            switch self {
            case .object(let object): object.keys
            // `Object.keys(["a","b"])` is ["0","1"], which is how an array
            // handed to assertOnlyKeys reports "0" as an unsupported field.
            case .array(let items): items.indices.map(String.init)
            default: []
            }
        }

        public func hasOwnKey(_ key: String) -> Bool {
            guard case .object(let object) = self else { return false }
            return object[key] != nil
        }

        /// JavaScript truthiness: `false`, `0`, `-0`, `NaN`, `""` and `null`
        /// are falsy, everything else — including `[]` and `{}` — is truthy.
        public var isTruthy: Bool {
            switch self {
            case .null: false
            case .bool(let value): value
            case .number(let value): !(value == 0 || value.isNaN)
            case .string(let value): !value.isEmpty
            case .array, .object: true
            }
        }

        public var isString: Bool { if case .string = self { return true } else { return false } }

        /// `value || []`, for the several places the JavaScript writes it.
        var orEmptyArray: JSON { isTruthy ? self : .array([]) }

        /// `value || null`, coerced to a string — the shape the code fields
        /// take (`section.from_n02_station_code || null`).
        var orNullString: String? { isTruthy ? TrainValidation.jsToString(self) : nil }

        /// The value as a string when it is a truthy string, else nil — the
        /// shape behind `x.name || fallback`.
        var stringOrNilIfFalsy: String? {
            if case .string(let value) = self, !value.isEmpty { return value }
            return nil
        }

        /// The value as a string when it *is* a string, else nil — the shape
        /// behind `typeof x === "string" ? … : …`, where an empty string is
        /// still a string.
        var stringOrNilIfNotString: String? {
            if case .string(let value) = self { return value }
            return nil
        }
    }

    /// ECMAScript `String(value)`.
    ///
    /// `JSNumber.string` rather than Swift's own `description`, because
    /// JavaScript prints an integral number without a fractional part — the
    /// number `123456` has to spell `"123456"` to be recognised as a
    /// six-digit station code, where `String(123456.0)` would give
    /// `"123456.0"` and it would not.
    static func jsToString(_ value: JSON) -> String {
        switch value {
        case .null: "null"
        case .bool(let flag): flag ? "true" : "false"
        case .number(let number): JSNumber.string(number)
        case .string(let text): text
        // Array#toString joins with "," and spells null/undefined as "".
        case .array(let items):
            items.map { $0 == .null ? "" : jsToString($0) }.joined(separator: ",")
        case .object: "[object Object]"
        }
    }
}

// MARK: - reading and writing JSON text

extension TrainValidation.JSON {

    /// `JSON.parse`, preserving key order.
    ///
    /// Hand-written rather than `JSONSerialization` because the order of an
    /// object's keys has to survive, and neither `JSONSerialization` nor
    /// `JSONDecoder` keeps it.
    public static func parse(_ text: String) throws -> TrainValidation.JSON {
        var parser = Parser(Array(text.utf8))
        let value = try parser.parseValue()
        try parser.skipWhitespace()
        guard parser.isAtEnd else { throw parser.error("Unexpected non-whitespace character after JSON") }
        return value
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0

        init(_ bytes: [UInt8]) { self.bytes = bytes }

        var isAtEnd: Bool { index >= bytes.count }

        func error(_ message: String) -> TrainValidation.ValidationError {
            TrainValidation.ValidationError(
                kind: .syntaxError, message: "\(message) at position \(index)")
        }

        mutating func skipWhitespace() throws {
            while index < bytes.count {
                switch bytes[index] {
                case 0x20, 0x09, 0x0A, 0x0D: index += 1
                default: return
                }
            }
        }

        mutating func parseValue() throws -> TrainValidation.JSON {
            try skipWhitespace()
            guard index < bytes.count else { throw error("Unexpected end of JSON input") }
            switch bytes[index] {
            case UInt8(ascii: "{"): return try parseObject()
            case UInt8(ascii: "["): return try parseArray()
            case UInt8(ascii: "\""): return .string(try parseString())
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            default: return .number(try parseNumber())
            }
        }

        mutating func expect(_ literal: String) throws {
            for byte in literal.utf8 {
                guard index < bytes.count, bytes[index] == byte else {
                    throw error("Unexpected token")
                }
                index += 1
            }
        }

        mutating func parseObject() throws -> TrainValidation.JSON {
            index += 1  // {
            var pairs: [(String, TrainValidation.JSON)] = []
            try skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(TrainValidation.JSON.Object(pairs))
            }
            while true {
                try skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else {
                    throw error("Expected property name or '}' in JSON")
                }
                let key = try parseString()
                try skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else {
                    throw error("Expected ':' after property name in JSON")
                }
                index += 1
                pairs.append((key, try parseValue()))
                try skipWhitespace()
                guard index < bytes.count else { throw error("Unexpected end of JSON input") }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "}") {
                    index += 1
                    return .object(TrainValidation.JSON.Object(pairs))
                }
                throw error("Expected ',' or '}' after property value in JSON")
            }
        }

        mutating func parseArray() throws -> TrainValidation.JSON {
            index += 1  // [
            var items: [TrainValidation.JSON] = []
            try skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(items)
            }
            while true {
                items.append(try parseValue())
                try skipWhitespace()
                guard index < bytes.count else { throw error("Unexpected end of JSON input") }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "]") {
                    index += 1
                    return .array(items)
                }
                throw error("Expected ',' or ']' after array element in JSON")
            }
        }

        mutating func parseString() throws -> String {
            index += 1  // opening quote
            var units: [UInt16] = []
            var literal: [UInt8] = []
            func flushLiteral() {
                guard !literal.isEmpty else { return }
                units.append(contentsOf: Array(String(decoding: literal, as: UTF8.self).utf16))
                literal.removeAll(keepingCapacity: true)
            }
            while index < bytes.count {
                let byte = bytes[index]
                if byte == UInt8(ascii: "\"") {
                    index += 1
                    flushLiteral()
                    // A lone surrogate cannot live in a Swift String; JSON
                    // text produced by this project never contains one, and
                    // substituting U+FFFD is what String(decoding:) would do
                    // anyway.
                    return String(decoding: units, as: UTF16.self)
                }
                if byte == UInt8(ascii: "\\") {
                    flushLiteral()
                    index += 1
                    guard index < bytes.count else { throw error("Unexpected end of JSON input") }
                    let escape = bytes[index]
                    index += 1
                    switch escape {
                    case UInt8(ascii: "\""): units.append(0x22)
                    case UInt8(ascii: "\\"): units.append(0x5C)
                    case UInt8(ascii: "/"): units.append(0x2F)
                    case UInt8(ascii: "b"): units.append(0x08)
                    case UInt8(ascii: "f"): units.append(0x0C)
                    case UInt8(ascii: "n"): units.append(0x0A)
                    case UInt8(ascii: "r"): units.append(0x0D)
                    case UInt8(ascii: "t"): units.append(0x09)
                    case UInt8(ascii: "u"):
                        guard index + 4 <= bytes.count else {
                            throw error("Bad Unicode escape in JSON")
                        }
                        var unit: UInt16 = 0
                        for offset in 0..<4 {
                            let digit = bytes[index + offset]
                            let value: UInt16
                            switch digit {
                            case 0x30...0x39: value = UInt16(digit - 0x30)
                            case 0x41...0x46: value = UInt16(digit - 0x41 + 10)
                            case 0x61...0x66: value = UInt16(digit - 0x61 + 10)
                            default: throw error("Bad Unicode escape in JSON")
                            }
                            unit = unit << 4 | value
                        }
                        index += 4
                        units.append(unit)
                    default: throw error("Bad escaped character in JSON")
                    }
                    continue
                }
                literal.append(byte)
                index += 1
            }
            throw error("Unterminated string in JSON")
        }

        mutating func parseNumber() throws -> Double {
            let start = index
            if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
            while index < bytes.count {
                switch bytes[index] {
                case 0x30...0x39, UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E"),
                    UInt8(ascii: "+"), UInt8(ascii: "-"):
                    index += 1
                default:
                    guard start < index,
                        let value = Double(String(decoding: bytes[start..<index], as: UTF8.self))
                    else { throw error("Unexpected token") }
                    return value
                }
            }
            guard start < index,
                let value = Double(String(decoding: bytes[start..<index], as: UTF8.self))
            else { throw error("Unexpected end of JSON input") }
            return value
        }
    }

    /// `JSON.stringify` with the keys sorted — the canonical spelling both
    /// sides compare on.
    ///
    /// Sorted because Swift's `Codable` emits no defined key order, so a
    /// byte-for-byte round-trip check has to canonicalise one. The sort is
    /// JavaScript's own: `Array.prototype.sort` with no comparator compares
    /// by UTF-16 code unit, not by canonical equivalence.
    public var canonicalText: String {
        switch self {
        case .null: "null"
        case .bool(let flag): flag ? "true" : "false"
        case .number(let value): JSNumber.string(value)
        case .string(let text): TrainValidation.JSON.quote(text)
        case .array(let items): "[" + items.map(\.canonicalText).joined(separator: ",") + "]"
        case .object(let object):
            "{"
                + object.keys
                .sorted { a, b in
                    // Strictly less by UTF-16 code unit: `a <= b && !(b <= a)`.
                    JSNumber.stringLessOrEqual(a, b) && !JSNumber.stringLessOrEqual(b, a)
                }
                .map { "\(TrainValidation.JSON.quote($0)):\(object[$0]!.canonicalText)" }
                .joined(separator: ",") + "}"
        }
    }

    /// `JSON.stringify` of a string: only `"`, `\` and the C0 controls are
    /// escaped. Non-ASCII is emitted as-is, which is what makes a CJK station
    /// name one token rather than six escapes.
    ///
    /// Built as UTF-16 units and converted once at the end, rather than a
    /// scalar at a time: a character outside the BMP is a surrogate PAIR, and
    /// converting each half on its own turns it into two replacement
    /// characters.
    private static func quote(_ text: String) -> String {
        var units: [UInt16] = [0x22]
        func append(_ escape: String) { units.append(contentsOf: Array(escape.utf16)) }
        for unit in text.utf16 {
            switch unit {
            case 0x22: append("\\\"")
            case 0x5C: append("\\\\")
            case 0x08: append("\\b")
            case 0x0C: append("\\f")
            case 0x0A: append("\\n")
            case 0x0D: append("\\r")
            case 0x09: append("\\t")
            case 0..<0x20: append(String(format: "\\u%04x", unit))
            default: units.append(unit)
            }
        }
        units.append(0x22)
        return String(decoding: units, as: UTF16.self)
    }
}
