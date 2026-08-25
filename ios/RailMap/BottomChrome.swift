import RailPresentation
import SwiftUI

// =============================================================================
//  The bottom chrome — JRM_FLIGHTY_UI_REFACTOR_SPEC.md §9.5.6
// =============================================================================
//
//  One resident system Sheet carries the whole interface. A system `TabView`
//  lives inside it, so SwiftUI owns the Liquid Glass tab bar, selection lens,
//  Search separation, Dynamic Type and accessibility behavior. The Sheet owns
//  inset margins, corner interpolation, rubber banding, predicted-endpoint
//  snapping and the iOS 26 morph from inset card to edge-to-edge.
//
//      Bottom Sheet
//        ↓ shrink
//      Compact Bottom Bar
//
//  The bar is therefore not hand drawn. At the smallest detent the tab bar is
//  remains visible with a reduced title row; at Medium and Large its selected
//  page grows above it.

/// §2.2 (revised) — three primary destinations and semantic Search.
///
/// Not Journeys / Network / Passport any more. The railway network stopped
/// being a destination when the map became the root layer that all three
/// share: a "network" tab would have been a tab whose whole content is a set
/// of switches for the map already on screen behind it. Its package status and
/// diagnostics moved to Settings, where the rest of the app's plumbing lives.
///
/// What is left are the three questions a journey log actually answers:
/// what is coming, what does it all add up to, and what have I got.
enum PrimaryTab: String, CaseIterable, Identifiable {
    /// What is coming. Dated today or later, soonest first.
    case upcoming
    /// What it adds up to — §5.3's Passport, by its plainer name.
    case stats
    /// Everything on record, by date.
    case all
    /// System Search, also the entry point for adding a journey.
    case search

    var id: String { rawValue }

    /// The short name shown by the system tab bar.
    ///
    /// A tab item and a page heading have different space budgets. Reusing
    /// `nav.allJourneys` and `sec.search` here made the system compress some
    /// languages but not others (for example, 「すべての行程」 versus 「統計」).
    /// These iOS-only labels keep all four languages on the same one-concept,
    /// one-line footing while the panel header continues to use the complete
    /// shared-catalog wording.
    var tabLocalizationKey: String {
        switch self {
        case .upcoming: "ios.tab.upcoming"
        case .stats: "ios.tab.stats"
        case .all: "ios.tab.all"
        case .search: "ios.tab.search"
        }
    }

    var tabFallbackName: String {
        switch self {
        case .upcoming: "Upcoming"
        case .stats: "Stats"
        case .all: "All"
        case .search: "Search"
        }
    }

    var systemImage: String {
        switch self {
        case .upcoming: "calendar"
        case .stats: "chart.bar.xaxis"
        case .all: "tram"
        case .search: "magnifyingglass"
        }
    }
}

// MARK: - how tall each stop is

/// The three detents, for the window the sheet is in.
///
/// Medium is arithmetic, Large is the system detent, and Compact reserves the
/// system tab bar's standard vertical region plus one reduced title row. Full
/// panel content belongs to the two expanded stops; keeping only that short
/// identifying row at the smallest stop makes it read as a collapsed card
/// rather than either a bare bar or clipped content.
///
/// `medium` is a fraction of the SCREEN, not a `PresentationDetent.fraction`.
/// §9.5.5: `.fraction()` measures against the space a sheet is allowed, which
/// is not the same quantity and drifts between devices. A design that says
/// "about half the screen" means half the screen.
struct BottomChromeMetrics: Equatable {
    /// The window's full height, from the root `GeometryReader`.
    var screenHeight: CGFloat

    /// The compact stop's own height at the reader's text size.
    ///
    /// The tab bar's band is a system metric and does not move; the title row
    /// on top of it is TEXT, and at an accessibility size it is more than
    /// twice as tall. A single constant is right at one text size and clips at
    /// the others — which is the whole argument the ride card's own compact
    /// measurement used to make, before the resident sheet replaced it with
    /// `136`. The caller supplies this from a `@ScaledMetric`; see
    /// `RailWorkspaceView.chromeMetrics(in:)`.
    var compactRow: CGFloat = compactFallback

