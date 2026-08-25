import RailCore
import RailPresentation
import SwiftUI

// The §7 components, in the order the spec lists them: JourneySummary,
// RouteTiming, StatusBadge, QuietActionGroup.
//
// They all take a resolved `JourneyPresentation` rather than a train plus a
// pile of booleans. That is the point of Slice 1 existing: the question "is
// this surface about the journey, or about something that happened to it" is
// answered once, in a module with tests, and these views render the answer.

// MARK: - §7.5 StatusBadge

/// A capsule that says what state a journey is in.
///
/// Two rules from §7.5 are structural here rather than conventional: the
/// capsule always contains TEXT (`StatusPresentation.title` is not optional,
/// so there is no way to build a badge that is only a colour), and there is no
/// success badge — the resolver returns `status == nil` for a healthy journey,
/// so "路线正常" cannot be drawn even by accident.
struct JourneyStatusBadge: View {
    var status: StatusPresentation
    var compact = false

    @Environment(AppLocalization.self) private var localization
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Label {
            Text(localization.journeyText(status.title))
        } icon: {
            Image(systemName: status.tone.systemImage)
        }
        .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
        .labelStyle(.titleAndIcon)
        // A status is a sentence, not a label: at an accessibility size
        // 「路線未完成，6 段中 4 段」 needs more than three lines, and a status
        // that has been cut in half is the one piece of text on the card that
        // must not be guessed at (§14.4).
        .lineLimit(compact ? (dynamicTypeSize.isAccessibilitySize ? nil : 1) : 3)
        .multilineTextAlignment(.leading)
        .foregroundStyle(status.tone.color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background {
            if compact && dynamicTypeSize.isAccessibilitySize {
                RoundedRectangle(
                    cornerRadius: RailStyle.controlCornerRadius,
                    style: .continuous
                )
                .fill(status.tone.color.opacity(status.tone.fillOpacity))
            } else {
                Capsule()
                    .fill(status.tone.color.opacity(status.tone.fillOpacity))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// §5.2's 状态放大, in §13.3's order.
///
/// The four lines are the four fields, and they are in this order because the
/// spec puts them in it:
///
///   badge            发生了什么   `presentation.title`
///   affected         影响了什么   `presentation.subtitle`, when it is not just
///                                the journey's own endpoints
///   kept             保留了什么   `status.title`
///   detail                        `status.detail`
///
/// "保留了什么" is why this block exists at all rather than a toast: §3.1 says an
/// error that blocks the task must stay beside the content, and the sentence a
/// reader most needs after "路线无法绘制" is that their record is still there.
struct JourneyStateBlock: View {
    var presentation: JourneyPresentation

    @Environment(AppLocalization.self) private var localization

    /// Whether there is anything to draw. A healthy journey has neither a
    /// badge nor a status, and draws nothing at all.
    static func isPresent(_ presentation: JourneyPresentation) -> Bool {
        presentation.heroStatus != nil || presentation.status != nil
            || affected(presentation) != nil
    }

    /// The subtitle, unless it is the endpoints the Hero already shows in full
    /// above — repeating them would push the actual reason down the card.
    static func affected(_ presentation: JourneyPresentation) -> PresentationText? {
        guard let subtitle = presentation.subtitle else { return nil }
        guard subtitle.key != JourneyPresentationResolver.Keys.endpoints else { return nil }
        return subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let badge = presentation.heroStatus {
                JourneyStatusBadge(status: badge)
            }
            if let affected = Self.affected(presentation) {
                Text(localization.journeyText(affected))
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let status = presentation.status {
                Text(localization.journeyText(status.title))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = status.detail {
                    Text(localization.journeyText(detail))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            (presentation.status?.tone ?? .neutral).color
                .opacity((presentation.status?.tone ?? .neutral).fillOpacity * 0.55),
            // §6.4's radius-control. This block is a panel INSIDE a card, so
            // it takes the small token rather than the card one — the rule is
            // that radius expresses depth: small control < content card <
            // sheet, and a block nested in a card must not match the card.
            in: RoundedRectangle(
                cornerRadius: RailStyle.controlCornerRadius,
                style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - §7.3 RouteTiming

/// Origin and destination with their times, side by side or stacked.
///
/// §7.3 and §10.1 both require the stacked form: at an accessibility text size
/// the two station names cannot share a line, and the answer is a vertical
/// layout with a downward arrow — not a smaller font. `ViewThatFits` handles
/// the merely-narrow case; the accessibility size is decided outright, because
/// a name long enough to fit and short enough to be unreadable is exactly the
/// case `minimumScaleFactor` gets wrong.
///
/// Times are `monospacedDigit` (§14.2) and are never reformatted: `25:10` is a
/// business fact about an overnight service, and turning it into `01:10` on the
/// next date loses the thing the reader wrote down.
struct RouteTimingView: View {
    var origin: String
    var destination: String
    var departure: String?
    var arrival: String?
    var originPlatform: Int? = nil
    var destinationPlatform: Int? = nil

    @Environment(AppLocalization.self) private var localization

    var body: some View {
        ViewThatFits(in: .horizontal) {
            sideBySide
            stacked
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenSummary))
    }

    private var sideBySide: some View {
        HStack(alignment: .top, spacing: 12) {
            endpoint(origin, time: departure, platform: originPlatform, alignment: .leading)
            Image(systemName: "arrow.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
                .padding(.top, 2)
            endpoint(
                destination, time: arrival, platform: destinationPlatform,
                alignment: .trailing)
        }
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: 6) {
            endpoint(origin, time: departure, platform: originPlatform, alignment: .leading)
            Image(systemName: "arrow.down")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            endpoint(
                destination, time: arrival, platform: destinationPlatform,
                alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func endpoint(
        _ name: String, time: String?, platform: Int?, alignment: HorizontalAlignment
    ) -> some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(localization.stationName(name))
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(alignment == .trailing ? .trailing : .leading)
            if let time, !time.isEmpty {
                Text(time)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if let platform, platform >= 0 {
                platformBadge(platform)
            }
        }
        .frame(
            maxWidth: .infinity,
            alignment: alignment == .trailing ? .trailing : .leading)
    }

    /// §10.2: one journey reads as one sentence, not as four labels.
    private var spokenSummary: String {
        var parts = [localization.stationName(origin)]
        if let departure, !departure.isEmpty { parts.append(departure) }
        if let originPlatform, originPlatform >= 0 { parts.append(platformText(originPlatform)) }
        parts.append(localization.stationName(destination))
        if let arrival, !arrival.isEmpty { parts.append(arrival) }
        if let destinationPlatform, destinationPlatform >= 0 {
            parts.append(platformText(destinationPlatform))
        }
        return parts.joined(separator: ", ")
    }

    private func platformText(_ number: Int) -> String {
        localization.editorText(
            "ios.detail.platformValue", ["number": .number(Double(number))])
    }

    private func platformBadge(_ number: Int) -> some View {
        Text(platformText(number))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: Capsule(style: .continuous))
            .fixedSize(horizontal: true, vertical: false)
    }
}

// MARK: - §7.1 JourneySummary

/// One journey, as a list reads it.
///
/// The field order follows what a reader is choosing: quiet service metadata,
/// then the origin and destination as the visual title, then both endpoint
/// times, and finally state. The record ID never appears — §3.1 puts it in L4,
/// which is the detail screen.
struct JourneySummaryRow: View {
    var train: Train
    var presentation: JourneyPresentation
    var isSelected: Bool
    var showsDate: Bool

    @Environment(AppLocalization.self) private var localization
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                // At large text sizes the route is the decision, so it must
                // appear before service metadata that can span many lines.
                stationPair
                timingLine
                detailLine
            } else {
                detailLine
                stationPair
                timingLine
            }

            if let status = presentation.summaryStatus,
               status.title.key != JourneyPresentationResolver.Keys.hiddenTitle
            {
                JourneyStatusBadge(status: status, compact: true)
                    .padding(.top, 1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 38)
        .padding(.trailing, 12)
        .padding(.vertical, 11)
        .background(rowBackground)
        .overlay(alignment: .leading) {
            Capsule(style: .continuous)
                .fill(swatchColor)
                .frame(width: 8)
                .padding(.leading, 16)
                .padding(.vertical, 12)
                .accessibilityHidden(true)
        }
        .overlay {
            RoundedRectangle(cornerRadius: RailStyle.cardCornerRadius, style: .continuous)
                .strokeBorder(
                    isSelected ? Color.accentColor.opacity(0.55) : .clear,
                    lineWidth: 1.5)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    @ViewBuilder
    private var detailLine: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 5) {
                if showsDate { dateBadge }
                detail
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if showsDate { dateBadge }
                detail
            }
        }
    }

    private var detail: some View {
        Text(detailText)
            // The train number, type and operator identify the service, but
            // they are supporting detail rather than the decision the row is
            // for. The route below therefore owns the display weight.
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var stationPair: some View {
        if dynamicTypeSize.isAccessibilitySize {
            stackedStationPair
        } else {
            ViewThatFits(in: .horizontal) {
                horizontalStationPair
                stackedStationPair
            }
        }
    }

    private var horizontalStationPair: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            stationName(train.origin, lineLimit: 1)
            Image(systemName: "arrow.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            stationName(train.destination, lineLimit: 1)
        }
        // Make ViewThatFits compare the route's honest single-line width; if
        // it cannot fit, the vertical route below is clearer than compressing
        // or truncating either station name.
        .fixedSize(horizontal: true, vertical: false)
    }

    private var stackedStationPair: some View {
        VStack(alignment: .leading, spacing: 4) {
            stationName(train.origin, lineLimit: nil)
            Image(systemName: "arrow.down")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            stationName(train.destination, lineLimit: nil)
        }
    }

    private func stationName(_ name: String, lineLimit: Int?) -> some View {
        Text(localization.stationName(name))
            .font(.title3.weight(.bold))
            .lineLimit(lineLimit)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var timingLine: some View {
        if dynamicTypeSize.isAccessibilitySize {
            verticalTimingLine
        } else {
            ViewThatFits(in: .horizontal) {
                horizontalTimingLine
                verticalTimingLine
            }
        }
    }

    private var horizontalTimingLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            timeEndpoint(
                localization.countryText("tag.dep", fallback: "Dep"),
                time: departureTime,
                platform: train.stops.first?.platformNumber)
            Image(systemName: "arrow.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            timeEndpoint(
                localization.countryText("tag.arr", fallback: "Arr"),
                time: arrivalTime,
                platform: train.stops.last?.platformNumber)
            Text("·")
                .foregroundStyle(.tertiary)
            Text(stopCountText)
            Spacer(minLength: 0)
            visibilityBadge
                .fixedSize(horizontal: true, vertical: false)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private var verticalTimingLine: some View {
        VStack(alignment: .leading, spacing: 5) {
            timeEndpoint(
                localization.countryText("tag.dep", fallback: "Dep"),
                time: departureTime,
                platform: train.stops.first?.platformNumber)
            timeEndpoint(
                localization.countryText("tag.arr", fallback: "Arr"),
                time: arrivalTime,
                platform: train.stops.last?.platformNumber)
            HStack(spacing: 8) {
                Text(stopCountText)
                visibilityBadge
            }
        }
    }

    private func timeEndpoint(_ label: String, time: String?, platform: Int?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(label)
            Text(time ?? "—:—")
                .monospacedDigit()
                .foregroundStyle(.primary)
            if let platform, platform >= 0 {
                Text(
                    localization.editorText(
                        "ios.detail.platformValue",
                        ["number": .number(Double(platform))])
                )
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color(.tertiarySystemFill), in: Capsule(style: .continuous))
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private var dateBadge: some View {
        Text(dateText)
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: Capsule(style: .continuous))
            .fixedSize(horizontal: true, vertical: false)
    }

    private var visibilityBadge: some View {
        Text(
            train.visible == false
                ? localization.countryText("state.hidden", fallback: "Hidden")
                : localization.countryText("state.shown", fallback: "Shown")
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(Color(.tertiarySystemFill), in: Capsule(style: .continuous))
    }

    private var rowBackground: some View {
        RoundedRectangle(cornerRadius: RailStyle.cardCornerRadius, style: .continuous)
            .fill(isSelected ? Color.accentColor.opacity(0.14) : Color(.secondarySystemBackground))
            .overlay {
                RoundedRectangle(cornerRadius: RailStyle.cardCornerRadius, style: .continuous)
                    .strokeBorder(Color(.separator), lineWidth: 1)
            }
    }

    private var detailText: String {
        [train.number, typeCompanyText]
            .filter { !$0.isEmpty }
            .joined(separator: "  ")
    }

    private var dateText: String {
        guard let date = train.date, !date.isEmpty else { return Dates.undated }
        return date
    }

    private var typeCompanyText: String {
        [train.trainType, train.company]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " · ")
    }

    private var stopCountText: String {
        "\(train.stops.count) \(localization.countryText("unit.stops", fallback: "stops"))"
    }

    private var departureTime: String? {
        let time = train.stops.first?.departure ?? train.stops.first?.arrival
        guard let time, !time.isEmpty else { return nil }
        return time
    }

    private var arrivalTime: String? {
        let time = train.stops.last?.arrival ?? train.stops.last?.departure
        guard let time, !time.isEmpty else { return nil }
        return time
    }

    private var swatchColor: Color {
        if let color = train.style?.color, let resolved = Color(hex: color) {
            return resolved
        }
        return Color(hex: TrainValidation.defaultTrainColor) ?? .accentColor
    }
}

// MARK: - §7.6 QuietActionGroup

/// The one filled button, the quiet verbs beside it, and everything else in a
/// More menu.
///
/// The single-prominent-action rule of §3.1 is not enforced here by care: the
/// group takes `JourneyPresentation.primaryAction`, which is `Optional` and
/// singular, so there is no way to hand it two. An invalid edit draft resolves
/// to `nil` and the row correctly draws no filled button at all.
struct QuietActionGroup: View {
    var presentation: JourneyPresentation
    /// The selected-journey card keeps its four controls on one scan line:
    /// primary, playback, edit, then More. Other surfaces retain the stacked
    /// layout because their action sets are not constrained to those roles.
    var arrangesJourneyControlsInOneRow = false
    var perform: (JourneyPresentation.PrimaryAction) -> Void
    var performSecondary: (SecondaryAction) -> Void

    @Environment(AppLocalization.self) private var localization
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let quiet = presentation.secondaryActions.filter(\.showsInQuietRow)
        let more = presentation.secondaryActions.filter { !$0.showsInQuietRow }

        if arrangesJourneyControlsInOneRow && !dynamicTypeSize.isAccessibilitySize {
            // One scan line where one scan line fits, and something legible
            // where it does not.
            //
            // The row itself is right; what was wrong is that it could not
            // FAIL. `journeyRowQuietButton` carried `minimumScaleFactor`, so
            // the arrangement reported that it fitted at any width by
            // shrinking its own text — which is why a 300-point landscape
            // sidebar (§4.3) drew 「聚焦」 and 「播放」 as half words instead
            // of falling back to something that fits. `ViewThatFits` can only
            // choose between candidates that state their true width, so the
            // shrink is gone and the fallbacks are real:
            //
            //   1. every control labelled, on one line
            //   2. the primary keeps a SHORT label — 経路 / Focus / 聚焦 — and
            //      the quiet verbs become the icons they already are next to
            //      編集, which is the degradation a system toolbar makes when
            //      it narrows
            //
            // There is deliberately no third, stacked candidate at these text
            // sizes. A stacked group in a 300-point landscape sidebar puts its
            // second row under the floating tab bar, so "it fitted" was true
            // of the layout and false of the screen — a fallback that hides
            // three of the four controls is worse than the crowding it was
            // avoiding. Candidate 2 is four fixed-width controls and always
            // fits; stacking belongs to the accessibility sizes below, where
            // the panel is tall and the tab bar is not over the content.
            ViewThatFits(in: .horizontal) {
                journeyControlRow(quiet, more: more, labelsQuietActions: true)
                journeyControlRow(
                    quiet, more: more, labelsQuietActions: false, shortPrimary: true)
            }
        } else if arrangesJourneyControlsInOneRow {
            // An accessibility text size does not get a narrower font, it gets
            // the stacked layout. §10.1 asks the LAYOUT to follow the setting:
            // four controls cannot share a scan line at `accessibility5` at
            // any font this app is allowed to pick, so clamping the type here
            // would be answering a layout question by overruling the reader.
            stackedControls(quiet, more: more)
        } else {
            stackedControls(quiet, more: more)
        }
    }

    /// The component's original arrangement, and now also the last fallback
    /// for the one-row one.
    private func stackedControls(
        _ quiet: [SecondaryAction], more: [SecondaryAction]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let primary = presentation.primaryAction {
                primaryButton(primary)
            }
            if !quiet.isEmpty || !more.isEmpty {
                quietRow(quiet, more: more)
            }
        }
    }

    /// The four journey controls on one line: primary, playback, edit, More.
    ///
    /// `labelsQuietActions` is the single knob between the two one-line
    /// candidates — with it the quiet verbs carry their words, without it they
    /// are icons. The primary keeps its label either way: §3.1 gives a surface
    /// one filled action, and an unlabelled one is a filled button that does
    /// not say what it does.
    private func journeyControlRow(
        _ quiet: [SecondaryAction], more: [SecondaryAction],
        labelsQuietActions: Bool, shortPrimary: Bool = false
    ) -> some View {
        HStack(spacing: 8) {
            if let primary = presentation.primaryAction {
                primaryButton(primary, short: shortPrimary)
                    .layoutPriority(1)
            }
            ForEach(quiet, id: \.self) { action in
                if action == .edit || !labelsQuietActions {
                    journeyRowIconButton(action)
                } else {
                    journeyRowQuietButton(action)
                        .layoutPriority(1)
                }
            }
            if !more.isEmpty { journeyRowMoreMenu(more) }
        }
        // Optical centring, not layout centring — see `trailingHitSlack`.
        .padding(.leading, trailingHitSlack(quiet, more: more,
                                            labelsQuietActions: labelsQuietActions))
        // Centred, not leading. These four controls are a group that sizes to
        // its own content, so a leading row left a ragged strip of empty card
        // to the right of More that read as a fifth control missing from the
        // line. The row's own width is the same either way — only where the
        // slack goes changes — and splitting it evenly makes the group read as
        // one unit belonging to the card rather than one edge of it.
        .frame(maxWidth: .infinity, alignment: .center)
    }

    /// The transparent slack the row's LAST control carries outside its own
    /// ink, when that control is one of the circles.
    ///
    /// `journeyRowIcon` draws a 34-point circle inside a 44-point hit frame,
    /// so a row ending in one is 5 points wider than it looks while the filled
    /// pill that starts it is exactly as wide as its ink. Centring the layout
    /// box therefore lands the visible group 2.5 points left of the card's
    /// middle — measured, not assumed: 31 points of card to the left of the
    /// pill against 38 to the right of More. Padding the leading edge by the
    /// same slack moves the centre back by half of it and the ink is centred.
    ///
    /// Returned as 0 when the row ends in a labelled button, which states its
    /// true width: the compensation exists for the circles, and applying it
    /// unconditionally would push those rows off-centre in the other
    /// direction.
    private func trailingHitSlack(
        _ quiet: [SecondaryAction], more: [SecondaryAction], labelsQuietActions: Bool
    ) -> CGFloat {
        let endsInCircle =
            !more.isEmpty || quiet.last.map { $0 == .edit || !labelsQuietActions } == true
        guard endsInCircle else { return 0 }
        return (44 - SheetIconButton<Image>.visualSide) / 2
    }

    private func primaryButton(
        _ action: JourneyPresentation.PrimaryAction, short: Bool = false
    ) -> some View {
        let appearance = action.appearance(localization)
        let title = short ? appearance.shortLabel : appearance.label
        return Button { perform(action) } label: {
            Label(title, systemImage: appearance.systemImage)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                // States its TRUE width. Without this the label truncates to
                // whatever it is offered, so the full-label candidate below
                // reported that it fitted a 300-point sidebar by cutting its
                // own verb in half — and `ViewThatFits`, told that the first
                // candidate fits, never reached the short one.
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 2)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.regular)
        // A compact visual button with the same 44-point landing area as the
        // header icons. The action stays easy to hit without reading as a
        // full-width call-to-action that overwhelms the journey itself.
        .frame(height: 44)
        .contentShape(.rect)
        .accessibilityLabel(Text(appearance.label))
        // Which action this IS varies by state — 経路 / 播放 / 聚焦 — and its
        // label is the reader's language on top of that, so a harness has no
        // string to look it up by. `ConsoleSweepTests` tried three English ones
        // and silently walked past the journey card on every non-English
        // simulator; the identifier is what the resolver's choice can be
        // reached through without naming it.
        .accessibilityIdentifier("journeyPrimaryAction")
    }

    /// The playback control uses the same system geometry as the prominent
    /// control beside it. Only emphasis differs; height, type and insets do
    /// not, so the row reads as one control family.
    private func journeyRowQuietButton(_ action: SecondaryAction) -> some View {
        let appearance = action.appearance(localization)
        return Button { performSecondary(action) } label: {
            Label(appearance.label, systemImage: appearance.systemImage)
                .font(.footnote.weight(.semibold))
                // No `minimumScaleFactor`. It is what let this button report
                // that it fitted any width by shrinking its own text, which
                // made the `ViewThatFits` above unable to ever reject the
                // one-line arrangement. A control that states its true width
                // is what lets the layout degrade instead of the type.
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 2)
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .frame(height: 44)
        .contentShape(.rect)
        .accessibilityLabel(Text(appearance.label))
    }

    @ViewBuilder
    private func quietRow(_ quiet: [SecondaryAction], more: [SecondaryAction]) -> some View {
        HStack(spacing: 8) {
            ForEach(quiet, id: \.self) { quietButton($0) }
            if !more.isEmpty { moreMenu(more) }
        }
    }

    private func quietButton(_ action: SecondaryAction) -> some View {
        let appearance = action.appearance(localization)
        return Button { performSecondary(action) } label: {
            Label(appearance.label, systemImage: appearance.systemImage)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(Text(appearance.label))
    }

    private func journeyRowIconButton(_ action: SecondaryAction) -> some View {
        let appearance = action.appearance(localization)
        return Button {
            performSecondary(action)
        } label: {
            journeyRowIcon(appearance.systemImage)
                .accessibilityHidden(true)
        }
        .buttonStyle(RailPressStyle())
        .accessibilityLabel(Text(appearance.label))
    }

    private func journeyRowMoreMenu(_ actions: [SecondaryAction]) -> some View {
        Menu {
            menuItems(actions)
        } label: {
            journeyRowIcon("ellipsis")
        }
        // The same feedback as `journeyRowIconButton` beside it. These two are
        // the same circle at the same size in the same row, and `.plain` gave
        // one of them a press and the other nothing — things that look alike
        // have to behave alike, or the row teaches the reader that its own
        // controls are inconsistent.
        .buttonStyle(RailPressStyle())
        .accessibilityLabel(
            Text(localization.journeyText("ios.journey.moreActions", fallback: "More")))
    }

    /// Icon-only controls share the text buttons' 34-point visual height and
    /// the row's 44-point hit height. Accent-coloured glyphs match the quiet
    /// playback button while the neutral fill keeps the primary action unique.
    private func journeyRowIcon(_ systemImage: String) -> some View {
        Image(systemName: systemImage)
            // A fixed point size, not `.subheadline`. A text style scales with
            // Dynamic Type and this glyph lives in a 34-point circle that does
            // not, so at an accessibility size the icon grew straight out of
            // its own shape. `MapControlBar.ControlButton` fixes its glyph for
            // exactly this reason: a control's meaning and its 44-point target
            // do not get clearer by doubling the mark inside it.
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .frame(
                width: SheetIconButton<Image>.visualSide,
                height: SheetIconButton<Image>.visualSide)
            .background(.quaternary.opacity(0.5), in: Circle())
            .overlay { Circle().stroke(Color.primary.opacity(0.06), lineWidth: 0.5) }
            .frame(width: 44, height: 44)
            .contentShape(.rect)
    }

    private func moreMenu(_ actions: [SecondaryAction]) -> some View {
        Menu {
            menuItems(actions)
        } label: {
            Label(
                localization.journeyText("ios.journey.moreActions", fallback: "More"),
                systemImage: "ellipsis"
            )
            .labelStyle(.iconOnly)
            .font(.footnote.weight(.semibold))
            .frame(minWidth: 44)
            .padding(.vertical, 10)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(
            Text(localization.journeyText("ios.journey.moreActions", fallback: "More")))
    }

    @ViewBuilder
    private func menuItems(_ actions: [SecondaryAction]) -> some View {
        // §5.2: destructive last, and with the role, so the system draws it
        // the way readers already expect a delete to be drawn.
        ForEach(actions.filter { !$0.appearance(localization).isDestructive }, id: \.self) {
            menuButton($0)
        }
        let destructive = actions.filter { $0.appearance(localization).isDestructive }
        if !destructive.isEmpty {
            Divider()
            ForEach(destructive, id: \.self) { menuButton($0) }
        }
    }

    private func menuButton(_ action: SecondaryAction) -> some View {
        let appearance = action.appearance(localization)
        return Button(role: appearance.isDestructive ? .destructive : nil) {
            performSecondary(action)
        } label: {
            Label(appearance.label, systemImage: appearance.systemImage)
        }
    }
}

// MARK: - what a compact summary shows of a resolved surface

extension JourneyPresentation {

    /// The state a Hero amplifies (§5.2), or `nil` when there is nothing to
    /// explain.
    ///
    /// The test is structural rather than a second priority chain: the resolver
    /// returns a *record value* title (the train number, `key == nil`) exactly
    /// when the surface is about the journey itself, and a catalog key when it
    /// is about something that happened to it. So a healthy journey can never
    /// grow a badge here — §7.5's "`resolved`、`normal` 之类成功状态不应在每个
    /// 卡片永久显示" holds without this view knowing what `resolved` is.
    var heroStatus: StatusPresentation? {
        guard title.key != nil else { return nil }
        return StatusPresentation(title: title, tone: status?.tone ?? .neutral)
    }

    /// The same state, as a dense list row shows it — which is not always.
    ///
    /// While the route store is working, EVERY journey is in the same
    /// preparing/resolving state at once, and two hundred identical grey pills
    /// carry no information the workspace's own progress line does not carry
    /// once. §7.5 asks a badge to appear "只在状态对决策有帮助时".
    ///
    /// The filter is again structural, not a second chain: the resolver leaves
    /// `primaryAction` empty exactly for the states where there is nothing for
    /// the reader to do yet (§13.2 — offering "Rebuild" against a solve already
    /// running is a second answer to one question). So a neutral state with no
    /// action is the transient one, and everything else — hidden, playing,
    /// needs review, unavailable — still says so in the row.
    var summaryStatus: StatusPresentation? {
        guard let hero = heroStatus else { return nil }
        guard hero.tone != .neutral || primaryAction != nil else { return nil }
        return hero
    }
}
