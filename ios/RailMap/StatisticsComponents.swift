import RailCore
import SwiftUI

// MARK: - card chrome

extension View {
    /// One statistics card. §6.4's card radius, and a background that is a
    /// surface rather than a colour, so Increase Contrast and the dark
    /// appearance both stay the system's business.
    func statisticsCard() -> some View {
        self
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

// MARK: - §7.8 ProgressSummary

/// What is being computed, how far it has got, and whether the reader has to
/// wait for it.
///
/// §13.2: this is only ever mounted once the work has been running for about
/// 400 ms, so a fast recompute does not flash a spinner. The caller owns that
/// delay because it also owns the answer this replaces.
struct StatisticsProgressSummary: View {
    @Environment(AppLocalization.self) private var localization
    let progress: MileageStatisticsStore.Progress

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text(localization.statsText("ios.stats.calculating"))
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
            }
            Text(localization.statsText(progress.stage.localizationKey))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let completed = progress.completed, let total = progress.total, total > 0 {
                ProgressView(value: Double(min(completed, total)), total: Double(total))
                Text(countLabel(completed: completed, total: total))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if progress.interactionContinues {
                Text(localization.statsText("ios.stats.keepUsing"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .statisticsCard()
        .accessibilityElement(children: .combine)
    }

    private func countLabel(completed: Int, total: Int) -> String {
        localization.statsText(
            "ios.stats.matchedOf",
            params: ["done": .number(Double(completed)), "total": .number(Double(total))])
    }
}

// MARK: - the one bar the whole panel is drawn with

/// A labelled proportion bar.
///
/// §5.7 and §6.2: the fill is the tint role, never the positive/green one — a
/// large number is not a success state. §10.2: the figure is always spelled
/// out next to the bar, and the whole row reads to VoiceOver as one sentence
/// carrying the same numbers, so the chart is never the only place a value
/// exists.
struct StatisticsBar: View {
    let label: String
    /// The number shown at the trailing edge of the head row.
    let value: String
    /// The line under the bar — usually "ridden / total km".
    var detail: String?
    /// 0…1.
    let fraction: Double
    /// The whole row, spoken.
    let spoken: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Text(value)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
            }
            GeometryReader { geometry in
                Capsule()
                    .fill(Color.secondary.opacity(0.14))
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(Color.accentColor)
                            .frame(width: geometry.size.width * clamped)
                    }
            }
            .frame(height: 7)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(label))
        .accessibilityValue(Text(spoken))
    }

    private var clamped: CGFloat {
        guard fraction.isFinite else { return 0 }
        return CGFloat(min(max(fraction, 0), 1))
    }
}

// MARK: - metric tiles

/// One figure with its caption.
///
/// §10.1: at an accessibility text size the caller lays these out vertically
/// instead of shrinking them, so nothing is solved by making the number
/// smaller. `minimumScaleFactor` is therefore absent by design.
struct StatisticsMetric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title3.bold())
                .monospacedDigit()
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

struct StatisticsMetricRow: View {
    let label: String
    let value: String

    var body: some View {
        LabeledContent {
            Text(value).font(.headline).monospacedDigit()
        } label: {
            Text(label).foregroundStyle(.secondary)
        }
    }
}

/// Four figures across, two by two, or stacked — whichever the current text
/// size actually fits (§10.1).
struct StatisticsMetricGrid: View {
    struct Item: Identifiable {
        let label: String
        let value: String
        var id: String { label }

        init(_ label: String, _ value: String) {
            self.label = label
            self.value = value
        }
    }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let items: [Item]

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            column
        } else {
            ViewThatFits(in: .horizontal) {
                row
                pairs
                column
            }
        }
    }

    private var row: some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { index in
                if index > 0 { Divider().frame(height: 44) }
                StatisticsMetric(label: items[index].label, value: items[index].value)
            }
        }
    }

    private var pairs: some View {
        VStack(spacing: 14) {
            ForEach(Array(stride(from: 0, to: items.count, by: 2)), id: \.self) { start in
                HStack(spacing: 0) {
                    StatisticsMetric(
                        label: items[start].label, value: items[start].value)
                    if start + 1 < items.count {
                        Divider().frame(height: 44)
                        StatisticsMetric(
                            label: items[start + 1].label, value: items[start + 1].value)
                    }
                }
            }
        }
    }

    private var column: some View {
        VStack(spacing: 12) {
            ForEach(items.indices, id: \.self) { index in
                if index > 0 { Divider() }
                StatisticsMetricRow(label: items[index].label, value: items[index].value)
            }
        }
    }
}
