import RailPresentation
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

    /// The same stop, in the vocabulary §4.3 gives the reader.
    ///
    /// Two names for three states looks like duplication and is not. This enum
    /// keys *measurements* — `compactChrome`, `mediumHeight`, the detent
    /// dictionary — and its cases are named for what the CONTENT does at each
    /// one. `PanelDetent` is what the interface SAYS, it is shared with the web
    /// app, and it is what the release physics are written against. Renaming
    /// the cases here would have renamed a measurement key to a user-facing
    /// word; keeping two names and one mapping is what makes the boundary
    /// visible.
    var detent: PanelDetent {
        switch self {
        case .compact: .docked
        case .medium: .half
        case .expanded: .full
        }
    }

    init(_ detent: PanelDetent) {
        switch detent {
        case .docked: self = .compact
        case .half: self = .medium
        case .full: self = .expanded
        }
    }

    /// What a tap on the grabber advances to. Wraps, so the control is never
    /// inert — see ``PanelDetent/next``.
    var next: SheetStage { SheetStage(detent.next) }
    var higher: SheetStage { SheetStage(detent.higher) }
    var lower: SheetStage { SheetStage(detent.lower) }
}

extension View {
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
            // A near-imperceptible continuity bridge for a touch-selected
            // journey. Both layers stay mounted, so this opacity transition is
            // interruptible and preserves list scroll state. Keyboard callers
            // suppress it with `RailMotion.withoutAnimation`.
            .animation(RailMotion.reduced, value: isTop)
    }
}

// MARK: - shared card furniture, and what used to sit above it
//
// The hand-drawn panel that lived here is gone: `RideSheetMetrics` (three
// measured stops, `dragging`, the rubber band), `SheetHandle` and
// `railSheetSurface()` were the geometry, gesture and material of a panel this
// app drew itself, and §9.5.6 replaced all three with one resident system
// Sheet — which owns detents, direction, predicted endpoint, velocity handoff,
// boundary resistance and the iOS 26 morph to edge-to-edge (see
// `BottomChrome.swift`). They had no callers left, and leaving them meant the
// question "where is this app's panel physics written" had two answers that
// disagreed; `PanelDetentResolver` still holds the shared arithmetic in
// RailPresentation, where the web app and its tests read it.
//
// `SheetCompactHeightKey` and `compactChromeProbe` went with them: nothing
// read the preference, and `RideCard` was still rendering a hidden second copy
// of its own header on every layout pass to publish it. What they were built
// to do — measure the collapsed stop rather than guess it — is done now by
// `BottomChromeMetrics.compactRow`, from the reader's text size.


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
        .buttonStyle(RailPressStyle())
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
