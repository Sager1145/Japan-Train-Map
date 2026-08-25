import RailCore
import RailPresentation
import SwiftUI

/// One station, as the sheet presents it.
///
/// The map used to answer a tap on a station bead with an `MKAnnotationView`
/// callout: a bubble anchored to the bead, carrying the readings and every
/// railway through the complex. It had to stay small enough not to cover the
/// map it pointed at, which put as many as a dozen badge rows into a fixed
/// 280-point box that could neither scroll nor grow with the reader's type
/// size — and the bubble's tail moved the map under it every time one opened
/// near an edge.
///
/// So the same model is presented as a card in a sheet instead. Nothing about
/// what a station SAYS has changed: `StationDisplay.buildPopupModel` is still
/// the ported reference that decides which railways are listed, how they are
/// deduped and which badge each one wears.
///
/// What the card carries is the ANSWER rather than the network row it usually
/// comes out of. The dots a recorded ride puts on its own stops open this same
/// card, and a ride's stop is resolved back to a network platform by code and
/// then by name (`Coordinator.rideStationCard`) — a resolution that can fail,
/// on a store written by hand or against a package that has no such station.
/// Holding a `DrawnStation` would make that failure unpresentable, and a
/// station the reader can see on the map but cannot tap is the fault this card
/// exists to fix.
struct StationCard: Identifiable {
    /// What the sheet is keyed on: the network platform's own id where the tap
    /// resolved to one, and the place itself where it did not.
    var id: String
    /// The station's own surveyed position — where the pin goes when this card
    /// is shared or opened in Maps.
    var coordinate: Coordinate
    /// The header, in the reader's language — see `StationAnnotation`.
    var displayName: String
    /// The package's own spelling, whatever the reader has the app set to.
    ///
    /// It is the name the local map service holds the station under, so it is
    /// the one `StationPlaceStore` searches with — a card opened by a reader
    /// using the app in English must still ask Apple Maps for 東京 rather than
    /// for Tokyo.
    var rawName: String
    /// Which package the station came out of. `StationPlaceLink` needs it for
    /// the word it appends to a failed query, and nothing else on the card
    /// does.
    var region: Region
    /// One line per enabled reading. `nil` is "no localisation at all", `[]`
    /// is "every reading toggle off", and the two are different answers.
    var readings: [String]?
    /// `PopupModel.nameRoma`, which is the subline the standalone case — no
    /// localisation engine at all — falls back to.
    var nameRoma: String
    /// Every railway through the station complex, as
    /// `StationDisplay.buildPopupModel` deduped and badged them. Empty is a
    /// real answer: a stop that resolved to no platform lists no line rather
    /// than guessing at one.
    var lines: [StationDisplay.PopupRow]
}

extension StationCard {
    /// A network platform's card, whose popup model was built once when the
    /// package was decoded.
    init(
        station: RailNetworkStore.DrawnStation, displayName: String,
        readings: [String]?
    ) {
        self.init(
            id: station.id,
            coordinate: station.coordinate,
            displayName: displayName,
            rawName: station.name,
            region: station.region,
            readings: readings,
            nameRoma: station.popup.nameRoma,
            lines: station.popup.lines)
    }

    /// Every spelling of this station worth asking Apple Maps about, the
    /// package's own first.
    ///
    /// The readings are included because they are the station's name in
    /// another script rather than a gloss on it: Hong Kong, Macao, Taiwan and
    /// Korea carry official ja/en/zh names in the same table Japan uses for
    /// kana and romaji, and a device answering in any of those languages
    /// answers with one of them. `nil` readings — the standalone build with no
    /// localisation engine — contribute nothing rather than an empty string.
    var searchNames: [String] {
        [rawName, displayName, nameRoma] + (readings ?? [])
    }
}

