import Foundation
import RailCore

// The presentation state layer of JRM_FLIGHTY_UI_REFACTOR_SPEC.md §11.1.
//
// Why this is a separate target and not `RailCore`, and not the app either:
//
// §16 forbids display state in `RailCore` ("不得加入 SwiftUI/MapKit 展示状态")
// and §1.2 puts presentation resolution in the platform display layer. But the
// app target has no test target, and §15 Slice 1 requires unit tests for the
// failure / hidden / playback priority. So the resolution lives one step below
// SwiftUI: a Foundation + RailCore module the package can run `swift test`
// against, which the app imports and renders.
//
// Nothing here knows about SwiftUI, MapKit, `ItineraryStore`, `RiddenRouteStore`
// or `PlaybackController`. Those types are `@MainActor @Observable` app objects;
// the app flattens them into the value inputs below and renders what comes back.

// MARK: - Text

/// A string the display layer still has to resolve.
///
/// The resolver deliberately does not return finished English. §11.2 is explicit
/// that "文案最终由现有本地化系统提供；示例中的英文是结构占位", and the catalog
/// runtime this app uses (`RailCore.Localization`, driven by `AppLocalization`)
/// speaks `{placeholder}` fills and four fallback chains that a pre-formatted
/// string would have already thrown away.
///
/// `key == nil` marks text that is a *record value* — a train number, a station
/// name, an error message from `Foundation` — which must never be sent through
/// a translation table. Those carry their text in `fallback`.
public struct PresentationText: Equatable, Sendable {

    /// Catalog key, or `nil` for a record value that must not be translated.
    public let key: String?

    /// `{name}` parameters for the catalog entry, and for the fallback: the
    /// app's `AppLocalization.text(_:params:fallback:)` fills placeholders in
    /// the fallback too, so a key missing from the catalog still renders its
    /// numbers.
    public let params: [String: Localization.Param]

    /// English structural placeholder, used when the key resolves to nothing.
    /// Not the shipped copy — the catalog is.
    public let fallback: String

    public init(key: String?, params: [String: Localization.Param] = [:], fallback: String) {
        self.key = key
        self.params = params
        self.fallback = fallback
    }

    /// A localized string.
    public static func key(
        _ key: String,
        _ params: [String: Localization.Param] = [:],
        fallback: String
    ) -> PresentationText {
        PresentationText(key: key, params: params, fallback: fallback)
    }

    /// A value out of the record. Never translated.
    public static func value(_ text: String) -> PresentationText {
        PresentationText(key: nil, fallback: text)
    }
}

// MARK: - Task state machine

/// §2.1's task state machine, as far as the presentation layer needs it.
///
/// The machine's own note — "状态可以并行，但界面必须解析出唯一的主任务" — is
/// why this is an input to the resolver and not a rendering instruction: several
/// of these can be true at once, and `JourneyPresentationResolver` is the thing
/// that picks which one the surface is about.
public enum JourneyWorkspacePhase: Equatable, Sendable {
    case loading
    case empty
    case browsing
    case selected
    /// `isValid == false` is an L0 blocker: §3.3 requires *no* prominent button
    /// while the draft cannot be saved.
    case editing(isDirty: Bool, isValid: Bool)
    case resolving(completed: Int?, total: Int?)
    case playing(progress: Double, isPaused: Bool)
    case importing(completed: Int?, total: Int?)
    case failed(JourneyFailure)
}

/// §5.5's five user-visible route states.
///
/// `needsReview` and `unavailable` are separate states because they have
/// different recoveries, not different severities: review means part of the
/// journey drew and the rest needs a human decision; unavailable means nothing
/// drew. Neither one may be represented by a straight line (§1.1).
public enum JourneyRouteState: Equatable, Sendable {
    case unknown
    case resolving(completed: Int?, total: Int?)
    case resolved
    /// `reason` is a record value (an affected section, a solver message), not
    /// a catalog key — see `PresentationText.value`.
    case needsReview(reason: String)
    case unavailable(reason: String)
}

