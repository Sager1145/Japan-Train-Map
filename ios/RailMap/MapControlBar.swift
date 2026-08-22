import MapKit
import SwiftUI

/// The map's own controls, stacked down the right edge — Apple Maps' own
/// arrangement, and for its reasons.
///
/// They sit against the map rather than in the sheet or the sidebar because
/// that is what they act on: pressing `+` changes the map, not the app. The
/// sheet and the sidebar carry what the *app* does, and keeping the two apart
/// means neither has to grow to hold the other.
///
/// Three details here are not free choices — each is a bug avoided:
///
///   - **Glass goes on the group, once.** Applying it per button and then
///     unioning makes the system raise a single rounded shape enclosing both,
///     and the glyphs escape their own frames.
///   - **The separator is drawn outside the glass.** Inside, it is pulled into
///     the material layer and blurs away to nothing.
///   - **The compass is `MKCompassButton`.** It already carries the system's
///     glass, so glassing it again double-renders the material; and it belongs
///     *above* the capsules, because it appears and disappears with the map's
///     heading and anything below it would jump as it did.
struct MapControlBar: View {
    @Environment(AppLocalization.self) private var localization
    /// Supplied once `RailMapView` has an `MKMapView` — `MKCompassButton`
    /// cannot exist without one, so the caller withholds the whole stack until
    /// then rather than showing a gap where the compass will be.
    var mapView: MKMapView
    @Bindable var controller: RailMapController
    var onFit: () -> Void

    /// One button's side. Apple Maps uses 48 rather than the 44-point minimum:
    /// these are pressed while the other hand holds the phone, and they sit at
    /// the screen edge where the thumb arrives at an angle.
    static let side: CGFloat = 48
    /// The hairline between two buttons in one capsule. Narrower than the
    /// capsule, so it reads as a division rather than a cut.
    private static let separatorWidth: CGFloat = 28

    var body: some View {
        VStack(spacing: 8) {
            MapCompassButton(mapView: mapView)
                .fixedSize()

            // What is drawn, and where to look at it.
            RailGlassGroup(spacing: 8) {
                VStack(spacing: 0) {
                    ControlButton(
                        systemImage: "tram.fill",
                        label: Text(localization.text("map.allRailways", fallback: "Rail network")),
                        isOn: controller.showsNetwork
                    ) {
                        controller.showsNetwork.toggle()
                    }
                    ControlButton(
                        systemImage: "paperplane",
                        label: Text(localization.text("btn.fit", fallback: "Frame the railway"))
                    ) {
                        onFit()
                    }
                }
                .railGlass(in: capsule, interactive: true)
            }
            .overlay(alignment: .center) { separator }

            RailGlassGroup(spacing: 8) {
                VStack(spacing: 0) {
                    ControlButton(
                        systemImage: "plus",
                        label: Text(localization.text("ios.zoomIn", fallback: "Zoom in"))
                    ) {
                        controller.zoomIn()
                    }
                    ControlButton(
                        systemImage: "minus",
                        label: Text(localization.text("ios.zoomOut", fallback: "Zoom out"))
                    ) {
                        controller.zoomOut()
                    }
                }
                .railGlass(in: capsule, interactive: true)
            }
            .overlay(alignment: .center) { separator }

            // 目前位置 — the device, not the selection. The web app's 定位
            // frames the selected railway and says nothing about where the
            // reader is standing, so the two stay separate buttons rather than
            // one button carrying two meanings.
            RailGlassGroup(spacing: 8) {
                ControlButton(
                    systemImage: controller.isFollowingUser ? "location.fill" : "location",
                    label: Text(localization.text("ios.currentLocation", fallback: "Current location")),
                    isOn: controller.isFollowingUser
                ) {
                    controller.toggleFollowUser()
                }
                .railGlass(in: capsule, interactive: true)
            }
        }
        .frame(width: Self.side)
        .fixedSize(horizontal: false, vertical: true)
        .overlay(alignment: .leading) { refusal }
        .animation(.default, value: controller.locationRefusal)
    }

    private var capsule: some Shape { RoundedRectangle(cornerRadius: 22, style: .continuous) }

    private var separator: some View {
        Rectangle()
            .fill(Color(.separator))
            .frame(width: Self.separatorWidth, height: 0.5)
    }

    @ViewBuilder
    private var refusal: some View {
        if let message = controller.locationRefusal {
            Text(message)
                .font(.caption)
                .multilineTextAlignment(.trailing)
                .padding(10)
                .frame(maxWidth: 220)
                .railGlass(in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .fixedSize(horizontal: false, vertical: true)
                .offset(x: -12)
                .transition(.opacity)
                .allowsHitTesting(false)
        }
    }
}

/// One control.
///
/// The glyph carries no background of its own — the glass is on the capsule —
/// so the hit area has to be stated, or only the drawn strokes are the target.
private struct ControlButton: View {
    var systemImage: String
    var label: Text
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
                .foregroundStyle(isOn ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color.primary))
                .frame(width: MapControlBar.side, height: MapControlBar.side)
                .contentShape(.rect)
                // SF Symbols carry their own spoken names, which VoiceOver
                // would read in addition to the button's label. Hide the child
                // so the button speaks once.
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
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
