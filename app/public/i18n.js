// ---------------------------------------------------------------------------
// Lightweight i18n layer for the N02 Limited Express Manager web UI.
//
// Loaded BEFORE app.js so `window.I18N` exists synchronously for every caller,
// and AFTER i18n-strings.js (UI string catalogs, I18NStrings global) and
// app-core.js (AppCore.normalizeStationName — the one station-name key rule,
// used here for the reading-table byName lookups). Four languages:
// Traditional Chinese, Simplified Chinese, Japanese and English. The chosen
// language is remembered in localStorage.
//
//   I18N.t(key, params)   -> translated UI string ("{x}" placeholders filled)
//   I18N.placeName(name)  -> country-aware station name / reading
//   I18N.trainName(jp)    -> same dictionary, for limited-express service names
//   I18N.setLang(lang)    -> switch language, persist, re-apply, notify
//   I18N.onChange(fn)     -> register a callback fired after each switch
//   I18N.applyStatic(root)-> translate [data-i18n*] attributes under root
//
// Source station / line names are proper nouns and are never rewritten in the
// train data. Japan keeps its source name and optional reading subline; Taiwan
// replaces the displayed station name from its separate official four-language
// table while retaining the official Traditional name in the source store.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  const LANG_KEY = "n02-ui-lang";
  const SUPPORTED = ["zh-Hant", "zh-Hans", "ja", "en"];
  let currentLang = "zh-Hant";

  // UI string catalogs (STRINGS / JA_STRINGS) live in i18n-strings.js,
  // loaded right before this file.
  const { STRINGS, JA_STRINGS } = window.I18NStrings;
  // The Simplified Chinese UI is derived from the maintained Traditional
  // Chinese source copy. These are the characters used by the UI strings;
  // Japanese proper nouns and JSON content are intentionally untouched.
  const HANS_CHAR_MAP = {
    "語": "语", "圖": "图", "檢": "检", "視": "视", "輯": "辑",
    "車": "车", "與": "与", "並": "并", "資": "资", "區": "区",
    "導": "导", "覽": "览", "說": "说", "尋": "寻", "複": "复",
    "刪": "删", "選": "选", "擇": "择", "動": "动", "關": "关",
    "顯": "显", "節": "节", "線": "线", "寬": "宽", "點": "点",
    "調": "调", "終": "终", "過": "过", "設": "设", "時": "时",
    "瀏": "浏", "僅": "仅", "隱": "隐", "載": "载", "匯": "汇",
    "陣": "阵", "個": "个", "欄": "栏", "篩": "筛", "當": "当",
    "響": "响", "無": "无", "復": "复", "鐵": "铁", "門": "门",
    "錄": "录", "總": "总", "來": "来", "網": "网", "單": "单",
    "輛": "辆", "顏": "颜", "發": "发", "類": "类", "運": "运",
    "轉": "转", "邊": "边", "標": "标", "記": "记", "檔": "档",
    "驗": "验", "開": "开", "這": "这", "會": "会", "權": "权",
    "確": "确", "準": "准", "條": "条", "從": "从", "將": "将",
    "內": "内", "數": "数", "據": "据", "製": "制", "離": "离",
    "羅": "罗", "啟": "启", "鄰": "邻", "實": "实", "際": "际",
    "國": "国", "處": "处", "還": "还", "應": "应", "層": "层",
    "寫": "写", "讀": "读", "識": "识", "別": "别", "歸": "归",
    "則": "则", "為": "为", "較": "较", "敗": "败", "錯": "错",
    "碼": "码", "儲": "储", "併": "并", "頁": "页", "鈕": "钮",
    "編": "编", "預": "预", "細": "细", "間": "间", "貼": "贴",
    "證": "证", "險": "险", "請": "请", "統": "统", "計": "计",
    "幹": "干", "閉": "闭", "圓": "圆", "襯": "衬", "號": "号",
    "經": "经", "磚": "砖", "馬": "马", "連": "连", "試": "试",
    "橫": "横", "換": "换", "隨": "随", "獨": "独", "後": "后",
    "沒": "没", "備": "备", "該": "该", "輸": "输", "報": "报",
    "達": "达", "讓": "让", "屬": "属", "於": "于", "題": "题",
    "須": "须", "樣": "样", "徑": "径", "虛": "虚", "監": "监",
    "畫": "画", "擬": "拟", "參": "参", "暫": "暂", "範": "范",
    "圍": "围", "紅": "红", "採": "采", "許": "许", "測": "测",
    "東": "东", "捨": "舍", "棄": "弃", "蓋": "盖", "疊": "叠",
    "營": "营", "偵": "侦", "機": "机", "電": "电", "腦": "脑",
    "灣": "湾",
    // Taiwanese authority names in the data-source panel (交通部運輸資料流通
    // 服務平臺, 國土測繪中心, 農業部…林業鐵路及文化資產管理處, 臺北市…).
    // 臺 is the Traditional form Taiwan's own agencies use; Simplified writes
    // it 台 (臺北→台北, 平臺→平台), and station names are unaffected — they
    // carry their own zh_Hans from the readings table, not this converter.
    "務": "务", "業": "业", "產": "产", "結": "结", "繪": "绘",
    "農": "农", "臺": "台",
    // Taiwan's coverage categories (輕軌 …).
    "輕": "轻", "軌": "轨",
  };

  const HANS_PHRASE_MAP = {
    "「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成":
      "根据日本国土交通省“国土数值信息（铁路数据 N02）”加工制作",
    "國土數值情報": "国土数值信息",
    "国土数値情報": "国土数值信息",
    "車輛公司": "运营公司",
    "營運公司": "运营公司",
    "資料來源": "数据来源",
    "資料": "数据",
    "匯入": "导入",
    "匯出": "导出",
    "載入": "加载",
    "內建": "内置",
    "伺服器": "服务器",
    "檔案": "文件",
    "欄位": "字段",
    "套用": "应用",
    "開啟": "打开",
    "起站": "始发站",
    "終站": "终到站",
    "運轉停車": "技术停车",
    "檢視": "查看",
    "導覽": "导航",
    "搜尋": "搜索",
    "設定": "设置",
    "支援": "支持",
    "目前": "当前",
    "貼上": "粘贴",
    "物件": "对象",
    "預設": "默认",
    "即時": "立即",
    "依全部": "根据全部",
    "依停站": "根据停靠站",
    "依日期": "按日期",
    "依 ODbL": "遵循 ODbL",
    "個停站": "个停靠站",
  };

  function toSimplifiedChinese(text) {
    let result = String(text);
    Object.entries(HANS_PHRASE_MAP).forEach(([from, to]) => {
      result = result.split(from).join(to);
    });
    return result.replace(/[\u3400-\u9fff]/g, (ch) => HANS_CHAR_MAP[ch] || ch);
  }

  // ---- Japanese -> English (romaji / gloss) for stations & services -------
  const NAMES = {
    "あずさ": "Azusa",
    "あそぼーい！": "Aso Boy!",
    "いなほ": "Inaho",
    "うずしお": "Uzushio",
    "おおぞら": "Ōzora",
    "かもめ": "Kamome",
    "きりしま": "Kirishima",
    "こだま": "Kodama",
    "こまち": "Komachi",
    "こまち+はやぶさ": "Komachi + Hayabusa",
    "さくら": "Sakura",
    "しなの": "Shinano",
    "しらゆき": "Shirayuki",
    "つがる": "Tsugaru",
    "ときわ": "Tokiwa",
    "にちりん": "Nichirin",
    "はくたか": "Hakutaka",
    "はこだてライナー": "Hakodate Liner",
    "はやぶさ": "Hayabusa",
    "はやぶさ+こまち": "Hayabusa + Komachi",
    "ひかり": "Hikari",
    "ひたち": "Hitachi",
    "ふじかわ": "Fujikawa",
    "みどり": "Midori",
    "シーサイドライナー": "Seaside Liner",
    "ソニック": "Sonic",
    "マリンライナー": "Marine Liner",
    "リレーかもめ": "Relay Kamome",
    "京浜東北線": "Keihin-Tōhoku Line",
    "剣山": "Tsurugisan",
    "北斗": "Hokuto",
    "南風": "Nanpū",
    "奥羽線 普通": "Ōu Line (Local)",
    "宗谷": "Sōya",
    "快速ノサップ": "Rapid Nosappu",
    "指宿枕崎線 普通": "Ibusuki-Makurazaki Line (Local)",
    "東北線・京浜東北線": "Tōhoku Line · Keihin-Tōhoku Line",
    "東海道線 普通": "Tōkaidō Line (Local)",
    "松浦鉄道 西九州線": "Matsuura Railway Nishi-Kyūshū Line",
    "武蔵野線・東北線": "Musashino Line · Tōhoku Line",
    "花咲線 普通": "Hanasaki Line (Local)",
    "鹿児島本線 普通": "Kagoshima Main Line (Local)",
  };

  // ---- Japanese -> kana (hiragana) reading, shown in Chinese mode ---------
  // Only names that contain kanji are listed; names already written entirely
  // in kana (e.g. あずさ, ソニック) get no parenthetical so the display stays
  // clean. Used by placeName() to render "東京（とうきょう）" in zh mode.
  const KANA = {
    "剣山": "つるぎさん",
    "北斗": "ほくと",
    "南風": "なんぷう",
    "奥羽線 普通": "おううせん ふつう",
    "宗谷": "そうや",
    "快速ノサップ": "かいそくノサップ",
    "指宿枕崎線 普通": "いぶすきまくらざきせん ふつう",
    "東北線・京浜東北線": "とうほくせん・けいひんとうほくせん",
    "東海道線 普通": "とうかいどうせん ふつう",
    "松浦鉄道 西九州線": "まつうらてつどう にしきゅうしゅうせん",
    "武蔵野線・東北線": "むさしのせん・とうほくせん",
    "花咲線 普通": "はなさきせん ふつう",
    "鹿児島本線 普通": "かごしまほんせん ふつう",
    "京浜東北線": "けいひんとうほくせん",
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
    let raw = key;
    if (entry) {
      if (currentLang === "ja")
        raw = JA_STRINGS[key] ?? entry.en ?? entry.zh ?? key;
      else if (currentLang === "zh-Hans")
        raw = toSimplifiedChinese(entry.zh ?? entry.en ?? key);
      else if (currentLang === "zh-Hant") raw = entry.zh ?? entry.en ?? key;
      else raw = entry[currentLang] ?? entry.en ?? entry.zh ?? key;
    }
    return fill(raw, params);
  }

  // Proper-name display. Defaults (no explicit toggle prefs):
  //   EN       -> "東京 (Tōkyō)" (Japanese + romanized gloss)
  //   ZH-Hant  -> "東京（とうきょう）" (Japanese + kana reading)
  //   ZH-Hans  -> same presentation; source proper nouns stay unchanged
  //   JA       -> original Japanese only
  // The 顯示 panel exposes three independent reading toggles (kana / romaji /
  // Chinese), pushed in via setNameReadings(); when set they replace the
  // locale defaults above and every enabled reading is appended, joined by
  // " / ". Chinese names come from the readings table's zh_Hant / zh_Hans
  // fields (picked by UI language).
  // Station readings (kana + romaji + zh) keyed by N02 station code, loaded at
  // runtime from /api/station-readings and injected via setStationReadings().
  // Station注音 no longer lives inline in the dictionaries below — those keep
  // only limited-express SERVICE names and line names. placeName() prefers the
  // id-keyed table (code first, then a normalized-name fallback), and only
  // falls back to the service dictionaries for non-station labels.
  let STATION_READINGS = { byCode: {}, byName: {} };
  let STATION_READINGS_COUNTRY = "JP";
  // One station-name key rule for the whole system, owned by AppCore (the
  // station-resolution index and the build scripts use the same function).
  // app-core.js loads before this file — same load-order contract as
  // I18NStrings above.
  const normReadingKey = window.AppCore.normalizeStationName;
  function setStationReadings(data) {
    if (data && typeof data === "object") {
      // Re-key byName through the SAME rule the lookups below use, so hits
      // can never depend on how the external readings table normalized its
      // keys (a no-op for the current data — its keys are already on this
      // grid; verified zero key changes and zero collisions).
      const byName = {};
      const source = data.byName || {};
      for (const key of Object.keys(source))
        byName[normReadingKey(key)] = source[key];
      STATION_READINGS = { byCode: data.byCode || {}, byName };
      STATION_READINGS_COUNTRY =
        String(data.country || "JP").toUpperCase() === "TW" ? "TW" : "JP";
    }
  }
  function stationReading(code, jp) {
    if (code && STATION_READINGS.byCode) {
      const e = STATION_READINGS.byCode[code];
      if (e) return e;
    }
    if (jp && STATION_READINGS.byName) {
      const e = STATION_READINGS.byName[normReadingKey(jp)];
      if (e) return e;
    }
    return null;
  }
  // Taiwan's table contains localized NAMES, not Japanese pronunciation
  // annotations. Use the exact official StationUID/network alias first, then a
  // safe unambiguous byName fallback. Missing official English/Japanese values
  // deliberately fall back to the official Traditional Chinese station name;
  // the table itself keeps those translations as empty strings.
  function stationName(name, code) {
    if (!name) return name || "";
    if (STATION_READINGS_COUNTRY !== "TW") return name;
    const row = stationReading(code, name);
    if (!row) return name;
    if (currentLang === "zh-Hans") return row.zh_Hans || row.zh_Hant || name;
    if (currentLang === "zh-Hant") return row.zh_Hant || name;
    if (currentLang === "ja") return row.ja || row.zh_Hant || name;
    if (currentLang === "en") return row.en || row.zh_Hant || name;
    return name;
  }
  // Explicit reading toggles from the 顯示 panel ({kana, romaji, zh} booleans);
  // null = no explicit choice yet, follow the locale defaults.
  let nameReadingPrefs = null;
  function setNameReadings(prefs) {
    nameReadingPrefs =
      prefs && typeof prefs === "object"
        ? { kana: !!prefs.kana, romaji: !!prefs.romaji, zh: !!prefs.zh }
        : null;
  }
  // Until the user customizes the reading toggles, they follow the UI
  // language. The ONE spelling of that default — app-display-settings.js
  // seeds its toggle state from here (syncNameReadingDefaultsToLang), and
  // activeReadingPrefs falls back to it for the pre-boot window and any
  // standalone railmap embedding.
  function localeDefaultReadingPrefs(lang) {
    return {
      kana: lang === "zh-Hant" || lang === "zh-Hans",
      romaji: lang === "en",
      zh: false,
    };
  }
  function activeReadingPrefs() {
    if (nameReadingPrefs) return nameReadingPrefs;
    return localeDefaultReadingPrefs(currentLang);
  }
  // The enabled readings for a name, typed: [{type: "kana"|"romaji"|"zh",
  // text}] in that fixed order, minus any reading that equals the base name.
  // Station-name display sites stack the texts one per line UNDER the name;
  // the typed form lets paired displays (origin → destination) align the same
  // reading type on the same line.
  function nameReadingsTyped(jp, code) {
    if (!jp) return [];
    // Taiwan localizes the base station name itself into the active one of the
    // four UI languages. It has no Japanese-style reading subline.
    if (STATION_READINGS_COUNTRY === "TW") return [];
    const prefs = activeReadingPrefs();
    const r = stationReading(code, jp);
    const parts = [];
    if (prefs.kana) {
      const kana = (r && r.kana) || KANA[jp];
      if (kana && kana !== jp) parts.push({ type: "kana", text: kana });
    }
    if (prefs.romaji) {
      const romaji = (r && r.romaji) || NAMES[jp];
      if (romaji && romaji !== jp) parts.push({ type: "romaji", text: romaji });
    }
    if (prefs.zh && r) {
      const zh =
        currentLang === "zh-Hans"
          ? r.zh_Hans || r.zh_Hant
          : r.zh_Hant || r.zh_Hans;
      if (zh && zh !== jp) parts.push({ type: "zh", text: zh });
    }
    return parts;
  }
  function nameReadingsList(jp, code) {
    return nameReadingsTyped(jp, code).map((p) => p.text);
  }
  function nameReadings(jp, code) {
    return nameReadingsList(jp, code).join(" / ");
  }
  function placeName(jp, code) {
    if (!jp) return jp || "";
    if (STATION_READINGS_COUNTRY === "TW") return stationName(jp, code);
    const readings = nameReadings(jp, code);
    if (!readings) return jp;
    // Half-width brackets in the Latin-script locales, full-width in Chinese
    // (matches the previous per-locale presentation).
    return currentLang === "zh-Hant" || currentLang === "zh-Hans"
      ? jp + "（" + readings + "）"
      : jp + " (" + readings + ")";
  }
  const trainName = placeName; // same dictionary covers service names

  // ---- static DOM application --------------------------------------------
  // Country-variant lookup: while Taiwan is active, "app.title" resolves to
  // "app.title.tw" when that key exists, so one data-i18n attribute serves
  // both datasets (title, placeholders, attribution copy …). The app pushes
  // the country in via I18N.setCountry (i18n.js loads before app-config.js).
  let uiCountry = "jp";
  function setCountry(country) {
    uiCountry = country === "tw" ? "tw" : "jp";
  }
  function countryVariantKey(key) {
    if (uiCountry === "jp") return key;
    const variant = key + "." + uiCountry;
    return STRINGS[variant] ? variant : key;
  }
  function tc(key, params) {
    return t(countryVariantKey(key), params);
  }
  function applyStatic(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = tc(el.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = tc(el.getAttribute("data-i18n-html"));
    });
    scope.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", tc(el.getAttribute("data-i18n-ph")));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", tc(el.getAttribute("data-i18n-title")));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      el.setAttribute("aria-label", tc(el.getAttribute("data-i18n-aria-label")));
    });
    document.documentElement.lang = currentLang;
    document.title = tc("app.title");
  }

  // ---- change listeners / language switch --------------------------------
  const listeners = [];
  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function setLang(lang) {
    // Migrate calls from the former two-language API.
    if (lang === "zh") lang = "zh-Hant";
    if (!SUPPORTED.includes(lang)) return;
    if (lang === currentLang) {
      // Re-picking the current language: sync the dropdown if it drifted, but
      // skip the heavy re-render (applyStatic + every onChange = full
      // renderAll in app.js). The old guard fell through and re-rendered.
      const sel = document.getElementById("lang-select");
      if (sel && sel.value !== lang) sel.value = lang;
      return;
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
      if (saved === "zh") return "zh-Hant";
      if (SUPPORTED.includes(saved)) return saved;
    } catch (e) {
      /* ignore */
    }
    return "zh-Hant"; // default: Traditional Chinese
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
    nameReadings: nameReadings,
    nameReadingsList: nameReadingsList,
    nameReadingsTyped: nameReadingsTyped,
    stationName: stationName,
    localeDefaultReadingPrefs: localeDefaultReadingPrefs,
    setNameReadings: setNameReadings,
    setStationReadings: setStationReadings,
    setLang: setLang,
    getLang: () => currentLang,
    setCountry: setCountry,
    tc: tc,
    onChange: onChange,
    applyStatic: applyStatic,
  };
})();
