import Foundation
import RailCore
import RailPresentation

/// The four-language copy for everything `JourneyPresentationResolver` can say.
///
/// `RailPresentation` deliberately returns catalog *keys* rather than finished
/// English (see `PresentationText`), and thirty-five of the keys it emits —
/// every `ios.journey.*` — exist in neither `Resources/Localizable.xcstrings`
/// nor `AppLocalization.nativeStrings`. Until they do, each emission renders
/// its English structural fallback, which is an English sentence shown to a
/// reader who chose 日本語: a localisation bug that compiles.
///
/// This table is that copy. It follows the shape `DataStrings` already uses in
/// this port — a table plus one lookup that tries the shared web catalog FIRST
/// — for the same reason: `AppLocalization` is another port's file, and a key
/// the web app already spells (`status.routeNoPath`, `btn.rebuildRoute`,
/// `play.pause`) must keep the web app's own wording in every language rather
/// than gaining a second translation here that drifts from it.
///
/// Two rules this table is written against:
///
/// - **Every entry carries all four languages.** A missing language silently
///   falls through to English, and English text under a Japanese interface is
///   exactly the defect the table exists to remove.
/// - **Nothing here claims a route was drawn when it was not.** The `route*`
///   entries are the §13.3 error structure — what happened, what it affected,
///   what was kept — and the "no straight line" promise of §1.1 is part of the
///   sentence, not a footnote.
enum JourneyStrings {

