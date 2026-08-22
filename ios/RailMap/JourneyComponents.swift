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

    var body: some View {
        Label {
            Text(localization.journeyText(status.title))
        } icon: {
            Image(systemName: status.tone.systemImage)
        }
        .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
        .labelStyle(.titleAndIcon)
        .lineLimit(compact ? 1 : 3)
        .multilineTextAlignment(.leading)
        .foregroundStyle(status.tone.color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(status.tone.color.opacity(status.tone.fillOpacity), in: Capsule())
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
            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(AppLocalization.self) private var localization

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                stacked
            } else {
                ViewThatFits(in: .horizontal) {
                    sideBySide
                    stacked
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenSummary))
    }

    private var sideBySide: some View {
        HStack(alignment: .top, spacing: 12) {
            endpoint(origin, time: departure, alignment: .leading)
            Image(systemName: "arrow.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
                .padding(.top, 2)
            endpoint(destination, time: arrival, alignment: .trailing)
        }
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: 6) {
            endpoint(origin, time: departure, alignment: .leading)
            Image(systemName: "arrow.down")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            endpoint(destination, time: arrival, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func endpoint(
        _ name: String, time: String?, alignment: HorizontalAlignment
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
        }
        .frame(
            maxWidth: .infinity,
            alignment: alignment == .trailing ? .trailing : .leading)
    }

    /// §10.2: one journey reads as one sentence, not as four labels.
    private var spokenSummary: String {
        var parts = [localization.stationName(origin)]
        if let departure, !departure.isEmpty { parts.append(departure) }
        parts.append(localization.stationName(destination))
        if let arrival, !arrival.isEmpty { parts.append(arrival) }
        return parts.joined(separator: ", ")
    }
}

// MARK: - §7.1 JourneySummary

/// One journey, as a list reads it.
///
/// The field order is §3.2's scan order and is the same at every density:
/// number, then the station pair, then the first departure, then date / type /
/// operator, then state. The record ID never appears — §3.2 forbids it above
/// the number and §3.1 puts it in L4, which is the detail screen.
struct JourneySummaryRow: View {
    var train: Train
    var presentation: JourneyPresentation
    var isSelected: Bool
    var showsDate: Bool

    @Environment(AppLocalization.self) private var localization

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    identity
                    Spacer(minLength: 8)
                    departure
                }
                VStack(alignment: .leading, spacing: 4) {
                    identity
                    departure
                }
            }

            HStack(spacing: 5) {
                Text(localization.stationName(train.origin))
                Image(systemName: "arrow.right")
                    .imageScale(.small)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
                Text(localization.stationName(train.destination))
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            if !metadata.isEmpty {
                Text(metadata.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }

            // §5.1: a hidden record says so in words. It is NOT drawn at a low
            // enough opacity to be hard to read — the reader hid it from the
            // map, not from themselves.
            if let status = presentation.summaryStatus {
                JourneyStatusBadge(status: status, compact: true)
                    .padding(.top, 1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(rowBackground)
        .overlay {
            // §14.2: selection is more than a colour.
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    isSelected ? Color.accentColor.opacity(0.55) : .clear,
                    lineWidth: 1.5)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private var identity: some View {
        Text(train.number)
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var departure: some View {
        if let time = departureTime {
            Text(time)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
    }

    /// A translucent fill, not `secondarySystemGroupedBackground`.
    ///
    /// That colour is the right one for a row on an opaque grouped screen and
    /// the wrong one here: this row sits on the glass panel, and an opaque fill
    /// over glass is a slab that reads as pure black in dark mode — it paints
    /// over the very translucency the panel exists to have. A tint of the
    /// foreground colour keeps the row legible as a row while the map still
    /// shows through it, and it follows the theme without naming either end.
    private var rowBackground: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(
                isSelected
                    ? AnyShapeStyle(Color.accentColor.opacity(0.18))
                    : AnyShapeStyle(Color.primary.opacity(0.05)))
    }

    private var metadata: [String] {
        var parts: [String] = []
        if showsDate, let date = train.date, !date.isEmpty { parts.append(date) }
        if let type = train.trainType, !type.isEmpty { parts.append(type) }
        if let company = train.company, !company.isEmpty { parts.append(company) }
        parts.append(
            "\(train.stops.count) \(localization.countryText("unit.stops", fallback: "stops"))")
        return parts
    }

    private var departureTime: String? {
        let time = train.stops.first?.departure ?? train.stops.first?.arrival
        guard let time, !time.isEmpty else { return nil }
        return time
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
    var perform: (JourneyPresentation.PrimaryAction) -> Void
    var performSecondary: (SecondaryAction) -> Void

    @Environment(AppLocalization.self) private var localization
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let quiet = presentation.secondaryActions.filter(\.showsInQuietRow)
        let more = presentation.secondaryActions.filter { !$0.showsInQuietRow }

        VStack(spacing: 8) {
            if let primary = presentation.primaryAction {
                primaryButton(primary)
            }
            if !quiet.isEmpty || !more.isEmpty {
                quietRow(quiet, more: more)
            }
        }
    }

    private func primaryButton(
        _ action: JourneyPresentation.PrimaryAction
    ) -> some View {
        let appearance = action.appearance(localization)
        return Button { perform(action) } label: {
            Label(appearance.label, systemImage: appearance.systemImage)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .accessibilityLabel(Text(appearance.label))
    }

    @ViewBuilder
    private func quietRow(_ quiet: [SecondaryAction], more: [SecondaryAction]) -> some View {
        // At an accessibility size three side-by-side labels are three
        // truncated words; §10.1 says the answer is more room, not less type.
        let stacks = dynamicTypeSize.isAccessibilitySize
        Group {
            if stacks {
                VStack(spacing: 8) {
                    ForEach(quiet, id: \.self) { quietButton($0) }
                    if !more.isEmpty { moreMenu(more).frame(maxWidth: .infinity) }
                }
            } else {
                HStack(spacing: 8) {
                    ForEach(quiet, id: \.self) { quietButton($0) }
                    if !more.isEmpty { moreMenu(more) }
                }
            }
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

    private func moreMenu(_ actions: [SecondaryAction]) -> some View {
        Menu {
            // §5.2: destructive last, and with the role, so the system draws
            // it the way readers already expect a delete to be drawn.
            ForEach(actions.filter { !$0.appearance(localization).isDestructive }, id: \.self) {
                menuButton($0)
            }
            let destructive = actions.filter { $0.appearance(localization).isDestructive }
            if !destructive.isEmpty {
                Divider()
                ForEach(destructive, id: \.self) { menuButton($0) }
            }
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