/// What `RiddenRouteStore.LoadState` looks like from here.
///
/// `RiddenRouteStore` is a `@MainActor @Observable` app object, so it cannot be
/// named in this target. The app maps its four cases onto these four; the
/// mapping is one-to-one on purpose, so that when Slice 3 gives the store a
/// per-train state this enum is what changes.
public enum RouteLoadPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

/// §3.1 L0. The four failures that can take over a surface.
public enum JourneyFailure: Equatable, Sendable {
    case load(String)
    case importData(String)
    case route(trainID: String, section: String?, message: String)
    case save(String)
}

// MARK: - Presentation

/// One resolved surface.
///
/// The field order is §13.3's error-copy structure, which is also the scan
/// order of a healthy journey (§3.2):
///
///   `title`         what happened / what this journey is
///   `subtitle`      what it affects / where it runs
///   `status.title`  what was kept
///   actions         what the reader can do next
public struct JourneyPresentation: Equatable, Sendable {

    /// §3.3's dynamic primary action. Exactly one, or none — the type is
    /// singular because §3.1's "同一表面最多出现一个填充强调的主按钮" is not a
    /// convention this layer hopes views will follow.
    public enum PrimaryAction: Hashable, Sendable {
        case add
        case importData
        case locate
        case showOnMap
        case rebuildRoute
        case save
        case pause
        case resume
        case retry
        case clearSearch
    }

    public var eyebrow: PresentationText?
    public var title: PresentationText
    public var subtitle: PresentationText?
    public var status: StatusPresentation?
    public var primaryAction: PrimaryAction?
    public var secondaryActions: [SecondaryAction]

    /// True whenever starting playback — or a video export, §8.4 — would be a
    /// lie about the state of the route.
    ///
    /// The resolver guarantees this is true for every route state other than
    /// `.resolved`, and that no `.playing` presentation is produced while it is.
    public var blocksPlayback: Bool

    public init(
        eyebrow: PresentationText? = nil,
        title: PresentationText,
        subtitle: PresentationText? = nil,
        status: StatusPresentation? = nil,
        primaryAction: PrimaryAction? = nil,
        secondaryActions: [SecondaryAction] = [],
        blocksPlayback: Bool = false
    ) {
        self.eyebrow = eyebrow
        self.title = title
        self.subtitle = subtitle
        self.status = status
        self.primaryAction = primaryAction
        self.secondaryActions = secondaryActions
        self.blocksPlayback = blocksPlayback
    }
}

/// §7.5 StatusBadge. Present only when the state helps a decision — which is
/// why `resolved` produces none: "`resolved`、`normal` 之类成功状态不应在每个
/// 卡片永久显示."
public struct StatusPresentation: Equatable, Sendable {
    /// §3.1: colour is the *second* encoding. `title` is the first, and it is
    /// not optional, so a tone can never be the only thing carrying the state.
    public enum Tone: Equatable, Sendable { case neutral, positive, caution, critical }

    public var title: PresentationText
    public var detail: PresentationText?
    public var tone: Tone

    public init(title: PresentationText, detail: PresentationText? = nil, tone: Tone) {
        self.title = title
        self.detail = detail
        self.tone = tone
    }
}

/// §7.6 QuietActionGroup. Everything that is not the one filled button.
public enum SecondaryAction: Hashable, Sendable {
    case play
    case stop
    case edit
    case duplicate
    case hide
    case show
    case delete
    case inspectDetails
    case rebuildRoute
    case cancel
    case importData
    case add
}

// MARK: - The single-prominent-action invariant

extension JourneyPresentation {

    /// §3.1 / §14.1: the filled-emphasis buttons on this surface.
    ///
    /// Structurally never more than one. Exposed anyway so the acceptance
    /// criterion is a thing that can be asserted rather than a thing that is
    /// argued about.
    public var prominentActions: [PrimaryAction] {
        primaryAction.map { [$0] } ?? []
    }

