import Foundation
import RailCore

/// JRM_FLIGHTY_UI_REFACTOR_SPEC.md §11.2 — the information-priority resolver.
///
/// §2.1's task states run in parallel. A journey can be hidden *and* have a
/// route that failed *and* be the one the reader just hit play on. The spec's
/// requirement is not that the interface show all three; it is that it resolve
/// them into one primary task ("界面必须解析出唯一的主任务"), and it names the
/// case that makes this load-bearing rather than tidy:
///
/// > 例如路线正在求解且用户启动回放时，回放不能假装可用；`resolvingRoute` 的
/// > 阻塞原因必须成为主状态。
///
/// So the priority is a total order applied in one place, and every view reads
/// the answer instead of re-deriving it from a local `if`:
///
///   1. failure          §3.1 L0 — blocking, and it stays on screen (§3.1: an
///                       error that blocks the task may not be a toast)
///   2. editing          the draft is the surface; an invalid draft is L0 too
///   3. hidden           §3.3 — "在地图显示" is the primary action
///   4. playing          §5.6 — playback replaces the ordinary journey actions
///   5. route state      §5.5
///   6. resolved/normal  §3.3 — locate
///
/// Two places where this deviates from the §11.2 sample, both deliberate:
///
/// - The sample tests `playing` before `hidden`. This orders `hidden` first:
///   playing a journey that is not on the map answers no question the reader
///   has, and §3.3 gives a hidden record exactly one primary action, "在地图显示".
/// - The sample has no `editing` branch. §3.3 does ("编辑草稿有效 → 保存";
///   "编辑草稿无效 → 无 Prominent 按钮；保存禁用"), so it is placed directly
///   under failure: while a draft is open the draft is what the surface is about.
public enum JourneyPresentationResolver {

    // MARK: - Selected journey