    /// Whether the reader is at one of the five accessibility text sizes.
    ///
    /// It changes the SET of stops rather than the content: see ``detents``.
    var isAccessibilitySize = false

    /// The system tab bar, a reduced title row and their breathing room, at
    /// the standard text sizes. The Sheet adds the device's bottom safe area
    /// to a height detent itself.
    static let compactFallback: CGFloat = 136
    /// How much of ``compactFallback`` is the tab bar's own band — the part
    /// that does not scale with text. The rest is the title row.
    static let compactTabBand: CGFloat = 88
    /// §9.5.2's Medium. The `+ 8` is §9.5.5's: it keeps the stop clear of the
    /// rounding the system applies when a detent lands within a point or two
    /// of another one.
    static let mediumFraction: CGFloat = 0.52
    /// Below this the sheet reads as a bar rather than a card, and the map
    /// gains nothing for the loss.
    static let minimumCompact: CGFloat = 120

    var compact: CGFloat {
        let wanted = max(compactRow, Self.minimumCompact)
        // At an accessibility size there IS no medium stop (see `detents`), so
        // the clamp that keeps the two far enough apart to be different
        // gestures has nothing left to keep apart — and applying it anyway is
        // what would clip the title row it was just measured to fit. The map
        // still gets its share: 60 % of the window is the ceiling.
        guard !isAccessibilitySize else { return min(wanted, screenHeight * 0.6) }
        // Never so tall that compact and medium stop being different gestures.
        return min(wanted, max(Self.minimumCompact, medium * 0.7))
    }

    /// §9.5.2's Medium.
    ///
    /// Still computed at an accessibility size even though it is not a stop
    /// there: the map's controls are lifted by it (`mapLayout`'s `lift`) and
    /// the header's morph is measured against it, and both of those want the
    /// same reference height whether or not the sheet can rest at it.
    var medium: CGFloat {
        max(Self.minimumCompact + 1, screenHeight * Self.mediumFraction + 8)
    }

    var compactDetent: PresentationDetent { .height(compact) }
    var mediumDetent: PresentationDetent { .height(medium) }

    /// `.large` rather than a fourth measured number: §9.5.6 asks Expanded to
    /// be *really* full, and `.large` is the only detent the system morphs to
    /// edge-to-edge — dropping the side margins and the corner radius on the
    /// way, which is exactly §9.5.2's Expanded row and not something a
    /// `.height()` detent does.
    var detents: Set<PresentationDetent> {
        // Two stops at an accessibility text size, not three.
        //
        // This is what replaced the app-wide Dynamic Type ceiling. Clamping
        // the text was the wrong lever: it made every AX-size code path in the
        // app — the stacked `RouteTiming`, the three-line journey name, the
        // measured compact row above — unreachable by the readers they were
        // written for, and §10.1 asks the layout to follow the setting rather
        // than the setting to be discarded.
        //
        // What actually does not fit at those sizes is the MIDDLE stop: a
        // half-height panel holding a 34-point-equivalent title and one row is
        // a panel showing a title and nothing else. So the half goes and the
        // two useful ends stay — collapsed, where the map is the point, and
        // full, where the reading is.
        isAccessibilitySize
            ? [compactDetent, .large]
            : [compactDetent, mediumDetent, .large]
    }

    /// The stops this window actually offers, smallest first.
    var stages: [SheetStage] {
        isAccessibilitySize ? [.compact, .expanded] : [.compact, .medium, .expanded]
    }

    /// Which stop a live height is nearest.
    ///
    /// §9.5.5 point 6: the bound `PresentationDetent` only changes once the
    /// sheet has settled, so content that keys off it changes a beat after the
    /// finger. Reading the real height every frame and picking the nearest stop
    /// is what lets the title, the rows and the map controls start moving while
    /// the drag is still happening.
    func stage(nearest height: CGFloat) -> SheetStage {
        // Only the stops this window offers. At an accessibility size medium
        // is not one of them, and answering with a stage the sheet cannot rest
        // at would put the content into a form the panel never reaches.
        let targets = stages.map { ($0, self.height(of: $0)) }
        return targets.min { abs($0.1 - height) < abs($1.1 - height) }?.0
            ?? stages.first ?? .compact
    }

