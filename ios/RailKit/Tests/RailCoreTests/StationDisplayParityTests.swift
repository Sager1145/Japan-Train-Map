import Foundation
import Testing

@testable import RailCore

/// `StationDisplay` against `railmap-popup.js`, `rail-network.js`'s label
/// election and `railmap-geometry.js`'s marker election.
///
/// The expected values in `port-fixtures/station-display.json` are whatever
/// the JavaScript returns today, so a failure here is not cosmetic: it is a
/// station named nine times instead of once, or a hover popup listing a
/// different set of railways in a different order.
///
/// Everything that compares a name compares CODE UNITS. `==` on `String` would
/// be the wrong assertion in the direction that hides the bug — it holds under
/// canonical equivalence, so a port that merged the two spellings of 笹塚 would
/// produce a different answer and still pass. The fixture ships both spellings
/// for exactly that reason.
struct StationDisplayParityTests {

    // MARK: - the fixture

    struct Fixture: Decodable {
        struct Line: Decodable {
            let lineId: String
            let isLoop: Bool
            let packageLogo: String?
            let minZoom: Int
            let company: String
            let label: String
            let color: String
            let logo: String?
            let logoNeedsDarkMatte: Bool
        }
        /// One station complex the 600 m pass silenced: it elected a platform
        /// of its own and a neighbouring group had already claimed the name.
        struct Dropped: Decodable {
            let groupKey: String
            let names: [String]
            let stationIds: [String]
        }
        struct Package: Decodable {
            let country: String
            let lines: [Line]
            let elected: [String]
            let droppedByMerge: [Dropped]
            let stationCount: Int
            let groupCount: Int
        }
        struct PopupCase: Decodable {
            let country: String?
            let stationId: String
            let name: String
            let nameRoma: String
            /// Positions in the country's `lines` table, in popup row order.
            let rows: [Int]
            /// Only the synthetic packages spell the labels out; there the
            /// ORDER is the answer and an index list is unreadable in a diff.
            let rowLabels: [String]?
        }
        struct HeaderCase: Decodable {
            let stationId: String
            /// Which of the five reachable shapes of the app's i18n layer this
            /// case used. Two of them carry the same pair of function names,
            /// so the shape alone would not identify the stub.
            let naming: String
            let carries: [String]
            let name: String
            let nameRoma: String
            let readings: [String]?
            let why: String
        }
        struct Probe: Decodable {
            let stationId: String
            let lineIdFallback: String?
            let name: String
            let nameRoma: String
            let rows: [String]
            let why: String
        }
        struct Synthetic: Decodable {
            let key: String
            let why: String
            let package: CompactPackage
            let lines: [Line]
            let cases: [PopupCase]
            /// `[stationId, minz]` for every station feature.
            let stationMinZoom: [[MinZoomCell]]
            let elected: [String]
        }
        struct Ride: Decodable {
            let country: String
            let trainCount: Int
            let records: [String]
            let features: [String]
        }
        struct RideProbe: Decodable {
            let key: String
            let why: String
            let records: [String]
            let features: [String]
        }
        struct RideDefaults: Decodable {
            let why: String
            let records: [String]
            let features: [String]
        }
        struct ComparatorPair: Decodable {
            let a: String
            let b: String
            let sign: Int
            let why: String?
        }
        let cases: [PopupCase]
        let packages: [Package]
        let header: [HeaderCase]
        let synthetic: [Synthetic]
        let probes: [Probe]
        let recordColumns: String
        let featureColumns: String
        let rides: [Ride]
        let rideProbes: [RideProbe]
        let rideDefaults: RideDefaults
        let comparator: [ComparatorPair]
    }

    /// `["jp-…:003766", 3]` — a heterogeneous JSON pair.
    enum MinZoomCell: Decodable {
        case text(String)
        case number(Int)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(Int.self) {
                self = .number(value)
            } else {
                self = .text(try container.decode(String.self))
            }
        }

