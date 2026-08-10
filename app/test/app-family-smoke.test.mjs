// Smoke tests over the REAL frontend script family evaluated in a Node vm
// (the same replay approach as scripts/precompute-train-parts.mjs).
//
// The app is a set of classic scripts sharing one global lexical scope, so a
// stale cross-file reference only explodes at RUNTIME. The lint task now runs
// concatenated `no-undef`; test 1 remains a runtime family smoke check by
// firing every registered language-change listener WITHOUT i18n.js's
// try/catch, so a swallowed listener error still fails the suite.
//
// Tests 2–3 characterize the read-only recovery mode: a saved store that
// exists but cannot be loaded must yield a recovery sentinel (never writable
// defaults), and while recovery is active autosave must be inert.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import {
  evaluateAppScripts,
  makeSandbox,
} from "../scripts/lib/app-family-sandbox.mjs";

function loadAppFamily({ indexedDB } = {}) {
  const i18nListeners = [];
  const context = makeSandbox({
    userAgent: "node-smoke",
    fetchErrorMessage: "fetch is not available in the smoke-test sandbox",
    indexedDB,
    // Recording i18n stub: listeners are invoked by the tests DIRECTLY,
    // without i18n.js's try/catch, so listener errors fail the test.
    i18n: { onChange: (fn) => i18nListeners.push(fn) },
  });
  evaluateAppScripts(context);
  return { context, i18nListeners };
}

