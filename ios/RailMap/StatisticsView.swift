import RailCore
import SwiftUI

/// The 里程統計 workspace. Split out of `AppShell.swift` so the four top-level
/// destinations are four files: the shell owns navigation, each destination
/// owns its own screen — which is also what lets them be worked on at once.
struct StatisticsDashboardView: View {
    @Environment(AppLocalization.self) private var localization
    @Bindable var itineraries: ItineraryStore
    @Bindable var statistics: MileageStatisticsStore
    let country: String

    var body: some View {
        Group {
            if let loaded = itineraries.loaded {
                ScrollView {
                    LazyVStack(spacing: 16) {
                        journeyHero(loaded)
                        overviewCard(loaded)
                        mileageCard
                        coverageCard
                        serviceMixCard(loaded.trains)
                        topSegmentsCard
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 110)
                }
                .background(Color(.systemGroupedBackground))
            } else {
                ProgressView("Reading journeys…")
            }
        }
        .navigationTitle(localization.text("ios.statistics", fallback: "Statistics"))
    }

    private func journeyHero(_ loaded: ItineraryStore.Loaded) -> some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(localization.text("ios.recordedJourneys", fallback: "Recorded journeys"))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(loaded.trains.count, format: .number)
                    .font(.system(size: 52, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.7)
                    .contentTransition(.numericText())
                Text(regionName)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Image(systemName: "tram.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: 64, height: 64)
                .background(Color.accentColor.opacity(0.12), in: Circle())
                .accessibilityHidden(true)
        }
        .padding(20)
        .background(.background, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func overviewCard(_ loaded: ItineraryStore.Loaded) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(localization.text("ios.overview", fallback: "Overview"), systemImage: "calendar.badge.clock")
                .font(.headline)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 0) {
                    metric(localization.text("ios.travelDays", fallback: "Travel days"), value: loaded.days.count.formatted())
                    Divider().frame(height: 44)
                    metric(localization.text("ios.stops", fallback: "Stops"), value: stopCount(loaded.trains).formatted())
                    Divider().frame(height: 44)
                    metric(localization.text("ios.rideTime", fallback: "Ride time"), value: rideTime(loaded.trains))
                }

                VStack(spacing: 12) {
                    metricRow(localization.text("ios.travelDays", fallback: "Travel days"), value: loaded.days.count.formatted())
                    Divider()
                    metricRow(localization.text("ios.stops", fallback: "Stops"), value: stopCount(loaded.trains).formatted())
                    Divider()
                    metricRow(localization.text("ios.rideTime", fallback: "Ride time"), value: rideTime(loaded.trains))
                }
            }
        }
        .padding(18)
        .background(.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func metric(_ label: String, value: String) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title3.bold())
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func metricRow(_ label: String, value: String) -> some View {
        LabeledContent {
            Text(value).font(.headline).monospacedDigit()
        } label: {
            Text(label).foregroundStyle(.secondary)
        }
    }

    private func serviceMixCard(_ trains: [Train]) -> some View {
        let rows = serviceRows(trains)
        return VStack(alignment: .leading, spacing: 16) {
            Label(localization.text("ios.serviceMix", fallback: "Service mix"), systemImage: "chart.bar.fill")
                .font(.headline)
            ForEach(Array(rows.enumerated()), id: \.element.label) { index, row in
                VStack(spacing: 7) {
                    HStack {
                        Text(localization.text(row.label, fallback: row.label))
                        Spacer()
                        Text(row.count, format: .number)
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                    }
                    GeometryReader { geometry in
                        Capsule()
                            .fill(Color.secondary.opacity(0.12))
                            .overlay(alignment: .leading) {
                                Capsule()
                                    .fill(Color.accentColor.opacity(1 - Double(index) * 0.2))
                                    .frame(
                                        width: geometry.size.width
                                            * CGFloat(row.count) / CGFloat(max(trains.count, 1))
                                    )
                            }
                    }
                    .frame(height: 7)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(
                    Text("\(row.count) of \(trains.count) journeys")
                )
            }
        }
        .padding(18)
        .background(.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    @ViewBuilder
    private var mileageCard: some View {
        if let stats = statistics.view?.overall {
            VStack(alignment: .leading, spacing: 14) {
                Label(localization.text("ios.mileageCoverage", fallback: "Mileage and coverage"), systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    .font(.headline)
                HStack(alignment: .firstTextBaseline) {
                    Text(stats.riddenAll, format: .number.precision(.fractionLength(1)))
                        .font(.system(size: 38, weight: .bold, design: .rounded))
                        .contentTransition(.numericText())
                    Text("km").font(.headline).foregroundStyle(.secondary)
                    Spacer()
                }
                if stats.unmatchedKm > 0.01 {
                    Text(localization.text(
                        "ios.unmatchedDistance",
                        params: ["km": .string(stats.unmatchedKm.formatted(.number.precision(.fractionLength(1))))],
                        fallback: "\(stats.unmatchedKm.formatted(.number.precision(.fractionLength(1)))) km unmatched"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(18)
            .background(.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        } else {
            HStack(spacing: 12) {
                ProgressView()
                Text(localization.text("ios.mileageCoverage", fallback: "Calculating mileage and coverage…"))
                    .foregroundStyle(.secondary)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    @ViewBuilder
    private var coverageCard: some View {
        if let view = statistics.view {
            VStack(alignment: .leading, spacing: 16) {
                Label(localization.text("ios.networkCoverage", fallback: "Network coverage"), systemImage: "chart.bar.xaxis")
                    .font(.headline)
                ForEach(view.categories, id: \.mask) { category in
                    let ridden = view.overall.riddenByMask[category.mask] ?? 0
                    let total = edgeTotal(for: category.mask)
                    let fraction = total > 0 ? min(max(ridden / total, 0), 1) : 0
                    let lines = lineCoverageRows(
                        mask: category.mask,
                        includeUnridden: category.mask == Statistics.maskHSR
                            || category.mask == Statistics.maskMETRO)
                    VStack(spacing: 7) {
                        HStack {
                            Text(localization.text(category.i18n, fallback: category.i18n))
                            Spacer()
                            Text(fraction, format: .percent.precision(.fractionLength(1)))
                                .font(.subheadline.weight(.semibold)).monospacedDigit()
                        }
                        GeometryReader { geometry in
                            Capsule().fill(Color.secondary.opacity(0.12))
                                .overlay(alignment: .leading) {
                                    Capsule().fill(Color.accentColor)
                                        .frame(width: geometry.size.width * CGFloat(fraction))
                                }
                        }
                        .frame(height: 7)
                        Text("\(ridden.formatted(.number.precision(.fractionLength(1)))) / \(total.formatted(.number.precision(.fractionLength(1)))) km")
                            .font(.caption).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !lines.isEmpty {
                            DisclosureGroup {
                                VStack(spacing: 12) {
                                    ForEach(lines) { line in
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack(alignment: .firstTextBaseline) {
                                                VStack(alignment: .leading, spacing: 1) {
                                                    if !line.operatorName.isEmpty {
                                                        Text(line.operatorName)
                                                            .font(.caption2)
                                                            .foregroundStyle(.tertiary)
                                                    }
                                                    Text(line.name).font(.caption.weight(.medium))
                                                }
                                                Spacer()
                                                Text(line.fraction, format: .percent.precision(.fractionLength(1)))
                                                    .font(.caption.weight(.semibold))
                                                    .monospacedDigit()
                                            }
                                            Text("\(line.ridden.formatted(.number.precision(.fractionLength(1)))) / \(line.total.formatted(.number.precision(.fractionLength(1)))) km")
                                                .font(.caption2).foregroundStyle(.secondary)
                                        }
                                        .accessibilityElement(children: .combine)
                                    }
                                }
                                .padding(.top, 8)
                            } label: {
                                Text(localization.text(
                                    "ios.lines", params: ["count": .number(Double(lines.count))],
                                    fallback: "By line (\(lines.count))"))
                                    .font(.caption.weight(.semibold))
                            }
                        }
                    }
                }
            }
            .padding(18)
            .background(.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private func edgeTotal(for mask: Int) -> Double {
        // MileageStatsView deliberately exposes the ridden aggregation only;
        // denominators are supplied by the same edge index through the
        // store's snapshot in the next small bridge.
        statistics.totalsByMask[mask] ?? 0
    }

    private struct LineCoverageRow: Identifiable {
        let name: String
        let operatorName: String
        let total: Double
        let ridden: Double
        var id: String { "\(operatorName)\u{001F}\(name)" }
        var fraction: Double { total > 0 ? min(max(ridden / total, 0), 1) : 0 }
    }

    private func lineCoverageRows(mask: Int, includeUnridden: Bool) -> [LineCoverageRow] {
        let ridden = statistics.view?.overall.lineRidByCat
        return statistics.lineTotals.compactMap { item in
            let total = item.byMask[mask] ?? 0
            let riddenKm = ridden?[item.name]?[mask] ?? 0
            guard total > 0, riddenKm > 0 || includeUnridden else { return nil }
            return LineCoverageRow(
                name: item.name,
                operatorName: statistics.lineOperators[item.name] ?? "",
                total: total, ridden: riddenKm)
        }.sorted {
            if $0.operatorName != $1.operatorName {
                if $0.operatorName.isEmpty { return false }
                if $1.operatorName.isEmpty { return true }
                return $0.operatorName.localizedStandardCompare($1.operatorName) == .orderedAscending
            }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private func categoryLabel(mask: Int) -> String {
        guard let category = statistics.view?.categories.first(where: { $0.mask == mask })
        else { return "\(mask)" }
        return localization.countryText(
            category.i18n,
            fallback: localization.text(category.i18n, fallback: category.i18n))
    }

    @ViewBuilder
    private var topSegmentsCard: some View {
        if let rows = statistics.view?.overall.topSegments?.all, !rows.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                Label(localization.text("ios.mostRiddenSections", fallback: "Most ridden sections"), systemImage: "list.number")
                    .font(.headline)
                ForEach(Array(rows.prefix(5).enumerated()), id: \.offset) { index, row in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text("\(index + 1)").font(.caption.bold()).foregroundStyle(.secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(row.from) → \(row.to)").font(.subheadline.weight(.semibold))
                            Text("\(row.km.formatted(.number.precision(.fractionLength(1)))) km")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("×\(row.count)").font(.subheadline.bold()).monospacedDigit()
                    }
                }
                if let buckets = statistics.view?.overall.topSegments?.byMask,
                   buckets.contains(where: { !$0.rows.isEmpty }) {
                    Divider()
                    Text(localization.text(
                        "ios.categoryTopSections", fallback: "Top sections by network type"))
                        .font(.subheadline.weight(.semibold))
                    ForEach(buckets, id: \.mask) { bucket in
                        if !bucket.rows.isEmpty {
                            DisclosureGroup {
                                VStack(spacing: 10) {
                                    ForEach(Array(bucket.rows.prefix(5).enumerated()), id: \.offset) { _, row in
                                        HStack(alignment: .firstTextBaseline) {
                                            Text("\(row.from) → \(row.to)")
                                                .font(.caption.weight(.medium))
                                            Spacer()
                                            Text("×\(row.count) · \(row.km.formatted(.number.precision(.fractionLength(1)))) km")
                                                .font(.caption2).foregroundStyle(.secondary)
                                                .monospacedDigit()
                                        }
                                    }
                                }
                                .padding(.top, 8)
                            } label: {
                                Text(categoryLabel(mask: bucket.mask))
                                    .font(.caption.weight(.semibold))
                            }
                        }
                    }
                }
            }
            .padding(18)
            .background(.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private var regionName: String {
        let fallback = RailNetworkStore.countries.first(where: { $0.code == country })?.label
            ?? country.uppercased()
        return localization.text("country.\(country)", fallback: fallback)
    }

    private func stopCount(_ trains: [Train]) -> Int {
        trains.reduce(0) { $0 + $1.stops.count }
    }

    private func rideTime(_ trains: [Train]) -> String {
        let minutes = Statistics.sumRideMinutes(trains.map(\.forStatistics))
        guard minutes > 0 else { return "—" }
        let hours = Int(minutes) / 60
        let remainder = Int(minutes) % 60
        return localization.text(
            "fmt.duration",
            params: ["h": .number(Double(hours)), "m": .number(Double(remainder))],
            fallback: "\(hours) hr \(remainder) min"
        )
    }

    private func serviceRows(_ trains: [Train]) -> [(label: String, count: Int)] {
        var counts = ["ios.highSpeed": 0, "ios.limitedExpress": 0, "ios.other": 0]
        for train in trains {
            switch Statistics.serviceGroupOfTrain(trainType: train.trainType, country: country) {
            case "hsr": counts["ios.highSpeed", default: 0] += 1
            case "ltd": counts["ios.limitedExpress", default: 0] += 1
            default: counts["ios.other", default: 0] += 1
            }
        }
        return ["ios.highSpeed", "ios.limitedExpress", "ios.other"].map {
            ($0, counts[$0, default: 0])
        }
    }

}

private extension Train {
    var forStatistics: Statistics.Train {
        Statistics.Train(
            id: id,
            trainType: trainType,
            date: date,
            stops: stops.map {
                Statistics.Stop(
                    arrival: $0.arrival,
                    departure: $0.departure,
                    stopType: $0.stopType,
                    rideSegment: $0.rideSegment
                )
            }
        )
    }
}