    /// Resolves the surface for one selected journey.
    ///
    /// - Parameters:
    ///   - train: the canonical record. Never mutated, never re-derived here.
    ///   - route: §5.5 state, from `JourneyRouteState.resolve(...)`.
    ///   - phase: the selection's active sub-phase — `.failed`, `.editing`,
    ///     `.playing`, or `nil` for a plain selection. `.loading`, `.empty`,
    ///     `.browsing`, `.selected`, `.resolving` and `.importing` are workspace
    ///     phases and are handled by `workspace(phase:)`; passed here they mean
    ///     nothing more than "no sub-phase".
    public static func selected(
        train: Train,
        route: JourneyRouteState,
        phase: JourneyWorkspacePhase? = nil
    ) -> JourneyPresentation {
        let number = PresentationText.value(train.number)
        let endpoints = endpointsText(train)

        // 1. Failure. Blocking and non-transient: §3.1 forbids representing a
        //    task-blocking error as a toast that then disappears.
        if case .failed(let failure) = phase {
            return self.failure(failure, eyebrow: number, subtitle: endpoints)
        }

        // 2. Editing. §3.3: a valid draft's primary is Save; an invalid draft
        //    gets no prominent button at all, and the view moves focus to the
        //    first bad field instead.
        if case .editing(let isDirty, let isValid) = phase {
            return editing(train: train, isDirty: isDirty, isValid: isValid, subtitle: endpoints)
        }

        // 3. Hidden. §8.5: hiding changes the map, not the record or the export,
        //    and the copy has to say so.
        if train.visible == false {
            return JourneyPresentation(
                eyebrow: number,
                title: .key(Keys.hiddenTitle, fallback: "Hidden from map"),
                subtitle: endpoints,
                status: StatusPresentation(
                    title: .key(Keys.stillSaved, fallback: "Journey is still saved"),
                    detail: .key(
                        Keys.hiddenDetail,
                        fallback: "Showing it again does not change exported journey data."),
                    tone: .neutral),
                primaryAction: .showOnMap,
                secondaryActions: [.edit, .duplicate, .delete],
                blocksPlayback: true)
        }

        // 4. Playback — but only over a route that actually exists.
        //
        //    This guard is the §2.1 rule. Falling through to the route branch
        //    when the route is not resolved is what stops the interface from
        //    offering a pause button for a journey it cannot draw, and it is
        //    also §8.4 ("求解中不得让用户启动依赖完整路线的回放或视频导出").
        if case .playing(_, let isPaused) = phase, route == .resolved {
            return JourneyPresentation(
                eyebrow: number,
                title: isPaused
                    ? .key(Keys.playbackPaused, fallback: "Playback paused")
                    : .key(Keys.playing, fallback: "Playing journey"),
                subtitle: endpoints,
                status: nil,
                primaryAction: isPaused ? .resume : .pause,
                secondaryActions: [.stop, .inspectDetails],
                blocksPlayback: false)
        }

        // 5. Route state.
        switch route {
        case .unknown, .resolving:
            // §5.5 keeps these apart: unknown is "准备路线" and resolving is
            // "正在重建路线". Copy that claims a solve is under way when none
            // has started is the same class of lie as a fake straight line —
            // smaller, but it teaches the reader to distrust the progress text.
            let isResolving: Bool
            if case .resolving = route { isResolving = true } else { isResolving = false }
            return JourneyPresentation(
                eyebrow: number,
                title: isResolving
                    ? .key(Keys.routeBuilding, fallback: "Building railway route")
                    : .key(Keys.routePreparing, fallback: "Preparing route"),
                subtitle: endpoints,
                status: StatusPresentation(
                    title: isResolving
                        ? .key(
                            Keys.routeGenerating,
                            ["train": .string(train.number)],
                            fallback: "Generating N02 railway route for {train}...")
                        : .key(Keys.routeNotReady, fallback: "Route is not ready yet"),
                    tone: .neutral),
                // §13.2 / §3.3: nothing to press. Offering "Rebuild" against a
                // solve already in flight is a second answer to one question.
                primaryAction: nil,
                secondaryActions: [.edit, .inspectDetails],
                blocksPlayback: true)

        case .needsReview(let reason):
            return JourneyPresentation(
                eyebrow: number,
                title: .key(Keys.routeNeedsReview, fallback: "Route needs review"),
                subtitle: reason.isEmpty ? endpoints : .value(reason),
                status: StatusPresentation(
                    title: .key(
                        Keys.recordUnchanged,
                        fallback: "Journey record and stops are unchanged."),
                    detail: .key(
                        Keys.routePartial,
                        fallback: "Some sections could not be drawn. No straight line was used."),
                    tone: .caution),
                primaryAction: .rebuildRoute,
                // §8.4: "优先给「编辑停站」而不是「重试」死循环" — so editing the
                // stops leads the quiet group even though the primary rebuilds.
                secondaryActions: [.edit, .inspectDetails],
                blocksPlayback: true)

        case .unavailable(let reason):
            return JourneyPresentation(
                eyebrow: number,
                title: .key(Keys.routeUnavailable, fallback: "Route unavailable"),
                subtitle: reason.isEmpty ? endpoints : .value(reason),
                status: StatusPresentation(
                    title: .key(
                        Keys.recordUnchanged,
                        fallback: "Journey record and stops are unchanged."),
                    // §1.1: the record is intact and no straight line was drawn
                    // in place of the railway. The existing catalog entry says
                    // exactly this, in all four languages.
                    detail: .key(
                        Keys.routeNoPath,
                        fallback: """
                            No N02 railway path could be generated from embedded N02 data. \
                            Check station codes / route_policy. No fake straight line was drawn.
                            """),
                    tone: .critical),
                primaryAction: .rebuildRoute,
                secondaryActions: [.edit, .inspectDetails],
                blocksPlayback: true)

        case .resolved:
            // 6. Normal. §7.5: no permanent success badge — `status` is nil, and
            //    the reader sees the journey rather than a green tick about it.
            //    §3.2's scan order puts the date above the number as an eyebrow.
            return JourneyPresentation(
                eyebrow: train.date.map(PresentationText.value),
                title: number,
                subtitle: endpoints,
                status: nil,
                primaryAction: .locate,
                secondaryActions: [.play, .edit, .duplicate, .hide, .delete],
                blocksPlayback: false)
        }
    }

    // MARK: - Workspace