test("frontend jsonspec validation accepts canonical Taiwan TDX station ids", () => {
  const { context } = loadAppFamily();
  assert.equal(vm.runInContext('stationCodeSystem("003770")', context), "N02");
  assert.equal(vm.runInContext('stationCodeSystem("TYMC-A13")', context), "TDX");
  assert.equal(vm.runInContext('stationCodeSystem("tw-official-tymc-a13")', context), null);
  context.__taiwanStore = JSON.parse(
    fs.readFileSync(new URL("../data/train-store-tw.json", import.meta.url), "utf8"),
  );
  const result = vm.runInContext(
    `(() => {
      const parsed = parseImportedCanonicalStore(__taiwanStore);
      const normalized = {
        schema_version: SCHEMA_VERSION,
        trains: parsed.trains.map((train) => normalizeImportedTrain(train)),
      };
      validateTrainStore(normalized);
      return normalized;
    })()`,
    context,
  );
  assert.equal(result.trains.length, 23);
  context.__legacyTaiwanTrain = {
    ...context.__taiwanStore.trains[0],
    company: "桃園大眾捷運股份有限公司",
  };
  const migratedCompany = vm.runInContext(
    `(() => {
      activeCountry = "tw";
      return normalizeImportedTrain(__legacyTaiwanTrain).company;
    })()`,
    context,
  );
  assert.equal(migratedCompany, "桃園捷運");
  assert.deepEqual(
    Array.from(
      vm.runInContext(
        'derivedPreferredOperatorNames({ company: "台鐵" })',
        context,
      ),
    ),
    ["國營臺灣鐵路股份有限公司"],
  );
  assert.deepEqual(
    Array.from(
      vm.runInContext(
        'derivedInstitutionTypeCodes({ company: "台灣高鐵" })',
        context,
      ),
    ),
    ["1"],
  );
  const airportMrt = result.trains.find(
    (train) => train.id === "20260802_01_taoyuan_airport_mrt_express_t2_taipei",
  );
  assert.equal(airportMrt.stops.length, 13);
  assert.equal(airportMrt.route_sections.length, 12);
  const taipeiMainToXimen = result.trains.find(
    (train) => train.id === "20260802_02_trtc_bl_taipei_main_ximen",
  );
  assert.equal(taipeiMainToXimen.stops[0].departure, "14:45");
  assert.equal(taipeiMainToXimen.stops.at(-1).arrival, "14:47");
  assert.deepEqual(taipeiMainToXimen.route_policy.preferred_line_names, [
    "板南線",
  ]);
  const ximenToZhongxiaoFuxing = result.trains.find(
    (train) => train.id === "20260802_03_trtc_bl_ximen_zhongxiao_fuxing",
  );
  assert.equal(ximenToZhongxiaoFuxing.stops[0].departure, "15:52");
  assert.equal(ximenToZhongxiaoFuxing.stops.at(-1).arrival, "16:00");
  assert.deepEqual(
    Array.from(
      ximenToZhongxiaoFuxing.stops.map(
        (stop) => stop.n02_station_code,
      ),
    ),
    ["TRTC-BL11", "TRTC-BL12", "TRTC-BL13", "TRTC-BL14", "TRTC-BL15"],
  );
  const zhongxiaoFuxingToXimen = result.trains.find(
    (train) => train.id === "20260802_04_trtc_bl_zhongxiao_fuxing_ximen",
  );
  assert.equal(zhongxiaoFuxingToXimen.stops[0].departure, "20:00");
  assert.equal(zhongxiaoFuxingToXimen.stops.at(-1).arrival, "20:08");
  assert.equal(zhongxiaoFuxingToXimen.company, "台北捷運");
  assert.deepEqual(
    Array.from(zhongxiaoFuxingToXimen.route_sections[0].operator_names),
    ["臺北大眾捷運股份有限公司"],
  );
  const tra191 = result.trains.find(
    (train) =>
      train.id === "20260808_01_tra_tze_chiang_3000_191_taichung_chiayi",
  );
  assert.equal(tra191.stops[0].departure, "07:39");
  assert.equal(tra191.stops.at(-1).arrival, "08:43");
  assert.equal(tra191.stops.length, 23);
  assert.equal(tra191.route_sections.length, 22);
  assert.equal(
    tra191.stops.filter((stop) => stop.stop_type === "pass_through").length,
    20,
  );
  const tra191Changhua = tra191.stops.find((stop) => stop.name === "彰化");
  assert.equal(tra191Changhua.arrival, "07:53");
  assert.equal(tra191Changhua.departure, "07:55");
  assert.deepEqual(Array.from(tra191.route_sections[5].line_names), ["臺中線"]);
  assert.deepEqual(Array.from(tra191.route_sections[6].line_names), [
    "縱貫線南段",
  ]);
  const alishan5 = result.trains.find(
    (train) => train.id === "20260808_02_alsr_5_chiayi_alishan",
  );
  assert.equal(alishan5.stops[0].departure, "10:00");
  assert.equal(alishan5.stops.at(-1).arrival, "14:56");
  assert.equal(alishan5.stops.length, 17);
  assert.equal(alishan5.route_sections.length, 16);
  assert.equal(
    alishan5.stops.filter((stop) => stop.stop_type === "pass_through").length,
    10,
  );
  const alishan5Fenqihu = alishan5.stops.find(
    (stop) => stop.name === "奮起湖",
  );
  assert.equal(alishan5Fenqihu.arrival, "12:16");
  assert.equal(alishan5Fenqihu.departure, "13:21");
  assert.deepEqual(Array.from(alishan5.route_sections[0].line_names), [
    "阿里山線",
  ]);
  assert.equal(alishan5.company, "阿里山林鐵");
  const alishan8 = result.trains.find(
    (train) => train.id === "20260809_01_alsr_8_alishan_chiayi",
  );
  assert.equal(alishan8.stops[0].departure, "11:50");
  assert.equal(alishan8.stops.at(-1).arrival, "15:45");
  assert.equal(alishan8.stops.length, 17);
  assert.equal(alishan8.route_sections.length, 16);
  assert.equal(
    alishan8.stops.filter((stop) => stop.stop_type === "pass_through").length,
    10,
  );
  assert.deepEqual(Array.from(alishan8.route_sections[0].operator_names), [
    "阿里山林業鐵路及文化資產管理處",
  ]);
  const shenmu120 = result.trains.find(
    (train) => train.id === "20260808_03_alsr_120_alishan_shenmu",
  );
  assert.equal(shenmu120.stops[0].departure, "15:50");
  assert.equal(shenmu120.stops.at(-1).arrival, "15:57");
  assert.deepEqual(Array.from(shenmu120.route_sections[0].line_names), [
    "神木線",
  ]);
  const shenmu121 = result.trains.find(
    (train) => train.id === "20260808_04_alsr_121_shenmu_alishan",
  );
  assert.equal(shenmu121.stops[0].departure, "16:10");
  assert.equal(shenmu121.stops.at(-1).arrival, "16:17");
  const zhushanObservation = result.trains.find(
    (train) =>
      train.id === "20260809_02_alsr_zhushan_observation_alishan_zhushan",
  );
  assert.equal(zhushanObservation.stops[0].departure, "04:40");
  assert.equal(zhushanObservation.stops.at(-1).arrival, "05:05");
  assert.deepEqual(
    Array.from(zhushanObservation.stops.map((stop) => stop.name)),
    ["阿里山", "對高岳", "祝山"],
  );
  assert.equal(zhushanObservation.route_sections.length, 2);
  assert.equal(
    zhushanObservation.stops.filter(
      (stop) => stop.stop_type === "pass_through",
    ).length,
    1,
  );
  zhushanObservation.route_sections.forEach((section) => {
    assert.deepEqual(Array.from(section.line_names), ["祝山線"]);
  });
  const zhushanReturn = result.trains.find(
    (train) =>
      train.id === "20260809_03_alsr_zhushan_observation_zhushan_alishan",
  );
  assert.equal(zhushanReturn.stops[0].departure, "06:20");
  assert.equal(zhushanReturn.stops.at(-1).arrival, "06:45");
  const tra125 = result.trains.find(
    (train) =>
      train.id ===
      "20260809_04_tra_tze_chiang_3000_125_chiayi_kaohsiung",
  );
  assert.equal(tra125.stops[0].departure, "16:19");
  assert.equal(tra125.stops.at(-1).arrival, "17:34");
  assert.equal(tra125.stops.length, 30);
  assert.equal(tra125.route_sections.length, 29);
  assert.equal(
    tra125.stops.filter((stop) => stop.stop_type === "pass_through").length,
    24,
  );
  assert.deepEqual(
    Array.from(
      tra125.stops
        .filter((stop) => stop.stop_type !== "pass_through")
        .map((stop) => stop.name),
    ),
    ["嘉義", "新營", "永康", "臺南", "新左營", "高雄"],
  );
  const kaohsiungToGangshanStation = result.trains.find(
    (train) =>
      train.id === "20260810_01_krtc_red_kaohsiung_gangshan_station",
  );
  assert.equal(kaohsiungToGangshanStation.stops[0].departure, "14:38");
  assert.equal(
    kaohsiungToGangshanStation.stops.at(-1).n02_station_code,
    "KRTC-RK1",
  );
  assert.equal(kaohsiungToGangshanStation.stops.at(-1).arrival, "15:10");
  assert.equal(kaohsiungToGangshanStation.company, "高雄捷運");
  assert.equal(kaohsiungToGangshanStation.route_sections.length, 15);
  const gangshanStationToSiaogang = result.trains.find(
    (train) =>
      train.id === "20260810_02_krtc_red_gangshan_station_siaogang",
  );
  assert.equal(gangshanStationToSiaogang.stops[0].departure, "15:16");
  assert.equal(gangshanStationToSiaogang.stops.at(-1).arrival, "16:06");
  assert.equal(gangshanStationToSiaogang.stops.length, 25);
  const siaogangToSanduo = result.trains.find(
    (train) => train.id === "20260810_03_krtc_red_siaogang_sanduo",
  );
  assert.equal(siaogangToSanduo.stops[0].departure, "16:12");
  assert.equal(siaogangToSanduo.stops.at(-1).arrival, "16:24");
  const sanduoToKaisyuan = result.trains.find(
    (train) => train.id === "20260810_04_krtc_red_sanduo_kaisyuan",
  );
  assert.equal(sanduoToKaisyuan.stops[0].departure, "17:03");
  assert.equal(sanduoToKaisyuan.stops[1].departure, "17:05");
  assert.equal(sanduoToKaisyuan.stops.at(-1).arrival, "17:08");
  const lightRailLoop = result.trains.find(
    (train) => train.id === "20260810_05_klrt_c3_counterclockwise_loop",
  );
  assert.equal(lightRailLoop.stops[0].departure, "17:18");
  assert.equal(lightRailLoop.stops.at(-1).arrival, "18:47");
  assert.equal(lightRailLoop.stops.length, 39);
  assert.equal(lightRailLoop.route_sections.length, 38);
  assert.equal(lightRailLoop.stops[0].n02_station_code, "KLRT-NETWORK-C3");
  assert.equal(lightRailLoop.stops[1].n02_station_code, "KLRT-NETWORK-C2");
  assert.equal(lightRailLoop.stops.at(-1).n02_station_code, "KLRT-NETWORK-C3");
  assert.equal(
    lightRailLoop.stops.filter((stop) => stop.stop_type === "passenger_stop")
      .length,
    37,
  );
  const kaisyuanToKaohsiung = result.trains.find(
    (train) => train.id === "20260810_06_krtc_red_kaisyuan_kaohsiung",
  );
  assert.equal(kaisyuanToKaohsiung.stops[0].departure, "18:54");
  assert.equal(kaisyuanToKaohsiung.stops.at(-1).arrival, "19:04");
  assert.equal(
    result.trains.every(
      (train) => !/(?:股份有限公司|管理局|管理處)/.test(train.company),
    ),
    true,
  );
  const thsr165 = result.trains.find(
    (train) => train.id === "20260805_01_thsr_165_taipei_taichung",
  );
  assert.equal(thsr165.stops[0].departure, "21:31");
  assert.deepEqual(
    Array.from(
      thsr165.stops
        .filter((stop) => stop.stop_type === "pass_through")
        .map((stop) => stop.n02_station_code),
    ),
    ["THSR-1020", "THSR-1030", "THSR-1035"],
  );
  const tra137 = result.trains.find(
    (train) =>
      train.id === "20260806_01_tra_tze_chiang_3000_137_taichung_changhua",
  );
  assert.equal(tra137.stops[0].departure, "14:10");
  assert.equal(tra137.stops.at(-1).arrival, "14:23");
  assert.equal(
    tra137.stops.filter((stop) => stop.stop_type === "pass_through").length,
    5,
  );
  // The round-island tourist express: a Taipei→Taipei loop over eight TRA
  // display lines, every physical station enumerated per jsonspec §14.
  const roundIsland = result.trains.find(
    (train) => train.id === "20260813_01_star_of_taiwan_round_island_loop",
  );
  assert.equal(roundIsland.id, "20260813_01_star_of_taiwan_round_island_loop");
  assert.equal(roundIsland.stops.length, 195);
  assert.equal(roundIsland.route_sections.length, 194);
  assert.equal(roundIsland.stops[0].n02_station_code, "TRA-1000");
  assert.equal(roundIsland.stops.at(-1).n02_station_code, "TRA-1000");
  assert.equal(
    roundIsland.stops.filter((stop) => stop.stop_type !== "pass_through").length,
    24,
  );
});