        var text: String? { if case .text(let value) = self { return value } else { return nil } }
        var number: Int? {
            if case .number(let value) = self { return value } else { return nil }
        }
    }

    /// Loaded once: the file is 5 MB and a dozen tests read it.
    static let fixture: Fixture = {
        do { return try PortFixtures.decode(Fixture.self, "station-display.json") } catch {
            fatalError("port-fixtures/station-display.json did not load: \(error)")
        }
    }()

    // MARK: - helpers

    /// `a === b` — NOT `==`. See the type's documentation comment.
    static func same(_ got: String?, _ expected: String?) -> Bool {
        switch (got, expected) {
        case (nil, nil): return true
        case let (got?, expected?): return got.utf16.elementsEqual(expected.utf16)
        default: return false
        }
    }

    /// A description that survives being printed.
    ///
    /// Several names here differ from an ordinary one only by an invisible or
    /// a look-alike character — U+FA10 against U+585A, U+2019 against nothing
    /// at all — and a failure message showing `"笹塚"` twice would be useless.
    /// Only the ranges where that happens are escaped, so ordinary CJK,
    /// Hangul and kana stay readable.
    static func spell(_ value: String?) -> String {
        guard let value else { return "nil" }
        return value.unicodeScalars
            .map { scalar in
                let escaped =
                    scalar.value < 0x20 || scalar.properties.isWhitespace
                    || (0x2000...0x206F).contains(scalar.value)  // general punctuation
                    || (0xFA00...0xFAFF).contains(scalar.value)  // compatibility ideographs
                    || (0xFE00...0xFFEF).contains(scalar.value)  // variation / half & full width
                    || scalar.properties.isDiacritic
                return escaped ? String(format: "<U+%04X>", scalar.value) : String(scalar)
            }
            .joined()
    }

    /// Every country's network, built once, the way the app builds it: the
    /// shipped package plus the two fields `CompactPackage`'s decoder does not
    /// carry.
    ///
    /// A `static let` rather than per-test: Swift Testing runs a suite's tests
    /// in parallel and a dozen of these want the same country, so building the
    /// wrapper once for the suite saves a dozen redundant passes over the
    /// fixture's line lists. The packages themselves come from
    /// `PortFixtures.package(country:)`, so the 9 MB Japan decode is shared
    /// with every other suite that reads it.
    static let networks: [String: StationDisplay.Network] = {
        var built: [String: StationDisplay.Network] = [:]
        for entry in fixture.packages {
            do {
                built[entry.country] = StationDisplay.Network(
                    package: try PortFixtures.package(country: entry.country),
                    loopLineIDs: Set(entry.lines.filter(\.isLoop).map(\.lineId)),
                    packageLogoLineIDs: Set(
                        entry.lines.filter { $0.packageLogo != nil }.map(\.lineId)))
            } catch {
                fatalError("\(entry.country)-2025.json did not load: \(error)")
            }
        }
        return built
    }()

    static func network(_ entry: Fixture.Package) throws -> StationDisplay.Network {
        try #require(networks[entry.country])
    }

    static func network(_ entry: Fixture.Synthetic) -> StationDisplay.Network {
        StationDisplay.Network(
            package: entry.package,
            loopLineIDs: Set(entry.lines.filter(\.isLoop).map(\.lineId)),
            packageLogoLineIDs: Set(
                entry.lines.filter { $0.packageLogo != nil }.map(\.lineId)))
    }

    /// One tab-joined fixture row, split without dropping empty cells — an
    /// empty cell is a `null`, and losing one would silently shift every column
    /// after it.
    static func cells(_ row: String) -> [String] {
        row.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
    }

    static func record(_ row: String) throws -> StationDisplay.MarkerRecord {
        let cell = cells(row)
        #expect(cell.count == 14, "a record row must have 14 columns")
        func optional(_ index: Int) -> String? { cell[index].isEmpty ? nil : cell[index] }
        func number(_ index: Int) throws -> Double { try #require(Double(cell[index])) }
        func colour(_ index: Int) -> [Double]? {
            guard !cell[index].isEmpty else { return nil }
            return cell[index].split(separator: ",").compactMap { Double($0) }
        }
        let lon = try number(0)
        let lat = try number(1)
        return StationDisplay.MarkerRecord(
            position: Coordinate(lon: lon, lat: lat),
            name: cell[2],
            category: cell[3],
            role: optional(4),
            radius: try number(5),
            lineWidth: try number(6),
            fillColor: colour(7),
            lineColor: colour(8),
            alpha: optional(9).flatMap { Double($0) },
            focusScale: optional(10).flatMap { Double($0) },
            trainID: optional(11),
            tdate: optional(12),
            dspan: optional(13))
    }

    /// The feature spelled the way the fixture spells it, so the comparison is
    /// on the printed text and a `139.0` against a `139` cannot pass.
    static func spellFeature(_ feature: StationDisplay.MarkerFeature) -> String {
        [
            JSNumber.string(Double(feature.idx)),
            feature.tid,
            feature.tdate,
            feature.dspan,
            feature.category,
            feature.role,
            JSNumber.string(feature.focusScale),
            JSNumber.string(feature.radius),
            JSNumber.string(feature.lineWidth),
            feature.fill,
            feature.stroke,
            JSNumber.string(feature.alpha),
            feature.name,
        ].joined(separator: "\t")
    }

    // MARK: - the network slice

    /// The part of `buildNetworkFromCompactPackage` this port rebuilds, over
    /// all five packages.
    ///
    /// `packageLogo` is the interesting column: the package's `logo` flag only
    /// ever meant "artwork was downloaded", and turning it into a path means
    /// peeling a trailing run of `-2` / `-p1` suffixes, because a split part
    /// and a paired alignment both wear their PARENT railway's badge.
    @Test("the line table is rebuilt from the package identically")
    func lineTable() throws {
        let fixture = Self.fixture
        #expect(fixture.packages.count == 5)
        var lineCount = 0
        for entry in fixture.packages {
            let network = try Self.network(entry)
            #expect(
                network.lines.count == entry.lines.count,
                """
                \(entry.country): \(network.lines.count) lines, \
                expected \(entry.lines.count)
                """)
            for (index, expected) in entry.lines.enumerated() where index < network.lines.count {
                let line = network.lines[index]
                lineCount += 1
                #expect(
                    Self.same(line.lineID, expected.lineId),
                    "\(entry.country) line \(index): id \(line.lineID) != \(expected.lineId)")
                #expect(
                    Self.same(line.logo, expected.packageLogo),
                    """
                    \(expected.lineId): package badge \(Self.spell(line.logo)) \
                    but JavaScript says \(Self.spell(expected.packageLogo))
                    """)
                #expect(
                    line.minZoom == expected.minZoom,
                    "\(expected.lineId): minZoom \(line.minZoom) != \(expected.minZoom)")
                #expect(line.isLoop == expected.isLoop, "\(expected.lineId): isLoop disagrees")
            }
        }
        #expect(lineCount == 804, "804 lines across the five packages, got \(lineCount)")
    }

    @Test("every station of every package is filed under its group")
    func stationTable() throws {
        let fixture = Self.fixture
        var total = 0
        for entry in fixture.packages {
            let network = try Self.network(entry)
            #expect(
                network.stations.count == entry.stationCount,
                """
                \(entry.country): \(network.stations.count) stations, \
                expected \(entry.stationCount)
                """)
            total += network.stations.count

            var groups = Set<[UInt16]>()
            for station in network.stations {
                let key = StationDisplay.Network.groupKey(
                    groupID: station.stationGroupID, stationID: station.stationID)
                groups.insert(Array(key.utf16))
            }
            #expect(
                groups.count == entry.groupCount,
                """
                \(entry.country): \(groups.count) station groups, \
                expected \(entry.groupCount)
                """)

            // A platform must be a member of its own group, or the popup
            // would list every railway at the complex except its own.
            for station in network.stations {
                let members = network.groupMembers(ofStationID: station.stationID)
                let mine = members.contains { network.stations[$0].stationID == station.stationID }
                #expect(mine, "\(station.stationID) is not a member of its own group")
            }
        }
        #expect(total == 12685, "12,685 stations across the five packages, got \(total)")
    }

    // MARK: - the popup model

    /// Every line in all five packages, through the row builder.
    ///
    /// The row is a function of the line alone — company, bilingual label,
    /// colour, badge and matte — so 804 rows is the whole domain rather than a
    /// sample of it. Reached through `lineIDFallback`, which is the only door
    /// into the row builder that does not go via a station.
    @Test("every line's popup row matches, character for character")
    func popupRows() throws {
        let fixture = Self.fixture
        for entry in fixture.packages {
            let network = try Self.network(entry)
            for expected in entry.lines {
                let model = StationDisplay.buildPopupModel(
                    network: network, stationID: " no-such-station",
                    lineIDFallback: expected.lineId)
                let row = try #require(model.lines.first)
                #expect(
                    Self.same(row.company, expected.company),
                    """
                    \(expected.lineId): company \(Self.spell(row.company)) \
                    but JavaScript says \(Self.spell(expected.company))
                    """)
                #expect(
                    Self.same(row.label, expected.label),
                    """
                    \(expected.lineId): label \(Self.spell(row.label)) \
                    but JavaScript says \(Self.spell(expected.label))
                    """)
                #expect(
                    Self.same(row.color, expected.color),
                    "\(expected.lineId): colour \(row.color) != \(expected.color)")
                #expect(
                    Self.same(row.logo, expected.logo),
                    """
                    \(expected.lineId): badge \(Self.spell(row.logo)) \
                    but JavaScript says \(Self.spell(expected.logo))
                    """)
                #expect(
                    row.logoNeedsDarkMatte == expected.logoNeedsDarkMatte,
                    "\(expected.lineId): dark matte disagrees")
            }
        }
    }

    /// Every station in all five packages, through the whole popup.
    ///
    /// This is where the dedupe and the label sort are checked together, and
    /// where a naive port fails: the multi-line complexes (東京, 新宿, 大阪,
    /// 台北, 서울역) are exactly the ones whose row list is neither the group's
    /// member list nor a subset of it.
    @Test("every station's popup lists the same lines in the same order")
    func popupOrder() throws {
        let fixture = Self.fixture
        #expect(fixture.cases.count == 12685)
        var multiRow = 0
        var checked = 0
        for entry in fixture.packages {
            let network = try Self.network(entry)
            let ids = entry.lines.map(\.lineId)
            for item in fixture.cases where item.country == entry.country {
                checked += 1
                if item.rows.count > 1 { multiRow += 1 }
                let model = StationDisplay.buildPopupModel(
                    network: network, stationID: item.stationId)
                let expectedIDs = item.rows.map { ids[$0] }
                let gotIDs = model.lines.map(\.lineID)
                let agree =
                    gotIDs.count == expectedIDs.count
                    && zip(gotIDs, expectedIDs).allSatisfy(Self.same)
                #expect(
                    agree,
                    """
                    \(item.stationId) (\(Self.spell(item.name))) lists
                      \(gotIDs.joined(separator: ", "))
                    but JavaScript lists
                      \(expectedIDs.joined(separator: ", "))
                    """)
                #expect(
                    Self.same(model.name, item.name),
                    """
                    \(item.stationId): name \(Self.spell(model.name)) \
                    != \(Self.spell(item.name))
                    """)
                #expect(
                    Self.same(model.nameRoma, item.nameRoma),
                    "\(item.stationId): nameRoma \(model.nameRoma) != \(item.nameRoma)")
                #expect(
                    model.readings == nil,
                    """
                    \(item.stationId): with no app i18n the readings must be nil, \
                    which is not the same answer as an empty list
                    """)
            }
        }
        #expect(checked == 12685)
        #expect(multiRow == 2894, "2,894 stations are served by more than one line")
    }

    /// The header, over the five reachable shapes of the app's i18n layer.
    ///
    /// The two function tests are independent in the JavaScript, so an object
    /// carrying only one of them is a real state and produces a popup with a
    /// localized name and no readings at all. `readings == nil` (no app i18n)
    /// and `readings == []` (app present, every toggle off) are different
    /// answers and the shell draws them differently — a port that used an
    /// empty array for both would silently keep a `nameRoma` subline the app
    /// had turned off.
    @Test("the popup header follows whichever i18n functions exist")
    func popupHeader() throws {
        let fixture = Self.fixture
        let jp = try #require(fixture.packages.first { $0.country == "jp" })
        let network = try Self.network(jp)
        #expect(fixture.header.count == 15, "five i18n shapes over three stations")

        for item in fixture.header {
            let localizedName: (@Sendable (String, String) -> String)? = {
                switch item.naming {
                case "name-only", "both-empty", "both":
                    return { name, code in "NAME<\(name)|\(code)>" }
                default: return nil
                }
            }()
            let readings: (@Sendable (String, String) -> [String])? = {
                switch item.naming {
                case "readings-only": return { name, code in ["R<\(name)|\(code)>"] }
                case "both-empty": return { _, _ in [] }
                case "both": return { name, code in ["KANA<\(name)>", "ROMA<\(code)>"] }
                default: return nil
                }
            }()
            // The fixture's own record of which functions the stub carried,
            // checked against the reconstruction so a renamed key cannot
            // silently turn a case into a different one.
            let carried = Set(
                [
                    localizedName == nil ? nil : "stationName",
                    readings == nil ? nil : "nameReadingsList",
                ].compactMap { $0 })
            #expect(carried == Set(item.carries), "stub \(item.naming) was rebuilt wrongly")

            let model = StationDisplay.buildPopupModel(
                network: network, stationID: item.stationId,
                naming: StationDisplay.Naming(
                    stationName: localizedName, nameReadingsList: readings))
            #expect(
                Self.same(model.name, item.name),
                """
                \(item.stationId) [\(item.why)]: name \(Self.spell(model.name)) \
                != \(Self.spell(item.name))
                """)
            #expect(
                Self.same(model.nameRoma, item.nameRoma),
                "\(item.stationId) [\(item.why)]: nameRoma disagrees")

            switch (model.readings, item.readings) {
            case (nil, nil):
                break
            case let (got?, expected?):
                let agree = got.count == expected.count && zip(got, expected).allSatisfy(Self.same)
                #expect(agree, "\(item.stationId) [\(item.why)]: readings \(got) != \(expected)")
            default:
                let got = model.readings.map { "\($0)" } ?? "nil"
                let want = item.readings.map { "\($0)" } ?? "nil"
                Issue.record(
                    """
                    \(item.stationId) [\(item.why)]: readings \(got) vs \(want) — \
                    nil and [] are different answers and the shell draws them \
                    differently
                    """)
            }
        }
    }

    /// The fallback line, and what happens when there is no station at all.
    @Test("a popup with no station behind it behaves the same")
    func popupProbes() throws {
        let fixture = Self.fixture
        let jp = try #require(fixture.packages.first { $0.country == "jp" })
        let network = try Self.network(jp)
        for item in fixture.probes {
            let model = StationDisplay.buildPopupModel(
                network: network, stationID: item.stationId,
                lineIDFallback: item.lineIdFallback)
            let gotIDs = model.lines.map(\.lineID)
            let agree =
                gotIDs.count == item.rows.count && zip(gotIDs, item.rows).allSatisfy(Self.same)
            #expect(agree, "\(item.stationId) [\(item.why)]: \(gotIDs) != \(item.rows)")
            #expect(
                Self.same(model.name, item.name),
                """
                \(item.stationId) [\(item.why)]: name \(Self.spell(model.name)) \
                != \(Self.spell(item.name))
                """)
        }
    }

    // MARK: - the network's station labels

    /// Every station complex in all five packages, through both passes.
    ///
    /// The elected list is the whole answer and it is compared in order, so a
    /// port that got the group pick right and the 600 m merge wrong fails on
    /// the count, and one that got both right and the SORT wrong fails on the
    /// order.
    @Test("one platform per complex carries the name, in all five packages")
    func labelElection() throws {
        let fixture = Self.fixture
        var totalElected = 0
        var totalDropped = 0
        for entry in fixture.packages {
            let network = try Self.network(entry)
            let winners = StationDisplay.stationLabelWinners(network)
            let got = winners.map { network.stations[$0].stationID }
            totalElected += got.count
            totalDropped += entry.droppedByMerge.count
            #expect(
                got.count == entry.elected.count,
                "\(entry.country): \(got.count) labels, expected \(entry.elected.count)")
            // Every group elects exactly one platform, so the labels that
            // survive are the groups minus the ones the 600 m pass silenced.
            #expect(
                entry.elected.count == entry.groupCount - entry.droppedByMerge.count,
                "\(entry.country): the fixture's own counts disagree")
            for (index, expected) in entry.elected.enumerated() where index < got.count {
                #expect(
                    Self.same(got[index], expected),
                    "\(entry.country) label \(index): \(got[index]) != \(expected)")
            }
            // A silenced complex must have NO platform elected, not merely a
            // different one: the whole group stepped down.
            let electedSet = Set(got.map { Array($0.utf16) })
            for dropped in entry.droppedByMerge {
                let survivor = dropped.stationIds.first {
                    electedSet.contains(Array($0.utf16))
                }
                #expect(
                    survivor == nil,
                    """
                    \(entry.country): the group \(dropped.groupKey) \
                    (\(dropped.names.map(Self.spell).joined(separator: " / "))) \
                    kept \(survivor ?? "") — it is the same place, named twice
                    """)
            }
        }
        #expect(totalElected == 10881, "10,881 elected labels, got \(totalElected)")
        #expect(
            totalDropped == 57,
            "57 complexes arrive as two groups and are named once, got \(totalDropped)")
    }

    /// 東京 is the case the whole election exists for: eight platforms, TWO
    /// station groups four hundred metres apart, one name.
    @Test("the complexes a naive port names nine times are named once")
    func namedComplexes() throws {
        let fixture = Self.fixture
        let probes: [(country: String, name: String, labels: Int)] = [
            ("jp", "東京", 1),
            ("jp", "新宿", 1),
            ("jp", "大阪", 1),
            ("kr", "서울역", 1),
        ]
        for probe in probes {
            let entry = try #require(fixture.packages.first { $0.country == probe.country })
            let network = try Self.network(entry)
            let winners = StationDisplay.stationLabelWinners(network)
            let platforms = network.stations.filter { Self.same($0.name, probe.name) }
            let labels = winners.filter { Self.same(network.stations[$0].name, probe.name) }
            #expect(
                platforms.count > 1,
                "\(probe.name) should be several platforms, found \(platforms.count)")
            #expect(
                labels.count == probe.labels,
                """
                \(probe.name) is \(platforms.count) platforms and carries \
                \(labels.count) labels, expected \(probe.labels)
                """)
        }
    }

    /// The synthetic packages, which exist to fail a port rather than pass it.
    ///
    /// Each carries its own reason in the fixture and it is quoted into the
    /// failure, because "synthetic case 3 failed" is not a bug report.
    @Test("the adversarial packages come out the same way")
    func syntheticPackages() throws {
        let fixture = Self.fixture
        #expect(fixture.synthetic.count == 7)
        for entry in fixture.synthetic {
            let network = Self.network(entry)

            // per-station minzoom, which is what the group pick sorts on
            for pair in entry.stationMinZoom {
                let id = try #require(pair.first?.text)
                let minZoom = try #require(pair.last?.number)
                let station = try #require(
                    network.stations.first { Self.same($0.stationID, id) })
                #expect(
                    station.minZoom == minZoom,
                    "\(entry.key) \(id): minz \(station.minZoom) != \(minZoom) — \(entry.why)")
            }

            for item in entry.cases {
                let model = StationDisplay.buildPopupModel(
                    network: network, stationID: item.stationId)
                let expected = try #require(item.rowLabels)
                let got = model.lines.map(\.label)
                let agree = got.count == expected.count && zip(got, expected).allSatisfy(Self.same)
                #expect(
                    agree,
                    """
                    \(entry.key) \(item.stationId): rows
                      \(got.map(Self.spell).joined(separator: " | "))
                    but JavaScript says
                      \(expected.map(Self.spell).joined(separator: " | "))
                    — \(entry.why)
                    """)
            }

            let winners = StationDisplay.stationLabelWinners(network)
            let elected = winners.map { network.stations[$0].stationID }
            let agree =
                elected.count == entry.elected.count
                && zip(elected, entry.elected).allSatisfy(Self.same)
            #expect(
                agree,
                """
                \(entry.key): elected
                  \(elected.joined(separator: ", "))
                but JavaScript elected
                  \(entry.elected.joined(separator: ", "))
                — \(entry.why)
                """)
        }
    }

    // MARK: - the ride's own labels

    /// Every marker record of every train in the five committed stores.
    ///
    /// The records come from the real `buildDeckMarkerRecords`, so the ROLES
    /// are the app's own — which matters, because the role is what the three
    /// tiers key on and what the rank table orders.
    @Test("every ride's markers name the same stations")
    func rideLabels() throws {
        let fixture = Self.fixture
        #expect(fixture.recordColumns.split(separator: "\t").count == 14)
        #expect(fixture.featureColumns.split(separator: "\t").count == 13)
        var totalRecords = 0
        var totalNamed = 0
        for ride in fixture.rides {
            let records = try ride.records.map(Self.record)
            let features = StationDisplay.markerRecordsToFC(records)
            totalRecords += records.count
            #expect(features.count == ride.features.count)
            for (index, expected) in ride.features.enumerated() where index < features.count {
                let got = Self.spellFeature(features[index])
                #expect(
                    Self.same(got, expected),
                    """
                    \(ride.country) marker \(index):
                      \(Self.spell(got))
                    but JavaScript says
                      \(Self.spell(expected))
                    """)
                if !features[index].name.isEmpty { totalNamed += 1 }
            }
        }
        #expect(totalRecords == 4085, "4,085 marker records, got \(totalRecords)")
        // Two fifths of them: a station reached by several trains ships one
        // record per train and one of those wins, and every intermediate stop
        // also ships a stop-center that can never win at all.
        #expect(totalNamed == 1714, "1,714 of them carry a name, got \(totalNamed)")
    }

    /// 東京 is 24 marker records across the Japanese store, and exactly one of
    /// them draws the name.
    @Test("a station reached by many trains is still named once")
    func rideBusiestStation() throws {
        let fixture = Self.fixture
        let jp = try #require(fixture.rides.first { $0.country == "jp" })
        let records = try jp.records.map(Self.record)
        let features = StationDisplay.markerRecordsToFC(records)
        for name in ["東京", "品川", "新横浜", "小田原"] {
            let carrying = records.filter { Self.same($0.name, name) }.count
            let named = features.filter { Self.same($0.name, name) }.count
            #expect(carrying > 10, "\(name) should appear on many records")
            #expect(
                named == 1,
                "\(name) is on \(carrying) records and \(named) of them draw the name")
        }
    }

    @Test("the adversarial ride records elect the same winners")
    func rideProbes() throws {
        let fixture = Self.fixture
        #expect(fixture.rideProbes.count == 12)
        for probe in fixture.rideProbes {
            let records = try probe.records.map(Self.record)
            let features = StationDisplay.markerRecordsToFC(records)
            #expect(features.count == probe.features.count)
            for (index, expected) in probe.features.enumerated() where index < features.count {
                let got = Self.spellFeature(features[index])
                #expect(
                    Self.same(got, expected),
                    """
                    \(probe.key) record \(index):
                      \(Self.spell(got))
                    but JavaScript says
                      \(Self.spell(expected))
                    — \(probe.why)
                    """)
            }
        }
    }

    @Test("markerRecordsToFC's defaults are the JavaScript's")
    func rideDefaults() throws {
        let fixture = Self.fixture
        let records = try fixture.rideDefaults.records.map(Self.record)
        let features = StationDisplay.markerRecordsToFC(records)
        for (index, expected) in fixture.rideDefaults.features.enumerated()
        where index < features.count {
            let got = Self.spellFeature(features[index])
            #expect(
                Self.same(got, expected),
                """
                default record \(index):
                  \(Self.spell(got))
                but JavaScript says
                  \(Self.spell(expected))
                — \(fixture.rideDefaults.why)
                """)
        }
    }

    /// The three tiers, and the roles that have none.
    @Test("the role tiers are the style's")
    func roleTiers() {
        #expect(StationDisplay.rideLabelTier(role: "terminal")?.minZoom == 8)
        #expect(StationDisplay.rideLabelTier(role: "xday")?.minZoom == 8)
        #expect(StationDisplay.rideLabelTier(role: "stop")?.minZoom == 10)
        #expect(StationDisplay.rideLabelTier(role: "pass")?.minZoom == 13)
        // The black core of an intermediate stop: its own dot already holds
        // the name, so naming it too would draw 東京 twice on one platform.
        #expect(StationDisplay.rideLabelTier(role: "stop-center") == nil)
        #expect(StationDisplay.rideLabelTier(role: "") == nil)

        #expect(StationDisplay.terminalLabelTier.baseTextSize == 11)
        #expect(StationDisplay.stopLabelTier.baseTextSize == 10)
        #expect(StationDisplay.passLabelTier.baseTextSize == 10)

        // The ramp is clamped at both ends, the way MapLibre's `interpolate`
        // is: below the floor the layer is not drawn at all, and above z16 the
        // text stops growing.
        let terminal = StationDisplay.terminalLabelTier
        #expect(terminal.textSize(atZoom: 4) == 11)
        #expect(terminal.textSize(atZoom: 8) == 11)
        #expect(terminal.textSize(atZoom: 12) == 12)
        #expect(terminal.textSize(atZoom: 16) == 13)
        #expect(terminal.textSize(atZoom: 22) == 13)

        // Weakest tier first: MapLibre places symbols in REVERSE draw order,
        // so a boarding station claims its space before an intermediate stop,
        // which claims it before a station merely rolled through.
        let order = StationDisplay.rideLabelTiersInPlacementOrder.map(\.layerID)
        #expect(order == ["train-pass-label", "train-stop-label", "train-terminal-label"])
    }

    // MARK: - the comparator

    /// `localeCompare`, which is the one part of this port that is a property
    /// of the environment rather than of the code.
    ///
    /// The fixture froze Node's answer, which resolves to `en-US`.
    /// `String.compare(options: [], locale: en_US)` reproduces it on every
    /// ordered pair the five packages actually compare — all 3,511 of them,
    /// including the only one where code-unit order would differ. It does NOT
    /// reproduce it below that level: Foundation collates at a strength that
    /// treats kana type and character width as equal where V8 orders them, so
    /// the adversarial block contains pairs the two answer differently.
    ///
    /// Those are enumerated rather than tolerated. The assertion is that the
    /// set of divergences is EXACTLY this list — a port that drifted further
    /// fails, and so does one that somehow fixed these, because then the
    /// measurement quoted in `StationDisplay.sortedByLabel` is stale.
    @Test("the row comparator matches localeCompare on every pair that ships")
    func comparator() throws {
        let fixture = Self.fixture
        #expect(fixture.comparator.count > 3500)

        /// Every pair where Foundation's collation differs from V8's. All are
        /// TERTIARY-only differences — kana type, or character width — which
        /// Foundation calls equal and V8 orders. No line label in the five
        /// packages contains such a pair, which is why every real case passes.
        let knownDivergences: Set<[String]> = [
            ["あ", "ア"],  // hiragana vs katakana
            ["ア", "ｱ"],  // full-width vs half-width katakana
            ["ＪＲ", "JR"],  // full-width vs ASCII
        ]

        var diverged: Set<[String]> = []
        var realPairs = 0
        for pair in fixture.comparator {
            let got = StationDisplay.compareLabels(pair.a, pair.b)
            if pair.why == nil { realPairs += 1 }
            guard got.signum() != pair.sign else { continue }
            diverged.insert([pair.a, pair.b])
            #expect(
                pair.why != nil,
                """
                a pair the five packages really compare disagrees:
                  \(Self.spell(pair.a))
                  \(Self.spell(pair.b))
                Foundation says \(got.signum()), localeCompare says \(pair.sign)
                """)
        }
        #expect(
            realPairs == 3511,
            "3,511 ordered label pairs come out of the five packages, got \(realPairs)")

        let now = diverged.map { $0.map(Self.spell).joined(separator: " vs ") }.sorted()
        let was = knownDivergences.map { $0.map(Self.spell).joined(separator: " vs ") }.sorted()
        #expect(
            diverged == knownDivergences,
            """
            the measured collation divergence moved.
              now: \(now)
              was: \(was)
            The comment in StationDisplay.sortedByLabel states what was measured; \
            if this set changed, that measurement is stale.
            """)
    }

    /// The sort is stable, and the twelve popups that prove it are real.
    @Test("rows with the same label keep their group's member order")
    func sortStability() throws {
        let fixture = Self.fixture
        var duplicates = 0
        for entry in fixture.packages {
            let network = try Self.network(entry)
            let labels = entry.lines.map(\.label)
            for item in fixture.cases
            where item.country == entry.country && item.rows.count > 1 {
                let rowLabels = item.rows.map { labels[$0] }
                let distinct = Set(rowLabels.map { Array($0.utf16) }).count
                guard distinct != rowLabels.count else { continue }
                duplicates += 1
                let model = StationDisplay.buildPopupModel(
                    network: network, stationID: item.stationId)
                let gotIDs = model.lines.map(\.lineID)
                let expectedIDs = item.rows.map { entry.lines[$0].lineId }
                #expect(
                    zip(gotIDs, expectedIDs).allSatisfy(Self.same),
                    """
                    \(item.stationId) lists two rows with the same label and the order moved:
                      \(gotIDs.joined(separator: ", "))
                    vs
                      \(expectedIDs.joined(separator: ", "))
                    """)
            }
        }
        #expect(duplicates == 12, "twelve real popups carry a repeated label, got \(duplicates)")
    }

    // MARK: - the code-unit rule, asserted directly

    /// The hazard this whole file is keyed against, stated as a test rather
    /// than only as a comment.
    @Test("the two spellings of 笹塚 are two names")
    func compatibilityIdeograph() {
        let shipped = "笹\u{FA10}"  // the jp package's spelling
        let typed = "笹\u{585A}"  // what a passenger types
        #expect(shipped == typed, "Swift's == calls these equal — that is the hazard")
        #expect(
            !shipped.utf16.elementsEqual(typed.utf16),
            "JavaScript calls them different, which is the answer this port owes")

        // And the election agrees with JavaScript rather than with Swift: two
        // records at the SAME point, spelled the two ways, are two places.
        let records = [
            StationDisplay.MarkerRecord(
                position: Coordinate(lon: 139.6, lat: 35.67), name: shipped,
                category: "stop", role: "terminal"),
            StationDisplay.MarkerRecord(
                position: Coordinate(lon: 139.6, lat: 35.67), name: typed,
                category: "stop", role: "terminal"),
        ]
        #expect(
            StationDisplay.markerLabelWinners(records) == [0, 1],
            "both spellings must win: a port keying on String names it once")
    }

    /// A negative zero, which the fixture's text format cannot carry.
    ///
    /// `String(-0)` is `"0"` in JavaScript, so the packed record rows above
    /// spell a `-0` coordinate the same way they spell `0` and the round trip
    /// loses the distinction. It still has to be right: `Math.floor(-0 / size)`
    /// really is `-0`, `${-0}` is `"0"`, and a Swift key that kept the sign bit
    /// would put a station at longitude −0 in a different cell from one at 0.
    @Test("a negative-zero coordinate lands in the same cell as zero")
    func negativeZeroCell() {
        let records = [
            StationDisplay.MarkerRecord(
                position: Coordinate(lon: -0.0, lat: -0.0), name: "負零",
                category: "stop", role: "terminal"),
            StationDisplay.MarkerRecord(
                position: Coordinate(lon: 0.0, lat: 0.0), name: "負零",
                category: "stop", role: "stop"),
        ]
        #expect(
            StationDisplay.markerLabelWinners(records) == [0],
            "the two are one place, and the terminal outranks the stop")
    }

    /// The station-id tiebreak in the group pick is a code-unit comparison,
    /// and the ids that reach it are CJK.
    @Test("the group pick's tiebreak orders ids the way JavaScript does")
    func idTiebreak() throws {
        let fixture = Self.fixture
        // `syn-a-main-2:G1` beats `syn-a-main:G1` because '-' (U+002D) is less
        // than ':' (U+003A) — an ASCII case, but one a port comparing
        // "logical" prefixes would get backwards.
        let shared = try #require(fixture.synthetic.first { $0.key == "shared-group" })
        #expect(shared.elected.first == "syn-a-main-2:G1")
    }
}
