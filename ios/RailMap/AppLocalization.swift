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

    /// The country whose readings table is wanted. Kept so a slow decode that
    /// finishes after the reader has moved to another country is dropped
    /// instead of installing Taiwanese names over a Japanese map.
    private var readingsCountry: String?

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.preferenceKey)
        language = Localization.Language(rawValue: saved ?? "") ?? Self.systemLanguage

        guard let url = Bundle.main.url(forResource: "Localizable", withExtension: "json"),
            let catalog = try? Localization.Catalog(contentsOf: url)
        else { return }
        engine = Localization(
            catalog: catalog,
            language: language,
            readingPrefs: DisplaySettings.persistedNameReadingPrefs())
        // The application shell calls `setCountry` from a `task(id:)`, which
        // does not run until the first view appears. Seeding from the same
        // stored key it uses means the country-variant strings and the station
        // readings are already right on the first frame rather than one
        // country-flavoured redraw later.
        setCountry(UserDefaults.standard.string(forKey: Self.countryKey) ?? "jp")
    }

    /// The key `ContentView`'s `@AppStorage("active-country")` writes.
    private static let countryKey = "active-country"

    func setCountry(_ country: String) {
        engine?.setCountry(country)
        loadStationReadings(country: country)
    }

    // MARK: - Station name readings

    /// Install the country's readings table. Decoding happens on
    /// `StationReadingsStore`'s own executor: Korea's table is 2,812 rows and
    /// the reader is looking at a map while it is read.
    private func loadStationReadings(country: String) {
        guard readingsCountry != country else { return }
        readingsCountry = country
        Task { [weak self] in
            let table = await StationReadingsStore.shared.table(for: country)
            guard let self, self.readingsCountry == country else { return }
            self.engine?.setStationReadings(table)
        }
    }

    /// `I18N.setNameReadings`. `nil` puts the three toggles back to following
    /// the UI language.
    func setNameReadings(_ prefs: Localization.ReadingPrefs?) {
        engine?.setNameReadings(prefs)
    }

    /// What the display sites should actually annotate with right now.
    var activeReadingPrefs: Localization.ReadingPrefs {
        engine?.activeReadingPrefs ?? Localization.localeDefaultReadingPrefs(language)
    }

    /// Whether the active country's readings table localises the base station
    /// NAME (Taiwan, Hong Kong, Macao, Korea) instead of annotating a Japanese
    /// name with kana/romaji sublines. The three reading toggles do nothing at
    /// all in those countries, and the settings panel says so rather than
    /// offering switches that cannot change anything.
    var localizesStationNames: Bool {
        guard let engine else { return false }
        return Localization.localizedNameCountries.contains(engine.stationReadings.country)
    }

    /// `I18N.stationName` — the localised base name.
    func stationName(_ name: String?, code: String? = nil) -> String {
        engine?.stationName(name, code: code) ?? (name ?? "")
    }

    /// `I18N.nameReadingsTyped` — the enabled readings for a name, typed so a
    /// paired display can align the same kind of reading on the same line.
    func nameReadingsTyped(_ name: String?, code: String? = nil) -> [Localization.Reading] {
        engine?.nameReadingsTyped(name, code: code) ?? []
    }

    /// `I18N.nameReadings` — the enabled readings joined with `" / "`.
    func nameReadings(_ name: String?, code: String? = nil) -> String {
        engine?.nameReadings(name, code: code) ?? ""
    }

    /// `I18N.placeName` — a station or proper noun as the active language
    /// displays it, readings included.
    func placeName(_ name: String?, code: String? = nil) -> String {
        engine?.placeName(name, code: code) ?? (name ?? "")
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

    /// `I18N.tc` — the country-variant lookup.
    ///
    /// The web app does not reserve this for a handful of call sites:
    /// `applyStatic` resolves EVERY `data-i18n` attribute through `tc`, so any
    /// static string is one `key.tw` away from being country-specific without
    /// its call site changing. Native screens follow the same rule — a catalog
    /// key goes through here, and only the iOS-only `ios.*` keys use `text`.
    ///
    /// A missed variant falls through to `text`, which is what keeps that rule
    /// free: the shipped catalog declares variants for eleven keys, and the
    /// rest resolve exactly as `text` would.
    func countryText(
        _ key: String,
        params: [String: Localization.Param]? = nil,
        fallback: String? = nil
    ) -> String {
        guard let engine else { return text(key, params: params, fallback: fallback) }
        let variant = engine.countryVariantKey(key)
        if variant != key {
            let value = engine.t(variant, params)
            if value != variant { return value }
        }
        return text(key, params: params, fallback: fallback)
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

        // -- Settings: section headers -------------------------------------
        "ios.regionLanguage": [.en: "Region & language", .ja: "地域と言語", .zhHans: "地区与语言", .zhHant: "地區與語言"],
        "ios.stationNames": [.en: "Station names", .ja: "駅名の表示", .zhHans: "站名显示", .zhHant: "站名顯示"],
        "ios.mapContent": [.en: "Map content", .ja: "地図の内容", .zhHans: "地图内容", .zhHant: "地圖內容"],
        "ios.stationMarkers": [.en: "Station markers", .ja: "駅マーカー", .zhHans: "站点标记", .zhHant: "站點標記"],
        "ios.selectionFocus": [.en: "Selection & focus", .ja: "選択とフォーカス", .zhHans: "选择与聚焦", .zhHant: "選擇與聚焦"],

        // -- Settings: diagnostics -----------------------------------------
        "ios.package": [.en: "Package", .ja: "データパッケージ", .zhHans: "数据包", .zhHant: "資料包"],
        "ios.packageIdle": [.en: "Not loaded", .ja: "未読み込み", .zhHans: "尚未加载", .zhHant: "尚未載入"],
        "ios.packageDecoding": [.en: "Decoding package…", .ja: "データパッケージを解析中…", .zhHans: "正在解析数据包…", .zhHant: "正在解析資料包…"],
        "ios.packageLines": [
            .en: "{code} · {count} lines",
            .ja: "{code}・{count} 路線",
            .zhHans: "{code} · {count} 条线路",
            .zhHant: "{code} · {count} 條線路",
        ],
        "ios.decodeTime": [.en: "Decode time", .ja: "解析時間", .zhHans: "解析耗时", .zhHant: "解析耗時"],
        "ios.renderer": [.en: "Renderer", .ja: "描画エンジン", .zhHans: "绘制引擎", .zhHant: "繪製引擎"],

        // -- Settings: what each control actually reaches --------------------
        //
        // Spec §5.9: every toggle says what it affects where it stands, and a
        // display preference must never imply that it edits the reader's data.
        "ios.note.displayOnly": [
            .en: "These change how the map is drawn. They never touch your rides or the JSON you export.",
            .ja: "これらは地図の見え方だけを変える設定です。乗車記録や書き出される JSON は変わりません。",
            .zhHans: "这些设置只影响地图的呈现方式，不会更动乘车记录，也不会改变导出的 JSON。",
            .zhHant: "這些設定只影響地圖的呈現方式，不會更動乘車紀錄，也不會改變匯出的 JSON。",
        ],
        "ios.note.allRailways": [
            .en: "The complete rail network drawn beneath your rides. Off leaves only your own journeys.",
            .ja: "乗車記録の下に描かれる鉄道網全体です。オフにすると自分の行程だけが残ります。",
            .zhHans: "行程底下的完整铁路网。关闭后只留下你自己的行程。",
            .zhHant: "行程底下的完整鐵路網。關閉後只留下你自己的行程。",
        ],
        "ios.note.fitToNetwork": [
            .en: "Moves the map to frame the network that is currently loaded.",
            .ja: "読み込み済みの鉄道網が収まるように地図を移動します。",
            .zhHans: "把地图范围调整到当前已加载的铁路网。",
            .zhHant: "把地圖範圍調整到目前已載入的鐵路網。",
        ],
        "ios.note.basemapOpacity": [
            .en: "Affects the basemap only — railways and rides keep their own opacity.",
            .ja: "背景地図のみに効きます。鉄道と乗車の描画は変わりません。",
            .zhHans: "只影响底图；铁路与行程维持原样。",
            .zhHant: "只影響底圖；鐵路與行程維持原樣。",
        ],
        "ios.note.theme": [
            .en: "Line colours automatically use each operator's light or dark palette.",
            .ja: "路線色は事業者ごとのライト／ダークの配色を自動で使い分けます。",
            .zhHans: "线路颜色会自动采用各运营商的亮色或暗色版本。",
            .zhHant: "線路顏色會自動採用各業者的亮色或暗色版本。",
        ],
        "ios.note.readingKana": [
            .en: "Adds the kana reading under a Japanese station name.",
            .ja: "日本語の駅名にかな読みを併記します。",
            .zhHans: "在日文站名下方加注假名读音。",
            .zhHant: "在日文站名下方加註假名讀音。",
        ],
        "ios.note.readingRomaji": [
            .en: "Adds the Hepburn romanisation under a station name.",
            .ja: "駅名にヘボン式ローマ字を併記します。",
            .zhHans: "在站名下方加注罗马字。",
            .zhHant: "在站名下方加註羅馬字。",
        ],
        "ios.note.readingZh": [
            .en: "Adds the Chinese name under a station, where the reference table has one.",
            .ja: "対照表にある駅について、中国語表記を併記します。",
            .zhHans: "在对照表有资料的站名下方加注中文站名。",
            .zhHant: "在對照表有資料的站名下方加註中文站名。",
        ],
        "ios.note.readingsFollowLanguage": [
            .en: "Until you change one of these, all three follow the interface language.",
            .ja: "いずれかを変更するまで、この 3 つは表示言語に追随します。",
            .zhHans: "在你调整之前，这三项跟随界面语言。",
            .zhHant: "在你調整之前，這三項跟隨介面語言。",
        ],
        "ios.note.readingsLocalized": [
            .en: "This region's station names come straight from the operator's own official name in each language, so reading annotations do not apply here.",
            .ja: "この地域の駅名は事業者の公式な各言語表記をそのまま使うため、読みの併記は行われません。",
            .zhHans: "此地区的站名直接使用运营机构的官方各语言名称，因此读音注记在这里不适用。",
            .zhHant: "此地區的站名直接使用營運機構的官方各語言名稱，因此讀音註記在這裡不適用。",
        ],
        "ios.note.routeWidth": [
            .en: "Scales your ride's route line. The network underneath keeps its own weight.",
            .ja: "自分の行程の線の太さです。下の鉄道網の太さは変わりません。",
            .zhHans: "缩放你的行程线；底下的铁路网维持原本粗细。",
            .zhHant: "縮放你的行程線；底下的鐵路網維持原本粗細。",
        ],
        "ios.note.riddenOpacity": [
            .en: "Opacity of the segments recorded as ridden.",
            .ja: "「乗車済み」として記録された区間の不透明度です。",
            .zhHans: "已记录为「已乘」的区间的透明度。",
            .zhHant: "已記錄為「已乘」的區間的透明度。",
        ],
        "ios.note.dimOpacity": [
            .en: "Rides that are not on the selected date fade to this opacity.",
            .ja: "選択した日以外の行程は、この不透明度まで淡くなります。",
            .zhHans: "不在所选日期的行程会淡化到此透明度。",
            .zhHant: "不在所選日期的行程會淡化到此透明度。",
        ],
        "ios.note.focusBoost": [
            .en: "How much thicker the selected ride is drawn, and how much larger its markers are.",
            .ja: "選択中の行程をどれだけ太く、マーカーをどれだけ大きく描くかです。",
            .zhHans: "选中的行程加粗与放大标记的幅度。",
            .zhHant: "選中的行程加粗與放大標記的幅度。",
        ],
        "ios.note.fullCrossDay": [
            .en: "Off draws the half of an overnight ride that runs on the other calendar day as a dashed line.",
            .ja: "オフのとき、日をまたぐ行程は別の日に走る半分を破線で描きます。",
            .zhHans: "关闭时，跨夜行程在另一个日期的半段以虚线绘制。",
            .zhHant: "關閉時，跨夜行程在另一個日期的半段以虛線繪製。",
        ],
        "ios.note.terminalRadius": [
            .en: "The dot at a ride's origin and destination.",
            .ja: "行程の始発駅と終着駅に置かれる丸です。",
            .zhHans: "行程起点与终点站的圆点。",
            .zhHant: "行程起點與終點站的圓點。",
        ],
        "ios.note.stopRadius": [
            .en: "The black centre inside an intermediate stop's dot.",
            .ja: "途中停車駅の丸の中心にある黒点です。",
            .zhHans: "中途停靠站圆点中心的黑点。",
            .zhHant: "中途停靠站圓點中心的黑點。",
        ],
        "ios.note.passRadius": [
            .en: "The outer circle for intermediate calls and pass-throughs.",
            .ja: "途中停車駅と通過駅の外円です。",
            .zhHans: "中途停靠站与通过站的外圈。",
            .zhHant: "中途停靠站與通過站的外圈。",
        ],
        "ios.note.markerStroke": [
            .en: "The border width of every ride marker.",
            .ja: "すべての乗車マーカーの枠線の太さです。",
            .zhHans: "所有行程标记的边框粗细。",
            .zhHant: "所有行程標記的邊框粗細。",
        ],
        "ios.note.reset": [
            .en: "Resets the display settings on this screen only. Your rides and exported data are untouched.",
            .ja: "この画面の表示設定だけを初期化します。乗車記録と書き出しデータは変わりません。",
            .zhHans: "只重设本页的显示设置；乘车记录与导出资料不受影响。",
            .zhHant: "只重設本頁的顯示設定；乘車紀錄與匯出資料不受影響。",
        ],
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
