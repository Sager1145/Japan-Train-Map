import Foundation
import RailCore

/// The five regional packages, and how an itinerary is matched to one.
///
/// **This is not a port.** The web app has a region *switch*: one package is
/// loaded, one store is open, and everything downstream simply uses "the
/// current country". This app draws all five networks at once, so the question
/// "which package is this ride measured against?" has to be answered per
/// itinerary. That answer lives here.
///
/// It is kept out of `RailCore` for the reason `NetworkLOD` is: there is no
/// JavaScript to check it against, and mixing a policy of our own into the
/// ported tier would make the parity fixtures meaningless. What `RailCore`
/// carries is only the stored field — `Train.region` — because that is part of
/// the document, not part of the policy.
///
/// ## How a ride is matched
///
/// In order, stopping at the first that answers:
///
/// 1. **What the file says.** `Train.region`, when the store carries one.
/// 2. **The stops' station codes, when they name a region.** Japan's are the
///    six-digit `N02_005c`, and the packages' own group ids are spelled
///    `"<region>-official-…"`. Either answers outright.
/// 3. **The route sections' endpoint codes**, by the same rule. The sections'
///    `line_names` are deliberately NOT consulted: they are names, not ids,
///    and carry no region.
///
/// A ride that answers none of these is Japanese, which is the same fallback
/// `StoreOperations.createBlankTrain(country:)` makes for an unrecognised
/// country: the JavaScript's `if`-chain with no `else`.
///
/// ## What the ride stores actually carry, and why (2) is not enough
///
/// The codes in a train store are `n02_station_code`, not the packages' group
/// ids, and outside Japan they are the OPERATOR's own spelling — `TYMC-A13`
/// (a TDX StationUID), `AEL-MTR-HOK`, `MLM-TAIPA-MLM-BARRA`,
/// `KR-GYEONGBUSEON-BUSAN`. Only Korea's happens to begin with its region.
/// Nothing in the string says Taiwan or Hong Kong, and a rule invented from
/// the operator prefixes that ship today would be a guess that breaks on the
/// next operator.
///
/// So the real answer for those codes comes from the data: the four non-Japanese
/// `stations-*.json` carry `n02_station_code` beside `n02_group_code`, and
/// ``RegionCodeIndex`` reads the pairing. That lookup is asynchronous and runs
/// ONCE, over the rides a store arrives untagged with — after which every ride
/// carries `region` and this synchronous path is exact.
enum Region: String, CaseIterable, Identifiable, Sendable, Hashable {
    case jp
    case tw
    case hk
    case mo
    case kr

    var id: String { rawValue }

    /// The string every `RailCore` entry point calls `country`.
    var code: String { rawValue }

    /// The regions in the order the interface offers them — smallest network
    /// first, which is also least to most demanding on the renderer.
    static let ordered: [Region] = [.mo, .hk, .tw, .kr, .jp]

    /// The catalog key for this region's name, so the interface reads in the
    /// reader's language rather than in Chinese for everybody.
    var localizationKey: String { "country.\(rawValue)" }

    /// The untranslated fallback, for the moment before a catalog is loaded.
    var fallbackName: String {
        switch self {
        case .jp: "日本 Japan"
        case .tw: "臺灣 Taiwan"
        case .hk: "香港 Hong Kong"
        case .mo: "澳門 Macao"
        case .kr: "한국 Korea"
        }
    }

    /// The rail package in the app bundle.
    var packageResource: String { "\(rawValue)-2025" }

    /// The statistics sections file: Japan's carries no suffix, exactly as the
    /// web app names them (`rail-sections.json`, `rail-sections-tw.json`).
    var sectionsResource: String {
        self == .jp ? "rail-sections" : "rail-sections-\(rawValue)"
    }

    // MARK: - matching a ride to a region

    /// The region a line id belongs to — `"tw-alsr-alishan"` → `.tw`.
    static func fromLineID(_ lineID: String?) -> Region? {
        guard let lineID, let dash = lineID.firstIndex(of: "-") else { return nil }
        return Region(rawValue: String(lineID[lineID.startIndex..<dash]))
    }

    /// The region a station code names, when it names one at all.
    ///
    /// Japan's `N02_005c` is six ASCII digits, and the packages' group ids
    /// begin `"<region>-official-"`. An operator's own code — which is what a
    /// train store actually carries outside Japan — names no region, and this
    /// answers `nil` for it rather than guessing. See the type's note.
    static func fromStationCode(_ code: String?) -> Region? {
        guard let code, !code.isEmpty else { return nil }
        if code.count == 6, code.allSatisfy({ $0.isASCII && $0.isNumber }) { return .jp }
        guard let dash = code.firstIndex(of: "-") else { return nil }
        let head = String(code[code.startIndex..<dash])
        // `kr-official-busan` names Korea; `KR-GYEONGBUSEON-BUSAN` is an
        // operator code that merely starts with the same two letters, and it
        // happens to name Korea too. Both are accepted, and no other region's
        // operator codes begin with another region's code, so this cannot
        // claim a region that is wrong.
        return Region(rawValue: head.lowercased())
    }

