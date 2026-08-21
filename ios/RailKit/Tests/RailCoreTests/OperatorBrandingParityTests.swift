import Foundation
import Testing

@testable import RailCore

/// `OperatorBranding` against `app-operator-branding.js`, over every distinct
/// operator string and every line in all five shipped packages.
///
/// The expected values in `port-fixtures/operator-branding.json` are whatever
/// the JavaScript returns today, so a failure here means the two apps would
/// show a reader different words or different artwork for the same railway.
/// Several of the recorded answers look wrong — a well-known railway with no
/// mark, a split part wearing a company mark the audit set rejects — and are
/// deliberate: the fixture's `contract` field names all three.
struct OperatorBrandingParityTests {

    // MARK: - loading

    struct Fixture: Decodable {
        struct OperatorCase: Decodable {
            let `operator`: String?
            let country: String?
            let companyLabel: String
            let normalizeTaiwanCompanyName: String
            let operatorLogo: String?
            let note: String?
        }
        struct CompanyForCase: Decodable {
            let `operator`: String?
            let lineName: String?
            let company: String
            let note: String?
        }
        struct LineCase: Decodable {
            struct Input: Decodable {
                let lineId: String?
                let id: String?
                let `operator`: String?
                let logo: String?
            }
            let country: String?
            let input: Input?
            let verifiedPackageLineLogo: String?
            let lineLogo: String?
            let logoForLine: String?
            let note: String?
        }
        struct DarkMatteCase: Decodable {
            let logo: String?
            let needsDarkMatte: Bool
            let note: String?
        }
        let cases: [OperatorCase]
        let companyFor: [CompanyForCase]
        let lines: [LineCase]
        let darkMatte: [DarkMatteCase]
    }