    /// Resolves the list-level surface: §13.1 empty states, §13.2 loading, and
    /// the import flow of §8.7.
    public static func workspace(
        phase: JourneyWorkspacePhase,
        hasSearchQuery: Bool = false,
        hasDateFilter: Bool = false
    ) -> JourneyPresentation {
        switch phase {
        case .failed(let failure):
            return self.failure(failure, eyebrow: nil, subtitle: nil)

        case .loading:
            return JourneyPresentation(
                title: .key(Keys.loadingTitle, fallback: "Loading journeys"),
                status: StatusPresentation(
                    title: .key(Keys.loadingDetail, fallback: "Reading the saved store"),
                    tone: .neutral),
                primaryAction: nil,
                secondaryActions: [],
                blocksPlayback: true)

        case .empty:
            // §13.1: three different empty states with three different single
            // primary actions — "空状态不得同时放三个同权主按钮."
            if hasSearchQuery {
                return JourneyPresentation(
                    title: .key(Keys.emptySearchTitle, fallback: "No matching journeys"),
                    subtitle: .key(
                        Keys.emptySearchDetail,
                        fallback: "Try a train number, a station, or an ID."),
                    primaryAction: .clearSearch,
                    secondaryActions: [.add, .importData],
                    blocksPlayback: true)
            }
            if hasDateFilter {
                return JourneyPresentation(
                    title: .key(Keys.emptyDateTitle, fallback: "No journeys on this day"),
                    subtitle: .key(
                        Keys.emptyDateDetail,
                        fallback: "The current date filter has no records."),
                    primaryAction: .add,
                    secondaryActions: [.importData],
                    blocksPlayback: true)
            }
            return JourneyPresentation(
                title: .key(Keys.emptyTitle, fallback: "No journeys yet"),
                subtitle: .key(
                    Keys.emptyDetail,
                    fallback: "Add a journey, or import an existing JSON store."),
                primaryAction: .add,
                secondaryActions: [.importData],
                blocksPlayback: true)

        case .importing(let completed, let total):
            return JourneyPresentation(
                title: .key(Keys.importingTitle, fallback: "Importing journeys"),
                subtitle: progressText(completed: completed, total: total),
                status: StatusPresentation(
                    title: .key(
                        Keys.importBusy, fallback: "Loading data — please wait before editing."),
                    tone: .neutral),
                primaryAction: nil,
                secondaryActions: [.cancel],
                // §8.7 allows watching the map during a long import; it does not
                // allow starting something that depends on routes not yet solved.
                blocksPlayback: true)

        case .resolving(let completed, let total):
            return JourneyPresentation(
                title: .key(Keys.routeBuilding, fallback: "Building railway route"),
                subtitle: progressText(completed: completed, total: total),
                status: StatusPresentation(
                    title: .key(Keys.routePreparing, fallback: "Preparing route"),
                    tone: .neutral),
                primaryAction: nil,
                secondaryActions: [],
                blocksPlayback: true)

        case .browsing, .selected, .editing, .playing:
            return JourneyPresentation(
                title: .key(Keys.browsingTitle, fallback: "My Rides"),
                primaryAction: .add,
                secondaryActions: [.importData],
                blocksPlayback: false)
        }
    }

    // MARK: - Failure

    /// §13.3's four-line error structure, mapped onto the four fields that
    /// carry it: title = 发生了什么, subtitle = 影响了什么,
    /// status.title = 保留了什么, actions = 用户下一步可以做什么.
    private static func failure(
        _ failure: JourneyFailure,
        eyebrow: PresentationText?,
        subtitle: PresentationText?
    ) -> JourneyPresentation {
        switch failure {
        case .load(let message):
            return JourneyPresentation(
                eyebrow: eyebrow,
                title: .key(Keys.loadFailedTitle, fallback: "Could not load journeys"),
                subtitle: .value(message),
                status: StatusPresentation(
                    title: .key(
                        Keys.loadFailedKept,
                        fallback: "Saved journey data on this device was not changed."),
                    tone: .critical),
                primaryAction: .retry,
                secondaryActions: [.importData, .inspectDetails],
                blocksPlayback: true)

        case .importData(let message):
            return JourneyPresentation(
                eyebrow: eyebrow,
                title: .key(Keys.importFailedTitle, fallback: "Could not import this file"),
                subtitle: .value(message),
                status: StatusPresentation(
                    // §8.7: parse and validation never touch current data.
                    title: .key(
                        Keys.importFailedKept,
                        fallback: "Nothing was imported; your existing journeys are unchanged."),
                    tone: .critical),
                primaryAction: .importData,
                secondaryActions: [.cancel, .inspectDetails],
                blocksPlayback: true)

        case .route(let trainID, let section, let message):
            return JourneyPresentation(
                eyebrow: eyebrow ?? .value(trainID),
                title: .key(Keys.routeUnavailable, fallback: "Route unavailable"),
                subtitle: section.map { (affected: String) -> PresentationText in
                    PresentationText.key(
                        Keys.routeAffectedSection,
                        ["section": .string(affected)],
                        fallback: "No path matched the current line constraints for {section}.")
                } ?? .value(message),
                status: StatusPresentation(
                    title: .key(
                        Keys.recordUnchanged,
                        fallback: "Journey record and stops are unchanged."),
                    detail: .key(
                        Keys.routeNoPath,
                        fallback: """
                            No N02 railway path could be generated from embedded N02 data. \
                            Check station codes / route_policy. No fake straight line was drawn.
                            """),
                    tone: .critical),
                primaryAction: .rebuildRoute,
                secondaryActions: [.edit, .inspectDetails],
                blocksPlayback: true)

        case .save(let message):
            return JourneyPresentation(
                eyebrow: eyebrow,
                title: .key(Keys.saveFailedTitle, fallback: "Could not save this journey"),
                subtitle: subtitle ?? .value(message),
                status: StatusPresentation(
                    // §8.3: a failed save keeps the draft and the focus.
                    title: .key(Keys.saveFailedKept, fallback: "Your edits are still open."),
                    detail: .value(message),
                    tone: .critical),
                primaryAction: .save,
                secondaryActions: [.cancel, .inspectDetails],
                blocksPlayback: true)
        }
    }

