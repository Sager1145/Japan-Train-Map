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
        RideDetailContent(
            train: train,
            onRebuild: onRebuild,
            onEditStops: onSave == nil ? nil : { showsEditor = true },
            // §8.5's "从地图隐藏" is an edit to one field of the record, so it
            // travels through the same atomic save every other edit does
            // rather than through a second write path of its own.
            onSetVisible: onSave.map { save in
                { visible in
                    var updated = train
                    updated.visible = visible
                    save(updated)
                }
            })
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
/// ## The card order is the specification
///
/// §5.3 fixes it — identity, route timing, stop timeline, route state, service
/// metadata, advanced record details — and names the thing that must not
/// happen: "不得默认把 `id`、`route_policy`、`route_sections` 展开在 Hero
/// 附近". Those three now live behind one disclosure at the bottom, where they
/// were previously in the second card on screen.
///
/// `includesIdentity` is the one seam between the two surfaces. The pushed
/// version needs the identity card because its navigation bar only carries the
/// train number; the panel version does not, because its header *is* the
/// identity and is still on screen at every stage.
struct RideDetailContent: View {
    let train: Train
    var onRebuild: (() -> Int?)?
    var includesIdentity = true
    /// Whether this surface needs its own origin/destination summary card.
    ///
    /// The selected-journey panel already presents the same stations and times
    /// in `RouteTimingView` immediately above its actions. Repeating them in a
    /// second card adds no information, so that caller turns this off. The
    /// pushed detail screen keeps it because it has no summary above the cards.
    var includesStationPair = true
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
    /// §5.5's route state for this journey.
    ///
    /// Explicit when the surface knows it. `nil` reads `RideStatusCenter`,
    /// which the two stores publish into — see that type for why a shared
    /// projection exists at all, and why passing this in is the seam that
    /// retires it.
    var routeStatus: RideRouteStatus?
    /// §8.4: the recovery a failed route should offer *first*, ahead of a
    /// retry loop. Absent on surfaces that carry their own Edit action.
    var onEditStops: (() -> Void)?
    /// §8.5: hide from the map, or put it back. Absent on surfaces that have
    /// their own visibility control, so the reader is never offered two.
    var onSetVisible: ((Bool) -> Void)?

    @Environment(AppLocalization.self) private var localization
    @State private var rebuild: RebuildPhase = .idle

