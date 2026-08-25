import Foundation
import RailCore

/// The rules that only exist because one store now holds every region.
///
/// The web app keeps one store per region and hands "the active country" to
/// every function that needs one. There is no active country here, so the two
/// places that used one have to get their answer from the ride instead: the
/// canonical export, which normalises each train against a region's rules, and
/// merging a sample into a working set that already holds other regions.
enum MergedStore {

    /// The canonical bytes for a store whose trains may belong to different
    /// regions.
    ///
    /// `StoreOperations.exportTrainStore` takes one country for the whole
    /// store, which was right when a store *was* one region. Here each train
    /// is normalised against its own region — `normalizeTrainCompany` is the
    /// rule that actually differs — and the result is stringified through the
    /// same projection, so the file is byte-for-byte what the web app's export
    /// writes for the trains it would have written.
    static func export(_ store: TrainStore) -> String {
        let trains = store.trains.map { train in
            TrainValidation.normalizeExportTrain(
                train.taggingRegion(), country: Region.resolved(train).code)
        }
        return StoreOperations.stringify(
            StoreOperations.json(
                TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: trains)),
            indent: 2)
    }

    /// Every train with its region written down, as far as the ride itself
    /// says.
    ///
    /// Called on the way in — after a load, an import or a sample — so that
    /// the answer is derived once from the stops rather than on every draw,
    /// and so that a store saved by this app tells the next launch directly.
    ///
    /// This half answers for Japan and for any ride that already carries a
    /// `region`. It cannot answer for the other four, and it does not pretend
    /// to: outside Japan a store's codes are the OPERATOR's own spelling —
    /// `TYMC-A13`, `AEL-MTR-HOK`, `MLM-TAIPA-MLM-BARRA` — which names no
    /// region. Use ``regionTagged(_:)`` for anything arriving from outside
    /// this app.
    static func tagged(_ store: TrainStore) -> TrainStore {
        var copy = store
        copy.trains = copy.trains.map { $0.taggingRegion() }
        return copy
    }

    /// The same, plus the answer the shipped station datasets hold for the
    /// rides the string rule could not read.
    ///
    /// Asynchronous because that answer is a file — see ``RegionCodeIndex``,
    /// which also explains why this must run before a ride is published rather
    /// than as a correction afterwards. Costs nothing when every ride is
    /// already placed: no dataset is opened in that case.
    static func regionTagged(_ store: TrainStore) async -> TrainStore {
        var copy = store
        copy.trains = await RegionCodeIndex.shared.tagging(copy.trains)
        return copy
    }

    /// Fold one store's trains into another.
    ///
    /// A train whose id is already present REPLACES it, so loading the same
    /// sample twice is idempotent rather than a way to accumulate duplicates.
    /// That is a deliberate choice of *which* collision rule to use: the
    /// import path renames on collision, because two hand-written files that
    /// share an id are two different rides that happen to be named the same,
    /// while a sample loaded twice is the same ride both times. All seven
    /// shipped samples use ids distinctive enough that no two of them collide.
    ///
    /// This is where the web app would have replaced the whole store: its
    /// 載入示例資料 swaps one region's store for another, which is the same
    /// operation when a store can only hold one region. Merging is what that
    /// operation becomes when it cannot.
    static func merging(_ incoming: TrainStore, into existing: TrainStore) -> TrainStore {
        var trains = existing.trains
        var byID = Dictionary(
            trains.enumerated().map { ($0.element.id, $0.offset) },
            uniquingKeysWith: { first, _ in first })
        for raw in incoming.trains {
            let train = raw.taggingRegion()
            if let index = byID[train.id] {
                trains[index] = train
            } else {
                byID[train.id] = trains.count
                trains.append(train)
            }
        }
        return TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: trains)
    }

    /// The trains of one region, in store order.
    static func trains(_ trains: [Train], in region: Region) -> [Train] {
        trains.filter { Region.resolved($0) == region }
    }

    /// Which regions a set of rides touches, in the interface's order.
    static func regions(of trains: [Train]) -> [Region] {
        let present = Set(trains.map { Region.resolved($0) })
        return Region.ordered.filter { present.contains($0) }
    }
}