test("Taiwan ridden routes keep the exact ordered Alishan display interval", async () => {
  const { context } = loadAppFamily();
  context.__twSections = JSON.parse(
    fs.readFileSync(
      new URL("../data/rail-sections-tw.json", import.meta.url),
      "utf8",
    ),
  );
  context.__twStations = JSON.parse(
    fs.readFileSync(
      new URL("../data/stations-tw.json", import.meta.url),
      "utf8",
    ),
  );
  context.__twStore = JSON.parse(
    fs.readFileSync(
      new URL("../data/train-store-tw.json", import.meta.url),
      "utf8",
    ),
  );

  const result = await vm.runInContext(
    `(async () => {
      activeCountry = "tw";
      railSectionsGeoJson = __twSections;
      stationsGeoJson = __twStations;
      await buildStationIndexesSliced(stationsGeoJson);
      const uphill = __twStore.trains.find(
        (train) => train.id === "20260808_02_alsr_5_chiayi_alishan"
      );
      const downhill = __twStore.trains.find(
        (train) => train.id === "20260809_01_alsr_8_alishan_chiayi"
      );
      const uphillFeature = solveTaiwanRouteSectionOnOfficialInterval(
        uphill.route_sections.at(-1),
        uphill.route_sections.length - 1,
        uphill,
        ["3"],
      );
      const downhillFeature = solveTaiwanRouteSectionOnOfficialInterval(
        downhill.route_sections[0],
        0,
        downhill,
        ["3"],
      );
      const deduped = dedupeSameTrainRouteFeatures([uphillFeature]);
      return {
        uphillFeature,
        downhillFeature,
        dedupedCoordinates: deduped[0].geometry.coordinates,
        renderKeepIndices: getRouteLinePairs(uphillFeature)[0].keepIdx,
      };
    })()`,
    context,
  );
  const plain = JSON.parse(JSON.stringify(result));
  const official = context.__twSections.features.find((feature) => {
    const coordinates = feature.geometry.coordinates;
    return (
      feature.properties.line_name === "阿里山線" &&
      coordinates[0][0] === 120.806072 &&
      coordinates[0][1] === 23.518996 &&
      coordinates.at(-1)[0] === 120.805009 &&
      coordinates.at(-1)[1] === 23.510618
    );
  });
  assert.ok(official, "the groomed 神木→阿里山 interval is missing");
  assert.equal(official.geometry.coordinates.length, 86);
  assert.equal(
    plain.uphillFeature.properties.route_choice,
    "official_interval_exact",
  );
  assert.equal(plain.uphillFeature.properties.preserve_ordered_geometry, true);
  assert.deepEqual(
    plain.uphillFeature.geometry.coordinates,
    official.geometry.coordinates,
  );
  assert.deepEqual(
    plain.downhillFeature.geometry.coordinates,
    [...official.geometry.coordinates].reverse(),
  );
  assert.deepEqual(plain.dedupedCoordinates, official.geometry.coordinates);
  assert.equal(
    plain.renderKeepIndices,
    null,
    "exact official intervals must bypass display simplification",
  );
});