    // MARK: - Editing

    private static func editing(
        train: Train,
        isDirty: Bool,
        isValid: Bool,
        subtitle: PresentationText?
    ) -> JourneyPresentation {
        guard isValid else {
            // §3.3: no prominent button. Save is disabled and the view sends
            // focus to the first bad field; there is nothing to press here.
            return JourneyPresentation(
                eyebrow: .value(train.number),
                title: .key(Keys.draftInvalidTitle, fallback: "Fix these fields to save"),
                subtitle: subtitle,
                status: StatusPresentation(
                    title: .key(
                        Keys.draftInvalidKept,
                        fallback: "The saved journey is unchanged until you save."),
                    tone: .caution),
                primaryAction: nil,
                secondaryActions: [.cancel, .inspectDetails],
                blocksPlayback: true)
        }
        return JourneyPresentation(
            eyebrow: .value(train.number),
            title: .key(Keys.editingTitle, fallback: "Edit journey"),
            subtitle: subtitle,
            status: isDirty
                ? StatusPresentation(
                    title: .key(Keys.draftDirty, fallback: "Unsaved changes"), tone: .caution)
                : nil,
            primaryAction: isDirty ? .save : nil,
            secondaryActions: [.cancel],
            blocksPlayback: true)
    }

    // MARK: - Shared text

    /// §3.2: origin → destination, second in the scan order and never smaller
    /// than the operator or the route constraints.
    private static func endpointsText(_ train: Train) -> PresentationText {
        .key(
            Keys.endpoints,
            ["from": .string(train.origin), "to": .string(train.destination)],
            fallback: "{from} → {to}")
    }

    private static func progressText(completed: Int?, total: Int?) -> PresentationText? {
        // §13.2: quantitative progress only when the total is actually known.
        guard let completed, let total, total > 0 else { return nil }
        return .key(
            Keys.progress,
            ["completed": .number(Double(completed)), "total": .number(Double(total))],
            fallback: "{completed} of {total}")
    }

    // MARK: - Keys

    /// Every catalog key this resolver can emit.
    ///
    /// Split by provenance because the two halves have different obligations:
    /// the `existing` half is copy the web app already ships in four languages
    /// and this port already carries, and reusing it keeps one wording for one
    /// concept across both platforms. The `new` half does not exist in
    /// `Resources/Localizable.xcstrings` or `AppLocalization.nativeStrings`
    /// yet — every emission carries an English `fallback`, so the app renders
    /// readable text before Slice 2 adds the translations.
    public enum Keys {

        // Already in Resources/Localizable.xcstrings.
        public static let routeGenerating = "status.routeGenerating"
        public static let routeNoPath = "status.routeNoPath"
        public static let importBusy = "status.importBusy"

        // Already in AppLocalization.nativeStrings.
        public static let browsingTitle = "ios.myRides"
        public static let editingTitle = "ios.editJourney"

