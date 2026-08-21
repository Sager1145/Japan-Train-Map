import SwiftUI

/// The map's own controls, stacked down the right edge of the map.
///
/// They sit against the map rather than in the bottom bar or the sidebar
/// because that is what they act on: pressing `+` changes the map, not the
/// app. The bottom bar (iPhone) and the sidebar (iPad) carry what the *app*
/// does — which country is loaded, what is being looked at — and keeping the
/// two apart means neither has to grow to hold the other.
///
/// Right-hand side, and grouped, for the same reason Apple Maps does it: a map
/// is dragged with the thumb, and controls under the thumb's arc get pressed
/// by accident. The grouping is the same reading — pairs that belong together
/// share a capsule, so the eye finds `−` from `+` without re-reading the icons.
///
/// The set matches the web app's controls — network, 定位, zoom in, zoom out,
/// compass — plus the one it has never had: the device's own position. The web
/// app's 定位 frames the *selected railway* and says nothing about where the
/// reader is standing, so the two are separate buttons rather than one button
/// with two meanings.
struct MapControlBar: View {
    @Bindable var controller: RailMapController
    var onFit: () -> Void

    /// The stack is exactly one button wide. Without a width, `Divider()`
    /// claims the maximum the parent offers and drags each capsule out to the
    /// full width of the map.
    private static let width: CGFloat = 44

    var body: some View {
        VStack(spacing: 12) {
            ControlGroup {
                // Rail network on/off. The web app makes the network opt-in
                // rather than permanent, and this is that switch.
                ControlButton(
                    systemImage: "tram.fill",
                    label: Text("Rail network", comment: "Toggles the rail network layer"),
                    isOn: controller.showsNetwork
                ) {
                    controller.showsNetwork.toggle()
                }

                separator

                // 定位 — frame the drawn railway.
                ControlButton(
                    systemImage: "paperplane",
                    label: Text("Frame the railway", comment: "Zooms to fit the drawn network")
                ) {
                    onFit()
                }
            }

            ControlGroup {
                ControlButton(systemImage: "plus", label: Text("Zoom in")) {
                    controller.zoomIn()
                }
                separator
                ControlButton(systemImage: "minus", label: Text("Zoom out")) {
                    controller.zoomOut()
                }
            }

            // The needle points at true north, so it turns against the map's
            // heading. Always shown: hiding it when the map happens to be
            // north-up (as MKCompassButton does) makes the whole stack shift
            // under the reader's thumb.
            ControlGroup {
                ControlButton(
                    systemImage: "location.north.line.fill",
                    label: Text("Face north"),
                    rotation: -controller.headingDegrees
                ) {
                    controller.resetNorth()
                }
            }

            // 目前位置 — the device, not the selection. Bottom of the stack,
            // closest to the thumb, because it is the one pressed most.
            ControlGroup {
                ControlButton(
                    systemImage: controller.isFollowingUser ? "location.fill" : "location",
                    label: Text("Current location"),
                    isOn: controller.isFollowingUser
                ) {
                    controller.toggleFollowUser()
                }
            }
        }
        .frame(width: Self.width)
        // Hugs its content vertically so the ZStack can pin it to the bottom
        // corner instead of centring a full-height column.
        .fixedSize(horizontal: false, vertical: true)
        .overlay(alignment: .leading) {
            if let refusal = controller.locationRefusal {
                Text(refusal)
                    .font(.caption)
                    .multilineTextAlignment(.trailing)
                    .padding(10)
                    .frame(maxWidth: 220)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .fixedSize(horizontal: false, vertical: true)
                    .offset(x: -12)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(.default, value: controller.locationRefusal)
    }
}

/// One capsule of buttons.
///
/// `.regularMaterial` rather than a fixed colour is what makes the stack
/// legible over both a pale city and dark water, and it follows light and dark
/// mode without this file knowing which is in effect.
private struct ControlGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .frame(width: 44)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.15), radius: 3, y: 1)
    }
}

/// A hairline between two buttons in the same capsule, inset so it reads as a
/// separator rather than a cut.
private var separator: some View {
    Divider().frame(width: 28)
}

/// One control.
///
/// 44×44 points is not a design choice — it is the minimum comfortable touch
/// target. The glyph is smaller than the target; the target is never smaller
/// than the glyph.
private struct ControlButton: View {
    var systemImage: String
    var label: Text
    var isOn: Bool = false
    var rotation: Double = 0
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .medium))
                .rotationEffect(.degrees(rotation))
                .frame(width: 44, height: 44)
                .foregroundStyle(isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
        // The needle should turn with the map rather than jump to the new
        // angle; every other button has nothing to animate.
        .animation(.easeOut(duration: 0.2), value: rotation)
    }
}
