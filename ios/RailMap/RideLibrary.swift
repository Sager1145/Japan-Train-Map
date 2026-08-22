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

        /// The catalog key index.html gives this sample's own button, so the
        /// list reads in the interface language instead of in Chinese for
        /// everybody. ``title`` stays as the untranslated fallback: it is read
        /// by another port's file, and a name is a poor thing to change under
        /// a caller who did not ask.
        var titleKey: String {
            switch resource {
            case "train-store": "btn.loadSampleAll"
            case "train-store-tw": "btn.loadSampleAllTw"
            case "train-store-hk": "btn.loadSampleAllHk"
            case "train-store-mo": "btn.loadSampleAllMo"
            case "train-store-kr": "btn.loadSampleAllKr"
            case "new-year-grand-loop": "btn.loadNewYearGrandLoop"
            case "tokyo-limited-express-loop": "btn.loadTokyoLimitedExpressLoop"
            default: ""
            }
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

    /// When the saved store was last written, so the data screen can say more
    /// than "saved" — a date is what tells a reader whether the copy on this
    /// device is the one they think it is.
    private(set) var savedStoreDate: Date?

    /// The one-deep undo behind every destructive data action.
    ///
    /// §5.8 asks that deleting everything explain what can be recovered, and
    /// §8.6 that a recovery path be offered in preference to a confirmation
    /// wall. Neither is possible without something to recover FROM, so the
    /// destructive actions write one of these first. It is deliberately one
    /// deep and deliberately not a version history: a second backup would
    /// raise the question of which one a reader is restoring, and the answer
    /// would have to be a list of dates nobody keeps track of.
    struct Backup: Equatable, Sendable, Codable {
        enum Reason: String, Codable, Sendable {
            case beforeImport
            case beforeDeleteAll
            case beforeReplace

            var localizationKey: String {
                switch self {
                case .beforeImport: "data.backupReasonImport"
                case .beforeDeleteAll: "data.backupReasonDeleteAll"
                case .beforeReplace: "data.backupReasonReplace"
                }
            }
        }

        var created: Date
        var trainCount: Int
        var reason: Reason
    }

    private(set) var backup: Backup?

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
        let url = Self.storeURL(country: country)
        hasSavedStore = FileManager.default.fileExists(atPath: url.path)
        savedStoreDate =
            hasSavedStore
            ? (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate : nil
        refreshBackupState(country: country)
    }

    /// Reads the sidecar rather than the backup itself: what the screen shows
    /// is a date and a count, and decoding a 201-journey store to learn them
    /// would be a megabyte of work every time the tab is opened.
    func refreshBackupState(country: String) {
        guard FileManager.default.fileExists(atPath: Self.backupURL(country: country).path),
            let data = try? Data(contentsOf: Self.backupMetaURL(country: country)),
            let decoded = try? Self.metaDecoder.decode(Backup.self, from: data)
        else {
            backup = nil
            return
        }
        backup = decoded
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

    /// Writes the recovery copy a destructive action can be undone from.
    ///
    /// Same canonical bytes as ``save(_:country:)`` — a backup that cannot be
    /// re-imported by the web app is not a backup of this store, it is a
    /// second format. Failure is reported rather than thrown: the caller's
    /// decision (delete everything, replace everything) is the reader's, and
    /// the screen refuses to go ahead unsupervised when the backup did not
    /// land rather than silently proceeding without one.
    @discardableResult
    func snapshotBackup(_ store: TrainStore, country: String, reason: Backup.Reason) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: Self.directory(), withIntermediateDirectories: true)
            let text = StoreOperations.exportTrainStore(
                StoreOperations.Workspace(store: store, country: country))
            try Data(text.utf8).write(to: Self.backupURL(country: country), options: .atomic)
            let meta = Backup(created: Date(), trainCount: store.trains.count, reason: reason)
            try Self.metaEncoder.encode(meta).write(
                to: Self.backupMetaURL(country: country), options: .atomic)
            backup = meta
            return true
        } catch {
            lastSaveError = error.localizedDescription
            return false
        }
    }

    /// Puts the backup back as the reader's own store and returns it.
    ///
    /// The backup is consumed: leaving it in place after a restore would offer
    /// a "restore" button that now restores what is already on screen, which
    /// reads as a second undo that does nothing.
    @discardableResult
    func restoreBackup(country: String) throws -> TrainStore {
        let url = Self.backupURL(country: country)
        let store = try JSONDecoder().decode(TrainStore.self, from: Data(contentsOf: url))
        try FileManager.default.createDirectory(
            at: Self.directory(), withIntermediateDirectories: true)
        try Data(contentsOf: url).write(to: Self.storeURL(country: country), options: .atomic)
        hasSavedStore = true
        source = .mine
        lastSaveError = nil
        discardBackup(country: country)
        refreshSavedState(country: country)
        return store
    }

    func discardBackup(country: String) {
        try? FileManager.default.removeItem(at: Self.backupURL(country: country))
        try? FileManager.default.removeItem(at: Self.backupMetaURL(country: country))
        backup = nil
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

    /// The recovery copy and its sidecar. The sidecar is separate so that the
    /// backup file itself stays byte-identical to an export — a date stamped
    /// inside it would make it a different document from the one it copies.
    private static func backupURL(country: String) -> URL {
        directory().appending(path: "train-store-\(country).backup.json")
    }

    private static func backupMetaURL(country: String) -> URL {
        directory().appending(path: "train-store-\(country).backup-meta.json")
    }

    private static let metaEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let metaDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

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
