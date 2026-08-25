import Foundation

/// The itinerary date rules, ported from `app-dates.js` §6 and the
/// `shared/app-core.js` primitives it is built on.
///
/// A train lives in exactly **one** date bucket — its own `date`, the date
/// read out of its id, or `undated` — and every per-day view in the app is
/// derived from that bucket rather than stored beside it, so the daily lists
/// and the combined list cannot drift apart. An overnight train stays in one
/// bucket while physically covering several calendar days: `daySpan` derives
/// the days it touches from its own stop times, where 25:10 means 01:10 the
/// next day (jsonspec §10.5).
///
/// ## Why this file is careful about time zones
///
/// It has none, and that is a ported property, not a simplification. The
/// JavaScript adds a day like this:
///
/// ```js
/// new Date(Date.UTC(year, month - 1, day) + days * 86400000)
/// ```
///
/// and reads the result back through `getUTCFullYear` / `getUTCMonth` /
/// `getUTCDate`. Every step is UTC, and a UTC day is exactly 86 400 000 ms,
/// so the calculation cannot see a time zone and cannot see daylight saving
/// either — 2026-03-29 in Europe is a 23-hour day locally and still exactly
/// one increment here. The neighbouring JavaScript spelling
/// `new Date("2026-07-26")` would also be UTC midnight, but
/// `new Date("2026/07/26")` and `new Date(2026, 6, 26)` are *local* midnight,
/// and the app uses none of those.
///
/// So the port does the arithmetic on integer civil dates and never touches
/// `Calendar`, `TimeZone`, `Date` or `DateFormatter`. Reaching for a calendar
/// here would be strictly worse than useless: it would introduce the one
/// dependency the original does not have, and it would answer differently for
/// a reader west of UTC and differently again twice a year.
///
/// The two places the JavaScript *is* environment-dependent are called out at
/// their definitions: `Date.UTC`'s two-digit-year rule (``addDays``) and
/// `String#localeCompare` (``compareByDateAndDeparture``).
public enum Dates {

    // MARK: - the values the buckets are named with

    /// `ALL_DATES` from `app-config.js` — the sentinel for the combined view.
    /// Not a date: it never reaches the arithmetic, only the guards.
    public static let allDates = "__all__"

    /// `UNDATED` from `app-core.js` — the bucket for a train whose date could
    /// neither be supplied nor inferred.
    public static let undated = "undated"

    /// `dateSortKey`'s replacement for ``undated``.
    ///
    /// U+FFFF is above every character a `YYYY-MM-DD` string can contain, so
    /// substituting it is what forces the undated bucket to the end of the
    /// date bar without a special case in the comparator.
    public static let undatedSortKey = "\u{FFFF}"

    // MARK: - the shapes a date rule reads

    /// One stop, reduced to the three fields the date rules look at.
    ///
    /// `stopType` earns its place only through ``departureMinutes(of:)``,
    /// which falls back to the stop marked `origin` when the first stop has no
    /// departure time. Everything else a stop carries (station, coordinates,
    /// platform) takes no part in deciding a date and is ignored on decode.
    public struct Stop: Decodable, Sendable {
        public var arrival: String?
        public var departure: String?
        public var stopType: String?

        private enum CodingKeys: String, CodingKey {
            case arrival, departure
            case stopType = "stop_type"
        }

        public init(arrival: String? = nil, departure: String? = nil, stopType: String? = nil) {
            self.arrival = arrival
            self.departure = departure
            self.stopType = stopType
        }
    }

    /// One train, reduced likewise.
    ///
    /// `id` and `date` are optional because the JavaScript genuinely receives
    /// them missing — jsonspec allows a train with no `date`, and the editor
    /// creates a train before either field is typed. Both `undefined` and
    /// `null` fail the JavaScript's `typeof value !== "string"` test, so both
    /// decode to `nil` here and take the same path.
    public struct Train: Decodable, Sendable {
        public var id: String?
        public var date: String?
        public var stops: [Stop]

        public init(id: String? = nil, date: String? = nil, stops: [Stop] = []) {
            self.id = id
            self.date = date
            self.stops = stops
        }
    }

