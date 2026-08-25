import Foundation

// The pull-up panel's physics, as arithmetic rather than as gesture code.
//
// §4.3 gives the panel three semantic stops and §9.3 says which one a release
// lands on: "the stop is chosen from where the flick was GOING, not from where
// the finger happened to leave the glass". That sentence is a formula, and a
// formula that lives inside a `DragGesture.onEnded` closure cannot be tested —
// which matters here because the two platforms have to agree. The web app
// reimplements the same three stops in `app-panel-motion.js`, and the only way
// to know the two agree is for both to be checkable against the same numbers.
//
// So this module owns the arithmetic and nothing else. It does not know what a
// panel looks like, which detents a route offers, or whether the reader is
// dragging with a finger or a trackpad. It is handed positions and a velocity
// and it answers with a stop.

/// The panel's three semantic stops, in the reader's language rather than in
/// pixels (§4.3).
///
/// The names are the ones §4.3 uses — Docked / Half / Full — and they are the
/// names the interface speaks. The older `Compact / Medium / Expanded` spelling
/// survives inside the app's own layout type because it keys measurements, but
/// nothing a reader hears says "Medium" any more.
public enum PanelDetent: Int, CaseIterable, Comparable, Sendable {
    /// Above the tab bar: grabber, what is selected, and one action (§4.3).
    case docked
    /// Roughly half the window. The default.
    case half
    /// The window less a small top margin — still a floating card, never a
    /// full-bleed rectangle (§4.3).
    case full

    public static func < (lhs: PanelDetent, rhs: PanelDetent) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    /// The catalog key naming this stop, for a label or a VoiceOver value.
    ///
    /// A key rather than a word, for the same reason `PresentationText` carries
    /// keys: this target has no catalog, and a `String(localized:)` here would
    /// be English under a Japanese interface.
    ///
    /// These are the SHARED catalog's keys, the ones `i18n-strings.js` spells
    /// and `Localizable.xcstrings` is generated from — not a second set under
    /// an `ios.` prefix. The web panel says 半屏 for this stop; a port that
    /// invented its own translation of the same word would drift from it one
    /// language at a time.
    public var localizationKey: String {
        switch self {
        case .docked: "panel.docked"
        case .half: "panel.half"
        case .full: "panel.full"
        }
    }

    /// English structural fallback. Not the shipped copy — the catalog is.
    public var fallbackName: String {
        switch self {
        case .docked: "Docked"
        case .half: "Half"
        case .full: "Full"
        }
    }

    /// The next stop up, or this one when already at the top.
    public var higher: PanelDetent {
        PanelDetent(rawValue: rawValue + 1) ?? self
    }

    /// The next stop down, or this one when already at the bottom.
    public var lower: PanelDetent {
        PanelDetent(rawValue: rawValue - 1) ?? self
    }

    /// What a tap on the grabber advances to — and it wraps.
    ///
    /// Wrapping rather than stopping at `.full` because a handle that stops
    /// doing anything is a handle the reader taps twice and then gives up on.
    /// The gesture is still the precise control; this is the one-finger,
    /// Switch-Control-reachable version of it.
    public var next: PanelDetent {
        PanelDetent(rawValue: rawValue + 1) ?? .docked
    }
}

/// Where a release is going, and which stop that is.
public enum PanelDetentResolver {

    /// UIScrollView's deceleration rate, and the reason the number is 0.998.
    ///
    /// It is not a tuning constant that happened to feel right: it is the rate
    /// the system's own scroll views decelerate at, so a panel that projects
    /// with it comes to rest where a reader's hand — trained on every other
    /// scroll surface on the device — expects it to.
    public static let decelerationRate: Double = 0.998

    /// Where a flick would come to rest if nothing stopped it.
    ///
    /// The closed form of exponential deceleration: a body released at
    /// `velocity` and decaying by `decelerationRate` per millisecond travels
    /// `v/1000 · d/(1-d)` further. At the default rate that is 499 milliseconds
    /// of the release velocity — which is why a fast flick from just above
    /// Docked can reach Full without the finger ever travelling that far.
    ///
    /// - Parameters:
    ///   - position: where the panel is at the moment of release, in the same
    ///     units its detents are measured in.
    ///   - velocity: units per second, positive in the direction that makes the
    ///     panel larger.
    public static func projectedPosition(
        position: Double,
        velocity: Double,
        decelerationRate: Double = decelerationRate
    ) -> Double {
        // A rate of 1 would never stop, and a rate outside (0, 1) is not a
        // deceleration at all. Refusing to divide by zero here rather than
        // returning an infinity keeps a bad caller from moving the panel to
        // nowhere.
        guard decelerationRate > 0, decelerationRate < 1 else { return position }
        return position + (velocity / 1000) * decelerationRate / (1 - decelerationRate)
    }

    /// The stop nearest a projected position.
    ///
    /// Nearest, not "the next one in the direction of travel": a slow drag that
    /// crosses most of the way to the next stop should land there, and a flick
    /// that would overshoot Full by a screen height should still land on Full
    /// rather than on nothing.
    ///
    /// Detents the caller does not offer are simply absent from `positions`;
    /// a route that cannot be expanded is expressed by leaving `.full` out
    /// rather than by a flag here.
    public static func nearest(
        projectedPosition: Double,
        positions: [PanelDetent: Double]
    ) -> PanelDetent {
        let offered = PanelDetent.allCases.compactMap { detent in
            positions[detent].map { (detent, $0) }
        }
        guard let first = offered.first else { return .half }
        return offered.dropFirst().reduce(first) { best, candidate in
            // `<` rather than `<=` so an exact tie keeps the LOWER detent. A
            // tie is a release exactly halfway between two stops, and settling
            // downwards there leaves more map visible, which is the choice a
            // map-first layout should make when the reader has not expressed
            // one.
            abs(candidate.1 - projectedPosition) < abs(best.1 - projectedPosition)
                ? candidate : best
        }.0
    }

    /// The whole release decision: project, then snap.
    public static func detent(
        releasedAt position: Double,
        velocity: Double,
        positions: [PanelDetent: Double],
        decelerationRate: Double = decelerationRate
    ) -> PanelDetent {
        nearest(
            projectedPosition: projectedPosition(
                position: position, velocity: velocity,
                decelerationRate: decelerationRate),
            positions: positions)
    }

    /// How far past its limit the panel actually moves (§9.3).
    ///
    /// Apple's own rubber band. Two properties matter and neither is
    /// negotiable: the first points of overshoot are almost free, so the
    /// gesture never feels like it snagged; and it asymptotes rather than
    /// clamping, so it never feels like it broke. A hard clamp at the extreme
    /// reads to the hand as the panel having stopped tracking the finger.
    ///
    /// - Parameters:
    ///   - overshoot: how far past the limit the finger has travelled. Negative
    ///     values are treated as no overshoot at all.
    ///   - dimension: the span the resistance is scaled against — the window,
    ///     usually. The overshoot can never exceed it.
    ///   - constant: how quickly resistance builds. Apple's is 0.55, which is
    ///     what a caller scaling against the window should pass. A caller that
    ///     wants a fixed ceiling instead passes that ceiling as `dimension`
    ///     with `constant: 1`, where the curve reduces to `o·L/(o+L)`.
    public static func rubberBand(
        overshoot: Double,
        dimension: Double,
        constant: Double = 0.55
    ) -> Double {
        guard overshoot > 0, dimension > 0, constant > 0 else { return 0 }
        return overshoot * dimension * constant / (dimension + constant * overshoot)
    }
}
