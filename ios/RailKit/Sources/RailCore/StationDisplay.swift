import Foundation

/// Which station marks the map draws, where, and what they are called.
///
/// Three functions, one file, because they are the same question asked of
/// three collections and they share every hazard:
///
///   - ``buildPopupModel(network:stationID:lineIDFallback:naming:)`` —
///     `railmap-popup.js`'s C5 bilingual hover popup MODEL: given a station,
///     which lines call there, in what order, with what label, company and
///     badge. The HTML is the shell's problem and is not here.
///   - ``stationLabelWinners(_:)`` — `rail-network.js`'s station-label
///     election, which decides that 東京 is named ONCE rather than nine times.
///   - ``markerLabelWinners(_:)`` and ``markerRecordsToFC(_:)`` — the same
///     election again over a RIDE's own station dots, plus the three role
///     tiers that decide which of a ride's stations are named at all.
///
/// **This is a string problem before it is a geometry problem.** Every
/// judgement below is "is this the same name / the same line / the same
/// place", and JavaScript answers the first two by UTF-16 code unit while
/// Swift's `String` — and therefore `Dictionary`, `Set` and `==` — answers by
/// canonical equivalence. The shipped `jp` package spells 笹塚 with U+FA10 CJK
/// COMPATIBILITY IDEOGRAPH-585A, the only non-NFC name among 10,361, so the
/// two languages genuinely disagree about a name a passenger can type. Every
/// table here is keyed on ``CodeUnits`` and every name comparison is written
/// out longhand, for the same reason `Stations.swift` is.
///
/// **The second hazard is ordering.** `Array.prototype.sort` has been stable
/// since ES2019 and Swift's `sort` is not guaranteed to be. Twelve real
/// station popups list two rows carrying the SAME label — 米原 shows
/// 東海道線 (Tokaido Line) twice, from JR Central's two strokes — so the tie
/// is not hypothetical, and the group's member order is what breaks it. The
/// sort below is made stable by hand.
public enum StationDisplay {

    // MARK: - The slice of the network these three functions read

    /// `buildNetworkFromCompactPackage`, as far as station display needs it.
    ///
    /// The whole builder is not ported: this is its `lineById`, `stationById`,
    /// `groupMembers` and the `minz` of each station feature, which is
    /// everything the popup and the label election touch. Geometry, service
    /// splits, interchange counts and the drawn line features belong to other
    /// ports (`DisplayParts`, `RouteFeature`) and are not rebuilt here.
    ///
    /// Two fields come in separately because ``CompactPackage``'s decoder does
    /// not carry them and this file may not change it: `isLoop`, which decides
    /// whether a line has terminals at all, and the `logo` flag, which the
    /// builder turns into a path.
    public struct Network: Sendable {

        /// One entry of `lineById`.
        public struct Line: Sendable, Equatable {
            public let lineID: String
            public let name: String
            public let nameRoma: String?
            public let `operator`: String?
            /// `compactLine.color || DEFAULT_LINE_COLOR` — a `||`, so an
            /// EMPTY colour string falls through to the default as well.
            public let color: String
            /// The package's own badge, as a path. nil where the package
            /// carries no artwork for the line.
            public let logo: String?
            public let isLoop: Bool
            /// The line's own length-derived minimum zoom, which its two
            /// terminals inherit.
            public let minZoom: Int
        }

        /// One entry of `stationById`, plus the `minz` its map feature carries.
        public struct Station: Sendable, Equatable {
            /// `${lineId}:${row[0]}` — per (line, station), NOT per place.
            public let stationID: String
            /// `row[0]`, the code every platform of one complex shares.
            public let stationGroupID: String
            public let name: String
            public let nameRoma: String?
            public let lineIndex: Int
            public let coordinate: Coordinate
            /// A non-loop line's two endpoints are structural and follow the
            /// complete line exactly; intermediate stations keep the denser
            /// spacing-based level of detail and may appear several zoom
            /// levels later.
            public let isTerminal: Bool
            public let minZoom: Int
        }

        public let lines: [Line]
        /// In `stationFeatures` order: package line order, then station order
        /// within each line. Both elections depend on it.
        public let stations: [Station]

        private let lineIndexByID: [CodeUnits: Int]
        private let stationIndexByID: [CodeUnits: Int]
        /// `groupMembers` — group key → station positions, in insertion order.
        /// That order is the popup's row order before the label sort, and the
        /// sort is stable, so it survives into the drawn popup.
        private let groupMemberIndices: [CodeUnits: [Int]]

        /// `#7C8A82` — the colour a line with none of its own is drawn in.
        public static let defaultLineColor = "#7C8A82"

