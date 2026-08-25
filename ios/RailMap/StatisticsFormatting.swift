import Foundation
import RailCore
import SwiftUI

/// The number spellings the 統計 panel uses, ported from `app-stats-render.js`.
///
/// These are presentation, not aggregation — nothing here decides what a
/// kilometre counts towards — but they are ported rather than reinvented,
/// because "8.6 km" reading as "9" on one platform and "8.6" on the other is
/// exactly the kind of difference nobody notices until the two are compared
/// side by side.
enum StatisticsFormat {

    /// `formatStatKm`.
    ///
    /// Short distances keep one decimal: a two-digit figure rounded to a whole
    /// kilometre loses a meaningful share of itself (8.6 km reading as "9"),
    /// while anything from 100 km up is precise enough whole.
    ///
    /// The rounding is done before formatting rather than left to the format
    /// style: `Math.round` breaks ties away from zero and
    /// `FloatingPointFormatStyle` breaks them to even, so `0.05` and `100.5`
    /// would otherwise disagree with the web app in their last digit.
    static func km(_ value: Double) -> String {
        let v = value.isFinite ? value : 0
        if abs(v) < 100 {
            let rounded = (v * 10).rounded(.toNearestOrAwayFromZero) / 10
            return rounded.formatted(.number.precision(.fractionLength(1)))
        }
        return v.rounded(.toNearestOrAwayFromZero)
            .formatted(.number.precision(.fractionLength(0)))
    }

    /// `formatStatPct` — a percentage already on the 0–100 scale.
    ///
    /// One decimal only in the (0, 10) band, where a whole number would round
    /// a real 0.4% coverage away to "0". Not locale-grouped, because the
    /// JavaScript spells it with `String(...)` rather than `toLocaleString`,
    /// and no percentage is large enough for a group separator anyway.
    ///
    /// `String(format:)` is `toFixed(1)` here, despite the two disagreeing in
    /// general: they differ only on an exact tie, and at one fraction digit a
    /// tie would have to be exactly `(2k+1)/20`. Twenty has a factor of five,
    /// so no finite `Double` is ever exactly that — the case where `printf`
    /// rounds to even and `toFixed` rounds up is unreachable. (It is very much
    /// reachable at other digit counts, which is why `RailCore` carries a real
    /// `toFixed`; that one is internal to the package.)
    static func percent(_ value: Double) -> String {
        let v = value.isFinite ? value : 0
        if v > 0 && v < 10 { return String(format: "%.1f", v) }
        return String(Int(v.rounded(.toNearestOrAwayFromZero)))
    }

    /// `formatStatDuration` — hours and minutes, or bare minutes under an hour.
    @MainActor
    static func duration(_ minutes: Double, _ localization: AppLocalization) -> String {
        let safe = minutes.isFinite ? minutes : 0
        let h = (safe / 60).rounded(.down)
        let m = (safe.truncatingRemainder(dividingBy: 60)).rounded(.toNearestOrAwayFromZero)
        if h > 0 {
            return localization.statsText(
                "fmt.duration", params: ["h": .number(h), "m": .number(m)])
        }
        return localization.statsText("fmt.durationM", params: ["m": .number(m)])
    }

    /// The placeholder every daily figure reads as while the scope is 全部.
    ///
    /// Deliberately not `0`: a zero is a result, and "you rode nothing that
    /// day" is not what the combined view means (§5.7).
    static let unset = "--"

    /// `statsCompanyLabel` — the short operator label the per-line rows are
    /// grouped by (東日本旅客鉄道 → JR東日本), falling back to the raw N02 name.
    static func companyLabel(_ operatorName: String) -> String {
        guard !operatorName.isEmpty else { return "" }
        return OperatorBranding.companyLabel(operatorName)
    }

    /// `STATS_LINE_COLLATOR` — numeric, case/accent-insensitive, ja/en.
    ///
    /// `localizedStandardCompare` is Foundation's nearest equivalent: it is
    /// numeric-aware, so 1号線 < 2号線 < 10号線 rather than 1 < 10 < 2, and it
    /// folds case. It is not the same collator, so an exotic tie can order
    /// differently from the web app; the rows and their numbers are the same
    /// either way.
    static func linesPrecede(_ a: String, _ b: String) -> Bool {
        a.localizedStandardCompare(b) == .orderedAscending
    }
}

extension AppLocalization {
    /// Localization for the statistics screen.
    ///
    /// Keys the generated web catalog already carries resolve through it, so
    /// the two apps say the same words. `ios.stats.*` keys are native-shell
    /// labels with no web counterpart (stage names, section headings, the
    /// spoken descriptions of the bar charts) and come from the table below.
    func statsText(
        _ key: String, params: [String: Localization.Param]? = nil
    ) -> String {
        text(key, params: params, fallback: StatisticsStrings.table[key]?[language])
    }

    /// A category label that follows the active country's variant
    /// (`stat.conv` → `stat.conv.tw` = 臺鐵), which is `I18N.tc` in the web app.
    func statsCategoryText(_ key: String) -> String {
        countryText(key, fallback: statsText(key))
    }
}