    /// A stop's height. `.expanded` is the window, which is what `.large`
    /// resolves to once the system has dropped the sheet's side margins.
    func height(of stage: SheetStage) -> CGFloat {
        switch stage {
        case .compact: compact
        case .medium: medium
        case .expanded: screenHeight
        }
    }

    /// The nearest stop this window actually offers to a requested one — so a
    /// reader who asks for Half at an accessibility size gets Full rather than
    /// a detent SwiftUI silently substitutes.
    func available(_ stage: SheetStage) -> SheetStage {
        guard !stages.contains(stage) else { return stage }
        return stages.min {
            abs(height(of: $0) - height(of: stage))
                < abs(height(of: $1) - height(of: stage))
        } ?? .compact
    }

    /// The stop this height IS, if it is resting on one.
    ///
    /// The sheet reports its stops exactly: a `.height(136)` detent measures
    /// 136 and `.large` measures the window. A drag reports whatever the finger
    /// is holding, and lands on one of those three numbers only by accident. So
    /// "this height is a stop's height" is how the panel tells the SYSTEM's
    /// settle — the spring that runs after the finger lifts, and the move an
    /// accessibility action asks for — from the finger itself. Both of those
    /// arrive here as one discontinuous jump rather than as a stream, because
    /// UIKit animates the sheet's frame and lays its content out once, at the
    /// destination; see `ResidentBottomSheetModifier`.
    ///
    /// The tolerance is a rounding allowance and not a window: the system
    /// quantises a detent to the device's point grid, which puts Medium's
    /// 412.57 on screen as 412.67 on a 3× phone.
    func settledStage(at height: CGFloat) -> SheetStage? {
        stages.first { abs(self.height(of: $0) - height) <= 0.5 }
    }

    /// A continuous compact-to-medium value for chrome that must follow the
    /// reader's finger rather than change when the nearest detent changes.
    ///
    /// Medium and Expanded intentionally share `1`: the expanded title is
    /// already established at the half stop, so dragging farther should move
    /// the sheet without making its hierarchy grow a second time.
    func headerExpansionProgress(for height: CGFloat) -> CGFloat {
        let distance = medium - compact
        guard distance > 0 else { return 1 }
        return min(max((height - compact) / distance, 0), 1)
    }
}

// MARK: - measuring

/// The sheet's live height while it is being dragged.
struct SheetLiveHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// The map control rail's drawn height.
///
/// Measured because it is not a constant: `MapControlBar` includes an
/// `MKCompassButton` only while the map has a heading, which is 52 pt of
/// difference, and the rail's contents have changed twice already. The one
/// reader is `RailWorkspaceView.mapLayout`, which needs the rail's TOP edge to
/// know when the constant sheet gap has pushed it into the status bar.
struct RailControlHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - the panel header