        public init(
            package: CompactPackage,
            loopLineIDs: Set<String> = [],
            packageLogoLineIDs: Set<String> = []
        ) {
            // Both ladders come from the already-ported `Visibility`, which
            // reproduces the asymmetry the JavaScript is deliberate about: a
            // line's own zoom is decided by its whole visibility GROUP's
            // length, while its station density is decided by its own.
            let lineMinZoom = Visibility.minZoomByLineId(package)
            let densityMinZoom = Visibility.stationMinZoomByLineId(package)

            var lines: [Line] = []
            var stations: [Station] = []
            var lineIndexByID: [CodeUnits: Int] = [:]
            var stationIndexByID: [CodeUnits: Int] = [:]
            var groupMemberIndices: [CodeUnits: [Int]] = [:]

            for packageLine in package.lines {
                let lineZoom = lineMinZoom[packageLine.id] ?? 0
                let stationZoom = densityMinZoom[packageLine.id] ?? 0
                let isLoop = loopLineIDs.contains(packageLine.id)
                let lineIndex = lines.count
                lines.append(
                    Line(
                        lineID: packageLine.id,
                        name: packageLine.name,
                        nameRoma: packageLine.nameRoma,
                        operator: packageLine.operator,
                        color: firstTruthy(packageLine.color) ?? Self.defaultLineColor,
                        logo: packageLogoLineIDs.contains(packageLine.id)
                            ? "/rail/logos/\(Self.badgeIDForLine(packageLine.id)).png"
                            : nil,
                        isLoop: isLoop,
                        minZoom: lineZoom))
                // `lineById.set` — last writer wins on a duplicate id, which
                // is a package question rather than a display one.
                lineIndexByID[CodeUnits(packageLine.id)] = lineIndex

                let stationCount = packageLine.stations.count
                for (index, station) in packageLine.stations.enumerated() {
                    let isTerminal =
                        !isLoop && (index == 0 || index == stationCount - 1)
                    let stationID = "\(packageLine.id):\(station.id)"
                    let position = stations.count
                    stations.append(
                        Station(
                            stationID: stationID,
                            stationGroupID: station.id,
                            name: station.name,
                            nameRoma: station.nameRoma,
                            lineIndex: lineIndex,
                            coordinate: station.coordinate,
                            isTerminal: isTerminal,
                            minZoom: isTerminal ? lineZoom : stationZoom))
                    stationIndexByID[CodeUnits(stationID)] = position

                    let key = CodeUnits(Self.groupKey(groupID: station.id, stationID: stationID))
                    groupMemberIndices[key, default: []].append(position)
                }
            }

            self.lines = lines
            self.stations = stations
            self.lineIndexByID = lineIndexByID
            self.stationIndexByID = stationIndexByID
            self.groupMemberIndices = groupMemberIndices
        }

        /// `station.stationGroupId || "solo:" + station.stationId`.
        ///
        /// A `||`, so an EMPTY group code takes the solo key too. No shipped
        /// package has one — all 12,685 stations carry a group — but the
        /// branch is the difference between a station complex and a station.
        static func groupKey(groupID: String, stationID: String) -> String {
            groupID.utf16.isEmpty ? "solo:\(stationID)" : groupID
        }

        /// Which railway's artwork a stroke wears: `lineId` with any trailing
        /// run of `-2` / `-p1` suffixes peeled off.
        ///
        /// A split part is the SAME railway as its parent and has no badge of
        /// its own — the art is named after the railway, not the stroke — and
        /// `-p1` is the same story for a paired alignment. Both can stack
        /// (日豊線's 立石 pair is `日豊線-2-p1`), which is why the JavaScript's
        /// `/(?:-p?\d+)+$/` peels repeatedly; taking one suffix off leaves
        /// `日豊線-2`, a badge that was never drawn either.
        static func badgeIDForLine(_ lineID: String) -> String {
            var units = Array(lineID.utf16)
            while true {
                var end = units.count
                // one `-p?\d+` group, scanned right to left
                var digits = 0
                while end - digits > 0, isASCIIDigit(units[end - digits - 1]) { digits += 1 }
                guard digits > 0 else { break }
                var start = end - digits
                if start > 0, units[start - 1] == 0x70 { start -= 1 }  // "p"
                guard start > 0, units[start - 1] == 0x2D else { break }  // "-"
                start -= 1
                units.removeSubrange(start..<end)
                end = start
            }
            return String(decoding: units, as: UTF16.self)
        }

        public func line(id: String) -> Line? {
            lineIndexByID[CodeUnits(id)].map { lines[$0] }
        }

        public func lineIndex(id: String) -> Int? { lineIndexByID[CodeUnits(id)] }

        public func station(id: String) -> Station? {
            stationIndexByID[CodeUnits(id)].map { stations[$0] }
        }

        /// The positions of every platform filed under one station's group,
        /// in the order the builder pushed them.
        public func groupMembers(ofStationID stationID: String) -> [Int] {
            let station = self.station(id: stationID)
            let key = Self.groupKey(
                groupID: station?.stationGroupID ?? "", stationID: stationID)
            return groupMemberIndices[CodeUnits(key)] ?? []
        }
    }

    // MARK: - The popup model

