import RailCore
import SwiftUI

/// 圖例與資料來源 — what the marks on the map mean, and whose data they are.
///
/// The web app's is a popover behind an `i` in the map's bottom-right corner
/// (`buildMapInfoControl` in app-map-init.js). This is the same panel as a
/// sheet, for the same two reasons the web app gives it: a reader cannot be
/// expected to infer that a hollow ring means a train passed through without
/// stopping, and the packages are used **under licences that require
/// attribution** — MLIT's N02 under CC BY 4.0, Taiwan's open-data terms, the
/// romaji under ODbL. A map that draws the data without naming it is not a
/// tidier map; it is one that has stopped meeting the condition it is drawn
/// under.
///
/// Three differences from the web app's copy, each because the client differs:
///
///   - **The basemap is Apple's, not OpenFreeMap Positron.** `info.basemapBody`
///     names the wrong thing here, so this article is iOS's own — and MapKit
///     puts its own attribution on the map, which is why this only names it
///     rather than reproducing it.
///   - **Korea has an article.** The web app has none: `info.krRail*` does not
///     exist in its catalog, which is a gap there rather than a decision. The
///     package ships with `kr-2025.sources.md` naming its sources, so the
///     article is written from that.
///   - **Every region is listed at once.** The web app hides the articles that
///     do not apply to the active country (`applyCountryVisibility`); with all
///     five networks drawn, all five apply.
struct MapInfoView: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Self.legend, id: \.titleKey) { entry in
                        LegendRow(entry: entry)
                    }
                } header: {
                    Text(localization.countryText("info.legendHeading", fallback: "Map legend"))
                } footer: {
                    Text(localization.countryText("info.intro", fallback: ""))
                }

                Section {
                    ForEach(Self.sources) { source in
                        SourceRow(source: source)
                    }
                } header: {
                    Text(
                        localization.countryText(
                            "info.sourcesHeading", fallback: "Data and licences"))
                }
            }
            .navigationTitle(
                localization.countryText("info.title", fallback: "Legend and sources"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(localization.text("ios.done", fallback: "Done")) { dismiss() }
                }
            }
        }
        // §4.2: this sheet is ABOUT the map, so it must not cover all of it —
        // half by default, full when the reader pulls it up. Declared here
        // rather than at the presenter, the way `VideoExportOptionsView` does.
        .presentationDetents([.medium, .large])
    }

    // MARK: - the legend

    struct LegendEntry {
        var symbol: LegendSymbol
        var titleKey: String
        var detailKey: String
    }

    /// The same six rows the web panel carries, in its order. 停駛區間 is last
    /// there because it is the one that describes an exception rather than a
    /// mark.
    static let legend: [LegendEntry] = [
        .init(symbol: .route, titleKey: "info.routeTitle", detailKey: "info.routeDesc"),
        .init(symbol: .stop, titleKey: "info.stopTitle", detailKey: "info.stopDesc"),
        .init(symbol: .pass, titleKey: "info.passTitle", detailKey: "info.passDesc"),
        .init(symbol: .terminal, titleKey: "info.terminalTitle", detailKey: "info.terminalDesc"),
        .init(symbol: .network, titleKey: "info.networkTitle", detailKey: "info.networkDesc"),
        .init(
            symbol: .suspended, titleKey: "info.suspendedTitle", detailKey: "info.suspendedDesc"),
    ]

    // MARK: - the sources

    struct Source: Identifiable {
        var id: String { titleKey }
        var titleKey: String
        var titleFallback: String
        var bodyKey: String
        var bodyFallback: String
        var links: [SourceLink] = []
    }

    struct SourceLink: Identifiable {
        var id: String { url }
        var label: String
        var labelKey: String?
        var url: String
    }

    static let sources: [Source] = [
        Source(
            titleKey: "info.n02Title", titleFallback: "Japanese rail network",
            bodyKey: "info.n02Body",
            bodyFallback: "Processed from MLIT's National Land Numerical Information (N02).",
            links: [
                .init(label: "MLIT N02", url: "https://nlftp.mlit.go.jp/ksj/"),
                .init(label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/"),
            ]),
        Source(
            titleKey: "info.twRailTitle", titleFallback: "Taiwanese rail network",
            bodyKey: "info.twRailBody",
            bodyFallback: "Processed from TDX, NLSC, the Alishan Forest Railway and Taipei's open data.",
            links: [
                .init(label: "TDX", url: "https://tdx.transportdata.tw/"),
                .init(
                    label: "NLSC", labelKey: "info.twNlsc",
                    url: "https://data.gov.tw/dataset/73220"),
                .init(
                    label: "Alishan Forest Railway", labelKey: "info.twAfr",
                    url: "https://afrch.forest.gov.tw/"),
                .init(
                    label: "Taipei Metro GIS", labelKey: "info.twTaipei",
                    url:
                        "https://data.taipei/dataset/detail?id=afccd2ac-75b1-4362-9099-45983e332776"),
                .init(
                    label: "Open Government Data Licence", labelKey: "info.twLicense",
                    url: "https://data.gov.tw/license"),
            ]),
        Source(
            titleKey: "info.hkRailTitle", titleFallback: "Hong Kong rail network",
            bodyKey: "info.hkRailBody",
            bodyFallback: "Processed from MTR's official journey planner and open data.",
            links: [
                .init(
                    label: "MTR Journey Planner",
                    url: "https://www.mtr.com.hk/en/customer/jp/index.php"),
                .init(
                    label: "MTR Open Data",
                    url:
                        "https://data.gov.hk/en-data/dataset/mtr-data-routes-fares-barrier-free-facilities"
                ),
            ]),
        Source(
            titleKey: "info.moRailTitle", titleFallback: "Macao LRT network",
            bodyKey: "info.moRailBody",
            bodyFallback: "Processed from the Macao LRT's official line and station data.",
            links: [.init(label: "Macao LRT Lines", url: "https://www.mlm.com.mo/en/route.html")]),
        // Korea's article has no web counterpart — see the type's note.
        Source(
            titleKey: "ios.info.krRailTitle", titleFallback: "Korean rail network",
            bodyKey: "ios.info.krRailBody",
            bodyFallback:
                "Processed from data.go.kr's official station records and OpenStreetMap alignments.",
            links: [
                .init(label: "data.go.kr", url: "https://www.data.go.kr/"),
                .init(label: "OpenStreetMap (ODbL)", url: "https://www.openstreetmap.org/copyright"),
            ]),
        Source(
            titleKey: "info.basemapTitle", titleFallback: "Basemap",
            bodyKey: "ios.info.basemapBody",
            bodyFallback: "Apple Maps, with its own attribution shown on the map.",
            links: [.init(label: "Apple Maps", url: "https://www.apple.com/legal/internet-services/maps/")]),
        Source(
            titleKey: "info.namesTitle", titleFallback: "Station name romaji",
            bodyKey: "info.namesBody", bodyFallback: "OpenStreetMap contributors, under ODbL.",
            links: [
                .init(label: "ODbL", url: "https://www.openstreetmap.org/copyright")
            ]),
        Source(
            titleKey: "info.packageTitle", titleFallback: "Rail data packages",
            bodyKey: "info.packageBody", bodyFallback: "railprint's regional rail packages.",
            links: [.init(label: "railprint", url: "https://github.com/yzhouwang/railprint")]),
    ]
}