/// Statistics-screen strings with no key in the generated web catalog.
///
/// Held here rather than in `AppLocalization`'s own table because this screen
/// introduced them; the shared vocabulary stays in the catalog both apps read.
enum StatisticsStrings {
    static let table: [String: [Localization.Language: String]] = [
        "ios.stats.scope": [
            .en: "Date scope", .ja: "対象日", .zhHans: "日期范围", .zhHant: "日期範圍",
        ],
        "ios.stats.totalDistance": [
            .en: "Total distance ridden", .ja: "総乗車距離",
            .zhHans: "总乘车里程", .zhHant: "總乘車里程",
        ],
        "ios.stats.calculating": [
            .en: "Calculating statistics", .ja: "統計を計算しています",
            .zhHans: "正在计算统计", .zhHant: "正在計算統計",
        ],
        "ios.stats.stage.readingNetwork": [
            .en: "Reading the rail network", .ja: "路線網を読み込んでいます",
            .zhHans: "正在读取路网", .zhHant: "正在讀取路網",
        ],
        "ios.stats.stage.matchingRides": [
            .en: "Matching rides to the network", .ja: "乗車記録を路線に対応させています",
            .zhHans: "正在把乘车记录对应到路网", .zhHant: "正在把乘車記錄對應到路網",
        ],
        "ios.stats.stage.aggregating": [
            .en: "Adding up coverage", .ja: "カバー率を集計しています",
            .zhHans: "正在汇总覆盖率", .zhHant: "正在彙總覆蓋率",
        ],
        "ios.stats.stage.scopingDay": [
            .en: "Recalculating the selected day", .ja: "対象日を計算し直しています",
            .zhHans: "正在重新计算所选日期", .zhHant: "正在重新計算所選日期",
        ],
        "ios.stats.matchedOf": [
            .en: "{done} of {total} journeys",
            .ja: "{total} 本中 {done} 本",
            .zhHans: "{total} 趟中的 {done} 趟",
            .zhHant: "{total} 趟中的 {done} 趟",
        ],
        "ios.stats.keepUsing": [
            .en: "The rest of the app keeps working while this finishes.",
            .ja: "計算中もアプリの他の機能は利用できます。",
            .zhHans: "计算过程中，应用的其他部分仍可正常使用。",
            .zhHant: "計算過程中，應用程式的其他部分仍可正常使用。",
        ],
        "ios.stats.detailTitle": [
            .en: "Detail by line and category", .ja: "路線・種別ごとの内訳",
            .zhHans: "按线路与类别的明细", .zhHant: "依線路與類別的明細",
        ],
        "ios.stats.unmatchedTitle": [
            .en: "Unmatched distance", .ja: "未一致の距離",
            .zhHans: "未匹配里程", .zhHant: "未配對里程",
        ],
        "ios.stats.coverageA11y": [
            .en: "{pct} percent covered, {ridden} of {total} kilometres",
            .ja: "カバー率 {pct} パーセント、{total} キロ中 {ridden} キロ",
            .zhHans: "覆盖率 {pct}%，{total} 公里中的 {ridden} 公里",
            .zhHant: "覆蓋率 {pct}%，{total} 公里中的 {ridden} 公里",
        ],
        "ios.stats.failedTitle": [
            .en: "Statistics could not be calculated",
            .ja: "統計を計算できませんでした",
            .zhHans: "无法计算统计",
            .zhHant: "無法計算統計",
        ],
        "ios.stats.failedBody": [
            .en: "Your journeys and routes are unchanged.",
            .ja: "乗車記録と経路は変更されていません。",
            .zhHans: "行程记录与路线均未改变。",
            .zhHant: "行程記錄與路線均未改變。",
        ],
        "ios.stats.passportTitle": [
            .en: "All-time rail passport", .ja: "全期間 鉄道パスポート",
            .zhHans: "全时段 铁道护照", .zhHant: "全期間 鐵道護照",
        ],
        // The reference's "1.4x around the world". Written with the number
        // ahead of the unit in English and behind it in CJK, because
        // 「地球 1.4 周」 is how the lap is counted in all three.
        "ios.stats.earthLaps": [
            .en: "{n}× around the world", .ja: "地球 {n} 周",
            .zhHans: "绕地球 {n} 圈", .zhHant: "繞地球 {n} 圈",
        ],
        "ios.stats.journeysLabel": [
            .en: "Journeys", .ja: "乗車本数", .zhHans: "乘车趟数", .zhHant: "乘車趟數",
        ],
        "ios.stats.linesRidden": [
            .en: "Lines ridden", .ja: "乗車路線", .zhHans: "已乘线路", .zhHant: "已乘線路",
        ],
        "ios.stats.operatorCount": [
            .en: "{n} operators", .ja: "{n} 事業者",
            .zhHans: "{n} 家运营商", .zhHant: "{n} 家業者",
        ],
        "ios.stats.topSection": [
            .en: "Most ridden section", .ja: "最も乗った区間",
            .zhHans: "乘坐最多的区间", .zhHant: "乘坐最多的區間",
        ],
        "ios.stats.unsetSpoken": [
            .en: "not available", .ja: "対象日が未選択", .zhHans: "未选择日期", .zhHant: "未選擇日期",
        ],
    ]
}
