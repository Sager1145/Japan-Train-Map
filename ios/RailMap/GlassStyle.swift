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
    ///
    /// Two accessibility settings are answered here rather than at the call
    /// sites, for the same reason the availability check is (§10.5):
    ///
    ///   - **Reduce Transparency** replaces the material with an opaque
    ///     surface. Glass over a map is a legibility bet — the control takes
    ///     its colour from whatever the reader has panned under it — and this
    ///     is the setting that says not to take it.
    ///   - **Increase Contrast** adds a hairline border, because a surface
    ///     that is defined only by its blur has no edge to find.
    func railGlass(in shape: some Shape, interactive: Bool = false) -> some View {
        modifier(RailGlassSurface(shape: AnyShape(shape), interactive: interactive))
    }
}

private struct RailGlassSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    var shape: AnyShape
    var interactive: Bool

    func body(content: Content) -> some View {
        surface(content)
            .overlay {
                if contrast == .increased {
                    shape.stroke(Color.primary.opacity(0.55), lineWidth: 1)
                }
            }
    }

    @ViewBuilder
    private func surface(_ content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(.secondarySystemBackground), in: shape)
        } else if #available(iOS 26.0, *) {
            content.glassEffect(
                interactive ? .regular.interactive() : .regular,
                in: shape
            )
        } else {
            content.background(.regularMaterial, in: shape)
        }
    }
}

// MARK: - the sheet's own colours

extension Color {
    /// The resident menu's surface, exactly as §4.3 specifies it.
    ///
    /// §4.3: "三档菜单内容区统一使用同一个实体 iOS 系统色，并固定按 base
    /// interface level 解析：亮色为 `systemBackground` 白色，暗色为
    /// `secondarySystemBackground`（约 `#1C1C1E`）灰色".
    ///
    /// Two things in that sentence, and the second is the one that used to be
    /// missing. The COLOUR differs by scheme — it is not one semantic name in
    /// both — and the LEVEL is pinned, because a presented sheet already
    /// carries an elevated trait and a semantic colour handed to it gets
    /// resolved against that level, which is how dark mode came out a step
    /// lighter than the system's own menus (`#2C2C2E` instead of `#1C1C1E`).
    ///
    /// This used to be written as literal RGB for that reason, which solved
    /// the level by discarding the semantics along with it: no Increase
    /// Contrast, no future system palette revision, no accessibility variant.
    /// Overriding the trait keeps both — the level is decided outright here, so
    /// it cannot be applied twice however the surface is nested.
    /// ``railElevated`` is the same technique aimed the other way.
    ///
    /// Resolved values are unchanged from the RGB it replaces: `#FFFFFF` and
    /// `#1C1C1E`.
    private static var menuSurface: Color {
        Color(
            UIColor { traits in
                let semantic: UIColor = traits.userInterfaceStyle == .dark
                    ? .secondarySystemBackground
                    : .systemBackground
                return semantic.resolvedColor(
                    with: traits.modifyingTraits { $0.userInterfaceLevel = .base })
            })
    }

    /// The resident menu's surface.
    ///
    /// No longer takes a `ColorScheme`: a `UIColor` built from a trait closure
    /// answers the live trait collection itself, which is what it was being
    /// handed the environment's colour scheme to imitate.
    static var railMenuBackground: Color { menuSurface }

    /// The same colour, for the `ShapeStyle` overload of
    /// `presentationBackground`. That overload replaces the partial sheet's
    /// default Liquid Glass surface; the custom-View overload remains part of
    /// the presentation's glass composition on iOS 26.
    static var railMenuPresentationStyle: Color { menuSurface }

    /// Resolves a semantic colour at the elevated interface level.
    ///
    /// Content cards use this helper to remain visually distinct from the
    /// menu surface. It is intentionally not used by ``RailSheetBackground``.
    static func railElevated(_ semantic: UIColor) -> Color {
        Color(
            UIColor { traits in
                semantic.resolvedColor(
                    with: traits.modifyingTraits {
                        $0.userInterfaceLevel = .elevated
                    })
            })
    }
}

/// The resident sheet's own surface: one solid colour at every stop.
///
/// Glass here was solving a problem the sheet does not have. The panel is
/// where the reader READS — a list of journeys, a column of statistics — and a
/// surface that takes its colour from whatever the map happens to be showing
/// gives that text a different background in every part of the country. The
/// map is already the spatial context (§4.2); the panel over it does not have
/// to prove it by being see-through.
///
/// So the sheet uses one opaque semantic menu colour and nothing else, at
/// every stop. Two things follow from that, and both are the point rather than
/// a side effect:
///
///   - There is no material transition left to get wrong. This used to fade an
///     opaque backdrop in behind the glass across the last stretch of the drag,
///     because switching it on at `.large` made the surface visibly jump. A
///     surface that is the same at every height cannot jump, so that ramp — and
///     the live-height reading that drove it — is gone.
///   - The BOTTOM BAR is untouched and stays Liquid Glass. It is the system's
///     own tab bar, drawn over this, and it now samples the panel and the rows
///     scrolling under it rather than the map. That is the one place in the
///     chrome where the material still earns its keep, because it is the one
///     thing floating over moving content.
struct RailSheetBackground: View {
    var body: some View {
        // Exactly the same opaque semantic colour at compact, half and full.
        // The glass belongs to the system tab bar above this surface, not here.
        Color.railMenuBackground
            .ignoresSafeArea()
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
