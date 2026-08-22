import Foundation
import Observation
import RailCore

/// SwiftUI-facing owner for the verified web localization runtime.
///
/// The build phase places the generated catalog in the bundle as raw JSON so
/// `RailCore.Localization` can preserve the main fork's fallback chains,
/// country variants, and `{placeholder}` semantics. This object only bridges
/// that engine into Observation and persists the reader's language choice.
@MainActor
@Observable
final class AppLocalization {
    private static let preferenceKey = "interface-language"

    var language: Localization.Language {
        didSet {
            engine?.setLanguage(language.rawValue)
            UserDefaults.standard.set(language.rawValue, forKey: Self.preferenceKey)
        }
    }

    private var engine: Localization?

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.preferenceKey)
        language = Localization.Language(rawValue: saved ?? "") ?? Self.systemLanguage

        guard let url = Bundle.main.url(forResource: "Localizable", withExtension: "json"),
            let catalog = try? Localization.Catalog(contentsOf: url)
        else { return }
        engine = Localization(catalog: catalog, language: language)
    }

    func setCountry(_ country: String) {
        engine?.setCountry(country)
    }

    func text(
        _ key: String,
        params: [String: Localization.Param]? = nil,
        fallback: String? = nil
    ) -> String {
        guard let engine else {
            return Self.fill(Self.nativeStrings[key]?[language] ?? fallback ?? key, params: params)
        }
        let value = engine.t(key, params)
        if value != key { return value }
        return Self.fill(Self.nativeStrings[key]?[language] ?? fallback ?? key, params: params)
    }

    func countryText(
        _ key: String,
        params: [String: Localization.Param]? = nil,
        fallback: String? = nil
    ) -> String {
        guard let engine else { return fallback ?? key }
        let value = engine.tc(key, params)
        return value == key || value == engine.countryVariantKey(key) ? fallback ?? value : value
    }

    /// Strings introduced by the native shell and therefore absent from the
    /// generated web catalog. Shared concepts continue to come from the main
    /// catalog above; this table is intentionally limited to iOS-only labels.
    private static let nativeStrings: [String: [Localization.Language: String]] = [
        "ios.settings": [.en: "Settings", .ja: "設定", .zhHans: "设置", .zhHant: "設定"],
        "ios.myRides": [.en: "My Rides", .ja: "自分の乗車記録", .zhHans: "我的行程", .zhHant: "我的行程"],
        "ios.appearance": [.en: "Appearance", .ja: "外観", .zhHans: "外观", .zhHant: "外觀"],
        "ios.map": [.en: "Map", .ja: "地図", .zhHans: "地图", .zhHant: "地圖"],
        "ios.diagnostics": [.en: "Diagnostics", .ja: "診断", .zhHans: "诊断", .zhHant: "診斷"],
        "ios.statistics": [.en: "Statistics", .ja: "統計", .zhHans: "统计", .zhHant: "統計"],
        "ios.recordedJourneys": [.en: "Recorded journeys", .ja: "記録済みの乗車", .zhHans: "已记录行程", .zhHant: "已記錄行程"],
        "ios.overview": [.en: "Overview", .ja: "概要", .zhHans: "概览", .zhHant: "概覽"],
        "ios.travelDays": [.en: "Travel days", .ja: "乗車日数", .zhHans: "出行天数", .zhHant: "出行天數"],
        "ios.stops": [.en: "Stops", .ja: "停車駅", .zhHans: "停靠站", .zhHant: "停靠站"],
        "ios.rideTime": [.en: "Ride time", .ja: "乗車時間", .zhHans: "乘车时间", .zhHant: "乘車時間"],
        "ios.serviceMix": [.en: "Service mix", .ja: "列車種別", .zhHans: "列车类型", .zhHant: "列車類型"],
        "ios.highSpeed": [.en: "High speed", .ja: "高速鉄道", .zhHans: "高速铁路", .zhHant: "高速鐵路"],
        "ios.limitedExpress": [.en: "Limited express", .ja: "特急", .zhHans: "特急", .zhHant: "特急"],
        "ios.other": [.en: "Other", .ja: "その他", .zhHans: "其他", .zhHant: "其他"],
        "ios.mileageCoverage": [.en: "Mileage and coverage", .ja: "距離とカバー率", .zhHans: "里程与覆盖率", .zhHant: "里程與覆蓋率"],
        "ios.networkCoverage": [.en: "Network coverage", .ja: "路線網カバー率", .zhHans: "路网覆盖率", .zhHant: "路網覆蓋率"],
        "ios.mostRiddenSections": [.en: "Most ridden sections", .ja: "よく乗る区間", .zhHans: "最常乘坐区间", .zhHant: "最常乘坐區間"],
        "ios.unmatchedDistance": [
            .en: "{km} km could not be matched to a classified network edge.",
            .ja: "{km} km は分類済み路線に一致しませんでした。",
            .zhHans: "有 {km} km 未能匹配到已分类路网。",
            .zhHant: "有 {km} km 未能配對到已分類路網。",
        ],
        "ios.geometryPending": [
            .en: "Available after ridden route geometry is connected.",
            .ja: "乗車ルート形状の接続後に利用できます。",
            .zhHans: "接入已乘坐路线几何数据后可用。",
            .zhHant: "接入已乘坐路線幾何資料後可用。",
        ],
        "ios.files": [.en: "Files", .ja: "ファイル", .zhHans: "文件", .zhHant: "檔案"],
        "ios.newJourney": [.en: "New journey", .ja: "新しい乗車", .zhHans: "新建行程", .zhHant: "新增行程"],
        "ios.editJourney": [.en: "Edit journey", .ja: "乗車記録を編集", .zhHans: "编辑行程", .zhHant: "編輯行程"],
        "ios.edit": [.en: "Edit", .ja: "編集", .zhHans: "编辑", .zhHant: "編輯"],
        "ios.save": [.en: "Save", .ja: "保存", .zhHans: "保存", .zhHant: "儲存"],
        "ios.cancel": [.en: "Cancel", .ja: "キャンセル", .zhHans: "取消", .zhHant: "取消"],
        "ios.journey": [.en: "Journey", .ja: "乗車", .zhHans: "行程", .zhHant: "行程"],
        "ios.stations": [.en: "Stations", .ja: "駅", .zhHans: "车站", .zhHant: "車站"],
        "ios.routing": [.en: "Routing", .ja: "経路", .zhHans: "路径", .zhHant: "路徑"],
        "ios.routePolicy": [.en: "Route policy", .ja: "経路ポリシー", .zhHans: "路径策略", .zhHant: "路徑策略"],
        "ios.routeSection": [.en: "Route section", .ja: "経路区間", .zhHans: "路径分段", .zhHant: "路徑分段"],
        "ios.addRouteSection": [.en: "Add route section", .ja: "経路区間を追加", .zhHans: "新增路径分段", .zhHant: "新增路徑分段"],
        "ios.style": [.en: "Style", .ja: "スタイル", .zhHans: "样式", .zhHant: "樣式"],
        "ios.showOnMap": [.en: "Show on map", .ja: "地図に表示", .zhHans: "在地图上显示", .zhHant: "在地圖上顯示"],
        "ios.discardChanges": [.en: "Discard changes", .ja: "変更を破棄", .zhHans: "放弃更改", .zhHant: "放棄變更"],
        "ios.addStop": [.en: "Add stop", .ja: "停車駅を追加", .zhHans: "新增停靠站", .zhHant: "新增停靠站"],
        "ios.journeyInfo": [.en: "Journey information", .ja: "乗車情報", .zhHans: "行程信息", .zhHant: "行程資訊"],
        "ios.recordedStops": [.en: "Recorded stops", .ja: "記録駅数", .zhHans: "记录停靠站", .zhHant: "記錄停靠站"],
        "ios.visibility": [.en: "Visibility", .ja: "表示状態", .zhHans: "显示状态", .zhHant: "顯示狀態"],
        "ios.passWithoutStopping": [.en: "Passes without stopping", .ja: "通過", .zhHans: "通过不停靠", .zhHant: "通過不停靠"],
        "ios.currentLocation": [.en: "Current location", .ja: "現在地", .zhHans: "当前位置", .zhHant: "目前位置"],
        "ios.zoomIn": [.en: "Zoom in", .ja: "拡大", .zhHans: "放大", .zhHant: "放大"],
        "ios.zoomOut": [.en: "Zoom out", .ja: "縮小", .zhHans: "缩小", .zhHant: "縮小"],
        "ios.lines": [.en: "By line ({count})", .ja: "路線別（{count}）", .zhHans: "按线路（{count}）", .zhHant: "依線路（{count}）"],
        "ios.categoryTopSections": [.en: "Top sections by network type", .ja: "路線種別ごとの主要区間", .zhHans: "按路网类型的热门区间", .zhHant: "依路網類型的熱門區間"],
    ]

    private static func fill(
        _ template: String, params: [String: Localization.Param]?
    ) -> String {
        guard let params else { return template }
        var result = template
        for (key, value) in params {
            let replacement: String?
            switch value {
            case .string(let string): replacement = string
            case .number(let number): replacement = JSNumber.string(number)
            case .bool(let bool): replacement = bool ? "true" : "false"
            case .null: replacement = nil
            }
            if let replacement {
                result = result.replacingOccurrences(of: "{\(key)}", with: replacement)
            }
        }
        return result
    }

    private static var systemLanguage: Localization.Language {
        for identifier in Locale.preferredLanguages {
            if identifier.hasPrefix("zh-Hans") || identifier.hasPrefix("zh-CN") {
                return .zhHans
            }
            if identifier.hasPrefix("zh") { return .zhHant }
            if identifier.hasPrefix("ja") { return .ja }
            if identifier.hasPrefix("en") { return .en }
        }
        return .zhHant
    }
}
