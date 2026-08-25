import SwiftUI

/// Every animation in the app, in one place — and what each of them becomes
/// when the reader has asked for less motion.
///
/// Spec §9.2 gives the parameters as ranges rather than as constants, which is
/// an invitation to spell a different number at every call site. These are the
/// values this app picked out of those ranges, once:
///
///     default spring          response 0.36, damping 1.0
///     gesture / sheet spring  response 0.34, damping 0.86
///     press feedback          90 ms, scale 0.975
///     small replacement       180 ms
///     map camera              300–550 ms, distance-aware
///
/// **Damping 1.0 is not a rounding of "springy".** §9.1 forbids a menu or a
/// status badge bouncing to look lively; only something the finger threw
/// carries momentum, which is why the gesture spring is the only one under
/// critical damping.
///
/// ## Reduce Motion
///
/// §9.4 asks for a short cross-fade or an in-place replacement instead of
/// large slides, springs and parallax — while **keeping** press feedback,
/// colour, progress and numeric updates, because those carry meaning rather
/// than decoration. So the swap here is per-kind rather than global:
/// ``RailMotion/animation(_:reduceMotion:)`` degrades every token except
/// ``RailMotion/press``, and the map's camera move stops travelling instead.
enum RailMotion {

    /// The default spring: a state change the reader caused, with no momentum.
    static let spring = Animation.spring(response: 0.36, dampingFraction: 1.0)

    /// A drag or a sheet detent, where the finger's velocity is handed over.
    ///
    /// `interactiveSpring` rather than `spring`: §9.3 asks the release to be
    /// handed the finger's velocity so there is no pause at the moment it
    /// lifts, and that is the difference between the two.
    static let gesture = Animation.interactiveSpring(response: 0.34, dampingFraction: 0.86)

    /// Press feedback. Kept under Reduce Motion — §9.4 names it explicitly.
    static let press = Animation.easeOut(duration: 0.09)
    static let pressedScale: CGFloat = 0.975

    /// What a disabled control draws at.
    ///
    /// One number for both button styles rather than one each: a transport
    /// button and a list row that mean the same thing — "not now" — and say it
    /// at two different strengths are two vocabularies for one state. 0.35 is
    /// where the system's own disabled controls sit.
    static let disabledOpacity: CGFloat = 0.35

    /// One small thing replacing another in place: a badge, a count, a label.
    static let replace = Animation.easeInOut(duration: 0.18)

    /// A small anchored surface arriving or leaving: a callout, tooltip or
    /// compact popover. Unlike ``replace``, entry needs an immediate response,
    /// so it uses ease-out rather than a symmetric morphing curve.
    static let enter = Animation.easeOut(duration: 0.18)

    /// The Reduce Motion stand-in for anything that would otherwise spring or
    /// slide: the same change, cross-faded in place.
    static let reduced = Animation.easeInOut(duration: 0.16)

    /// Any of the above, with the Reduce Motion swap applied. One function
    /// rather than one per token, so the swap is impossible to forget for a
    /// token added later.
    static func animation(_ base: Animation, reduceMotion: Bool) -> Animation {
        // `press` survives deliberately: §9.4 keeps press feedback, colour,
        // progress and numeric updates, and this is the one caller that would
        // otherwise flatten it along with the rest.
        guard reduceMotion, base != press else { return base }
        return reduced
    }

    /// Performs a keyboard-initiated or otherwise high-frequency state change
    /// without allowing a descendant `.animation(_:value:)` to put motion back
    /// into the transaction.
    static func withoutAnimation(_ action: () -> Void) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction, action)
    }

    /// Whether a camera move should be animated at all.
    ///
    /// MapKit's `animated:` flag is the only control it offers over a region
    /// change, so "shorter and gentler" (§9.4) is expressed as "not animated"
    /// — the camera arrives rather than travelling. Distance-awareness (§9.2)
    /// is MapKit's own: it scales the duration by how far the camera moves.
    static func cameraAnimated(reduceMotion: Bool) -> Bool { !reduceMotion }

    /// A panel or bar arriving. Slides from its own edge normally; fades in
    /// place when motion is reduced, because a bar sliding a third of the
    /// screen is exactly what §9.4 asks to remove.
    static func panelTransition(reduceMotion: Bool, edge: Edge = .bottom) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .move(edge: edge).combined(with: .opacity)
    }


    /// A compact surface connected to a trigger beside it. It materializes
    /// from that trigger in ordinary motion and becomes an opacity-only change
    /// when the reader has requested less movement.
    static func anchoredTransition(
        reduceMotion: Bool, anchor: UnitPoint = .trailing
    ) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .scale(scale: 0.97, anchor: anchor).combined(with: .opacity)
    }
}

/// A type size a transaction can actually animate.
///
/// `Font` is not `Animatable`. SwiftUI has nothing to interpolate between
/// `.system(size: 20)` and `.system(size: 34)`, so inside an animated
/// transaction the glyphs take the new size on the first frame while the
/// padding, the reserved heights and the panel itself glide to meet it over
/// the next third of a second. That is what made the bottom sheet's large
/// title arrive before the sheet did every time a drag was released short of a
/// stop (see `ResidentBottomSheetModifier`).
///
/// Carrying the size as `animatableData` makes SwiftUI re-evaluate this
/// modifier once per frame with the interpolated value, so the title travels
/// with everything else — §4.4 and §9.1's "one element moving", rather than
/// two halves of one header on two clocks.
///
/// Nothing changes while the reader's finger is on the sheet: with no
/// animation in the transaction, `animatableData` is set straight through and
/// this is the same single evaluation `.font(.system(size:))` always was.
///
/// The `Animatable` conformance is `nonisolated` because SwiftUI interpolates
/// `animatableData` off the main actor. The stored properties it touches are
/// this struct's own value copies, which is why that is safe to say here and
/// would not be on a type holding anything shared.
struct RailInterpolatedFont: ViewModifier, nonisolated Animatable {
    var size: CGFloat
    var weight: Font.Weight

