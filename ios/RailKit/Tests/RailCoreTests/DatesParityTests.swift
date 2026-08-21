import Foundation
import Testing

@testable import RailCore

/// `RailCore.Dates` against `app-dates.js`, over `port-fixtures/dates.json`.
///
/// The inputs are the 229 real itineraries in the two committed train stores
/// plus nineteen projections of them (a field dropped, or the one real
/// overnight run carried onto another real store date), and every expected
/// value is what the JavaScript answered when the fixture was generated. So a
/// failure here says one thing only: this Swift disagrees with the app it was
/// forked from.
///
/// ## What these tests are guarding against specifically
///
/// Dates are where two languages disagree in silence. JavaScript months are
/// 0-based and `DateComponents.month` is 1-based; `new Date("2026-07-26")` is
/// UTC midnight while `new Date("2026/07/26")` is *local* midnight; a day that
/// crosses a daylight-saving boundary is not 24 hours long. None of those
/// mistakes throws — each simply moves an answer by one day, for some readers,
/// sometimes. The fixture therefore carries a month rollover
/// (2026-07-31 → 2026-08-01), both 2026 daylight-saving transitions in each
/// hemisphere's usual direction, a year boundary, a leap day, and dates that
/// pass the app's own validator without existing in the calendar.
struct DatesParityTests {

    // MARK: - fixture shape

    struct Fixture: Decodable {
        struct TrainInput: Decodable {
            let index: Int
            let source: String
            let id: String?
            let date: String?
            let stops: [Dates.Stop]

            var train: Dates.Train { Dates.Train(id: id, date: date, stops: stops) }
        }

        /// A day span. `breaks` is `trainDayBreaks` and `spanBreaks` is what
        /// the span reports; they differ for an undated train, which is the
        /// point of recording both.
        struct SpanCase: Decodable {
            let train: Int
            let trainDate: String
            let hasCrossDayTimes: Bool
            let breaks: [Dates.DayBreak]
            let spanDate: String
            let spanBreaks: [Dates.DayBreak]
            let dates: [String]
            let key: String
            let sig: String
        }

        struct AvailableDatesCase: Decodable {
            let trains: [Int]
            let manualDates: [String]
            let dates: [String]
        }

        struct BucketCase: Decodable {
            let date: String
            let trains: [Int]
        }

        struct SortCase: Decodable {
            let label: String
            let input: [Int]
            let order: [Int]
        }

        struct ComparisonCase: Decodable {
            let a: Int
            let b: Int
            let sign: Int
        }

        /// The comparator's last branch, probed over the id charset. `a` and
        /// `b` are ids rather than train indices here.
        struct IdTiebreakCase: Decodable {
            let a: String
            let b: String
            let sign: Int
        }

        /// `minutes` is null where the JavaScript answered `Infinity`, which
        /// JSON cannot spell.
        struct DepartureCase: Decodable {
            let train: Int
            let minutes: Double?
        }

        struct SpansDateCase: Decodable {
            let train: Int
            let date: String
            let spans: Bool
        }

        struct SegmentCase: Decodable {
            let train: Int
            let segmentIndex: Int
            let date: String
        }

        struct ReconcileCase: Decodable {
            let selectedDate: String
            let trains: [Int]
            let manualDates: [String]
            let result: String
        }

        struct LabelCase: Decodable {
            let date: String
            let label: String
        }

        struct DayArithmeticCase: Decodable {
            let date: String
            let days: Int
            let result: String?
        }

        struct SortKeyCase: Decodable {
            let date: String
            let key: String
        }

        let trains: [TrainInput]
        let cases: [SpanCase]
        let availableDates: [AvailableDatesCase]
        let trainsForDate: [BucketCase]
        let sortOrders: [SortCase]
        let comparisons: [ComparisonCase]
        let idTiebreak: [IdTiebreakCase]
        /// The locale the JavaScript runtime resolved to when the answers
        /// above were recorded. Not an input — context for a disagreement.
        let tiebreakLocale: String
        let departureMinutes: [DepartureCase]
        let spansDate: [SpansDateCase]
        let segmentDates: [SegmentCase]
        let reconcile: [ReconcileCase]
        let labels: [LabelCase]
        let dayArithmetic: [DayArithmeticCase]
        let sortKeys: [SortKeyCase]
    }