    /// The app's i18n layer, as `buildPopupModel` reaches for it.
    ///
    /// Two independent optional functions rather than one protocol, because
    /// the JavaScript tests `typeof I18N.stationName === "function"` and
    /// `typeof I18N.nameReadingsList === "function"` SEPARATELY — an object
    /// carrying one and not the other is a reachable state, and it produces a
    /// popup with a localized name and no readings at all.
    ///
    /// WHICH of the four languages a name is shown in, and whether a reading
    /// subline is enabled, is a display preference that belongs to
    /// ``Localization`` and is already ported; what belongs here is only which
    /// two arguments this popup hands over. Note the second one: it is the
    /// STATION ID (`lineId:groupCode`), not an official station code, so the
    /// reading table's by-code lookup misses and its by-name lookup answers.
    public struct Naming: Sendable {
        public var stationName: (@Sendable (String, String) -> String)?
        public var nameReadingsList: (@Sendable (String, String) -> [String])?

        public init(
            stationName: (@Sendable (String, String) -> String)? = nil,
            nameReadingsList: (@Sendable (String, String) -> [String])? = nil
        ) {
            self.stationName = stationName
            self.nameReadingsList = nameReadingsList
        }

        /// The app's own wiring: both functions, answered by `Localization`.
        public static func localized(_ localization: Localization) -> Naming {
            Naming(
                stationName: { name, code in localization.stationName(name, code: code) },
                nameReadingsList: { name, code in
                    localization.nameReadingsList(name, code: code)
                })
        }
    }

    /// One line's row in the popup.
    public struct PopupRow: Sendable, Equatable {
        public let lineID: String
        /// The short company label, or "" when the line's name already begins
        /// with it — so a popup reads 東急東横線 rather than 東急 東急東横線.
        public let company: String
        /// `name (nameRoma)`, or just the name when there is no romanisation.
        public let label: String
        public let color: String
        public let logo: String?
        public let logoNeedsDarkMatte: Bool
    }

    public struct PopupModel: Sendable, Equatable {
        public let name: String
        public let nameRoma: String
        /// `nil` is the standalone railmap, with no app i18n at all: the shell
        /// then falls back to a single `nameRoma` subline. `[]` is the app
        /// with every reading toggle turned off, which means NO subline. The
        /// two are different answers and the shell draws them differently.
        public let readings: [String]?
        public let lines: [PopupRow]
    }

    /// Every line through the hovered platform's station complex, deduped.
    ///
    /// A canonical railway can be stored as several drawable strokes (main,
    /// branch, rejoin, or a paired alignment). At a shared station those
    /// records are still ONE passenger-facing line, so the dedupe is keyed on
    /// the displayed operator + name rather than on the internal stroke id.
    /// Railway identity is deliberately not used: it may join differently
    /// named through railways for lane continuity (東北線 → 東海道線 at 東京),
    /// and both names must stay visible to passengers.
    ///
    /// - Parameter lineIDFallback: added only when the group produced no rows
    ///   at all — a station that is somehow in the map source but not in the
    ///   network still names the line the pointer is over.
    public static func buildPopupModel(
        network: Network,
        stationID: String,
        lineIDFallback: String? = nil,
        naming: Naming = Naming()
    ) -> PopupModel {
        let station = network.station(id: stationID)
        let members = network.groupMembers(ofStationID: stationID)

        var rows: [PopupRow] = []
        var seen = Set<CodeUnits>()
        func add(lineIndex: Int?) {
            guard let lineIndex else { return }
            let line = network.lines[lineIndex]
            // The NUL separator is not decoration: it cannot appear in either
            // half, so a name containing the separator cannot forge a key that
            // collides with a different operator's.
            let displayKey = "\(line.operator ?? "")\u{0000}\(line.name)"
            guard seen.insert(CodeUnits(displayKey)).inserted else { return }
            let brandingLine = OperatorBranding.Line(
                lineId: line.lineID, operator: line.operator, logo: line.logo)
            let logo = OperatorBranding.logoForLine(brandingLine)
            rows.append(
                PopupRow(
                    lineID: line.lineID,
                    company: OperatorBranding.companyFor(
                        operator: line.operator, lineName: line.name),
                    label: bilingualLabel(line.name, line.nameRoma),
                    color: line.color,
                    // A package-provided per-line badge first, then the
                    // operator's mark when the line has no identity of its own.
                    logo: logo,
                    logoNeedsDarkMatte: OperatorBranding.logoNeedsDarkMatte(logo)))
        }

        for member in members { add(lineIndex: network.stations[member].lineIndex) }
        if rows.isEmpty, let lineIDFallback, !lineIDFallback.utf16.isEmpty {
            add(lineIndex: network.lineIndex(id: lineIDFallback))
        }

        rows = sortedByLabel(rows)

        // `st ? st.name : stationId` — an id with no station behind it becomes
        // its own display name, which is what makes a stale map source visible
        // rather than blank.
        let rawName = station?.name ?? stationID
        let code = station?.stationID ?? stationID
        return PopupModel(
            name: naming.stationName?(rawName, code) ?? rawName,
            nameRoma: firstTruthy(station?.nameRoma) ?? "",
            readings: naming.nameReadingsList?(rawName, code),
            lines: rows)
    }