    static func load() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "operator-branding.json")
    }

    /// Compares the way JavaScript does — by UTF-16 code unit.
    ///
    /// `==` on `String` would be the wrong assertion for this module, and
    /// wrong in the direction that hides the bug: it holds under canonical
    /// equivalence, so a port that normalised its answers (or that leaned on a
    /// `[String: String]` table and matched a decomposed name against a
    /// composed key) would return a *different* string and still pass. The
    /// fixture carries decomposed inputs for exactly this reason.
    static func sameCodeUnits(_ got: String?, _ expected: String?) -> Bool {
        switch (got, expected) {
        case (nil, nil): return true
        case let (got?, expected?): return Array(got.utf16) == Array(expected.utf16)
        default: return false
        }
    }

    static func line(_ input: Fixture.LineCase.Input?) -> OperatorBranding.Line? {
        guard let input else { return nil }
        return OperatorBranding.Line(
            lineId: input.lineId,
            id: input.id,
            operator: input.operator,
            logo: input.logo
        )
    }

    /// A description that survives being printed: several inputs here differ
    /// from an ordinary string only by an invisible character, and a failure
    /// message showing `"東急電鉄"` twice would be useless.
    static func spell(_ value: String?) -> String {
        guard let value else { return "nil" }
        return value.unicodeScalars
            .map { scalar in
                if scalar.value < 0x20 || scalar.properties.isWhitespace
                    || scalar.value == 0xFEFF || scalar.value == 0x0085
                    || scalar.properties.isDiacritic
                {
                    return String(format: "U+%04X", scalar.value)
                }
                return String(scalar)
            }
            .joined()
    }

    // MARK: - company names

    /// Every distinct operator string in mo, hk, tw, kr and jp, plus the
    /// inputs written to break a port. A classifier's failures are all in the
    /// strings nobody thought to sample, so this is a census, not a sample.
    @Test("company labels match, character for character")
    func companyLabels() throws {
        let fixture = try Self.load()
        #expect(fixture.cases.count > 200, "the packages carry 208 distinct operators")

        for item in fixture.cases {
            let got = OperatorBranding.companyLabel(item.operator)
            #expect(
                Self.sameCodeUnits(got, item.companyLabel),
                """
                companyLabel(\(Self.spell(item.operator))) = \(Self.spell(got)) \
                but JavaScript says \(Self.spell(item.companyLabel))\
                \(item.note.map { " — \($0)" } ?? "")
                """
            )
        }
    }

    @Test("Taiwan company names normalise identically")
    func taiwanNormalisation() throws {
        let fixture = try Self.load()
        for item in fixture.cases {
            let got = OperatorBranding.normalizeTaiwanCompanyName(item.operator)
            #expect(
                Self.sameCodeUnits(got, item.normalizeTaiwanCompanyName),
                """
                normalizeTaiwanCompanyName(\(Self.spell(item.operator))) = \
                \(Self.spell(got)) but JavaScript says \
                \(Self.spell(item.normalizeTaiwanCompanyName))\
                \(item.note.map { " — \($0)" } ?? "")
                """
            )
        }
    }

    /// The suppression rule, which is the one place a UTF-16 prefix test is
    /// load-bearing: `hasPrefix` would answer differently for a line name
    /// written with a combining mark, and the reader would see a company label
    /// the web app hides (or lose one the web app shows).
    @Test("the company beside a line name is suppressed on the same lines")
    func companyForLines() throws {
        let fixture = try Self.load()
        #expect(fixture.companyFor.count > 800, "one per line, all five packages")

        for item in fixture.companyFor {
            let got = OperatorBranding.companyFor(
                operator: item.operator, lineName: item.lineName)
            #expect(
                Self.sameCodeUnits(got, item.company),
                """
                companyFor(\(Self.spell(item.operator)), \(Self.spell(item.lineName))) \
                = \(Self.spell(got)) but JavaScript says \(Self.spell(item.company))\
                \(item.note.map { " — \($0)" } ?? "")
                """
            )
        }
    }

    // MARK: - logos

    @Test("operator marks resolve through the same chain")
    func operatorLogos() throws {
        let fixture = try Self.load()
        for item in fixture.cases {
            let got = OperatorBranding.operatorLogo(item.operator)
            #expect(
                Self.sameCodeUnits(got, item.operatorLogo),
                """
                operatorLogo(\(Self.spell(item.operator))) = \(got ?? "nil") \
                but JavaScript says \(item.operatorLogo ?? "nil")\
                \(item.note.map { " — \($0)" } ?? "")
                """
            )
        }
    }

    /// Every line of every package. Which badge a line wears is decided by
    /// three lookups in order, and an off-by-one in any of them is invisible
    /// in a sample: it shows up as one railway wearing another's mark.
    @Test("every line resolves to the same badge")
    func lineLogos() throws {
        let fixture = try Self.load()
        #expect(fixture.lines.count > 800, "804 lines plus the synthetic ones")

        for item in fixture.lines {
            let line = Self.line(item.input)
            let identity = item.input?.lineId ?? item.input?.id ?? "nil"

            #expect(
                Self.sameCodeUnits(
                    OperatorBranding.verifiedPackageLineLogo(line),
                    item.verifiedPackageLineLogo),
                """
                verifiedPackageLineLogo(\(identity))\
                \(item.note.map { " — \($0)" } ?? "")
                """
            )
            #expect(
                Self.sameCodeUnits(
                    line.flatMap {
                        OperatorBranding.lineLogo($0.lineId?.isEmpty == false ? $0.lineId : $0.id)
                    },
                    item.lineLogo),
                "lineLogo(\(identity))\(item.note.map { " — \($0)" } ?? "")"
            )
            #expect(
                Self.sameCodeUnits(OperatorBranding.logoForLine(line), item.logoForLine),
                """
                logoForLine(\(identity)) = \(OperatorBranding.logoForLine(line) ?? "nil") \
                but JavaScript says \(item.logoForLine ?? "nil")\
                \(item.note.map { " — \($0)" } ?? "")
                """
            )
        }
    }

    /// The three white-on-dark marks, and everything else that must NOT get a
    /// matte. Checked against every distinct badge the packages resolve to, so
    /// a port that widened the set fails here rather than in a screenshot.
    @Test("only the three white marks ask for a dark matte")
    func darkMatte() throws {
        let fixture = try Self.load()
        #expect(fixture.darkMatte.count > 400)

        for item in fixture.darkMatte {
            #expect(
                OperatorBranding.logoNeedsDarkMatte(item.logo) == item.needsDarkMatte,
                """
                logoNeedsDarkMatte(\(Self.spell(item.logo))) disagrees\
                \(item.note.map { " — \($0)" } ?? "")
                """
            )
        }
        #expect(
            fixture.darkMatte.filter(\.needsDarkMatte).count >= 3,
            "the fixture must still exercise all three members of the set"
        )
    }

    // MARK: - the properties the fixture cannot state

    /// Canonical equivalence must not create a table hit.
    ///
    /// This is asserted rather than left to the fixture because it is the one
    /// mistake a port makes silently and permanently: a `[String: String]`
    /// table answers this decomposed name and a JavaScript object does not.
    /// The fixture already carries the case; this states the reason.
    @Test("a decomposed name is not the composed key")
    func decomposedNamesMissTheTables() {
        let composed = "アルピコ交通"
        let decomposed = "\u{30a2}\u{30eb}\u{30d2}\u{309a}\u{30b3}交通"
        #expect(composed == decomposed, "Swift's own String equality is canonical")
        #expect(OperatorBranding.operatorLogo(composed) != nil)
        #expect(
            OperatorBranding.operatorLogo(decomposed) == nil,
            "JavaScript compares UTF-16 code units, so this misses the badge table"
        )
    }

    /// ECMAScript's trim, at both ends of where it differs from Foundation's.
    @Test("trim follows ECMAScript, not CharacterSet.whitespacesAndNewlines")
    func trimBoundaries() {
        // U+FEFF is ECMAScript WhiteSpace and is NOT in .whitespacesAndNewlines.
        #expect(OperatorBranding.operatorLogo("\u{feff}MTR") != nil)
        // U+0085 is in .whitespacesAndNewlines and is NOT ECMAScript WhiteSpace.
        #expect(OperatorBranding.operatorLogo("\u{0085}MTR") == nil)
        // U+3000 is trimmed at the ends and kept in the middle, which this
        // operator's real name depends on.
        #expect(
            OperatorBranding.operatorLogo("\u{3000}WILLER\u{3000}TRAINS\u{3000}")
                == "/rail/operator-logos/jp/q19727758.svg"
        )
    }
}
