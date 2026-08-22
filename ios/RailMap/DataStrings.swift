import Foundation
import RailCore

/// The strings the data workspace needs that the web catalog does not carry.
///
/// `AppLocalization` already owns a table like this one, but it is another
/// port's file; adding to it from here would be an edit to work in flight.
/// The lookup below therefore goes through the shared engine FIRST — a key the
/// web app already spells (`btn.apply`, `prog.done`, `country.jp`) keeps the
/// web app's own wording in every language — and only falls back to this table
/// for the sentences the native data screen invented.
///
/// Every entry carries all four interface languages. A fallback string is an
/// English string, and an English string shown to a reader who chose 日本語 is
/// a localisation bug that compiles.
enum DataStrings {

    static let table: [String: [Localization.Language: String]] = [

        // MARK: source hero

        "data.sourceMine": [
            .zhHant: "我的資料 · {region}",
            .zhHans: "我的数据 · {region}",
            .ja: "自分のデータ · {region}",
            .en: "My data · {region}",
        ],
        "data.sourceSample": [
            .zhHant: "示例資料 · 唯讀預覽",
            .zhHans: "示例数据 · 只读预览",
            .ja: "サンプルデータ · 読み取り専用プレビュー",
            .en: "Sample data · read-only preview",
        ],
        "data.savedOnDevice": [
            .zhHant: "{count} 趟旅程 · 已保存在此裝置",
            .zhHans: "{count} 趟旅程 · 已保存在此设备",
            .ja: "{count} 本の乗車記録 · この端末に保存済み",
            .en: "{count} journeys · saved on this device",
        ],
        "data.notSavedOnDevice": [
            .zhHant: "{count} 趟旅程 · 尚未保存到此裝置",
            .zhHans: "{count} 趟旅程 · 尚未保存到此设备",
            .ja: "{count} 本の乗車記録 · この端末には未保存",
            .en: "{count} journeys · not saved on this device yet",
        ],
        "data.sampleSubtitle": [
            .zhHant: "{count} 趟旅程 · 內建示例，不會被覆寫",
            .zhHans: "{count} 趟旅程 · 内置示例，不会被覆盖",
            .ja: "{count} 本の乗車記録 · 内蔵サンプル（上書きされません）",
            .en: "{count} journeys · bundled sample, never overwritten",
        ],
        "data.sampleFootnote": [
            .zhHant: "編輯示例會另存成你自己的資料；內建示例永遠不會被覆寫。",
            .zhHans: "编辑示例会另存成你自己的数据；内置示例永远不会被覆盖。",
            .ja: "サンプルを編集すると自分のデータとして別に保存されます。内蔵サンプルが上書きされることはありません。",
            .en: "Editing a sample saves a copy as your own data; bundled samples are never overwritten.",
        ],
        "data.readingJourneys": [
            .zhHant: "正在讀取旅程…",
            .zhHans: "正在读取旅程…",
            .ja: "乗車記録を読み込んでいます…",
            .en: "Reading journeys…",
        ],
        "data.storageFootnote": [
            .zhHant: "旅程保存在此裝置上。匯入、匯出與統計都不需要網路。",
            .zhHans: "旅程保存在此设备上。导入、导出与统计都不需要网络。",
            .ja: "乗車記録はこの端末に保存されます。読み込み・書き出し・統計にネットワークは不要です。",
            .en: "Journeys live on this device. Import, export and statistics need no network.",
        ],

        // MARK: import — mode

        "data.importGroup": [
            .zhHant: "匯入", .zhHans: "导入", .ja: "読み込み", .en: "Import",
        ],
        "data.importMode": [
            .zhHant: "匯入方式", .zhHans: "导入方式", .ja: "読み込み方法", .en: "Import mode",
        ],
        "data.modeReplace": [
            .zhHant: "取代全部", .zhHans: "替换全部", .ja: "すべて置き換え", .en: "Replace all",
        ],
        "data.modeAppend": [
            .zhHant: "追加", .zhHans: "追加", .ja: "追加", .en: "Append",
        ],
        "data.modeReplaceDetail": [
            .zhHant: "目前的 {kept} 趟旅程會全部移除，換成檔案裡的 {count} 趟。",
            .zhHans: "当前的 {kept} 趟旅程会全部移除，换成文件里的 {count} 趟。",
            .ja: "現在の {kept} 本をすべて削除し、ファイルの {count} 本に置き換えます。",
            .en: "All {kept} current journeys are removed and replaced by the {count} in the file.",
        ],
        "data.modeAppendDetail": [
            .zhHant: "目前的 {kept} 趟旅程全部保留，檔案裡的 {count} 趟接在後面。",
            .zhHans: "当前的 {kept} 趟旅程全部保留，文件里的 {count} 趟接在后面。",
            .ja: "現在の {kept} 本はすべて残り、ファイルの {count} 本が後ろに追加されます。",
            .en: "All {kept} current journeys are kept; the {count} in the file are added after them.",
        ],
        "data.appendIdRule": [
            .zhHant: "ID 與現有旅程相同時，新的一趟會取得新 ID（如 {example}）。現有旅程不會被覆寫，也不會依 ID 更新。",
            .zhHans: "ID 与现有旅程相同时，新的一趟会取得新 ID（如 {example}）。现有旅程不会被覆盖，也不会按 ID 更新。",
            .ja: "既存と同じ ID の場合、新しい方に別の ID（例：{example}）が付きます。既存の記録は上書きも ID 更新もされません。",
            .en: "A colliding id is renamed on the incoming journey (e.g. {example}). Existing journeys are never overwritten or updated by id.",
        ],

        // MARK: import — preflight

        "data.preflight": [
            .zhHant: "匯入前檢查", .zhHans: "导入前检查", .ja: "読み込み前チェック", .en: "Preflight",
        ],
        "data.preflightTarget": [
            .zhHant: "匯入到", .zhHans: "导入到", .ja: "読み込み先", .en: "Imports into",
        ],
        "data.preflightRegionNote": [
            .zhHant: "JSON 本身不帶地區標記，會以目前地區（{region}）的規則匯入。",
            .zhHans: "JSON 本身不带地区标记，会以当前地区（{region}）的规则导入。",
            .ja: "JSON に地域の記載はありません。現在の地域（{region}）の規則で読み込みます。",
            .en: "The JSON carries no region of its own; it is imported under the current region ({region}).",
        ],
        "data.preflightDateNote": [
            .zhHant: "沒有 date 的旅程，依 JSON 的 date 欄位或 ID 自動判定日期。",
            .zhHans: "没有 date 的旅程，依 JSON 的 date 字段或 ID 自动判定日期。",
            .ja: "date のない列車は、JSON の date 項目または ID から日付を判定します。",
            .en: "Journeys without a date are filed by the JSON's own date field or by id.",
        ],
        "data.journeysInFile": [
            .zhHant: "檔案內旅程", .zhHans: "文件内旅程", .ja: "ファイル内の乗車記録", .en: "Journeys in file",
        ],
        "data.willAdd": [
            .zhHant: "將新增", .zhHans: "将新增", .ja: "追加される", .en: "Will be added",
        ],
        "data.willReplace": [
            .zhHant: "將取代", .zhHans: "将替换", .ja: "置き換えられる", .en: "Will be replaced",
        ],
        "data.willKeep": [
            .zhHant: "將保留", .zhHans: "将保留", .ja: "残る", .en: "Will be kept",
        ],
        "data.willRename": [
            .zhHant: "ID 將改名", .zhHans: "ID 将改名", .ja: "ID が変更される", .en: "Ids renamed",
        ],
        "data.problems": [
            .zhHant: "問題", .zhHans: "问题", .ja: "問題", .en: "Problems",
        ],
        "data.schemaVersion": [
            .zhHant: "結構版本", .zhHans: "结构版本", .ja: "スキーマ版", .en: "Schema version",
        ],
        "data.renameList": [
            .zhHant: "{from} → {to}", .zhHans: "{from} → {to}", .ja: "{from} → {to}", .en: "{from} → {to}",
        ],

        // MARK: import — stages

        "data.stageReading": [
            .zhHant: "讀取文件", .zhHans: "读取文件", .ja: "ファイルを読み込み中", .en: "Reading the document",
        ],
        "data.stageValidating": [
            .zhHant: "驗證 {count}/{total}",
            .zhHans: "验证 {count}/{total}",
            .ja: "検証 {count}/{total}",
            .en: "Validating {count}/{total}",
        ],
        "data.stageValidatingPlain": [
            .zhHant: "驗證旅程", .zhHans: "验证旅程", .ja: "乗車記録を検証中", .en: "Validating journeys",
        ],
        "data.stageImporting": [
            .zhHant: "匯入 {count}/{total}",
            .zhHans: "导入 {count}/{total}",
            .ja: "読み込み {count}/{total}",
            .en: "Importing {count}/{total}",
        ],
        "data.stageImportingPlain": [
            .zhHant: "逐趟匯入", .zhHans: "逐趟导入", .ja: "1 本ずつ読み込み中", .en: "Importing journeys",
        ],
        "data.stageGrouping": [
            .zhHant: "整理日期", .zhHans: "整理日期", .ja: "日付をまとめています", .en: "Grouping by date",
        ],
        "data.stageSaving": [
            .zhHant: "保存到此裝置", .zhHans: "保存到此设备", .ja: "この端末に保存中", .en: "Saving to this device",
        ],
        "data.stageInteractive": [
            .zhHant: "匯入期間可以繼續看地圖；資料要等這一步完成才會換。",
            .zhHans: "导入期间可以继续看地图；数据要等这一步完成才会更换。",
            .ja: "読み込み中も地図は見られます。データが入れ替わるのは完了後です。",
            .en: "The map stays readable while this runs; the store only changes when it finishes.",
        ],
        "data.routesLater": [
            .zhHant: "路線會在地圖載入時逐趟求解。某一趟求解失敗只影響那一趟。",
            .zhHans: "路线会在地图加载时逐趟求解。某一趟求解失败只影响那一趟。",
            .ja: "経路は地図の読み込み時に 1 本ずつ解きます。失敗してもその 1 本だけに影響します。",
            .en: "Routes are solved per journey when the map loads; a failure affects only that journey.",
        ],

        // MARK: import — outcome

        "data.importDone": [
            .zhHant: "已匯入 {count} 趟旅程，並保存在此裝置。",
            .zhHans: "已导入 {count} 趟旅程，并保存在此设备。",
            .ja: "{count} 本を読み込み、この端末に保存しました。",
            .en: "Imported {count} journeys and saved them on this device.",
        ],
        "data.importDoneRenamed": [
            .zhHant: "其中 {count} 趟因為 ID 重複而改了 ID。",
            .zhHans: "其中 {count} 趟因为 ID 重复而改了 ID。",
            .ja: "うち {count} 本は ID の重複により ID を変更しました。",
            .en: "{count} of them were given a new id because their id was already taken.",
        ],
        "data.importCancelled": [
            .zhHant: "已取消檢查。目前的旅程沒有任何變更。",
            .zhHans: "已取消检查。当前的旅程没有任何变更。",
            .ja: "チェックを中止しました。現在の乗車記録は変更されていません。",
            .en: "Check cancelled. Nothing in the current journeys changed.",
        ],
        "data.importBlocked": [
            .zhHant: "有 {count} 個問題要先修正，還不能匯入。",
            .zhHans: "有 {count} 个问题要先修正，还不能导入。",
            .ja: "先に {count} 件の問題を直す必要があります。",
            .en: "{count} problems have to be fixed before this can be imported.",
        ],
        "data.startImport": [
            .zhHant: "匯入 {count} 趟旅程",
            .zhHans: "导入 {count} 趟旅程",
            .ja: "{count} 本を読み込む",
            .en: "Import {count} journeys",
        ],
        "data.done": [
            .zhHant: "完成", .zhHans: "完成", .ja: "完了", .en: "Done",
        ],
        "data.recheck": [
            .zhHant: "重新檢查", .zhHans: "重新检查", .ja: "再チェック", .en: "Check again",
        ],
        "data.chooseAnotherFile": [
            .zhHant: "換一個檔案", .zhHans: "换一个文件", .ja: "別のファイルを選ぶ", .en: "Choose another file",
        ],
        "data.pasteHint": [
            .zhHant: "貼上完整 store、列車陣列，或單一列車物件。",
            .zhHans: "粘贴完整 store、列车数组，或单一列车对象。",
            .ja: "store 全体、列車の配列、または列車 1 件を貼り付けてください。",
            .en: "Paste a whole store, a trains array, or one train object.",
        ],

        // MARK: errors

        "data.errorImportTitle": [
            .zhHant: "無法匯入這份 JSON",
            .zhHans: "无法导入这份 JSON",
            .ja: "この JSON は読み込めません",
            .en: "This JSON cannot be imported",
        ],
        "data.errorKept": [
            .zhHant: "目前的 {count} 趟旅程沒有變更，也沒有被刪除。",
            .zhHans: "当前的 {count} 趟旅程没有变更，也没有被删除。",
            .ja: "現在の {count} 本は変更も削除もされていません。",
            .en: "The {count} journeys you already have are unchanged and were not deleted.",
        ],
        "data.errorNothingChanged": [
            .zhHant: "目前的旅程沒有變更。",
            .zhHans: "当前的旅程没有变更。",
            .ja: "現在の乗車記録は変更されていません。",
            .en: "Nothing in the current journeys changed.",
        ],
        "data.issueAt": [
            .zhHant: "位置：{path}", .zhHans: "位置：{path}", .ja: "位置：{path}", .en: "At {path}",
        ],
        "data.issueTrainID": [
            .zhHant: "旅程 ID：{id}", .zhHans: "旅程 ID：{id}", .ja: "乗車 ID：{id}", .en: "Journey id {id}",
        ],
        "data.issueDocumentRoot": [
            .zhHant: "整份文件", .zhHans: "整份文件", .ja: "ドキュメント全体", .en: "the document root",
        ],
        "data.moreIssues": [
            .zhHant: "另有 {count} 個問題未列出。",
            .zhHans: "另有 {count} 个问题未列出。",
            .ja: "ほかに {count} 件の問題があります。",
            .en: "{count} further problems are not listed.",
        ],

        "data.saveFailedTitle": [
            .zhHant: "無法保存到此裝置",
            .zhHans: "无法保存到此设备",
            .ja: "この端末に保存できません",
            .en: "Could not save to this device",
        ],
        "data.saveFailedKept": [
            .zhHant: "旅程仍在畫面上，但重新啟動後會回到上次保存的版本。",
            .zhHans: "旅程仍在画面上，但重新启动后会回到上次保存的版本。",
            .ja: "画面の乗車記録は残りますが、再起動すると前回保存した内容に戻ります。",
            .en: "The journeys are still on screen, but a relaunch will show the last saved version.",
        ],
        "data.saveRetry": [
            .zhHant: "再保存一次", .zhHans: "再保存一次", .ja: "もう一度保存", .en: "Save again",
        ],
        "data.loadFailedTitle": [
            .zhHant: "無法讀取這個地區的旅程",
            .zhHans: "无法读取这个地区的旅程",
            .ja: "この地域の乗車記録を読み込めません",
            .en: "Could not read this region's journeys",
        ],
        "data.loadFailedKept": [
            .zhHant: "保存在此裝置上的檔案沒有被改動。",
            .zhHans: "保存在此设备上的文件没有被改动。",
            .ja: "この端末に保存されたファイルは変更されていません。",
            .en: "The file saved on this device was not modified.",
        ],
        "data.retryLoad": [
            .zhHant: "重新讀取", .zhHans: "重新读取", .ja: "再読み込み", .en: "Read again",
        ],

        // MARK: degradation

        "data.availability": [
            .zhHant: "地圖與可用性", .zhHans: "地图与可用性", .ja: "地図と利用可否", .en: "Map and availability",
        ],
        "data.packageReady": [
            .zhHant: "{region} 路網：{count} 條線路已載入",
            .zhHans: "{region} 路网：{count} 条线路已加载",
            .ja: "{region} 路線網：{count} 路線を読み込み済み",
            .en: "{region} network: {count} lines loaded",
        ],
        "data.packageLoading": [
            .zhHant: "正在載入 {region} 路網…",
            .zhHans: "正在加载 {region} 路网…",
            .ja: "{region} の路線網を読み込み中…",
            .en: "Loading the {region} network…",
        ],
        "data.packageMissingTitle": [
            .zhHant: "{region} 的路網資料無法載入",
            .zhHans: "{region} 的路网数据无法加载",
            .ja: "{region} の路線網データを読み込めません",
            .en: "The {region} network package could not be loaded",
        ],
        "data.packageMissingImpact": [
            .zhHant: "這個地區的地圖畫不出鐵路，路線也無法求解。",
            .zhHans: "这个地区的地图画不出铁路，路线也无法求解。",
            .ja: "この地域では鉄道を描画できず、経路も解けません。",
            .en: "This region's map cannot draw railways, and routes cannot be solved.",
        ],
        "data.packageMissingKept": [
            .zhHant: "旅程記錄仍然可以瀏覽、編輯、匯入與匯出。",
            .zhHans: "旅程记录仍然可以浏览、编辑、导入与导出。",
            .ja: "乗車記録の閲覧・編集・読み込み・書き出しは引き続きできます。",
            .en: "Journey records can still be browsed, edited, imported and exported.",
        ],
        "data.packageRetry": [
            .zhHant: "重新載入路網", .zhHans: "重新加载路网", .ja: "路線網を再読み込み", .en: "Load the network again",
        ],

        // MARK: export

        "data.exportGroup": [
            .zhHant: "匯出與備份", .zhHans: "导出与备份", .ja: "書き出しとバックアップ", .en: "Export and backup",
        ],
        "data.copyJSON": [
            .zhHant: "複製 JSON", .zhHans: "复制 JSON", .ja: "JSON をコピー", .en: "Copy JSON",
        ],
        "data.dismiss": [
            .zhHant: "知道了", .zhHans: "知道了", .ja: "閉じる", .en: "Dismiss",
        ],
        "data.previewTruncated": [
            .zhHant: "預覽只顯示開頭；完整內容請用匯出或複製。",
            .zhHans: "预览只显示开头；完整内容请用导出或复制。",
            .ja: "プレビューは先頭のみです。全体は書き出しかコピーで取得してください。",
            .en: "The preview shows the beginning only; export or copy for the whole document.",
        ],
        "data.copied": [
            .zhHant: "已複製", .zhHans: "已复制", .ja: "コピーしました", .en: "Copied",
        ],
        "data.exportSize": [
            .zhHant: "{count} 趟旅程 · 約 {kb} KB",
            .zhHans: "{count} 趟旅程 · 约 {kb} KB",
            .ja: "{count} 本 · 約 {kb} KB",
            .en: "{count} journeys · about {kb} KB",
        ],

        // MARK: danger zone and recovery

        "data.deleteAllTitle": [
            .zhHant: "刪除全部旅程", .zhHans: "删除全部旅程", .ja: "すべての乗車記録を削除", .en: "Delete every journey",
        ],
        "data.deleteAllScope": [
            .zhHant: "會刪除 {region} 的 {count} 趟旅程，包含保存在此裝置的副本。其他地區不受影響。",
            .zhHans: "会删除 {region} 的 {count} 趟旅程，包含保存在此设备的副本。其他地区不受影响。",
            .ja: "{region} の {count} 本を、この端末の保存分も含めて削除します。他の地域には影響しません。",
            .en: "Deletes {region}'s {count} journeys, including the copy saved on this device. Other regions are untouched.",
        ],
        "data.deleteAllRecovery": [
            .zhHant: "刪除前會先寫一份備份，之後可以從「從備份恢復」還原。",
            .zhHans: "删除前会先写一份备份，之后可以从「从备份恢复」还原。",
            .ja: "削除前にバックアップを作成するので、「バックアップから復元」で戻せます。",
            .en: "A backup is written first, so this can be undone from “Restore from backup”.",
        ],
        "data.deleteSavedScope": [
            .zhHant: "會刪除保存在此裝置上的 {region} 副本。畫面上的旅程會換回內建示例。",
            .zhHans: "会删除保存在此设备上的 {region} 副本。画面上的旅程会换回内置示例。",
            .ja: "この端末に保存された {region} のコピーを削除します。画面は内蔵サンプルに戻ります。",
            .en: "Deletes the {region} copy saved on this device. The screen falls back to the bundled sample.",
        ],
        "data.recovery": [
            .zhHant: "恢復", .zhHans: "恢复", .ja: "復元", .en: "Recovery",
        ],
        "data.backupAvailable": [
            .zhHant: "備份：{count} 趟旅程 · {time}",
            .zhHans: "备份：{count} 趟旅程 · {time}",
            .ja: "バックアップ：{count} 本 · {time}",
            .en: "Backup: {count} journeys · {time}",
        ],
        "data.backupReasonImport": [
            .zhHant: "匯入前自動備份", .zhHans: "导入前自动备份", .ja: "読み込み前の自動バックアップ", .en: "Taken before an import",
        ],
        "data.backupReasonDeleteAll": [
            .zhHant: "刪除全部前自動備份", .zhHans: "删除全部前自动备份", .ja: "全削除前の自動バックアップ", .en: "Taken before deleting everything",
        ],
        "data.backupReasonReplace": [
            .zhHant: "重置示例前自動備份", .zhHans: "重置示例前自动备份", .ja: "サンプル初期化前の自動バックアップ", .en: "Taken before resetting to the sample",
        ],
        "data.restoreBackup": [
            .zhHant: "從備份恢復", .zhHans: "从备份恢复", .ja: "バックアップから復元", .en: "Restore from backup",
        ],
        "data.restoreBackupDetail": [
            .zhHant: "會把目前的旅程換成備份裡的 {count} 趟。",
            .zhHans: "会把当前的旅程换成备份里的 {count} 趟。",
            .ja: "現在の乗車記録をバックアップの {count} 本に置き換えます。",
            .en: "Replaces the current journeys with the {count} in the backup.",
        ],
        "data.discardBackup": [
            .zhHant: "刪除備份", .zhHans: "删除备份", .ja: "バックアップを削除", .en: "Delete the backup",
        ],
        "data.noBackup": [
            .zhHant: "目前沒有備份。",
            .zhHans: "当前没有备份。",
            .ja: "バックアップはありません。",
            .en: "There is no backup right now.",
        ],
    ]
}

extension AppLocalization {

    /// The shared catalog first, this port's own table second.
    ///
    /// A key the web app already spells keeps the web app's wording — the two
    /// products should not describe 匯出 JSON differently — and only the
    /// sentences the native screen invented come from ``DataStrings``.
    func dataText(_ key: String, _ params: [String: Localization.Param]? = nil) -> String {
        text(key, params: params, fallback: DataStrings.table[key]?[language] ?? key)
    }
}