    /// `nameRoma ? name + " (" + nameRoma + ")" : name`.
    static func bilingualLabel(_ name: String, _ nameRoma: String?) -> String {
        guard let nameRoma, !nameRoma.utf16.isEmpty else { return name }
        return name + " (" + nameRoma + ")"
    }

    /// `rows.sort((a, b) => a.label.localeCompare(b.label))`, stably.
    ///
    /// Two things about this are worth stating rather than assuming.
    ///
    /// **Stability.** `Array.prototype.sort` is required to be stable and
    /// Swift's is not, so the original position is carried into the comparison
    /// as the final tiebreak. That is not defensive: twelve of the 12,685 real
    /// station popups contain two rows with an identical label, and their
    /// order is the order their platforms were pushed into the station group.
    ///
    /// **Collation.** `localeCompare` with no arguments asks the HOST for a
    /// collation, so its answer is a property of the environment rather than
    /// of this code. The fixture froze Node's, which resolves to `en-US`, and
    /// this is the Foundation call that reproduces it — measured on every
    /// ordered pair the five packages actually compare:
    ///
    ///     compare(options: [], locale: en_US)     0 / 3511 disagree
    ///     localizedStandardCompare              770 / 3511 disagree
    ///     UTF-16 code unit                        2 / 3511 disagree
    ///
    /// The two code-unit disagreements are one pair, in both directions:
    /// 下関 lists 山陽線 (San’yo Main Line) beside 山陽線 (Sanyo Line), and
    /// U+2019 sorts BEFORE a letter under ICU and after it by code unit.
    /// `localizedStandardCompare` is wrong for a different reason — it uses
    /// the *user's* locale, and the CJK order that produces is not the one the
    /// fixture recorded.
    ///
    /// Where the two do differ is below the level the labels reach: Foundation
    /// collates at a strength that ignores kana type and character width, so
    /// it calls あ and ア equal where V8 orders them. No line label in the five
    /// packages contains such a pair, and the fixture's `comparator` block
    /// records both answers for the ones that do.
    static func sortedByLabel(_ rows: [PopupRow]) -> [PopupRow] {
        rows.enumerated()
            .sorted { left, right in
                let order = compareLabels(left.element.label, right.element.label)
                if order != 0 { return order < 0 }
                return left.offset < right.offset
            }
            .map(\.element)
    }

    /// `String.prototype.localeCompare` — see ``sortedByLabel(_:)``.
    public static func compareLabels(_ a: String, _ b: String) -> Int {
        a.compare(b, options: [], range: nil, locale: collationLocale).rawValue
    }

    private static let collationLocale = Locale(identifier: "en_US")

    // MARK: - The network's own station labels

    /// The platforms elected to carry their complex's name, as positions in
    /// `network.stations`, in the order the second pass accepted them.
    ///
    /// 東京 is nine platforms of five railways and ONE name. A renderer-side
    /// collision pass cannot produce that: the platforms sit tens of metres
    /// apart and every one of the nine finds room for its own copy. So the
    /// name is a right exactly one platform wins.
    ///
    /// The election is a LABEL right and nothing else. It does not merge,
    /// move, delete or re-colour a single mark — every platform keeps its own
    /// dot and its own line identity, and this function returns positions
    /// rather than a new collection precisely so that a label cannot drift
    /// from the dot it names.
    ///
    /// Two passes, because a "station" and a "station group" are not always
    /// the same thing in the source data: 東京 is one place a passenger walks
    /// around, but JR East's 東京 and 東京メトロ's 東京 arrive as two groups
    /// four hundred metres apart. The first pass elects one platform per
    /// group; the second drops an elected name that READS the same as one
    /// already accepted within 600 m.
    public static func stationLabelWinners(_ network: Network) -> [Int] {
        stationLabelWinners(network.stations)
    }