test("every language-change listener runs without undefined identifiers", () => {
  const { context, i18nListeners } = loadAppFamily();
  // Keep the run timer-free: the stats job and export refresh are debounced
  // side effects that this test does not characterize.
  vm.runInContext(
    "mileageStatsTabActive = () => false; scheduleExportTextareaRefresh = () => {};",
    context,
  );
  vm.runInContext("bindEvents()", context);
  assert.ok(
    i18nListeners.length >= 1,
    "bindEvents() registered no I18N.onChange listener",
  );
  for (const listener of i18nListeners) listener("en");
});

test("date actions report in the visible train workspace", async () => {
  const { context } = loadAppFamily();
  const run = (code) => vm.runInContext(code, context);

  run('uiPrompt = async () => "not-a-date";');
  await run("addManualDate()");
  assert.equal(run("els.dateStatus.textContent"), "status.invalidDate");
  assert.equal(
    run("els.importStatus.textContent"),
    "",
    "date feedback must not leak into the hidden Data workspace",
  );

  run("manualDates = ['2026-08-04']; renderAll = () => {};");
  run("removeEmptyDates()");
  assert.equal(run("els.dateStatus.textContent"), "status.emptyDatesRemoved");
  assert.equal(run("els.importStatus.textContent"), "");
});

test("mobile peek reserves navigation plus an exposed handle", () => {
  const { context } = loadAppFamily();
  context.__mobileNav = {
    getBoundingClientRect: () => ({ height: 98 }),
  };
  const size = vm.runInContext(
    `(() => {
      window.innerHeight = 800;
      const querySelector = document.querySelector.bind(document);
      document.querySelector = (selector) =>
        selector === ".workspace-nav" ? __mobileNav : querySelector(selector);
      return sidebarPanelSizePx("peek");
    })()`,
    context,
  );
  assert.equal(size, 130);
});

