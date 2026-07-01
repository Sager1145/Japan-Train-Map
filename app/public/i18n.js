// ---------------------------------------------------------------------------
// Lightweight i18n layer for the N02 Limited Express Manager web UI.
//
// Loaded BEFORE app.js so `window.I18N` exists synchronously for every caller.
// Two languages: Traditional Chinese ("zh", the original/default) and English
// ("en"). The chosen language is remembered in localStorage.
//
//   I18N.t(key, params)   -> translated UI string ("{x}" placeholders filled)
//   I18N.placeName(jp)    -> in EN mode "東京 (Tōkyō)", in ZH mode just "東京"
//   I18N.trainName(jp)    -> same dictionary, for limited-express service names
//   I18N.setLang(lang)    -> switch language, persist, re-apply, notify
//   I18N.getLang()        -> "zh" | "en"
//   I18N.onChange(fn)     -> register a callback fired after each switch
//   I18N.applyStatic(root)-> translate [data-i18n*] attributes under root
//
// Japanese station / line names are PROPER NOUNS and are never rewritten in the
// data; placeName() only appends a romanized English gloss in English mode so
// both scripts are visible at once.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  const LANG_KEY = "n02-ui-lang";
  const SUPPORTED = ["zh", "en"];
  let currentLang = "zh";

  // ---- UI strings ---------------------------------------------------------
  // Every value is { zh, en }. Use "{name}" style placeholders for params.
  const STRINGS = {
    // language picker
    "lang.label": { zh: "語言", en: "Language" },

    // header
    "app.title": { zh: "N02 特急列車管理", en: "N02 Limited Express Manager" },
    "app.hint": {
      zh: "OSM Overlay／伺服器 train-store.json 自動保存載入／逐條匯入",
      en: "OSM overlay / server train-store.json auto-save & load / per-item import",
    },

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

    // display settings
    "disp.summary": {
      zh: "顯示調節（線寬／站點大小／透明度）",
      en: "Display Settings (line width / marker size / opacity)",
    },
    "disp.reset": { zh: "重置為預設", en: "Reset to Defaults" },
    "disp.hint": {
      zh: "調整全部列車的線路粗細、起終點／停靠站／通過站大小與透明度等。設定即時生效，並自動保存到此瀏覽器。",
      en: "Adjust line width, terminal / stop / pass-through marker sizes and opacity for all trains. Changes apply instantly and are saved to this browser.",
    },
    "disp.routeWidthScale": { zh: "線路粗細", en: "Line width" },
    "disp.riddenOpacity": { zh: "已乘區間透明度", en: "Ridden segment opacity" },
    "disp.unriddenOpacity": { zh: "未乘區間透明度", en: "Unridden segment opacity" },
    "disp.dimOpacity": { zh: "非當前日期淡化", en: "Off-date dimming" },
    "disp.terminalRadius": { zh: "端點（起／終站）大小", en: "Terminal (origin/dest) size" },
    "disp.stopRadius": { zh: "停靠站大小", en: "Stop marker size" },
    "disp.passRadius": { zh: "通過站大小", en: "Pass-through size" },
    "disp.markerStrokeScale": { zh: "標記邊框粗細", en: "Marker border width" },
    "disp.focusBoost": { zh: "選中放大量", en: "Selection zoom boost" },
    "disp.mapOpacity": { zh: "地圖底圖透明度", en: "Basemap opacity" },
    "disp.onlyEndpoints": {
      zh: "僅顯示首尾端點（隱藏中間停站）",
      en: "Show only first/last endpoints (hide intermediate stops)",
    },

    // JSON import / local data
    "sec.import": { zh: "JSON 匯入／本地資料", en: "JSON Import / Local Data" },
    "ph.importJson": {
      zh: '貼上完整 store：{"schema_version":"1.2","trains":[...]}，也可貼上列車陣列或單一列車物件',
      en: 'Paste a full store: {"schema_version":"1.2","trains":[...]}, or a train array or a single train object',
    },
    "btn.openLocal": { zh: "打開本地 JSON", en: "Open Local JSON" },
    "btn.saveLocal": { zh: "保存／另存 JSON", en: "Save / Save As JSON" },
    "btn.validate": { zh: "驗證匯入 JSON", en: "Validate Import JSON" },
    "btn.apply": { zh: "開始載入／逐條匯入", en: "Start Loading / Import Items" },

    // train list
    "sec.list": { zh: "列車清單", en: "Train List" },
    "btn.addDate": { zh: "新增日期", en: "Add Date" },
    "btn.removeEmpty": { zh: "刪除空日期", en: "Remove Empty Dates" },
    "chk.mapDateFilter": { zh: "地圖僅顯示當前日期", en: "Map shows current date only" },

    // train data form
    "sec.trainData": { zh: "列車資料", en: "Train Data" },
    "field.id": { zh: "列車 ID", en: "Train ID" },
    "field.number": { zh: "車次", en: "Train No." },
    "field.name": { zh: "列車名稱", en: "Train Name" },
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
      zh: "N02 全鐵路 overlay (N02_002=1/2/3/4/5)",
      en: "N02 full railway overlay (N02_002=1/2/3/4/5)",
    },
    "legend.station": {
      zh: "N02 全車站 overlay (N02_002=1/2/3/4/5)",
      en: "N02 full station overlay (N02_002=1/2/3/4/5)",
    },
    "legend.express": {
      zh: "特急路線、停靠與通過站 overlay",
      en: "Limited express routes, stops & pass-throughs overlay",
    },
    "legend.source1": {
      zh: "鐵路線資料：「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成。",
      en: 'Railway data: created from "National Land Numerical Information (Railway Data N02)" (Ministry of Land, Infrastructure, Transport and Tourism of Japan).',
    },
    "legend.source2": {
      zh: "Map data © OpenStreetMap contributors. N02 railway data © Ministry of Land, Infrastructure, Transport and Tourism of Japan, CC BY 4.0.",
      en: "Map data © OpenStreetMap contributors. N02 railway data © Ministry of Land, Infrastructure, Transport and Tourism of Japan, CC BY 4.0.",
    },

    // map tooltips / labels
    "tag.arr": { zh: "到", en: "Arr" },
    "tag.dep": { zh: "發", en: "Dep" },
    "field.carNo": { zh: "車號", en: "Train No." },

    // import source labels
    "src.serverStore": { zh: "伺服器保存的 train-store.json", en: "server-saved train-store.json" },
    "src.builtinDefault": { zh: "內建預設 JSON", en: "built-in default JSON" },
    "src.serverCleared": { zh: "伺服器已清除（內建預設）", en: "server cleared (built-in defaults)" },
    "src.agentImport": { zh: "AI 代理導入", en: "AI agent import" },
    "src.otherUpdate": { zh: "其他來源更新", en: "update from another source" },
    "src.localJson": { zh: "本地 JSON：{name}", en: "local JSON: {name}" },

    // status messages
    "status.loadFailed": { zh: "資料載入失敗：{msg}", en: "Data load failed: {msg}" },
    "status.noSavedStore": {
      zh: "尚未有保存的 train-store.json，已載入內建預設資料。編輯後會自動保存到伺服器。",
      en: "No saved train-store.json yet; loaded built-in defaults. Edits auto-save to the server.",
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
      zh: "已自動保存到伺服器 train-store.json。",
      en: "Auto-saved to server train-store.json.",
    },
    "status.autosaveFail": {
      zh: "自動保存到伺服器失敗：{msg}",
      en: "Auto-save to server failed: {msg}",
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
      zh: "已清除伺服器保存的 train-store.json 與本地檔案授權。重新載入時會使用內建預設資料。",
      en: "Cleared the server-saved train-store.json and local file authorization. Built-in defaults will be used on reload.",
    },
    "status.clearFail": { zh: "清除保存資料失敗：{msg}", en: "Failed to clear saved data: {msg}" },
    "confirm.deleteTrain": { zh: "確定刪除選取的列車？", en: "Delete selected train?" },
    "confirm.deleteAll": { zh: "確定刪除所有列車？", en: "Delete all trains?" },
    "status.allDeleted": { zh: "已刪除所有列車。", en: "All trains deleted." },
    "status.fieldsSaved": { zh: "已套用欄位。", en: "Fields saved." },

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
  };

  // ---- Japanese -> English (romaji / gloss) for stations & services -------
  const NAMES = {
    // stations
    "あつみ温泉": "Atsumi-Onsen", "いわき": "Iwaki", "さいたま新都心": "Saitama-Shintoshin",
    "たびら平戸口": "Tabira-Hiradoguchi", "トマム": "Tomamu", "ハウステンボス": "Huis Ten Bosch",
    "三島": "Mishima", "三本松": "Sanbonmatsu", "三股": "Mimata", "上諏訪": "Kami-Suwa",
    "上越妙高": "Jōetsu-Myōkō", "上野": "Ueno", "下部温泉": "Shimobe-Onsen", "与野": "Yono",
    "中佐世保": "Naka-Sasebo", "中名": "Nakamyō", "中条": "Nakajō", "中津": "Nakatsu",
    "丸亀": "Marugame", "久留米": "Kurume", "二ツ井": "Futatsui", "二日市": "Futsukaichi",
    "二月田": "Nigatsuden", "五位野": "Goino", "五稜郭": "Goryōkaku", "京都": "Kyōto",
    "仁賀保": "Nikaho", "仙台": "Sendai", "伊達紋別": "Date-Monbetsu", "佐々": "Saza",
    "佐世保": "Sasebo", "佐世保中央": "Sasebo-Chūō", "佐伯": "Saiki", "佐土原": "Sadowara",
    "佐賀": "Saga", "余目": "Amarume", "児島": "Kojima", "八戸": "Hachinohe", "八王子": "Hachiōji",
    "八郎潟": "Hachirōgata", "八雲": "Yakumo", "内船": "Utsubuna", "出水": "Izumi",
    "函館": "Hakodate", "別府": "Beppu", "前之浜": "Maenohama", "加茂": "Kamo",
    "加賀温泉": "Kaga-Onsen", "勝瑞": "Shōzui", "勝田": "Katsuta", "北佐世保": "Kita-Sasebo",
    "北浦和": "Kita-Urawa", "南千歳": "Minami-Chitose", "南宮崎": "Minami-Miyazaki",
    "南浦和": "Minami-Urawa", "南甲府": "Minami-Kōfu", "南稚内": "Minami-Wakkanai",
    "南鹿児島": "Minami-Kagoshima", "博多": "Hakata", "厚岸": "Akkeshi", "厚床": "Attoko",
    "原ノ町": "Haranomachi", "名古屋": "Nagoya", "名寄": "Nayoro", "和寒": "Wassamu",
    "品川": "Shinagawa", "善通寺": "Zentsūji", "喜入": "Kiire", "国分": "Kokubu",
    "土佐山田": "Tosa-Yamada", "土浦": "Tsuchiura", "坂之上": "Sakanoue", "坂出": "Sakaide",
    "坂町": "Sakamachi", "塩尻": "Shiojiri", "士別": "Shibetsu", "多度津": "Tadotsu",
    "大分": "Ōita", "大塔": "Daitō", "大宮": "Ōmiya", "大山": "Ōyama", "大曲": "Ōmagari",
    "大月": "Ōtsuki", "大杉": "Ōsugi", "大村": "Ōmura", "大歩危": "Ōboke", "大館": "Ōdate",
    "大鰐温泉": "Ōwani-Onsen", "天塩中川": "Teshio-Nakagawa", "妹尾": "Senoo", "姫路": "Himeji",
    "奥津軽いまべつ": "Oku-Tsugaru-Imabetsu", "幌延": "Horonobe",
    "嬉野温泉": "Ureshino-Onsen", "宇多津": "Utazu", "宇宿": "Utoko", "宮ヶ浜": "Miyagahama",
    "宮地": "Miyaji", "宮崎": "Miyazaki", "宮崎神宮": "Miyazaki-Jingū", "富士": "Fuji",
    "富士宮": "Fujinomiya", "富山": "Toyama", "小倉": "Kokura", "小松": "Komatsu",
    "小森江": "Komorie", "小田原": "Odawara", "山之口": "Yamanokuchi", "山川": "Yamakawa",
    "岡山": "Okayama", "岡谷": "Okaya", "岩見沢": "Iwamizawa", "川内": "Sendai",
    "川棚": "Kawatana", "市川大門": "Ichikawa-Daimon", "帯広": "Obihiro", "平川": "Hirakawa",
    "広島": "Hiroshima", "延岡": "Nobeoka", "引田": "Hiketa", "弘前": "Hirosaki",
    "彼杵": "Sonogi", "後免": "Gomen", "徳島": "Tokushima", "志度": "Shido", "慈眼寺": "Jigenji",
    "指宿": "Ibusuki", "新八代": "Shin-Yatsushiro", "新函館北斗": "Shin-Hakodate-Hokuto",
    "新夕張": "Shin-Yūbari", "新大村": "Shin-Ōmura", "新大阪": "Shin-Ōsaka", "新宿": "Shinjuku",
    "新富士": "Shin-Fuji", "新山口": "Shin-Yamaguchi", "新得": "Shintoku", "新札幌": "Shin-Sapporo",
    "新横浜": "Shin-Yokohama", "新水俣": "Shin-Minamata", "新津": "Niitsu", "新潟": "Niigata",
    "新発田": "Shibata", "新神戸": "Shin-Kōbe", "新青森": "Shin-Aomori", "新高岡": "Shin-Takaoka",
    "新鳥栖": "Shin-Tosu", "日向市": "Hyūga-shi", "日宇": "Hiu", "日立": "Hitachi",
    "早岐": "Haiki", "早島": "Hayashima", "旭川": "Asahikawa", "有田": "Arita", "木古内": "Kikonai",
    "札幌": "Sapporo", "村上": "Murakami", "東三条": "Higashi-Sanjō", "東京": "Tōkyō",
    "東室蘭": "Higashi-Muroran", "東能代": "Higashi-Noshiro", "東花輪": "Higashi-Hanawa",
    "東釧路": "Higashi-Kushiro", "杵築": "Kitsuki", "松原": "Matsubara", "松本": "Matsumoto",
    "松浦": "Matsuura", "板野": "Itano", "柏": "Kashiwa", "柏崎": "Kashiwazaki", "栗林": "Ritsurin",
    "根室": "Nemuro", "森": "Mori", "森岳": "Moritake", "武蔵塚": "Musashizuka",
    "武蔵浦和": "Musashi-Urawa", "武雄温泉": "Takeo-Onsen", "水戸": "Mito", "江北": "Kōhoku",
    "池田": "Ikeda", "池谷": "Ikenotani", "沼津": "Numazu", "洞爺": "Tōya", "津久見": "Tsukumi",
    "浜中": "Hamanaka", "浦上": "Urakami", "浦和": "Urawa", "浪岡": "Namioka", "深川": "Fukagawa",
    "清武": "Kiyotake", "清水": "Shimizu", "滝川": "Takikawa", "瀬々串": "Sezekushi",
    "熊本": "Kumamoto", "熱海": "Atami", "琴平": "Kotohira", "生見": "Nukumi", "田沢湖": "Tazawako",
    "田野": "Tano", "甲府": "Kōfu", "甲斐岩間": "Kai-Iwama", "登別": "Noboribetsu",
    "白糠": "Shiranuka", "盛岡": "Morioka", "直江津": "Naoetsu", "相浦": "Ainoura", "相馬": "Sōma",
    "石井": "Ishii", "石岡": "Ishioka", "砂川": "Sunagawa", "碇ヶ関": "Ikarigaseki",
    "福山": "Fukuyama", "秋田": "Akita", "稚内": "Wakkanai", "穴吹": "Anabuki", "立川": "Tachikawa",
    "立野": "Tateno", "竹松": "Takematsu", "篠ノ井": "Shinonoi", "糸魚川": "Itoigawa",
    "美唄": "Bibai", "美深": "Bifuka", "羽後本荘": "Ugo-Honjō", "肥後大津": "Higo-Ōzu",
    "臼杵": "Usuki", "苫小牧": "Tomakomai", "茅野": "Chino", "茶内": "Chanai", "茶屋町": "Chayamachi",
    "蔵本": "Kuramoto", "薩摩今和泉": "Satsuma-Imaizumi", "行橋": "Yukuhashi",
    "西国分寺": "Nishi-Kokubunji", "西大山": "Nishi-Ōyama", "西小倉": "Nishi-Kokura",
    "西都城": "Nishi-Miyakonojō", "見附": "Mitsuke", "角館": "Kakunodate", "諫早": "Isahaya",
    "谷山": "Taniyama", "豊富": "Toyotomi", "豊栄": "Toyosaka", "象潟": "Kisakata",
    "貞光": "Sadamitsu", "赤水": "Akamizu", "赤羽": "Akabane", "身延": "Minobu", "郡元": "Kōrimoto",
    "都城": "Miyakonojō", "酒田": "Sakata", "金沢": "Kanazawa", "釧路": "Kushiro",
    "長万部": "Oshamambe", "長岡": "Nagaoka", "長崎": "Nagasaki", "長野": "Nagano", "門司": "Moji",
    "門司港": "Mojikō", "阿波加茂": "Awa-Kamo", "阿波川島": "Awa-Kawashima", "阿波池田": "Awa-Ikeda",
    "阿蘇": "Aso", "隼人": "Hayato", "霧島神宮": "Kirishima-Jingū", "青森": "Aomori",
    "静岡": "Shizuoka", "音威子府": "Otoineppu", "飯山": "Iiyama", "高松": "Takamatsu",
    "高田": "Takada", "高知": "Kōchi", "高鍋": "Takanabe", "鰍沢口": "Kajikazawaguchi",
    "鳥栖": "Tosu", "鴨島": "Kamojima", "鶴岡": "Tsuruoka", "鷹ノ巣": "Takanosu",
    "鹿児島": "Kagoshima", "鹿児島中央": "Kagoshima-Chūō", "黒部宇奈月温泉": "Kurobe-Unazuki-Onsen",

    // limited-express / line service names
    "あずさ": "Azusa", "あそぼーい！": "Aso Boy!", "いなほ": "Inaho", "うずしお": "Uzushio",
    "おおぞら": "Ōzora", "かもめ": "Kamome", "きりしま": "Kirishima", "こだま": "Kodama",
    "こまち": "Komachi", "こまち+はやぶさ": "Komachi + Hayabusa", "さくら": "Sakura",
    "しなの": "Shinano", "しらゆき": "Shirayuki", "つがる": "Tsugaru", "ときわ": "Tokiwa",
    "にちりん": "Nichirin", "はくたか": "Hakutaka", "はこだてライナー": "Hakodate Liner",
    "はやぶさ": "Hayabusa", "はやぶさ+こまち": "Hayabusa + Komachi", "ひかり": "Hikari",
    "ひたち": "Hitachi", "ふじかわ": "Fujikawa", "みどり": "Midori",
    "シーサイドライナー": "Seaside Liner", "ソニック": "Sonic", "マリンライナー": "Marine Liner",
    "リレーかもめ": "Relay Kamome", "京浜東北線": "Keihin-Tōhoku Line", "剣山": "Tsurugisan",
    "北斗": "Hokuto", "南風": "Nanpū", "奥羽線 普通": "Ōu Line (Local)", "宗谷": "Sōya",
    "快速ノサップ": "Rapid Nosappu", "指宿枕崎線 普通": "Ibusuki-Makurazaki Line (Local)",
    "東北線・京浜東北線": "Tōhoku Line · Keihin-Tōhoku Line", "東海道線 普通": "Tōkaidō Line (Local)",
    "松浦鉄道 西九州線": "Matsuura Railway Nishi-Kyūshū Line",
    "武蔵野線・東北線": "Musashino Line · Tōhoku Line", "花咲線 普通": "Hanasaki Line (Local)",
    "鹿児島本線 普通": "Kagoshima Main Line (Local)",
  };

  // ---- Japanese -> kana (hiragana) reading, shown in Chinese mode ---------
  // Only names that contain kanji are listed; names already written entirely
  // in kana (e.g. あずさ, ソニック) get no parenthetical so the display stays
  // clean. Used by placeName() to render "東京（とうきょう）" in zh mode.
  const KANA = {
    // stations
    "あつみ温泉": "あつみおんせん", "さいたま新都心": "さいたましんとしん",
    "たびら平戸口": "たびらひらどぐち", "三島": "みしま", "三本松": "さんぼんまつ",
    "三股": "みまた", "上諏訪": "かみすわ", "上越妙高": "じょうえつみょうこう", "上野": "うえの",
    "下部温泉": "しもべおんせん", "与野": "よの", "中佐世保": "なかさせぼ", "中名": "なかみょう",
    "中条": "なかじょう", "中津": "なかつ", "丸亀": "まるがめ", "久留米": "くるめ",
    "二ツ井": "ふたつい", "二日市": "ふつかいち", "二月田": "にがつでん", "五位野": "ごいの",
    "五稜郭": "ごりょうかく", "京都": "きょうと", "仁賀保": "にかほ", "仙台": "せんだい",
    "伊達紋別": "だてもんべつ", "佐々": "さざ", "佐世保": "させぼ", "佐世保中央": "させぼちゅうおう",
    "佐伯": "さいき", "佐土原": "さどわら", "佐賀": "さが", "余目": "あまるめ", "児島": "こじま",
    "八戸": "はちのへ", "八王子": "はちおうじ", "八郎潟": "はちろうがた", "八雲": "やくも",
    "内船": "うつぶな", "出水": "いずみ", "函館": "はこだて", "別府": "べっぷ",
    "前之浜": "まえのはま", "加茂": "かも", "加賀温泉": "かがおんせん", "勝瑞": "しょうずい",
    "勝田": "かつた", "北佐世保": "きたさせぼ", "北浦和": "きたうらわ", "南千歳": "みなみちとせ",
    "南宮崎": "みなみみやざき", "南浦和": "みなみうらわ", "南甲府": "みなみこうふ",
    "南稚内": "みなみわっかない", "南鹿児島": "みなみかごしま", "博多": "はかた", "厚岸": "あっけし",
    "厚床": "あっとこ", "原ノ町": "はらのまち", "名古屋": "なごや", "名寄": "なよろ",
    "和寒": "わっさむ", "品川": "しながわ", "善通寺": "ぜんつうじ", "喜入": "きいれ",
    "国分": "こくぶ", "土佐山田": "とさやまだ", "土浦": "つちうら", "坂之上": "さかのうえ",
    "坂出": "さかいで", "坂町": "さかまち", "塩尻": "しおじり", "士別": "しべつ", "多度津": "たどつ",
    "大分": "おおいた", "大塔": "だいとう", "大宮": "おおみや", "大山": "おおやま", "大曲": "おおまがり",
    "大月": "おおつき", "大杉": "おおすぎ", "大村": "おおむら", "大歩危": "おおぼけ", "大館": "おおだて",
    "大鰐温泉": "おおわにおんせん", "天塩中川": "てしおなかがわ", "奥津軽いまべつ": "おくつがるいまべつ",
    "幌延": "ほろのべ", "妹尾": "せのお", "姫路": "ひめじ", "嬉野温泉": "うれしのおんせん",
    "宇多津": "うたづ", "宇宿": "うとこ", "宮ヶ浜": "みやがはま", "宮地": "みやじ", "宮崎": "みやざき",
    "宮崎神宮": "みやざきじんぐう", "富士": "ふじ", "富士宮": "ふじのみや", "富山": "とやま",
    "小倉": "こくら", "小松": "こまつ", "小森江": "こもりえ", "小田原": "おだわら",
    "山之口": "やまのくち", "山川": "やまかわ", "岡山": "おかやま", "岡谷": "おかや",
    "岩見沢": "いわみざわ", "川内": "せんだい", "川棚": "かわたな", "市川大門": "いちかわだいもん",
    "帯広": "おびひろ", "平川": "ひらかわ", "広島": "ひろしま", "延岡": "のべおか", "引田": "ひけた",
    "弘前": "ひろさき", "彼杵": "そのぎ", "後免": "ごめん", "徳島": "とくしま", "志度": "しど",
    "慈眼寺": "じげんじ", "指宿": "いぶすき", "新八代": "しんやつしろ",
    "新函館北斗": "しんはこだてほくと", "新夕張": "しんゆうばり", "新大村": "しんおおむら",
    "新大阪": "しんおおさか", "新宿": "しんじゅく", "新富士": "しんふじ", "新山口": "しんやまぐち",
    "新得": "しんとく", "新札幌": "しんさっぽろ", "新横浜": "しんよこはま", "新水俣": "しんみなまた",
    "新津": "にいつ", "新潟": "にいがた", "新発田": "しばた", "新神戸": "しんこうべ",
    "新青森": "しんあおもり", "新高岡": "しんたかおか", "新鳥栖": "しんとす", "日向市": "ひゅうがし",
    "日宇": "ひう", "日立": "ひたち", "早岐": "はいき", "早島": "はやしま", "旭川": "あさひかわ",
    "有田": "ありた", "木古内": "きこない", "札幌": "さっぽろ", "村上": "むらかみ",
    "東三条": "ひがしさんじょう", "東京": "とうきょう", "東室蘭": "ひがしむろらん",
    "東能代": "ひがしのしろ", "東花輪": "ひがしはなわ", "東釧路": "ひがしくしろ", "杵築": "きつき",
    "松原": "まつばら", "松本": "まつもと", "松浦": "まつうら", "板野": "いたの", "柏": "かしわ",
    "柏崎": "かしわざき", "栗林": "りつりん", "根室": "ねむろ", "森": "もり", "森岳": "もりたけ",
    "武蔵塚": "むさしづか", "武蔵浦和": "むさしうらわ", "武雄温泉": "たけおおんせん", "水戸": "みと",
    "江北": "こうほく", "池田": "いけだ", "池谷": "いけのたに", "沼津": "ぬまづ", "洞爺": "とうや",
    "津久見": "つくみ", "浜中": "はまなか", "浦上": "うらかみ", "浦和": "うらわ", "浪岡": "なみおか",
    "深川": "ふかがわ", "清武": "きよたけ", "清水": "しみず", "滝川": "たきかわ", "瀬々串": "せせくし",
    "熊本": "くまもと", "熱海": "あたみ", "琴平": "ことひら", "生見": "ぬくみ", "田沢湖": "たざわこ",
    "田野": "たの", "甲府": "こうふ", "甲斐岩間": "かいいわま", "登別": "のぼりべつ", "白糠": "しらぬか",
    "盛岡": "もりおか", "直江津": "なおえつ", "相浦": "あいのうら", "相馬": "そうま", "石井": "いしい",
    "石岡": "いしおか", "砂川": "すながわ", "碇ヶ関": "いかりがせき", "福山": "ふくやま",
    "秋田": "あきた", "稚内": "わっかない", "穴吹": "あなぶき", "立川": "たちかわ", "立野": "たての",
    "竹松": "たけまつ", "篠ノ井": "しののい", "糸魚川": "いといがわ", "美唄": "びばい", "美深": "びふか",
    "羽後本荘": "うごほんじょう", "肥後大津": "ひごおおづ", "臼杵": "うすき", "苫小牧": "とまこまい",
    "茅野": "ちの", "茶内": "ちゃない", "茶屋町": "ちゃやまち", "蔵本": "くらもと",
    "薩摩今和泉": "さつまいまいずみ", "行橋": "ゆくはし", "西国分寺": "にしこくぶんじ",
    "西大山": "にしおおやま", "西小倉": "にしこくら", "西都城": "にしみやこのじょう", "見附": "みつけ",
    "角館": "かくのだて", "諫早": "いさはや", "谷山": "たにやま", "豊富": "とよとみ", "豊栄": "とよさか",
    "象潟": "きさかた", "貞光": "さだみつ", "赤水": "あかみず", "赤羽": "あかばね", "身延": "みのぶ",
    "郡元": "こおりもと", "都城": "みやこのじょう", "酒田": "さかた", "金沢": "かなざわ",
    "釧路": "くしろ", "長万部": "おしゃまんべ", "長岡": "ながおか", "長崎": "ながさき", "長野": "ながの",
    "門司": "もじ", "門司港": "もじこう", "阿波加茂": "あわかも", "阿波川島": "あわかわしま",
    "阿波池田": "あわいけだ", "阿蘇": "あそ", "隼人": "はやと", "霧島神宮": "きりしまじんぐう",
    "青森": "あおもり", "静岡": "しずおか", "音威子府": "おといねっぷ", "飯山": "いいやま",
    "高松": "たかまつ", "高田": "たかだ", "高知": "こうち", "高鍋": "たかなべ",
    "鰍沢口": "かじかざわぐち", "鳥栖": "とす", "鴨島": "かもじま", "鶴岡": "つるおか",
    "鷹ノ巣": "たかのす", "鹿児島": "かごしま", "鹿児島中央": "かごしまちゅうおう",
    "黒部宇奈月温泉": "くろべうなづきおんせん",

    // limited-express / line service names with kanji
    "剣山": "つるぎさん", "北斗": "ほくと", "南風": "なんぷう", "奥羽線 普通": "おううせん ふつう",
    "宗谷": "そうや", "快速ノサップ": "かいそくノサップ",
    "指宿枕崎線 普通": "いぶすきまくらざきせん ふつう",
    "東北線・京浜東北線": "とうほくせん・けいひんとうほくせん", "東海道線 普通": "とうかいどうせん ふつう",
    "松浦鉄道 西九州線": "まつうらてつどう にしきゅうしゅうせん",
    "武蔵野線・東北線": "むさしのせん・とうほくせん", "花咲線 普通": "はなさきせん ふつう",
    "鹿児島本線 普通": "かごしまほんせん ふつう", "京浜東北線": "けいひんとうほくせん",
  };

  // ---- core helpers -------------------------------------------------------
  function fill(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) =>
      params[k] === undefined || params[k] === null ? m : String(params[k]),
    );
  }

  function t(key, params) {
    const entry = STRINGS[key];
    const raw = entry ? (entry[currentLang] ?? entry.zh ?? key) : key;
    return fill(raw, params);
  }

  function nameEn(jp) {
    return NAMES[jp] || null;
  }

  // Bilingual display:
  //   EN -> "東京 (Tōkyō)" (Japanese + romanized gloss)
  //   ZH -> "東京（とうきょう）" (Japanese + kana reading); names already
  //         written entirely in kana get no parenthetical.
  function placeName(jp) {
    if (!jp) return jp || "";
    if (currentLang === "en") {
      const en = NAMES[jp];
      return en ? jp + " (" + en + ")" : jp;
    }
    const kana = KANA[jp];
    return kana ? jp + "（" + kana + "）" : jp;
  }
  const trainName = placeName; // same dictionary covers service names

  function getLang() {
    return currentLang;
  }

  // ---- static DOM application --------------------------------------------
  function applyStatic(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    scope.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
    document.documentElement.lang = currentLang === "en" ? "en" : "zh-Hant";
    document.title = t("app.title");
  }

  // ---- change listeners / language switch --------------------------------
  const listeners = [];
  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function setLang(lang) {
    if (!SUPPORTED.includes(lang) || lang === currentLang) {
      // Still sync the dropdown if it drifted, but skip the heavy re-render.
      if (!SUPPORTED.includes(lang)) return;
    }
    currentLang = lang;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch (e) {
      /* storage may be unavailable; language just won't persist */
    }
    applyStatic(document);
    const sel = document.getElementById("lang-select");
    if (sel && sel.value !== lang) sel.value = lang;
    listeners.forEach((fn) => {
      try {
        fn(lang);
      } catch (e) {
        console.warn("i18n onChange listener failed", e);
      }
    });
  }

  function detectInitialLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (SUPPORTED.includes(saved)) return saved;
    } catch (e) {
      /* ignore */
    }
    return "zh"; // default: Traditional Chinese
  }

  currentLang = detectInitialLang();

  function init() {
    const sel = document.getElementById("lang-select");
    if (sel) {
      sel.value = currentLang;
      sel.addEventListener("change", () => setLang(sel.value));
    }
    applyStatic(document);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.I18N = {
    t: t,
    placeName: placeName,
    trainName: trainName,
    nameEn: nameEn,
    getLang: getLang,
    setLang: setLang,
    onChange: onChange,
    applyStatic: applyStatic,
  };
})();
