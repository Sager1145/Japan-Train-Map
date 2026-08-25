import Foundation

// The JavaScript string primitives this port keeps having to re-establish,
// in the one place they now live.
//
// `JSNumber` and `JSMath` are here for the same reason and this file is their
// third sibling: Swift's `String` is not JavaScript's, and the differences are
// silent. `==` is canonical equivalence, so 「が」 written U+304C and written
// U+304B U+3099 are equal in Swift and are two different strings in
// JavaScript — and the shipped `jp` package uses one spelling while every
// human types the other. Anything keyed, compared or trimmed the way the
// JavaScript keys, compares or trims it has to come through here.
//
// ## Why these were duplicated, and why they no longer are
//
// Six of them, spread over `Stations`, `StationDisplay`, `OperatorBranding`,
// `Train` and `Dates` — and every copy said so itself:
//
//     `Stations.swift` keeps a private copy of this for the same reason; the
//     duplication is deliberate, because a shared one would be a file two
//     parallel ports have to merge.    — StationDisplay.swift
//
//     The same set is spelled privately in `Dates.swift`. Duplicated rather
//     than shared because this file may not edit that one — if these ever
//     need to move, they should move together into one internal helper.
//                                      — Train.swift
//
// The parallel ports have landed. This is that internal helper. Every copy was
// byte-identical to its siblings, and their being byte-identical is what makes
// this a move rather than a merge: nothing here decides anything differently,
// and the 206 parity tests say so.
//
// The files that used to own these keep their own local names — `jsTrim`,
// `isJSWhiteSpace`, `JSText.trim` — as one-line forwarders, because those names
// read against the JavaScript the port is checked against.
//
// ## What is NOT here, and must not be moved here
//
// The distance and turn primitives. `distanceMeters` has five spellings across
// RailCore because the JavaScript has five, and `(a - b) * k` is not
// `a*k - b*k` in IEEE-754 — those are different functions that share a name,
// where these were one function that had several copies. Measured 2026-08-26
// over 200,060 real coordinate triples: `Grooming.turnDegrees` and
// `DisplayParts.turnDegrees` disagree on 96,040 of them. See
// `RouteFeature.swift`'s `RouteNetwork.Metric` for the whole measurement.

/// A string, keyed the way JavaScript keys one — by UTF-16 code unit.
///
/// Every table in `Stations`, `StationDisplay` and `OperatorBranding` is keyed
/// on this so that a lookup answers the question a JavaScript object lookup
/// answers, and no other. A Swift `[String: …]` would find an entry for a
/// decomposed spelling that the JavaScript misses.
///
/// Declared at module scope rather than nested in a `JSString` enum because it
/// appears in about sixty type positions across three files; the qualification
/// would be noise at every one of them.
struct CodeUnits: Hashable {
    let units: [UInt16]
    init(_ value: String) { units = Array(value.utf16) }
}

/// `a === b` for strings. NOT `==`, which is canonical equivalence and would
/// call the two spellings of 笹塚 equal — the exact judgement this port exists
/// to get right.
func sameCodeUnits(_ a: String, _ b: String) -> Bool {
    a.utf16.elementsEqual(b.utf16)
}

enum JSString {

    /// ECMAScript `WhiteSpace` ∪ `LineTerminator` — the set
    /// `String.prototype.trim` removes and the set `\s` matches, which are the
    /// same set.
    ///
    /// Deliberately not `CharacterSet.whitespacesAndNewlines`, which differs at
    /// BOTH ends: it omits U+FEFF (ZWNBSP), which ECMAScript trims, and it
    /// includes U+0085 (NEL), which ECMAScript does not. So it is neither a
    /// subset nor a superset of the rule — a code with a leading byte-order
    /// mark would be rejected and a code with a leading NEL accepted, both
    /// backwards. Both characters are in `port-fixtures/validation.json`
    /// precisely because they are the two that make the two implementations
    /// disagree about where a name begins.
    ///
    /// It matters because dates and codes arrive from pasted spreadsheets and
    /// hand-typed forms, which is exactly where a stray no-break space or byte
    /// order mark turns up.
    static let whitespace: Set<Unicode.Scalar> = {
        var set: Set<Unicode.Scalar> = [
            "\u{0009}", "\u{000A}", "\u{000B}", "\u{000C}", "\u{000D}",
            "\u{0020}", "\u{00A0}", "\u{1680}", "\u{2028}", "\u{2029}",
            "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
        ]
        for scalar in 0x2000...0x200A { set.insert(Unicode.Scalar(scalar)!) }
        return set
    }()

    /// ECMAScript `String.prototype.trim`.
    static func trim(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end && whitespace.contains(scalars[start]) { start += 1 }
        while end > start && whitespace.contains(scalars[end - 1]) { end -= 1 }
        return String(String.UnicodeScalarView(scalars[start..<end]))
    }

    /// ``trim(_:)`` done in UTF-16 code units.
    ///
    /// Equal in result to the scalar form — no member of ``whitespace`` is
    /// outside the BMP, so nothing can be half of a surrogate pair — and a
    /// separate function because it is the one the code-unit files were ported
    /// with, down to the early return: handing back the original `String` when
    /// nothing was trimmed keeps the exact instance rather than a re-encoded
    /// copy of it, and these run over every station name in five packages.
    static func trimCodeUnits(_ value: String) -> String {
        let units = Array(value.utf16)
        var start = 0
        var end = units.count
        while start < end, isWhiteSpace(units[start]) { start += 1 }
        while end > start, isWhiteSpace(units[end - 1]) { end -= 1 }
        guard start != 0 || end != units.count else { return value }
        return String(decoding: units[start..<end], as: UTF16.self)
    }

    /// ``whitespace``, asked one UTF-16 code unit at a time.
    ///
    /// The same set as the `Set<Unicode.Scalar>` above and a second spelling of
    /// it, because the files that key on ``CodeUnits`` are working in code
    /// units throughout and one of them needs `units.removeAll(where:)` —
    /// which has no scalar form. Every member of the set is in the BMP, so the
    /// two spellings cannot disagree about any input.
    ///
    /// It was written out as a `switch` in both places it came from, and is
    /// left as one rather than rewritten to consult ``whitespace``: this is a
    /// move of two byte-identical copies into one, and a rewrite would put a
    /// change nobody measured underneath the station tables.
    static func isWhiteSpace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D:  // TAB LF VT FF CR
            return true
        case 0x0020, 0x00A0:  // SPACE, NBSP
            return true
        case 0x1680, 0x2000...0x200A, 0x202F, 0x205F, 0x3000:  // category Zs
            return true
        case 0x2028, 0x2029:  // LINE / PARAGRAPH SEPARATOR
            return true
        case 0xFEFF:  // ZWNBSP
            return true
        default:
            return false
        }
    }
}