test("recovery mode blocks autosave and pins the raw JSON for rescue", () => {
  const { context } = loadAppFamily();
  const run = (code) => vm.runInContext(code, context);
  run('enterStoreRecoveryMode({ message: "boom", rawText: "RAW-STORE-JSON" })');
  assert.equal(run("storeRecoveryMode"), true);
  assert.equal(run("els.json.value"), "RAW-STORE-JSON");
  run("saveTrainStore()");
  assert.equal(run("storeSaveDirty"), false, "recovery must block autosave");
  // Routine renders must not overwrite the pinned rescue JSON.
  run("scheduleExportTextareaRefresh()");
  assert.equal(run("els.json.value"), "RAW-STORE-JSON");
  run("exitStoreRecoveryMode()");
  assert.equal(run("storeRecoveryMode"), false);
  run("saveTrainStore()");
  assert.equal(run("storeSaveDirty"), true, "autosave must resume after exit");
  run("clearTimeout(serverStoreSaveTimer)"); // don't leave the debounce armed
  run("clearTimeout(pendingServerStoreJournalTimer)");
});

test("backend edits stage a recovery journal before the network debounce", async () => {
  const { context } = loadAppFamily();
  context.__journalBodies = [];
  vm.runInContext(
    `writePendingServerStoreSave = async (body) => {
       __journalBodies.push(body);
     };
     saveTrainStore();`,
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(context.__journalBodies.length, 1);
  assert.deepEqual(JSON.parse(context.__journalBodies[0]), {
    schema_version: "1.3",
    trains: [],
  });
  assert.equal(
    vm.runInContext("serverStoreSaveInFlight", context),
    false,
    "the 450ms network save must not have started yet",
  );
  vm.runInContext(
    `clearTimeout(serverStoreSaveTimer);
     clearTimeout(pendingServerStoreJournalTimer);
     pendingServerStoreText = null;`,
    context,
  );
});

test("unloadable saved store yields a recovery sentinel; 404 yields null", async () => {
  const { context } = loadAppFamily();

  // Saved store exists but fails validation -> recovery sentinel + raw text.
  const invalidText = '{"schema_version":"9.9","trains":[]}';
  context.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => invalidText,
  });
  let result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result && result.recovery, true);
  assert.equal(result.rawText, invalidText);
  assert.match(result.message, /schema_version/);

  // Corrupt JSON -> recovery sentinel too.
  context.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '{"schema_version":"1.3","trains":[',
  });
  result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result && result.recovery, true);

  // Nothing saved yet (404) -> null: writable defaults are safe.
  context.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found" });
  result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result, null);

  // Network failure -> recovery sentinel (we cannot know a store is absent).
  context.fetch = async () => {
    throw new Error("network down");
  };
  result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result && result.recovery, true);
});

