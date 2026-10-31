import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { evaluateAppScripts, makeSandbox } from "../scripts/lib/app-family-sandbox.mjs";
const context = makeSandbox(); evaluateAppScripts(context);
const run = (source) => vm.runInContext(source, context);
const draft = (text, ridden = false) => {
  context.raw = text; context.ridden = ridden;
  return run('transferGuideDraftTrains(parseTransferGuideText(raw), { date: "2026-09-30", ridden })');
};
test("transfer calls keep endpoint platforms, equipment and independent arrival/departure", () => {
  const trains = draft(`10:45→00:09 (13時間24分) 8月28日(金)
IC優先 47,280円 乗換2回 2338.2km
10:45 発 札幌
4駅 ＪＲ特急北斗８号 24,640円
当駅始発 函館行 指定席
発 8番線
着 2番線
10:54 新札幌
14:18着
新函館北斗 iii
14:39発
3駅 ＪＲ新幹線はやぶさ２８号(E5系)
発 11番線
着 21番線
19:04着 19:12発 東京
JR新幹線のぞみ57号(N700A)
23:54 小倉(福岡県) iii
00:09 着 博多
CO2排出量 40kg`);
  assert.equal(trains.length, 3);
  assert.equal(trains[0].number, "JR特急北斗8号");
  assert.equal(trains[1].vehicle_type, "E5系");
  assert.equal(trains[0].stops[0].platform_number, 8);
  assert.equal(trains[0].stops.at(-1).platform_number, 2);
  assert.equal(trains[1].stops[0].platform_number, 11);
  assert.equal(trains[1].stops.at(-1).platform_number, 21);
  assert.equal(trains[0].stops.at(-1).arrival, "14:18");
  assert.equal(trains[0].stops.at(-1).departure, null);
  assert.equal(trains[1].stops[0].departure, "14:39");
  assert.equal(trains[1].stops[0].arrival, null);
  assert.equal(trains[2].stops.at(-1).arrival, "24:09");
  assert.equal(trains[2].stops.at(-2).name, "小倉(福岡県)");
  assert.equal(trains.flatMap(t => t.stops).some(s => s.ride_segment), false);
});
test("midnight carries across transfers; small backward errors require review", () => {
  const trains = draft("23:50発 A\nJR線\n00:10着 00:20発 B\n新幹線\n00:40着 C", true);
  assert.equal(trains[0].stops.at(-1).arrival, "24:10");
  assert.equal(trains[1].stops[0].departure, "24:20");
  assert.equal(trains[1].stops.at(-1).arrival, "24:40");
  context.trains = draft("09:00発 A\nJR線\n08:50着 B");
  run('resolveGuideStop = (stop) => new Map([[stop.n02_station_code, {}]])');
  assert.equal(context.trains[0].stops.at(-1).arrival, "08:50");
  assert.equal(run("guideDraftProblems({trains, included: [true]}).invalidTimes"), 1);
});
test("walking is excluded and through-running lines remain one ride", () => {
  const trains = draft("09:00発 東京\nJR京浜東北線\n09:02着 神田\n徒歩5分\n09:10発 小川町\n都営新宿線\n09:30着 九段下");
  assert.equal(trains.length, 2);
  assert.equal(trains[1].stops[0].name, "小川町");
  assert.equal(draft("07:20発 上野\nJR上野東京ライン\n直通 熱海行\nJR高崎線 直通 15両\n07:52 大宮\n09:16着 高崎").length, 1);
});
test("station names before times parse; missing calls are never filled", () => {
  const trains = draft("東京\n09:00\nJR山手線\n09:30\n池袋");
  assert.equal(trains[0].stops.length, 2);
  assert.equal(trains[0].stops[0].name, "東京");
  assert.equal(draft("東京\nJR山手線\n池袋").length, 0);
});
test("unresolved identities and invalid times gate selected draft rows", () => {
  run(`resolveGuideStop = () => new Map([["known", {}]]);
    draft = {included: [true, false], trains: [
      {stops: [{n02_station_code: null, departure: "09:61"}, {n02_station_code: "known", arrival: "10:00"}]},
      {stops: [{n02_station_code: null, departure: "bad"}]}
    ]}`);
  assert.equal(run("guideDraftProblems(draft).unresolved"), 1);
  assert.equal(run("guideDraftProblems(draft).invalidTimes"), 1);
  run('draft.trains[0].stops[0] = {n02_station_code: "known", departure: "09:00"}');
  assert.equal(run("guideDraftProblems(draft).unresolved"), 0);
  assert.equal(run("guideDraftProblems(draft).invalidTimes"), 0);
});
test("OCR joins columns on the same visual row in left-to-right order", () => {
  const word = (text, x0, y0) => ({text, bbox: {x0, x1:x0+30, y0, y1:y0+20}});
  context.data = {blocks:[{paragraphs:[{lines:[{words:[word("東京",100,2),word("09:00",0,0)]},{words:[word("JR山手線",100,36)]}]}]}]};
  const rows = run("guideOcrRows(data)");
  assert.equal(rows[0].text, "09:00 東京");
  assert.equal(rows[1].text, "JR山手線");
});
test("invalid append input cannot reset the sample store", async () => {
  run('trainStore = {trains:[{id:"original"}]}; dataSourceMode = "sample"; uiConfirm = async () => {throw new Error("must not ask")};');
  await assert.rejects(run('appendJsonFromUi(JSON.stringify({schema_version:"1.3", trains:[{id:"invalid"}]}))'));
  assert.equal(run('trainStore.trains[0].id'), "original");
  assert.equal(run('dataSourceMode'), "sample");
});


test("OCR page overlap removes only a matching multi-row suffix/prefix", () => {
  context.pages = ["09:00 東京\nJR山手線\n09:20 上野", "JR 山手線\n09:20 上野\nJR高崎線\n10:00 大宮"];
  assert.equal(run("stitchGuidePages(pages)"), "09:00 東京\nJR山手線\n09:20 上野\nJR高崎線\n10:00 大宮");
  context.pages = ["09:00 東京", "09:00 東京\nJR山手線"];
  assert.equal(run("stitchGuidePages(pages)"), "09:00 東京\n09:00 東京\nJR山手線");
});
