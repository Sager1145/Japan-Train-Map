import Foundation
import RailCore

/// Which journeys a search box is asking for (§5.1).
///
/// The spec names the fields, and it names them for both platforms at once:
///
/// > 统一目标搜索字段为记录 ID、车次/班次名称、日期、方向、起终站、途中站、
/// > 车种与运营方；当前 iOS 已覆盖除日期/方向外的字段，Web 已覆盖全部，重构时
/// > 补齐 iOS parity。
///
/// So the list is a contract rather than a convenience, and a contract spelled
/// out inline in a `filter` closure is one that drifts the next time somebody
/// adds a field. Two fields — `date` and `direction` — were missing on iOS
/// exactly because that closure was the only place the list existed.
///
/// It lives here rather than in `RailCore` for the reason the whole target
/// exists: there is no JavaScript function this is a port of. The web app
/// spreads the same rule across `renderTrainList`'s predicate, so a parity
/// fixture would have nothing to compare against — but the *field list* still
/// has to be checkable, and `swift test` can reach this.
public enum JourneySearchMatcher {

    /// Whether one journey answers a query.
    ///
    /// Case- and diacritic-insensitive substring matching, in the reader's
    /// locale: `localizedCaseInsensitiveContains` is what makes ｶﾞ find が and
    /// what keeps `odoriko` finding a record typed `Odoriko`. A `lowercased()`
    /// comparison would do neither, and would additionally get Turkish wrong.
    ///
    /// An empty or whitespace-only query matches everything, so a caller can
    /// hand the raw text field through without deciding first whether the
    /// reader has typed anything.
    public static func matches(_ train: Train, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return true }
        return fields(of: train).contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    /// Every string one journey is searchable by, in §3.2's scan order.
    ///
    /// The order is the order a reader reads the record in, which is not an
    /// aesthetic choice: it is what makes the list reviewable against §5.1
    /// without cross-referencing the struct's field order, and it is why the
    /// identifier is last rather than first — §3.2 forbids the record id
    /// leading the journey's identity, and a list that leads with it invites
    /// exactly that mistake into the next surface that renders it.
    public static func fields(of train: Train) -> [String] {
        var fields: [String] = [
            train.number,
            train.origin,
            train.destination,
        ]
        // Intermediate stops. `origin` and `destination` are the record's own
        // two names for the ends of the ride and are NOT guaranteed to be
        // spelled the same as the first and last stop, so both are searched.
        fields.append(contentsOf: train.stops.map(\.name))
        fields.append(contentsOf: [
            train.date,
            train.direction,
            train.trainType,
            train.company,
        ].compactMap { $0 })
        fields.append(train.id)
        return fields.filter { !$0.isEmpty }
    }

    /// The journeys of one day that answer a query, in store order.
    public static func filter(_ trains: [Train], query: String) -> [Train] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return trains }
        return trains.filter { matches($0, query: needle) }
    }
}
