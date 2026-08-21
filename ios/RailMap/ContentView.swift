import CoreLocation
import MapKit
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
/// The basemap is asked for `.muted` emphasis, which is MapKit's own term for
/// "something is being laid over me". Without it Apple's own transit lines
/// compete with ours for the same ink.
struct ContentView: View {
    @State private var store = RailNetworkStore()
    @State private var country = "mo"
    @State private var camera: MapCameraPosition = .automatic
    @State private var showsDetail = true

    var body: some View {
        ZStack(alignment: .bottom) {
            map
            controls
        }
        .task(id: country) { store.load(country: country) }
        .onChange(of: linesKey) { camera = .automatic }
    }

    // MARK: - map

    private var map: some View {
        Map(position: $camera) {
            ForEach(lines) { line in
                // One MapPolyline per station interval, matching the web app's
                // feature granularity. Drawing a line as a single polyline
                // would be fewer objects but would lose the interval identity
                // that selection, mileage and ride overlays all key on.
                ForEach(Array(line.intervals.enumerated()), id: \.offset) { _, interval in
                    MapPolyline(coordinates: interval.map(\.clLocation))
                        .stroke(
                            line.color,
                            style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)
                        )
                }
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControls {
            MapCompass()
            MapScaleView()
        }
        .ignoresSafeArea(edges: .top)
    }

    // MARK: - controls

    private var controls: some View {
        VStack(spacing: 12) {
            if showsDetail { statusCard }
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

    private var statusCard: some View {
        Group {
            switch store.state {
            case .idle:
                Text("Idle")
            case .loading:
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Decoding package…")
                }
            case .loaded(let code, let lines, let elapsed):
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(code.uppercased()) · \(lines.count) lines")
                        .font(.headline)
                    // Vertices and decode time are on screen on purpose. The
                    // open question for this fork is whether MapKit can carry
                    // a national network as overlays at all, and the answer is
                    // a number, not an impression.
                    Text(
                        "\(lines.reduce(0) { $0 + $1.intervals.count }) intervals · "
                            + "\(lines.reduce(0) { $0 + $1.vertexCount }) vertices"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text("decoded in \(elapsed.milliseconds) ms")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .failed(let message):
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - derived

    private var lines: [RailNetworkStore.DrawnLine] {
        if case .loaded(_, let lines, _) = store.state { return lines }
        return []
    }

    private var linesKey: Int {
        if case .loaded(let code, let lines, _) = store.state { return code.hashValue ^ lines.count }
        return 0
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