    /// `{ index, day }` — the itinerary rolls into day `day` (0-based, counted
    /// from the train's own date) **after** `stops[index]`.
    ///
    /// So `index` is the last station of the outgoing day, which is the one
    /// the map marks with the cross-day symbol: it is simultaneously the last
    /// station of day D and the first of day D+1, and one symbol serves both.
    public struct DayBreak: Decodable, Equatable, Sendable {
        public var index: Int
        public var day: Int

        public init(index: Int, day: Int) {
            self.index = index
            self.day = day
        }
    }

    /// Everything the map needs about which calendar days a train covers.
    ///
    /// `key` is what the GPU layers filter and dim on, so a cross-day train
    /// stays in scope on *both* of its days; `sig` adds the break positions,
    /// because moving a break re-splits the drawn segments even when the dates
    /// are unchanged and the record cache has to notice that.
    public struct DaySpan: Equatable, Sendable {
        public var date: String
        public var breaks: [DayBreak]
        public var dates: [String]
        public var key: String
        public var sig: String
    }

    // MARK: - JavaScript primitives the rules are spelled in

    /// ECMAScript `WhiteSpace` ∪ `LineTerminator` — what `String#trim` and the
    /// regular-expression `\s` actually strip.
    ///
    /// The set itself is ``JSString/whitespace``; `Train.swift` spelled the
    /// same one and the two have been moved together. Time and date strings
    /// arrive from pasted spreadsheets and hand-typed forms, which is exactly
    /// where a stray no-break space or byte-order mark turns up, so the
    /// scanners below need the set and not only the trim.
    private static let jsWhitespace = JSString.whitespace

    /// ECMAScript `String.prototype.trim`.
    private static func jsTrim(_ text: String) -> String { JSString.trim(text) }

    /// `\d` as JavaScript means it *without* the `u` flag: ASCII 0–9 only.
    ///
    /// This is the reason none of the scanners below is an
    /// `NSRegularExpression`. ICU's `\d` is `\p{Nd}`, which also matches
    /// Arabic-Indic and fullwidth digits — so an ICU translation of these same
    /// patterns would parse `２５:１０` as a cross-day time where the app
    /// rejects it outright.
    private static func isAsciiDigit(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value >= 48 && scalar.value <= 57
    }

    // MARK: - date strings

    /// `isValidDateString` — `^\d{4}-\d{2}-\d{2}$`, month 1–12, day 1–31.
    ///
    /// The day is checked only against 31, never against the month, so
    /// **2026-06-31 and 2026-02-30 are "valid" here**. That is not an
    /// oversight being carried over blindly: it is load-bearing, because it
    /// decides which manually-created dates survive into the date bar, and
    /// ``addDays`` then rolls such a date forward through the next month
    /// rather than rejecting it. Reproduced deliberately.
    public static func isValidDateString(_ value: String?) -> Bool {
        guard let value else { return false }
        let scalars = Array(value.unicodeScalars)
        guard scalars.count == 10 else { return false }
        for index in [0, 1, 2, 3, 5, 6, 8, 9] where !isAsciiDigit(scalars[index]) {
            return false
        }
        guard scalars[4] == "-", scalars[7] == "-" else { return false }
        let month = numeric(scalars[5...6])
        let day = numeric(scalars[8...9])
        return month >= 1 && month <= 12 && day >= 1 && day <= 31
    }

    private static func numeric(_ digits: ArraySlice<Unicode.Scalar>) -> Int {
        digits.reduce(0) { $0 * 10 + Int($1.value - 48) }
    }

    /// `normalizeDateString` — trim, rewrite every `/` as `-`, then validate.
    ///
    /// The slash rewrite is what lets a user type `2026/08/05` into the date
    /// bar; it is a normalisation, not a second accepted format, so anything
    /// that fails ``isValidDateString`` afterwards is dropped.
    public static func normalizeDateString(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = jsTrim(value).replacingOccurrences(of: "/", with: "-")
        return isValidDateString(normalized) ? normalized : nil
    }

