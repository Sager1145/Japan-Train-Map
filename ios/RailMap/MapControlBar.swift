import MapKit
import SwiftUI

/// The map's own controls, arranged as a single vertical rail at the right
/// edge — close to the Apple Maps controls and grouped by what each pair
/// changes.
///
/// They sit against the map rather than in the sheet or the sidebar because
/// that is what they act on: toggling the rail network changes the map, not
/// the app. The sheet and the sidebar carry what the *app* does, and keeping
/// the two apart means neither has to grow to hold the other.
///
/// The rail does not scroll, and that is a constraint rather than a
/// description: it must show every control it has at Docked and at Half. Any
/// control added here is measured against the band the medium stop leaves —
/// see the note in `body` for the two pairs that lost that measurement.
///
/// Three details here are not free choices — each is a bug avoided:
///
///   - **Glass goes on the group, once.** Applying it per button and then
///     unioning makes the system raise a single rounded shape enclosing both,
///     and the glyphs escape their own frames.
///   - **Separators are drawn over the glass.** Inside, they are pulled into
///     the material layer and blur away to nothing.
///   - **The compass is `MKCompassButton`.** It already carries the system's
///     glass, so glassing it again double-renders the material; and it belongs
///     *above* the capsules, because it appears and disappears with the map's
///     heading and anything below it would jump as it did.
struct MapControlBar: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Supplied once `RailMapView` has an `MKMapView` — `MKCompassButton`
    /// cannot exist without one, so the caller withholds the whole stack until
    /// then rather than showing a gap where the compass will be.
    var mapView: MKMapView
    @Bindable var controller: RailMapController
    /// §4.1: "定位所选路线" — frames the SELECTION.
    /// §4.1: "适配完整路网" — frames every drawn line, whatever is selected.
    ///
    /// A separate closure, and below a separate button with a separate label,
    /// because they are two different questions. One button that means either
    /// depending on the selection is a button whose accessibility label is
    /// wrong half the time, and a reader who wanted the whole network cannot
    /// ask for it by first deselecting something.
    /// 地圖圖層. A sheet held by the workspace for the same reason 圖例 is —
    /// see `onInfo`.
    var onLayers: () -> Void
    /// 圖例與資料來源. Held by the workspace rather than here because it is a
    /// sheet, and a sheet presented from inside a map overlay is a sheet that
    /// disappears with the overlay.
    var onInfo: () -> Void

    /// One button's side. Apple Maps uses 48 rather than the 44-point minimum:
    /// these are pressed while the other hand holds the phone, and they sit at
    /// the screen edge where the thumb arrives at an angle.
    static let side: CGFloat = 48
    /// Clear drawing space around the rail for Liquid Glass's touch-down
    /// expansion. The scroll container supplies it; the buttons remain 48 pt.
    static let interactionBleed: CGFloat = 8
    /// Between separate glass surfaces. This is also the breathing room that
    /// keeps the two circular utility buttons from visually merging.
    static let groupSpacing: CGFloat = 8

    /// The hairline between two buttons in one capsule. Narrower than the
    /// capsule, so it reads as a division rather than a cut.
    private static let separatorWidth: CGFloat = 28

    var body: some View {
        VStack(alignment: .trailing, spacing: Self.groupSpacing) {
            MapCompassButton(mapView: mapView)
                .fixedSize()
                .frame(maxWidth: .infinity, alignment: .trailing)

            // Map content: what is drawn.
            RailGlassGroup(spacing: Self.groupSpacing) {
                VStack(spacing: 0) {
                    ControlButton(
                        // The fill IS the state, not just its colour: §10.5
                        // and §14.2 both refuse a control whose only on/off
                        // signal is a hue. `location` two groups down already
                        // worked this way; this one drew `tram.fill` in both
                        // states and changed nothing but the tint.
                        systemImage: controller.showsNetwork ? "tram.fill" : "tram",
                        label: Text(localization.text("map.allRailways", fallback: "Rail network")),
                        identifier: "mapNetworkToggle",
                        isOn: controller.showsNetwork
                    ) {
                        controller.showsNetwork.toggle()
                    }
                    // 列車経路, directly under the network toggle, because the
                    // two are the same question asked of the two things this
                    // map draws: the railway that exists, and the journeys the
                    // reader took on it. It was reachable only from inside the
                    // layers sheet, which made hiding your own routes to read
                    // the network underneath a three-tap round trip — and it
                    // is the switch this map is toggled with most.
                    //
                    // Same fill-is-the-state rule as the button above.
                    ControlButton(
                        systemImage: controller.layers.routes
                            ? "point.topleft.down.to.point.bottomright.curvepath.fill"
                            : "point.topleft.down.to.point.bottomright.curvepath",
                        label: Text(localization.countryText(
                            "map.routes", fallback: "Train routes")),
                        identifier: "mapRoutesToggle",
                        isOn: controller.layers.routes
                    ) {
                        controller.layers.routes.toggle()
                    }
                    ControlButton(
                        systemImage: "square.3.layers.3d",
                        label: Text(localization.text("map.layers", fallback: "Map layers")),
                        identifier: "mapLayersButton"
                    ) {
                        onLayers()
                    }
                }
                .railGlass(in: capsule, interactive: true)
            }
            .overlay { capsuleSeparators(count: 3) }

            // Two pairs are deliberately NOT here, and the rail's whole
            // constraint is why: it has to show ALL of itself at Docked and at
            // Half, without a scroll view. Every control kept is measured
            // against the band the medium stop leaves.
            //
            // **定位所选路线 / 適配完整路網.** Both were second entries to
            // actions that already had a home: the journey card's own primary
            // action frames the selected route (`JourneyPresentationBridge`
            // draws it with the same `scope` glyph), and Settings has the
            // network-framing entry beside the note that explains it. §16's
            // mapping rule is that one action does not get two entries.
            //
            // **Zoom (+ / −).** Zoom on a touch map is a pinch, and Apple Maps
            // ships no ± buttons on iPhone for exactly that reason: the gesture
            // is always available, works with one hand, and does not cost the
            // rail two of its slots. `RailMapController.zoomIn()` / `zoomOut()`
            // stay, and stay called — §10.3 asks the keyboard to reach the main
            // map operations, so ⌘+ / ⌘− carry them now (see
            // `ContentView.keyboardShortcuts`). Removing a button is not a
            // reason to remove the only zoom a keyboard reader has.
            //
            // What is left is three controls — 96 pt of capsule, 104 pt of
            // circles and the compass — which fits the medium band with room
            // to spare. That is what let the enclosing `ScrollView` and its
            // top-edge fade go; see `ContentView.controlStackBody`.

            // Utilities remain separate circles because they do not change
            // the same state: one explains the map, one follows the device.
            RailGlassGroup(spacing: Self.groupSpacing) {
                VStack(spacing: Self.groupSpacing) {
                    ControlButton(
                        systemImage: "info.circle",
                        label: Text(
                            localization.countryText(
                                "info.button", fallback: "Legend and sources")),
                        identifier: "mapInfoButton"
                    ) {
                        onInfo()
                    }
                    .railGlass(in: capsule, interactive: true)

                    ControlButton(
                        systemImage: controller.isFollowingUser ? "location.fill" : "location",
                        label: Text(
                            localization.text(
                                "ios.currentLocation", fallback: "Current location")),
                        identifier: "mapLocateToggle",
                        isOn: controller.isFollowingUser
                    ) {
                        controller.toggleFollowUser()
                    }
                    .railGlass(in: capsule, interactive: true)
                }
            }
        }
        .frame(width: Self.side)
        .fixedSize(horizontal: false, vertical: true)
        .overlay(alignment: .leading) { refusal }
        .railAnimation(
            RailMotion.enter, value: controller.locationRefusal,
            reduceMotion: reduceMotion)
        // No `accessibilityIdentifier` on this stack, and its absence is the
        // fix rather than an omission.
        //
        // A container's identifier PROPAGATES to every accessibility element
        // inside it and overwrites their own. This stack carried
        // `"mapControlBar"`, so all five controls reported that identifier and
        // none reported the ones they set — a UI test asking for
        // `mapRoutesToggle` found nothing while the button sat on screen, and
        // a test asking for `mapControlBar` got five matches plus a zero-sized
        // container. `PanelHeader` records the same trap: it moved its
        // identifier onto the title text for exactly this reason.
        //
        // Each control names itself instead (see `ControlButton.identifier`),
        // which is also the more useful thing to assert — a container proves
        // the rail exists, a control proves the rail still has that control.
    }

    private var capsule: some Shape {
        RoundedRectangle(cornerRadius: RailStyle.chromeCornerRadius, style: .continuous)
    }

    /// The hairlines between the controls in one vertical capsule.
    ///
    /// A `VStack` of buttons with `n - 1` spacers between them, laid over the
    /// capsule: the spacers put each rule exactly on a button boundary without
    /// this needing to know the button height, and the whole thing is an
    /// overlay rather than glass content because a hairline drawn INSIDE the
    /// material is pulled into it and blurred away to nothing.
    ///
    /// It used to be a single centred rule, which was correct for exactly two
    /// buttons and silently wrong the moment a third arrived — one rule across
    /// the middle of the capsule, cutting the second button in half.
    private func capsuleSeparators(count: Int) -> some View {
        VStack(spacing: 0) {
            ForEach(0..<max(count, 1), id: \.self) { index in
                if index > 0 {
                    Rectangle()
                        .fill(Color(.separator))
                        .frame(width: Self.separatorWidth, height: 0.5)
                }
                // One flexible band per button. They divide what the hairlines
                // leave equally, which puts every rule on a button boundary
                // without this having to know how tall a button is.
                Color.clear
            }
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private var refusal: some View {
        if let refusal = controller.locationRefusal {
            // Resolved HERE rather than in the controller: the catalog is read
            // at runtime by `AppLocalization`, which is a view-tier
            // environment value. The controller names the state; this names it
            // in the reader's language.
            Text(localization.text(refusal.key, fallback: refusal.fallback))
                .font(.caption)
                .multilineTextAlignment(.trailing)
                .padding(10)
                .frame(maxWidth: 220)
                .railGlass(in: RoundedRectangle(
                    cornerRadius: RailStyle.controlCornerRadius,
                    style: .continuous))
                .fixedSize(horizontal: false, vertical: true)
                .offset(x: -12)
                .transition(
                    RailMotion.anchoredTransition(
                        reduceMotion: reduceMotion, anchor: .trailing))
                .allowsHitTesting(false)
        }
    }
}

/// One control.
///
/// The glyph carries no background of its own — the glass is on the capsule —
/// so the hit area has to be stated, or only the drawn strokes are the target.
private struct ControlButton: View {
    /// §10.5: with this on, an on state that is only a hue is not a state.
    @Environment(\.accessibilityDifferentiateWithoutColor)
    private var differentiateWithoutColor

    var systemImage: String
    var label: Text
    /// A stable name for this control, independent of the reader's language.
    ///
    /// The spoken label is the localised one and must stay that way, which is
    /// exactly why a test cannot use it: the app's catalog is the web app's,
    /// read at runtime, so `app.buttons["Map layers"]` finds nothing whenever
    /// the interface is not in English — and finds it again the moment someone
    /// runs the suite on an English simulator. Identifiers are the same
    /// mechanism `panelHeader` and `journeySearchField` already use.
    var identifier: String
    var isOn: Bool = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                // The control's meaning and 48-point hit target stay stable at
                // every Dynamic Type size. SF Symbols inside map chrome do not
                // represent reading text, so allowing them to grow past their
                // capsule makes the control less usable rather than more.
                .font(.system(size: 20, weight: .medium))
                // §9.1's 状态替换: `location` becoming `location.fill` is one
                // mark replacing another IN PLACE, which is exactly the form
                // §9.4 keeps under Reduce Motion — so it takes the `replace`
                // token directly rather than being degraded to it.
                .contentTransition(.symbolEffect(.replace))
                .animation(RailMotion.replace, value: systemImage)
                .foregroundStyle(isOn ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color.primary))
                .frame(width: MapControlBar.side, height: MapControlBar.side)
                // The selected disc, which is a SHAPE and therefore survives
                // greyscale: a tinted fill ordinarily, and a drawn ring when
                // the reader has asked not to be told things in colour. The
                // symbol carries the state too (see the `tram` call site); this
                // is the half of the signal that works for every control on the
                // rail, including the ones with no fill variant to swap to.
                .background {
                    if isOn {
                        Circle()
                            .fill(
                                Color.accentColor
                                    .opacity(differentiateWithoutColor ? 0 : 0.18))
                            .overlay {
                                if differentiateWithoutColor {
                                    Circle().stroke(Color.primary, lineWidth: 2)
                                }
                            }
                            .padding(5)
                            .allowsHitTesting(false)
                    }
                }
                .contentShape(.rect)
                // SF Symbols carry their own spoken names, which VoiceOver
                // would read in addition to the button's label. Hide the child
                // so the button speaks once.
                .accessibilityHidden(true)
        }
        // §14.3: the press has to read at touch-down. `.plain` leaves that to
        // the label, and glass alone does not say "this one".
        .buttonStyle(RailPressStyle(dims: false))
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

/// MapKit's own compass, rather than a needle of our own.
///
/// It tracks the map's heading without being told, animates itself, fades out
/// when the map is north-up and returns when it is not — all of which a
/// hand-rolled compass has to reimplement and get subtly wrong.
private struct MapCompassButton: UIViewRepresentable {
    let mapView: MKMapView

    func makeUIView(context: Context) -> MKCompassButton {
        let compass = MKCompassButton(mapView: mapView)
        compass.compassVisibility = .adaptive
        return compass
    }

    func updateUIView(_ compass: MKCompassButton, context: Context) {
        compass.mapView = mapView
    }
}
