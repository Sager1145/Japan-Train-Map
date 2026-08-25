import RailCore
import RailPresentation
import SwiftUI

/// §5.3.4 — the journeys the numbers above are made of, by date.
///
/// Two rules make this a log rather than a second journey list:
///
/// **It opens the same detail.** §5.3.4 requires the existing `RideDetailView`
/// and the existing record id — not a Passport-only copy of either. A second
/// detail view is a second place for the same record to be rendered wrong, and
/// a second selection is a second thing for the map to disagree with.
///
/// **It carries no verbs.** The list in Journeys owns create, duplicate,
/// reorder, hide and delete. Passport is the recollection surface: the only
/// thing to do with a row here is look at it, or watch it again. Anything more
/// would make this the journeys list with a different heading.
struct PassportJourneyLogView: View {
    @Environment(AppLocalization.self) private var localization

    var days: [ItineraryStore.Loaded.Day]
    var selectedTrainID: String?
    var presentation: (Train) -> JourneyPresentation
    var onSelect: (Train) -> Void
    var onReplay: (Train) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(
                localization.text("grp.journeyLog", fallback: "Journey log"),
                systemImage: "list.bullet.rectangle")
                .font(.headline)

            if days.isEmpty {
                // §13.1: an empty scope says which scope is empty, and offers
                // nothing — the way out is the scope control above, not a
                // button here that would duplicate it.
                Text(localization.text(
                    "passport.logEmpty",
                    fallback: "No journeys are recorded in this scope."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(days) { day in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(dateLabel(day.date))
                            .font(.footnote.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .accessibilityAddTraits(.isHeader)

                        ForEach(day.trains, id: \.id) { train in
                            row(train)
                        }
                    }
                }
            }
        }
        .statisticsCard()
        .accessibilityElement(children: .contain)
    }

    private func row(_ train: Train) -> some View {
        Button {
            onSelect(train)
        } label: {
            JourneySummaryRow(
                train: train,
                presentation: presentation(train),
                isSelected: train.id == selectedTrainID,
                // The date is the section header two lines up; repeating it on
                // every row is §3.2's scan order with a redundant first item.
                showsDate: false)
        }
        // §14.3, and the same row as the journeys list — so the same feedback.
        // See `RailRowPressStyle` for why a row darkens rather than shrinks.
        .buttonStyle(RailRowPressStyle())
        .contextMenu {
            Button {
                onReplay(train)
            } label: {
                Label(
                    localization.countryText("btn.play", fallback: "Play"),
                    systemImage: "play.fill")
            }
        }
    }

    /// The two sentinels need a word; a real date labels itself.
    private func dateLabel(_ date: String) -> String {
        let key = Dates.dateLabelKey(date)
        return localization.text(key, fallback: date)
    }
}