    /// `inferDateFromTrainId` — the first 8 digits in the id that are bounded
    /// by non-digits, read as `YYYYMMDD`.
    ///
    /// A hand-rolled scan of `/(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?:[^0-9]|$)/`
    /// rather than a regex, and it reproduces the engine's search order
    /// exactly: at each start position the empty `^` alternative is tried
    /// before the one that consumes a non-digit, and the leftmost position
    /// that matches wins. Getting that order wrong would shift which 8 digits
    /// of a longer numeric run are read, which silently re-dates a train.
    public static func inferDateFromTrainId(_ id: String?) -> String? {
        // `String(id || "")` — a missing id becomes the empty string, which
        // simply fails to match.
        let scalars = Array((id ?? "").unicodeScalars)
        for start in 0...max(scalars.count, 0) {
            // Alternative 1: `^`, which consumes nothing and only exists at 0.
            if start == 0, let found = readDate(scalars, at: 0) { return found }
            // Alternative 2: `[^0-9]`, which consumes one character.
            if start < scalars.count, !isAsciiDigit(scalars[start]),
                let found = readDate(scalars, at: start + 1)
            {
                return found
            }
        }
        return nil
    }

    /// `(\d{4})(\d{2})(\d{2})(?:[^0-9]|$)` anchored at `offset`.
    private static func readDate(_ scalars: [Unicode.Scalar], at offset: Int) -> String? {
        guard offset + 8 <= scalars.count else { return nil }
        for index in offset..<(offset + 8) where !isAsciiDigit(scalars[index]) {
            return nil
        }
        // The trailing `[^0-9]|$` is what stops a 9-digit run from being read
        // as a date plus a spare digit.
        if offset + 8 < scalars.count, isAsciiDigit(scalars[offset + 8]) { return nil }
        let year = String(String.UnicodeScalarView(scalars[offset..<(offset + 4)]))
        let month = String(String.UnicodeScalarView(scalars[(offset + 4)..<(offset + 6)]))
        let day = String(String.UnicodeScalarView(scalars[(offset + 6)..<(offset + 8)]))
        let candidate = "\(year)-\(month)-\(day)"
        return isValidDateString(candidate) ? candidate : nil
    }

    /// `normalizeTrainDate` — explicit date, else the caller's fallback, else
    /// the date spelled in the id, else ``undated``.
    public static func normalizeTrainDate(
        _ train: Train?,
        fallback: String? = nil,
        undatedValue: String = undated
    ) -> String {
        if let explicit = normalizeDateString(train?.date) { return explicit }
        if let fallback = normalizeDateString(fallback) { return fallback }
        return inferDateFromTrainId(train?.id) ?? undatedValue
    }

    // MARK: - civil-date arithmetic

    /// `addDaysToDateString` — `date` shifted by `days`, or `nil` if `date` is
    /// not a valid date string.
    ///
    /// Three behaviours here look like bugs and are all reproduced, because a
    /// port that quietly fixes one is a port whose disagreements can no longer
    /// be read:
    ///
    /// 1. **`days == 0` returns the input verbatim.** The JavaScript
    ///    short-circuits on `if (!days) return date`, so `addDays("2026-06-31",
    ///    0)` stays `"2026-06-31"` while `addDays("2026-06-31", 1)` is
    ///    `"2026-07-02"` — June has no 31st, so the shift starts from July 1.
    /// 2. **Two-digit years become 19xx.** `Date.UTC` maps years 0–99 to
    ///    1900 + y, so `"0026-07-04"` plus a day is `"1926-07-05"`. This is the
    ///    one place the JavaScript's *value* depends on a legacy rule rather
    ///    than on arithmetic, and it is unreachable from any real itinerary,
    ///    but it is what the function returns.
    /// 3. **Only month and day are zero-padded.** The year comes through
    ///    `String(n)`, so a shift out of the four-digit range produces
    ///    `"100-01-02"` or `"10000-01-01"` — strings that ``isValidDateString``
    ///    would then reject.
    ///
    /// The arithmetic itself is Howard Hinnant's civil-date algorithm, which
    /// is the same proleptic Gregorian calendar `Date.UTC` implements, done in
    /// integers. That is what makes the result identical in every time zone:
    /// see the type-level note.
    public static func addDays(_ date: String?, _ days: Int) -> String? {
        guard let date, isValidDateString(date) else { return nil }
        if days == 0 { return date }
        let scalars = Array(date.unicodeScalars)
        var year = numeric(scalars[0...3])
        let month = numeric(scalars[5...6])
        let day = numeric(scalars[8...9])
        // `Date.UTC`'s legacy two-digit-year rule (ECMA-262 MakeFullYear).
        if year >= 0 && year <= 99 { year += 1900 }
        // `day - 1` as an offset rather than a calendar day is what makes an
        // out-of-range day (the 31st of June) roll forward the way `Date.UTC`
        // rolls it, instead of being rejected or clamped.
        let serial = daysFromCivil(year: year, month: month, day: 1) + (day - 1) + days
        let (y, m, d) = civilFromDays(serial)
        return "\(y)-\(pad2(m))-\(pad2(d))"
    }