    /// The region an itinerary belongs to, or `nil` when nothing in it says.
    ///
    /// Deliberately returns the *first* region any part of the ride names
    /// rather than a majority vote: a through service that crosses no border
    /// (and none of these five networks touch each other) has one region in
    /// every part, and a store that somehow mixed them would be a data fault
    /// worth seeing rather than averaging away.
    static func matched(_ train: Train) -> Region? {
        if let declared = train.region, let region = Region(rawValue: declared) {
            return region
        }
        for stop in train.stops {
            if let region = fromStationCode(stop.n02StationCode) { return region }
        }
        for section in train.routeSections ?? [] {
            if let region = fromStationCode(section.fromN02StationCode) { return region }
            if let region = fromStationCode(section.toN02StationCode) { return region }
        }
        return nil
    }

    /// The region an itinerary is drawn and measured in — matched, or Japan.
    static func resolved(_ train: Train) -> Region { matched(train) ?? .jp }
}

extension Train {
    /// The region this itinerary is drawn and measured in.
    var resolvedRegion: Region { Region.resolved(self) }

    /// The same train with its region written down — when the ride actually
    /// says which one it is.
    ///
    /// A ride that says nothing is left ALONE rather than tagged Japanese.
    /// `Region.resolved` falls back to Japan because something has to be drawn
    /// and solved right now, but writing that fallback into the record would
    /// turn a guess into a stated fact, and the Taiwanese ride whose codes
    /// this pass could not read would be Japanese for ever. Those rides are
    /// resolved properly, once, by ``RegionCodeIndex``.
    func taggingRegion() -> Train {
        guard let region = Region.matched(self) else { return self }
        var copy = self
        copy.region = region.code
        return copy
    }
}


/// Which region a station code belongs to, read out of the shipped station
/// datasets rather than guessed from the string.
///
/// Only exists for rides that arrive without a `region` of their own: a store
/// written by the web app, or by a build of this app from before the merge —
/// and the five bundled samples, which ARE web-app stores (`copy-rail-packages.sh`
/// ships `app/data/train-store-*.json` unchanged, and none of them carries a
/// `region`). One pass tags them, they are saved with the answer, and this is
/// never consulted for them again.
///
/// It has to run BEFORE a ride is published, not as a correction afterwards.
/// An untagged ride is `Region.resolved`-as-Japanese, which means it is drawn
/// against Japan's package and solved against Japan's station table — so the
/// Macanese sample asks Japan's solver for 媽閣, and twenty seconds later the
/// journey card says 無法繪製路線.
///
/// Japan is deliberately absent from the index. Its own codes are recognisable
/// on sight (six digits), `stations.json` is 3.1 MB against 1.1 MB for the
/// other four together, and Japan is the fallback anyway — so loading it would
/// be three megabytes of work to confirm what not finding a code already says.
actor RegionCodeIndex {

    static let shared = RegionCodeIndex()

    private var codes: [String: Region]?

    /// The same rides, each carrying the region it belongs to.
    ///
    /// ``Train/taggingRegion()`` runs first and answers for everything it can
    /// read on sight — a ride that already says, and every Japanese one. Only
    /// what is left pays for the index, so a store this app saved never opens
    /// a dataset at all.
    ///
    /// A ride nothing can place is returned untagged, for the reason
    /// `taggingRegion()` leaves it alone: `Region.resolved` will draw it as
    /// Japanese either way, and writing that guess into the record would make
    /// it permanent.
    func tagging(_ trains: [Train]) -> [Train] {
        let known = trains.map { $0.taggingRegion() }
        guard known.contains(where: { $0.region == nil }) else { return known }
        let table = table()
        guard !table.isEmpty else { return known }
        return known.map { train in
            guard train.region == nil else { return train }
            let region = train.stops.lazy
                .compactMap { $0.n02StationCode.flatMap { table[$0] } }
                .first
            guard let region else { return train }
            var copy = train
            copy.region = region.code
            return copy
        }
    }

    private func table() -> [String: Region] {
        if let codes { return codes }
        var built: [String: Region] = [:]
        for region in Region.allCases where region != .jp {
            guard let url = Bundle.main.url(
                    forResource: "stations-\(region.rawValue)", withExtension: "json"),
                  let data = try? Data(contentsOf: url, options: .mappedIfSafe),
                  let decoded = try? JSONDecoder().decode(StationFile.self, from: data)
            else { continue }
            for feature in decoded.features {
                guard let code = feature.properties.n02StationCode, !code.isEmpty else { continue }
                built[code] = region
            }
        }
        codes = built
        return built
    }

    /// Only the one field this needs. Every other property — the geometry, the
    /// operator, the class codes — is ignored by `Decodable`, which is what
    /// keeps a 650 KB file from being decoded into objects nobody reads.
    private struct StationFile: Decodable {
        struct Feature: Decodable {
            struct Properties: Decodable {
                let n02StationCode: String?
                enum CodingKeys: String, CodingKey {
                    case n02StationCode = "n02_station_code"
                }
            }
            let properties: Properties
        }
        let features: [Feature]
    }
}