/// §9.5.6's "左上大标题，右上功能按钮" at every sheet stop.
///
/// This is one persistent header, not compact and expanded branches. Its
/// progress comes from the sheet's live height, so type, spacing and the
/// subtitle remain attached to the drag instead of teleporting when the
/// nearest-detent calculation crosses its midpoint.
struct PanelHeader<Actions: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @ScaledMetric(relativeTo: .title3) private var compactTitleSize: CGFloat = 20
    @ScaledMetric(relativeTo: .largeTitle) private var expandedTitleSize: CGFloat = 34
    @ScaledMetric(relativeTo: .footnote) private var subtitleLineHeight: CGFloat = 16

    var title: String
    var subtitle: String?
    var stage: SheetStage
    var expansionProgress: CGFloat
    @ViewBuilder var actions: Actions

    private var progress: CGFloat {
        let live = min(max(expansionProgress, 0), 1)
        // Reduce Motion removes the finger-tracking morph. The modifier below
        // turns this named-state replacement into RailMotion's short fade-like
        // in-place transition instead of a spring.
        return reduceMotion ? (stage == .compact ? 0 : 1) : live
    }

    private func interpolated(_ compact: CGFloat, _ expanded: CGFloat) -> CGFloat {
        compact + (expanded - compact) * progress
    }

    /// How many lines the subtitle is allowed, and therefore how much height
    /// the header reserves for it.
    private var subtitleLines: Int { dynamicTypeSize.isAccessibilitySize ? 2 : 1 }

    /// The title's size at the two open stops.
    ///
    /// ``expandedTitleSize`` is a large-title token and it assumes a tall
    /// panel. A landscape phone is 402 points tall, and at an accessibility
    /// text size that token resolves to something near 88 points — a title
    /// that takes a quarter of the window and STILL does not fit its own line,
    /// which is how 「現在の行程」 came out as 「現在の…」.
    ///
    /// In a short window the header therefore uses its compact size at both
    /// stops. This is not the Dynamic Type clamp that was removed from the app
    /// root: ``compactTitleSize`` is itself a `@ScaledMetric`, so it still
    /// follows the reader's setting exactly — it is the choice of a smaller
    /// type STYLE for a smaller container, which is what leaves room for the
    /// content this header introduces.
    private var openTitleSize: CGFloat {
        // Both conditions, not just the short window. A landscape phone at a
        // STANDARD text size has always drawn the large title here and reads
        // correctly doing it; shrinking that too would have been an unasked-for
        // change to a state that was already right. What does not fit is the
        // large-title token multiplied by an accessibility ramp.
        verticalSizeClass == .compact && dynamicTypeSize.isAccessibilitySize
            ? compactTitleSize
            : expandedTitleSize
    }

    /// One line ordinarily, two at an accessibility size.
    ///
    /// §16's first wayfinding question is "where am I", and a name cut down to
    /// 「現在の…」 is not an answer to it. `minimumScaleFactor` alone cannot
    /// help here — it is already allowed to shrink to 60 %, and past that the
    /// only thing left to give is a line.
    private var titleLines: Int {
        // Two lines only where there is room for two. In a short window the
        // title is already drawn at the compact size (see ``openTitleSize``),
        // and at that size `minimumScaleFactor` can fit it on ONE line — which
        // is worth taking, because a second line of a 52-point title costs 65
        // points of a 402-point window and this header is the fixed part of
        // it. SwiftUI prefers wrapping to scaling whenever more than one line
        // is allowed, so the allowance itself is what has to go.
        dynamicTypeSize.isAccessibilitySize && verticalSizeClass != .compact ? 2 : 1
    }

    /// Whether the subtitle is drawn at all.
    ///
    /// It is L2 metadata (§3.1) and it is worth its line almost everywhere.
    /// In one window it is not: a landscape phone at an accessibility text
    /// size has 402 points in total, and two wrapped lines of subtitle take
    /// eighty of them out of the scrolling content below — where
    /// `RouteTimingView` states the same origin, destination and times
    /// properly, as its own row, two rows further down. §6's rule is that
    /// every element earns its place; here the same sentence is already paid
    /// for once.
    private var showsSubtitle: Bool {
        !(dynamicTypeSize.isAccessibilitySize && verticalSizeClass == .compact)
    }

    /// Large accessibility text needs the full panel width for both the title
    /// and the controls. Keeping them in one horizontal row makes SwiftUI
    /// compress the controls' *values* first — exactly the wrong trade for the
    /// statistics date and region menus, whose current scope is their label.
    private var stacksActions: Bool {
        dynamicTypeSize.isAccessibilitySize && verticalSizeClass != .compact
    }

    var body: some View {
        Group {
            if stacksActions {
                VStack(alignment: .leading, spacing: 6) {
                    titleBlock
                    HStack(spacing: 2) {
                        Spacer(minLength: 0)
                        actionStrip
                    }
                }
            } else {
                // Centred on the actions, not sat on their baseline.
                HStack(alignment: .center, spacing: 12) {
                    titleBlock
                    Spacer(minLength: 0)
                    actionStrip
                }
            }
        }
        // Leading and trailing are no longer the same number. The trailing
        // edge is measured to a BUTTON, whose glass capsule already carries
        // its own optical inset; the leading edge is measured to a large-title
        // glyph, which carries none. Setting both to 16 therefore put the
        // title visibly nearer the edge than the buttons were, so the text
        // side gets the wider margin that makes the two read as equal.
        .padding(.leading, interpolated(16, 24))
        .padding(.trailing, 16)
        .padding(.top, interpolated(8, 10))
        .padding(.bottom, interpolated(2, 6))
        // Normal motion is driven directly by the live sheet height and must
        // not lag behind it. Under Reduce Motion the named-state typography
        // change is deliberately immediate: applying a 160 ms curve here would
        // still animate font size, padding, offset and reserved height. Opacity
        // feedback remains scoped to the content that actually cross-fades.
        .transaction { transaction in
            if reduceMotion {
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: interpolated(0, 1)) {
            Text(title)
                // Interpolated rather than swapped between two `Font`s: see
                // ``RailInterpolatedFont``. The size is a function of the live
                // sheet height at every frame of a drag, and of the settle
                // spring `ResidentBottomSheetModifier` puts on the release —
                // and a plain `.font()` can follow the first but not the
                // second.
                .railInterpolatedFont(
                    size: interpolated(compactTitleSize, openTitleSize),
                    weight: .bold)
                // The title is not always the same sentence at both ends. Over
                // a selected journey the Docked row carries the train's number
                // and the open one names the state (see
                // `RailWorkspaceView.panelTitle(for:stage:)`), so the one thing
                // in this header that CANNOT be interpolated is the string. It
                // gets §9.4's short in-place replacement instead of changing
                // between two frames — and scoped to the title's own value, so
                // it never puts a curve on the size the drag is driving.
                .contentTransition(.opacity)
                .animation(
                    RailMotion.animation(RailMotion.replace, reduceMotion: reduceMotion),
                    value: title)
                .lineLimit(titleLines)
                .minimumScaleFactor(interpolated(0.72, 0.6))
                .fixedSize(horizontal: false, vertical: true)
                // Keep one stable, non-interactive header element for
                // VoiceOver and UI automation. Putting this identifier on the
                // outer layout propagates it into the action buttons.
                .accessibilityIdentifier("panelHeader")
                .accessibilityAddTraits(.isHeader)
                .railSheetStageActions()
                .modifier(ReduceMotionUITestProbe(enabled: reduceMotion))
            if showsSubtitle, let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(subtitleLines)
                    .fixedSize(horizontal: false, vertical: true)
                    .opacity(progress)
                    .offset(y: interpolated(-3, 0))
                    .frame(
                        height: progress >= 1
                            ? nil
                            : subtitleLineHeight * CGFloat(subtitleLines) * progress,
                        alignment: .top)
                    .clipped()
                    .accessibilityHidden(progress < 0.5)
            }
        }
    }

    private var actionStrip: some View {
        HStack(spacing: 2) { actions }
            // This ceiling applies to chrome glyphs and compact scope labels,
            // not to the content introduced by the header.
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .fixedSize(horizontal: true, vertical: false)
            // The SET of controls changes at Docked — over a selected journey
            // this row is that journey's controls, and above Docked the card
            // below owns them (see `RailWorkspaceView.panelActions(for:stage:)`).
            // That is a membership change rather than a morph, so it takes the
            // same short replacement the title's wording does; without it two
            // glass capsules appeared and vanished between two frames beside a
            // title that was still growing.
            .animation(
                RailMotion.animation(RailMotion.replace, reduceMotion: reduceMotion),
                value: stage)
    }
}

