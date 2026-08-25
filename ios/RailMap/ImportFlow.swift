import Foundation
import Observation
import RailCore

/// What an in-flight operation is allowed to tell the reader — §7.8.
///
/// The four members are the spec's four, and they are members rather than
/// optional decorations because each one answers a question a spinner leaves
/// open: what is happening (`stage`), how far along it is (`completed`/`total`
/// when the total is knowable at all), whether the app is still usable
/// (`canInteract`), and whether there is a way out (`canCancel`).
struct ProgressSummary: Sendable {

    enum Stage: Sendable {
        /// Parsing. There is no count here and inventing one would be a lie:
        /// a document is parsed whole, in one call, before anything is known
        /// about how many journeys it holds.
        case reading
        /// Normalising and validating one journey at a time, counted.
        case validating
        /// The commit's own per-journey loop, counted.
        case importing
        /// Rebuilding the date buckets. One pass over the finished store; the
        /// engine reports nothing inside it, so it stays uncounted.
        case grouping
        /// Writing the store to this device.
        case saving

        /// The key that names it, and whether that key expects a count.
        var countedKey: String {
            switch self {
            case .validating: "data.stageValidating"
            case .importing: "data.stageImporting"
            case .reading: "data.stageReading"
            case .grouping: "data.stageGrouping"
            case .saving: "data.stageSaving"
            }
        }

        var plainKey: String {
            switch self {
            case .validating: "data.stageValidatingPlain"
            case .importing: "data.stageImportingPlain"
            case .reading: "data.stageReading"
            case .grouping: "data.stageGrouping"
            case .saving: "data.stageSaving"
            }
        }
    }

    var stage: Stage
    var completed: Int?
    var total: Int?
    /// Whether the rest of the app remains usable while this runs. The import
    /// engine holds the store, so editing is blocked; reading and the map are
    /// not (§8.7).
    var canInteract: Bool
    /// Only where cancelling leaves a consistent store. See
    /// ``ItineraryStore/runImport(text:country:mode:sourceLabel:onProgress:)``
    /// for what cancelling does and does not stop.
    var canCancel: Bool

    var fraction: Double? {
        guard let completed, let total, total > 0 else { return nil }
        return min(1, max(0, Double(completed) / Double(total)))
    }
}

/// How much of a running operation is worth showing yet — §13.2.
///
/// A progress bar that appears for 80 ms and vanishes is noise, and a
/// quantitative bar is only honest once there is a total to be quantitative
/// about. Driven by two sleeps rather than a repeating timer: there are
/// exactly two moments at which the answer changes.
enum ProgressVisibility: Sendable {
    /// Under ~400 ms: show nothing.
    case quiet
    /// Over ~400 ms: name the stage.
    case stage
    /// Over ~3 s with a known total: name the stage and count it.
    case quantitative
}

/// The import as a state machine the interface can render.
///
/// Deliberately separate from ``ItineraryStore``: the store owns the
/// journeys, this owns one attempt at changing them — including the attempts
/// that are refused, which never reach the store at all.
@MainActor
@Observable
final class ImportFlow {

    /// Where the JSON came from. Kept so the completion and error surfaces can
    /// name it, which is most of the difference between "import failed" and
    /// "train-store-2026.json could not be imported".
    enum Origin: Equatable {
        case pasted
        case file(String)

        var label: String {
            switch self {
            case .pasted: ""
            case .file(let name): name
            }
        }
    }

    enum Phase {
        case editing
        case checking(ProgressSummary)
        case checked(ImportPreflight.Report)
        case importing(ProgressSummary)
        case finished(Outcome)
        case failed(Failure)
    }

    /// Which phase this is, without what is in it.
    ///
    /// `Phase` cannot be `Equatable` — its payloads are reports and outcomes —
    /// and `onChange(of:)` needs something that can be compared. This is that:
    /// it changes exactly when the phase does, so an announcement fires once
    /// per transition rather than on every progress tick inside one.
    enum PhaseKind: Equatable {
        case editing, checking, checked, importing, finished, failed
    }

    var phaseKind: PhaseKind {
        switch phase {
        case .editing: .editing
        case .checking: .checking
        case .checked: .checked
        case .importing: .importing
        case .finished: .finished
        case .failed: .failed
        }
    }

    struct Outcome {
        var imported: Int
        var renamed: Int
        var mode: ImportPreflight.Mode
        var storeCount: Int
        /// The import landed but could not be written to this device. The
        /// journeys are real and on screen; the next launch will not have
        /// them. That is a different sentence from "import failed" and it gets
        /// one (§13.3).
        var saveError: String?
    }

    /// A refusal, in the four parts §13.3 asks for. The view supplies "what
    /// you can do next" from the phase, because the available actions are a
    /// property of where the flow is, not of the message.
    struct Failure {
        /// 发生了什么
        var title: String
        /// 影响了什么 — the specific problems, with their positions.
        var issues: [ImportPreflight.Issue]
        /// 保留了什么
        var keptCount: Int
        /// Set when the flow stopped for a reason that is not the document's
        /// fault (a cancelled run, a region switch).
        var neutral: Bool = false
    }

    var text = ""
    var origin: Origin = .pasted
    var mode: ImportPreflight.Mode = .replaceAll
    private(set) var phase: Phase = .editing
    private(set) var visibility: ProgressVisibility = .quiet

    private var work: Task<Void, Never>?
    private var preflight: Task<ImportPreflight.Report, Error>?
    private var visibilityClock: Task<Void, Never>?

    var isRunning: Bool {
        switch phase {
        case .checking, .importing: true
        default: false
        }
    }

    var report: ImportPreflight.Report? {
        if case .checked(let report) = phase { return report }
        return nil
    }