test("pending backend autosave replays only against its exact server base", async () => {
  const canonicalStore = (id) => ({
    schema_version: "1.3",
    trains: [
      {
        id,
        date: "2026-07-24",
        number: id,
        origin: "A",
        destination: "B",
        stops: [
          {
            name: "A",
            stop_type: "origin",
            departure: "10:00",
            ride_segment: true,
          },
          {
            name: "B",
            stop_type: "destination",
            arrival: "11:00",
            ride_segment: true,
          },
        ],
      },
    ],
  });
  const baseStore = canonicalStore("base");
  const pendingStore = canonicalStore("pending");
  const baseText = JSON.stringify(baseStore);
  const pendingText = JSON.stringify(pendingStore);

  const replay = loadAppFamily();
  replay.context.__baseStore = baseStore;
  replay.context.__baseText = baseText;
  replay.context.__pendingText = pendingText;
  replay.context.__sentBodies = [];
  replay.context.__deletedPending = [];
  replay.context.fetch = async (_url, options) => {
    replay.context.__sentBodies.push(options.body);
    return { ok: true, status: 200, statusText: "OK" };
  };
  vm.runInContext(
    `lastKnownServerStoreExists = true;
     lastKnownServerStoreText = __baseText;
     readPendingServerStoreSaves = async () => [{
       client_id: "old-tab",
       body: __pendingText,
       base_body: __baseText,
       base_exists: true,
       updated_at: "2026-07-24T00:00:00.000Z",
     }];
     deletePendingServerStoreSave = async (id, body) => {
       __deletedPending.push([id, body]);
     };`,
    replay.context,
  );
  const replayed = await vm.runInContext(
    "recoverPendingServerStoreSaves(__baseStore)",
    replay.context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), pendingStore);
  assert.deepEqual(replay.context.__sentBodies, [pendingText]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay.context.__deletedPending)),
    [["old-tab", pendingText]],
  );

  const conflict = loadAppFamily();
  conflict.context.__baseStore = baseStore;
  conflict.context.__pendingText = pendingText;
  vm.runInContext(
    `lastKnownServerStoreExists = true;
     lastKnownServerStoreText = JSON.stringify({
       schema_version: "1.3",
       trains: [],
     });
     readPendingServerStoreSaves = async () => [{
       client_id: "old-tab",
       body: __pendingText,
       base_body: "different-old-base",
       base_exists: true,
       updated_at: "2026-07-24T00:00:00.000Z",
     }];`,
    conflict.context,
  );
  const conflicted = await vm.runInContext(
    "recoverPendingServerStoreSaves(__baseStore)",
    conflict.context,
  );
  assert.equal(conflicted.recovery, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(conflicted.pendingStore)),
    pendingStore,
  );
});

