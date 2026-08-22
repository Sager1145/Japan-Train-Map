import RailCore
import SwiftUI

/// The 里程統計 workspace. Split out of `AppShell.swift` so the four top-level
/// destinations are four files: the shell owns navigation, each destination
/// owns its own screen — which is also what lets them be worked on at once.
///
/// The screen answers one question, in the order §5.7 asks it: how much have I
/// ridden, over how many journeys and days, how much of the network is that,
/// what kind of trains were they, which sections do I ride most, and then the
/// line-by-line detail underneath.
///
/// Above all of it sits 當日統計, which is where `app-stats-render.js` puts it
/// too: `renderMileageStatsDom` writes `#stats-daily` before it writes the
/// all-time block, and that block is rendered whether or not a day is
/// selected — reading `--` in every field when it is not. The dashes are the
/// point. `0 km` would be an answer, and "no day is in scope" is not an
/// answer, so the combined view never spells one.
struct StatisticsDashboardView: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Bindable var itineraries: ItineraryStore
    @Bindable var statistics: MileageStatisticsStore
    let country: String

    /// §13.2: work under about 400 ms must not flash progress UI at the
    /// reader. Held here rather than inside the summary because the summary is
    /// mounted and unmounted by this decision.
    @State private var progressVisible = false

    /// `TOP_SEGMENT_CATEGORIES`. Not `view.categories`: the coverage rows carry
    /// a JR（含新幹線）row that is the UNION of two other rows, which is right
    /// for percentages and would merely duplicate sections here. Every row
    /// below is one EXCLUSIVE mode, which is why 在來線 reads as JR在來線.
    private struct TopSegmentSpec {
        /// `nil` = 全部鐵道, the unfiltered list.
        let mask: Int?
        let i18n: String
    }

    private static let topSegmentSections: [TopSegmentSpec] = [
        TopSegmentSpec(mask: nil, i18n: "stat.allrail"),
        TopSegmentSpec(mask: Statistics.maskHSR, i18n: "stat.hsr"),
        TopSegmentSpec(mask: Statistics.maskCONV, i18n: "stat.jrconv"),
        TopSegmentSpec(mask: Statistics.maskMETRO, i18n: "stat.metro"),
        TopSegmentSpec(mask: Statistics.maskPRIV, i18n: "stat.priv"),
        TopSegmentSpec(mask: Statistics.maskTRAM, i18n: "stat.tram"),
    ]

    private struct ServiceRow: Identifiable {
        let key: String
        let group: Statistics.ServiceGroup
        var id: String { key }
    }

    private struct TopSegmentSection: Identifiable {
        let key: String
        let rows: [Statistics.TopRow]
        var id: String { key }
    }

    private struct CategoryDetail: Identifiable {
        let category: Statistics.Category
        let rows: [LineCoverageRow]
        var id: Int { category.mask }
    }

    /// `TOP_SEGMENT_LIMIT`.
    private static let topSegmentLimit = 12

    var body: some View {
        Group {
            if let loaded = itineraries.loaded {
                ScrollView {
                    LazyVStack(spacing: 16) {
                        dailyCard(loaded)
                        if progressVisible, let progress = statistics.progress {
                            StatisticsProgressSummary(progress: progress)
                        }
                        if let failure = statistics.failureMessage {
                            failureCard(failure)
                        }
                        if loaded.trains.isEmpty {
                            emptyCard
                        } else if let stats = statistics.view {
                            mileageHeroCard(stats.overall)
                            overviewCard(loaded, stats.overall)
                            coverageCard(stats)
                            serviceCard(stats.overall)
                            topSegmentsCard(stats.overall)
                            lineDetailCard(stats)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 110)
                }
                .background(Color(.systemGroupedBackground))
            } else {
                ProgressView(localization.statsText("ios.stats.calculating"))
            }
        }
        .navigationTitle(localization.text("ios.statistics", fallback: "Statistics"))
        .task(id: statistics.progress == nil) {
            guard statistics.progress != nil else {
                progressVisible = false
                return
            }
            try? await Task.sleep(for: .milliseconds(400))
            progressVisible = statistics.progress != nil
        }
    }

    // MARK: - 當日統計

    /// `#stats-daily`, plus the scope control the web app does not need.
    ///
    /// In the browser the panel silently follows the one global `selectedDate`
    /// the date bar writes. There is no such global here — the rides workspace
    /// owns its filter and this screen owns its own — so the scope is picked
    /// here, and picking it does not disturb the ride list.
    private func dailyCard(_ loaded: ItineraryStore.Loaded) -> some View {
        let daily = statistics.view?.daily
        let dateText = daily.map { scopeLabel($0.date) } ?? StatisticsFormat.unset
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(localization.statsText(
                    "stats.dailyTitle", params: ["date": .string(dateText)]))
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                scopeMenu(loaded)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(daily.map { StatisticsFormat.km($0.stats.riddenAll) }
                        ?? StatisticsFormat.unset)
                        .font(.system(.largeTitle, design: .rounded).bold())
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    Text(verbatim: "km")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                }
                Text(dailySubtitle(daily))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(localization.statsText(
                "stats.dailyTitle", params: ["date": .string(dateText)])))
            // "--" spoken as dashes says nothing, so the unset state names
            // itself instead of reading the placeholder aloud.
            .accessibilityValue(Text(dailySpoken(daily)))

            // Same mutually-exclusive ride groups as 實際乘坐量; the overlapping
            // network-category rows the panel once carried here were removed.
            if let daily {
                Divider()
                serviceTextRows(daily.stats.services)
            }
        }
        .statisticsCard()
    }

    private func dailySubtitle(_ daily: Statistics.DailyStats?) -> String {
        let time = daily.map { StatisticsFormat.duration($0.stats.rideMinutes, localization) }
            ?? StatisticsFormat.unset
        let trains = localization.statsText(
            "stat.trains",
            params: [
                "n": daily.map { Localization.Param.number(Double($0.trainCount)) }
                    ?? .string(StatisticsFormat.unset)
            ])
        return "\(localization.statsText("stat.time")) \(time) · \(trains)"
    }

    private func dailySpoken(_ daily: Statistics.DailyStats?) -> String {
        guard let daily else { return localization.statsText("ios.stats.unsetSpoken") }
        return "\(StatisticsFormat.km(daily.stats.riddenAll)) km · \(dailySubtitle(daily))"
    }

    private func scopeMenu(_ loaded: ItineraryStore.Loaded) -> some View {
        Menu {
            Picker(
                localization.statsText("ios.stats.scope"),
                selection: Binding(
                    get: { statistics.selectedDate },
                    set: { statistics.selectDate($0) })
            ) {
                Text(localization.statsText("date.all")).tag(Dates.allDates)
                ForEach(loaded.days) { day in
                    Text(scopeLabel(day.date)).tag(day.date)
                }
            }
        } label: {
            Label(
                scopeLabel(statistics.selectedDate),
                systemImage: "calendar")
                .font(.subheadline.weight(.semibold))
                .labelStyle(.titleAndIcon)
        }
        .accessibilityLabel(Text(localization.statsText("ios.stats.scope")))
        .accessibilityValue(Text(scopeLabel(statistics.selectedDate)))
    }

    /// `dateLabel` — the two sentinels need a word, a real bucket labels itself.
    private func scopeLabel(_ date: String) -> String {
        let key = Dates.dateLabelKey(date)
        return localization.text(key, fallback: key)
    }

    // MARK: - §5.7 #1 總乘車里程

    private func mileageHeroCard(_ stats: Statistics.MileageStats) -> some View {
        let total = statistics.totalKm
        let pct = total > 0 ? 100 * stats.riddenAll / total : 0
        return VStack(alignment: .leading, spacing: 10) {
            Text(localization.statsText("ios.stats.totalDistance"))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(StatisticsFormat.km(stats.riddenAll))
                    .font(.system(.largeTitle, design: .rounded).bold())
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(verbatim: "km")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Text(verbatim:
                "\(StatisticsFormat.percent(pct))% · \(StatisticsFormat.km(total)) km · \(regionName)")
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // §5.7: a neutral note, not the critical role. Unmatched distance
            // means the drawn ride left the classified network for a stretch —
            // it is information about coverage, not a data error.
            if stats.unmatchedKm > 0.01 {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(localization.statsText("ios.stats.unmatchedTitle"))
                            .font(.footnote.weight(.semibold))
                        Text(localization.text(
                            "ios.unmatchedDistance",
                            params: ["km": .string(StatisticsFormat.km(stats.unmatchedKm))],
                            fallback: "\(StatisticsFormat.km(stats.unmatchedKm)) km unmatched"))
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } icon: {
                    Image(systemName: "info.circle")
                }
                .foregroundStyle(.secondary)
                .padding(.top, 2)
                .accessibilityElement(children: .combine)
            }
        }
        .statisticsCard()
        .accessibilityElement(children: .contain)
    }

    // MARK: - §5.7 #2 旅程數 / 出行日 / 停站數 / 乘車時間

    private func overviewCard(
        _ loaded: ItineraryStore.Loaded, _ stats: Statistics.MileageStats
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(
                localization.text("ios.overview", fallback: "Overview"),
                systemImage: "calendar.badge.clock")
                .font(.headline)
            StatisticsMetricGrid(items: [
                .init(
                    localization.text("ios.recordedJourneys", fallback: "Journeys"),
                    loaded.trains.count.formatted()),
                .init(
                    localization.text("ios.travelDays", fallback: "Travel days"),
                    loaded.days.count.formatted()),
                .init(
                    localization.text("ios.stops", fallback: "Stops"),
                    stopCount(loaded.trains).formatted()),
                .init(
                    localization.text("ios.rideTime", fallback: "Ride time"),
                    StatisticsFormat.duration(stats.rideMinutes, localization)),
            ])
        }
        .statisticsCard()
    }

    // MARK: - §5.7 #3 路網覆蓋率

    private func coverageCard(_ view: Statistics.MileageStatsView) -> some View {
        let stats = view.overall
        let total = statistics.totalKm
        let pctAll = total > 0 ? 100 * stats.riddenAll / total : 0
        return VStack(alignment: .leading, spacing: 16) {
            Label(
                localization.statsText("stats.coverageTitle"),
                systemImage: "chart.bar.xaxis")
                .font(.headline)
            StatisticsBar(
                label: localization.statsCategoryText("stat.all"),
                value: "\(StatisticsFormat.percent(pctAll))%",
                detail: "\(StatisticsFormat.km(stats.riddenAll)) / \(StatisticsFormat.km(total)) km",
                fraction: total > 0 ? stats.riddenAll / total : 0,
                spoken: coverageSpoken(ridden: stats.riddenAll, total: total))
            ForEach(view.categories, id: \.mask) { category in
                let ridden = stats.riddenByMask[category.mask] ?? 0
                let categoryTotal = statistics.totalsByMask[category.mask] ?? 0
                StatisticsBar(
                    label: localization.statsCategoryText(category.i18n),
                    value: "\(StatisticsFormat.percent(percentage(ridden, categoryTotal)))%",
                    detail:
                        "\(StatisticsFormat.km(ridden)) / \(StatisticsFormat.km(categoryTotal)) km",
                    fraction: categoryTotal > 0 ? ridden / categoryTotal : 0,
                    spoken: coverageSpoken(ridden: ridden, total: categoryTotal))
            }
            // The one sentence that stops these being read as an accumulating
            // odometer: the numerator is a deduped union over ridden intervals,
            // the denominator the whole N02 network.
            Text(localization.statsText("stats.hint"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .statisticsCard()
    }

    private func coverageSpoken(ridden: Double, total: Double) -> String {
        localization.statsText(
            "ios.stats.coverageA11y",
            params: [
                "pct": .string(StatisticsFormat.percent(percentage(ridden, total))),
                "ridden": .string(StatisticsFormat.km(ridden)),
                "total": .string(StatisticsFormat.km(total)),
            ])
    }

    private func percentage(_ part: Double, _ whole: Double) -> Double {
        whole > 0 ? 100 * part / whole : 0
    }

    // MARK: - §5.7 #4 車種組合

    /// `stats.actualTitle` + `serviceRowsHtml` + the ride-time row.
    ///
    /// Deliberately no coverage percentage: repeat rides count each time, so
    /// there is no denominator these could be a percentage *of*. The bar is a
    /// share of the ride distance the three groups add up to, which is a ratio
    /// of numbers the aggregate already carries, and every figure it draws is
    /// spelled out beside it (§10.2).
    private func serviceCard(_ stats: Statistics.MileageStats) -> some View {
        let groups = serviceRows(stats.services)
        let totalKm = groups.reduce(0) { $0 + $1.group.km }
        return VStack(alignment: .leading, spacing: 16) {
            Label(
                localization.statsText("stats.actualTitle"),
                systemImage: "chart.bar.fill")
                .font(.headline)
            ForEach(groups) { row in
                StatisticsBar(
                    label: localization.statsCategoryText(row.key),
                    value: "\(StatisticsFormat.km(row.group.km)) km",
                    detail: serviceDetail(row.group),
                    fraction: totalKm > 0 ? row.group.km / totalKm : 0,
                    spoken:
                        "\(StatisticsFormat.km(row.group.km)) km · \(serviceDetail(row.group))")
            }
            Divider()
            StatisticsMetricRow(
                label: localization.statsText("stat.time"),
                value: StatisticsFormat.duration(stats.rideMinutes, localization))
        }
        .statisticsCard()
    }

    /// `serviceRowsHtml`'s three rows, in its order.
    private func serviceRows(_ services: Statistics.ServiceGroups) -> [ServiceRow] {
        [
            ServiceRow(key: "stat.hsr", group: services.hsr),
            ServiceRow(key: "stat.ltdexp", group: services.ltd),
            ServiceRow(key: "stat.othertrains", group: services.other),
        ]
    }

    private func serviceDetail(_ group: Statistics.ServiceGroup) -> String {
        let time = StatisticsFormat.duration(group.minutes, localization)
        let trains = localization.statsText(
            "stat.trains", params: ["n": .number(Double(group.count))])
        return "\(time) · \(trains)"
    }

    /// The daily card's compact form of the same three rows.
    private func serviceTextRows(_ services: Statistics.ServiceGroups) -> some View {
        VStack(spacing: 10) {
            ForEach(serviceRows(services)) { row in
                adaptiveRow(
                    label: Text(localization.statsCategoryText(row.key))
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true),
                    value: Text(verbatim:
                        "\(StatisticsFormat.km(row.group.km)) km · \(serviceDetail(row.group))")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary))
                    .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: - §5.7 #5 最常乘坐區間

    private func topSegmentsCard(_ stats: Statistics.MileageStats) -> some View {
        let top = stats.topSegments
        let sections = Self.topSegmentSections.compactMap { section -> TopSegmentSection? in
            let rows: [Statistics.TopRow]
            if let mask = section.mask {
                rows = top?.byMask.first(where: { $0.mask == mask })?.rows ?? []
            } else {
                rows = top?.all ?? []
            }
            return rows.isEmpty ? nil : TopSegmentSection(key: section.i18n, rows: rows)
        }
        return Group {
            if !sections.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    Label(
                        localization.statsText("stats.topSegmentsTitle"),
                        systemImage: "list.number")
                        .font(.headline)
                    Text(localization.statsText("stats.topSegmentsHint"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(sections) { section in
                        topSegmentSection(key: section.key, rows: section.rows)
                    }
                }
                .statisticsCard()
            }
        }
    }

    @ViewBuilder
    private func topSegmentSection(key: String, rows: [Statistics.TopRow]) -> some View {
        let best = rows[0]
        VStack(alignment: .leading, spacing: 8) {
            adaptiveRow(
                label: Text(localization.statsCategoryText(key)).font(.subheadline),
                value: Text(verbatim: "\(sectionLabel(best)) · \(rideCount(best.count))")
                    .font(.subheadline.weight(.semibold)))
                .accessibilityElement(children: .combine)
            if rows.count > 1 {
                DisclosureGroup {
                    VStack(spacing: 10) {
                        ForEach(
                            Array(rows.prefix(Self.topSegmentLimit).enumerated()), id: \.offset
                        ) { _, row in
                            adaptiveRow(
                                label: Text(sectionLabel(row)).font(.caption),
                                value: Text(verbatim:
                                    "\(rideCount(row.count)) · \(StatisticsFormat.km(row.km)) km")
                                    .font(.caption2)
                                    .monospacedDigit()
                                    .foregroundStyle(.secondary))
                                .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    Text(localization.statsText(
                        "stats.byCountCount", params: ["count": .number(Double(rows.count))]))
                        .font(.caption.weight(.semibold))
                }
            }
        }
    }

    private func sectionLabel(_ row: Statistics.TopRow) -> String {
        "\(row.from) ↔ \(row.to)"
    }

    private func rideCount(_ count: Int) -> String {
        localization.statsText("stat.rides", params: ["n": .number(Double(count))])
    }

    // MARK: - §5.7 #6 按線路與類別的詳細展開

    /// `categoryLineBreakdownHtml`, lifted out of the coverage rows into the
    /// detail section §5.7 puts last. Same rows, same order, same numbers.
    private func lineDetailCard(_ view: Statistics.MileageStatsView) -> some View {
        let sections = view.categories.compactMap { category -> CategoryDetail? in
            // 新幹線 has only about eleven lines, so listing the unridden ones
            // keeps a 0% 山形/秋田新幹線 visible; 地下鐵 is small enough for the
            // same treatment. 在來線 / JR / 私鐵 stay ridden-only, or the list
            // would be hundreds of 0% rows.
            let rows = lineCoverageRows(
                mask: category.mask,
                includeUnridden: category.mask == Statistics.maskHSR
                    || category.mask == Statistics.maskMETRO,
                ridden: view.overall.lineRidByCat)
            return rows.isEmpty ? nil : CategoryDetail(category: category, rows: rows)
        }
        return Group {
            if !sections.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Label(
                        localization.statsText("ios.stats.detailTitle"),
                        systemImage: "list.bullet.indent")
                        .font(.headline)
                    ForEach(sections) { section in
                        DisclosureGroup {
                            VStack(spacing: 12) {
                                ForEach(section.rows) { row in lineRow(row) }
                            }
                            .padding(.top, 8)
                        } label: {
                            adaptiveRow(
                                label: Text(localization.statsCategoryText(section.category.i18n))
                                    .font(.subheadline.weight(.semibold)),
                                value: Text(localization.statsText(
                                    "stats.byLineCount",
                                    params: ["count": .number(Double(section.rows.count))]))
                                    .font(.caption)
                                    .foregroundStyle(.secondary))
                        }
                    }
                }
                .statisticsCard()
            }
        }
    }

    private func lineRow(_ line: LineCoverageRow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            adaptiveRow(
                label: VStack(alignment: .leading, spacing: 1) {
                    if !line.company.isEmpty {
                        Text(line.company)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    // No line limit: a long line name wraps rather than being
                    // truncated or shrunk (§10.1, §10.4).
                    Text(line.name)
                        .font(.caption.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                },
                value: VStack(alignment: .trailing, spacing: 1) {
                    Text(verbatim: "\(StatisticsFormat.percent(line.percent))%")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                    Text(verbatim:
                        "\(StatisticsFormat.km(line.ridden)) / \(StatisticsFormat.km(line.total)) km")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                })
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(line.company.isEmpty ? line.name : "\(line.company) \(line.name)"))
        .accessibilityValue(
            Text(coverageSpoken(ridden: line.ridden, total: line.total)))
    }

    private struct LineCoverageRow: Identifiable {
        let name: String
        /// The raw N02 operator, which is what the ORDER is built on.
        let operatorName: String
        /// The short label the rows are grouped by, which is what is SHOWN.
        let company: String
        let total: Double
        let ridden: Double
        var id: String { "\(operatorName)\u{001F}\(name)" }
        var percent: Double { total > 0 ? 100 * ridden / total : 0 }
    }

    private func lineCoverageRows(
        mask: Int, includeUnridden: Bool,
        ridden: Statistics.OrderedDictionary<String, [Int: Double]>
    ) -> [LineCoverageRow] {
        statistics.lineTotals.compactMap { item -> LineCoverageRow? in
            let total = item.byMask[mask] ?? 0
            guard total > 0 else { return nil }
            let riddenKm = ridden[item.name]?[mask] ?? 0
            guard riddenKm > 0 || includeUnridden else { return nil }
            let operatorName = statistics.lineOperators[item.name] ?? ""
            return LineCoverageRow(
                name: item.name, operatorName: operatorName,
                company: StatisticsFormat.companyLabel(operatorName),
                total: total, ridden: riddenKm)
        }
        // Group by operating company, then by line within the company, so a
        // near-100% aggregate can be audited in a stable, readable order
        // instead of "whatever we rode most". Lines with no known operator
        // sort last so they cannot split a company's block.
        .sorted { a, b in
            if a.operatorName != b.operatorName {
                if a.operatorName.isEmpty { return false }
                if b.operatorName.isEmpty { return true }
                if a.operatorName.localizedStandardCompare(b.operatorName) != .orderedSame {
                    return StatisticsFormat.linesPrecede(a.operatorName, b.operatorName)
                }
            }
            return StatisticsFormat.linesPrecede(a.name, b.name)
        }
    }

    // MARK: - states that are not numbers

    private func failureCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(
                localization.statsText("ios.stats.failedTitle"),
                systemImage: "exclamationmark.triangle")
                .font(.headline)
                .foregroundStyle(.primary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(localization.statsText("ios.stats.failedBody"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .statisticsCard()
        .accessibilityElement(children: .combine)
    }

    private var emptyCard: some View {
        Text(localization.statsText("stats.empty"))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .statisticsCard()
    }

    // MARK: - shared bits

    /// A label/value pair that turns into two stacked lines rather than
    /// squeezing either side at an accessibility text size (§10.1).
    @ViewBuilder
    private func adaptiveRow(label: some View, value: some View) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                label.frame(maxWidth: .infinity, alignment: .leading)
                value.frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            HStack(alignment: .firstTextBaseline) {
                label
                Spacer(minLength: 8)
                value
                    .multilineTextAlignment(.trailing)
            }
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
}
