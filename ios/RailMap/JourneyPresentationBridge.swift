import Foundation
import RailCore
import RailPresentation
import SwiftUI

/// The seam between the app's observable stores and `RailPresentation`.
///
/// `JourneyPresentationResolver` is a value function over value inputs: it
/// cannot see `RiddenRouteStore`, `ItineraryStore` or `PlaybackController`,
/// which are `@MainActor @Observable` app objects. This file is the only place
/// that flattens them, so that the priority order of §11.2 — failure, editing,
/// hidden, playback, route, normal — is decided once, in the tested module,
/// and every view renders the answer instead of re-deriving it from a local
/// `if`. §11.2 names scattered re-derivation as the thing to avoid, and the
/// only way to keep that promise is to have exactly one caller.
enum JourneyBridge {

    // MARK: - route state

    /// §5.5's route state for one journey.
    ///
    /// ## One answer, not a second one
    ///
    /// `RiddenRouteStore.RouteOutcome` already decided this per journey, from
    /// the sections that actually came back with geometry, and `RideStatusCenter`
    /// is the projection of that decision the whole app reads — the journey
    /// detail and the editor read it too. So this asks that, rather than
    /// re-deriving the state from `riddenRoutes.rides`: two derivations of "did
    /// this route draw" is the duplication §11.2 exists to prevent, and the
    /// centre knows two things a scan of the ride array cannot — a *single*
    /// journey being re-solved right now (§8.4), and a journey that asked for
    /// nothing at all.
    ///
    /// It is also why `JourneyRouteState.resolve(loadPhase:drawnSegmentCount:…)`
    /// is not used: that helper compares *drawn segments* against *expected
    /// sections*, two quantities that disagree the moment one section draws as
    /// several strokes. Its own documentation says `needsReview` was not
    /// derivable at Slice 1 and that a later slice would own the real count.
    /// This is that count.
    ///
    /// ## Where the line between `needsReview` and `unavailable` falls
    ///
    ///   `.resolved`     → `.resolved`
    ///   `.needsReview`  → `.needsReview`, reason NAMES the stretches that have
    ///                     no railway under them (§8.4 "失败时明确受影响区间")
    ///   `.unavailable`  → `.unavailable` with no reason, so the Hero keeps the
    ///                     journey's own endpoints as its subtitle and the
    ///                     §13.3 explanation comes from `status.routeNoPath`
    ///   `.noRoute`      → `.unavailable`, but the reason says nothing failed:
    ///                     no adjacent pair of stops is marked as ridden yet,
    ///                     so there was nothing to solve
    ///   `.unknown` / `.resolving` pass straight through
    ///
    /// Nothing in any branch draws a straight line or drops a record (§1.1):
    /// every one of these keeps the journey in the list with its stops intact,
    /// and says which stretch is missing.
    @MainActor
    static func routeState(
        for trainID: String,
        localization: AppLocalization
    ) -> JourneyRouteState {
        let status = RideStatusCenter.shared.status(forTrainID: trainID)
        return status.journeyRouteState(reason: reason(for: status, localization))
    }

    @MainActor
    private static func reason(
        for status: RideRouteStatus, _ localization: AppLocalization
    ) -> String {
        switch status {
        case .needsReview(_, _, let gaps):
            return gapReason(gaps, localization)
        case .noRoute:
            return localization.journeyText(
                "ios.journey.noRiddenSection",
                fallback: "No stretch of this journey is marked as ridden yet.")
        case .unknown, .resolving, .resolved, .unavailable:
            return ""
        }
    }

    /// The gaps, as a sentence naming the stretch the reader wrote.
    ///
    /// §5.5 asks for "原因和受影响区间上移" and §13.3 for copy that says what was
    /// affected — so this is the affected *interval*, by its own endpoints, not
    /// a section index the reader has never seen. Already localised, because
    /// `JourneyRouteState.needsReview(reason:)` is a record value the resolver
    /// passes through untranslated.
    @MainActor
    private static func gapReason(
        _ gaps: [RiddenRouteStore.SectionGap], _ localization: AppLocalization
    ) -> String {
        guard let first = gaps.first else { return "" }
        let head = localization.journeyText(
            "ios.journey.endpoints",
            ["from": .string(first.from ?? "?"), "to": .string(first.to ?? "?")],
            fallback: "{from} → {to}")
        guard gaps.count > 1 else { return head }
        return localization.journeyText(
            "ios.journey.gapMore",
            ["section": .string(head), "count": .number(Double(gaps.count - 1))],
            fallback: "{section} and {count} more sections")
    }
}

// MARK: - how an action is drawn