test("static user-store compare-before-write detects stale day records", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const original = { date: "2026-07-24", trains: [{ id: "a" }] };
      const changed = { date: "2026-07-24", trains: [{ id: "b" }] };
      const baseline = JSON.stringify(original);
      return {
        unchanged: userStoreChunkConflicts(baseline, original),
        changed: userStoreChunkConflicts(baseline, changed),
        concurrentlyCreated: userStoreChunkConflicts(undefined, changed),
        stillMissing: userStoreChunkConflicts(undefined, undefined),
      };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    unchanged: false,
    changed: true,
    concurrentlyCreated: true,
    stillMissing: false,
  });
});

test("two static tabs cannot overwrite the same IndexedDB day", async () => {
  const indexedDB = new IDBFactory();
  const first = loadAppFamily({ indexedDB });
  const second = loadAppFamily({ indexedDB });
  const store = (number) => ({
    schema_version: "1.3",
    trains: [
      {
        id: "shared-day",
        date: "2026-07-24",
        number,
        stops: [],
      },
    ],
  });

  first.context.__store = store("base");
  first.context.__nextStore = store("first-tab");
  second.context.__nextStore = store("second-tab");
  await vm.runInContext(
    `trainStore = __store;
     writeUserStoreChunks(__store, { force: true })`,
    first.context,
  );
  const secondLoaded = await vm.runInContext(
    "readUserStoreAll()",
    second.context,
  );
  assert.equal(secondLoaded.store.trains[0].number, "base");

  await vm.runInContext(
    `trainStore = __nextStore;
     writeUserStoreChunks(__nextStore)`,
    first.context,
  );
  await assert.rejects(
    vm.runInContext(
      `trainStore = __nextStore;
       writeUserStoreChunks(__nextStore)`,
      second.context,
    ),
    (error) =>
      error &&
      error.name === "UserStoreConflictError" &&
      error.dateKey === "2026-07-24",
  );

  const verify = loadAppFamily({ indexedDB });
  const stored = await vm.runInContext("readUserStoreAll()", verify.context);
  assert.equal(stored.store.trains[0].number, "first-tab");
});

test("station graph candidates keep the best snap for each graph node", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const distant = { properties: { id: "distant" } };
      const exact = { properties: { id: "exact" } };
      const original = getStationCandidateGraphNodes;
      getStationCandidateGraphNodes = (feature) => [{
        key: "shared-node",
        score: feature === distant ? 150 : 0,
        distance: feature === distant ? 150 : 0,
        stationFeature: feature,
      }];
      try {
        return collectStationCandidateGraphNodes(
          [distant, exact],
          {},
          {},
          ["4"],
        ).map((candidate) => candidate.stationFeature.properties.id);
      } finally {
        getStationCandidateGraphNodes = original;
      }
    })()`,
    context,
  );
  assert.deepEqual([...result], ["exact"]);
});

test("station snap cache distinguishes duplicate codes at different geometries", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const north = {
        properties: {
          N02_002: "4",
          N02_003: "白島線",
          N02_004: "広島電鉄",
          N02_005: "八丁堀",
          N02_005c: "008047",
        },
        geometry: { type: "LineString", coordinates: [[1, 1]] },
      };
      const south = {
        properties: { ...north.properties },
        geometry: { type: "LineString", coordinates: [[2, 2]] },
      };
      const meta = {
        institution_type_codes: new Set(["4"]),
        line_names: new Set(["白島線"]),
        operators: new Set(["広島電鉄"]),
      };
      const graph = {
        stationSnapCache: new Map(),
        nodeMeta: new Map([["north", meta], ["south", meta]]),
      };
      const hints = {
        preferredLines: new Set(),
        preferredOperators: new Set(),
        requiredLines: new Set(),
        requiredOperators: new Set(),
        requirePreferredInstitution: true,
      };
      const original = nearbyGraphNodes;
      nearbyGraphNodes = (coord) => [{
        key: coord[0] === 1 ? "north" : "south",
        distance: 0,
      }];
      try {
        const a = getStationCandidateGraphNodes(north, graph, hints, ["4"]);
        const b = getStationCandidateGraphNodes(south, graph, hints, ["4"]);
        return {
          first: a[0].key,
          second: b[0].key,
          cacheSize: graph.stationSnapCache.size,
        };
      } finally {
        nearbyGraphNodes = original;
      }
    })()`,
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    { first: "north", second: "south", cacheSize: 2 },
  );
});

