// ---------------------------------------------------------------------------
// i18n-strings.js — UI string catalogs for the N02 Limited Express Manager.
//
// Loaded BEFORE i18n.js, which owns the runtime (language switching, "{x}"
// placeholder fill, Traditional→Simplified conversion, proper-noun glosses)
// and reads these catalogs from the I18NStrings global:
//
//   STRINGS     "key" -> { zh, en }  Traditional Chinese + English copy
//                                    (the zh-Hans UI is derived from zh at
//                                    runtime by i18n.js)
//   JA_STRINGS  "key" -> string      complete Japanese locale overlay
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  // ---- UI strings ---------------------------------------------------------
  // Every value is { zh, en }. Use "{name}" style placeholders for params.
  const STRINGS = {
    // language picker
    "lang.label": { zh: "語言", en: "Language" },

    // header
    "app.title": { zh: "N02 特急列車管理", en: "N02 Limited Express Manager" },
    "app.hint": {
      zh: "在地圖中檢視行程、編輯列車與停站，並管理 JSON 資料。",
      en: "View journeys on the map, edit trains and stops, and manage JSON data.",
    },

    // persistent workspace navigation
    "nav.label": { zh: "工作區導覽", en: "Workspace navigation" },
    "nav.trains": { zh: "列車", en: "Trains" },
    "nav.editor": { zh: "編輯", en: "Edit" },
    "nav.data": { zh: "資料", en: "Data" },
    "nav.display": { zh: "顯示", en: "Display" },
    "nav.about": { zh: "說明", en: "About" },
    "menu.hide": { zh: "隱藏選單", en: "Hide menu" },
    "menu.show": { zh: "顯示選單", en: "Show menu" },

    // search & actions
    "sec.search": { zh: "搜尋與操作", en: "Search & Actions" },
    "ph.search": {
      zh: "搜尋車次、列車、車站或 ID",
      en: "Search by train number, name, station or ID",
    },
    "btn.addTrain": { zh: "新增列車", en: "Add Train" },
    "btn.duplicate": { zh: "複製", en: "Duplicate" },
    "btn.delete": { zh: "刪除", en: "Delete" },
    "btn.deleteAll": { zh: "全部刪除", en: "Delete All" },
    "btn.fit": { zh: "定位", en: "Locate" },
    "btn.clearSel": { zh: "取消選擇", en: "Clear Selection" },
    "btn.autoFocus": { zh: "自動聚焦：", en: "Auto-focus: " },
    "state.on": { zh: "開", en: "On" },
    "state.off": { zh: "關", en: "Off" },

    // country switch (per-country separate stores)
    "country.label": { zh: "國家", en: "Country" },
    "country.jp": { zh: "日本", en: "Japan" },
    "country.tw": { zh: "台灣", en: "Taiwan" },

    // display settings
    "disp.reset": { zh: "重置為預設", en: "Reset to Defaults" },
    "theme.label": { zh: "主題", en: "Theme" },
    "theme.system": { zh: "跟隨系統", en: "System" },
    "theme.light": { zh: "亮色", en: "Light" },
    "theme.dark": { zh: "暗色", en: "Dark" },
    "uiMode.label": { zh: "UI 模式", en: "UI mode" },
    "uiMode.auto": { zh: "自動偵測", en: "Auto detect" },
    "uiMode.mobile": { zh: "移動端", en: "Mobile" },
    "uiMode.desktop": { zh: "桌面端", en: "Desktop" },
    "uiMode.status": {
      zh: "偵測：{device} · 目前：{mode}",
      en: "Detected: {device} · Active: {mode}",
    },
    "uiMode.device.phone": { zh: "手機", en: "phone" },
    "uiMode.device.tablet": { zh: "平板", en: "tablet" },
    "uiMode.device.computer": { zh: "電腦", en: "computer" },
    "disp.hint": {
      zh: "擬合參數拖動後，須按「重建擬合曲線」才會套用。大細節尺度可把密集拐點拉成直線或平滑弧線；青色為命中框、橙色為暫留範圍、洋紅為區間切換範圍。",
      en: "After changing a fit slider, press Rebuild Fitted Curves to apply it. A large detail scale can turn dense bends into a straight span or smooth arc. Cyan shows the pick box, orange the hold radius, and magenta the interval-switch zone.",
    },
    "disp.routeWidthScale": { zh: "線路粗細", en: "Line width" },
    "disp.riddenOpacity": { zh: "已乘區間透明度", en: "Ridden segment opacity" },
    "disp.dimOpacity": { zh: "非當前日期淡化", en: "Off-date dimming" },
    "disp.terminalRadius": { zh: "端點（起／終站）大小", en: "Terminal (origin/dest) size" },
    "disp.stopRadius": { zh: "停靠站中心黑點大小", en: "Stop center-dot size" },
    "disp.passRadius": {
      zh: "中途停靠／通過站外圈大小",
      en: "Stop / pass-through outer size",
    },
    "disp.markerStrokeScale": { zh: "標記邊框粗細", en: "Marker border width" },
    "disp.focusBoost": { zh: "選中放大量", en: "Selection zoom boost" },
    "disp.mapOpacity": { zh: "地圖底圖透明度", en: "Basemap opacity" },
    "disp.fitCurvePrecision": {
      zh: "擬合曲線採樣精度",
      en: "Fitted-curve sampling precision",
    },
    "disp.fitCurveMinRadius": { zh: "最小曲線半徑", en: "Minimum curve radius" },
    "disp.fitCurveMinDetail": { zh: "最小細節尺度", en: "Minimum detail scale" },
    "disp.fitCurveMaxDeviation": { zh: "最大允許偏離原線", en: "Maximum source deviation" },
    "disp.fullCrossDay": {
      zh: "顯示完整跨天行程（不使用虛線）",
      en: "Show Full Cross-Day Runs (No Dashes)",
    },
    "disp.fitCurves": { zh: "顯示擬合曲線（除錯）", en: "Show Fitted Curves (Debug)" },
    "disp.fitCurveOverlapNote": {
      zh: "擬合曲線僅涵蓋重疊區間（多列車共線的走廊）；未重疊的路線不會產生曲線。",
      en: "Fitted curves only cover overlapping corridors (track shared by multiple trains); non-overlapping routes produce no curve.",
    },
    "disp.rebuildFitCurves": { zh: "重建擬合曲線", en: "Rebuild Fitted Curves" },
    "disp.fitCurvePendingHint": {
      zh: "參數已修改，尚未生效——點擊「重建擬合曲線」套用。",
      en: "Settings changed but not applied yet — click “Rebuild Fitted Curves” to apply.",
    },
    "disp.hoverRegions": { zh: "顯示 Hover 監測範圍（除錯）", en: "Show Hover Regions (Debug)" },
    "disp.nameReadingKana": { zh: "站名假名顯示", en: "Station Kana Readings" },
    "disp.nameReadingRomaji": { zh: "站名羅馬字顯示", en: "Station Romaji Readings" },
    "disp.nameReadingZh": { zh: "站名中文顯示", en: "Station Chinese Names" },

    // JSON import / local data
    "sec.import": { zh: "JSON 匯入／本地資料", en: "JSON Import / Local Data" },
    "ph.importJson": {
      zh: '貼上完整 store：{"schema_version":"1.3","trains":[...]}，也可貼上列車陣列或單一列車物件',
      en: 'Paste a full store: {"schema_version":"1.3","trains":[...]}, or a train array or a single train object',
    },
    "btn.openLocal": { zh: "打開本地 JSON", en: "Open Local JSON" },
    "btn.saveLocal": { zh: "保存／另存 JSON", en: "Save / Save As JSON" },
    "btn.validate": { zh: "驗證匯入 JSON", en: "Validate Import JSON" },
    "btn.apply": { zh: "開始載入／逐條匯入", en: "Start Loading / Import Items" },

    // data source (static deploy: sample data vs the user's own browser store)
    "sec.dataSource": { zh: "資料來源", en: "Data Source" },
    "hint.dataSource": {
      zh: "示例資料僅供瀏覽，任何更改都不會保存；你的資料保存在此瀏覽器中，編輯時自動保存。",
      en: "Sample data is for browsing only — changes to it are never saved. Your own data is stored in this browser and auto-saves as you edit.",
    },
    "btn.loadSampleAll": { zh: "載入全部示例資料", en: "Load Full Sample Data" },
    "btn.loadNewYearGrandLoop": {
      zh: "載入跨年大回行程",
      en: "Load New Year Grand Loop",
    },
    "btn.loadTokyoLimitedExpressLoop": {
      zh: "載入東京特急大回行程",
      en: "Load Tokyo Limited-Express Loop",
    },
    "btn.restoreMine": { zh: "恢復我的資料", en: "Restore My Data" },
    "btn.saveAsMine": { zh: "保存為我的資料", en: "Save as My Data" },
    "mode.user": {
      zh: "目前顯示：我的資料（自動保存在此瀏覽器）",
      en: "Showing: my data (auto-saved in this browser)",
    },
    "mode.sampleSingle": {
      zh: "目前顯示：示例資料 {date}（更改不會保存）",
      en: "Showing: sample data {date} (changes are not saved)",
    },
    "mode.sampleAll": {
      zh: "目前顯示：全部示例資料（更改不會保存）",
      en: "Showing: full sample data (changes are not saved)",
    },
    "mode.newYearGrandLoop": {
      zh: "目前顯示：跨年大回行程（更改不會保存）",
      en: "Showing: New Year grand loop (changes are not saved)",
    },
    "mode.tokyoLimitedExpressLoop": {
      zh: "目前顯示：東京特急大回行程（更改不會保存）",
      en: "Showing: Tokyo limited-express loop (changes are not saved)",
    },
    "confirm.loadSampleAll": {
      zh: "載入全部示例資料？目前畫面上的內容會被示例取代（你保存的資料不受影響，可隨時恢復）。",
      en: "Load the full sample data? What is on screen will be replaced by the sample (your saved data is untouched and can be restored anytime).",
    },
    "confirm.loadNewYearGrandLoop": {
      zh: "載入跨年大回行程？目前畫面上的內容會被這套獨立行程取代（你保存的資料不受影響，可隨時恢復）。",
      en: "Load the New Year grand loop? What is on screen will be replaced by this separate itinerary (your saved data is untouched and can be restored anytime).",
    },
    "confirm.loadTokyoLimitedExpressLoop": {
      zh: "載入東京特急大回行程？目前畫面上的內容會被這套獨立行程取代（你保存的資料不受影響，可隨時恢復）。",
      en: "Load the Tokyo limited-express loop? What is on screen will be replaced by this separate itinerary (your saved data is untouched and can be restored anytime).",
    },
    "confirm.restoreMine": {
      zh: "恢復我的資料？目前顯示的示例（包含未保存的更改）會被捨棄。",
      en: "Restore my data? The sample currently shown (including unsaved changes) will be discarded.",
    },
    "confirm.saveAsMine": {
      zh: "把目前畫面上的內容保存為我的資料？之後的編輯會自動保存在此瀏覽器。",
      en: "Save what is on screen as my data? Future edits will auto-save in this browser.",
    },
    "confirm.overwriteMine": {
      zh: "注意：你已有保存的資料。把目前畫面內容保存為我的資料會覆蓋原有保存，且無法復原。確定？",
      en: "Warning: you already have saved data. Saving the current view as my data will overwrite it and cannot be undone. Continue?",
    },
    "confirm.clearStorage": {
      zh: "確定清除此瀏覽器保存的資料？此操作無法復原。",
      en: "Clear the data saved in this browser? This cannot be undone.",
    },
    "confirm.importInSample": {
      zh: "目前顯示的是示例資料。按「確定」：清除示例、只匯入你的 JSON，並保存為我的資料；按「取消」：把 JSON 暫時疊加到示例上（不保存）。",
      en: "Sample data is currently shown. OK: clear the sample, import only your JSON and save it as my data. Cancel: overlay the JSON on the sample temporarily (not saved).",
    },
    "status.sampleSingleLoaded": {
      zh: "已載入示例資料 {date}（{count} 趟列車）。示例僅供瀏覽，不會保存；按「載入全部示例資料」可查看全部日期。",
      en: "Loaded sample data for {date} ({count} trains). The sample is view-only and never saved; press “Load Full Sample Data” to see every date.",
    },
    "status.sampleAllLoaded": {
      zh: "已載入全部示例資料（{count} 趟列車）。示例僅供瀏覽，更改不會保存。",
      en: "Loaded the full sample data ({count} trains). The sample is view-only; changes are not saved.",
    },
    "status.newYearGrandLoopLoaded": {
      zh: "已載入跨年大回行程（{count} 趟列車）。此行程與一般示例分開，僅供瀏覽，更改不會保存。",
      en: "Loaded the New Year grand loop ({count} trains). It is separate from the regular sample and is view-only; changes are not saved.",
    },
    "status.tokyoLimitedExpressLoopLoaded": {
      zh: "已載入東京特急大回行程（{count} 趟列車）。此行程與其他示例分開，僅供瀏覽，更改不會保存。",
      en: "Loaded the Tokyo limited-express loop ({count} trains). It is separate from the other samples and is view-only; changes are not saved.",
    },
    "status.savedAsMine": {
      zh: "已保存為我的資料（{count} 趟列車），之後的編輯會自動保存在此瀏覽器。",
      en: "Saved as my data ({count} trains). Future edits auto-save in this browser.",
    },
    "status.noUserStore": {
      zh: "此瀏覽器中沒有已保存的資料。",
      en: "No saved data in this browser.",
    },
    "status.sampleNoSave": {
      zh: "示例模式：更改不會保存。想保留目前內容，請在「資料」分頁按「保存為我的資料」。",
      en: "Sample mode: changes are not saved. To keep the current content, press “Save as My Data” in the Data tab.",
    },
    "status.autosaveLocalOk": {
      zh: "已自動保存到此瀏覽器。",
      en: "Auto-saved in this browser.",
    },
    "status.autosaveConflict": {
      zh: "未保存：另一個分頁已更改 {date} 的資料。請先匯出此分頁的 JSON，再重新載入以免覆蓋較新的資料。",
      en: "Not saved: another tab changed {date}. Export this tab’s JSON before reloading so the newer saved data is not overwritten.",
    },
    "src.userStore": { zh: "我的資料（此瀏覽器保存）", en: "my data (saved in this browser)" },
    "src.sampleDay": { zh: "示例資料 {date}", en: "sample data {date}" },
    "src.sampleAll": { zh: "全部示例資料", en: "full sample data" },
    "src.newYearGrandLoop": {
      zh: "跨年大回行程",
      en: "New Year grand loop",
    },
    "src.tokyoLimitedExpressLoop": {
      zh: "東京特急大回行程",
      en: "Tokyo limited-express loop",
    },
    "err.noSampleData": {
      zh: "示例資料目前無法載入，請稍後再試。",
      en: "Sample data is unavailable right now; please try again later.",
    },
    "err.noNewYearGrandLoopData": {
      zh: "跨年大回行程目前無法載入，請稍後再試。",
      en: "The New Year grand loop is unavailable right now; please try again later.",
    },
    "err.noTokyoLimitedExpressLoopData": {
      zh: "東京特急大回行程目前無法載入，請稍後再試。",
      en: "The Tokyo limited-express loop is unavailable right now; please try again later.",
    },

    // card / group titles (railprint-style folder-tab cards)
    "grp.edit": { zh: "編輯選中列車", en: "Edit Selected Train" },
    "grp.dates": { zh: "日期與篩選", en: "Dates & Filters" },
    "grp.trainResults": { zh: "當日列車", en: "Trains for This Date" },
    "grp.listActions": { zh: "列車操作", en: "Train Actions" },
    "grp.data": { zh: "資料管理", en: "Data Management" },
    "grp.danger": { zh: "危險區域", en: "Danger Zone" },
    "hint.danger": {
      zh: "這些操作會影響全部資料，無法復原，請小心使用。",
      en: "These actions affect all data and cannot be undone. Use with care.",
    },

    // mileage statistics (railprint-style coverage)
    "nav.stats": { zh: "統計", en: "Stats" },
    "sec.stats": { zh: "里程統計", en: "Mileage Stats" },
    "stat.all": { zh: "全國", en: "Nationwide" },
    "stat.hsr": { zh: "新幹線", en: "Shinkansen" },
    "stat.conv": { zh: "普通鐵道（在來線）", en: "Conventional rail" },
    "stat.jr": { zh: "JR（含新幹線）", en: "JR (incl. Shinkansen)" },
    "stat.metro": { zh: "地下鐵", en: "Subway" },
    "stat.priv": { zh: "私鐵・第三部門", en: "Private & 3rd-sector" },
    "stat.tram": { zh: "路面電車", en: "Trams" },
    "stat.allrail": { zh: "全部鐵道", en: "All Railways" },
    "stat.jrconv": { zh: "JR在來線", en: "JR Conventional" },
    "stats.loading": { zh: "正在載入路網資料…", en: "Loading rail network…" },
    "stats.dailyTitle": { zh: "當日統計（{date}）", en: "Selected Day ({date})" },
    "stats.overallTitle": { zh: "全部統計", en: "All-Time Total" },
    "stats.coverageTitle": { zh: "路網覆蓋率", en: "Network Coverage" },
    "stats.actualTitle": { zh: "實際乘坐量", en: "Actual Rides" },
    "stats.byLine": { zh: "分線明細", en: "By line" },
    "stats.byCount": { zh: "依次數", en: "By ride count" },
    "stats.topSegmentsTitle": { zh: "最常乘坐區間", en: "Most-Ridden Sections" },
    "stats.topSegmentsHint": {
      zh: "以相鄰車站之間的區間計算，來回視為同一區間；次數為搭乘過的班次數。",
      en: "Counted per station-to-station section; both directions share one row, and the count is how many services rode it.",
    },
    "stat.rides": { zh: "{n} 次", en: "{n}×" },
    "stat.time": { zh: "乘車時間", en: "Ride Time" },
    "stat.ltdexp": { zh: "有料特急", en: "Paid Ltd. Express" },
    "stat.othertrains": { zh: "其他列車", en: "Other trains" },
    "stat.trains": { zh: "{n} 班次", en: "{n} train(s)" },
    "fmt.duration": { zh: "{h} 小時 {m} 分", en: "{h}h {m}m" },
    "fmt.durationM": { zh: "{m} 分", en: "{m}m" },
    "stats.empty": { zh: "尚無乘坐記錄。", en: "No rides recorded yet." },
    "stats.hint": {
      zh: "依全部列車的實際乘坐區間（乘坐勾選）去重合併計算；總里程來自国土数値情報 N02-25 全路網。",
      en: "Computed from every train's actually-ridden intervals (ride checkboxes), deduplicated across trains; totals come from the full N02-25 national network.",
    },

    // train list
    "sec.list": { zh: "列車清單", en: "Train List" },
    "btn.addDate": { zh: "新增日期", en: "Add Date" },
    "btn.removeEmpty": { zh: "刪除空日期", en: "Remove Empty Dates" },
    "chk.mapDateFilter": { zh: "地圖僅顯示當前日期", en: "Map shows current date only" },

    // train data form
    "sec.trainData": { zh: "列車資料", en: "Train Data" },
    "field.id": { zh: "列車 ID", en: "Train ID" },
    "field.number": { zh: "車次", en: "Train No." },
    "field.trainType": { zh: "車輛類型", en: "Train Type" },
    "ph.trainType": { zh: "特急／普通／新幹線", en: "Ltd. Exp. / Local / Shinkansen" },
    "field.company": { zh: "車輛公司", en: "Company" },
    "ph.company": {
      zh: "JR西日本；直通用／分隔多家公司",
      en: "e.g. JR西日本; separate through-service companies with /",
    },
    "tag.through": { zh: "直通", en: "Through" },
    "field.direction": { zh: "方向", en: "Direction" },
    "ph.direction": { zh: "下行／上行", en: "Inbound / Outbound" },
    "field.origin": { zh: "起站", en: "Origin" },
    "field.destination": { zh: "終站", en: "Destination" },
    "field.color": { zh: "顏色", en: "Color" },
    "field.weight": { zh: "線寬", en: "Line Width" },
    "btn.saveFields": { zh: "套用欄位", en: "Apply Fields" },
    "btn.toggleVisible": { zh: "顯示／隱藏", en: "Show/Hide" },
    "btn.moveUp": { zh: "上移", en: "Move Up" },
    "btn.moveDown": { zh: "下移", en: "Move Down" },

    // stops table
    "sec.stops": { zh: "停靠站與通過站", en: "Stops & Pass-throughs" },
    "th.seq": { zh: "序", en: "#" },
    "th.station": { zh: "車站", en: "Station" },
    "th.arr": { zh: "到", en: "Arr" },
    "th.dep": { zh: "發", en: "Dep" },
    "th.type": { zh: "類型", en: "Type" },
    "th.ride": { zh: "乘坐", en: "Ride" },
    "th.actions": { zh: "操作", en: "Actions" },
    "btn.addStop": { zh: "新增停站", en: "Add Stop" },
    "btn.rebuildRoute": { zh: "依停站重建路線", en: "Rebuild Route from Stops" },
    "table.stopsLabel": { zh: "停靠站表格", en: "Stops table" },
    // branch (支線) grouping in the stops table
    "branch.tag": { zh: "支線／Branch", en: "Branch" },
    "branch.junction": { zh: "分歧站／Junction", en: "Junction" },
    "branch.rideAll": { zh: "整段乘坐／隱藏", en: "Ride / hide whole branch" },
    "branch.noline": { zh: "（未指定路線）", en: "(no line set)" },

    // JSON export
    "sec.export": { zh: "JSON 匯出", en: "JSON Export" },
    "btn.exportJson": { zh: "匯出 JSON", en: "Export JSON" },
    "btn.downloadJson": { zh: "下載 JSON", en: "Download JSON" },
    "btn.resetDefaults": { zh: "重置示例", en: "Reset Sample" },
    "btn.downloadHtml": { zh: "下載目前 HTML", en: "Download Current HTML" },
    "btn.clearStorage": { zh: "清除保存資料", en: "Clear Saved Data" },

    // legend & sources
    "sec.legend": { zh: "圖例與資料來源", en: "Legend & Data Sources" },
    "legend.railway": {
      zh: "全部線路（開關預設關閉）：各線路官方色（淡）＋灰色車站點",
      en: "All railway lines (switch, off by default): official line colors (faded) + grey station dots",
    },
    "legend.station": {
      zh: "中途停靠站：空心圓加黑色中心點；通過站：同尺寸空心圓；起終點：墨色大圓點",
      en: "Intermediate stops: outlined circles with black centers; pass-throughs: same-size outlined circles; endpoints: large ink dots",
    },
    "legend.express": {
      zh: "特急路線：全色加粗（選中時墨色底襯）",
      en: "Limited express routes: full color, thicker (ink casing when selected)",
    },
    "legend.source1": {
      zh: "鐵路線資料：「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成（CC BY 4.0）。",
      en: 'Railway data: created from "National Land Numerical Information (Railway Data N02)" (MLIT Japan), CC BY 4.0.',
    },
    "legend.source2": {
      zh: "Basemap © OpenStreetMap contributors｜OpenFreeMap (Positron / Dark)。Romanizations © OpenStreetMap contributors, ODbL。Rail package © railprint (jp-2025)。",
      en: "Basemap © OpenStreetMap contributors｜OpenFreeMap (Positron / Dark). Romanizations © OpenStreetMap contributors, ODbL. Rail package © railprint (jp-2025).",
    },

    // unified map information panel (bottom-right i button)
    "info.button": { zh: "開啟圖例與資料來源", en: "Open legend and data sources" },
    "info.title": { zh: "圖例與資料來源", en: "Legend & Data Sources" },
    "info.intro": {
      zh: "快速理解地圖符號，以及本地圖使用的資料與授權。",
      en: "A quick guide to map symbols, data providers, and licenses.",
    },
    "info.legendHeading": { zh: "地圖圖例", en: "Map Legend" },
    "info.routeTitle": { zh: "列車路線", en: "Train routes" },
    "info.routeDesc": {
      zh: "使用列車指定色顯示；選中時增加墨色底襯。",
      en: "Shown in each train's assigned color, with an ink casing when selected.",
    },
    "info.stopTitle": { zh: "中途停靠站", en: "Intermediate stops" },
    "info.stopDesc": {
      zh: "與通過站使用相同大小的空心圓，中心增加黑點。",
      en: "The same outlined-circle size as pass-throughs, with a black center dot.",
    },
    "info.passTitle": { zh: "通過站", en: "Pass-through stations" },
    "info.passDesc": {
      zh: "與中途停靠站外圈同尺寸，但中心保持留白。",
      en: "The same outer-circle size as intermediate stops, with an empty center.",
    },
    "info.terminalTitle": { zh: "起點與終點", en: "Origin & destination" },
    "info.terminalDesc": {
      zh: "使用較大的墨色圓點與白色外圈，保持行程端點醒目。",
      en: "Larger ink dots with white rings keep the journey endpoints prominent.",
    },
    "info.networkTitle": { zh: "全部鐵路線", en: "All railway lines" },
    "info.networkDesc": {
      zh: "可在地圖圖層中開啟，顯示官方路線色與灰色車站點。",
      en: "Optional in Map Layers, using official line colors and grey station dots.",
    },
    "info.sourcesHeading": { zh: "資料與授權", en: "Data & Licenses" },
    "info.n02Title": { zh: "日本鐵路網", en: "Japan railway network" },
    "info.n02Body": {
      zh: "國土交通省「國土數值情報（鐵道資料 N02）」經加工製作。",
      en: "Processed from MLIT National Land Numerical Information (Railway Data N02).",
    },
    "info.basemapTitle": { zh: "地圖底圖", en: "Basemap" },
    "info.basemapBody": {
      zh: "亮色使用 OpenFreeMap Positron，暗色使用官方 Dark 樣式。",
      en: "Light mode uses OpenFreeMap Positron; dark mode uses the official Dark style.",
    },
    "info.namesTitle": { zh: "站名羅馬字", en: "Station romanization" },
    "info.namesBody": {
      zh: "OpenStreetMap contributors，依 ODbL 授權。",
      en: "OpenStreetMap contributors, licensed under ODbL.",
    },
    "info.packageTitle": { zh: "鐵路資料包", en: "Rail package" },
    "info.packageBody": {
      zh: "使用 railprint 的 jp-2025 日本鐵路資料包。",
      en: "Uses railprint's jp-2025 Japan rail package.",
    },

    // map corner control
    "map.layers": { zh: "地圖圖層", en: "Map Layers" },
    "map.basemap": { zh: "底圖", en: "Basemap" },
    "map.positron": { zh: "OpenFreeMap（線上）", en: "OpenFreeMap (online)" },
    "map.noBasemap": { zh: "無底圖", en: "No Basemap" },
    "map.routes": { zh: "列車路線", en: "Train Routes" },
    "map.stops": { zh: "中途停靠站", en: "Intermediate Stops" },
    "map.terminals": { zh: "端點站（起點／終點）", en: "Terminals (Origin / Destination)" },
    "map.passThrough": { zh: "通過站", en: "Pass-through Stations" },
    "map.allRailways": { zh: "全部鐵路線", en: "All Railway Lines" },
    "map.riddenGroup": { zh: "已乘路線顯示", en: "Ridden Lines" },
    "map.riddenJr": { zh: "JR在來線", en: "JR Conventional" },
    "map.riddenPriv": { zh: "私鐵・其他", en: "Private / Other" },
    "map.unavailable": { zh: "不可用", en: "unavailable" },
    "map.connecting": { zh: "連線中…", en: "connecting…" },
    "map.retryFailed": { zh: "重試失敗", en: "retry failed" },

    // map tooltips / labels
    "tag.arr": { zh: "到", en: "Arr" },
    "tag.dep": { zh: "發", en: "Dep" },
    "tag.start": { zh: "起點", en: "Start" },
    "tag.end": { zh: "終點", en: "End" },
    "tip.overlap": {
      zh: "並行 {slot}/{count}（依日期排序）・橫移切換",
      en: "Parallel {slot}/{count} (date order) · slide to switch",
    },
    "tip.passRideFollows": {
      zh: "通過站會跟隨其所在停靠區間顯示或隱藏，無法單獨切換。",
      en: "Pass-through stations follow their stop interval and cannot be toggled individually.",
    },

    // import source labels
    "src.serverStore": { zh: "伺服器保存的 train-store.json", en: "server-saved train-store.json" },
    "src.builtinDefault": { zh: "內建預設 JSON", en: "built-in default JSON" },
    "src.serverCleared": { zh: "伺服器已清除（內建預設）", en: "server cleared (built-in defaults)" },
    "src.agentImport": { zh: "AI 代理導入", en: "AI agent import" },
    "src.otherUpdate": { zh: "其他來源更新", en: "update from another source" },
    "src.pendingRecovery": {
      zh: "瀏覽器中尚未送達伺服器的恢復副本",
      en: "unsent browser recovery copy",
    },
    "src.localJson": { zh: "本地 JSON：{name}", en: "local JSON: {name}" },
    "src.emptyStore": { zh: "空白資料", en: "empty store" },

    // status messages
    "status.loadFailed": { zh: "資料載入失敗：{msg}", en: "Data load failed: {msg}" },
    "status.countrySwitched": {
      zh: "已切換至{name}資料。",
      en: "Switched to {name} data.",
    },
    "status.countrySwitchFailed": {
      zh: "切換國家失敗：{msg}",
      en: "Country switch failed: {msg}",
    },
    "status.noSavedStore": {
      zh: "尚未有保存的 train-store.json，已載入內建預設資料。編輯後會自動保存到伺服器。",
      en: "No saved train-store.json yet; loaded built-in defaults. Edits auto-save to the server.",
    },
    "status.recoveryEntered": {
      zh: "已保存資料載入失敗：{msg}。已切換到唯讀恢復模式：自動保存停用，原始 JSON 已放入「JSON 匯出」框；可修正後重新匯入，或用「重置示例／清除保存資料」重新開始。",
      en: "Saved data failed to load: {msg}. Read-only recovery mode: autosave is off and the raw JSON is in the Export box — fix and re-import it, or use Reset Sample / Clear Saved Data to start over.",
    },
    "status.recoveryNoSave": {
      zh: "唯讀恢復模式：自動保存已停用（原保存資料載入失敗）。",
      en: "Read-only recovery mode: autosave is disabled (the saved store failed to load).",
    },
    "status.serverClearedFallback": {
      zh: "伺服器端的資料已被清除，已回退到內建預設。",
      en: "Server data was cleared; fell back to built-in defaults.",
    },
    "status.autoLoaded": {
      zh: "已自動載入{label}：共 {count} 趟列車。",
      en: "Auto-loaded {label}: {count} train(s).",
    },
    "status.autosaveOk": {
      zh: "已自動保存到伺服器。",
      en: "Auto-saved to the server.",
    },
    "status.importBusy": {
      zh: "資料載入中，請稍候再編輯。",
      en: "Loading data — please wait before editing.",
    },
    "status.autosaveFail": {
      zh: "自動保存到伺服器失敗：{msg}",
      en: "Auto-save to server failed: {msg}",
    },
    "err.pendingServerInvalid": {
      zh: "瀏覽器中的未送達恢復副本無效：{msg}",
      en: "The unsent browser recovery copy is invalid: {msg}",
    },
    "err.pendingServerConflict": {
      zh: "瀏覽器中有未送達的編輯，但伺服器資料之後已被其他來源更改。為避免覆蓋，未自動重送；請從匯出框保存或合併此恢復副本。",
      en: "This browser has an unsent edit, but another source changed the server afterward. It was not replayed; save or merge the recovery copy from the Export box.",
    },
    "err.pendingServerReplayFailed": {
      zh: "無法重送瀏覽器中的未送達編輯：{msg}",
      en: "Could not replay the browser’s unsent edit: {msg}",
    },
    "status.noFsApi": {
      zh: "此瀏覽器不支援直接寫入本地檔案，已改為下載 JSON。",
      en: "This browser can't write local files directly; downloaded the JSON instead.",
    },
    "err.noWritePerm": {
      zh: "沒有本地 JSON 的寫入權限。",
      en: "No write permission for the local JSON file.",
    },
    "prog.prepare": {
      zh: "準備逐條載入 {label}：0/{total}",
      en: "Preparing to load {label} item by item: 0/{total}",
    },
    "prog.loading": {
      zh: "正在逐條載入 {label}：{count}/{total}：{id}",
      en: "Loading {label} item by item: {count}/{total}: {id}",
    },
    "prog.loadingShort": {
      zh: "正在逐條載入 {count}/{total}：{id}",
      en: "Loading item by item: {count}/{total}: {id}",
    },
    "prog.done": { zh: "完成：{count} 趟列車", en: "Done: {count} train(s)" },
    "prog.openingLocal": { zh: "正在打開本地 JSON…", en: "Opening local JSON…" },
    "prog.preparingId": { zh: "準備載入", en: "preparing" },
    "status.loadedAll": {
      zh: "已逐條載入 {label}，共 {total} 趟列車。",
      en: "Loaded {label} item by item: {total} train(s).",
    },
    "status.restoredAll": {
      zh: "已從 {label} 逐條恢復 {total} 趟列車。",
      en: "Restored {total} train(s) from {label} item by item.",
    },
    "status.savedTo": { zh: "已保存到 {name}。", en: "Saved to {name}." },
    "status.imported": {
      zh: "已匯入 {count} 趟列車：{ids}",
      en: "Imported {count} train(s): {ids}",
    },
    "status.exported": {
      zh: "已將目前列車資料匯出到文字框。",
      en: "Current train store exported to textarea.",
    },
    "status.resetDefaults": { zh: "已重置為內建示例資料。", en: "Reset to embedded defaults." },
    "status.clearedAll": {
      zh: "已清除保存的資料與本地檔案授權。下次開啟時會重新載入示例／預設資料。",
      en: "Cleared the saved data and local file authorization. Sample/default data will load on the next visit.",
    },
    "status.clearFail": { zh: "清除保存資料失敗：{msg}", en: "Failed to clear saved data: {msg}" },
    "confirm.deleteTrain": { zh: "確定刪除選取的列車？", en: "Delete selected train?" },
    "confirm.deleteTrainDetail": {
      zh: "確定刪除 {date} 的「{number}」（{stops} 個停站）？此操作無法復原。",
      en: "Delete “{number}” on {date} ({stops} stops)? This cannot be undone.",
    },
    "status.shared": {
      zh: "已透過系統分享匯出",
      en: "Exported via the system share sheet",
    },
    "confirm.deleteAll": { zh: "確定刪除所有列車？", en: "Delete all trains?" },
    "choose.overlap": {
      zh: "此處有多條重疊路線，請選擇列車：",
      en: "Several routes overlap here — choose a train:",
    },
    "chip.sample": { zh: "示例資料", en: "Sample data" },
    "sec.importPaste": { zh: "貼上 JSON 文字", en: "Paste JSON text" },
    "sec.rawPreview": { zh: "原始 JSON 預覽", en: "Raw JSON preview" },
    "disp.advanced": { zh: "進階顯示參數", en: "Advanced display parameters" },
    "status.allDeleted": { zh: "已刪除所有列車。", en: "All trains deleted." },
    "status.fieldsSaved": { zh: "已套用欄位。", en: "Fields saved." },

    // route solve status (編輯 panel field-status line)
    "status.routeGenerating": {
      zh: "正在為 {train} 生成 N02 鐵路路線…",
      en: "Generating N02 railway route for {train}...",
    },
    "status.routeGenerated": {
      zh: "已為 {train} 生成 {count} 段 N02 路線。",
      en: "Generated {count} N02 route segment(s) for {train}.",
    },
    "status.routeGeneratedSkipped": {
      zh: "已為 {train} 生成 {count} 段 N02 路線；{skipped} 段無法生成，已略過。",
      en: "Generated {count} N02 route segment(s) for {train}; {skipped} segment(s) skipped.",
    },
    "status.routeGenerateFailed": {
      zh: "無法為 {train} 生成 N02 鐵路路線：{failed} 段失敗。",
      en: "Unable to generate N02 railway route for {train}. {failed} segment(s) failed.",
    },
    "status.routeNoPath": {
      zh: "無法從內建 N02 資料生成鐵路路徑，請檢查車站代碼或 route_policy 設定；不會以直線代替。",
      en: "No N02 railway path could be generated from embedded N02 data. Check station codes / route_policy. No fake straight line was drawn.",
    },
    "status.routeSectionsRebuilt": {
      zh: "已依停站重建路線：共 {count} 段。乘車區間以外的停站與區段將完全隱藏。",
      en: "Route sections rebuilt. {count} segment(s) calculated. Stops/segments outside the ridden range are hidden entirely.",
    },

    // dates / list
    "date.all": { zh: "全部", en: "All" },
    "date.undated": { zh: "未分配日期", en: "Undated" },
    "list.allTitle": { zh: "全部列車（{count}）", en: "All Trains ({count})" },
    "list.dateTitle": { zh: "{date} 列車", en: "{date} Trains" },
    "empty.allSearch": { zh: "沒有符合搜尋的列車。", en: "No trains match your search." },
    "empty.allNone": { zh: "尚無任何列車，請匯入 JSON。", en: "No trains yet — import JSON." },
    "empty.dateSearch": {
      zh: "此日期沒有符合搜尋的列車。",
      en: "No trains on this date match your search.",
    },
    "empty.dateNone": {
      zh: "當前日期沒有列車，請匯入 JSON 到當前日期。",
      en: "No trains on this date — import JSON to this date.",
    },
    "unit.stops": { zh: "個停站", en: "stops" },
    "state.shown": { zh: "顯示中", en: "shown" },
    "state.hidden": { zh: "已隱藏", en: "hidden" },

    // import target hint (HTML)
    "import.targetDate": {
      zh: "當前匯入目標：<strong>{date}</strong>（沒有 date 的列車會加入此日期）",
      en: "Import target: <strong>{date}</strong> (trains without a date are added to this date)",
    },
    "import.targetAuto": {
      zh: "當前匯入目標：<strong>JSON 內 date 欄位／自動從 id 識別</strong>（選一個日期可改為匯入到該日期）",
      en: "Import target: <strong>date field in JSON / auto-detected from id</strong> (pick a date to import into it instead)",
    },

    // add-date prompt
    "prompt.addDate": { zh: "輸入新增日期（YYYY-MM-DD）：", en: "Enter a new date (YYYY-MM-DD):" },
    // dialog (app-modal.js) buttons
    "modal.ok": { zh: "確定", en: "OK" },
    "modal.cancel": { zh: "取消", en: "Cancel" },
    "status.invalidDate": {
      zh: "無效的日期格式：「{input}」。請使用 YYYY-MM-DD。",
      en: 'Invalid date format: "{input}". Use YYYY-MM-DD.',
    },
    "status.dateAdded": {
      zh: "已新增日期 {date}，並切換為當前匯入目標。",
      en: "Added date {date} and switched the import target to it.",
    },
    "status.emptyDatesRemoved": {
      zh: "已刪除 {count} 個空日期。",
      en: "Removed {count} empty date(s).",
    },
    "status.noEmptyDates": { zh: "沒有可刪除的空日期。", en: "No empty dates to remove." },

    // ride-segment tooltip
    "tip.rideSegment": {
      zh: "此站是否按實際乘坐區間正常顯示；關閉時站點和相鄰區間淡色顯示",
      en: "Whether this stop shows normally as part of the actual ridden segment; off dims the stop and adjacent segments",
    },

    // stop types
    "stoptype.origin": { zh: "起站", en: "Origin" },
    "stoptype.passenger_stop": { zh: "停靠站", en: "Passenger stop" },
    "stoptype.pass_through": { zh: "通過站", en: "Pass-through" },
    "stoptype.operational_stop": { zh: "運轉停車", en: "Operational stop" },
    "stoptype.destination": { zh: "終站", en: "Destination" },

    // stop-marker click popup (buildStopPopup). N02_005c / N02_005g stay
    // literal: they are N02 field codes, not translatable labels.
    "popup.trainId": { zh: "列車 ID", en: "Train ID" },
    "popup.typeCompany": { zh: "類型／公司", en: "Type / Company" },
    "popup.station": { zh: "車站", en: "Station" },
    "popup.arrival": { zh: "到達", en: "Arrival" },
    "popup.departure": { zh: "出發", en: "Departure" },
    "popup.stopType": { zh: "停站類型", en: "Stop type" },
    "popup.rideSegment": { zh: "乘坐區間", en: "Ridden segment" },
    "popup.line": { zh: "路線", en: "Line" },
    "popup.operator": { zh: "營運公司", en: "Operator" },
    "popup.computed": { zh: "自動推定", en: "Computed" },
    "popup.routeSource": { zh: "路線來源", en: "Route source" },
    "popup.yes": { zh: "是", en: "Yes" },
    "popup.no": { zh: "否", en: "No" },
    "popup.noPale": { zh: "否（淡色顯示）", en: "No / pale" },
  };

  // Complete Japanese UI copy. Keeping this as a locale overlay avoids
  // duplicating the large romanization/kana dictionaries below.
  const JA_STRINGS = {
    "lang.label": "言語",
    "app.title": "N02 特急列車管理",
    "app.hint": "地図上で行程を確認し、列車・停車駅・JSON データを管理します。",
    "nav.label": "ワークスペースナビゲーション",
    "nav.trains": "列車",
    "nav.editor": "編集",
    "nav.data": "データ",
    "nav.display": "表示",
    "nav.about": "情報",
    "menu.hide": "メニューを隠す",
    "menu.show": "メニューを表示",
    "sec.search": "検索と操作",
    "ph.search": "列車番号・列車名・駅名・ID で検索",
    "btn.addTrain": "列車を追加",
    "btn.duplicate": "複製",
    "btn.delete": "削除",
    "btn.deleteAll": "すべて削除",
    "btn.fit": "位置を表示",
    "btn.clearSel": "選択を解除",
    "btn.autoFocus": "自動フォーカス：",
    "state.on": "オン",
    "state.off": "オフ",
    "country.label": "国",
    "country.jp": "日本",
    "country.tw": "台湾",
    "disp.reset": "初期設定に戻す",
    "theme.label": "テーマ",
    "theme.system": "システム",
    "theme.light": "ライト",
    "theme.dark": "ダーク",
    "uiMode.label": "UI モード",
    "uiMode.auto": "自動判定",
    "uiMode.mobile": "モバイル",
    "uiMode.desktop": "デスクトップ",
    "uiMode.status": "検出：{device}・現在：{mode}",
    "uiMode.device.phone": "スマートフォン",
    "uiMode.device.tablet": "タブレット",
    "uiMode.device.computer": "コンピュータ",
    "disp.hint": "フィッティング設定はスライダー変更後に「フィッティング曲線を再構築」を押すと適用されます。ディテール尺度を大きくすると密集した折れを直線または滑らかな弧にできます。シアンはヒット領域、オレンジは一時保持範囲、マゼンタは区間切替範囲です。",
    "disp.routeWidthScale": "路線の太さ",
    "disp.riddenOpacity": "乗車区間の透明度",
    "disp.dimOpacity": "選択日以外の淡色表示",
    "disp.terminalRadius": "端点（始発／終着駅）のサイズ",
    "disp.stopRadius": "停車駅の中心黒点サイズ",
    "disp.passRadius": "途中停車／通過駅の外円サイズ",
    "disp.markerStrokeScale": "マーカー枠線の太さ",
    "disp.focusBoost": "選択時の拡大量",
    "disp.mapOpacity": "背景地図の透明度",
    "disp.fitCurvePrecision": "フィッティング曲線のサンプリング精度",
    "disp.fitCurveMinRadius": "最小曲線半径",
    "disp.fitCurveMinDetail": "最小ディテール尺度",
    "disp.fitCurveMaxDeviation": "元線からの最大許容偏差",
    "disp.fullCrossDay": "日をまたぐ行程を全区間実線で表示",
    "disp.fitCurves": "フィッティング曲線を表示（デバッグ）",
    "disp.nameReadingKana": "駅名のかな読みを表示",
    "disp.nameReadingRomaji": "駅名のローマ字を表示",
    "disp.nameReadingZh": "駅名の中国語表記を表示",
    "disp.rebuildFitCurves": "フィッティング曲線を再構築",
    "disp.fitCurveOverlapNote":
      "フィッティング曲線は重複区間（複数列車が共有する線路）のみが対象です。重複のない路線には生成されません。",
    "disp.fitCurvePendingHint":
      "パラメータは変更されましたが未適用です。「フィッティング曲線を再構築」を押すと反映されます。",
    "disp.hoverRegions": "Hover 監視範囲を表示（デバッグ）",
    "sec.import": "JSON 読み込み／ローカルデータ",
    "ph.importJson": "完全な store、列車配列、または単一の列車オブジェクトを貼り付け",
    "btn.openLocal": "ローカル JSON を開く",
    "btn.saveLocal": "JSON を保存／別名保存",
    "btn.validate": "読み込み JSON を検証",
    "btn.apply": "読み込み／順次インポートを開始",
    "sec.dataSource": "データソース",
    "hint.dataSource":
      "サンプルデータは閲覧専用で、変更は保存されません。自分のデータはこのブラウザに保存され、編集すると自動保存されます。",
    "btn.loadSampleAll": "サンプルデータを全て読み込む",
    "btn.loadNewYearGrandLoop": "年越し大回り行程を読み込む",
    "btn.loadTokyoLimitedExpressLoop": "東京特急大回り行程を読み込む",
    "btn.restoreMine": "自分のデータを復元",
    "btn.saveAsMine": "自分のデータとして保存",
    "mode.user": "表示中：自分のデータ（このブラウザに自動保存）",
    "mode.sampleSingle": "表示中：サンプルデータ {date}（変更は保存されません）",
    "mode.sampleAll": "表示中：サンプルデータ全件（変更は保存されません）",
    "mode.newYearGrandLoop": "表示中：年越し大回り行程（変更は保存されません）",
    "mode.tokyoLimitedExpressLoop":
      "表示中：東京特急大回り行程（変更は保存されません）",
    "confirm.loadSampleAll":
      "サンプルデータを全て読み込みますか？画面の内容はサンプルに置き換わります（保存済みデータは影響を受けず、いつでも復元できます）。",
    "confirm.loadNewYearGrandLoop":
      "年越し大回り行程を読み込みますか？画面の内容はこの独立した行程に置き換わります（保存済みデータには影響しません）。",
    "confirm.loadTokyoLimitedExpressLoop":
      "東京特急大回り行程を読み込みますか？画面の内容はこの独立した行程に置き換わります（保存済みデータには影響しません）。",
    "confirm.restoreMine":
      "自分のデータを復元しますか？表示中のサンプル（未保存の変更を含む）は破棄されます。",
    "confirm.saveAsMine":
      "画面の内容を自分のデータとして保存しますか？以後の編集はこのブラウザに自動保存されます。",
    "confirm.overwriteMine":
      "注意：保存済みのデータがあります。現在の内容を保存すると上書きされ、元に戻せません。続行しますか？",
    "confirm.clearStorage":
      "このブラウザに保存されたデータを消去しますか？この操作は元に戻せません。",
    "confirm.importInSample":
      "現在サンプルデータを表示中です。「OK」：サンプルを消去し、読み込んだ JSON のみを自分のデータとして保存します。「キャンセル」：JSON をサンプルに一時的に重ねます（保存されません）。",
    "status.sampleSingleLoaded":
      "サンプルデータ {date}（{count} 本）を読み込みました。サンプルは閲覧専用で保存されません。「サンプルデータを全て読み込む」で全日付を表示できます。",
    "status.sampleAllLoaded":
      "サンプルデータ全件（{count} 本）を読み込みました。閲覧専用のため変更は保存されません。",
    "status.newYearGrandLoopLoaded":
      "年越し大回り行程（{count} 本）を読み込みました。通常のサンプルとは別の閲覧専用データです。",
    "status.tokyoLimitedExpressLoopLoaded":
      "東京特急大回り行程（{count} 本）を読み込みました。他のサンプルとは別の閲覧専用データです。",
    "status.savedAsMine":
      "自分のデータとして保存しました（{count} 本）。以後の編集はこのブラウザに自動保存されます。",
    "status.noUserStore": "このブラウザに保存済みのデータはありません。",
    "status.sampleNoSave":
      "サンプルモード：変更は保存されません。内容を残すには「データ」タブの「自分のデータとして保存」を押してください。",
    "status.autosaveLocalOk": "このブラウザに自動保存しました。",
    "status.autosaveConflict":
      "未保存：別のタブが {date} のデータを変更しました。新しい保存データを上書きしないよう、このタブの JSON をエクスポートしてから再読み込みしてください。",
    "src.userStore": "自分のデータ（このブラウザ保存）",
    "src.sampleDay": "サンプルデータ {date}",
    "src.sampleAll": "サンプルデータ全件",
    "src.newYearGrandLoop": "年越し大回り行程",
    "src.tokyoLimitedExpressLoop": "東京特急大回り行程",
    "err.noSampleData": "サンプルデータを読み込めません。しばらくしてからもう一度お試しください。",
    "err.noNewYearGrandLoopData":
      "年越し大回り行程を読み込めません。しばらくしてからもう一度お試しください。",
    "err.noTokyoLimitedExpressLoopData":
      "東京特急大回り行程を読み込めません。しばらくしてからもう一度お試しください。",
    "grp.edit": "選択中の列車を編集",
    "grp.dates": "日付と絞り込み",
    "grp.trainResults": "この日の列車",
    "grp.listActions": "列車操作",
    "grp.data": "データ管理",
    "grp.danger": "危険な操作",
    "hint.danger": "これらの操作はすべてのデータに影響し、元に戻せません。慎重に操作してください。",
    "nav.stats": "統計",
    "sec.stats": "走行距離統計",
    "stats.dailyTitle": "当日の統計（{date}）",
    "stats.overallTitle": "全期間の統計",
    "stats.coverageTitle": "路線網カバー率",
    "stats.actualTitle": "実乗車量",
    "stats.byLine": "路線別",
    "stats.byCount": "回数順",
    "stats.topSegmentsTitle": "最も乗車した区間",
    "stats.topSegmentsHint":
      "隣接する駅と駅の間の区間で集計します。往復は同じ区間として扱い、回数は乗車した列車の本数です。",
    "stat.time": "乗車時間",
    "stat.ltdexp": "有料特急",
    "stat.othertrains": "その他の列車",
    "stat.trains": "{n} 本",
    "fmt.duration": "{h}時間{m}分",
    "fmt.durationM": "{m}分",
    "stat.all": "全国",
    "stat.hsr": "新幹線",
    "stat.conv": "普通鉄道（在来線）",
    "stat.jr": "JR（新幹線を含む）",
    "stat.metro": "地下鉄",
    "stat.priv": "私鉄・第三セクター",
    "stat.tram": "路面電車",
    "stat.allrail": "全鉄道",
    "stat.jrconv": "JR在来線",
    "stat.rides": "{n} 回",
    "stats.loading": "鉄道路線データを読み込み中…",
    "stats.empty": "乗車記録がありません。",
    "stats.hint": "全列車で実際に乗車した区間を重複を除いて集計します。総延長は国土数値情報 N02-25 の全国鉄道網に基づきます。",
    "sec.list": "列車一覧",
    "btn.addDate": "日付を追加",
    "btn.removeEmpty": "空の日付を削除",
    "chk.mapDateFilter": "地図には選択日のみ表示",
    "sec.trainData": "列車データ",
    "field.id": "列車 ID",
    "field.number": "列車番号",
    "field.trainType": "列車種別",
    "ph.trainType": "特急／普通／新幹線",
    "field.company": "運行会社",
    "ph.company": "JR西日本。直通運転は複数社を / で区切る",
    "tag.through": "直通",
    "field.direction": "方向",
    "ph.direction": "下り／上り",
    "field.origin": "始発駅",
    "field.destination": "終着駅",
    "field.color": "色",
    "field.weight": "線幅",
    "btn.saveFields": "項目を適用",
    "btn.toggleVisible": "表示／非表示",
    "btn.moveUp": "上へ",
    "btn.moveDown": "下へ",
    "sec.stops": "停車駅と通過駅",
    "th.seq": "順",
    "th.station": "駅",
    "th.arr": "着",
    "th.dep": "発",
    "th.type": "種別",
    "th.ride": "乗車",
    "th.actions": "操作",
    "btn.addStop": "停車駅を追加",
    "btn.rebuildRoute": "停車駅から経路を再構築",
    "table.stopsLabel": "停車駅一覧表",
    "branch.tag": "支線",
    "branch.junction": "分岐駅",
    "branch.rideAll": "支線全体を乗車／非表示",
    "branch.noline": "（路線未指定）",
    "sec.export": "JSON 書き出し",
    "btn.exportJson": "JSON を書き出す",
    "btn.downloadJson": "JSON をダウンロード",
    "btn.resetDefaults": "サンプルを初期化",
    "btn.downloadHtml": "現在の HTML をダウンロード",
    "btn.clearStorage": "保存データを消去",
    "sec.legend": "凡例とデータ出典",
    "legend.railway": "全路線（初期状態はオフ）：路線ごとの公式色（淡色）＋灰色の駅マーカー",
    "legend.station": "途中停車駅：黒い中心点付きの中空円、通過駅：同じ大きさの中空円、始終点：大きな墨色の点",
    "legend.express": "列車経路：指定色の太線（選択中は墨色の下線）",
    "legend.source1": "鉄道路線データ：国土交通省『国土数値情報（鉄道データ N02）』を加工して作成（CC BY 4.0）。",
    "legend.source2": "背景地図 © OpenStreetMap contributors｜OpenFreeMap。ローマ字表記 © OpenStreetMap contributors, ODbL。鉄道データパッケージ © railprint (jp-2025)。",
    "info.button": "凡例とデータ出典を開く",
    "info.title": "凡例とデータ出典",
    "info.intro": "地図記号、使用データ、ライセンスをまとめて確認できます。",
    "info.legendHeading": "地図の凡例",
    "info.routeTitle": "列車経路",
    "info.routeDesc": "列車ごとの指定色で表示し、選択中は墨色の下線を加えます。",
    "info.stopTitle": "途中停車駅",
    "info.stopDesc": "通過駅と同じ大きさの中空円に、黒い中心点を加えます。",
    "info.passTitle": "通過駅",
    "info.passDesc": "途中停車駅と同じ外円サイズで、中心は白抜きのままです。",
    "info.terminalTitle": "始点と終点",
    "info.terminalDesc": "大きな墨色の点と白い外周で、行程の端点を強調します。",
    "info.networkTitle": "全鉄道路線",
    "info.networkDesc": "地図レイヤーから有効にすると、公式路線色と灰色の駅マーカーを表示します。",
    "info.sourcesHeading": "データとライセンス",
    "info.n02Title": "日本の鉄道網",
    "info.n02Body": "国土交通省『国土数値情報（鉄道データ N02）』を加工して作成しています。",
    "info.basemapTitle": "背景地図",
    "info.basemapBody": "ライトモードは OpenFreeMap Positron、ダークモードは公式 Dark スタイルを使用します。",
    "info.namesTitle": "駅名のローマ字表記",
    "info.namesBody": "OpenStreetMap contributors、ODbL ライセンス。",
    "info.packageTitle": "鉄道データパッケージ",
    "info.packageBody": "railprint の日本鉄道データパッケージ jp-2025 を使用しています。",
    "map.layers": "地図レイヤー",
    "map.basemap": "背景地図",
    "map.positron": "OpenFreeMap（オンライン）",
    "map.noBasemap": "背景地図なし",
    "map.routes": "列車経路",
    "map.stops": "途中停車駅",
    "map.terminals": "端点駅（始発／終着）",
    "map.passThrough": "通過駅",
    "map.allRailways": "全鉄道路線",
    "map.riddenGroup": "乗車済み路線の表示",
    "map.riddenJr": "JR在来線",
    "map.riddenPriv": "私鉄・その他",
    "map.unavailable": "利用不可",
    "map.connecting": "接続中…",
    "map.retryFailed": "再試行に失敗",
    "tag.arr": "着",
    "tag.dep": "発",
    "tag.start": "始点",
    "tag.end": "終点",
    "tip.overlap": "並行 {slot}/{count}（日付順）・横移動で切り替え",
    "tip.passRideFollows": "通過駅は所属する停車区間の表示状態に従うため、個別には切り替えられません。",
    "src.serverStore": "サーバー保存済み train-store.json",
    "src.builtinDefault": "内蔵の初期 JSON",
    "src.serverCleared": "サーバー消去済み（内蔵初期データ）",
    "src.agentImport": "AI エージェントからの読み込み",
    "src.otherUpdate": "別のソースからの更新",
    "src.pendingRecovery": "ブラウザー内の未送信リカバリーコピー",
    "src.localJson": "ローカル JSON：{name}",
    "src.emptyStore": "空のデータ",
    "status.loadFailed": "データの読み込みに失敗しました：{msg}",
    "status.countrySwitched": "{name}のデータに切り替えました。",
    "status.countrySwitchFailed": "国の切り替えに失敗しました：{msg}",
    "status.noSavedStore": "保存済みの train-store.json がないため、内蔵初期データを読み込みました。編集内容はサーバーへ自動保存されます。",
    "status.recoveryEntered": "保存データの読み込みに失敗しました：{msg}。読み取り専用の復旧モードに切り替えました：自動保存は無効化され、元の JSON は「JSON エクスポート」欄にあります。修正して再読み込みするか、「サンプルへリセット／保存データを消去」でやり直してください。",
    "status.recoveryNoSave": "読み取り専用の復旧モード：自動保存は無効です（保存データの読み込みに失敗）。",
    "status.serverClearedFallback": "サーバー上のデータが消去されたため、内蔵初期データに戻しました。",
    "status.autoLoaded": "{label} を自動読み込みしました：{count} 本。",
    "status.autosaveOk": "サーバーに自動保存しました。",
    "status.autosaveFail": "サーバーへの自動保存に失敗しました：{msg}",
    "err.pendingServerInvalid":
      "ブラウザー内の未送信リカバリーコピーが無効です：{msg}",
    "err.pendingServerConflict":
      "未送信の編集がありますが、その後サーバーが別のソースから更新されました。上書きを避けるため自動再送していません。エクスポート欄からリカバリーコピーを保存または統合してください。",
    "err.pendingServerReplayFailed":
      "ブラウザー内の未送信編集を再送できませんでした：{msg}",
    "status.noFsApi": "このブラウザーはローカルファイルへの直接書き込みに対応していないため、JSON をダウンロードしました。",
    "err.noWritePerm": "ローカル JSON ファイルへの書き込み権限がありません。",
    "prog.prepare": "{label} の順次読み込みを準備中：0/{total}",
    "prog.loading": "{label} を順次読み込み中：{count}/{total}：{id}",
    "prog.loadingShort": "順次読み込み中：{count}/{total}：{id}",
    "prog.done": "完了：{count} 本",
    "prog.openingLocal": "ローカル JSON を開いています…",
    "prog.preparingId": "準備中",
    "status.loadedAll": "{label} から {total} 本を順次読み込みました。",
    "status.restoredAll": "{label} から {total} 本を順次復元しました。",
    "status.savedTo": "{name} に保存しました。",
    "status.imported": "{count} 本をインポートしました：{ids}",
    "status.importBusy": "データ読み込み中です。完了までお待ちください。",
    "status.exported": "現在の列車データをテキスト欄へ書き出しました。",
    "status.resetDefaults": "内蔵サンプルデータに戻しました。",
    "status.clearedAll": "保存済みデータとローカルファイル権限を消去しました。次回はサンプル／初期データを読み込みます。",
    "status.clearFail": "保存データの消去に失敗しました：{msg}",
    "confirm.deleteTrain": "選択中の列車を削除しますか？",
    "confirm.deleteTrainDetail":
      "{date} の「{number}」（停車駅 {stops}）を削除しますか？この操作は元に戻せません。",
    "status.shared": "共有シートからエクスポートしました",
    "confirm.deleteAll": "すべての列車を削除しますか？",
    "choose.overlap": "この地点では複数の路線が重なっています。列車を選択してください：",
    "chip.sample": "サンプルデータ",
    "sec.importPaste": "JSONテキストを貼り付け",
    "sec.rawPreview": "JSONプレビュー",
    "disp.advanced": "詳細表示パラメータ",
    "status.allDeleted": "すべての列車を削除しました。",
    "status.fieldsSaved": "項目を適用しました。",
    "status.routeGenerating": "{train} の N02 鉄道経路を生成しています…",
    "status.routeGenerated": "{train} の N02 経路を {count} 区間生成しました。",
    "status.routeGeneratedSkipped":
      "{train} の N02 経路を {count} 区間生成しました（{skipped} 区間はスキップ）。",
    "status.routeGenerateFailed":
      "{train} の N02 経路を生成できませんでした（{failed} 区間失敗）。",
    "status.routeNoPath":
      "内蔵 N02 データから経路を生成できませんでした。駅コード／route_policy を確認してください。直線での代替描画は行いません。",
    "status.routeSectionsRebuilt":
      "停車駅から経路を再構築しました：{count} 区間。乗車区間外の駅／区間は非表示になります。",
    "date.all": "すべて",
    "date.undated": "日付未設定",
    "list.allTitle": "すべての列車（{count}）",
    "list.dateTitle": "{date} の列車",
    "empty.allSearch": "検索条件に一致する列車はありません。",
    "empty.allNone": "列車がありません。JSON を読み込んでください。",
    "empty.dateSearch": "この日には検索条件に一致する列車がありません。",
    "empty.dateNone": "この日には列車がありません。この日付へ JSON を読み込んでください。",
    "unit.stops": "駅",
    "state.shown": "表示中",
    "state.hidden": "非表示",
    "import.targetDate": "現在の読み込み先：<strong>{date}</strong>（date のない列車はこの日に追加）",
    "import.targetAuto": "現在の読み込み先：<strong>JSON の date 項目／ID から自動判定</strong>（日付を選ぶと読み込み先を変更できます）",
    "prompt.addDate": "追加する日付を入力してください（YYYY-MM-DD）：",
    "modal.ok": "OK",
    "modal.cancel": "キャンセル",
    "status.invalidDate": "日付形式が正しくありません：『{input}』。YYYY-MM-DD を使用してください。",
    "status.dateAdded": "{date} を追加し、現在の読み込み先に設定しました。",
    "status.emptyDatesRemoved": "空の日付を {count} 件削除しました。",
    "status.noEmptyDates": "削除できる空の日付はありません。",
    "tip.rideSegment": "実際の乗車区間として通常表示するかを設定します。オフにすると駅と隣接区間を淡色表示します",
    "stoptype.origin": "始発駅",
    "stoptype.passenger_stop": "停車駅",
    "stoptype.pass_through": "通過駅",
    "stoptype.operational_stop": "運転停車",
    "stoptype.destination": "終着駅",
    "popup.trainId": "列車ID",
    "popup.typeCompany": "種別・会社",
    "popup.station": "駅",
    "popup.arrival": "到着",
    "popup.departure": "出発",
    "popup.stopType": "停車種別",
    "popup.rideSegment": "乗車区間",
    "popup.line": "路線",
    "popup.operator": "事業者",
    "popup.computed": "自動推定",
    "popup.routeSource": "経路ソース",
    "popup.yes": "はい",
    "popup.no": "いいえ",
    "popup.noPale": "いいえ（淡色表示）",
  };

  window.I18NStrings = { STRINGS, JA_STRINGS };
})();
