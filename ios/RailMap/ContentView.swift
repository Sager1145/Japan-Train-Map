import CoreLocation
import RailCore
import SwiftUI

/// The railway drawn over Apple Maps, in the two shapes iOS asks for.
///
/// The split is by size class rather than by device idiom, which matters on
/// iPad: a window narrowed to a slide-over is compact and wants the phone
/// layout even though `UIDevice` still says iPad. Asking the environment what
/// shape the window *is* gets that right for free, including mid-drag as the
/// reader resizes it.
///
///   tall   the panel is a sheet over the map, dragged between three stops
///   wide   the same tabs live at the foot of a sidebar, always open
///
/// The choice is made on the window's shape, not the device. A phone in
/// landscape has almost no height to spend on a bottom sheet but plenty of
/// width to spare, so it gets the sidebar — the same layout as iPad, for the
/// same reason. A phone in landscape also reports a *compact* horizontal size
/// class on every model but the largest, so size class alone would put a sheet
/// there and leave the map a letterbox.
///
/// The sidebar is a plain `HStack` rather than `NavigationSplitView` because a
/// split view collapses to a stack at compact width — which is exactly the
/// case this exists to serve. Building it directly means one layout behaves
/// the same way on both devices instead of two that nearly do.
///
/// The map's own controls are down the right edge in both, because they act on
/// the map rather than on the app. In the sheet layout they ride above the
/// panel: it publishes its height and they keep clear of it, so a control is
/// never slid under and left looking present but unreachable.
struct ContentView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var store = RailNetworkStore()
    @State private var controller = RailMapController()
    @State private var country = "mo"
    @State private var render: RailMapView.RenderStats?
    @State private var tab = BottomBar<AnyView>.Tab.network
    @State private var detent = BottomBar<AnyView>.Detent.collapsed
    @State private var panelHeight: CGFloat = 96

    var body: some View {
        GeometryReader { geometry in
            // Wider than tall, or a regular-width window: sidebar. Otherwise
            // the sheet. Read from the geometry so a rotation or an iPad
            // window resize switches layouts as it happens.
            if geometry.size.width > geometry.size.height || horizontalSizeClass == .regular {
                sidebarLayout
            } else {
                sheetLayout
            }
        }
        .task(id: country) { store.load(country: country) }
    }

    // MARK: - tall windows: a sheet over the map

    private var sheetLayout: some View {
        ZStack(alignment: .bottomTrailing) {
            map

            MapControlBar(controller: controller) { controller.fitToNetwork() }
                .padding(.trailing, 12)
                // The panel's live height, not its resting height, so the
                // controls travel with the drag rather than jumping when it
                // settles.
                .padding(.bottom, panelHeight + 12)

            BottomBar(selection: $tab, detent: $detent, height: $panelHeight) { tab in
                AnyView(tabContent(tab))
            }
        }
    }

    // MARK: - wide windows: a sidebar, on iPad and on a phone in landscape

    private var sidebarLayout: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                tabContent(tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

                Divider()

                // The sidebar's own bottom bar. Same tabs as the sheet's; no
                // detents, because a sidebar is already the width the reader
                // chose and nothing is covering the map.
                sidebarTabRow
            }
            // Narrower on a phone, where the map has little enough width as it
            // is; a fixed 320 would eat half of a landscape iPhone.
            .frame(width: horizontalSizeClass == .regular ? 320 : 260)
            .background(.regularMaterial)

            Divider()

            ZStack(alignment: .bottomTrailing) {
                map
                MapControlBar(controller: controller) { controller.fitToNetwork() }
                    .padding(12)
            }
        }
        // The sidebar runs to the screen edge; its contents do not, or the
        // notch clips the tab row in landscape.
        .ignoresSafeArea(edges: .bottom)
    }

    private var sidebarTabRow: some View {
        HStack(spacing: 0) {
            ForEach(BottomBar<AnyView>.Tab.allCases) { entry in
                Button {
                    tab = entry
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: entry.symbol).font(.system(size: 18))
                        Text(entry.title).font(.caption2)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(tab == entry ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == entry ? [.isSelected] : [])
            }
        }
        .padding(.vertical, 6)
        .background(.bar)
    }

    // MARK: - tabs

    @ViewBuilder
    private func tabContent(_ tab: BottomBar<AnyView>.Tab) -> some View {
        switch tab {
        case .network:
            List(RailNetworkStore.countries, id: \.code) { entry in
                Button {
                    country = entry.code
                } label: {
                    HStack {
                        Text(entry.label)
                        Spacer()
                        if country == entry.code {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)

        case .layers:
            Form {
                Section {
                    Toggle("Rail network", isOn: $controller.showsNetwork)
                } footer: {
                    Text(
                        "Lines are drawn in each operator's official colour. "
                            + "Where an operator publishes a separate dark-mode colour, "
                            + "it is used automatically."
                    )
                }
            }
            .scrollContentBackground(.hidden)

        case .info:
            List {
                statusRows
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    @ViewBuilder
    private var statusRows: some View {
        switch store.state {
        case .idle:
            Text("Idle")
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Decoding package…")
            }
        case .loaded(let code, let lines, let elapsed):
            LabeledContent("Package", value: "\(code.uppercased()) · \(lines.count) lines")
            LabeledContent(
                "Decoded",
                value: "\(lines.reduce(0) { $0 + $1.intervals.count }) intervals · "
                    + "\(lines.reduce(0) { $0 + $1.vertexCount }) vertices · \(elapsed.milliseconds) ms"
            )
            // What the renderer actually submitted, at this zoom. These are
            // measurements, not estimates — the MKMapView rewrite exists
            // because of the gap between these two rows.
            if let render {
                LabeledContent("Zoom", value: String(format: "%.1f", render.zoom))
                LabeledContent(
                    "Drawn",
                    value: "\(render.visibleLines) lines · \(render.overlays) overlays · "
                        + "\(render.vertices) vertices"
                )
                LabeledContent("Rebuild", value: "\(render.buildMilliseconds) ms")
            }
        case .failed(let message):
            Text(message).foregroundStyle(.red)
        }
    }

    // MARK: - map

    private var map: some View {
        RailMapView(
            lines: controller.showsNetwork ? lines : [],
            controller: controller
        ) { render = $0 }
        .ignoresSafeArea()
    }

    private var lines: [RailNetworkStore.DrawnLine] {
        if case .loaded(_, let lines, _) = store.state { return lines }
        return []
    }
}

extension Coordinate {
    var clLocation: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}

extension Duration {
    var milliseconds: Int {
        Int(components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000)
    }
}

#Preview {
    ContentView()
}