    static func load() throws -> Fixture {
        let fixture = try PortFixtures.decode(Fixture.self, "dates.json")
        // The case lists address trains by index, so a fixture whose ordering
        // moved would silently test the wrong train against the right answer.
        for (position, train) in fixture.trains.enumerated() {
            #expect(train.index == position)
        }
        return fixture
    }

    // MARK: - buckets

    @Test("every train lands in the same date bucket")
    func trainDates() throws {
        let fixture = try Self.load()
        #expect(fixture.cases.count == fixture.trains.count)
        for item in fixture.cases {
            let input = fixture.trains[item.train]
            #expect(
                Dates.trainDate(input.train) == item.trainDate,
                "train \(item.train) (\(input.source)) id=\(input.id ?? "—") date=\(input.date ?? "—")"
            )
        }
    }

    /// The projections are the reason the bucket test means anything: without
    /// them every train carries an explicit `date` and the two fallbacks —
    /// read the date out of the id, then give up and answer `undated` — are
    /// never taken.
    @Test("the fixture actually reaches every bucket rule")
    func bucketRulesAreCovered() throws {
        let fixture = try Self.load()
        let inferred = fixture.trains.filter {
            $0.date == nil && $0.id != nil
        }
        let undated = fixture.cases.filter { $0.trainDate == Dates.undated }
        #expect(inferred.count >= 8, "no train exercises inferDateFromTrainId")
        #expect(undated.count >= 3, "no train reaches the UNDATED bucket")
    }

    @Test("date sort keys put UNDATED last")
    func sortKeys() throws {
        let fixture = try Self.load()
        for item in fixture.sortKeys {
            #expect(Dates.dateSortKey(item.date) == item.key)
        }
        // Asserted rather than read from the fixture, because it is the
        // property the ordering relies on and not merely a value.
        #expect(Dates.dateSortKey(Dates.undated) == "\u{FFFF}")
    }

    @Test("date labels take the same branch")
    func labels() throws {
        let fixture = try Self.load()
        for item in fixture.labels {
            #expect(Dates.dateLabelKey(item.date) == item.label)
        }
    }

    // MARK: - cross-day spans

    @Test("day spans cover the same calendar days, with the same break positions")
    func daySpans() throws {
        let fixture = try Self.load()
        for item in fixture.cases {
            let input = fixture.trains[item.train]
            let where_ = "train \(item.train) (\(input.source))"
            #expect(Dates.hasCrossDayTimes(input.train) == item.hasCrossDayTimes, "\(where_)")
            #expect(Dates.dayBreaks(input.train) == item.breaks, "\(where_)")

            let span = Dates.daySpan(input.train)
            #expect(span.date == item.spanDate, "\(where_)")
            #expect(span.breaks == item.spanBreaks, "\(where_)")
            #expect(span.dates == item.dates, "\(where_)")
            // The two strings the render path is keyed on. `key` decides which
            // days keep a train in scope; `sig` additionally re-splits the
            // drawn segments when a break moves, so they are checked apart.
            #expect(span.key == item.key, "\(where_) span key")
            #expect(span.sig == item.sig, "\(where_) record-cache signature")
        }
    }

    /// The case that would catch a day added through a local calendar, and the
    /// one that would catch a day added by incrementing the day-of-month.
    @Test("the overnight itinerary is present, and one copy rolls over a month")
    func overnightCoverage() throws {
        let fixture = try Self.load()
        let multiDay = fixture.cases.filter { $0.dates.count > 1 }
        #expect(multiDay.count >= 4, "no multi-day span left in the fixture")
        #expect(
            multiDay.contains { $0.dates == ["2026-07-31", "2026-08-01"] },
            "no span crosses a month boundary — the arithmetic is untested there"
        )
        // An undated train short-circuits before the cross-day branch even
        // though its times climb past 24:00. Reproduced from the JavaScript,
        // and asserted here so a "tidier" port cannot quietly change it.
        let undatedCrossDay = fixture.cases.filter {
            $0.trainDate == Dates.undated && $0.hasCrossDayTimes
        }
        #expect(!undatedCrossDay.isEmpty)
        for item in undatedCrossDay {
            #expect(!item.breaks.isEmpty)
            #expect(item.spanBreaks.isEmpty)
            #expect(item.dates == [Dates.undated])
        }
    }

    @Test("a train is in scope on the same days")
    func spansDate() throws {
        let fixture = try Self.load()
        for item in fixture.spansDate {
            let input = fixture.trains[item.train]
            #expect(
                Dates.trainSpans(input.train, date: item.date) == item.spans,
                "train \(item.train) (\(input.source)) on \(item.date.isEmpty ? "«empty»" : item.date)"
            )
        }
        // The falsy-date guard, which the fixture spells as "" — a nil date
        // has to mean the same "no filter" and JSON has no way to say so.
        let anyTrain = fixture.trains[0].train
        #expect(Dates.trainSpans(anyTrain, date: nil))
    }

    @Test("each route segment runs on the same day")
    func segmentDates() throws {
        let fixture = try Self.load()
        for item in fixture.segmentDates {
            let span = Dates.daySpan(fixture.trains[item.train].train)
            #expect(
                Dates.segmentDate(span, segmentIndex: item.segmentIndex) == item.date,
                "train \(item.train) segment \(item.segmentIndex)"
            )
        }
    }

    // MARK: - ordering

    @Test("departure minutes agree, including the Infinity case")
    func departureMinutes() throws {
        let fixture = try Self.load()
        for item in fixture.departureMinutes {
            let actual = Dates.departureMinutes(of: fixture.trains[item.train].train)
            if let expected = item.minutes {
                #expect(actual == expected, "train \(item.train)")
            } else {
                #expect(actual == .infinity, "train \(item.train) should sort last")
            }
        }
        #expect(fixture.departureMinutes.contains { $0.minutes == nil })
    }

    @Test("the comparator returns the same sign")
    func comparisons() throws {
        let fixture = try Self.load()
        for item in fixture.comparisons {
            let a = fixture.trains[item.a]
            let b = fixture.trains[item.b]
            let sign = Dates.compareByDateAndDeparture(a.train, b.train).signum()
            #expect(sign == item.sign, "compare(\(item.a), \(item.b))")
        }
    }

    /// The test that justifies pinning a locale.
    ///
    /// `String#localeCompare` uses the JavaScript runtime's *default* locale,
    /// which resolved to `en-US` where these answers were recorded. Over the
    /// `[A-Za-z0-9_-]` charset ids are allowed (jsonspec §3.2), that collation
    /// and UTF-16 code-unit order genuinely disagree — `"a_b"` before `"a-b"`
    /// under ICU and after it by code unit, `"AB"` after `"ab"` under ICU and
    /// before it by code unit — so a port that reached for `<` on `String`, or
    /// for the code-unit rule the coordinate keys use, would pass every case
    /// built from real ids and be wrong the first time an id had a capital or
    /// a hyphen in it.
    ///
    /// These probes are compared through the whole comparator, on trains that
    /// tie on both earlier branches, so what is being checked is the branch as
    /// it is actually reached.
    @Test("the id tiebreak orders the way the JavaScript's collation does")
    func idTiebreak() throws {
        let fixture = try Self.load()
        #expect(fixture.tiebreakLocale == "en-US", "the fixture was recorded under a different locale")
        for item in fixture.idTiebreak {
            let a = Dates.Train(id: item.a, date: "2026-07-03", stops: [])
            let b = Dates.Train(id: item.b, date: "2026-07-03", stops: [])
            #expect(
                Dates.compareByDateAndDeparture(a, b).signum() == item.sign,
                "\(item.a) vs \(item.b)"
            )
        }
        // The pairs that separate the two candidate rules have to be in there,
        // or the test above is satisfied by either.
        #expect(fixture.idTiebreak.contains { $0.a == "a_b" && $0.b == "a-b" })
        #expect(fixture.idTiebreak.contains { $0.a == "AB" && $0.b == "ab" })
    }

    @Test("sorting produces the same order")
    func sortOrders() throws {
        let fixture = try Self.load()
        for item in fixture.sortOrders {
            let sorted = Dates.sortByDateAndDeparture(item.input.map { fixture.trains[$0].train })
            // Compared as (bucket, departure, id) triples rather than by
            // identity: Swift has no object identity to map back through, and
            // the triple is the whole of what the ordering claims.
            let expected = item.order.map { fixture.trains[$0] }
            #expect(sorted.count == expected.count, "\(item.label)")
            for (actual, wanted) in zip(sorted, expected) {
                #expect(Dates.trainDate(actual) == Dates.trainDate(wanted.train), "\(item.label)")
                #expect(
                    Dates.departureMinutes(of: actual)
                        == Dates.departureMinutes(of: wanted.train), "\(item.label)")
                #expect(actual.id == wanted.id, "\(item.label)")
            }
        }
        // The tiebreak case exists only because of a projection; if it were
        // ever dropped, the id comparison would go untested and the locale
        // pinned for it would be pinned on nothing.
        #expect(fixture.sortOrders.contains { $0.label == "id tiebreak only" })
    }

    // MARK: - the date bar

    @Test("the available date list matches, order included")
    func availableDates() throws {
        let fixture = try Self.load()
        for (position, item) in fixture.availableDates.enumerated() {
            let dates = Dates.availableDates(
                item.trains.map { fixture.trains[$0].train },
                manualDates: item.manualDates
            )
            #expect(dates == item.dates, "availableDates case \(position) \(item.manualDates)")
        }
        // 2026-06-31 has to survive: isValidDateString checks the day only
        // against 31 and never asks the month, so a day that does not exist is
        // accepted into the date bar. The JavaScript does this; the port does
        // it too, and this assertion is here so the behaviour is stated rather
        // than merely inherited.
        #expect(Dates.availableDates([], manualDates: ["2026-06-31"]) == ["2026-06-31"])
        #expect(Dates.availableDates([], manualDates: ["2026-13-01"]).isEmpty)
    }

    @Test("each date bucket holds the same trains")
    func trainsForDate() throws {
        let fixture = try Self.load()
        let all = fixture.trains.map(\.train)
        for item in fixture.trainsForDate {
            let expected = item.trains.map { fixture.trains[$0].train }
            let actual = Dates.trains(all, inBucket: item.date)
            #expect(actual.count == expected.count, "bucket \(item.date)")
            for (actualTrain, wanted) in zip(actual, expected) {
                #expect(actualTrain.id == wanted.id, "bucket \(item.date)")
            }
        }
    }

    @Test("a selection is reconciled the same way")
    func reconcile() throws {
        let fixture = try Self.load()
        for item in fixture.reconcile {
            let result = Dates.reconcileSelectedDate(
                item.selectedDate,
                trains: item.trains.map { fixture.trains[$0].train },
                manualDates: item.manualDates
            )
            #expect(
                result == item.result,
                "reconcile(\(item.selectedDate), \(item.trains.count) trains)"
            )
        }
    }

    // MARK: - day arithmetic

    /// The test the whole time-zone discussion comes down to.
    ///
    /// The JavaScript adds a day as `Date.UTC(...) + days × 86 400 000` read
    /// back through `getUTC*`, so the answer is the same everywhere on Earth
    /// and the same on both sides of a daylight-saving transition. A port that
    /// used `Calendar.date(byAdding:)` with the device's calendar would pass
    /// most of these and fail the March and October probes for readers in a
    /// zone that observes DST — which is to say, it would fail in the field
    /// and not in CI.
    @Test("day arithmetic agrees, across months, years, leap days and DST")
    func dayArithmetic() throws {
        let fixture = try Self.load()
        for item in fixture.dayArithmetic {
            #expect(
                Dates.addDays(item.date, item.days) == item.result,
                "addDays(\(item.date), \(item.days))"
            )
        }
        // The probes have to be present, not merely passing: the fixture is
        // regenerated by a script and a rule that stopped emitting them would
        // leave a green test that checks nothing interesting.
        for date in ["2026-03-29", "2026-10-25", "2026-12-31", "2028-02-28"] {
            #expect(
                fixture.dayArithmetic.contains { $0.date == date && $0.days != 0 },
                "no arithmetic probe on \(date)"
            )
        }
    }

    /// The same inputs, computed with the process time zone forced somewhere
    /// that observes DST in the opposite hemisphere.
    ///
    /// `Dates` reaches for no calendar at all, so this passes by construction —
    /// which is exactly why it is worth asserting. It is the test that fails
    /// the day someone "simplifies" the civil-date arithmetic into
    /// `Calendar.current`.
    @Test("day arithmetic is unmoved by the ambient time zone")
    func dayArithmeticIgnoresTheAmbientZone() throws {
        let fixture = try Self.load()
        let zones = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Auckland"]
        for name in zones {
            guard let zone = TimeZone(identifier: name) else {
                Issue.record("no time zone \(name)")
                continue
            }
            // Only the *defaults* can be moved from a test; nothing in Dates
            // reads them, and that is the assertion.
            let previous = NSTimeZone.default
            NSTimeZone.default = zone
            defer { NSTimeZone.default = previous }
            for item in fixture.dayArithmetic {
                #expect(
                    Dates.addDays(item.date, item.days) == item.result,
                    "addDays(\(item.date), \(item.days)) under \(name)"
                )
            }
        }
    }

    // MARK: - the primitives underneath

    /// Not fixture-driven: these state properties the ported rules rely on,
    /// where the fixture can only show values.
    @Test("the JavaScript's own parsing quirks are reproduced")
    func parsingQuirks() {
        // A cross-day time is a running count, not a clock reading. The
        // expected values are written as Double: `parseTimeToMinutes` answers
        // a JavaScript number, and comparing `Double?` against an integer
        // literal compiles and is then always false.
        #expect(Dates.parseTimeToMinutes("25:10") == Double(25 * 60 + 10))
        #expect(Dates.parseTimeToMinutes("01:10 +1") == Double(24 * 60 + 70))
        #expect(Dates.parseTimeToMinutes("9:05") == Double(9 * 60 + 5))  // \d{1,2} backtracks
        // Anchored at the start only, so trailing text is ignored, and a `+`
        // with no digits behind it leaves the match standing.
        #expect(Dates.parseTimeToMinutes("07:30 (approx)") == Double(7 * 60 + 30))
        #expect(Dates.parseTimeToMinutes("07:30+") == Double(7 * 60 + 30))
        #expect(Dates.parseTimeToMinutes("7:5") == nil)  // \d{2} for the minute
        #expect(Dates.parseTimeToMinutes(nil) == nil)
        // JavaScript's \d without the u flag is ASCII-only. An ICU-backed
        // regex would accept these and read the train as cross-day.
        #expect(Dates.parseTimeToMinutes("２５:１０") == nil)
        #expect(!Dates.isCrossDayTimeString("２５:１０"))
        #expect(Dates.isCrossDayTimeString("25:10"))
        #expect(Dates.isCrossDayTimeString("10:00+1"))
        #expect(!Dates.isCrossDayTimeString("23:59"))

        // The date validator asks 1..31 and never asks the month.
        #expect(Dates.isValidDateString("2026-06-31"))
        #expect(Dates.isValidDateString("2026-02-30"))
        #expect(!Dates.isValidDateString("2026-13-01"))
        #expect(!Dates.isValidDateString("2026-7-04"))
        // Slashes are rewritten; padding is trimmed.
        #expect(Dates.normalizeDateString(" 2026/07/04 ") == "2026-07-04")
        #expect(Dates.normalizeDateString("not-a-date") == nil)

        // Eight digits bounded by non-digits, leftmost match.
        #expect(Dates.inferDateFromTrainId("20260703_01_haruka") == "2026-07-03")
        #expect(Dates.inferDateFromTrainId("a123456789b") == nil)  // nine in a row
        #expect(Dates.inferDateFromTrainId(nil) == nil)

        // `days == 0` short-circuits before any normalisation, so a date that
        // does not exist survives unchanged and then moves two days on +1.
        #expect(Dates.addDays("2026-06-31", 0) == "2026-06-31")
        #expect(Dates.addDays("2026-06-31", 1) == "2026-07-02")
        // Date.UTC's two-digit-year rule, and its unpadded year on the way out.
        #expect(Dates.addDays("0026-07-04", 1) == "1926-07-05")
        #expect(Dates.addDays("0100-01-01", 1) == "100-01-02")
        #expect(Dates.addDays("9999-12-31", 1) == "10000-01-01")
    }
}