/// A debug-only observation point for the UI test that is run after the
/// simulator's *system* Reduce Motion setting has been enabled. It never
/// changes application behavior and is absent from release accessibility.
private struct ReduceMotionUITestProbe: ViewModifier {
    var enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        #if DEBUG
        if ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_REPORT_REDUCE_MOTION"] == "1" {
            content.accessibilityValue(Text(enabled ? "enabled" : "disabled"))
        } else {
            content
        }
        #else
        content
        #endif
    }
}

/// Applies only the surface behavior shared by the modern and compatibility
/// TabViews. SwiftUI still owns every pixel of the actual tab bar.
struct SystemSheetTabSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            // Paint the actual TabView surface as well as the presentation
            // container. On iOS 26 the TabView installs its own container
            // surface above `.presentationBackground`; leaving that layer
            // unpainted is what turned the requested #1C1C1E menu into the
            // much lighter system presentation gray. This is an opaque color,
            // not a material. The native tab bar remains a separate glass
            // layer drawn by SwiftUI over it.
            .background { RailSheetBackground() }
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: SheetLiveHeightKey.self, value: proxy.size.height)
                }
            }
    }
}

extension View {
    /// Flighty's bottom row stays present while its card scrolls. On iOS 26+
    /// use the system policy that expresses that directly; older systems keep
    /// their normal persistent tab bar behavior.
    @ViewBuilder
    func railPersistentTabBar() -> some View {
        if #available(iOS 26.0, *) {
            tabBarMinimizeBehavior(.never)
        } else {
            self
        }
    }
}

