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
    /// buttons exactly, including which region each belongs to — which now
    /// says where a sample's rides will appear on a map that draws every
    /// region at once, rather than which region has to be switched on first.
    struct Sample: Identifiable, Hashable {
        var id: String { resource }
        var resource: String
        var title: String
        var region: Region

        static let all: [Sample] = [
            .init(resource: "train-store", title: "日本 全部示例資料", region: .jp),
            .init(resource: "new-year-grand-loop", title: "跨年大回行程", region: .jp),
            .init(resource: "tokyo-limited-express-loop", title: "東京特急大回行程", region: .jp),
            .init(resource: "train-store-tw", title: "台灣示例資料", region: .tw),
            .init(resource: "train-store-hk", title: "香港示例資料", region: .hk),
            .init(resource: "train-store-mo", title: "澳門示例資料", region: .mo),
            .init(resource: "train-store-kr", title: "韓國示例資料", region: .kr),
        ]

        static func forRegion(_ region: Region) -> [Sample] {
            all.filter { $0.region == region }
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

    /// Which samples have been loaded into the working set, so the data
    /// screen can say "loaded" beside one instead of offering seven buttons
    /// that all look untouched.
    ///
    /// A note about the reader's own store, not a claim about its contents:
    /// rides loaded from a sample can be edited and deleted like any other,
    /// and this is cleared when everything is.
    private(set) var loadedSamples: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: RideLibrary.loadedSamplesKey) ?? [])

    private static let loadedSamplesKey = "loaded-samples"

    /// Whether a saved store exists on disk, so the interface can offer
    /// "restore" only when there is something to restore.
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

    func savedStore() throws -> TrainStore {
        try JSONDecoder().decode(TrainStore.self, from: Data(contentsOf: Self.storeURL()))
    }

    func refreshSavedState() {
        let url = Self.storeURL()
        hasSavedStore = FileManager.default.fileExists(atPath: url.path)
        savedStoreDate =
            hasSavedStore
            ? (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate : nil
        refreshBackupState()
    }

    /// Reads the sidecar rather than the backup itself: what the screen shows
    /// is a date and a count, and decoding a 201-journey store to learn them
    /// would be a megabyte of work every time the tab is opened.
    func refreshBackupState() {
        guard FileManager.default.fileExists(atPath: Self.backupURL().path),
            let data = try? Data(contentsOf: Self.backupMetaURL()),
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
    func save(_ store: TrainStore) {
        lastSaveError = nil
        do {
            let directory = Self.directory()
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true)

            try Data(MergedStore.export(store).utf8)
                .write(to: Self.storeURL(), options: .atomic)

            hasSavedStore = true
            savedStoreDate = Date()
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
    func snapshotBackup(_ store: TrainStore, reason: Backup.Reason) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: Self.directory(), withIntermediateDirectories: true)
            try Data(MergedStore.export(store).utf8)
                .write(to: Self.backupURL(), options: .atomic)
            let meta = Backup(created: Date(), trainCount: store.trains.count, reason: reason)
            try Self.metaEncoder.encode(meta).write(
                to: Self.backupMetaURL(), options: .atomic)
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
    func restoreBackup() throws -> TrainStore {
        let url = Self.backupURL()
        let store = try JSONDecoder().decode(TrainStore.self, from: Data(contentsOf: url))
        try FileManager.default.createDirectory(
            at: Self.directory(), withIntermediateDirectories: true)
        try Data(contentsOf: url).write(to: Self.storeURL(), options: .atomic)
        hasSavedStore = true
        lastSaveError = nil
        discardBackup()
        refreshSavedState()
        return store
    }

    func discardBackup() {
        try? FileManager.default.removeItem(at: Self.backupURL())
        try? FileManager.default.removeItem(at: Self.backupMetaURL())
        backup = nil
    }

    func deleteSavedStore() {
        try? FileManager.default.removeItem(at: Self.storeURL())
        hasSavedStore = false
        savedStoreDate = nil
        forgetLoadedSamples()
    }

    /// Remember that a sample's rides are in the working set.
    ///
    /// Persisted, because the claim it makes — "these rides are already here" —
    /// outlives the launch that loaded them, and a checkmark that disappeared
    /// overnight would invite loading the same 201 journeys again.
    func noteSampleLoaded(_ resource: String) {
        loadedSamples.insert(resource)
        persistLoadedSamples()
    }

    func forgetLoadedSamples() {
        loadedSamples.removeAll()
        persistLoadedSamples()
    }

    private func persistLoadedSamples() {
        UserDefaults.standard.set(Array(loadedSamples).sorted(), forKey: Self.loadedSamplesKey)
    }

    /// The precomputed route directories a region's rides may have been solved
    /// into, most likely first.
    ///
    /// The web app knows which one to read because it has one store open at a
    /// time and that store came from one place. A merged store has no such
    /// provenance — a reader can hold the 201-journey Japanese sample, the
    /// New Year loop and their own rides at once — so the route store searches
    /// this list instead. That is safe rather than approximate: every part is
    /// matched by the same route-cache digest the web app uses, so a part
    /// belonging to another itinerary is rejected rather than drawn.
    nonisolated static func routeDatasets(for region: Region) -> [String] {
        switch region {
        case .jp: ["sample-data", "new-year-grand-loop-data", "tokyo-limited-express-loop-data"]
        case .tw: ["sample-data-tw"]
        case .hk: ["sample-data-hk"]
        case .mo: ["sample-data-mo"]
        case .kr: ["sample-data-kr"]
        }
    }

    // MARK: - locations

    /// One file, holding every region.
    ///
    /// It used to be one file per region, because the app had a region switch
    /// and "load the Taiwan sample" had to be unambiguous about what it
    /// replaced. With every region drawn at once there is one working set, so
    /// there is one file — and each ride says which region it belongs to
    /// (`Train.region`) rather than being told by which file it was in.
    private static func storeURL() -> URL {
        directory().appending(path: "train-store.json")
    }

    /// The per-region files this app wrote before the merge, in the order they
    /// are folded into the merged store.
    private static let legacyStoreURLs: [(Region, String)] = Region.ordered.map {
        ($0, "train-store-\($0.rawValue).json")
    }

    /// Fold any per-region stores left by an earlier version into the merged
    /// one, once.
    ///
    /// Runs before the first read and does nothing when there is nothing to
    /// do. The legacy files are left on disk rather than deleted: the merge is
    /// the kind of one-way step that is worth being able to check afterwards,
    /// and five small JSON files are a cheap receipt. A subsequent launch sees
    /// the merged file and skips this entirely.
    func migrateLegacyStores() {
        let merged = Self.storeURL()
        guard !FileManager.default.fileExists(atPath: merged.path) else { return }
        var trains: [Train] = []
        var seen = Set<String>()
        for (region, name) in Self.legacyStoreURLs {
            let url = Self.directory().appending(path: name)
            guard let data = try? Data(contentsOf: url),
                  let store = try? JSONDecoder().decode(TrainStore.self, from: data)
            else { continue }
            for train in store.trains {
                var copy = train
                copy.region = region.code
                // Two regions could have written the same id — nothing stopped
                // them while the stores were separate. Renaming rather than
                // dropping keeps both rides; losing one silently would be the
                // migration eating data.
                if seen.contains(copy.id) { copy.id = "\(copy.id)-\(region.code)" }
                seen.insert(copy.id)
                trains.append(copy)
            }
        }
        guard !trains.isEmpty else { return }
        save(TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: trains))
    }

    /// The recovery copy and its sidecar. The sidecar is separate so that the
    /// backup file itself stays byte-identical to an export — a date stamped
    /// inside it would make it a different document from the one it copies.
    private static func backupURL() -> URL {
        directory().appending(path: "train-store.backup.json")
    }

    private static func backupMetaURL() -> URL {
        directory().appending(path: "train-store.backup-meta.json")
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