    static func stationLabelWinners(_ stations: [Network.Station]) -> [Int] {
        // ── one platform per group ──
        //
        // Lowest minz wins, then the lowest station id, so the choice is
        // deterministic across rebuilds rather than dependent on iteration
        // order. `<` on ids is JavaScript's, i.e. by UTF-16 code unit: the ids
        // are `jp-東日本旅客鉄道-中央線:001234`, so this is a CJK comparison and
        // Swift's `<` — which orders by canonical equivalence — is not the
        // same relation.
        var pickByGroup: [CodeUnits: Int] = [:]
        for (index, station) in stations.enumerated() {
            let key = CodeUnits(
                Network.groupKey(
                    groupID: station.stationGroupID, stationID: station.stationID))
            guard let current = pickByGroup[key] else {
                pickByGroup[key] = index
                continue
            }
            let held = stations[current]
            if station.minZoom < held.minZoom
                || (station.minZoom == held.minZoom
                    && lessByCodeUnits(station.stationID, held.stationID))
            {
                pickByGroup[key] = index
            }
        }

        // The JavaScript sorts `[...map.values()]`, so it sorts in Map
        // insertion order and relies on the sort being stable. It does not
        // have to be: a group key determines the group code, which the station
        // id embeds, so no two picks can share an id and the comparison below
        // is a TOTAL order. Swift's unordered `Dictionary.values` therefore
        // reaches the same array.
        let elected = pickByGroup.values.sorted { left, right in
            let a = stations[left]
            let b = stations[right]
            if a.minZoom != b.minZoom { return a.minZoom < b.minZoom }
            return lessByCodeUnits(a.stationID, b.stationID)
        }

        // ── the same place, named twice ──
        //
        // Two elected names that READ the same and sit within 600 m are one
        // place named twice, so the second steps down. DIFFERENT names never
        // merge however close they sit — 新宿 and 新宿三丁目 stay two labels —
        // and no distance in this pass reaches a single dot.
        var acceptedByCell: [Cell: [Int]] = [:]
        var winners: [Int] = []
        for index in elected {
            let station = stations[index]
            let cell = Cell(station.coordinate, size: labelCellDegrees)
            var duplicate = false
            neighbours: for dx in -1...1 {
                for dy in -1...1 {
                    guard let bucket = acceptedByCell[cell.offset(dx, dy)] else { continue }
                    for other in bucket {
                        guard sameCodeUnits(stations[other].name, station.name) else {
                            continue
                        }
                        // `distanceMeters` here is rail-network.js's own
                        // EQUIRECTANGULAR metric, not the route solver's
                        // haversine. The two are 0.1125% apart, which is 0.68 m
                        // at this threshold — enough to decide a borderline
                        // pair, which is why `Grooming`'s copy is used rather
                        // than `Geometry`'s.
                        if Grooming.distanceMeters(
                            stations[other].coordinate, station.coordinate)
                            <= labelMergeMeters
                        {
                            duplicate = true
                            break neighbours
                        }
                    }
                }
            }
            if duplicate { continue }
            winners.append(index)
            acceptedByCell[cell, default: []].append(index)
        }
        return winners
    }

    /// 600 m — near enough that one name printed twice would print on top of
    /// itself.
    static let labelMergeMeters = 600.0

    /// ~400 m of longitude at 35°, the worst case across all five packages. A
    /// slightly generous cell only costs a few extra comparisons.
    ///
    /// Note that it is SMALLER than the merge radius it accelerates. 600 m is
    /// 0.00658° of longitude at 35°N — and 0.0077° at 45.5°N, Japan's northern
    /// limit — both wider than one cell, so a qualifying pair can land TWO
    /// cells apart and the eight-neighbour scan then misses it. That is a hole
    /// in the JavaScript rather than a rule, and it is reproduced here:
    /// measured across all five packages, no real pair reaches it — 0 of the
    /// 10,881 elected labels has a same-named neighbour left inside 600 m — so
    /// widening the scan would be a behaviour change disguised as a fix.
    ///
    /// Latitude is safe at any latitude: 600 m is 0.00539°, under one cell.
    /// And the ride election below cannot have this hole at all, because its
    /// merge distance IS its cell size — a span of at most one cell width can
    /// only ever cross one boundary.
    static let labelCellDegrees = 0.0055

    // MARK: - The ride's own station labels

    /// One deck.gl marker record, as `markerRecordsToFC` reads it.
    ///
    /// Colours are `[Double]?` rather than a typed colour because `rgbCss`
    /// indexes three elements without checking: a two-element array prints
    /// `rgb(1,2,undefined)` and a non-array prints `rgb(0,0,0)`, and both are
    /// reachable from a caller that builds a record by hand.
    public struct MarkerRecord: Sendable, Equatable {
        public var position: Coordinate
        /// The station's own name. With the national network switched off the
        /// map draws rides over blank ground and the network's label layer
        /// goes with the network it belongs to, so a ride's own stops are the
        /// only thing left that knows what these places are called.
        public var name: String
        public var category: String
        /// `terminal` / `stop` / `pass` / `xday` / `stop-center`. nil is the
        /// JavaScript's absent field, which `m.role || m.category` replaces
        /// with the category — and so does an EMPTY string, since `||` tests
        /// truthiness.
        public var role: String?
        public var radius: Double
        public var lineWidth: Double
        public var fillColor: [Double]?
        public var lineColor: [Double]?
        public var alpha: Double?
        public var focusScale: Double?
        public var trainID: String?
        public var tdate: String?
        public var dspan: String?

        public init(
            position: Coordinate,
            name: String = "",
            category: String = "",
            role: String? = nil,
            radius: Double = 0,
            lineWidth: Double = 0,
            fillColor: [Double]? = nil,
            lineColor: [Double]? = nil,
            alpha: Double? = nil,
            focusScale: Double? = nil,
            trainID: String? = nil,
            tdate: String? = nil,
            dspan: String? = nil
        ) {
            self.position = position
            self.name = name
            self.category = category
            self.role = role
            self.radius = radius
            self.lineWidth = lineWidth
            self.fillColor = fillColor
            self.lineColor = lineColor
            self.alpha = alpha
            self.focusScale = focusScale
            self.trainID = trainID
            self.tdate = tdate
            self.dspan = dspan
        }

