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

    /// The locale this app's own dates and numbers are formatted in.
    ///
    /// `Foundation`'s `.formatted()` reads `Locale.current`, which is the
    /// DEVICE's language — and this app has a language switch of its own. On
    /// an English phone set to 日本語, every string came out Japanese except
    /// the one line that names a date, which read "Aug 23, 2026 at 5:09" in
    /// the middle of a Japanese panel. Anything the reader is shown follows
    /// the language they picked here, dates included.
    var locale: Locale {
        Locale(identifier: language.rawValue)
    }

    var language: Localization.Language {
        didSet {
            engine?.setLanguage(language.rawValue)
            for region in Region.allCases {
                namingEngines[region]?.setLanguage(language.rawValue)
            }
            UserDefaults.standard.set(language.rawValue, forKey: Self.preferenceKey)
        }
    }

    private var engine: Localization?

    /// One naming engine per region, because a station's language is a
    /// property of the station rather than of the app.
    ///
    /// The web app has a region switch, so it holds ONE readings table and
    /// `Localization` reads its `country` field to decide whether a name is
    /// *annotated* with kana and romaji (Japan) or *replaced* by its official
    /// name in the reader's language (Taiwan, Hong Kong, Macao, Korea). This
    /// app draws all five networks at once, so one table cannot answer for the
    /// map: a Taiwanese station would be handed Japanese rules.
    ///
    /// Rather than change the ported rule — which is fixture-checked against
    /// the JavaScript — the app holds one engine per region and picks by the
    /// station's own region. Each engine is the same catalog and language with
    /// a different table installed, and `Localization` is a value type whose
    /// dictionaries are copy-on-write, so five of them cost five tables rather
    /// than five catalogs.
    private var namingEngines: [Region: Localization] = [:]

    /// Which region's wording the country-variant keys resolve in — `I18N.tc`.
    ///
    /// With no region switch left, this is no longer "the country you are
    /// looking at". It follows the statistics screen's own region selector,
    /// because that is where the eleven variant-bearing keys actually appear
    /// (捷運 / 地下鐵, 高鐵 / 新幹線, 私鐵 / 사철). Everywhere else the base
    /// key reads correctly in all five regions.
    private(set) var variantRegion: Region = .jp

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
        // One naming engine per region, seeded empty and filled as each table
        // is read. An engine with `.empty` installed declares country "JP",
        // which annotates rather than replaces — so a name drawn in the moment
        // before its table lands is the package's own spelling, never another
        // language's name.
        for region in Region.allCases {
            var naming = Localization(
                catalog: catalog,
                language: language,
                readingPrefs: DisplaySettings.persistedNameReadingPrefs())
            naming.setCountry(region.code)
            namingEngines[region] = naming
        }
        setVariantRegion(
            Region(rawValue: UserDefaults.standard.string(forKey: Self.variantKey) ?? "") ?? .jp)
        loadStationReadings()
    }

    /// Which region's wording the statistics screen last asked for.
    /// Deliberately NOT `"statistics-region"`, which is the key the shell's
    /// `@AppStorage` owns.
    ///
    /// These two shared one key, and the value only ever travelled one way —
    /// the shell pushes the region in through `setVariantRegion` — so nothing
    /// went wrong for as long as every value that could be stored was a
    /// `Region`. The scope now has an 全部 entry, which is not: writing "all"
    /// made this line read it back as `nil`, fall through to `.jp`, and SAVE
    /// that over the reader's choice, so choosing 全部 silently selected Japan
    /// a moment later. Two owners of one key is the fault; one key each is the
    /// fix.
    private static let variantKey = "statistics-variant-region"

    /// `I18N.setCountry` for the UI catalog only — the readings tables are all
    /// installed at once and are chosen per station, not per app state.
    func setVariantRegion(_ region: Region) {
        variantRegion = region
        engine?.setCountry(region.code)
        UserDefaults.standard.set(region.rawValue, forKey: Self.variantKey)
    }

    // MARK: - Station name readings

    /// Install every region's readings table.
    ///
    /// Decoding happens on `StationReadingsStore`'s own executor: the five
    /// tables are about a megabyte together and the reader is looking at a map
    /// while they are read. They land one at a time, in whatever order they
    /// finish, and each one only affects the names of its own region.
    private func loadStationReadings() {
        for region in Region.allCases {
            Task { [weak self] in
                let table = await StationReadingsStore.shared.table(for: region.code)
                guard let self else { return }
                self.namingEngines[region]?.setStationReadings(table)
                self.readingsGeneration += 1
            }
        }
    }

    /// How many regional readings tables have been installed.
    ///
    /// The map's renderer is not a SwiftUI view and cannot observe a table
    /// landing — see ``MapNaming``, which carries this number so that a map
    /// drawn before a table arrived is rebuilt once it has.
    private(set) var readingsGeneration = 0

    /// `I18N.setNameReadings`. `nil` puts the three toggles back to following
    /// the UI language.
    func setNameReadings(_ prefs: Localization.ReadingPrefs?) {
        engine?.setNameReadings(prefs)
        for region in Region.allCases { namingEngines[region]?.setNameReadings(prefs) }
    }

    /// What the display sites should actually annotate with right now.
    var activeReadingPrefs: Localization.ReadingPrefs {
        engine?.activeReadingPrefs ?? Localization.localeDefaultReadingPrefs(language)
    }

    /// Whether a region's readings table localises the base station NAME
    /// (Taiwan, Hong Kong, Macao, Korea) instead of annotating a Japanese name
    /// with kana/romaji sublines. The three reading toggles do nothing at all
    /// in those regions, and the settings panel says so rather than offering
    /// switches that cannot change anything.
    func localizesStationNames(in region: Region) -> Bool {
        guard let naming = namingEngines[region] else { return false }
        return Localization.localizedNameCountries.contains(naming.stationReadings.country)
    }

    /// Whether every region drawn localises names — the settings panel's
    /// question, now that all five are on screen at once. Japan is always one
    /// of them, so this is `false` and the reading toggles always do
    /// something; it stays a function of the regions rather than a constant
    /// because a build that shipped without the Japanese package should say so
    /// rather than offer three switches that change nothing.
    var localizesEveryStationName: Bool {
        Region.allCases.allSatisfy { localizesStationNames(in: $0) }
    }

    /// Which engine answers for a name.
    ///
    /// The station code names its own region — Japan's are six digits, every
    /// other package spells `"<region>-official-…"` — so most callers need
    /// pass nothing. A name with no code and no stated region is read as
    /// Japanese, which annotates rather than replaces and therefore cannot put
    /// the wrong language's name on a station.
    private func naming(_ region: Region?, _ code: String?) -> Localization? {
        namingEngines[region ?? Region.fromStationCode(code) ?? .jp]
    }

    /// `I18N.stationName` — the localised base name.
    func stationName(_ name: String?, code: String? = nil, region: Region? = nil) -> String {
        naming(region, code)?.stationName(name, code: code) ?? (name ?? "")
    }

    /// `I18N.nameReadingsTyped` — the enabled readings for a name, typed so a
    /// paired display can align the same kind of reading on the same line.
    func nameReadingsTyped(
        _ name: String?, code: String? = nil, region: Region? = nil
    ) -> [Localization.Reading] {
        naming(region, code)?.nameReadingsTyped(name, code: code) ?? []
    }

    /// Every name the readings table holds for a station, in every language it
    /// carries and regardless of the reading toggles — what
    /// `StationPlaceStore` matches an Apple Maps answer against. See
    /// `Localization.stationNameAliases`.
    func stationNameAliases(
        _ name: String?, code: String? = nil, region: Region? = nil
    ) -> [String] {
        naming(region, code)?.stationNameAliases(name, code: code) ?? []
    }

    /// `I18N.nameReadings` — the enabled readings joined with `" / "`.
    func nameReadings(_ name: String?, code: String? = nil, region: Region? = nil) -> String {
        naming(region, code)?.nameReadings(name, code: code) ?? ""
    }

    /// `I18N.placeName` — a station or proper noun as the active language
    /// displays it, readings included.
    func placeName(_ name: String?, code: String? = nil, region: Region? = nil) -> String {
        naming(region, code)?.placeName(name, code: code) ?? (name ?? "")
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
        // The system TabView has a much tighter width budget than a panel
        // heading. Keep the four destinations equally compact in every UI
        // language; their full titles remain in the shared `nav.*` / `sec.*`
        // catalog and are still used by the panel headers.
        "ios.tab.upcoming": [
            .en: "Upcoming", .ja: "今後", .zhHans: "未来", .zhHant: "未來",
        ],
        "ios.tab.stats": [
            .en: "Stats", .ja: "統計", .zhHans: "统计", .zhHant: "統計",
        ],
        "ios.tab.all": [
            .en: "All", .ja: "すべて", .zhHans: "全部", .zhHant: "全部",
        ],
        "ios.tab.search": [
            .en: "Search", .ja: "検索", .zhHans: "搜索", .zhHant: "搜尋",
        ],
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
        "ios.currentJourney": [.en: "Current journey", .ja: "現在の行程", .zhHans: "当前行程", .zhHant: "目前行程"],
        "ios.edit": [.en: "Edit", .ja: "編集", .zhHans: "编辑", .zhHant: "編輯"],
        // The editor's NAV TITLE, which is not the same string as the button
        // that opens it. 「乗車記録を編集」 and 「新しい乗車」 both lose their
        // row to 「キャンセル」 and 「乗車記録を保存」 and come back as
        // 「乗車記録…」 — a heading truncated to a stub (§14.5). The two
        // buttons already carry the verbs; this only has to name the surface.
        "ios.editorTitleNew": [.en: "New", .ja: "新規", .zhHans: "新建", .zhHant: "新增"],
        "ios.save": [.en: "Save", .ja: "保存", .zhHans: "保存", .zhHant: "儲存"],
        "ios.cancel": [.en: "Cancel", .ja: "キャンセル", .zhHans: "取消", .zhHant: "取消"],
        // The search field's own clear button. Spoken, not drawn: the glyph is
        // `xmark.circle.fill`, which VoiceOver would otherwise announce by its
        // symbol name (§10.2).
        "ios.clear": [.en: "Clear search", .ja: "検索を消去", .zhHans: "清除搜索", .zhHant: "清除搜尋"],
        // §13.1: what the daily card says when no single date is chosen. It
        // used to draw `StatisticsFormat.unset` — 「-- km」 over 「乗車時間 --
        // · -- 本」 — which a reader cannot tell apart from a figure that
        // failed to load.
        "ios.stats.dailyHeading": [
            .en: "Selected day", .ja: "当日の統計", .zhHans: "当日统计", .zhHant: "當日統計",
        ],
        "ios.stats.dailyUnset": [
            .en: "Pick a date to see that day's distance and time.",
            .ja: "日付を選ぶと、その日の距離と乗車時間が出ます。",
            .zhHans: "选择一个日期，就会显示当天的里程与乘车时间。",
            .zhHant: "選擇一個日期，就會顯示當天的里程與乘車時間。",
        ],
        "ios.done": [.en: "Done", .ja: "完了", .zhHans: "完成", .zhHant: "完成"],
        "ios.region.all": [
            .en: "All regions", .ja: "すべての地域",
            .zhHans: "全部地区", .zhHant: "全部地區",
        ],
        "ios.close": [.en: "Close", .ja: "閉じる", .zhHans: "关闭", .zhHant: "關閉"],
        // The resident sheet's three stops, as accessibility actions. See
        // `SheetStageActions` — with no Pull Bar and a drag-driven resize,
        // these are the only way a reader not using touch can move it.
        "ios.sheet.expand": [
            .en: "Expand panel", .ja: "パネルを全画面にする",
            .zhHans: "展开面板", .zhHant: "展開面板",
        ],
        "ios.sheet.half": [
            .en: "Half-height panel", .ja: "パネルを半分の高さにする",
            .zhHans: "面板半屏", .zhHant: "面板半螢幕",
        ],
        "ios.sheet.collapse": [
            .en: "Collapse panel", .ja: "パネルを折りたたむ",
            .zhHans: "收起面板", .zhHant: "收起面板",
        ],
        "ios.share": [.en: "Share", .ja: "共有", .zhHans: "分享", .zhHant: "分享"],
        // Short forms of the three primary actions that can appear in the
        // journey card's one-line control row. See
        // `JourneyActionAppearance.short` — they exist so a 300-point
        // landscape sidebar keeps one scan line instead of falling back to a
        // stacked layout the floating tab bar then covers.
        // The date chip's spoken hint — it is a Button whose action is not
        // obvious from its label alone (§5.2: the chip is the way back).
        "ios.journey.backToDate": [
            .en: "Back to this day's journeys", .ja: "この日の行程に戻る",
            .zhHans: "返回当天行程", .zhHant: "返回當天行程",
        ],
        "ios.journey.locateShort": [
            .en: "Focus", .ja: "経路", .zhHans: "聚焦", .zhHant: "聚焦",
        ],
        "ios.journey.showShort": [
            .en: "Show", .ja: "表示", .zhHans: "显示", .zhHant: "顯示",
        ],
        "ios.journey.rebuildShort": [
            .en: "Rebuild", .ja: "再構築", .zhHans: "重建", .zhHant: "重建",
        ],
        // Why the map cannot follow the device — see
        // `RailMapController.LocationRefusal`. Native-only: the web app has no
        // Core Location and therefore no catalog entry to share.
        "ios.location.unavailable": [
            .en: "Location access is off for this app. Settings › Privacy › Location Services.",
            .ja: "このアプリの位置情報がオフです。設定 › プライバシー › 位置情報サービス。",
            .zhHans: "本应用的定位权限已关闭。设置 › 隐私 › 定位服务。",
            .zhHant: "本應用程式的定位權限已關閉。設定 › 隱私權 › 定位服務。",
        ],
        "ios.location.declined": [
            .en: "Location access was declined.",
            .ja: "位置情報の利用が許可されませんでした。",
            .zhHans: "定位权限已被拒绝。",
            .zhHant: "定位權限已被拒絕。",
        ],
        "ios.openInMaps": [
            .en: "Open in Maps", .ja: "マップで開く",
            .zhHans: "在地图中打开", .zhHant: "在地圖中打開",
        ],
        // The legend and sources panel. Korea has no article in the web
        // catalog and the basemap article there names OpenFreeMap, which is
        // not what draws underneath this app — see `MapInfoView`.
        "ios.info.krRailTitle": [
            .en: "Korean rail network", .ja: "韓国の鉄道網",
            .zhHans: "韩国铁路网", .zhHant: "韓國鐵路網",
        ],
        "ios.info.krRailBody": [
            .en:
                "Built from data.go.kr's official station records and OpenStreetMap track alignments.",
            .ja: "data.go.kr の公式駅データと OpenStreetMap の線形をもとに作成しています。",
            .zhHans: "依 data.go.kr 官方车站资料与 OpenStreetMap 线形加工制作。",
            .zhHant: "依 data.go.kr 官方車站資料與 OpenStreetMap 線形加工製作。",
        ],
        "ios.info.basemapBody": [
            .en: "Apple Maps. Its own attribution is shown on the map itself.",
            .ja: "Apple マップ。帰属表示は地図上に表示されます。",
            .zhHans: "Apple 地图，其署名显示在地图上。",
            .zhHant: "Apple 地圖，其署名顯示在地圖上。",
        ],
        "ios.mapInfo": [
            .en: "Legend and sources", .ja: "凡例と出典",
            .zhHans: "图例与资料来源", .zhHant: "圖例與資料來源",
        ],
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

        // -- Map layers: the two groups ------------------------------------
        //
        // iOS-only keys. The web app's layers popover has no network group —
        // its network switch draws lines and stations together, which is
        // exactly the bundling these two switches undo — so there is nothing
        // in `i18n-strings.js` to share and these live here.
        "ios.layers.networkGroup": [
            .en: "All railways", .ja: "全路線の表示", .zhHans: "全部线路显示",
            .zhHant: "全部線路顯示",
        ],
        "ios.layers.networkStations": [
            .en: "Stations", .ja: "駅", .zhHans: "车站", .zhHant: "車站",
        ],
        "ios.layers.networkStationNames": [
            .en: "Station names", .ja: "駅名", .zhHans: "站名", .zhHant: "站名",
        ],
        "ios.layers.riddenCategories": [
            .en: "Ridden line types", .ja: "乗車済み路線の種別",
            .zhHans: "已乘线路类型", .zhHant: "已乘線路類型",
        ],
        "ios.note.networkLayers": [
            .en: """
                Both follow the rail network switch on the map. Station names also wait for \
                the zoom level that gives them room.
                """,
            .ja: """
                どちらも地図上の路線網スイッチに従います。駅名は表示に十分な縮尺になってから出ます。
                """,
            .zhHans: """
                两者都跟随地图上的路网开关。站名还需要缩放到足够近才会出现。
                """,
            .zhHant: """
                兩者都跟隨地圖上的路網開關。站名還需要縮放到足夠近才會出現。
                """,
        ],
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
        "ios.note.riddenCategories": [
            .en: "Each ridden section is classified by the network that covers most of it. Sections the network cannot identify stay visible.",
            .ja: "乗車済み区間は、その大半を占める路線網で分類します。判別できない区間は表示したままにします。",
            .zhHans: "每段已乘区间按覆盖其里程最多的路网分类。无法判别的区间保持显示。",
            .zhHant: "每段已乘區間按覆蓋其里程最多的路網分類。無法判別的區間維持顯示。",
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