/// The glyph and the label for one resolved action.
///
/// The resolver ships a default `label` for every action and documents it as
/// something "views may override". Three of its defaults are wrong for a
/// button on this platform and are overridden here — each with the reason:
///
///   `.hide` / `.show`   the web catalog's `state.hidden` / `state.shown` are
///                       the STATE words ("已隱藏", "表示中"), not the verbs.
///   `.importData`       `sec.import` is a section heading, "JSON 匯入／本地資料".
///   `.locate`           `btn.fit` is bare "定位", and §4.1 requires locating the
///                       route and locating the reader to read differently.
struct JourneyActionAppearance {
    var label: String
    var systemImage: String
    var isDestructive: Bool = false
}

extension JourneyPresentation.PrimaryAction {
    @MainActor
    func appearance(_ localization: AppLocalization) -> JourneyActionAppearance {
        switch self {
        case .add:
            .init(label: localization.text("ios.newJourney", fallback: "New journey"),
                  systemImage: "plus")
        case .importData:
            .init(label: localization.journeyText("ios.journey.importJSON", fallback: "Import JSON"),
                  systemImage: "square.and.arrow.down")
        case .locate:
            .init(label: localization.journeyText("ios.journey.locateRoute", fallback: "Locate route"),
                  systemImage: "scope")
        case .showOnMap:
            .init(label: localization.text("ios.showOnMap", fallback: "Show on map"),
                  systemImage: "eye")
        case .rebuildRoute:
            .init(label: localization.journeyText(label), systemImage: "arrow.triangle.2.circlepath")
        case .save:
            .init(label: localization.journeyText(label), systemImage: "checkmark")
        case .pause:
            .init(label: localization.journeyText(label), systemImage: "pause.fill")
        case .resume:
            .init(label: localization.journeyText(label), systemImage: "play.fill")
        case .retry:
            .init(label: localization.journeyText(label), systemImage: "arrow.clockwise")
        case .clearSearch:
            .init(label: localization.journeyText(label), systemImage: "xmark.circle")
        }
    }
}

extension SecondaryAction {
    @MainActor
    func appearance(_ localization: AppLocalization) -> JourneyActionAppearance {
        switch self {
        case .play:
            .init(label: localization.journeyText(label), systemImage: "play.fill")
        case .stop:
            .init(label: localization.journeyText(label), systemImage: "stop.fill")
        case .edit:
            .init(label: localization.journeyText(label), systemImage: "pencil")
        case .duplicate:
            .init(label: localization.journeyText(label), systemImage: "plus.square.on.square")
        case .hide:
            .init(label: localization.journeyText("ios.journey.hideFromMap", fallback: "Hide from map"),
                  systemImage: "eye.slash")
        case .show:
            .init(label: localization.text("ios.showOnMap", fallback: "Show on map"),
                  systemImage: "eye")
        case .delete:
            .init(label: localization.journeyText(label), systemImage: "trash", isDestructive: true)
        case .inspectDetails:
            .init(label: localization.journeyText(label), systemImage: "info.circle")
        case .rebuildRoute:
            .init(label: localization.journeyText(label), systemImage: "arrow.triangle.2.circlepath")
        case .cancel:
            .init(label: localization.journeyText(label), systemImage: "xmark")
        case .importData:
            .init(label: localization.journeyText("ios.journey.importJSON", fallback: "Import JSON"),
                  systemImage: "square.and.arrow.down")
        case .add:
            .init(label: localization.text("ios.newJourney", fallback: "New journey"),
                  systemImage: "plus")
        }
    }

    /// §7.6: the quiet group shows the frequent verbs and sends the rest to
    /// More. Destructive is never one of the visible ones — "destructive 操作
    /// 永远不与主操作并排做成同样权重".
    var showsInQuietRow: Bool {
        switch self {
        case .play, .stop, .edit, .cancel, .rebuildRoute, .importData, .add: true
        case .inspectDetails, .duplicate, .hide, .show, .delete: false
        }
    }
}

// MARK: - status tone

extension StatusPresentation.Tone {
    /// §3.1: colour is the SECOND encoding. Every badge that uses one of these
    /// also carries `StatusPresentation.title`, which is not optional.
    var color: Color {
        switch self {
        case .neutral: .secondary
        case .positive: .green
        case .caution: .orange
        case .critical: .red
        }
    }

    /// §7.5: "背景使用语义色 10–14% 强度".
    var fillOpacity: Double {
        switch self {
        case .neutral: 0.10
        case .positive, .caution, .critical: 0.13
        }
    }

    var systemImage: String {
        switch self {
        case .neutral: "info.circle"
        case .positive: "checkmark.circle"
        case .caution: "exclamationmark.triangle"
        case .critical: "exclamationmark.octagon"
        }
    }
}