        /// `m.role || m.category`.
        public var effectiveRole: String {
            guard let role, !role.utf16.isEmpty else { return category }
            return role
        }
    }

    /// What `MARKER_LABEL_RANK[role]` can answer.
    ///
    /// Three states rather than `Int?`, because the JavaScript looks the role
    /// up in an object literal and therefore walks `Object.prototype`. A role
    /// of `toString` or `constructor` finds a FUNCTION there: not `undefined`,
    /// so the record is not skipped, and not a number, so every `<` against it
    /// is false — it claims a name it can then never lose. No role the app
    /// produces reaches it, and it is modelled rather than collapsed because
    /// collapsing it either way changes an answer.
    enum MarkerRank: Equatable {
        case tier(Int)
        case inherited

        /// `rank < held.rank`, which is false whenever either side is not a
        /// number.
        static func < (lhs: MarkerRank, rhs: MarkerRank) -> Bool {
            guard case .tier(let a) = lhs, case .tier(let b) = rhs else { return false }
            return a < b
        }
    }

    /// A station where a ride BEGINS or ENDS outranks one it stopped at, which
    /// outranks one it merely rolled through — so a place that is a terminal
    /// for one train and a pass-through for another is named at the terminal's
    /// zoom.
    ///
    /// `stop-center` is absent on purpose: it is the black core of an
    /// intermediate stop whose own record already holds the name.
    static func markerRank(forRole role: String) -> MarkerRank? {
        switch role {
        case "terminal", "xday": return .tier(0)
        case "stop": return .tier(1)
        case "pass": return .tier(2)
        // `Object.prototype`'s own property names, which an object-literal
        // lookup finds. See ``MarkerRank/inherited``.
        case "toString", "toLocaleString", "valueOf", "constructor",
            "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
            "__proto__", "__defineGetter__", "__defineSetter__",
            "__lookupGetter__", "__lookupSetter__":
            return .inherited
        default: return nil
        }
    }

    /// Which marker records win the right to carry their station's name.
    ///
    /// A station reached by twenty trains ships twenty marker records and
    /// every one of them knows the same name; 東京 is also several platforms
    /// hundreds of metres apart, so MapLibre's collision pass cannot merge
    /// them either — at z14 two copies of 東京 sit four hundred pixels apart
    /// and BOTH fit. So the name is a right that exactly one record wins, the
    /// same way `rail-network.js` elects one platform per complex. Nothing
    /// else about a record changes: every dot still draws.
    public static func markerLabelWinners(_ records: [MarkerRecord]) -> Set<Int> {
        /// name + position + the current holder. `rank` and `index` move when
        /// a better-ranked record arrives; `coordinate` does NOT — the place
        /// keeps the coordinates of the record that first claimed it, so a
        /// third record is measured against where the place was first seen
        /// rather than against the current holder. Reproduced, not repaired.
        struct Accepted {
            let name: String
            let coordinate: Coordinate
            var rank: MarkerRank
            var index: Int
        }

        var accepted: [Cell: [Accepted]] = [:]
        var winners: Set<Int> = []

        for (index, record) in records.enumerated() {
            guard let rank = markerRank(forRole: record.effectiveRole) else { continue }
            // `if (!name) continue` — an unnamed dot cannot win a name.
            guard !record.name.utf16.isEmpty else { continue }

            let cell = Cell(record.position, size: markerLabelCellDegrees)
            var heldCell: Cell?
            var heldOffset: Int?
            neighbours: for dx in -1...1 {
                for dy in -1...1 {
                    let key = cell.offset(dx, dy)
                    guard let bucket = accepted[key] else { continue }
                    for (offset, other) in bucket.enumerated() {
                        guard sameCodeUnits(other.name, record.name) else { continue }
                        // A SQUARE in raw degrees, not a circle in metres —
                        // and its half-width is exactly the cell size, which
                        // is what makes the eight-neighbour scan sufficient
                        // here where it is not in the network election above.
                        if abs(other.coordinate.lon - record.position.lon)
                            <= markerLabelMergeDegrees
                            && abs(other.coordinate.lat - record.position.lat)
                                <= markerLabelMergeDegrees
                        {
                            heldCell = key
                            heldOffset = offset
                            break neighbours
                        }
                    }
                }
            }

            if let heldCell, let heldOffset {
                // Same place, already named — unless this record names it
                // earlier in the zoom ladder. Strictly `<`, so equal rank
                // leaves the incumbent alone: a cross-day break station and a
                // terminal share rank 0, and whichever arrived first keeps it.
                let held = accepted[heldCell]![heldOffset]
                if rank < held.rank {
                    winners.remove(held.index)
                    winners.insert(index)
                    accepted[heldCell]![heldOffset].rank = rank
                    accepted[heldCell]![heldOffset].index = index
                }
                continue
            }

            accepted[cell, default: []].append(
                Accepted(
                    name: record.name, coordinate: record.position, rank: rank, index: index))
            winners.insert(index)
        }
        return winners
    }

