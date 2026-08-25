import RailCore
import SwiftUI

// MARK: - card chrome

extension View {
    /// One ordinary content card: §6.4's card radius on a system surface, one
    /// visual step above the panel so the group remains identifiable.
    ///
    /// The surface itself is spelled once, in ``PassportTone/plain``. The
    /// statistics screen now draws three tones of card (§6.1's Memory
    /// personality — see `PassportCardStyle.swift`), and two surfaces that
    /// agree only by coincidence are two that disagree after the next edit.
    /// Every non-statistics card in the Passport workspace keeps calling this
    /// name and keeps getting exactly the card it had.
    func statisticsCard() -> some View {
        passportCard(.plain)
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

// MARK: - metric row

/// One label and one figure, on a row.
///
/// Takes `metricValueStacked` rather than `metricValue`: nothing below this
/// re-lays it out, so the figure has to be allowed to wrap inside the card
/// rather than state a width the card cannot give it. (`metricValue` exists
/// for the opposite case — a `ViewThatFits` candidate, which has to state its
/// TRUE width or the arrangements below it are never reached. See `RailType`.)
struct StatisticsMetricRow: View {
    let label: String
    let value: String

    var body: some View {
        LabeledContent {
            Text(value)
                .font(.headline)
                .monospacedDigit()
                .railType(.metricValueStacked)
        } label: {
            Text(label)
                .foregroundStyle(.secondary)
                .railType(.metricLabel)
        }
    }
}
