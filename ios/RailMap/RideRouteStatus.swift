import Foundation
import Observation
import RailCore
import RailPresentation

/// §5.5's route resolution state, for **one** journey.
///
/// `RailPresentation.JourneyRouteState` is the same five states one tier down,
/// and this bridges to it (``journeyRouteState``). It is not simply used
/// instead, because the pure tier deliberately reduces a partial solve to a
/// single `reason` string: its own documentation says `needsReview` "is not"
/// derivable from what Slice 1 could observe, and that "Slice 3 owns adding it
/// to the store".
///
/// That is what this type is. `RiddenRouteStore.RouteOutcome` now names the
/// stretches that did not draw, and §8.4 requires the interface to say which
/// ones ("失败时明确受影响区间"), so the gaps travel all the way to the screen
/// rather than being flattened into "something failed".
enum RideRouteStatus: Equatable {
    /// Nothing has been asked yet — no solve has started (§5.5 `unknown`).
    case unknown
    /// A solve is running for this journey (§5.5 `resolving`).
    case resolving
    /// Every section came back with geometry (§5.5 `resolved`).
    case resolved(sections: Int)
    /// Some sections drew and some did not (§5.5 `needsReview`).
    case needsReview(solved: Int, expected: Int, gaps: [RiddenRouteStore.SectionGap])
    /// Sections were asked for and none drew (§5.5 `unavailable`).
    ///
    /// `reason` is a record value — a load failure the reader can act on —
    /// never a catalog key. Nil means the ordinary case: the solver found no
    /// path that fits the constraints, which the card explains in the
    /// catalog's own words.
    case unavailable(expected: Int, reason: String?)
    /// The journey has no drawable section at all — no two adjacent stops are
    /// marked ridden, so there is nothing for the solver to be asked.
    ///
    /// Kept apart from ``unavailable(expected:)`` because the recovery is
    /// different: nothing failed, the reader has not said which stretch they
    /// rode yet.
    case noRoute

    /// §8.4 / §5.6: starting playback or a video export over a route that is
    /// not whole would be a claim the data does not support.
    var blocksPlayback: Bool {
        if case .resolved = self { return false }
        return true
    }

    /// §7.5: a success state is not a permanent badge. Only these states are
    /// worth taking space in a Hero for.
    var isNoteworthy: Bool {
        switch self {
        case .resolved: false
        default: true
        }
    }

    /// The same state as the pure display tier spells it, so a surface already
    /// rendering `JourneyPresentation` gets the richer answer for free.
    ///
    /// The gap list collapses into `reason` here — that is the shape §11.1
    /// defines — and every caller that wants the sections themselves reads
    /// this enum instead.
    func journeyRouteState(reason: String = "") -> JourneyRouteState {
        switch self {
        case .unknown: .unknown
        case .resolving: .resolving(completed: nil, total: nil)
        case .resolved: .resolved
        case .needsReview(let solved, let expected, _):
            .needsReview(reason: reason.isEmpty ? "\(solved)/\(expected)" : reason)
        case .unavailable(_, let failure):
            .unavailable(reason: reason.isEmpty ? (failure ?? "") : reason)
        case .noRoute: .unavailable(reason: reason)
        }
    }
}

/// What the editor and the journey detail need to know about the workspace
/// they were never handed.
///
/// ## Why this is a shared object rather than a parameter
///
/// `RiddenRouteStore` and `ItineraryStore` are created once, in `AppShell`,
/// and threaded down by hand. The journey detail is pushed by
/// `ContentView.navigationDestination` and the ride panel builds `RideCard`;
/// neither passes a route store, and both files belong to other ports running
/// in parallel — so a new initialiser argument on `RideDetailContent` cannot be
/// filled in without editing files this work does not own.
///
/// So the two stores publish into one main-actor `@Observable` object, and the
/// surfaces read it. Every consumer still accepts an explicit value first
/// (`RideDetailContent.routeStatus`), which is the seam to close once the
/// owning files can be touched: pass the status in, and this becomes the
/// fallback nobody reaches.
///
/// It holds no truth of its own. Every field is a projection of a store's
/// state, written by that store, and reset when the store resets.
@MainActor
@Observable
final class RideStatusCenter {
    static let shared = RideStatusCenter()