        // New — no catalog entry yet.
        public static let endpoints = "ios.journey.endpoints"
        public static let progress = "ios.journey.progress"
        public static let hiddenTitle = "ios.journey.hiddenTitle"
        public static let hiddenDetail = "ios.journey.hiddenDetail"
        public static let stillSaved = "ios.journey.stillSaved"
        public static let playing = "ios.journey.playing"
        public static let playbackPaused = "ios.journey.playbackPaused"
        public static let routePreparing = "ios.journey.routePreparing"
        public static let routeNotReady = "ios.journey.routeNotReady"
        public static let routeBuilding = "ios.journey.routeBuilding"
        public static let routeNeedsReview = "ios.journey.routeNeedsReview"
        public static let routeUnavailable = "ios.journey.routeUnavailable"
        public static let routePartial = "ios.journey.routePartial"
        public static let recordUnchanged = "ios.journey.recordUnchanged"
        public static let routeAffectedSection = "ios.journey.routeAffectedSection"
        public static let loadingTitle = "ios.journey.loadingTitle"
        public static let loadingDetail = "ios.journey.loadingDetail"
        public static let emptyTitle = "ios.journey.emptyTitle"
        public static let emptyDetail = "ios.journey.emptyDetail"
        public static let emptyDateTitle = "ios.journey.emptyDateTitle"
        public static let emptyDateDetail = "ios.journey.emptyDateDetail"
        public static let emptySearchTitle = "ios.journey.emptySearchTitle"
        public static let emptySearchDetail = "ios.journey.emptySearchDetail"
        public static let importingTitle = "ios.journey.importingTitle"
        public static let loadFailedTitle = "ios.journey.loadFailedTitle"
        public static let loadFailedKept = "ios.journey.loadFailedKept"
        public static let importFailedTitle = "ios.journey.importFailedTitle"
        public static let importFailedKept = "ios.journey.importFailedKept"
        public static let saveFailedTitle = "ios.journey.saveFailedTitle"
        public static let saveFailedKept = "ios.journey.saveFailedKept"
        public static let draftInvalidTitle = "ios.journey.draftInvalidTitle"
        public static let draftInvalidKept = "ios.journey.draftInvalidKept"
        public static let draftDirty = "ios.journey.draftDirty"

        /// Keys the shipped catalog already answers.
        public static let existing: Set<String> = [
            routeGenerating, routeNoPath, importBusy, browsingTitle, editingTitle,
        ]
    }
}

// MARK: - Action labels

extension JourneyPresentation.PrimaryAction {
    /// The default button label. Views may override it; having one here keeps
    /// the same action from being spelled two ways on two surfaces.
    public var label: PresentationText {
        switch self {
        case .add: .key("ios.newJourney", fallback: "New journey")
        case .importData: .key("sec.import", fallback: "Import")
        case .locate: .key("btn.fit", fallback: "Locate")
        case .showOnMap: .key("ios.showOnMap", fallback: "Show on map")
        case .rebuildRoute: .key("btn.rebuildRoute", fallback: "Rebuild Route from Stops")
        case .save: .key("ios.save", fallback: "Save")
        case .pause: .key("play.pause", fallback: "Pause")
        case .resume: .key("play.resume", fallback: "Play")
        case .retry: .key("ios.journey.retry", fallback: "Try again")
        case .clearSearch: .key("ios.journey.clearSearch", fallback: "Clear search")
        }
    }
}

extension SecondaryAction {
    public var label: PresentationText {
        switch self {
        case .play: .key("btn.play", fallback: "Play Journey")
        case .stop: .key("play.stop", fallback: "Stop playback")
        case .edit: .key("ios.edit", fallback: "Edit")
        case .duplicate: .key("btn.duplicate", fallback: "Duplicate")
        case .hide: .key("state.hidden", fallback: "Hide from map")
        case .show: .key("state.shown", fallback: "Show on map")
        case .delete: .key("btn.delete", fallback: "Delete")
        case .inspectDetails: .key("ios.journeyInfo", fallback: "Journey information")
        case .rebuildRoute: .key("btn.rebuildRoute", fallback: "Rebuild Route from Stops")
        case .cancel: .key("ios.cancel", fallback: "Cancel")
        case .importData: .key("sec.import", fallback: "Import")
        case .add: .key("ios.newJourney", fallback: "New journey")
        }
    }
}
