import Foundation

/// JavaScript's own spelling of a `Double`, and its own rounding.
///
/// This type exists because of a single measured fact. In JavaScript,
/// `String(139)` is `"139"`; in Swift, `String(139.0)` is `"139.0"`. The web
/// app builds coordinate keys by concatenating numbers into strings, and those
/// keys are a *persisted* format — route caches, stats edge keys and overlap
/// buckets are all keyed on those exact bytes. A port that spells one
/// coordinate `"139.0"` where the original spells it `"139"` does not merely
/// look different: it computes a different identity for the same point, so
/// every cache it writes is unreadable by the app it forked from and every
/// graph node silently splits in two.
///
/// The `port-fixtures/coords.json` cases lead with exactly these shapes
/// (integral values, negative zero, `0.00001`), because a fixture set that
/// only contains ordinary five-decimal coordinates would let a naive port
/// pass and fail in production.
public enum JSNumber {

    /// ECMAScript `Math.round`.
    ///
    /// Not the same function as Swift's `rounded()`. Swift rounds a tie away
    /// from zero, so `(-2.5).rounded()` is `-3`; JavaScript rounds a tie
    /// toward positive infinity, so `Math.round(-2.5)` is `-2`. Coordinates
    /// are quantised through this, and negative longitudes are ordinary in
    /// four of the five shipped countries, so the difference is reachable.
    ///
    /// The two early returns are the specification's own (ECMA-262,
    /// `Math.round`): they are what keeps `Math.round(0.49999999999999994)` at
    /// `0`, where a bare `floor(x + 0.5)` would answer `1` because the sum is
    /// not representable.
    public static func round(_ x: Double) -> Double {
        if x.isNaN || x.isInfinite || x == 0 { return x }
        if x > 0 && x < 0.5 { return 0 }
        if x < 0 && x >= -0.5 { return -0.0 }
        return (x + 0.5).rounded(.down)
    }

    /// ECMAScript `Number::toString` for base 10 — how JavaScript renders a
    /// number when it is concatenated into a string.
    ///
    /// Swift's own `description` is also shortest-round-trip, so the *digits*
    /// agree; what differs is the presentation, in three ways that all appear
    /// in real coordinate data:
    ///
    ///   - an integral value keeps no fractional part (`139`, not `139.0`)
    ///   - negative zero prints as `0`
    ///   - the switch to exponential notation happens at a different
    ///     magnitude (`0.00001`, not `1e-05`)
    ///
    /// So this takes Swift's shortest digits and re-formats them under
    /// JavaScript's rules rather than trying to pick a format string.
    public static func string(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value == 0 { return "0" }  // also catches -0.0, which JS prints as "0"
        if value < 0 { return "-" + string(-value) }
        if value.isInfinite { return "Infinity" }

        let (digits, n) = decompose(value)
        let k = digits.count

        // The four positional cases and the exponential fallback, in the
        // order the specification states them. `n` is the position of the
        // decimal point relative to the digit string: value = 0.<digits> × 10^n.
        if k <= n && n <= 21 {
            return digits + String(repeating: "0", count: n - k)
        }
        if n > 0 && n <= 21 {
            let split = digits.index(digits.startIndex, offsetBy: n)
            return digits[..<split] + "." + digits[split...]
        }
        if n > -6 && n <= 0 {
            return "0." + String(repeating: "0", count: -n) + digits
        }
        let exponent = n - 1
        let sign = exponent >= 0 ? "+" : "-"
        let magnitude = String(abs(exponent))
        if k == 1 { return digits + "e" + sign + magnitude }
        return digits.prefix(1) + "." + digits.dropFirst() + "e" + sign + magnitude
    }

    /// Splits a positive finite `Double` into its shortest round-trip digits
    /// and the decimal point's position, so that value = 0.<digits> × 10^n.
    ///
    /// Reads those digits out of Swift's `description` rather than computing
    /// them: `description` is already the shortest representation that round
    /// trips, which is the same guarantee JavaScript's own algorithm makes, so
    /// re-deriving them here could only introduce a disagreement.
    private static func decompose(_ value: Double) -> (digits: String, n: Int) {
        let text = "\(value)"
        var mantissa = text
        var exponent = 0
        if let marker = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(text[..<marker])
            exponent = Int(text[text.index(after: marker)...]) ?? 0
        }

        var integerPart = mantissa
        var fractionPart = ""
        if let dot = mantissa.firstIndex(of: ".") {
            integerPart = String(mantissa[..<dot])
            fractionPart = String(mantissa[mantissa.index(after: dot)...])
        }

        var digits = Array(integerPart + fractionPart)
        var pointPosition = integerPart.count

        // Leading zeros are place-holders, not significant digits: dropping
        // them is what moves the point left for a value below 1.
        var leading = 0
        while leading < digits.count - 1 && digits[leading] == "0" { leading += 1 }
        digits.removeFirst(leading)
        pointPosition -= leading

        // Trailing zeros are what make Swift print "139.0" where JavaScript
        // prints "139"; dropping them is what lets the k <= n branch put them
        // back only when the magnitude actually calls for them.
        while digits.count > 1 && digits.last == "0" { digits.removeLast() }

        return (String(digits), pointPosition + exponent)
    }

    /// JavaScript's `<=` between two strings.
    ///
    /// JavaScript compares strings by UTF-16 code unit; Swift's `<` on
    /// `String` compares by Unicode canonical ordering. For the digits, comma,
    /// minus and dot that coordinate keys are made of the two agree, but the
    /// segment key's ordering is a persisted format, so this states the rule
    /// it actually relies on instead of inheriting whichever rule the standard
    /// library happens to implement.
    public static func stringLessOrEqual(_ a: String, _ b: String) -> Bool {
        var left = a.utf16.makeIterator()
        var right = b.utf16.makeIterator()
        while true {
            switch (left.next(), right.next()) {
            case (nil, _): return true          // a is a prefix of b, or equal
            case (_, nil): return false         // b is a strict prefix of a
            case let (l?, r?):
                if l != r { return l < r }
            }
        }
    }
}