test("route cache keys include the solver version", () => {
  const { context } = loadAppFamily();
  const key = vm.runInContext(
    `buildTrainRouteSolveContext({
      route_policy: { allowed_institution_type_codes: ["4"] },
      route_sections: [{
        from_n02_station_code: "008062",
        to_n02_station_code: "008058",
      }],
      stops: [
        { name: "胡町", n02_station_code: "008062", ride_segment: true },
        { name: "八丁堀", n02_station_code: "008058", ride_segment: true },
      ],
    }).cacheKey`,
    context,
  );
  assert.match(key, /^solver:17\|/);
});

test("precomputed sample geometry replaces stale warmed geometry", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const key = "solver:15|hiroden-test";
      runtimeRouteCache.set(key, [{ geometry: { coordinates: [[0, 0], [9, 9]] } }]);
      runtimeRouteNegativeCache.add(key);
      seedRouteCacheFromPart({ route: {
        cache_key: key,
        features: [{ geometry: { coordinates: [[0, 0], [1, 0]] } }],
      } });
      return {
        coordinates: runtimeRouteCache.get(key)[0].geometry.coordinates,
        negative: runtimeRouteNegativeCache.has(key),
      };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    coordinates: [[0, 0], [1, 0]],
    negative: false,
  });
});

test("out-and-back geometry keeps the later cross-day traversal", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const features = dedupeSameTrainRouteFeatures([
        {
          type: "Feature",
          properties: { segment_index: 0 },
          geometry: {
            type: "LineString",
            coordinates: [[139, 35], [140, 35]],
          },
        },
        {
          type: "Feature",
          properties: { segment_index: 1 },
          geometry: {
            type: "LineString",
            coordinates: [[140, 35], [139, 35]],
          },
        },
      ]);
      const breaks = trainDayBreaks({
        date: "2026-07-24",
        stops: [
          { name: "A", departure: "22:00" },
          { name: "B", arrival: "23:00", departure: "23:30" },
          { name: "A", arrival: "25:00" },
        ],
      });
      return {
        retained: features.map((feature) => feature.properties.segment_index),
        days: [0, 1].map((index) => dayIndexForSegment(breaks, index)),
      };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    retained: [0, 1],
    days: [0, 1],
  });
});

// A→D is ridden with B→C inside it, so listing both reports the same trip
// twice. The suppression only runs downward: the longer section wins when it
// is ridden at least as often, and a short section ridden MORE than the long
// one it sits inside keeps both rows.
test("最常乘坐區間 drops sections contained in a more-ridden one", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const row = (from, to, count, edgeIds, bucket) =>
        ({ from, to, count, km: edgeIds.length, bucket, edgeIds });
      const HSR = STAT_MASK_HSR, CONV = STAT_MASK_CONV;
      // Same track, long section ridden more -> the inner one goes.
      const absorbed = dropContainedSections([
        row("A", "D", 5, [1, 2, 3], CONV),
        row("B", "C", 3, [2], CONV),
      ]).map((r) => r.from + r.to);
      // Same track, inner section ridden more -> both stay.
      const kept = dropContainedSections([
        row("B", "C", 9, [2], CONV),
        row("A", "D", 4, [1, 2, 3], CONV),
      ]).map((r) => r.from + r.to);
      // Different mode: 新幹線 must never swallow a 在來線 section.
      const crossMode = dropContainedSections([
        row("A", "D", 5, [1, 2, 3], HSR),
        row("B", "C", 3, [2], CONV),
      ]).map((r) => r.from + r.to);
      // Overlapping but neither contained -> both stay.
      const overlap = dropContainedSections([
        row("A", "C", 5, [1, 2], CONV),
        row("B", "D", 4, [2, 3], CONV),
      ]).map((r) => r.from + r.to);
      return { absorbed, kept, crossMode, overlap };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    absorbed: ["AD"],
    kept: ["BC", "AD"],
    crossMode: ["AD", "BC"],
    overlap: ["AC", "BD"],
  });
});