    /// `RiddenRouteStore.LoadState`, flattened — the same four cases
    /// `RailPresentation.RouteLoadPhase` names.
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// One journey's solved route, as the store left it.
    ///
    /// `Sendable` because the store builds these on the decode's own executor
    /// and hands the finished table to the main actor in one assignment.
    struct Entry: Equatable, Sendable {
        var outcome: RiddenRouteStore.RouteOutcome
        var drawnSegments: Int
    }

    private(set) var phase: Phase = .idle
    private(set) var entries: [String: Entry] = [:]
    /// Journeys with a solve in flight right now — a single-journey rebuild
    /// (§8.4), which the store-wide `phase` cannot express.
    private(set) var resolvingIDs: Set<String> = []
    /// Every id in the itinerary store. §8.3: an id edit must not silently
    /// overwrite another record, and the editor can only warn about a
    /// collision it can see.
    private(set) var trainIDs: Set<String> = []
    /// The live route store, for the one thing a status reader has to be able
    /// to ask for: solve this journey again. Weak, and ignored by observation
    /// — it is a wire, not state.
    @ObservationIgnored weak var routeStore: RiddenRouteStore?

    // MARK: - Reading

    func status(forTrainID id: String) -> RideRouteStatus {
        if resolvingIDs.contains(id) { return .resolving }
        guard let entry = entries[id] else {
            switch phase {
            case .idle: return .unknown
            // Store-wide, so a journey nobody has reported on yet is still
            // being worked on rather than known to have failed.
            case .loading: return .resolving
            case .loaded: return .noRoute
            // §8.8: a route dataset that would not load is not evidence that
            // this journey has nothing to draw, so it is not reported as
            // such — it is a route that is unavailable, for a stated reason.
            case .failed(let message): return .unavailable(expected: 0, reason: message)
            }
        }
        switch entry.outcome {
        case .resolved:
            return .resolved(sections: max(entry.drawnSegments, 1))
        case .partial(let solved, let expected, let unsolved):
            return .needsReview(solved: solved, expected: expected, gaps: unsolved)
        case .unavailable(let expected):
            // `expected == 0` is the store's spelling for "this journey asked
            // for nothing": `solveMissing` skips a train whose canonical
            // section list is empty, and the publish below records the ones it
            // skipped rather than leaving them indistinguishable from a
            // journey it never saw.
            return expected == 0
                ? .noRoute : .unavailable(expected: expected, reason: nil)
        }
    }

    /// Whether an id typed into the editor belongs to a different journey.
    func idIsTaken(_ candidate: String, editing originalID: String) -> Bool {
        candidate != originalID && trainIDs.contains(candidate)
    }

    // MARK: - Writing (stores only)

    func publish(phase: Phase) {
        self.phase = phase
        if phase == .loading { resolvingIDs.removeAll() }
    }

    func publish(entries: [String: Entry], phase: Phase) {
        self.entries = entries
        self.phase = phase
        resolvingIDs.removeAll()
    }

    func publish(trainIDs: Set<String>) {
        self.trainIDs = trainIDs
    }

    func beginResolving(_ id: String) { resolvingIDs.insert(id) }

    func finishResolving(_ id: String, entry: Entry?) {
        resolvingIDs.remove(id)
        if let entry {
            entries[id] = entry
        } else {
            entries.removeValue(forKey: id)
        }
    }

    func clear() {
        phase = .idle
        entries.removeAll()
        resolvingIDs.removeAll()
    }

    /// §8.4: solve one journey again and let the map update.
    ///
    /// Returns whether a solve actually started. It does not when the app is
    /// running without a route store under it (previews, tests), and the
    /// caller says "sections rebuilt" rather than "route rebuilt" in that
    /// case instead of claiming work that nobody is doing.
    @discardableResult
    func resolveAgain(_ train: Train) -> Bool {
        guard let routeStore else { return false }
        // Which package a rebuild solves against comes from the journey
        // itself — `Train.region` — rather than from a region the app is
        // switched to, because there is no longer such a thing.
        routeStore.resolve(train)
        return true
    }
}