    /// The summary of a commit that is still running, for surfaces OUTSIDE the
    /// import sheet.
    ///
    /// §8.7 allows a large import to be left running while the reader goes
    /// back to the map, and the sheet can be swiped away without cancelling —
    /// so the screen underneath has to be able to say that something still
    /// owns the store. The check phase is deliberately not reported here: it
    /// changes nothing, so nothing outside the sheet is waiting on it.
    var committingSummary: ProgressSummary? {
        if case .importing(let summary) = phase { return summary }
        return nil
    }

    func reset() {
        work?.cancel()
        preflight?.cancel()
        visibilityClock?.cancel()
        phase = .editing
    }

    /// The starting mode is the web app's, per door: 打開本地 JSON replaces the
    /// store (`replaceTrainStoreFromJsonText`) and 開始載入／逐條匯入 appends
    /// (`importCanonicalStoreAppendProgressive`). Keeping those defaults means
    /// a reader who does what they did on the web gets what they got on the
    /// web — the difference is that here the mode is written down and
    /// changeable before anything happens, rather than implied by which
    /// button was pressed.
    func load(_ text: String, origin: Origin) {
        self.text = text
        self.origin = origin
        mode = origin == .pasted ? .append : .replaceAll
        phase = .editing
    }

    // MARK: - check

    /// The dry run. Nothing it does can change the store, which is why it is
    /// safe to run automatically the moment a file is chosen.
    func check(itineraries: ItineraryStore, region: Region) {
        work?.cancel()
        preflight?.cancel()
        let source = text
        let current = itineraries.store?.trains ?? []
        let checkedMode = mode
        startVisibilityClock()
        phase = .checking(
            ProgressSummary(
                stage: .reading, completed: nil, total: nil, canInteract: true, canCancel: true))

        let (stream, continuation) = AsyncStream<ItineraryStore.ImportProgress>.makeStream(
            bufferingPolicy: .bufferingNewest(1))
        let job = Task.detached(priority: .userInitiated) { () throws -> ImportPreflight.Report in
            defer { continuation.finish() }
            return try ImportPreflight.inspect(
                text: source, currentTrains: current, country: region.code, mode: checkedMode
            ) { done, total in
                continuation.yield(
                    ItineraryStore.ImportProgress(completed: done, total: total, trainID: nil))
            }
        }
        preflight = job

        work = Task { [weak self] in
            for await tick in stream {
                guard let self else { return }
                phase = .checking(
                    ProgressSummary(
                        stage: .validating, completed: tick.completed, total: tick.total,
                        canInteract: true, canCancel: true))
            }
            guard let self else { return }
            do {
                let report = try await job.value
                stopVisibilityClock()
                phase = .checked(report)
            } catch is CancellationError {
                stopVisibilityClock()
                phase = .editing
            } catch {
                stopVisibilityClock()
                phase = .failed(
                    Failure(
                        title: ImportPreflight.message(of: error),
                        issues: [],
                        keptCount: current.count))
            }
        }
    }

    // MARK: - commit

    /// The real thing. Everything it needs to know was decided by the report,
    /// so this method takes no decisions of its own — it runs the engine door
    /// the mode names, then saves.
    func commit(
        itineraries: ItineraryStore,
        library: RideLibrary,
        region: Region
    ) {
        guard let report, report.isCommittable else { return }
        work?.cancel()
        let source = text
        let label = origin.label
        let mode = report.mode
        let renamed = report.renames.count
        let keptCount = itineraries.store?.trains.count ?? 0
        startVisibilityClock()
        phase = .importing(
            ProgressSummary(
                stage: .reading, completed: nil, total: report.documentCount, canInteract: true,
                canCancel: true))

        work = Task { [weak self] in
            guard let self else { return }
            // The recovery copy is written BEFORE the store changes, which is
            // the only moment at which it can still be written (§5.8).
            if let current = itineraries.store, !current.trains.isEmpty {
                library.snapshotBackup(current, reason: .beforeImport)
            }
            do {
                let summary = try await itineraries.runImport(
                    text: source, region: region, mode: mode,
                    sourceLabel: label.isEmpty ? "JSON" : label
                ) { progress in
                    self.phase = .importing(
                        ProgressSummary(
                            stage: .importing, completed: progress.completed,
                            total: progress.total, canInteract: true, canCancel: true))
                }
                phase = .importing(
                    ProgressSummary(
                        stage: .saving, completed: nil, total: nil, canInteract: false,
                        canCancel: false))
                if let store = itineraries.store {
                    library.save(store)
                }
                stopVisibilityClock()
                phase = .finished(
                    Outcome(
                        imported: summary.imported, renamed: renamed, mode: mode,
                        storeCount: summary.storeCount, saveError: library.lastSaveError))
            } catch is CancellationError {
                stopVisibilityClock()
                phase = .failed(
                    Failure(
                        title: "", issues: [], keptCount: keptCount, neutral: true))
            } catch {
                stopVisibilityClock()
                phase = .failed(
                    Failure(
                        title: ImportPreflight.message(of: error), issues: [],
                        keptCount: keptCount))
            }
        }
    }

    func cancel() {
        preflight?.cancel()
        work?.cancel()
        stopVisibilityClock()
    }

    // MARK: - §13.2 timing

    private func startVisibilityClock() {
        visibilityClock?.cancel()
        visibility = .quiet
        visibilityClock = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let self else { return }
            self.visibility = .stage
            try? await Task.sleep(for: .milliseconds(2600))
            guard !Task.isCancelled else { return }
            self.visibility = .quantitative
        }
    }

    private func stopVisibilityClock() {
        visibilityClock?.cancel()
        visibilityClock = nil
        visibility = .quiet
    }
}