struct StationCardView: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var card: StationCard

    /// The Apple Maps place this station is, once `StationPlaceStore` has
    /// found it. `nil` while the search is in flight and `nil` for good when
    /// the service has no such station — the two are deliberately the same
    /// state here, because the answer to both is the same link.
    @State private var place: StationPlaceStore.Place?

    /// The web app's three-state reading rule, unchanged by the move: `nil`
    /// keeps the single `nameRoma` subline, an empty list means no subline at
    /// all, and a list is itself.
    private var sublines: [String] {
        card.readings ?? (card.nameRoma.isEmpty ? [] : [card.nameRoma])
    }

    /// The link this card sends.
    ///
    /// The station's own Apple Maps place where one was found — a link that
    /// arrives at the other end as 東京駅, with its exits, its platforms and
    /// its departures — and the captioned pin where none was. The fallback is
    /// what this card sent for every station before places were resolved at
    /// all, so a service that cannot answer costs the reader nothing.
    private var appleMapsURL: URL {
        place?.url ?? StationPlaceLink.pinURL(
            name: card.displayName,
            latitude: card.coordinate.lat, longitude: card.coordinate.lon)
    }

    /// Hand the reader over to Apple Maps.
    ///
    /// The resolved map item rather than its URL, because opening the ITEM is
    /// the one path that cannot be wrong: Maps is handed the place it already
    /// agreed this station is, on the same device and the same map service,
    /// with no URL to parse and no identifier to re-resolve.
    private func openInMaps() {
        if let item = place?.item {
            _ = item.openInMaps()
        } else {
            openURL(appleMapsURL)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(card.displayName)
                            .font(.title2.weight(.semibold))
                        ForEach(Array(sublines.enumerated()), id: \.offset) { _, subline in
                            Text(subline)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)

                    // The other half of the hand-off the share button starts:
                    // the same station, opened here instead of sent. Apple Maps
                    // knows what is around a station — the exits, the streets,
                    // the walk to it — and this map deliberately does not.
                    Button(action: openInMaps) {
                        Label(
                            localization.text("ios.openInMaps", fallback: "Open in Maps"),
                            systemImage: "map")
                    }
                }

                if !card.lines.isEmpty {
                    Section {
                        ForEach(card.lines, id: \.lineID) { row in
                            StationCardLineRow(row: row)
                        }
                    } header: {
                        // The catalog's own word for this (路線 / Line). The
                        // web popup heads the rows with nothing at all — it
                        // has the name directly above them and no section
                        // chrome between — but a grouped list needs a header,
                        // and inventing a string when the catalog already
                        // carries the word would be a fifth translation to
                        // keep true.
                        Text(localization.countryText("popup.line", fallback: "Line"))
                    }
                }
            }
            // Deliberately no title: the card's own header carries the
            // station's name at reading size, and a navigation bar repeating
            // it two lines above would print the same word twice. The bar is
            // still there for the close button, which is where a sheet's
            // dismissal belongs.
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ShareLink(
                        item: appleMapsURL,
                        subject: Text(card.displayName),
                        message: Text(card.displayName)
                    ) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel(localization.text("ios.share", fallback: "Share"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    closeButton
                }
            }
        }
        // A station card is a short answer — a name, its readings and the
        // railways through it — so it opens at the height that answer needs
        // and leaves the map visible above it, the way a place card does.
        // `.large` stays reachable because a major interchange lists a dozen
        // railways and the medium detent would scroll for all of them.
        // Keyed on the station rather than run once, because one sheet is
        // reused for the next station the reader taps: the card is a value the
        // presentation swaps, and a `task` with no id would hold the first
        // station's place under every card after it.
        .task(id: card.id) {
            place = await StationPlaceStore.shared.place(
                for: card,
                aliases: localization.stationNameAliases(
                    card.rawName, code: card.id, region: card.region))
        }
        .presentationDetents([.medium, .large])
        // §9.5.6's no-Pull-Bar rule is the app's, not the resident sheet's —
        // this card was the one bottom surface still drawing a grabber. As
        // with the resident sheet, hiding it is only affordable next to
        // `.resizes`: without that, a sheet with no grabber and a scrolling
        // list inside it cannot be dragged between its stops at all.
        .presentationDragIndicator(.hidden)
        .presentationContentInteraction(.resizes)
    }

    /// The system's own close button, and nothing drawn on top of it.
    ///
    /// This used to be a hand-built `xmark.circle.fill` at `.title2` in
    /// secondary ink, which is what a close button looked like when a toolbar
    /// item was bare glyph on bare bar. On iOS 26 the toolbar gives every item
    /// its own circular glass capsule, so that filled circle became a second,
    /// grey circle sitting inside the system's — a doubled mark next to a
    /// share button that had let the system draw its container.
    ///
    /// `ButtonRole.close` is the whole fix: it is iOS 26's own dismissal
    /// button — the standard glyph, at the standard weight, in the standard
    /// container, matching every other sheet the reader closes. It arrived in
    /// that release and the app deploys to iOS 17, so the hand-built glyph
    /// stays as the fallback, where it is still the right drawing: before iOS
    /// 26 the bar puts nothing behind a toolbar item and the filled circle IS
    /// the container.
    ///
    /// The label is the app's own `ios.close` rather than the system's, for
    /// the reason every other string here is: this app carries its own
    /// language setting, and VoiceOver would otherwise say 「閉じる」 to a
    /// reader who has put the app in Chinese.
    @ViewBuilder
    private var closeButton: some View {
        if #available(iOS 26.0, *) {
            Button(role: .close) { dismiss() }
                .accessibilityLabel(localization.text("ios.close", fallback: "Close"))
        } else {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(localization.text("ios.close", fallback: "Close"))
        }
    }
}

/// One railway through this station: its badge, then its name.
///
/// `railmap-popup.js` draws the operator's mark where there is one and a
/// colour swatch where there is not — never both, and never a bare name.
/// `OperatorBranding` decides which, through `StationDisplay.buildPopupModel`.
private struct StationCardLineRow: View {
    var row: StationDisplay.PopupRow

    var body: some View {
        HStack(spacing: 8) {
            badge
            Text([row.company, row.label].filter { !$0.isEmpty }.joined(separator: "  "))
                .font(.callout)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var badge: some View {
        if let image = OperatorBadge.image(row.logo) {
            let ratio = image.size.height > 0 ? image.size.width / image.size.height : 1
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                // 16 points tall, aspect kept, never wider than 48 — the
                // `.rp-line-logo` rule, which is what keeps a row of mixed
                // badges reading as one column rather than as a ransom note.
                .frame(width: min(48, 16 * ratio), height: 16)
                .padding(row.logoNeedsDarkMatte ? 2 : 0)
                .background {
                    if row.logoNeedsDarkMatte {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color(uiColor: OperatorBadge.matte))
                    }
                }
                .frame(width: 52, alignment: .leading)
        } else {
            // `.rp-line-swatch`: 14 × 6, the line's own colour.
            RoundedRectangle(cornerRadius: 2)
                .fill(Color(hex: row.color) ?? Color(.systemGray))
                .frame(width: 14, height: 6)
                .frame(width: 52, alignment: .leading)
        }
    }
}