// MARK: - rows

private struct LegendRow: View {
    @Environment(AppLocalization.self) private var localization
    let entry: MapInfoView.LegendEntry

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            LegendSymbolView(symbol: entry.symbol)
                .frame(width: 34, height: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(localization.countryText(entry.titleKey, fallback: entry.titleKey))
                    .font(.subheadline.weight(.semibold))
                Text(localization.countryText(entry.detailKey, fallback: ""))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct SourceRow: View {
    @Environment(AppLocalization.self) private var localization
    let source: MapInfoView.Source

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(localization.countryText(source.titleKey, fallback: source.titleFallback))
                .font(.subheadline.weight(.semibold))
            Text(localization.countryText(source.bodyKey, fallback: source.bodyFallback))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !source.links.isEmpty {
                // Wrapped rather than in one row: several of these are long,
                // and a licence link that has been truncated to "Open Gov…" is
                // a licence nobody can follow.
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(source.links) { link in
                        if let url = URL(string: link.url) {
                            Link(destination: url) {
                                Label(
                                    link.labelKey.map {
                                        localization.countryText($0, fallback: link.label)
                                    } ?? link.label,
                                    systemImage: "arrow.up.right.square")
                                    .font(.footnote)
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - the drawn symbols

enum LegendSymbol {
    case route
    case stop
    case pass
    case terminal
    case network
    case suspended
}

/// The marks themselves, drawn from the same tokens the map draws them with
/// rather than from a picture of them.
///
/// `RailStyle` is where every weight and radius on the map comes from, and a
/// legend drawn from remembered numbers is a legend that stops matching the
/// first time one of them moves. The one thing that is NOT taken from there is
/// the zoom ramp: `RailStyle.scale(atZoom:)` answers for a map at a zoom, and
/// this is a swatch at no zoom at all, so the marks are drawn at their full
/// weight — which is what they look like from a city view.
private struct LegendSymbolView: View {
    let symbol: LegendSymbol

    var body: some View {
        Canvas { context, size in
            let midY = size.height / 2
            let stroke = Path { path in
                path.move(to: CGPoint(x: 0, y: midY))
                path.addLine(to: CGPoint(x: size.width, y: midY))
            }
            switch symbol {
            case .route:
                context.stroke(
                    stroke, with: .color(Self.routeColour),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            case .network:
                context.stroke(
                    stroke, with: .color(.secondary),
                    style: StrokeStyle(lineWidth: lineWidth * 0.75, lineCap: .round))
            case .suspended:
                context.stroke(
                    stroke, with: .color(.secondary),
                    style: StrokeStyle(
                        lineWidth: lineWidth * 0.75, lineCap: .butt,
                        dash: [lineWidth * 1.6, lineWidth * 1.4]))
            case .stop, .pass, .terminal:
                context.stroke(
                    stroke, with: .color(Self.routeColour),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                let centre = CGPoint(x: size.width / 2, y: midY)
                let radius = symbol == .terminal ? outerRadius * 1.33 : outerRadius
                let disc = Path(
                    ellipseIn: CGRect(
                        x: centre.x - radius, y: centre.y - radius,
                        width: radius * 2, height: radius * 2))
                // White fill, ink ring — and the other way round for a
                // terminal. Fixed rather than theme-derived: these are the
                // colours `MapRideMarkers` actually draws with (`white` /
                // `ink`), and a legend that inverted itself in dark mode would
                // be showing marks the map never draws.
                context.fill(disc, with: .color(symbol == .terminal ? Self.ink : Self.white))
                context.stroke(
                    disc, with: .color(symbol == .terminal ? Self.white : Self.ink),
                    lineWidth: max(radius / 3, 1))
                if symbol == .stop {
                    // The stop's black centre is its ONLY difference from a
                    // pass-through — the same distinction the map makes, and
                    // the reason both rows are here.
                    let inner = radius * 0.45
                    context.fill(
                        Path(
                            ellipseIn: CGRect(
                                x: centre.x - inner, y: centre.y - inner,
                                width: inner * 2, height: inner * 2)),
                        with: .color(Self.ink))
                }
            }
        }
    }

    /// The web app's own default train colour, so the legend's line is a line
    /// the map can actually draw rather than the system tint.
    private static let routeColour = Color(hex: TrainValidation.defaultTrainColor) ?? .accentColor
    private static let white = Color(red: 1, green: 1, blue: 1)
    private static let ink = Color(red: 0.05, green: 0.05, blue: 0.07)

    /// Drawn at a legible multiple of the map's own token: `RailStyle.railWidth`
    /// is 1.5 pt at full scale, which is a hairline in a list row.
    private var lineWidth: CGFloat { RailStyle.riddenWidth * 3 }
    private var outerRadius: CGFloat { RailStyle.stationRadius * 2.2 }
}

#Preview {
    MapInfoView()
        .environment(AppLocalization())
}