    nonisolated var animatableData: CGFloat {
        get { size }
        set { size = newValue }
    }

    func body(content: Content) -> some View {
        NSLog("RAILANIM font=%.3f t=%.4f", size, CFAbsoluteTimeGetCurrent())
        return content.font(.system(size: size, weight: weight))
    }
}

extension View {
    /// `animation(_:value:)` with the Reduce Motion swap already applied.
    func railAnimation<V: Equatable>(
        _ animation: Animation, value: V, reduceMotion: Bool
    ) -> some View {
        self.animation(RailMotion.animation(animation, reduceMotion: reduceMotion), value: value)
    }

    /// `.font(.system(size:weight:))`, but interpolated rather than swapped.
    /// See ``RailInterpolatedFont``.
    func railInterpolatedFont(size: CGFloat, weight: Font.Weight) -> some View {
        modifier(RailInterpolatedFont(size: size, weight: weight))
    }
}

/// A button that reacts on touch-down rather than on release.
///
/// §14.3's first line: "按下瞬间有反馈，不等待 click/touch-up". SwiftUI's
/// `.plain` style leaves that to the label, and every place in this app that
/// wanted it was writing its own `scaleEffect`. This is that, once.
/// ## Disabled
///
/// A custom `ButtonStyle` inherits none of the system's disabled appearance —
/// `.disabled(true)` still routes through `makeBody`, so without reading
/// `isEnabled` a dimmed-out transport button drew at full strength AND still
/// shrank under the finger. §14.3 asks for feedback on touch-down; that was
/// feedback saying the opposite of what happened. The playback bar's previous
/// and next buttons are disabled at the ends of a queue, which is exactly when
/// a reader is pressing them.
///
/// `isEnabled` is read in a nested `View` rather than on the style itself:
/// `makeBody` is not a `View` body, so an `@Environment` declared on the style
/// is captured once and never updated.
struct RailPressStyle: ButtonStyle {
    /// Whether the press also dims. Off for anything already carrying glass —
    /// the material has its own highlight and two of them read as a flicker.
    var dims = true

    func makeBody(configuration: Configuration) -> some View {
        PressBody(configuration: configuration, dims: dims)
    }

    // Not named `Body`: that is `ButtonStyle`'s own associated type, and a
    // nested type of that name is read as the witness for it.
    private struct PressBody: View {
        let configuration: Configuration
        let dims: Bool
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let pressed = configuration.isPressed && isEnabled
            configuration.label
                .scaleEffect(pressed ? RailMotion.pressedScale : 1)
                .opacity(
                    isEnabled
                        ? (pressed && dims ? 0.7 : 1)
                        : RailMotion.disabledOpacity)
                .animation(RailMotion.press, value: pressed)
        }
    }
}

/// The same rule as ``RailPressStyle`` for a full-width row, which wants a
/// different SHAPE of feedback.
///
/// ``RailPressStyle`` shrinks its label by 2.5 %, which is right for a 48-point
/// map control and wrong for a card that spans the panel: at that width the
/// scale reads as the row retreating from the finger, and it is not the
/// vocabulary iOS uses anyway — a system list row, an Apple Maps place card and
/// a Flighty flight row all answer a press by DARKENING, not by moving. Things
/// that look like a list row have to behave like one.
///
/// So the press is a fill laid over the row in its own corner radius, and it
/// arrives on the same 90 ms `press` token as everything else.
struct RailRowPressStyle: ButtonStyle {
    /// The row's own corner radius, so the highlight stops where the row does.
    /// Defaults to §6.4's card token, which is what the rows it is used on are
    /// drawn at — a highlight on a different radius shows its corners.
    var cornerRadius: CGFloat = RailStyle.cardCornerRadius

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, cornerRadius: cornerRadius)
    }

    /// See ``RailPressStyle`` for why `isEnabled` is read down here, and why
    /// this is not called `Body`.
    private struct RowBody: View {
        let configuration: Configuration
        let cornerRadius: CGFloat
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let pressed = configuration.isPressed && isEnabled
            configuration.label
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(Color.primary.opacity(pressed ? 0.07 : 0))
                        .allowsHitTesting(false)
                }
                .opacity(isEnabled ? 1 : RailMotion.disabledOpacity)
                .animation(RailMotion.press, value: pressed)
        }
    }
}

// `railSearchFocused` used to live here: a wrapper around iOS 18's
// `searchFocused(_:)`, which was the only way to move focus into a
// `.searchable` field and did nothing at all on the iOS 17 floor this app
// deploys to. It has no callers left. The search destination draws its own
// `TextField` now (see `ContentView.searchField`), and a plain `@FocusState`
// moves focus into that on every version — so ⌘F works at the deployment
// floor for the first time, and there is no availability fork to keep.
