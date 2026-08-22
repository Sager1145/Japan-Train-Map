import SwiftUI

// MARK: - where the panel is

/// What the ride panel is showing.
///
/// The panel is *one* surface whose content is replaced. It is not a stack of
/// surfaces: opening a journey does not present a second card over the list,
/// it swaps what the single card draws. The list stays mounted underneath —
/// its search text, its scroll offset and its expanded sections are still
/// there when the reader comes back, because the view was never torn down.
///
/// That is the whole reason this is an enum and not a `NavigationPath`. A push
/// would give correct navigation and lose the state; a second `.sheet` would
/// give correct state and stack two translucent surfaces over the map, which
/// is the one thing a map-first layout cannot afford.
enum RideRoute: Equatable {
    case home
    case ride(String)

    /// The route's *kind*, which is what detents and measurements are keyed
    /// by. Two different journeys are two `.ride` routes but one card: the
    /// reader who left the card half-open expects it half-open for the next
    /// journey too, not reset because the identifier changed.
    enum Kind: Hashable {
        case home
        case ride
    }

    var kind: Kind {
        switch self {
        case .home: .home
        case .ride: .ride
        }
    }

    var rideID: String? {
        if case .ride(let id) = self { return id }
        return nil
    }

    var isHome: Bool { self == .home }
}

/// How much of the panel is showing.
///
/// Named rather than measured, because the content is written against these
/// three states: at `.compact` a card shows only enough to say what it is, at
/// `.medium` it shows its body, at `.expanded` it takes the window. Content
/// that branches on a raw height ends up with a different answer on every
/// device; content that branches on a stage does not.
enum SheetStage: Int, CaseIterable, Comparable {
    case compact
    case medium
    case expanded

    static func < (lhs: SheetStage, rhs: SheetStage) -> Bool { lhs.rawValue < rhs.rawValue }
}

// MARK: - the detents

/// Every height the panel is allowed to rest at, for the window it is in.
///
/// Three of the four numbers are fractions of the window, and one is measured.
/// The measured one is `.compact`: it has to clear the card's own top row, and
/// that row is a different height in English than in Japanese, different again
/// at an accessibility Dynamic Type size, and different on a phone with no home
/// indicator. A constant that looks right on one of those clips the text on
/// the others, so the cards report what they actually need and this reads it
/// back — see ``View/compactChromeProbe(_:probe:)``.
///
/// The fractions are of the *window*, not of a system large detent. SwiftUI's
/// `.fraction()` measures against the space a sheet is allowed, which is not
/// the same quantity and drifts between devices; a design that says "a bit more
/// than half the screen" wants half the screen.
struct RideSheetMetrics: Equatable {
    /// The space the panel and the map share — inside the tab bar, which the
    /// panel must never cover.
    var containerHeight: CGFloat
    var safeAreaTop: CGFloat
    var safeAreaBottom: CGFloat
    /// Height of the card's top row at `.compact`, measured from the card.
    var compactChrome: CGFloat
    var isAccessibilitySize: Bool

    /// The grab strip above every card's content.
    static let handleHeight: CGFloat = 28
    /// Below this the panel reads as a bar rather than a card, and the map
    /// gains nothing for the loss.
    static let minimumCompact: CGFloat = 96

    func height(of stage: SheetStage, for route: RideRoute) -> CGFloat {
        switch stage {
        case .compact: compactHeight(for: route)
        case .medium: mediumHeight(for: route)
        case .expanded: expandedHeight
        }
    }

    func stages(for route: RideRoute) -> [SheetStage] {
        // Every route keeps all three. A journey's stop list is as long as the
        // journey, so unlike a single place card there is always something for
        // `.expanded` to show.
        _ = route
        return SheetStage.allCases
    }

    /// The stage a given height is nearest to — what the panel snaps to when
    /// the finger lifts, and what the cards morph towards while it is still
    /// down.
    func stage(nearest height: CGFloat, for route: RideRoute) -> SheetStage {
        stages(for: route).min {
            abs(self.height(of: $0, for: route) - height)
                < abs(self.height(of: $1, for: route) - height)
        } ?? .medium
    }

    /// Height while the finger is down: free between the extremes, and
    /// resisted beyond them rather than stopped dead.
    func dragging(from height: CGFloat, translation: CGFloat, for route: RideRoute) -> CGFloat {
        // Dragging *down* is a positive translation and a shorter panel.
        let raw = height - translation
        let low = self.height(of: .compact, for: route)
        let high = self.height(of: .expanded, for: route)
        if raw < low { return low - Self.resistance(low - raw) }
        if raw > high { return high + Self.resistance(raw - high) }
        return raw
    }

    /// iOS' own rubber band: the first few points of overshoot are almost
    /// free, and it asymptotes rather than clamping. A hard clamp reads as the
    /// gesture having broken.
    private static func resistance(_ overshoot: CGFloat) -> CGFloat {
        let limit: CGFloat = 110
        return limit * (1 - 1 / (overshoot / limit + 1))
    }

    private func compactHeight(for route: RideRoute) -> CGFloat {
        let wanted = Self.handleHeight + compactChrome + safeAreaBottom
        // Never so tall that compact and medium are the same gesture.
        return min(max(wanted, Self.minimumCompact), mediumHeight(for: route) * 0.85)
    }

    private func mediumHeight(for route: RideRoute) -> CGFloat {
        // At an accessibility text size the same content needs more room, so
        // medium grows rather than the reader having to expand every time.
        if isAccessibilitySize { return containerHeight * 0.76 }
        return switch route.kind {
        case .home: containerHeight * 0.58
        case .ride: containerHeight * 0.55
        }
    }