    /// ~600 m of longitude at Japanese latitudes — the same distance
    /// `rail-network.js` treats as "one place being named twice". A cell grid
    /// plus its eight neighbours, so a pair straddling a cell edge still
    /// merges.
    static let markerLabelCellDegrees = 0.0055
    static let markerLabelMergeDegrees = markerLabelCellDegrees

    /// One marker's feature properties.
    public struct MarkerFeature: Sendable, Equatable {
        public let coordinates: Coordinate
        public let idx: Int
        public let tid: String
        public let tdate: String
        public let dspan: String
        public let category: String
        public let role: String
        public let focusScale: Double
        public let radius: Double
        public let lineWidth: Double
        public let fill: String
        public let stroke: String
        public let alpha: Double
        /// Empty on every record that lost the election, so the label layers
        /// can filter the source down to the names they will actually draw.
        public let name: String
    }

    public static func markerRecordsToFC(_ records: [MarkerRecord]) -> [MarkerFeature] {
        let labelled = markerLabelWinners(records)
        return records.enumerated().map { index, record in
            MarkerFeature(
                coordinates: record.position,
                idx: index,
                tid: firstTruthy(record.trainID) ?? "",
                tdate: firstTruthy(record.tdate) ?? "",
                // Cross-day scoping: `tdate` is the date this record's train
                // is filed under and `dspan` lists every date it touches. The
                // default keeps a single-day train's span consistent with it.
                dspan: firstTruthy(record.dspan)
                    ?? "|" + (firstTruthy(record.tdate) ?? "") + "|",
                category: record.category,
                role: record.effectiveRole,
                // `== null`, so a focusScale of 0 is kept and only an absent
                // one becomes 0.5.
                focusScale: record.focusScale ?? 0.5,
                radius: record.radius,
                lineWidth: record.lineWidth,
                fill: rgbCSS(record.fillColor),
                stroke: rgbCSS(record.lineColor),
                alpha: record.alpha ?? 1,
                name: labelled.contains(index) ? record.name : "")
        }
    }

    /// `rgbCss` — `"rgb(r,g,b)"`, with JavaScript's number printing.
    ///
    /// A non-array is black. A SHORT array is not: the JavaScript indexes
    /// three elements unconditionally and concatenates whatever it finds, so a
    /// two-element colour prints the literal text `undefined` in the blue
    /// channel rather than falling back.
    static func rgbCSS(_ channels: [Double]?) -> String {
        guard let channels else { return "rgb(0,0,0)" }
        func channel(_ index: Int) -> String {
            index < channels.count ? JSNumber.string(channels[index]) : "undefined"
        }
        return "rgb(" + channel(0) + "," + channel(1) + "," + channel(2) + ")"
    }

    // MARK: - The three role tiers

    /// When a ride's station names appear, by role.
    ///
    /// Three floors, because the three roles are three densities. A ride has
    /// exactly two ends, so naming them costs almost nothing and they appear
    /// early; its intermediate stops are a handful per train; the stations it
    /// merely rolled through are every station on the line, and are worth
    /// naming only once the view is about one district.
    ///
    /// Each floor is a LAYER minimum zoom rather than one layer with a zoom
    /// expression. That is a MapLibre finding rather than a preference: filter
    /// and layout zoom are only evaluated at tile parse in the build this app
    /// ships, and a zero-opacity label would still hold its space in the
    /// collision pass and silently suppress the name of a station that IS
    /// shown.
    ///
    /// The rest of `railmap-style.js` §7b — fonts, halo, anchors, the colour
    /// that follows the theme — is the style port's, not this one's. What is
    /// here is the part that decides WHICH stations are named and WHEN.
    public struct RideLabelTier: Sendable, Equatable {
        public let layerID: String
        public let minZoom: Int
        /// The label's size at ``minZoom``. It grows by 2 pt by z16 and then
        /// stops — the same shallow ramp the network's own names ride, because
        /// text is not a mark and never thins with the railway scale.
        public let baseTextSize: Double
        public static let topZoom = 16.0

        /// MapLibre's `["interpolate", ["linear"], ["zoom"], minzoom, base,
        /// 16, base + 2]`, which clamps outside its stops.
        public func textSize(atZoom zoom: Double) -> Double {
            let low = Double(minZoom)
            if zoom <= low { return baseTextSize }
            if zoom >= Self.topZoom { return baseTextSize + 2 }
            return baseTextSize + 2 * (zoom - low) / (Self.topZoom - low)
        }
    }

    /// A boarding or alighting station, and the cross-day break station that
    /// rides with them: it is where one day's travel ended and the next began,
    /// which is a boundary of the same kind.
    public static let terminalLabelTier = RideLabelTier(
        layerID: "train-terminal-label", minZoom: 8, baseTextSize: 11)
    public static let stopLabelTier = RideLabelTier(
        layerID: "train-stop-label", minZoom: 10, baseTextSize: 10)
    public static let passLabelTier = RideLabelTier(
        layerID: "train-pass-label", minZoom: 13, baseTextSize: 10)

