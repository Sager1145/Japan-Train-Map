import Foundation
import RailCore
import Testing

/// `Visibility.stationMinZoom` against the JavaScript that generated
/// `port-fixtures/station-visibility.json`.
///
/// Station-dot decluttering is not a performance knob any more than line
/// visibility is: if the two apps thin their beads at different zooms they are
/// drawing different maps of the same country, and the reader who compares
/// them sees stations that exist on one and not the other. So every line of
/// all five shipped packages is checked, plus the synthetic cases that reach
/// the arithmetic real data never does.
struct StationVisibilityParityTests {

    struct Fixture: Decodable {
        struct Case: Decodable {
            let label: String
            /// Present on the 804 package-derived cases, absent on the
            /// synthetic ones.
            let country: String?
            let lineId: String?
            let lineMinZoom: Int
            let totalKm: Double
            let stationCount: Int
            /// `log2(K / spacing)` before rounding — carried for diagnostics,
            /// and used below to show the tie cases still discriminate.
            /// `null` where the JavaScript produced NaN or an infinity.
            let densityRaw: Double?
            /// Marks a case built to land exactly on a `Math.round` tie.
            let exactTie: Bool?
            /// Whatever the JavaScript answers today.
            let stationMinZoom: Int
        }
        let cases: [Case]
    }

    @Test("station dots appear at the zoom the JavaScript puts them at")
    func densityLadder() throws {
        let fixture = try PortFixtures.decode(Fixture.self, "station-visibility.json")
        #expect(fixture.cases.count > 800)

        for item in fixture.cases {
            #expect(
                Visibility.stationMinZoom(
                    lineMinZoom: item.lineMinZoom,
                    totalKm: item.totalKm,
                    stationCount: item.stationCount) == item.stationMinZoom,
                "\(item.label): \(item.totalKm) km over \(item.stationCount) stations, line at z\(item.lineMinZoom)"
            )
        }
    }

    /// The arguments, not just the arithmetic.
    ///
    /// The fixture's package cases were taken from a real
    /// `buildNetworkFromCompactPackage`, so this checks the pairing the Swift
    /// side has to reproduce: the floor is the whole visibility GROUP's zoom
    /// while the density is the single line's own kilometres and its own
    /// station count. Feeding the group's length to both — the obvious
    /// simplification — is invisible until a railway stored in pieces thins
    /// its dots one zoom too late.
    @Test("the network build's own arguments are derived the same way")
    func argumentsMatchTheNetworkBuild() throws {
        let fixture = try PortFixtures.decode(Fixture.self, "station-visibility.json")

        for country in PortFixtures.countries {
            let package = try PortFixtures.package(country: country)
            let lineZoom = Visibility.minZoomByLineId(package)
            let stationZoom = Visibility.stationMinZoomByLineId(package)
            let byId = Dictionary(
                package.lines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

            var checked = 0
            for item in fixture.cases where item.country == country {
                let lineId = try #require(item.lineId)
                let line = try #require(byId[lineId], "\(country) has no line \(lineId)")
                checked += 1

                #expect(line.stations.count == item.stationCount, "\(lineId): station count")
                // Bit patterns, and in the JavaScript's summation order: the
                // km values are three-decimal survey figures whose left fold
                // is not the same double as their right fold.
                let totalKm = line.segments.reduce(0) { $0 + $1.distanceKm }
                #expect(
                    totalKm.bitPattern == item.totalKm.bitPattern,
                    "\(lineId): own length \(totalKm) vs \(item.totalKm)")
                #expect(lineZoom[lineId] == item.lineMinZoom, "\(lineId): group zoom")
                #expect(stationZoom[lineId] == item.stationMinZoom, "\(lineId): station zoom")
            }
            #expect(checked > 0, "\(country) contributed no cases")
        }
    }

    /// The guard, which no shipped line reaches and which therefore only the
    /// synthetic cases hold in place.
    ///
    /// Its quirk is that it returns `lineMinZoom` **raw** — neither floored
    /// nor capped — so it is the one way this function answers above zoom 14.
    /// That reads like an oversight and may well be one; it is reproduced
    /// because a port that quietly clamps it is a port whose disagreements can
    /// no longer be read.
    @Test("a degenerate line gets its own zoom back, unclamped")
    func degenerateLinesAreNotClamped() throws {
        let fixture = try PortFixtures.decode(Fixture.self, "station-visibility.json")

        var overTheCap = 0
        for item in fixture.cases where item.stationCount < 2 || item.totalKm <= 0 {
            #expect(item.stationMinZoom == item.lineMinZoom, "\(item.label)")
            if item.stationMinZoom > 14 { overTheCap += 1 }
        }
        // Without this the property above could be satisfied vacuously by a
        // fixture that happened to contain no such case.
        #expect(overTheCap > 0, "no case demonstrates the guard escaping the cap")
    }

    /// Guards the fixture's teeth rather than the port.
    ///
    /// The tie cases are aimed at exactly one bug — reaching for `.rounded()`
    /// instead of ``JSNumber/round(_:)`` — and they only bite while the
    /// spacings still land on an exact half-integer. Those spacings are
    /// derived from a copy of `STATION_LOD_K` in the fixture generator, so if
    /// that constant ever drifts the cases stay green while testing nothing.
    /// This asserts they are still ties, and still ties where the two rounding
    /// rules actually disagree.
    @Test("the rounding-tie cases still discriminate")
    func tieCasesStillBite() throws {
        let fixture = try PortFixtures.decode(Fixture.self, "station-visibility.json")

        let ties = fixture.cases.filter { $0.exactTie == true }
        #expect(ties.count >= 7, "the fixture no longer lands on rounding ties")

        let discriminating = ties.filter { item in
            guard let raw = item.densityRaw else { return false }
            return JSNumber.round(raw) != raw.rounded()
        }
        #expect(
            discriminating.count >= 3,
            "no tie case separates Math.round from .rounded() any more"
        )
    }
}
