import RailCore
import SwiftUI

/// A recorded journey expressed with Flighty's information hierarchy while
/// remaining a railway screen: service identity first, station pair second,
/// then the chronological stop timeline and lower-priority metadata.
struct RideDetailView: View {
    let train: Train
    var onSave: ((Train) -> Void)?
    var onRebuild: (() -> Int?)?

    @Environment(AppLocalization.self) private var localization
    @State private var showsEditor = false

    var body: some View {
        RideDetailContent(train: train, onRebuild: onRebuild)
            .background(Color(.systemGroupedBackground))
            .navigationTitle(train.number)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if onSave != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(localization.text("ios.edit", fallback: "Edit"), systemImage: "pencil") {
                            showsEditor = true
                        }
                    }
                }
            }
            .sheet(isPresented: $showsEditor) {
                RideEditorView(
                    train: train,
                    title: localization.text("ios.editJourney", fallback: "Edit journey")
                ) { edited in
                    onSave?(edited)
                    showsEditor = false
                }
            }
    }
}

/// The journey itself, with no navigation of its own.
///
/// Split out because two surfaces show exactly this and disagree about
/// everything around it: the sidebar pushes it into a navigation stack with a
/// title and an Edit button, and the ride panel morphs its own header above it
/// and supplies its own actions. Duplicating the stop timeline to serve both
/// would mean fixing every timeline bug twice.
///
/// `includesIdentity` is the one seam between them. The pushed version needs
/// the identity card because its navigation bar only carries the train number;
/// the panel version does not, because its header *is* the identity and is
/// still on screen at every stage.
struct RideDetailContent: View {
    let train: Train
    var onRebuild: (() -> Int?)?
    var includesIdentity = true
    /// What a card inside this content is filled with.
    ///
    /// Pushed into a navigation stack it sits on a grouped background and
    /// wants the opaque one. Inside the ride panel it sits on a material over
    /// the map, and an opaque fill there paints over the very translucency the
    /// panel exists to have — so the panel passes a tint instead.
    var surface: AnyShapeStyle = AnyShapeStyle(.background)
    /// Whether this brings its own `ScrollView`.
    ///
    /// The ride panel puts an action row above the journey and needs both to
    /// scroll as one column, so it supplies the scroll view and asks for the
    /// cards alone. The `LazyVStack` stays lazy either way — laziness comes
    /// from the enclosing scroll view, not from this one.
    var scrolls = true

    @Environment(AppLocalization.self) private var localization
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var routeStatus: String?

    @ViewBuilder
    var body: some View {
        if scrolls {
            ScrollView { cards }
        } else {
            cards
        }
    }