    /// The tier a role's name is drawn in, or nil for a role that is never
    /// named — which is `stop-center` and anything the rank table does not
    /// know.
    public static func rideLabelTier(role: String) -> RideLabelTier? {
        switch role {
        case "terminal", "xday": return terminalLabelTier
        case "stop": return stopLabelTier
        case "pass": return passLabelTier
        default: return nil
        }
    }

    /// The tiers in the order the style pushes them — weakest first.
    ///
    /// MapLibre places symbols in REVERSE draw order, so pushing
    /// pass → stop → terminal means a boarding station claims its space before
    /// an intermediate stop, which claims it before a station merely rolled
    /// through.
    public static let rideLabelTiersInPlacementOrder = [
        passLabelTier, stopLabelTier, terminalLabelTier,
    ]
}

// MARK: - The grid both elections accelerate with

/// `` `${Math.floor(lon / size)}|${Math.floor(lat / size)}` `` — a cell of the
/// uniform degree grid.
///
/// The two axes are kept as the floored DOUBLES the JavaScript prints rather
/// than as `Int`, and identity is their bit patterns. That is not caution for
/// its own sake — `Int(_:)` on a `Double` traps, and the three inputs that
/// would trap it are all reachable from a caller building a record by hand:
///
///   * a NaN coordinate, which JavaScript keys as `NaN|NaN` — one bucket that
///     its own ±1 neighbours cannot leave, since `NaN + 1` is `NaN`;
///   * ±Infinity, likewise its own bucket;
///   * a finite coordinate large enough that `lon / 0.0055` exceeds `Int`,
///     where `x + 1 == x` in floating point and JavaScript's neighbour scan
///     collapses to the same cell.
///
/// Keeping the doubles reproduces all three exactly, and costs nothing on the
/// ordinary path. Only two canonicalisations are needed: every NaN is one key
/// (JavaScript prints them all `NaN`), and `-0` is `0` (`${-0}` is `"0"`, and
/// `Math.floor(-0 / size)` really is `-0`).
private struct Cell: Hashable {
    private let x: UInt64
    private let y: UInt64

    init(_ coordinate: Coordinate, size: Double) {
        x = Self.key((coordinate.lon / size).rounded(.down))
        y = Self.key((coordinate.lat / size).rounded(.down))
    }

    private init(x: UInt64, y: UInt64) {
        self.x = x
        self.y = y
    }

    func offset(_ dx: Int, _ dy: Int) -> Cell {
        Cell(
            x: Self.key(Double(bitPattern: x) + Double(dx)),
            y: Self.key(Double(bitPattern: y) + Double(dy)))
    }

    private static func key(_ value: Double) -> UInt64 {
        if value.isNaN { return Double.nan.bitPattern }
        if value == 0 { return (0.0 as Double).bitPattern }
        return value.bitPattern
    }
}

// MARK: - JavaScript string semantics, written out

/// A string compared the way JavaScript compares one: by UTF-16 code unit.
///
/// Swift's `String` is equal under canonical equivalence, so `笹\u{FA10}` and
/// `笹\u{585A}` are one key to a `Dictionary` and two to a JavaScript `Map` —
/// and the shipped `jp` package uses the first spelling while every human
/// types the second. `Stations.swift` keeps a private copy of this for the
/// same reason; the duplication is deliberate, because a shared one would be
/// a file two parallel ports have to merge.
private struct CodeUnits: Hashable {
    let units: [UInt16]
    init(_ value: String) { units = Array(value.utf16) }
}

/// `a === b` for strings. NOT `==`.
private func sameCodeUnits(_ a: String, _ b: String) -> Bool {
    a.utf16.elementsEqual(b.utf16)
}

/// `a < b` for strings: the first differing UTF-16 code unit decides, and a
/// prefix is less than what extends it.
///
/// NOT Swift's `<`, which orders by Unicode scalar after canonical
/// equivalence. The two agree on the ASCII prefixes of a station id and can
/// disagree the moment a CJK name or a surrogate pair reaches them.
private func lessByCodeUnits(_ a: String, _ b: String) -> Bool {
    var left = a.utf16.makeIterator()
    var right = b.utf16.makeIterator()
    while true {
        switch (left.next(), right.next()) {
        case (nil, nil): return false
        case (nil, _): return true
        case (_, nil): return false
        case (let x?, let y?):
            if x != y { return x < y }
        }
    }
}

/// JavaScript's `a || ""` over an optional string: the empty string is falsy,
/// so it is not a value that survives a `||` chain the way `??` would keep it.
private func firstTruthy(_ value: String?) -> String? {
    guard let value, !value.utf16.isEmpty else { return nil }
    return value
}

private func isASCIIDigit(_ unit: UInt16) -> Bool { (0x30...0x39).contains(unit) }