    private enum RebuildPhase: Equatable {
        case idle
        case done(sections: Int)
    }

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
            if includesStationPair { stationPairCard }
            timelineCard
            if train.visible == false { hiddenCard }
            routeStateCard
            serviceCard
            advancedCard
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    // MARK: - 1. Identity

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
        }
        .padding(16)
        .background(
            surface,
            in: RoundedRectangle(
                cornerRadius: RailStyle.cardCornerRadius,
                style: .continuous))
        .accessibilityElement(children: .combine)
    }

    // MARK: - 2. Route timing (§7.3)

    @ViewBuilder
    private var stationPairCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                stationSummary(
                    name: train.origin,
                    stop: firstRiddenStop,
                    role: localization.countryText("popup.departure", fallback: "Departure"),
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
                    role: localization.countryText("popup.arrival", fallback: "Arrival"),
                    isArrival: true
                )
                    .multilineTextAlignment(.trailing)
            }
            // §7.3 / §10.4: the 24+ hour spelling stays exactly as recorded —
            // `25:10` is business data, not a formatting accident — and the
            // detail is where it gets explained instead of rewritten.
            if crossesMidnight {
                Text(localization.editorText("ios.detail.crossDay"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .background(
            surface,
            in: RoundedRectangle(
                cornerRadius: RailStyle.cardCornerRadius,
                style: .continuous))
    }

    private func stationSummary(
        name: String,
        stop: Stop?,
        role: String,
        isArrival: Bool
    ) -> some View {
        let time = isArrival ? stop?.arrival ?? stop?.departure
            : stop?.departure ?? stop?.arrival
        let platform = stop?.platformNumber.flatMap { $0 >= 0 ? $0 : nil }
        return VStack(alignment: isArrival ? .trailing : .leading, spacing: 4) {
            Text(role)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(name)
                .font(.title3.bold())
                .fixedSize(horizontal: false, vertical: true)
            if let time, !time.isEmpty {
                HStack(spacing: 5) {
                    Text(time).font(.headline).monospacedDigit()
                    if Dates.isCrossDayTimeString(time) { nextDayTag }
                }
            }
            if let platform {
                platformBadge(platform)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [role, name, time, time.map(nextDayVoiceOver) ?? nil,
             platform.map(platformText)]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        )
    }

    // MARK: - 3. Stop timeline (§7.4)

    private var timelineCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(localization.countryText("sec.stops", fallback: "Stops"))
                .font(.headline)
                .padding(.bottom, 12)
            ForEach(Array(train.stops.enumerated()), id: \.offset) { index, stop in
                timelineRow(stop, index: index)
            }
        }
        .padding(16)
        .background(
            surface,
            in: RoundedRectangle(
                cornerRadius: RailStyle.cardCornerRadius,
                style: .continuous))
        .accessibilityLabel(localization.countryText("table.stopsLabel", fallback: "Stops table"))
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
                        .frame(width: 2)
                        .frame(minHeight: 26)
                        .accessibilityHidden(true)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(stop.name)
                    .font(.body.weight(stop.stopType == "pass_through" ? .regular : .semibold))
                    .foregroundStyle(stop.rideSegment ? .primary : .secondary)
                    // §14.5: a long station name wraps rather than truncating.
                    .fixedSize(horizontal: false, vertical: true)
                // §7.4: the type is text, never only a symbol…
                if stop.stopType != "passenger_stop" {
                    Text(stopTypeName(stop.stopType))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                // …and `ride_segment == false` is spelled out rather than
                // being carried by opacity alone.
                if !stop.rideSegment {
                    Text(localization.editorText("ios.detail.notRidden"))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            timeColumn(stop)
        }
        .frame(minHeight: 44, alignment: .top)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: stop))
    }

    /// Arrival above departure, always in that order, trailing-aligned and
    /// monospaced (§7.4). Both slots keep their place even when one is empty,
    /// so the column does not reshuffle from row to row.
    private func timeColumn(_ stop: Stop) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            timeRow(stop.arrival, emphasised: true)
            timeRow(stop.departure, emphasised: false)
            if let platform = stop.platformNumber, platform >= 0 {
                platformBadge(platform)
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func timeRow(_ time: String?, emphasised: Bool) -> some View {
        if let time, !time.isEmpty {
            HStack(spacing: 4) {
                Text(time)
                    .font(emphasised ? .subheadline : .caption)
                    .monospacedDigit()
                    .foregroundStyle(emphasised ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                if Dates.isCrossDayTimeString(time) { nextDayTag }
            }
        }
    }

    private var nextDayTag: some View {
        Text(localization.editorText("ios.detail.nextDay"))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color.secondary.opacity(0.14), in: Capsule())
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
    }

    private func platformText(_ number: Int) -> String {
        localization.editorText(
            "ios.detail.platformValue", ["number": .number(Double(number))])
    }

    private func platformBadge(_ number: Int) -> some View {
        Text(platformText(number))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: Capsule(style: .continuous))
            .fixedSize(horizontal: true, vertical: false)
    }

    // MARK: - 4a. Hidden (§8.5)

    private var hiddenCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                localization.editorText("ios.detail.hiddenTitle"),
                systemImage: "eye.slash"
            )
            .font(.headline)
            Text(localization.editorText("ios.detail.hiddenDetail"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // §8.5: showing it again is the primary action while hidden.
            if let onSetVisible {
                Button(localization.editorText("ios.detail.showOnMap")) { onSetVisible(true) }
                    .buttonStyle(.borderedProminent)
                    .frame(minHeight: 44)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            surface,
            in: RoundedRectangle(
                cornerRadius: RailStyle.cardCornerRadius,
                style: .continuous))
    }

    // MARK: - 4b. Route state (§5.5)

    private var routeStateCard: some View {
        RideRouteStateCard(
            train: train,
            status: routeStatus ?? RideStatusCenter.shared.status(forTrainID: train.id),
            surface: surface,
            rebuiltSections: rebuiltSections,
            onRebuild: onRebuild.map { rebuildAction in
                {
                    if let sections = rebuildAction() {
                        rebuild = .done(sections: sections)
                    }
                }
            },
            onEditStops: onEditStops)
    }

    private var rebuiltSections: Int? {
        if case .done(let sections) = rebuild { return sections }
        return nil
    }

    // MARK: - 5. Service metadata

    private var serviceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(localization.editorText("ios.detail.service")).font(.headline)
            if let company = train.company, !company.isEmpty {
                LabeledContent(
                    localization.countryText("field.company", fallback: "Operator"), value: company)
            }
            if let type = train.trainType, !type.isEmpty {
                LabeledContent(
                    localization.countryText("field.trainType", fallback: "Train type"), value: type)
            }
            if let direction = train.direction, !direction.isEmpty {
                LabeledContent(
                    localization.countryText("field.direction", fallback: "Direction"),
                    value: direction)
            }
            LabeledContent(
                localization.text("ios.recordedStops", fallback: "Recorded stops"),
                value: train.stops.count.formatted()
            )
            LabeledContent(
                localization.text("ios.visibility", fallback: "Visibility"),
                value: train.visible == false
                    ? localization.countryText("state.hidden", fallback: "Hidden")
                    : localization.countryText("state.shown", fallback: "Shown")
            )
            // §5.4 wording: a specific verb, not "toggle display". Offered
            // only while the journey is shown — while it is hidden the same
            // action is the prominent one on the card above, and two copies of
            // one control on one screen is two answers to one question.
            if let onSetVisible, train.visible != false {
                Button(localization.editorText("ios.detail.hideFromMap"), systemImage: "eye.slash") {
                    onSetVisible(false)
                }
                .frame(minHeight: 44)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            surface,
            in: RoundedRectangle(
                cornerRadius: RailStyle.cardCornerRadius,
                style: .continuous))
    }

    // MARK: - 6. Advanced record details

    private var advancedCard: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                LabeledContent(
                    localization.countryText("field.id", fallback: "Identifier"), value: train.id)
                LabeledContent(
                    localization.text("ios.routePolicy", fallback: "Route policy"),
                    value: routePolicySummary)
                Divider()
                Text(
                    localization.editorText(
                        "ios.detail.routeSections",
                        ["count": .number(Double(train.routeSections?.count ?? 0))])
                )
                .font(.subheadline.weight(.semibold))
                if let sections = train.routeSections, !sections.isEmpty {
                    ForEach(Array(sections.enumerated()), id: \.offset) { index, section in
                        Text(sectionLabel(section, index: index))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text(localization.editorText("ios.detail.noRouteSections"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
        } label: {
            Text(localization.editorText("ios.detail.advanced")).font(.headline)
        }
        .padding(16)
        .background(
            surface,
            in: RoundedRectangle(
                cornerRadius: RailStyle.cardCornerRadius,
                style: .continuous))
    }

    private var routePolicySummary: String {
        guard let policy = train.routePolicy else {
            return localization.editorText("ios.editor.automatic")
        }
        switch policy.institutionFilterMode {
        case "hard": return localization.editorText("ios.editor.hardConstraint")
        case "soft": return localization.editorText("ios.editor.softPreference")
        default: return localization.editorText("ios.editor.automatic")
        }
    }

    private func sectionLabel(_ section: RouteSection, index: Int) -> String {
        localization.editorText(
            "ios.route.affectedSection",
            [
                "index": .number(Double(index + 1)),
                "from": .string(endpointName(section.from, code: section.fromN02StationCode, stopIndex: index)),
                "to": .string(endpointName(section.to, code: section.toN02StationCode, stopIndex: index + 1)),
            ])
    }

    /// A section endpoint the reader can recognise.
    ///
    /// `leanExportSection` drops an endpoint name whenever the station table
    /// can rebuild it from the code, so 1 861 of the committed Japanese
    /// sections carry no `from`/`to` at all. But the section list is one
    /// section per adjacent stop pair — `rideRouteSections` builds it that way
    /// — so section *i* is the stretch from `stops[i]` to `stops[i+1]`, and
    /// the stop the reader typed is a better name than a six-digit code.
    private func endpointName(_ name: String?, code: String?, stopIndex: Int) -> String {
        if let name, !name.isEmpty { return name }
        if train.stops.indices.contains(stopIndex), !train.stops[stopIndex].name.isEmpty {
            return train.stops[stopIndex].name
        }
        if let code, !code.isEmpty { return code }
        return localization.editorText("ios.route.unnamedStation")
    }

    // MARK: - Values

    private var riddenStops: [Stop] { train.stops.filter(\.rideSegment) }
    private var firstRiddenStop: Stop? { riddenStops.first ?? train.stops.first }
    private var lastRiddenStop: Stop? { riddenStops.last ?? train.stops.last }

    private var crossesMidnight: Bool {
        Dates.hasCrossDayTimes(train.forDates)
    }

    private func nextDayVoiceOver(_ time: String) -> String? {
        Dates.isCrossDayTimeString(time)
            ? localization.editorText("ios.detail.nextDay") : nil
    }

    private func symbol(for stop: Stop) -> String {
        switch stop.stopType {
        case "pass_through": "circle.dotted"
        case "origin", "destination": "circle.fill"
        default: "circle"
        }
    }

    private func stopTypeName(_ type: String) -> String {
        localization.countryText("stoptype.\(type)", fallback: type)
    }

    /// §7.4's reading order: 站名，类型，到达时间，出发时间，是否乘坐.
    private func accessibilityLabel(for stop: Stop) -> String {
        var values = [stop.name, stopTypeName(stop.stopType)]
        if let arrival = stop.arrival, !arrival.isEmpty {
            values.append(
                [
                    localization.countryText("popup.arrival", fallback: "arrival"), arrival,
                    nextDayVoiceOver(arrival),
                ].compactMap { $0 }.joined(separator: " "))
        }
        if let departure = stop.departure, !departure.isEmpty {
            values.append(
                [
                    localization.countryText("popup.departure", fallback: "departure"), departure,
                    nextDayVoiceOver(departure),
                ].compactMap { $0 }.joined(separator: " "))
        }
        values.append(
            "\(localization.countryText("popup.rideSegment", fallback: "ridden")): "
                + localization.countryText(
                    stop.rideSegment ? "popup.yes" : "popup.no",
                    fallback: stop.rideSegment ? "yes" : "no")
        )
        return values.joined(separator: ", ")
    }
}

// MARK: - Route state (§5.5, §8.4, §13.3)

/// The card that answers "路线是否可信，用户是否需要参与？".
///
/// Every failing state is written in §13.3's four parts, in this order:
///
///   title      发生了什么      "Route needs review"
///   detail     影响了什么      which sections did not draw, by name
///   kept       保留了什么      the record is unchanged, no straight line
///   actions    下一步          edit the stops first, rebuild second
///
/// The affected-section list is the part that could not exist before this
/// slice. `RiddenRouteStore` answered "did this journey draw?" with one bit,
/// so a six-section journey that drew four looked exactly like one that drew
/// six; `RouteOutcome.partial` now carries the stretches that did not, and
/// they are named here rather than summarised as "something failed".
private struct RideRouteStateCard: View {
    let train: Train
    let status: RideRouteStatus
    let surface: AnyShapeStyle
    /// Set once a rebuild has written sections back, so §8.4's "在原位置显示
    /// 完成状态" is an in-place line rather than an alert.
    let rebuiltSections: Int?
    let onRebuild: (() -> Void)?
    let onEditStops: (() -> Void)?

    @Environment(AppLocalization.self) private var localization

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !gaps.isEmpty { affectedSections }
            // §13.3 line three, and §1.1's promise: nothing was deleted and no
            // straight line stood in for railway.
            if status.isNoteworthy, status != .unknown, status != .resolving {
                Text(localization.editorText("ios.route.recordKept"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if status.blocksPlayback, status != .noRoute {
                Text(localization.editorText("ios.route.playbackBlocked"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            surface,
            in: RoundedRectangle(
                cornerRadius: RailStyle.cardCornerRadius,
                style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 8) {
            if isBusy {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol)
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.headline)
                .foregroundStyle(tint)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        // §10.2: the state changes under the reader while a solve runs.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isBusy ? .updatesFrequently : [])
    }

    private var affectedSections: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(localization.editorText("ios.route.affected"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(gaps, id: \.segmentIndex) { gap in
                Text(
                    localization.editorText(
                        "ios.route.affectedSection",
                        [
                            "index": .number(Double(gap.segmentIndex + 1)),
                            "from": .string(name(gap.from, stopIndex: gap.segmentIndex)),
                            "to": .string(name(gap.to, stopIndex: gap.segmentIndex + 1)),
                        ])
                )
                .font(.footnote)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            tint.opacity(0.12),
            in: RoundedRectangle(
                cornerRadius: RailStyle.controlCornerRadius,
                style: .continuous))
    }

    @ViewBuilder
    private var actions: some View {
        // §8.4: the explanation comes *before* the button, so a rebuild is
        // never a verb with no stated consequence.
        if onRebuild != nil {
            Text(localization.editorText("ios.route.rebuildExplain"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }

        VStack(alignment: .leading, spacing: 10) {
            // §8.4 / §5.5: for a route that needs a human decision, editing the
            // stops leads. Offering "retry" as the prominent action against a
            // solver that already failed on the same input is the dead loop the
            // spec names.
            if needsHumanFix, let onEditStops {
                Button(localization.editorText("ios.route.editStops"), systemImage: "list.bullet") {
                    onEditStops()
                }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: 44)
            }
            if let onRebuild {
                let button = Button(
                    localization.countryText("btn.rebuildRoute", fallback: "Rebuild route"),
                    systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                    action: onRebuild
                )
                .frame(minHeight: 44)
                .disabled(isBusy)
                // §3.1: exactly one filled button on a surface. When the stops
                // need a human decision, "Edit stops" above holds that slot.
                if prefersProminentRebuild {
                    button.buttonStyle(.borderedProminent)
                } else {
                    button.buttonStyle(.bordered)
                }
            }
            if needsHumanFix, onEditStops == nil, onRebuild == nil {
                Text(localization.editorText("ios.route.viewConstraints"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }

        if let rebuiltSections {
            // §8.4: "普通成功无需弹窗；在原位置显示完成状态".
            Text(
                localization.countryText(
                    "status.routeSectionsRebuilt",
                    params: ["count": .number(Double(rebuiltSections))],
                    fallback: "Rebuilt \(rebuiltSections) route sections.")
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    // MARK: - What the state says

    private var isBusy: Bool { status == .resolving || status == .unknown }

    private var needsHumanFix: Bool {
        switch status {
        case .needsReview, .unavailable, .noRoute: true
        default: false
        }
    }

    /// The rebuild is the prominent action only when nothing better is offered
    /// — §3.1 allows exactly one filled button on a surface.
    private var prefersProminentRebuild: Bool {
        !needsHumanFix || onEditStops == nil
    }

    private var title: String {
        switch status {
        case .unknown: localization.editorText("ios.route.preparing")
        case .resolving: localization.editorText("ios.route.resolving")
        case .resolved: localization.editorText("ios.route.resolved")
        case .needsReview: localization.editorText("ios.route.needsReview")
        case .unavailable: localization.editorText("ios.route.unavailable")
        case .noRoute: localization.editorText("ios.route.noSections")
        }
    }

    private var detail: String? {
        switch status {
        case .unknown:
            localization.editorText("ios.route.preparingDetail")
        case .resolving:
            localization.editorText("ios.route.resolvingDetail")
        case .resolved(let sections):
            localization.editorText(
                "ios.route.resolvedDetail", ["count": .number(Double(sections))])
        case .needsReview(let solved, let expected, _):
            localization.editorText(
                "ios.route.needsReviewDetail",
                ["solved": .number(Double(solved)), "expected": .number(Double(expected))])
        case .unavailable(let expected, let reason):
            // §13.3 line two — what it affected. A load failure carries its own
            // message; the ordinary "no path fits the constraints" case is said
            // in the catalog's words, which both apps already share.
            reason
                ?? (localization.editorText(
                    "ios.route.unavailableDetail", ["expected": .number(Double(expected))])
                    + "\n"
                    + localization.countryText("status.routeNoPath", fallback: ""))
        case .noRoute:
            localization.editorText("ios.route.noSectionsDetail")
        }
    }

    /// The stretches with no drawn railway.
    ///
    /// `partial` carries them; `unavailable` does not, because nothing solved
    /// and the store has no per-section answer to report — so the journey's own
    /// section list is what is affected, and it is read off the record here.
    private var gaps: [RiddenRouteStore.SectionGap] {
        switch status {
        case .needsReview(_, _, let gaps):
            return gaps
        case .unavailable:
            return (train.routeSections ?? []).enumerated().map { index, section in
                RiddenRouteStore.SectionGap(
                    segmentIndex: index, from: section.from, to: section.to)
            }
        default:
            return []
        }
    }

    private func name(_ value: String?, stopIndex: Int) -> String {
        if let value, !value.isEmpty { return value }
        if train.stops.indices.contains(stopIndex), !train.stops[stopIndex].name.isEmpty {
            return train.stops[stopIndex].name
        }
        return localization.editorText("ios.route.unnamedStation")
    }

    private var symbol: String {
        switch status {
        case .resolved: "checkmark.circle"
        case .needsReview: "exclamationmark.triangle"
        case .unavailable: "xmark.octagon"
        case .noRoute: "point.topleft.down.to.point.bottomright.curvepath"
        case .unknown, .resolving: "clock"
        }
    }

    /// §10.5: colour is the second encoding, never the only one — the title
    /// beside it already says the state in words.
    private var tint: Color {
        switch status {
        case .needsReview: .orange
        case .unavailable: .red
        default: .primary
        }
    }
}