    private static func pad2(_ value: Int) -> String {
        value >= 0 && value < 10 ? "0\(value)" : "\(value)"
    }

    /// Days since 1970-01-01 for a proleptic Gregorian civil date.
    private static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        // The era trick: shift the year so March starts it, which makes the
        // leap day the last day of the year and removes every special case.
        let y = year - (month <= 2 ? 1 : 0)
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400                              // 0…399
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146097 + dayOfEra - 719468
    }

    /// The inverse of ``daysFromCivil(year:month:day:)``.
    private static func civilFromDays(_ serial: Int) -> (year: Int, month: Int, day: Int) {
        let z = serial + 719468
        let era = (z >= 0 ? z : z - 146096) / 146097
        let dayOfEra = z - era * 146097                            // 0…146096
        let yearOfEra =
            (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365
        let year = yearOfEra + era * 400
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let mp = (5 * dayOfYear + 2) / 153                         // 0…11, March-based
        let day = dayOfYear - (153 * mp + 2) / 5 + 1
        let month = mp + (mp < 10 ? 3 : -9)
        return (year + (month <= 2 ? 1 : 0), month, day)
    }

    // MARK: - times

    /// ECMAScript `ToNumber` applied to a string, for the one caller that
    /// needs it: the hour field of a possibly-cross-day time.
    ///
    /// Written out rather than delegated to `Double(String)`, which disagrees
    /// with JavaScript in both directions — Swift accepts `"nan"`,
    /// `"infinity"` and `"0x1p3"`, which JavaScript reads as `NaN`; JavaScript
    /// accepts `""` and `"  "` as `0`, which Swift rejects.
    private static func jsToNumber(_ text: String) -> Double {
        let trimmed = jsTrim(text)
        if trimmed.isEmpty { return 0 }  // Number("") and Number(" ") are 0
        if trimmed == "Infinity" || trimmed == "+Infinity" { return .infinity }
        if trimmed == "-Infinity" { return -.infinity }
        // Radix literals take no sign in a StringNumericLiteral.
        if trimmed.count > 2, trimmed.hasPrefix("0") {
            let radix: Int?
            switch trimmed[trimmed.index(trimmed.startIndex, offsetBy: 1)] {
            case "x", "X": radix = 16
            case "o", "O": radix = 8
            case "b", "B": radix = 2
            default: radix = nil
            }
            if let radix {
                let digits = trimmed.dropFirst(2)
                guard let value = UInt64(digits, radix: radix) else { return .nan }
                return Double(value)
            }
        }
        // StrDecimalLiteral: [+-]? ( digits [. digits?] | . digits ) ( [eE] [+-]? digits )?
        var scalars = Array(trimmed.unicodeScalars)[...]
        if scalars.first == "+" || scalars.first == "-" { scalars = scalars.dropFirst() }
        let intDigits = scalars.prefix(while: isAsciiDigit)
        scalars = scalars.dropFirst(intDigits.count)
        var fractionDigits = ArraySlice<Unicode.Scalar>()
        if scalars.first == "." {
            scalars = scalars.dropFirst()
            fractionDigits = scalars.prefix(while: isAsciiDigit)
            scalars = scalars.dropFirst(fractionDigits.count)
        }
        if intDigits.isEmpty && fractionDigits.isEmpty { return .nan }
        if scalars.first == "e" || scalars.first == "E" {
            scalars = scalars.dropFirst()
            if scalars.first == "+" || scalars.first == "-" { scalars = scalars.dropFirst() }
            let exponentDigits = scalars.prefix(while: isAsciiDigit)
            if exponentDigits.isEmpty { return .nan }
            scalars = scalars.dropFirst(exponentDigits.count)
        }
        guard scalars.isEmpty else { return .nan }  // trailing junk ⇒ NaN
        return Double(trimmed) ?? .nan
    }

    /// `parseTimeToMinutes` — `"H:MM"` or `"HH:MM"`, optionally followed by
    /// `"+N"`, as minutes from the itinerary's own midnight.
    ///
    /// Returned as a `Double` because that is what a JavaScript number is, and
    /// because ``departureMinutes(of:)`` needs the missing case to be
    /// `.infinity` rather than a sentinel integer.
    ///
    /// Hand-rolled from `/^(\d{1,2}):(\d{2})(?:\s*\+\s*(\d+))?/`, including
    /// two properties that are easy to lose: the pattern is anchored only at
    /// the **start**, so trailing text is ignored rather than rejected; and
    /// `\d{1,2}` is greedy with backtracking, so `"9:05"` matches on the
    /// second attempt after the two-digit read fails to find its colon.
    public static func parseTimeToMinutes(_ value: String?) -> Double? {
        guard let value else { return nil }
        let scalars = Array(jsTrim(value).unicodeScalars)

        // (\d{1,2}) — two digits first, then one, mirroring greedy matching.
        var hourLength = 0
        for candidate in [2, 1] {
            guard candidate <= scalars.count else { continue }
            let allDigits = (0..<candidate).allSatisfy { isAsciiDigit(scalars[$0]) }
            if allDigits, candidate < scalars.count, scalars[candidate] == ":" {
                hourLength = candidate
                break
            }
        }
        guard hourLength > 0 else { return nil }
        var cursor = hourLength + 1  // past the colon

        // (\d{2})
        guard cursor + 2 <= scalars.count,
            isAsciiDigit(scalars[cursor]), isAsciiDigit(scalars[cursor + 1])
        else { return nil }
        let hours = Double(numeric(scalars[0..<hourLength]))
        let minutes = Double(numeric(scalars[cursor..<(cursor + 2)]))
        cursor += 2

        // (?:\s*\+\s*(\d+))? — the whole group is optional, so a `+` with no
        // digits behind it leaves the match standing with no day offset.
        var dayOffset = 0.0
        var probe = cursor
        while probe < scalars.count, jsWhitespace.contains(scalars[probe]) { probe += 1 }
        if probe < scalars.count, scalars[probe] == "+" {
            probe += 1
            while probe < scalars.count, jsWhitespace.contains(scalars[probe]) { probe += 1 }
            let digits = scalars[probe...].prefix(while: isAsciiDigit)
            if !digits.isEmpty { dayOffset = Double(numeric(digits)) }
        }

        return dayOffset * 24 * 60 + hours * 60 + minutes
    }

    /// `isCrossDayTimeString` — the cheap pre-test, kept cheap.
    ///
    /// A `+` anywhere means the legacy `"10:00+1"` spelling; otherwise the
    /// text before the first colon is read as a number and compared with 24.
    /// It is `ToNumber`, not a digit parse, which is why ``jsToNumber(_:)``
    /// exists: `"0x18:00"` reads as hour 24 and is therefore cross-day.
    public static func isCrossDayTimeString(_ value: String?) -> Bool {
        guard let value else { return false }
        let text = jsTrim(value)
        if text.contains("+") { return true }
        guard let colon = text.firstIndex(of: ":"), colon != text.startIndex else {
            return false
        }
        // NaN >= 24 is false, so unparseable text is simply not cross-day.
        return jsToNumber(String(text[text.startIndex..<colon])) >= 24
    }

    public static func hasCrossDayTimes(_ train: Train?) -> Bool {
        guard let train else { return false }
        for stop in train.stops {
            if isCrossDayTimeString(stop.arrival) { return true }
            if isCrossDayTimeString(stop.departure) { return true }
        }
        return false
    }

    /// The moment the train is first *at* a stop.
    ///
    /// Arrival wins, so a stop that itself straddles midnight (arrives 23:58,
    /// leaves 25:03) still belongs to the outgoing day.
    private static func stopDayMinutes(_ stop: Stop) -> Double? {
        parseTimeToMinutes(stop.arrival) ?? parseTimeToMinutes(stop.departure)
    }

    /// `trainDayBreaks` — where the itinerary rolls into the next day.
    ///
    /// Untimed stops (pass-throughs carry no times) are skipped, so they
    /// inherit the previous timed stop's day and the break lands on the last
    /// station whose *recorded* time is still before midnight.
    public static func dayBreaks(_ train: Train?) -> [DayBreak] {
        guard let train, hasCrossDayTimes(train) else { return [] }
        var breaks: [DayBreak] = []
        var lastTimedIndex = -1
        var lastDay = 0.0
        for (index, stop) in train.stops.enumerated() {
            guard let minutes = stopDayMinutes(stop) else { continue }
            let day = (minutes / 1440).rounded(.down)
            // A train whose FIRST timed stop already reads 25:xx is mis-dated,
            // not cross-day: with no earlier station there is nothing to break
            // away from.
            if day > lastDay, lastTimedIndex >= 0 {
                breaks.append(DayBreak(index: lastTimedIndex, day: Int(day)))
            }
            if day > lastDay { lastDay = day }
            lastTimedIndex = index
        }
        return breaks
    }

    /// `dayIndexForSegment` — the day a route *segment* belongs to.
    ///
    /// Segment `s` runs `stops[s] → stops[s + 1]`, so the segment **leaving**
    /// the break station is already next-day (`>=`, where the stop-level rule
    /// uses `>`). That single character is the difference between the
    /// cross-day stretch being drawn on the right day and on the wrong one.
    public static func dayIndexForSegment(_ breaks: [DayBreak], _ segmentIndex: Int) -> Int {
        var day = 0
        for item in breaks where segmentIndex >= item.index { day = item.day }
        return day
    }

    // MARK: - ordering

    /// `dateSortKey` — ``undated`` becomes U+FFFF so it sorts last.
    public static func dateSortKey(_ date: String, undatedValue: String = undated) -> String {
        date == undatedValue ? undatedSortKey : date
    }

    /// JavaScript's `<` / `>` on strings, as a three-way result.
    ///
    /// Reuses ``JSNumber/stringLessOrEqual(_:_:)`` — the same UTF-16 code-unit
    /// rule the coordinate keys are ordered by — rather than Swift's `<`,
    /// which compares by Unicode canonical ordering. The two agree on
    /// `YYYY-MM-DD`, but the date bar's order is what a reader sees, and
    /// inheriting whichever rule the standard library happens to implement is
    /// how the two apps end up disagreeing over a bucket nobody tested.
    private static func jsStringCompare(_ a: String, _ b: String) -> Int {
        if a == b { return 0 }
        return JSNumber.stringLessOrEqual(a, b) ? -1 : 1
    }

    /// `getTrainDepartureMinutes` — first stop's departure, else the departure
    /// of the stop marked `origin`, else the first departure of any stop.
    ///
    /// `.infinity` when nothing parses, which is the JavaScript's own value
    /// and matters twice: it sorts such a train last, and `Infinity !==
    /// Infinity` being **false** is what sends two of them to the id tiebreak
    /// instead of producing a `NaN` comparison result that `Array#sort` would
    /// read as "equal".
    public static func departureMinutes(of train: Train) -> Double {
        guard let first = train.stops.first else { return .infinity }
        if let departure = parseTimeToMinutes(first.departure) { return departure }
        // `stops.find(stop => stop.stop_type === "origin")` — the first stop
        // so marked, which is not necessarily `stops[0]`.
        if let origin = train.stops.first(where: { $0.stopType == "origin" }),
            let departure = parseTimeToMinutes(origin.departure)
        {
            return departure
        }
        for stop in train.stops {
            if let departure = parseTimeToMinutes(stop.departure) { return departure }
        }
        return .infinity
    }

    /// `compareTrainsByDateAndDeparture` — date bucket, then departure minute,
    /// then the id.
    ///
    /// Returns a **sign**, not the JavaScript's raw value. The middle branch
    /// there returns `departureA - departureB`, a minute count rather than a
    /// comparison result, and `localeCompare`'s magnitude is explicitly
    /// implementation-defined; `Array.prototype.sort` reads nothing but the
    /// sign, so the sign is the entire contract.
    ///
    /// ## The id tiebreak is locale-dependent, and the JavaScript does not pin it
    ///
    /// `String#localeCompare` with no arguments uses the *runtime's* default
    /// locale, which resolved to `en-US` on the machine that generated the
    /// fixtures. That is a real hazard rather than a theoretical one: over the
    /// `[A-Za-z0-9_-]` charset train ids are restricted to (jsonspec §3.2),
    /// ICU's collation and UTF-16 code-unit order genuinely disagree —
    /// `"a_b"` sorts before `"a-b"` under ICU and after it by code unit, and
    /// `"AB"` sorts after `"ab"` under ICU and before it by code unit.
    ///
    /// Every id in both committed stores is `[0-9a-z_]` with its separators in
    /// fixed positions, so the two rules agree on all 229² real pairs — real
    /// data cannot tell them apart. `dates.json` therefore carries a block of
    /// id probes run through this same comparator, and Foundation's `en_US`
    /// collation was *measured* against V8's on all of them, the divergent
    /// pairs included, rather than assumed to agree.
    ///
    /// The locale is pinned here because the JavaScript's is not: an unpinned
    /// comparison would answer differently on a device set to a locale with a
    /// different collation, and nothing would notice until an id with a
    /// capital or a hyphen appeared.
    public static func compareByDateAndDeparture(
        _ a: Train,
        _ b: Train,
        undatedValue: String = undated
    ) -> Int {
        let dateA = dateSortKey(
            normalizeTrainDate(a, undatedValue: undatedValue), undatedValue: undatedValue)
        let dateB = dateSortKey(
            normalizeTrainDate(b, undatedValue: undatedValue), undatedValue: undatedValue)
        if dateA != dateB { return jsStringCompare(dateA, dateB) }

        let departureA = departureMinutes(of: a)
        let departureB = departureMinutes(of: b)
        if departureA != departureB { return departureA < departureB ? -1 : 1 }

        // `String(a.id)` — a missing id stringifies to "undefined" in
        // JavaScript, and that literal is what it is then compared as.
        return localeCompareSign(a.id ?? "undefined", b.id ?? "undefined")
    }

    /// The locale the tiebreak is pinned to. See ``compareByDateAndDeparture``.
    private static let tiebreakLocale = Locale(identifier: "en_US")

    private static func localeCompareSign(_ a: String, _ b: String) -> Int {
        switch a.compare(b, options: [], range: nil, locale: tiebreakLocale) {
        case .orderedAscending: return -1
        case .orderedDescending: return 1
        case .orderedSame: return 0
        }
    }

    // MARK: - app-dates.js §6

    /// `getTrainDate` — the bucket a train currently lives in.
    public static func trainDate(_ train: Train) -> String {
        normalizeTrainDate(train)
    }

    /// `sortTrainsByDateAndDeparture` — a sorted copy.
    ///
    /// `Array.prototype.sort` has been stable since ES2019 and Swift's `sort`
    /// is not, which would matter if the comparator could report two distinct
    /// trains equal. It cannot when ids are unique, because the last branch is
    /// then a strict total order; the risk is only that two trains share an id
    /// (or both lack one), and in that case neither implementation has an
    /// order to preserve that the other could disagree with.
    public static func sortByDateAndDeparture(_ trains: [Train]) -> [Train] {
        trains.sorted { compareByDateAndDeparture($0, $1) < 0 }
    }

    /// `getAvailableDates` — every bucket in use, plus the manually-created
    /// empty ones, earliest first with ``undated`` forced to the end.
    ///
    /// `manualDates` is a global in the JavaScript (it is UI state, persisted
    /// in `localStorage` by the app shell); it is a parameter here so that
    /// `RailCore` keeps no state of its own.
    public static func availableDates(
        _ trains: [Train],
        manualDates: [String] = []
    ) -> [String] {
        var seen = Set<String>()
        var buckets: [String] = []
        func insert(_ value: String) {
            if seen.insert(value).inserted { buckets.append(value) }
        }
        for train in trains { insert(trainDate(train)) }
        for date in manualDates {
            // The sentinel is passed through untouched; everything else has to
            // survive normalisation, which is what drops a blank or malformed
            // entry left behind in the persisted UI state.
            if date == undated {
                insert(undated)
            } else if let normalized = normalizeDateString(date) {
                insert(normalized)
            }
        }
        return buckets.sorted { jsStringCompare(dateSortKey($0), dateSortKey($1)) < 0 }
    }

    /// `getTrainsForDate` — the trains whose own bucket is `date`.
    ///
    /// Deliberately *not* the trains that run on `date`: an overnight train
    /// appears in one list and spans two days on the map. ``trainSpans(_:date:)``
    /// is the other question.
    public static func trains(_ trains: [Train], inBucket date: String) -> [Train] {
        trains.filter { trainDate($0) == date }
    }

    /// `getTrainDaySpan` — the calendar days one itinerary touches, day 0 first.
    ///
    /// An undated train short-circuits before the cross-day branch even when
    /// its times climb past 24:00, because there is no day 0 to count from —
    /// so its span reports no breaks although ``dayBreaks(_:)`` would find
    /// one. Reproduced from the JavaScript's `date !== UNDATED &&` guard.
    ///
    /// The JavaScript caches one shared span object per date for the
    /// single-day case, so the hot render path allocates nothing. That is an
    /// allocation strategy, not a rule — nothing observable depends on the
    /// identity of the object — so it is not ported.
    public static func daySpan(_ train: Train) -> DaySpan {
        let date = trainDate(train)
        if date != undated, hasCrossDayTimes(train) {
            let breaks = dayBreaks(train)
            if let last = breaks.last {
                var dates = [date]
                // A C-style loop, not `1...last.day`: a range whose upper bound
                // is below its lower bound traps in Swift, where the
                // JavaScript simply runs zero times.
                var day = 1
                while day <= last.day {
                    dates.append(addDays(date, day) ?? date)
                    day += 1
                }
                let key = "|\(dates.joined(separator: "|"))|"
                let sig = key + breaks.map { "\($0.index)>\($0.day)" }.joined(separator: ",")
                return DaySpan(date: date, breaks: breaks, dates: dates, key: key, sig: sig)
            }
        }
        let key = "|\(date)|"
        return DaySpan(date: date, breaks: [], dates: [date], key: key, sig: key)
    }

    /// `trainSpansDate` — does this train run on `date` at all, whether that is
    /// its own bucket or a day it crosses into?
    ///
    /// A missing or empty date, and the combined-view sentinel, all mean "no
    /// filter", so everything is in scope.
    public static func trainSpans(_ train: Train, date: String?) -> Bool {
        guard let date, !date.isEmpty, date != allDates else { return true }
        return daySpan(train).dates.contains(date)
    }

    /// `segmentDateForTrain` — the date one route segment actually runs on.
    public static func segmentDate(_ span: DaySpan, segmentIndex: Int) -> String {
        guard span.dates.count >= 2 else { return span.date }
        let index = dayIndexForSegment(span.breaks, segmentIndex)
        guard span.dates.indices.contains(index) else { return span.date }
        return span.dates[index]
    }

    /// `reconcileSelectedDate` — keep the selection renderable after the train
    /// set changes.
    ///
    /// Never force-switches to the *last* date: a still-valid selection is
    /// kept, and anything else falls back to the earliest. The combined view
    /// is always renderable, so it is never narrowed to a single day — a load
    /// that ends on "all" stays on "all".
    ///
    /// A function of its inputs here; the JavaScript reads and writes the
    /// `selectedDate` global, which is the app shell's business.
    public static func reconcileSelectedDate(
        _ selectedDate: String,
        trains: [Train],
        manualDates: [String] = []
    ) -> String {
        if selectedDate == allDates { return selectedDate }
        let dates = availableDates(trains, manualDates: manualDates)
        if dates.contains(selectedDate) { return selectedDate }
        return dates.first ?? allDates
    }

    /// `dateLabel`, minus the translation.
    ///
    /// The JavaScript spells two of the three answers through `I18N.t`, which
    /// follows the interface language and is therefore UI state. What belongs
    /// to the date rules is the branch: a concrete bucket labels itself, and
    /// the two sentinels need a word from the shell. So this returns the
    /// translation **key** for those two and the date itself otherwise, and
    /// the shell resolves the key.
    public static func dateLabelKey(_ date: String) -> String {
        if date == allDates { return "date.all" }
        if date == undated { return "date.undated" }
        return date
    }
}
