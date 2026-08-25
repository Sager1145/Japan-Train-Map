import RailCore
import SwiftUI

/// The mileage statistics, as a SECTION rather than as a screen.
///
/// §2.2 folds this into Passport: the statistics are one of five things that
/// workspace shows, between the coverage map above and the journey log below.
/// So this type is a stack of cards with no `ScrollView`, no navigation title
/// and no toolbar of its own — `PassportWorkspaceView` owns all three, and a
/// section that brought its own scroll view would be a scroll view inside a
/// scroll view.
///
/// It carries no scope control at all. §5.3.1 puts Scope at the top of
/// Passport and §5.1 forbids a second filter source for one value, so the
/// region and the date are both chosen in the panel header and arrive here as
/// inputs — the region as a `Binding`, the date through the statistics store.
///
/// The cards answer one question in the order §5.7 asks it: how much have I
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
///
/// ## The stationery (§6.1)
///
/// These cards are drawn as passport pages rather than as system cards, which
/// is the Memory personality §6.1 reserves for exactly this screen —
/// "expressive / railway-signage / ticket-and-map metaphors / souvenir-like".
/// The tones come from `PassportCardStyle.swift` and are assigned here:
///
///   - `.feature`, once, for ``passportDataPage(_:_:)`` — the card that
///     answers §5.3's question.
///   - `.soft` for the three cards that carry charts, so a screen with one
///     loud card still reads as one set of pages rather than as a poster with
///     receipts stapled to it.
///   - `.plain` for the dense line-by-line lists and for every state that is
///     not a number: a failure, an empty scope, a calculation in progress.
///     §6.1 is explicit that the Memory style must not be worn by a card
///     reporting that something went wrong.
///
/// Three cards were merged into one page — §5.7 #1, #2 and 當日統計, see
/// ``passportDataPage(_:_:)`` — and one row was lifted out of a list into a
/// highlight (§5.7 #5). The date scope left with the daily card: it is in the
/// panel header now, beside the region, where §5.3.1 puts Scope and where it
/// stays visible at every sheet stop. Nothing else moved: same figures, same
/// order, same wording, and the same VoiceOver sentences over the top of them.
struct StatisticsDashboardContent: View {
    @Environment(AppLocalization.self) private var localization
    @Bindable var itineraries: ItineraryStore
    @Bindable var statistics: MileageStatisticsStore
    /// Which region's numbers these are.
    ///
    /// The map draws every region at once, but a statistic cannot: the
    /// categories differ (捷運 / 地下鐵, 高鐵 / 新幹線), and coverage is a
    /// fraction of one network's own length. So this screen keeps the region
    /// switch the rest of the app no longer has, and it is a `Binding` because
    /// the shell reloads `MileageStatisticsStore` when it moves.
    /// `nil` is 全部 — every network in one denominator.
    @Binding var region: Region?

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
            if let loaded = itineraries.loaded.map(scoped) {
                // A plain VStack, not Lazy: the caller is already a LazyVStack
                // inside the workspace's one ScrollView, and nesting a second
                // lazy container inside it defeats both.
                VStack(spacing: 16) {
                    if progressVisible, let progress = statistics.progress {
                        StatisticsProgressSummary(progress: progress)
                    }
                    if let failure = statistics.failureMessage {
                        failureCard(failure)
                    }
                    if loaded.trains.isEmpty {
                        emptyCard
                    } else if let stats = statistics.view {
                        passportDataPage(loaded, stats.overall)
                        coverageCard(stats)
                        serviceCard(stats.overall)
                        topSegmentsCard(stats.overall)
                        lineDetailCard(stats)
                    }
                }
            } else {
                ProgressView(localization.statsText("ios.stats.calculating"))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            }
        }
        .task(id: statistics.progress == nil) {
            guard statistics.progress != nil else {
                progressVisible = false
                return
            }
            try? await Task.sleep(for: .milliseconds(400))
            progressVisible = statistics.progress != nil
        }
    }

    // MARK: - 當日統計, as a stamp on the passport

    /// `#stats-daily`'s subtitle: how long, over how many trains.
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

    /// `#stats-daily`, as a stamp inside the passport rather than as a card
    /// above it.
    ///
    /// The web app renders this block whether or not a day is chosen, with
    /// `--` in every field, because in the browser the date bar that scopes it
    /// is a different region of the page. Here the scope control sits in the
    /// panel header — visible at every sheet stop, on this destination only —
    /// so "no day is in scope" is stated by the control that owns the scope.
    /// A block of dashes underneath it would say the same thing a second time,
    /// in the one register §13.1 rules out.
    private func dailyStamp(_ daily: Statistics.DailyStats) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                PassportEyebrow(localization.statsText("ios.stats.dailyHeading"))
                Spacer(minLength: 8)
                PassportEyebrow(scopeLabel(daily.date))
            }
            PassportHeadline(
                label: localization.statsText(
                    "stats.dailyTitle", params: ["date": .string(scopeLabel(daily.date))]),
                value: StatisticsFormat.km(daily.stats.riddenAll),
                spoken: dailySpoken(daily),
                unit: "km",
                caption: dailySubtitle(daily),
                // A field inside the page, not a second page headline: the
                // day is part of the total above it, and two `largeTitle`
                // figures on one card is two cards.
                prominence: .field)
            // Same mutually-exclusive ride groups as 實際乘坐量; the
            // overlapping network-category rows the panel once carried here
            // were removed.
            PassportRule()
            VStack(spacing: 8) {
                ForEach(serviceRows(daily.stats.services)) { row in
                    PassportRow(
                        label: localization.statsCategoryText(row.key),
                        value:
                            "\(StatisticsFormat.km(row.group.km)) km · \(serviceDetail(row.group))")
                }
            }
        }
        .passportBlock()
    }

    private func dailySpoken(_ daily: Statistics.DailyStats?) -> String {
        guard let daily else { return localization.statsText("ios.stats.unsetSpoken") }
        return "\(StatisticsFormat.km(daily.stats.riddenAll)) km · \(dailySubtitle(daily))"
    }

    /// `dateLabel` — the two sentinels need a word, a real bucket labels itself.
    private func scopeLabel(_ date: String) -> String {
        let key = Dates.dateLabelKey(date)
        return localization.text(key, fallback: key)
    }

    // MARK: - §5.7 #1 + #2 — the passport data page

    /// 總乘車里程, the fields that qualify it, and the day in scope — one page.
    ///
    /// §5.3.3 asks for the distance first and 旅程數 / 出行日 / 停站數 /
    /// 乘車時間 second, and that is the order here — but as ONE card rather
    /// than three, which is where this screen departs from a card-per-item
    /// reading of the spec. The reason is the thing being imitated: a passport
    /// data page is a headline with its fields under it, and on separate
    /// surfaces the total read as the answer to a different question from the
    /// journey count that produced it.
    ///
    /// One field is not in §5.3.3's list: 乗車路線, the number of distinct
    /// lines ridden and the companies that run them. It is the reference's
    /// AIRLINES field, it is free (the aggregate already carries the per-line
    /// table), and it answers the question a coverage percentage cannot —
    /// 31 % of the network is not a thing anyone has ridden, 125 lines is.
    ///
    /// It is also the one `.feature` card on the screen (§6.1's Memory
    /// personality — see `PassportCardStyle.swift`). One, because a screen
    /// where every card is loud has no hero, and this is the card that answers
    /// §5.3's question: **how much have I ridden, and which railways does that
    /// cover?**
    private func passportDataPage(
        _ loaded: ItineraryStore.Loaded, _ stats: Statistics.MileageStats
    ) -> some View {
        let total = statistics.totalKm
        let pct = total > 0 ? 100 * stats.riddenAll / total : 0
        let ridden = riddenLines(stats)
        let laps = aroundTheWorld(stats.riddenAll)
        let distance = StatisticsFormat.km(stats.riddenAll)
        return VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                // No region chip and no date menu on the card. Both scopes are
                // chosen in the panel header now — one row, always visible, on
                // this destination only — and a card that repeated either
                // would be a second place for one value to be stated (§5.1).
                PassportEyebrow(localization.statsText("ios.stats.passportTitle"))
                PassportBookletLine()
            }

            PassportHeadline(
                label: localization.statsText("ios.stats.totalDistance"),
                value: distance,
                spoken: laps.map { "\(distance) km · \($0)" } ?? "\(distance) km",
                unit: "km",
                caption: laps)

            PassportMetricGrid(items: [
                .init(
                    localization.statsText("ios.stats.journeysLabel"),
                    loaded.trains.count.formatted(),
                    caption: highSpeedCaption(stats.services)),
                .init(
                    localization.text("ios.rideTime", fallback: "Ride time"),
                    StatisticsFormat.duration(stats.rideMinutes, localization)),
                .init(
                    localization.text("ios.travelDays", fallback: "Travel days"),
                    loaded.days.count.formatted()),
                .init(
                    localization.text("ios.stops", fallback: "Stops"),
                    stopCount(loaded.trains).formatted()),
                .init(
                    localization.statsText("ios.stats.linesRidden"),
                    ridden.lines.formatted(),
                    caption: ridden.operators > 0
                        ? localization.statsText(
                            "ios.stats.operatorCount",
                            params: ["n": .number(Double(ridden.operators))])
                        : nil),
            ])

            // The same three numbers the old hero footnote carried — the
            // percentage, the denominator, and what they are a fraction of —
            // in the band the reference puts its footer chip in. Not a
            // navigation: the coverage card is the next card down in the same
            // scroll view, and a button that scrolls the reader somewhere they
            // can already see is furniture.
            PassportBand(
                label: localization.statsText("stats.coverageTitle"),
                value: "\(StatisticsFormat.percent(pct))%",
                detail: "\(distance) / \(StatisticsFormat.km(total)) km",
                fraction: total > 0 ? stats.riddenAll / total : 0,
                spoken: coverageSpoken(ridden: stats.riddenAll, total: total))

            // The selected day, stamped on the page it is part of (§5.3.3's
            // Daily module). Below the all-time block rather than above it, so
            // the passport's own headline and fields stay contiguous and the
            // day reads as what it is: one entry in them.
            if let daily = statistics.view?.daily {
                dailyStamp(daily)
            }

            // §5.7: a neutral note, not the critical role. Unmatched distance
            // means the drawn ride left the classified network for a stretch —
            // it is information about coverage, not a data error.
            if stats.unmatchedKm > 0.01 {
                PassportNote(
                    title: localization.statsText("ios.stats.unmatchedTitle"),
                    message: localization.text(
                        "ios.unmatchedDistance",
                        params: ["km": .string(StatisticsFormat.km(stats.unmatchedKm))],
                        fallback: "\(StatisticsFormat.km(stats.unmatchedKm)) km unmatched"))
            }
        }
        .passportCard(.feature)
        .accessibilityElement(children: .contain)
    }

    /// The reference's "1.4x around the world", in the only unit that means
    /// anything to someone who has been counting kilometres: laps of the
    /// equator, at the WGS-84 circumference the map's own distances are
    /// measured on.
    ///
    /// `nil` under a twentieth of a lap, where the figure would read 「地球
    /// 0.0 周」 and say nothing. Expressive is not the same as inventing a
    /// number — §5.3 asks for both at once ("可以比编辑界面更有表现力，但数字仍
    /// 应准确、克制").
    private func aroundTheWorld(_ km: Double) -> String? {
        guard km.isFinite, km > 0 else { return nil }
        let laps = km / 40075.017
        guard laps >= 0.05 else { return nil }
        let digits = laps >= 1 ? 1 : 2
        return localization.statsText(
            "ios.stats.earthLaps",
            params: [
                "n": .string(laps.formatted(.number.precision(.fractionLength(digits))))
            ])
    }

    /// The reference's "4 Long Haul" — the one qualifier a journey count is
    /// worth carrying.
    ///
    /// `stat.hsr` is a country-variant key (新幹線 / 高鐵 / 고속철도), so it
    /// goes through `statsCategoryText` and says whichever of those the region
    /// in scope calls it.
    private func highSpeedCaption(_ services: Statistics.ServiceGroups) -> String? {
        guard services.hsr.count > 0 else { return nil }
        let trains = localization.statsText(
            "stat.trains", params: ["n": .number(Double(services.hsr.count))])
        return "\(localization.statsCategoryText("stat.hsr")) \(trains)"
    }

    /// How many distinct lines the reader has been on, and how many companies
    /// operate them — the passport's AIRLINES field, in this app's terms.
    ///
    /// Counted off `lineRidByCat` rather than off the ride records: it is
    /// keyed by line name and holds the ridden kilometres per category, so a
    /// line counts once however many categories it appears in, and a line the
    /// reader has never been on does not count at all. Operators come from the
    /// raw N02 name rather than the short label, because two companies can
    /// share a short label and the count would then be one too few.
    private func riddenLines(_ stats: Statistics.MileageStats)
        -> (lines: Int, operators: Int)
    {
        var lines = 0
        var operators: Set<String> = []
        for (name, byMask) in stats.lineRidByCat.pairs {
            guard byMask.values.contains(where: { $0 > 0 }) else { continue }
            lines += 1
            let operatorName = statistics.lineOperators[name] ?? ""
            if !operatorName.isEmpty { operators.insert(operatorName) }
        }
        return (lines, operators.count)
    }

    // MARK: - §5.7 #3 路網覆蓋率

    private func coverageCard(_ view: Statistics.MileageStatsView) -> some View {
        let stats = view.overall
        let total = statistics.totalKm
        let pctAll = total > 0 ? 100 * stats.riddenAll / total : 0
        return VStack(alignment: .leading, spacing: 16) {
            PassportCardHeader(
                localization.statsText("stats.coverageTitle"),
                systemImage: "chart.bar.xaxis")
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
        .passportCard(.soft)
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
            PassportCardHeader(
                localization.statsText("stats.actualTitle"),
                systemImage: "chart.bar.fill")
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
        .passportCard(.soft)
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
        // The unfiltered list's own best row is lifted out of the list and
        // into the highlight block — the reference's "Most flown aircraft"
        // — so the card opens with the answer rather than with a heading
        // over six category rows that all look alike. It is the same row,
        // read once: `summarised: false` below keeps 全部鐵道 from stating
        // it a second line later.
        let overall = sections.first(where: { $0.key == "stat.allrail" })?.rows.first
        return Group {
            if !sections.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    PassportCardHeader(
                        localization.statsText("stats.topSegmentsTitle"),
                        systemImage: "list.number")
                    if let overall {
                        PassportHighlight(
                            eyebrow: localization.statsText("ios.stats.topSection"),
                            title: sectionLabel(overall),
                            detail:
                                "\(rideCount(overall.count)) · \(StatisticsFormat.km(overall.km)) km")
                    }
                    Text(localization.statsText("stats.topSegmentsHint"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(sections) { section in
                        topSegmentSection(
                            key: section.key,
                            rows: section.rows,
                            summarised: !(overall != nil && section.key == "stat.allrail"))
                    }
                }
                .passportCard(.soft)
            }
        }
    }

    @ViewBuilder
    private func topSegmentSection(
        key: String, rows: [Statistics.TopRow], summarised: Bool = true
    ) -> some View {
        let best = rows[0]
        let count = localization.statsText(
            "stats.byCountCount", params: ["count": .number(Double(rows.count))])
        VStack(alignment: .leading, spacing: 8) {
            if summarised {
                adaptiveRow(
                    label: Text(localization.statsCategoryText(key)).font(.subheadline),
                    value: Text(verbatim: "\(sectionLabel(best)) · \(rideCount(best.count))")
                        .font(.subheadline.weight(.semibold)))
                    .accessibilityElement(children: .combine)
            }
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
                    // The category names itself here when the row above was
                    // dropped, or the unfiltered list's disclosure would open
                    // under a bare 「12 件」 with nothing saying of what.
                    Text(verbatim: summarised ? count : "\(localization.statsCategoryText(key)) · \(count)")
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
        HStack(alignment: .firstTextBaseline) {
            label
            Spacer(minLength: 8)
            value
                .multilineTextAlignment(.trailing)
        }
    }

    /// This screen's slice of the working set: one region's rides, and the
    /// date buckets they occupy.
    ///
    /// The region itself is chosen in the panel header, which offers every
    /// region rather than only the ones with rides in them: a coverage figure
    /// of 0 % for a region you have not ridden is an answer, and a region that
    /// disappeared from the picker as soon as its last ride was deleted would
    /// look like a bug.
    private func scoped(_ loaded: ItineraryStore.Loaded) -> ItineraryStore.Loaded {
        let trains = region.map { scope in
            loaded.trains.filter { Region.resolved($0) == scope }
        } ?? loaded.trains
        let ids = Set(trains.map(\.id))
        return ItineraryStore.Loaded(
            regions: region.map { [$0] } ?? Region.ordered,
            trains: trains,
            days: loaded.days.compactMap { day in
                let kept = day.trains.filter { ids.contains($0.id) }
                return kept.isEmpty ? nil : ItineraryStore.Loaded.Day(date: day.date, trains: kept)
            },
            elapsed: loaded.elapsed)
    }

    private func stopCount(_ trains: [Train]) -> Int {
        trains.reduce(0) { $0 + $1.stops.count }
    }
}