/// §10.2: how a reader who cannot drag moves the sheet between its stops.
///
/// The Pull Bar is hidden by §9.5.6, and the thing that replaces it —
/// a drag on the header — responds to a DRAG. VoiceOver
/// and Switch Control perform neither, so without this the panel is stuck at
/// whichever stop it opened on for anyone not driving the app by touch, and
/// two of the three stages are simply unreachable.
///
/// A closure in the environment rather than the detent itself: the headers are
/// used by every destination and at every stop, and none of them should have
/// to know what a `PresentationDetent` is in order to offer the action.
/// Boxed rather than passed as a bare closure: an `EnvironmentKey`'s
/// `defaultValue` is a static, so under strict concurrency the value it holds
/// has to be `Sendable`, and a bare `(SheetStage) -> Void` is not.
struct RailSheetStageAction: Sendable {
    var move: @MainActor @Sendable (SheetStage) -> Void
    /// Which stops this window actually offers. At an accessibility text size
    /// there is no half stop (see ``BottomChromeMetrics/detents``), and an
    /// accessibility action named "Half-height panel" that lands somewhere
    /// else is worse than one that is not offered.
    var stages: [SheetStage] = [.compact, .medium, .expanded]

    @MainActor
    func callAsFunction(_ stage: SheetStage) { move(stage) }
}

struct RailSheetStageActionKey: EnvironmentKey {
    static let defaultValue: RailSheetStageAction? = nil
}

extension EnvironmentValues {
    var railSheetStageAction: RailSheetStageAction? {
        get { self[RailSheetStageActionKey.self] }
        set { self[RailSheetStageActionKey.self] = newValue }
    }
}

/// The three stops, as named accessibility actions on whichever header is on
/// screen.
///
/// On the HEADER rather than on the sheet as a whole, which is where an
/// earlier revision put them. A named action belongs to one accessibility
/// element, and making the sheet carry them meant making the sheet an element
/// — `children: .contain` — after which the actions were only offered while
/// that container itself held focus. VoiceOver lands on the panel title, so
/// that is where the actions have to be to be found. They cost no pixels and
/// do not put the grabber back.
private struct SheetStageActions: ViewModifier {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.railSheetStageAction) private var move

    @ViewBuilder
    func body(content: Content) -> some View {
        if let move {
            // Branched rather than filtered, because the actions are announced
            // in the order they are attached and the half stop belongs BETWEEN
            // the other two. `accessibilityAction` takes no availability flag,
            // so an action that does not apply has to be absent rather than
            // disabled — which is the honest form anyway: at an accessibility
            // text size there is no half stop to go to (see
            // ``BottomChromeMetrics/detents``), and an action named
            // "Half-height panel" that lands on Full is a label that lies.
            if move.stages.contains(.medium) {
                content
                    .accessibilityAction(named: expand) { move(.expanded) }
                    .accessibilityAction(named: half) { move(.medium) }
                    .accessibilityAction(named: collapse) { move(.compact) }
            } else {
                content
                    .accessibilityAction(named: expand) { move(.expanded) }
                    .accessibilityAction(named: collapse) { move(.compact) }
            }
        } else {
            content
        }
    }

    private var expand: Text {
        Text(localization.text("ios.sheet.expand", fallback: "Expand panel"))
    }

    private var half: Text {
        Text(localization.text("ios.sheet.half", fallback: "Half-height panel"))
    }

    private var collapse: Text {
        Text(localization.text("ios.sheet.collapse", fallback: "Collapse panel"))
    }
}