    private var cards: some View {
        LazyVStack(spacing: 16) {
            if includesIdentity { identityCard }
            stationPairCard
            timelineCard
            metadataCard
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Label(train.number, systemImage: "tram.fill")
                    .font(.title2.bold())
                Spacer()
                if let date = train.date, !date.isEmpty {
                    Text(date)
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            if let type = train.trainType, !type.isEmpty { Text(type).font(.headline) }
            if let company = train.company, !company.isEmpty {
                Text(company).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var stationPairCard: some View {
        let vertical = dynamicTypeSize.isAccessibilitySize
        Group {
            if vertical {
                VStack(alignment: .leading, spacing: 14) {
                    stationSummary(
                        name: train.origin,
                        stop: firstRiddenStop,
                        role: localization.text("popup.departure", fallback: "Departure"),
                        isArrival: false
                    )
                    Image(systemName: "arrow.down")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    stationSummary(
                        name: train.destination,
                        stop: lastRiddenStop,
                        role: localization.text("popup.arrival", fallback: "Arrival"),
                        isArrival: true
                    )
                }
            } else {
                HStack(alignment: .top, spacing: 12) {
                    stationSummary(
                        name: train.origin,
                        stop: firstRiddenStop,
                        role: localization.text("popup.departure", fallback: "Departure"),
                        isArrival: false
                    )
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.right")
                        .foregroundStyle(.secondary)
                        .padding(.top, 8)
                        .accessibilityHidden(true)
                    Spacer(minLength: 8)
                    stationSummary(
                        name: train.destination,
                        stop: lastRiddenStop,
                        role: localization.text("popup.arrival", fallback: "Arrival"),
                        isArrival: true
                    )
                        .multilineTextAlignment(.trailing)
                }
            }
        }
        .padding(16)
        .background(surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func stationSummary(
        name: String,
        stop: Stop?,
        role: String,
        isArrival: Bool
    ) -> some View {
        let time = isArrival ? stop?.arrival ?? stop?.departure
            : stop?.departure ?? stop?.arrival
        return VStack(alignment: isArrival ? .trailing : .leading, spacing: 4) {
            Text(role)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(name)
                .font(.title3.bold())
                .fixedSize(horizontal: false, vertical: true)
            if let time, !time.isEmpty {
                Text(time).font(.headline).monospacedDigit()
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [role, name, time].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        )
    }

    private var timelineCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(localization.text("sec.stops", fallback: "Stops"))
                .font(.headline)
                .padding(.bottom, 12)
            ForEach(Array(train.stops.enumerated()), id: \.offset) { index, stop in
                timelineRow(stop, index: index)
            }
        }
        .padding(16)
        .background(surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func timelineRow(_ stop: Stop, index: Int) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Image(systemName: symbol(for: stop))
                    .font(.caption)
                    .foregroundStyle(
                        stop.rideSegment
                            ? AnyShapeStyle(Color.accentColor)
                            : AnyShapeStyle(.tertiary)
                    )
                    .frame(width: 18, height: 18)
                    .accessibilityHidden(true)
                if index < train.stops.count - 1 {
                    Rectangle()
                        .fill(stop.rideSegment ? Color.accentColor.opacity(0.45) : Color.secondary.opacity(0.2))
                        .frame(width: 2, height: 38)
                        .accessibilityHidden(true)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(stop.name)
                    .font(.body.weight(stop.stopType == "pass_through" ? .regular : .semibold))
                    .foregroundStyle(stop.rideSegment ? .primary : .secondary)
                if stop.stopType == "pass_through" {
                    Text(localization.text("ios.passWithoutStopping", fallback: "Passes without stopping"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if let arrival = stop.arrival, !arrival.isEmpty {
                    Text(arrival).font(.subheadline).monospacedDigit()
                }
                if let departure = stop.departure, !departure.isEmpty {
                    Text(departure).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
            }
        }
        .frame(minHeight: 44, alignment: .top)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: stop))
    }

    private var metadataCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(localization.text("ios.journeyInfo", fallback: "Journey information")).font(.headline)
            LabeledContent(localization.text("field.id", fallback: "Identifier"), value: train.id)
            if let direction = train.direction, !direction.isEmpty {
                LabeledContent(localization.text("field.direction", fallback: "Direction"), value: direction)
            }
            LabeledContent(
                localization.text("ios.visibility", fallback: "Visibility"),
                value: train.visible == false
                    ? localization.text("state.hidden", fallback: "Hidden")
                    : localization.text("state.shown", fallback: "Shown")
            )
            LabeledContent(
                localization.text("ios.recordedStops", fallback: "Recorded stops"),
                value: train.stops.count.formatted()
            )
            if let onRebuild {
                Divider()
                Button {
                    if let count = onRebuild() {
                        routeStatus = localization.text(
                            "status.routeSectionsRebuilt",
                            params: ["count": .number(Double(count))],
                            fallback: "Rebuilt \(count) route sections. Resolving geometry…")
                    }
                } label: {
                    Label(
                        localization.text("btn.rebuildRoute", fallback: "Rebuild route from stops"),
                        systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                }
                if let routeStatus {
                    // The route status changes under the reader while a solve
                    // runs, so VoiceOver has to be told it is worth re-reading.
                    // SwiftUI has no `accessibilityLiveRegion`; the trait is
                    // how the same thing is said here.
                    Text(routeStatus).font(.footnote).foregroundStyle(.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
        }
        .padding(16)
        .background(surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var riddenStops: [Stop] { train.stops.filter(\.rideSegment) }
    private var firstRiddenStop: Stop? { riddenStops.first ?? train.stops.first }
    private var lastRiddenStop: Stop? { riddenStops.last ?? train.stops.last }

    private func symbol(for stop: Stop) -> String {
        switch stop.stopType {
        case "pass_through": "circle.dotted"
        case "origin", "destination": "circle.fill"
        default: "circle"
        }
    }

    private func accessibilityLabel(for stop: Stop) -> String {
        var values = [stop.name]
        if stop.stopType == "pass_through" {
            values.append(localization.text("ios.passWithoutStopping", fallback: "passes without stopping"))
        }
        if let arrival = stop.arrival, !arrival.isEmpty {
            values.append("\(localization.text("popup.arrival", fallback: "arrival")) \(arrival)")
        }
        if let departure = stop.departure, !departure.isEmpty {
            values.append("\(localization.text("popup.departure", fallback: "departure")) \(departure)")
        }
        values.append(
            "\(localization.text("popup.rideSegment", fallback: "ridden")): "
                + localization.text(stop.rideSegment ? "popup.yes" : "popup.no", fallback: stop.rideSegment ? "yes" : "no")
        )
        return values.joined(separator: ", ")
    }
}