    /// Secondary entries that would read as a second copy — or the opposite —
    /// of the primary action.
    ///
    /// A "Show on map" primary next to a "Hide" secondary, or a "Pause" primary
    /// next to a "Play" secondary, is two answers to one question even though
    /// only one of them is filled. Non-empty here is a resolver bug.
    public var conflictingSecondaryActions: [SecondaryAction] {
        guard let primaryAction else { return [] }
        let contradicted: Set<SecondaryAction>
        switch primaryAction {
        case .locate: contradicted = []
        case .showOnMap: contradicted = [.hide, .show]
        case .rebuildRoute: contradicted = [.rebuildRoute]
        case .pause: contradicted = [.play]
        case .resume: contradicted = [.play]
        case .add: contradicted = [.add]
        case .importData: contradicted = [.importData]
        case .save, .retry, .clearSearch: contradicted = []
        }
        var seen = Set<SecondaryAction>()
        var duplicates: [SecondaryAction] = []
        for action in secondaryActions {
            if !seen.insert(action).inserted { duplicates.append(action) }
            if contradicted.contains(action) { duplicates.append(action) }
        }
        return duplicates
    }
}

// MARK: - Deriving the route state from what the app can actually observe

extension JourneyRouteState {

    /// Builds a route state out of the signals `RiddenRouteStore` exposes today.
    ///
    /// ## What the store can and cannot say
    ///
    /// `RiddenRouteStore` carries one *store-wide* `LoadState` and a `[DrawnRide]`.
    /// A journey is "solved" by being present in that array with at least one
    /// segment; a journey that failed to solve is simply absent, because
    /// `solveMissing` appends a `DrawnRide` only `if !segments.isEmpty` and
    /// drops every section that returned nothing without recording that it did.
    ///
    /// So `unavailable` is derivable (loaded, and no drawn ride) and `resolving`
    /// / `unknown` are derivable (from the store-wide phase), but **`needsReview`
    /// is not**: nothing today reports "4 of 6 sections drew". That is why
    /// `expectedSectionCount` is an explicit parameter rather than something
    /// this function digs out — passing `nil` (all the app can do at Slice 1)
    /// can never produce `needsReview`, and the state is reached only by a
    /// caller that genuinely knows the count. Slice 3 owns adding it to the
    /// store; inventing it here would have meant a model that looks complete
    /// over data that is not.
    ///
    /// - Parameters:
    ///   - loadPhase: `RiddenRouteStore.LoadState`, flattened.
    ///   - drawnSegmentCount: segments actually drawn for this journey, or `nil`
    ///     when the journey has no `DrawnRide` at all.
    ///   - expectedSectionCount: route sections the journey should have drawn,
    ///     or `nil` when unknown.
    ///   - reason: the record value shown for a partial or failed route.
    public static func resolve(
        loadPhase: RouteLoadPhase,
        drawnSegmentCount: Int?,
        expectedSectionCount: Int? = nil,
        reason: String = ""
    ) -> JourneyRouteState {
        switch loadPhase {
        case .idle:
            return .unknown
        case .loading:
            // Store-wide, so a journey already drawn is not un-drawn by a
            // reload of the rest: only a journey with nothing on the map is
            // reported as still resolving.
            if let drawnSegmentCount, drawnSegmentCount > 0 {
                return resolvedOrPartial(
                    drawn: drawnSegmentCount, expected: expectedSectionCount, reason: reason)
            }
            return .resolving(completed: nil, total: expectedSectionCount)
        case .failed(let message):
            // A store-wide load failure is not evidence about this journey's
            // route, but it does mean nothing was drawn for it.
            return .unavailable(reason: reason.isEmpty ? message : reason)
        case .loaded:
            guard let drawnSegmentCount, drawnSegmentCount > 0 else {
                return .unavailable(reason: reason)
            }
            return resolvedOrPartial(
                drawn: drawnSegmentCount, expected: expectedSectionCount, reason: reason)
        }
    }

    private static func resolvedOrPartial(
        drawn: Int, expected: Int?, reason: String
    ) -> JourneyRouteState {
        guard let expected, expected > drawn else { return .resolved }
        return .needsReview(reason: reason)
    }
}