extension View {
    /// Offers the resident sheet's three stops from this element. See
    /// ``SheetStageActions``.
    func railSheetStageActions() -> some View {
        modifier(SheetStageActions())
    }
}

private struct ResidentBottomSheetModifier<SheetContent: View>: ViewModifier {
    var metrics: BottomChromeMetrics
    @Binding var detent: PresentationDetent
    @Binding var liveHeight: CGFloat
    @ViewBuilder var sheetContent: () -> SheetContent

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A resident presentation still needs owned lifecycle state.
    ///
    /// A constant `true` binding asks SwiftUI to present again every time the
    /// host is rebuilt. That normally goes unnoticed, but an alert or menu on
    /// top makes the duplicate request observable as "already presenting" and
    /// can briefly give MapKit a zero-sized drawable during recovery. The
    /// sheet cannot be dismissed interactively, so this value changes only at
    /// the two real lifecycle edges below.
    @State private var isPresented = false

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $isPresented, onDismiss: restoreIfNeeded) {
                sheetContent()
                .presentationDetents(metrics.detents, selection: $detent)
                // The menu is a stable reading surface rather than a second
                // glass layer over the map. `RailSheetBackground` resolves to
                // base system white in light appearance and base
                // `secondarySystemBackground` in dark appearance. It is the
                // same opaque colour at every detent. The system TabView above
                // it remains Liquid Glass.
                // Use the ShapeStyle overload. On iOS 26 the custom-View
                // overload participates in the partial sheet's default glass
                // composition; a solid ShapeStyle replaces that surface.
                .presentationBackground(Color.railMenuPresentationStyle)
                // §9.5.6: no Pull Bar.
                //
                // `.scrolls` rather than `.resizes`, which is what decides who
                // gets a drag that starts on the list. Under `.resizes` the
                // sheet took it: at the half stop a flick down the journeys
                // collapsed the panel instead of moving the list, so the only
                // way to read past the first screenful was to expand the sheet
                // first. The content's length has nothing to do with the
                // panel's height, and now neither does the gesture — the list
                // scrolls at every stop, full or half.
                //
                // Resizing keeps a touch route because the header is not a
                // scroll view: a drag that starts on the title still moves the
                // sheet between its stops, the way a place card does. For
                // anyone not driving it by touch, see `SheetStageActions`.
                .presentationDragIndicator(.hidden)
                .presentationContentInteraction(.scrolls)
                // The map underneath stays live at the two stops where it is
                // still visible. §4.2: the map is the app's spatial context,
                // not a picture behind a modal.
                .presentationBackgroundInteraction(
                    .enabled(upThrough: metrics.mediumDetent))
                .interactiveDismissDisabled()
                .environment(
                    \.railSheetStageAction,
                    RailSheetStageAction(
                        move: { stage in
                            switch metrics.available(stage) {
                            case .compact: detent = metrics.compactDetent
                            case .medium: detent = metrics.mediumDetent
                            case .expanded: detent = .large
                            }
                        },
                        stages: metrics.stages))
                .onPreferenceChange(SheetLiveHeightKey.self) { height in
                    settle(reporting: height.rounded())
                }
        }
        .onAppear {
            guard !isPresented else { return }
            isPresented = true
        }
    }

    /// One channel, two kinds of change — and size alone does not tell them
    /// apart.
    ///
    /// While the reader drags, the height arrives as a STREAM: UIKit resizes
    /// the sheet under the finger and lays its content out at every step, so
    /// the panel header, the journey card and the map's rail follow 1:1. None
    /// of that may be animated — a spring on top of a gesture is lag, which is
    /// the opposite of what §9.3 asks for.
    ///
    /// When the finger lifts, it arrives as a single JUMP to the stop the sheet
    /// is springing to. UIKit animates the frame and lays the content out once,
    /// at the destination, so every value keyed off this number is finished
    /// while the panel is still a third of a second from arriving: measured on
    /// an iPhone 17 Pro, a drag released at 276 pt reported 412 pt on the very
    /// next sample. That is the case this animates, and it is what §9.5.6's
    /// "one persistent header" was missing — the title, the subtitle and the
    /// rail now travel WITH the panel instead of landing ahead of it.
    ///
    /// The discriminator is a jump that lands ON a stop. A stop the finger
    /// drags through moves a few points per sample and is left alone; only the
    /// system arrives at one from far away.
    private func settle(reporting height: CGFloat) {
        let travelled = abs(height - liveHeight)
        NSLog("RAILANIM live=%.2f travelled=%.2f t=%.4f", height, travelled, CFAbsoluteTimeGetCurrent())
        guard height > 0, travelled > 0.5 else { return }
        let stop = metrics.settledStage(at: height)
        if stop != nil, travelled > 8 {
            withAnimation(
                RailMotion.animation(RailMotion.gesture, reduceMotion: reduceMotion)
            ) {
                liveHeight = height
            }
        } else {
            liveHeight = height
        }
        guard let stop else { return }
        correctDetent(to: stop, restingAt: height)
    }

    /// Puts the bound detent back on the stop the sheet is actually at.
    ///
    /// `selection` is written by the system only once the sheet has SETTLED,
    /// so for the whole of a drag the binding still names the stop the sheet
    /// left — and the layout pass that the settled height triggers re-applies
    /// that stale value to a presentation controller no longer holding a
    /// gesture, which obeys it. Measured on an iPhone 17 Pro: a drag released
    /// into Full reported 778, then 412 — the stop the binding still
    /// remembered — then 778 again, the three about 50 ms apart. The panel
    /// header collapsed and re-expanded inside that window, and so did every
    /// row under it.
    ///
    /// Corrected a frame late, deliberately. Writing it while the finger is
    /// still down hands UIKit a detent to MOVE to and ends the drag: with the
    /// correction applied immediately, a slow drag out of Docked stopped
    /// following the finger the moment it crossed Half and threw the sheet to
    /// Full instead. Re-reading the height after a frame is what tells a
    /// settled sheet from one still passing through: a moving sheet has
    /// reported another height by then.
    private func correctDetent(to stop: SheetStage, restingAt height: CGFloat) {
        let wanted: PresentationDetent =
            switch stop {
            case .compact: metrics.compactDetent
            case .medium: metrics.mediumDetent
            case .expanded: .large
            }
        guard detent != wanted else { return }
        let height = height
        let liveHeight = _liveHeight
        let detent = _detent
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(20))
            guard liveHeight.wrappedValue == height else { return }
            guard detent.wrappedValue != wanted else { return }
            NSLog("RAILANIM heal to %@ t=%.4f", String(describing: stop), CFAbsoluteTimeGetCurrent())
            RailMotion.withoutAnimation { detent.wrappedValue = wanted }
        }
    }

    private func restoreIfNeeded() {
        // `interactiveDismissDisabled` covers the reader. This is for scene or
        // framework-driven dismissal: wait until UIKit has completed the old
        // controller's dismissal before asking SwiftUI for its replacement.
        Task { @MainActor in
            await Task.yield()
            guard !isPresented else { return }
            isPresented = true
        }
    }
}

extension View {
    /// §9.5.6's resident sheet, in one place.
    ///
    /// The sheet owns a real presentation binding even though the reader can
    /// never dismiss it. This lets SwiftUI distinguish "already on screen"
    /// from "please present now" while another system surface is visible.
    func residentBottomSheet<SheetContent: View>(
        metrics: BottomChromeMetrics,
        detent: Binding<PresentationDetent>,
        liveHeight: Binding<CGFloat>,
        @ViewBuilder sheet: @escaping () -> SheetContent
    ) -> some View {
        modifier(ResidentBottomSheetModifier(
            metrics: metrics,
            detent: detent,
            liveHeight: liveHeight,
            sheetContent: sheet))
    }
}