    /// Not the full window: the card stops below the status bar so the map is
    /// still legibly *there*, which is what keeps the layout map-first.
    private var expandedHeight: CGFloat {
        containerHeight - max(safeAreaTop, 12)
    }
}

// MARK: - the cards report their own compact height

/// Compact heights, one per card kind, merged as the cards report them.
struct SheetCompactHeightKey: PreferenceKey {
    static let defaultValue: [RideRoute.Kind: CGFloat] = [:]

    static func reduce(
        value: inout [RideRoute.Kind: CGFloat],
        nextValue: () -> [RideRoute.Kind: CGFloat]
    ) {
        value.merge(nextValue()) { max($0, $1) }
    }
}

extension View {
    /// Measures a hidden copy of this card's compact top row and publishes its
    /// height.
    ///
    /// A copy, not the live row, because the row *morphs*: at `.expanded` the
    /// journey header is two lines and a button row, and measuring that would
    /// give a compact detent tall enough to hide the map. The probe is always
    /// drawn in its compact form and never drawn at all, so the number is the
    /// one the panel needs and is right the frame it is needed.
    func compactChromeProbe<Probe: View>(
        _ kind: RideRoute.Kind,
        @ViewBuilder probe: () -> Probe
    ) -> some View {
        background(alignment: .top) {
            probe()
                .hidden()
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: SheetCompactHeightKey.self,
                            value: [kind: proxy.size.height]
                        )
                    }
                }
                .accessibilityHidden(true)
                .allowsHitTesting(false)
        }
    }

    /// Keeps a covered card mounted while taking it out of the reader's way.
    ///
    /// Deliberately *not* `frame(maxHeight: 0)`, which is how this is usually
    /// written: the panel states its own height, so nothing here contributes
    /// to layout anyway, and proposing zero height to a covered `ScrollView`
    /// is what loses its offset. Hidden, inert, unspoken — and unchanged.
    func residentLayer(isTop: Bool) -> some View {
        self
            .opacity(isTop ? 1 : 0)
            .allowsHitTesting(isTop)
            .accessibilityHidden(!isTop)
    }
}

// MARK: - the surface

extension View {
    /// The card itself: a material that takes its colour from the map behind
    /// it, a tint that keeps it the app's own surface rather than a grey pane,
    /// and a hairline so its top edge survives over pale city fill.
    ///
    /// Not `railGlass`. Glass is for controls floating *on* the map; this is
    /// the surface the map is read against, and at 60% of the window a live
    /// glass refraction of a moving map is both expensive and unreadable.
    func railSheetSurface() -> some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: 24, bottomLeadingRadius: 0,
            bottomTrailingRadius: 0, topTrailingRadius: 24,
            style: .continuous
        )
        return background {
            shape
                .fill(.regularMaterial)
                .overlay { shape.fill(Color.accentColor.opacity(0.05)) }
                .overlay(alignment: .top) {
                    shape.stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
                }
                .compositingGroup()
                .shadow(color: .black.opacity(0.16), radius: 18, y: -4)
                .ignoresSafeArea(edges: .bottom)
        }
        .clipShape(shape)
    }
}

/// The grab strip, and the only part of the card that is *only* a gesture.
///
/// It is a button as well as a drag target because a resize handle that can
/// only be dragged is unreachable by Switch Control and Voice Control, and
/// because tapping a handle to toggle open is a thing readers try.
struct SheetHandle: View {
    var stage: SheetStage
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Capsule()
                .fill(.tertiary)
                .frame(width: 36, height: 5)
                .frame(maxWidth: .infinity, minHeight: RideSheetMetrics.handleHeight)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityValue(Text(stage.accessibilityName))
    }
}

extension SheetStage {
    var accessibilityName: String {
        switch self {
        case .compact: String(localized: "Compact")
        case .medium: String(localized: "Medium")
        case .expanded: String(localized: "Expanded")
        }
    }
}

// MARK: - shared card furniture

/// A round icon button in a card's top row.
///
/// Drawn at 34 points and hit at 44. They are two different numbers on
/// purpose: 34 is what the row looks right with next to a title, 44 is the
/// smallest thing a thumb reliably lands on. Drawing the button at 44 to make
/// the target big makes the header look like a toolbar; shrinking the target
/// to 34 to make the header look right makes it miss.
struct SheetIconButton<Label: View>: View {
    var accessibilityLabel: Text
    var action: () -> Void
    @ViewBuilder var label: Label

    static var visualSide: CGFloat { 34 }

    var body: some View {
        Button(action: action) {
            label
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.primary)
                .frame(width: Self.visualSide, height: Self.visualSide)
                .background(.quaternary.opacity(0.5), in: Circle())
                .overlay { Circle().stroke(Color.primary.opacity(0.06), lineWidth: 0.5) }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

extension SheetIconButton where Label == Image {
    init(systemImage: String, accessibilityLabel: Text, action: @escaping () -> Void) {
        self.init(accessibilityLabel: accessibilityLabel, action: action) {
            Image(systemName: systemImage)
        }
    }
}

/// The same shape as ``SheetIconButton`` for things that open a menu, which
/// cannot be expressed as a `Button`'s action.
struct SheetIconLabel: View {
    var systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.primary)
            .frame(width: SheetIconButton<Image>.visualSide, height: SheetIconButton<Image>.visualSide)
            .background(.quaternary.opacity(0.5), in: Circle())
            .overlay { Circle().stroke(Color.primary.opacity(0.06), lineWidth: 0.5) }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
    }
}
