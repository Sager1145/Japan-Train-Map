import Foundation
import Observation
import RailCore

/// Where the rides come from, and where the reader's own rides are kept.
///
/// The web app offers two things behind its 載入*示例資料 and 保存為我的資料
/// buttons: a set of sample itineraries to look at, and one store of your own
/// that survives a reload. This is both, and it draws the same distinction —
/// a sample is read-only reference material, your own store is the thing you
/// are building.
///
/// Persistence is a JSON file in Application Support, written in the canonical
/// spelling the web app's export produces. That is not laziness about
/// databases: it means the file you save here is the file the web app imports,
/// and vice versa. A SQLite schema of our own would be faster to query and
/// would immediately be a second format nobody else can read.
///
/// Application Support rather than Documents because this is app state the
/// reader did not create as a document, and it is excluded from iCloud backup
/// only where it is a cache — this is not, so it is backed up.
@MainActor
@Observable
final class RideLibrary {

    /// A source the reader can load. The seven samples mirror index.html's
    /// buttons exactly, including which country each belongs to — loading the
    /// Taiwan sample while the Japanese network is drawn would show rides with
    /// no railway under them.
    struct Sample: Identifiable, Hashable {
        var id: String { resource }
        var resource: String
        var title: String
        var country: String

        static let all: [Sample] = [
            .init(resource: "train-store", title: "日本 全部示例資料", country: "jp"),
            .init(resource: "new-year-grand-loop", title: "跨年大回行程", country: "jp"),
            .init(resource: "tokyo-limited-express-loop", title: "東京特急大回行程", country: "jp"),
            .init(resource: "train-store-tw", title: "台灣示例資料", country: "tw"),
            .init(resource: "train-store-hk", title: "香港示例資料", country: "hk"),
            .init(resource: "train-store-mo", title: "澳門示例資料", country: "mo"),
            .init(resource: "train-store-kr", title: "韓國示例資料", country: "kr"),
        ]

        static func forCountry(_ country: String) -> [Sample] {
            all.filter { $0.country == country }
        }
    }

    /// What the ride list is currently showing.
    enum Source: Equatable {
        case sample(String)
        /// The reader's own store, read from disk.
        case mine

        var isMine: Bool { self == .mine }
    }

    private(set) var source: Source = .sample("train-store")

    /// Progressive sample directory whose parts carry solved route geometry.
    /// Saving a sample as the reader's own store intentionally keeps this
    /// provenance so unchanged trains continue to draw without a new solve.
    private(set) var routeDataset = "sample-data"

    /// Whether a saved store exists on disk for this country, so the interface
    /// can offer "restore" only when there is something to restore.
    private(set) var hasSavedStore = false

    private(set) var lastSaveError: String?

    // MARK: - reading

    func sample(_ resource: String) throws -> TrainStore {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "json") else {
            throw LibraryError.missingSample(resource)
        }
        return try JSONDecoder().decode(TrainStore.self, from: Data(contentsOf: url))
    }

    func savedStore(country: String) throws -> TrainStore {
        let url = Self.storeURL(country: country)
        return try JSONDecoder().decode(TrainStore.self, from: Data(contentsOf: url))
    }

    func refreshSavedState(country: String) {
        hasSavedStore = FileManager.default.fileExists(atPath: Self.storeURL(country: country).path)
    }

    // MARK: - writing

    /// Saves as the reader's own store for this country.
    ///
    /// The bytes come from `StoreOperations.exportTrainStore`, which is the
    /// web app's own 匯出 JSON ported and checked against it — **not** from
    /// `JSONEncoder`.
    ///
    /// That distinction is the whole point of saving a JSON file rather than
    /// using a database. `JSONEncoder` has no setting that emits insertion
    /// order, and insertion order *is* the format: with `.sortedKeys` this
    /// wrote a third spelling, neither of the two the web app produces, so the
    /// file was interchangeable with nothing. The first version of this file
    /// did exactly that.
    ///
    /// Written atomically: a store half-written because the app was killed
    /// mid-save is worse than no store, because the reader would not find out
    /// until the next launch.
    func save(_ store: TrainStore, country: String) {
        lastSaveError = nil
        do {
            let directory = Self.directory()
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true)

            let workspace = StoreOperations.Workspace(store: store, country: country)
            let text = StoreOperations.exportTrainStore(workspace)
            try Data(text.utf8).write(to: Self.storeURL(country: country), options: .atomic)

            hasSavedStore = true
            source = .mine
        } catch {
            lastSaveError = error.localizedDescription
        }
    }

    func deleteSavedStore(country: String) {
        try? FileManager.default.removeItem(at: Self.storeURL(country: country))
        hasSavedStore = false
        if source.isMine { source = .sample(Sample.forCountry(country).first?.resource ?? "train-store") }
    }

    func use(_ source: Source) {
        self.source = source
        if case .sample(let resource) = source {
            routeDataset = Self.routeDataset(for: resource)
        }
    }

    private static func routeDataset(for resource: String) -> String {
        switch resource {
        case "train-store-tw": "sample-data-tw"
        case "train-store-hk": "sample-data-hk"
        case "train-store-mo": "sample-data-mo"
        case "train-store-kr": "sample-data-kr"
        case "new-year-grand-loop": "new-year-grand-loop-data"
        case "tokyo-limited-express-loop": "tokyo-limited-express-loop-data"
        default: "sample-data"
        }
    }

    // MARK: - locations

    /// One file per country. The web app keys its own store the same way, and
    /// a single merged file would make "load the Taiwan sample" ambiguous
    /// about what it replaces.
    private static func storeURL(country: String) -> URL {
        directory().appending(path: "train-store-\(country).json")
    }

    private static func directory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL.temporaryDirectory
        return base.appending(path: "Rides", directoryHint: .isDirectory)
    }

    enum LibraryError: LocalizedError {
        case missingSample(String)

        var errorDescription: String? {
            switch self {
            case .missingSample(let name):
                """
                \(name).json is not in the app bundle. Run ios/copy-rail-packages.sh — \
                the samples are read from app/data rather than committed twice.
                """
            }
        }
    }
}