    static let table: [String: [Localization.Language: String]] = [

        // MARK: - journey identity (§3.2)

        // Not translated so much as arranged: the arrow is the whole string in
        // every language, and the two fills are station names the reader wrote.
        "ios.journey.endpoints": [
            .zhHant: "{from} → {to}",
            .zhHans: "{from} → {to}",
            .ja: "{from} → {to}",
            .en: "{from} → {to}",
        ],
        "ios.journey.progress": [
            .zhHant: "{completed} / {total}",
            .zhHans: "{completed} / {total}",
            .ja: "{completed} / {total}",
            .en: "{completed} of {total}",
        ],

        // MARK: - hidden from the map (§8.5)

        "ios.journey.hiddenTitle": [
            .zhHant: "已從地圖隱藏",
            .zhHans: "已从地图隐藏",
            .ja: "地図から非表示",
            .en: "Hidden from map",
        ],
        "ios.journey.hiddenDetail": [
            .zhHant: "重新顯示不會改變匯出的旅程資料。",
            .zhHans: "重新显示不会改变导出的行程数据。",
            .ja: "再表示しても、書き出される乗車データは変わりません。",
            .en: "Showing it again does not change the journey data you export.",
        ],
        "ios.journey.stillSaved": [
            .zhHant: "旅程仍然保存著",
            .zhHans: "行程仍然保存着",
            .ja: "乗車記録は保存されたままです",
            .en: "The journey is still saved",
        ],

        // MARK: - playback (§5.6)

        "ios.journey.playing": [
            .zhHant: "正在播放旅程",
            .zhHans: "正在播放行程",
            .ja: "行程を再生中",
            .en: "Playing journey",
        ],
        "ios.journey.playbackPaused": [
            .zhHant: "播放已暫停",
            .zhHans: "播放已暂停",
            .ja: "再生を一時停止中",
            .en: "Playback paused",
        ],

        // MARK: - route resolution (§5.5)

        "ios.journey.routePreparing": [
            .zhHant: "準備路線",
            .zhHans: "准备路线",
            .ja: "経路を準備中",
            .en: "Preparing route",
        ],
        "ios.journey.routeNotReady": [
            .zhHant: "路線尚未就緒",
            .zhHans: "路线尚未就绪",
            .ja: "経路はまだ準備できていません",
            .en: "The route is not ready yet",
        ],
        "ios.journey.routeBuilding": [
            .zhHant: "正在重建路線",
            .zhHans: "正在重建路线",
            .ja: "経路を再構築しています",
            .en: "Building railway route",
        ],
        "ios.journey.routeNeedsReview": [
            .zhHant: "路線需要檢查",
            .zhHans: "路线需要检查",
            .ja: "経路の確認が必要です",
            .en: "Route needs review",
        ],
        "ios.journey.routeUnavailable": [
            .zhHant: "無法繪製路線",
            .zhHans: "无法绘制路线",
            .ja: "経路を描画できません",
            .en: "Route unavailable",
        ],
        // §1.1 and §5.5: a section that did not solve was left undrawn. Saying
        // so is the point of the sentence — the reader has to be able to tell
        // "not drawn" from "drawn wrong", and neither from "drawn straight".
        "ios.journey.routePartial": [
            .zhHant: "有區間未能繪製，也沒有以直線代替。",
            .zhHans: "有区间未能绘制，也没有以直线代替。",
            .ja: "描画できなかった区間があります。直線での代替描画は行っていません。",
            .en: "Some sections could not be drawn, and no straight line was used in their place.",
        ],
        // Not a failure: `RideRouteStatus.noRoute` means the reader has not yet
        // said which stretch they rode, so the solver was never asked. §13.3
        // still applies — what happened, and what to do next.
        "ios.journey.noRiddenSection": [
            .zhHant: "這趟旅程還沒有標記任何乘坐區間，可在停站中設定。",
            .zhHans: "这趟行程还没有标记任何乘坐区间，可在停靠站中设置。",
            .ja: "乗車区間がまだ指定されていません。停車駅で設定できます。",
            .en: "No stretch of this journey is marked as ridden yet — set it in the stops.",
        ],
        "ios.journey.recordUnchanged": [
            .zhHant: "旅程記錄與停站沒有改變。",
            .zhHans: "行程记录与停靠站没有改变。",
            .ja: "乗車記録と停車駅は変わっていません。",
            .en: "The journey record and its stops are unchanged.",
        ],
        "ios.journey.routeAffectedSection": [
            .zhHant: "「{section}」沒有找到符合目前線路約束的路徑。",
            .zhHans: "「{section}」没有找到符合当前线路约束的路径。",
            .ja: "「{section}」で、現在の路線条件に合う経路が見つかりませんでした。",
            .en: "No path matching the current line constraints was found for {section}.",
        ],

        // MARK: - workspace loading and empty states (§13.1, §13.2)

        "ios.journey.loadingTitle": [
            .zhHant: "正在讀取旅程",
            .zhHans: "正在读取行程",
            .ja: "乗車記録を読み込み中",
            .en: "Loading journeys",
        ],
        "ios.journey.loadingDetail": [
            .zhHant: "正在讀取已保存的資料",
            .zhHans: "正在读取已保存的数据",
            .ja: "保存済みのデータを読み込んでいます",
            .en: "Reading the saved store",
        ],
        "ios.journey.emptyTitle": [
            .zhHant: "還沒有乘車記錄",
            .zhHans: "还没有乘车记录",
            .ja: "まだ乗車記録がありません",
            .en: "No journeys yet",
        ],
        "ios.journey.emptyDetail": [
            .zhHant: "新增一趟旅程，或匯入既有的 JSON。",
            .zhHans: "新建一趟行程，或导入已有的 JSON。",
            .ja: "新しい行程を作るか、既存の JSON を読み込みます。",
            .en: "Add a journey, or import an existing JSON store.",
        ],
        "ios.journey.emptyDateTitle": [
            .zhHant: "這一天沒有旅程",
            .zhHans: "这一天没有行程",
            .ja: "この日の行程はありません",
            .en: "No journeys on this day",
        ],
        "ios.journey.emptyDateDetail": [
            .zhHant: "目前的日期篩選沒有記錄。",
            .zhHans: "当前的日期筛选没有记录。",
            .ja: "現在の日付フィルターに該当する記録がありません。",
            .en: "The current date filter has no records.",
        ],
        "ios.journey.emptySearchTitle": [
            .zhHant: "沒有符合的旅程",
            .zhHans: "没有匹配的行程",
            .ja: "一致する行程がありません",
            .en: "No matching journeys",
        ],
        "ios.journey.emptySearchDetail": [
            .zhHant: "試試車次、車站或 ID。",
            .zhHans: "试试车次、车站或 ID。",
            .ja: "列車番号・駅名・ID で試してください。",
            .en: "Try a train number, a station, or an ID.",
        ],
        "ios.journey.importingTitle": [
            .zhHant: "正在匯入旅程",
            .zhHans: "正在导入行程",
            .ja: "乗車記録を読み込んでいます",
            .en: "Importing journeys",
        ],

        // MARK: - failures (§13.3)

        "ios.journey.loadFailedTitle": [
            .zhHant: "無法讀取旅程",
            .zhHans: "无法读取行程",
            .ja: "乗車記録を読み込めませんでした",
            .en: "Could not load journeys",
        ],
        "ios.journey.loadFailedKept": [
            .zhHant: "此裝置上已保存的旅程資料沒有改變。",
            .zhHans: "此设备上已保存的行程数据没有改变。",
            .ja: "この端末に保存されている乗車データは変わっていません。",
            .en: "The journey data saved on this device was not changed.",
        ],
        "ios.journey.importFailedTitle": [
            .zhHant: "無法匯入這個檔案",
            .zhHans: "无法导入这个文件",
            .ja: "このファイルを読み込めませんでした",
            .en: "Could not import this file",
        ],
        "ios.journey.importFailedKept": [
            .zhHant: "沒有匯入任何內容，現有的旅程沒有改變。",
            .zhHans: "没有导入任何内容，现有的行程没有改变。",
            .ja: "何も読み込まれておらず、既存の乗車記録は変わっていません。",
            .en: "Nothing was imported; your existing journeys are unchanged.",
        ],
        "ios.journey.saveFailedTitle": [
            .zhHant: "無法保存這趟旅程",
            .zhHans: "无法保存这趟行程",
            .ja: "この乗車記録を保存できませんでした",
            .en: "Could not save this journey",
        ],
        "ios.journey.saveFailedKept": [
            .zhHant: "你的編輯仍然保留著。",
            .zhHans: "你的编辑仍然保留着。",
            .ja: "編集内容はそのまま残っています。",
            .en: "Your edits are still open.",
        ],
        "ios.journey.draftInvalidTitle": [
            .zhHant: "修正這些欄位才能保存",
            .zhHans: "修正这些字段才能保存",
            .ja: "保存するには、これらの項目を修正してください",
            .en: "Fix these fields to save",
        ],
        "ios.journey.draftInvalidKept": [
            .zhHant: "在你保存之前，已保存的旅程不會改變。",
            .zhHans: "在你保存之前，已保存的行程不会改变。",
            .ja: "保存するまで、保存済みの乗車記録は変わりません。",
            .en: "The saved journey stays unchanged until you save.",
        ],
        "ios.journey.draftDirty": [
            .zhHant: "有未保存的變更",
            .zhHans: "有未保存的更改",
            .ja: "未保存の変更があります",
            .en: "Unsaved changes",
        ],

        // MARK: - action labels the resolver emits

        "ios.journey.retry": [
            .zhHant: "再試一次",
            .zhHans: "再试一次",
            .ja: "再試行",
            .en: "Try again",
        ],
        "ios.journey.clearSearch": [
            .zhHant: "清除搜尋",
            .zhHans: "清除搜索",
            .ja: "検索を消去",
            .en: "Clear search",
        ],

        // MARK: - labels this port supplies instead of the resolver's default
        //
        // `SecondaryAction.label` documents itself as a default that "views may
        // override", and three of its keys are wrong for a button on this
        // platform:
        //
        //   state.hidden / state.shown  the web catalog spells these as STATES
        //                               ("已隱藏", "表示中"), not as the verbs a
        //                               button needs.
        //   sec.import                  a section heading, "JSON 匯入／本地資料".
        //   btn.fit                     "定位" — which §4.1 requires be told
        //                               apart from locating the reader.

        "ios.journey.hideFromMap": [
            .zhHant: "從地圖隱藏",
            .zhHans: "从地图隐藏",
            .ja: "地図から隠す",
            .en: "Hide from map",
        ],
        "ios.journey.locateRoute": [
            .zhHant: "定位路線",
            .zhHans: "定位路线",
            .ja: "経路を表示",
            .en: "Locate route",
        ],
        "ios.journey.importJSON": [
            .zhHant: "匯入 JSON",
            .zhHans: "导入 JSON",
            .ja: "JSON を読み込む",
            .en: "Import JSON",
        ],

        // MARK: - surfaces this port has and the web app does not

        "ios.journey.listSummary": [
            .zhHant: "{journeys} 趟旅程 · {days} 天",
            .zhHans: "{journeys} 趟行程 · {days} 天",
            .ja: "{journeys} 本の行程 · {days} 日",
            .en: "{journeys} journeys · {days} days",
        ],
        "ios.journey.daySummary": [
            .zhHant: "{journeys} 趟旅程",
            .zhHans: "{journeys} 趟行程",
            .ja: "{journeys} 本の行程",
            .en: "{journeys} journeys",
        ],
        // §5.5 needs to name the stretch that has no railway drawn under it.
        // One gap is spelled with `ios.journey.endpoints`; this is the rest.
        "ios.journey.gapMore": [
            .zhHant: "{section} 等 {count} 個區間",
            .zhHans: "{section} 等 {count} 个区间",
            .ja: "{section} ほか {count} 区間",
            .en: "{section} and {count} more sections",
        ],
        "ios.journey.backToList": [
            .zhHant: "返回列表",
            .zhHans: "返回列表",
            .ja: "一覧に戻る",
            .en: "Back to the list",
        ],
        "ios.journey.clearSelection": [
            .zhHant: "取消選擇",
            .zhHans: "取消选择",
            .ja: "選択を解除",
            .en: "Clear selection",
        ],
        "ios.journey.moreActions": [
            .zhHant: "更多旅程操作",
            .zhHans: "更多行程操作",
            .ja: "その他の操作",
            .en: "More journey actions",
        ],
        "ios.journey.resizePanel": [
            .zhHant: "調整面板高度",
            .zhHans: "调整面板高度",
            .ja: "パネルの高さを調整",
            .en: "Resize the journey panel",
        ],
        "ios.journey.panelCompact": [
            .zhHant: "精簡", .zhHans: "精简", .ja: "コンパクト", .en: "Compact",
        ],
        "ios.journey.panelMedium": [
            .zhHant: "中等", .zhHans: "中等", .ja: "標準", .en: "Medium",
        ],
        "ios.journey.panelExpanded": [
            .zhHant: "展開", .zhHans: "展开", .ja: "拡大", .en: "Expanded",
        ],
        "ios.journey.addDateTitle": [
            .zhHant: "新增日期",
            .zhHans: "新增日期",
            .ja: "日付を追加",
            .en: "Add a date",
        ],
        "ios.journey.addDateDetail": [
            .zhHant: "先建立一個空的日期，之後再往裡面加旅程。",
            .zhHans: "先建立一个空的日期，之后再往里面加行程。",
            .ja: "空の日付を作り、あとから行程を追加できます。",
            .en: "Create an empty date to add journeys to later.",
        ],
        "ios.journey.deleteConfirm": [
            .zhHant: "刪除「{train}」？",
            .zhHans: "删除「{train}」？",
            .ja: "「{train}」を削除しますか？",
            .en: "Delete {train}?",
        ],
        "ios.journey.deleteDetail": [
            .zhHant: "這趟旅程會從此裝置上的資料中移除。",
            .zhHans: "这趟行程会从此设备上的数据中移除。",
            .ja: "この乗車記録は、この端末のデータから取り除かれます。",
            .en: "The journey is removed from the data on this device.",
        ],
        // MARK: - web keys the generated catalog turned out not to carry
        //
        // Each of these is spelled by a `data-i18n` attribute in the web app but
        // is absent from `Resources/Localizable.xcstrings`, so the native call
        // sites in this workspace were rendering their English fallback in all
        // four languages. Kept under the web key rather than renamed, so that
        // when the catalog does grow the entry it silently wins (`journeyText`
        // asks the catalog first).

        "btn.add": [
            .zhHant: "新增", .zhHans: "新增", .ja: "追加", .en: "Add",
        ],
        "btn.removeEmptyDates": [
            .zhHant: "刪除空白日期",
            .zhHans: "删除空白日期",
            .ja: "空の日付を削除",
            .en: "Remove empty dates",
        ],
        "toggle.currentDate": [
            .zhHant: "地圖只顯示所選日期",
            .zhHans: "地图只显示所选日期",
            .ja: "地図は選択した日付だけ表示",
            .en: "Map shows the selected date only",
        ],
        "play.focus": [
            .zhHant: "自動跟隨", .zhHans: "自动跟随", .ja: "自動追従", .en: "Auto focus",
        ],
        "video.cancel": [
            .zhHant: "取消影片輸出",
            .zhHans: "取消视频导出",
            .ja: "動画の書き出しを中止",
            .en: "Cancel video export",
        ],
        "video.finishing": [
            .zhHant: "正在完成影片",
            .zhHans: "正在完成视频",
            .ja: "動画を仕上げています",
            .en: "Finishing video",
        ],
        "video.share": [
            .zhHant: "分享影片", .zhHans: "分享视频", .ja: "動画を共有", .en: "Share video",
        ],

        "ios.journey.noRegionRecords": [
            .zhHant: "這個地區有鐵路資料包，但還沒有任何乘車記錄。",
            .zhHans: "这个地区有铁路数据包，但还没有任何乘车记录。",
            .ja: "この地域の鉄道データはありますが、乗車記録はまだありません。",
            .en: "This region has a railway package, but no recorded journeys yet.",
        ],
    ]
}

extension AppLocalization {

    /// The shared web catalog first, this port's own table second.
    ///
    /// `countryText` rather than `text` so that a key which grows a country
    /// variant (`key.tw`, `key.hk`, …) starts resolving to it without this call
    /// site changing — the rule `AppLocalization.countryText` documents. A key
    /// with no variant costs one dictionary miss and resolves exactly as `text`
    /// would.
    func journeyText(
        _ key: String,
        _ params: [String: Localization.Param]? = nil,
        fallback: String? = nil
    ) -> String {
        countryText(
            key,
            params: params,
            fallback: JourneyStrings.table[key]?[language] ?? fallback ?? key)
    }

    /// Resolves one string the presentation layer left unresolved.
    ///
    /// `key == nil` is `PresentationText`'s marker for a *record value* — a
    /// train number, a station name, a `Foundation` error message. Those go
    /// straight through: sending a train number to a translation table is how
    /// a record ends up renamed by its own interface.
    func journeyText(_ text: PresentationText) -> String {
        guard let key = text.key else { return text.fallback }
        return journeyText(
            key,
            text.params.isEmpty ? nil : text.params,
            fallback: text.fallback)
    }
}
