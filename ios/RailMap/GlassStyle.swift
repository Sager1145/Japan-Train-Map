import SwiftUI

/// Liquid Glass where the system has it, a material where it does not.
///
/// `glassEffect(_:in:)` and `GlassEffectContainer` are iOS 26 and later
/// (checked against the iOS 27 SDK's own interface, not remembered). The app
/// deploys to iOS 17, so every use goes through here rather than being spelled
/// out at each call site with its own `#available` — one place to change when
/// the floor moves, and no chance of a control that is glass on one screen and
/// material on the next.
///
/// The fallback is `.regularMaterial`, which is what glass degrades to in
/// spirit: a surface that takes its colour from what is behind it. Over a map
/// that is the whole point, because the same control sits over pale city fill
/// and dark water within one pan.
extension View {

    /// A floating surface — a control capsule, a panel.
    ///
    /// `interactive` is worth passing for anything the finger lands on: it is
    /// what makes glass respond to touch rather than sit there as a texture,
    /// and leaving it off is the difference between a control that feels
    /// pressed and one that merely changes colour.
    @ViewBuilder
    func railGlass(in shape: some Shape, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(
                interactive ? .regular.interactive() : .regular,
                in: shape
            )
        } else {
            self.background(.regularMaterial, in: shape)
        }
    }
}

/// Groups glass surfaces so the system can treat them as one piece of material
/// — which is what lets neighbouring capsules pick up each other's light
/// instead of each rendering its own slab.
///
/// A plain `VStack` on older systems, where there is nothing to coordinate.
struct RailGlassGroup<Content: View>: View {
    var spacing: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}
