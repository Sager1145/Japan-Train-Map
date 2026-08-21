import SwiftUI

/// The bottom bar: which part of the app you are looking at, and how much of
/// it you want on screen.
///
/// It is a panel over the map rather than a screen beside it, because the map
/// is the app — every one of these tabs is about what is drawn, and pushing
/// the map off screen to read about it is the wrong trade. So the panel grows
/// and shrinks instead: the tab row alone when the map matters most, half the
/// screen to read a list, nearly all of it to work.
///
/// Height is published rather than kept private because the map's own controls
/// sit down the right edge and have to stay above it. A control the panel
/// slides over is a control that stops working without ever looking broken.
struct BottomBar<Content: View>: View {
    @Binding var selection: Tab
    @Binding var detent: Detent
    /// The panel's current height, so the caller can keep things clear of it.
    @Binding var height: CGFloat
    @ViewBuilder var content: (Tab) -> Content

    @Environment(\.colorScheme) private var colorScheme
    @GestureState private var drag: CGFloat = 0

    enum Tab: String, CaseIterable, Identifiable {
        case network, layers, info
        var id: String { rawValue }

        var symbol: String {
            switch self {
            case .network: "tram.fill"
            case .layers: "square.3.layers.3d"
            case .info: "chart.bar.doc.horizontal"
            }
        }

        var title: LocalizedStringKey {
            switch self {
            case .network: "Network"
            case .layers: "Layers"
            case .info: "Detail"
            }
        }
    }

    /// Three stops rather than free dragging. A panel that stays wherever it
    /// was let go is a panel that is usually in the wrong place; three stops
    /// can be reached deliberately and returned to exactly.
    enum Detent: CaseIterable {
        /// The tab row only — the map's state.
        case collapsed
        /// Enough to read a list without losing the map.
        case medium
        /// Nearly full height, for working rather than glancing.
        case expanded

        func height(in total: CGFloat) -> CGFloat {
            switch self {
            // Grabber, tab row and the home indicator — the strip that is
            // always visible. Measured against the 44-point row rather than
            // guessed, or the tabs sit half off the bottom of a phone.
            case .collapsed: 92
            case .medium: max(260, total * 0.42)
            case .expanded: max(340, total * 0.85)
            }
        }

        var next: Detent {
            switch self {
            case .collapsed: .medium
            case .medium: .expanded
            case .expanded: .collapsed
            }
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let resting = detent.height(in: geometry.size.height)
            // Clamped so a drag cannot push the panel past its own extremes;
            // rubber-banding past them would suggest a stop that is not there.
            let live = min(
                max(resting - drag, Detent.collapsed.height(in: geometry.size.height)),
                Detent.expanded.height(in: geometry.size.height)
            )

            VStack(spacing: 0) {
                Spacer(minLength: 0)

                VStack(spacing: 0) {
                    grabber

                    if detent != .collapsed {
                        // maxHeight .infinity, not the content's own height:
                        // a Form or List will happily report a height larger
                        // than the panel, and an unbounded child inside a
                        // fixed-height parent grows the parent instead — which
                        // is how the tab row ended up floating mid-screen with
                        // the content spilling out from under the material.
                        content(selection)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        Divider()
                    }

                    // The tab row sits at the bottom edge, which is what makes
                    // it a bottom bar: it stays under the thumb whether the
                    // panel is a strip or nearly the whole screen.
                    tabRow
                        .padding(.bottom, geometry.safeAreaInsets.bottom)
                }
                .frame(height: live, alignment: .top)
                .railGlass(in: PanelShape())
                .clipShape(PanelShape())
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.4 : 0.12), radius: 8, y: -2)
                .contentShape(Rectangle())
                .gesture(dragGesture(in: geometry.size.height))
            }
            .onChange(of: live) { _, value in height = value }
            .onAppear { height = live }
            .animation(.snappy(duration: 0.28), value: detent)
        }
        .ignoresSafeArea(edges: .bottom)
    }

    // MARK: - parts

    private var grabber: some View {
        Capsule()
            .fill(.secondary)
            .frame(width: 36, height: 5)
            .padding(.top, 8)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity)
            // The whole strip is the target, not the 5-point capsule.
            .contentShape(Rectangle())
            .onTapGesture { detent = detent.next }
            .accessibilityLabel(Text("Panel size"))
            .accessibilityHint(Text("Double tap to cycle between collapsed, half and full height"))
    }

    private var tabRow: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases) { tab in
                Button {
                    // Choosing a tab while collapsed means "show me this", so
                    // it opens the panel. Choosing the tab already open means
                    // "I am done with it", so it closes.
                    if selection == tab && detent != .collapsed {
                        detent = .collapsed
                    } else {
                        selection = tab
                        if detent == .collapsed { detent = .medium }
                    }
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: tab.symbol).font(.system(size: 18))
                        Text(tab.title).font(.caption2)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(selection == tab ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == tab ? [.isSelected] : [])
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }

    private func dragGesture(in total: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .updating($drag) { value, state, _ in state = value.translation.height }
            .onEnded { value in
                // Settle on the nearest stop to where the drag ended, with a
                // flick counted as a whole step so a fast gesture does not
                // fall back to where it started.
                let ended = detent.height(in: total) - value.translation.height
                let flick = value.predictedEndTranslation.height - value.translation.height
                let target = ended - flick * 0.4
                detent = Detent.allCases.min {
                    abs($0.height(in: total) - target) < abs($1.height(in: total) - target)
                } ?? detent
            }
    }
}

/// Rounded at the top, square at the bottom — the panel is anchored to the
/// screen edge, and rounding a corner that is off screen only wastes height.
private struct PanelShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path(
            UIBezierPath(
                roundedRect: rect,
                byRoundingCorners: [.topLeft, .topRight],
                cornerRadii: CGSize(width: 18, height: 18)
            ).cgPath
        )
    }
}
