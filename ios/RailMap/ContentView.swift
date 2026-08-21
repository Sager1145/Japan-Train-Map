import CoreLocation
import RailCore
import SwiftUI

/// The railway drawn over Apple Maps.
///
/// Apple Maps rather than a vector basemap of our own is a decision that fits
/// the data: this project's drawing rules were derived from Apple Maps Transit
/// in the first place — the stroke weight and station-bead diameter in
/// `railmap-style.js` are measured against macOS 「地圖」→ 大眾運輸 — so the
/// railway is being put back over the reference it was designed against.
///
/// The map itself is `MKMapView` (see ``RailMapView``), not SwiftUI's `Map`.
/// That is a measured decision, not a preference: SwiftUI's `MapPolyline` has
/// no batch initialiser, so a national network becomes thousands of overlays
/// and MapKit starts pruning Metal buffers mid-render.
struct ContentView: View {
    @State private var store = RailNetworkStore()
    @State private var country = "mo"
    @State private var render: RailMapView.RenderStats?

    var body: some View {
        ZStack(alignment: .bottom) {
            RailMapView(lines: lines) { render = $0 }
                .ignoresSafeArea()
            controls
        }
        .task(id: country) { store.load(country: country) }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            statusCard
            Picker("Country", selection: $country) {
                ForEach(RailNetworkStore.countries, id: \.code) { entry in
                    Text(entry.label).tag(entry.code)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding(12)
    }

    @ViewBuilder
    private var statusCard: some View {
        switch store.state {
        case .idle:
            Text("Idle").frame(maxWidth: .infinity, alignment: .leading)
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Decoding package…")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .loaded(let code, let lines, let elapsed):
            VStack(alignment: .leading, spacing: 4) {
                Text("\(code.uppercased()) · \(lines.count) lines")
                    .font(.headline)
                Text(
                    "\(lines.reduce(0) { $0 + $1.intervals.count }) intervals · "
                        + "\(lines.reduce(0) { $0 + $1.vertexCount }) vertices · "
                        + "decoded in \(elapsed.milliseconds) ms"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                // What the renderer actually submitted, at this zoom. The
                // whole point of the MKMapView rewrite is the gap between
                // these two lines, so both are on screen.
                if let render {
                    Text(
                        "z\(String(format: "%.1f", render.zoom)) → "
                            + "\(render.visibleLines) lines · \(render.overlays) overlays · "
                            + "\(render.vertices) drawn vertices · \(render.buildMilliseconds) ms"
                    )
                    .font(.caption)
                    .foregroundStyle(.tint)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .failed(let message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
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
