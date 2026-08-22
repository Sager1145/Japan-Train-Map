import CoreLocation
import MapKit
import RailCore
import SwiftUI

/// The railway over Apple Maps, in the two shapes iOS asks for.
///
/// The compact case follows Apple Maps' own presentation model rather than a
/// panel of our own: **a full-screen map with exactly one resident sheet**.
/// The sheet is never dismissed and never stacked — its *content* is swapped —
/// which is why it is presented with a constant binding and interactive
/// dismissal disabled. Using the system sheet rather than a hand-rolled panel
/// buys the real detent physics, the rubber-banding, the glass, the
/// accessibility and the keyboard avoidance, none of which a custom drag
/// gesture reproduces convincingly.
///
/// The layout is chosen by the window's shape, not the device. A phone in
/// landscape has almost no height for a sheet but plenty of width for a
/// sidebar, and it reports a *compact* horizontal size class on every model
/// but the largest — so size class alone would put a sheet there and leave the
/// map a letterbox.
///
///   tall windows   a resident sheet over the map
///   wide windows   the same tabs at the foot of a sidebar
///
/// The map's controls run down the right edge in both, and in the sheet
/// layout they ride above it — at full height they are removed rather than
/// pushed off screen. A control the sheet slides over is one that stops
/// working without ever looking broken.
struct ContentView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var store = RailNetworkStore()
    @State private var itineraries = ItineraryStore()
    @State private var controller = RailMapController()
    @State private var country = "mo"
    @State private var render: RailMapView.RenderStats?
    @State private var tab = Tab.rides
    @State private var detent: PresentationDetent = .height(collapsedHeight)

    private static let collapsedHeight: CGFloat = 92

    enum Tab: String, CaseIterable, Identifiable {
        // Rides first: this app is a record of journeys taken, and the network
        // under them is context. The web app's sidebar leads with the train
        // list for the same reason.
        case rides, network, layers, info
        var id: String { rawValue }

        var symbol: String {
            switch self {
            case .rides: "list.bullet.rectangle"
            case .network: "tram.fill"
            case .layers: "square.3.layers.3d"
            case .info: "chart.bar.doc.horizontal"
            }
        }

        var title: LocalizedStringKey {
            switch self {
            case .rides: "Rides"
            case .network: "Network"
            case .layers: "Layers"
            case .info: "Detail"
            }
        }
    }

    var body: some View {
        GeometryReader { geometry in
            // Wider than tall, or a regular-width window: sidebar. Read from
            // the geometry so a rotation or an iPad window resize switches
            // layouts as it happens.
            if geometry.size.width > geometry.size.height || horizontalSizeClass == .regular {
                sidebarLayout
            } else {
                sheetLayout(in: geometry)
            }
        }
        .task(id: country) {
            store.load(country: country)
            itineraries.load(country: country)
        }
    }

    // MARK: - tall windows: the resident sheet

    private func sheetLayout(in geometry: GeometryProxy) -> some View {
        ZStack(alignment: .bottomTrailing) {
            map

            // Above the sheet, derived from the detent rather than measured.
            //
            // Measuring was the first attempt and it does not work: the sheet
            // is presented in its own context, so a GeometryReader inside it
            // reports `.global` coordinates in that context's space, not the
            // map's. The reading never reached this view and the controls sat
            // under the sheet. The detent is the honest source here — it is
            // what actually decides the height.
            controlStack
                .padding(.trailing, 12)
                .padding(.bottom, sheetClearance(in: geometry) + 12)
        }
        .sheet(isPresented: .constant(true)) {
            sheetContent
                .presentationDetents(
                    [.height(Self.collapsedHeight), .fraction(0.45), .large],
                    selection: $detent
                )
                .presentationDragIndicator(.visible)
                // The map stays live behind the sheet at every detent short of
                // full height — this is a map app, and a sheet that freezes the
                // map is one that has to be dismissed before the app is usable.
                .presentationBackgroundInteraction(.enabled(upThrough: .fraction(0.45)))
                .interactiveDismissDisabled()
                .presentationCornerRadius(20)
        }
    }

    private var sheetContent: some View {
        VStack(spacing: 0) {
            tabContent(tab)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            tabRow
        }
    }

    /// How much room the sheet takes at the bottom of the map.
    ///
    /// At full height the sheet covers the map, so the controls are not moved
    /// out of the way — they are removed (see ``controlStack``); pushing them
    /// off the top of the screen instead would leave them present but
    /// unreachable, which is the failure this is here to avoid.
    private func sheetClearance(in geometry: GeometryProxy) -> CGFloat {
        switch detent {
        case .fraction(0.45): geometry.size.height * 0.45
        default: Self.collapsedHeight
        }
    }

    // MARK: - wide windows: a sidebar, on iPad and on a phone in landscape

    private var sidebarLayout: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                tabContent(tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                Divider()
                tabRow
            }
            // Narrower on a phone, where the map has little enough width as it
            // is; a fixed 320 would eat half of a landscape iPhone.
            .frame(width: horizontalSizeClass == .regular ? 320 : 260)
            .background(.regularMaterial)

            Divider()

            ZStack(alignment: .bottomTrailing) {
                map
                controlStack.padding(12)
            }
        }
        .ignoresSafeArea(edges: .bottom)
    }

    // MARK: - shared parts

    /// Withheld until the map exists: `MKCompassButton` cannot be built
    /// without an `MKMapView`, and showing the stack without it would leave a
    /// gap that fills in a frame later.
    @ViewBuilder
    private var controlStack: some View {
        if detent != .large, controller.isMapReady, let mapView = controller.mapView {
            MapControlBar(mapView: mapView, controller: controller) {
                controller.fitToNetwork()
            }
        }
    }

    private var tabRow: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases) { entry in
                Button {
                    tab = entry
                    if detent == .height(Self.collapsedHeight) { detent = .fraction(0.45) }
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: entry.symbol).font(.system(size: 18))
                        Text(entry.title).font(.caption2)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(tab == entry ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .contentShape(.rect)
                    .accessibilityHidden(true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(entry.title))
                .accessibilityAddTraits(tab == entry ? [.isSelected] : [])
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func tabContent(_ tab: Tab) -> some View {
        switch tab {
        case .rides:
            ridesList

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
                    .contentShape(.rect)
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
            List { statusRows }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
        }
    }

    /// The itineraries, grouped the way the web app's date bar groups them.
    @ViewBuilder
    private var ridesList: some View {
        switch itineraries.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView(
                "Could not read the rides",
                systemImage: "exclamationmark.triangle",
                description: Text(message)
            )
        case .loaded(let loaded) where loaded.days.isEmpty:
            // Three of the five packages draw a network but carry no recorded
            // journeys. Saying so is better than an empty list, which reads as
            // a failure rather than as an absence.
            ContentUnavailableView(
                "No recorded rides",
                systemImage: "tram",
                description: Text(
                    "This country's package draws its railways, but no journeys are stored for it yet."
                )
            )
        case .loaded(let loaded):
            NavigationStack {
                List {
                    ForEach(loaded.days) { day in
                        Section(day.date) {
                            ForEach(day.trains, id: \.id) { train in
                                NavigationLink(value: train.id) { rideRow(train) }
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .navigationDestination(for: String.self) { id in
                    if let train = loaded.trains.first(where: { $0.id == id }) {
                        RideDetailView(train: train)
                    }
                }
            }
        }
    }

    private func rideRow(_ train: Train) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(train.number).font(.body)
            HStack(spacing: 4) {
                Text(train.origin)
                Image(systemName: "arrow.right").imageScale(.small)
                Text(train.destination)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                if let type = train.trainType, !type.isEmpty { Text(type) }
                Text("\(train.stops.count) stops")
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
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
            // measurements, not estimates.
            if let render {
                LabeledContent(
                    "Zoom",
                    value: render.threshold < render.zoom - 0.01
                        ? String(format: "%.1f (drawing to %.1f)", render.zoom, render.threshold)
                        : String(format: "%.1f", render.zoom)
                )
                LabeledContent(
                    "Drawn",
                    value: "\(render.visibleLines) lines · \(render.overlays) overlays · "
                        + "\(render.vertices) vertices"
                )
                LabeledContent("Off screen", value: "\(render.culledOffScreen) lines culled")
                LabeledContent("Rebuild", value: "\(render.buildMilliseconds) ms")
            }
        case .failed(let message):
            Text(message).foregroundStyle(.red)
        }
        if let loaded = itineraries.loaded, !loaded.trains.isEmpty {
            LabeledContent(
                "Rides",
                value: "\(loaded.trains.count) over \(loaded.days.count) days · "
                    + "read in \(loaded.elapsed.milliseconds) ms"
            )
        }
    }

    private var map: some View {
        RailMapView(
            lines: lines,
            showsNetwork: controller.showsNetwork,
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
