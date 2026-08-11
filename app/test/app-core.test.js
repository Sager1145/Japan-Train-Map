"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const AppCore = require("../shared/app-core.js");

test("date normalization preserves the documented shallow calendar validation", () => {
  assert.equal(AppCore.isValidDateString("2026-07-03"), true);
  assert.equal(AppCore.isValidDateString("2026-02-31"), true);
  assert.equal(AppCore.isValidDateString("2026-13-01"), false);
  assert.equal(AppCore.normalizeDateString(" 2026/07/03 "), "2026-07-03");
  assert.equal(AppCore.normalizeDateString("2026-7-3"), null);
  assert.equal(
    AppCore.inferDateFromTrainId("trip_20260703_haruka"),
    "2026-07-03",
  );
});

test("train dates keep explicit, fallback, inferred, then undated precedence", () => {
  assert.equal(
    AppCore.normalizeTrainDate(
      { id: "20260703_a", date: "2026-07-04" },
      "2026-07-05",
    ),
    "2026-07-04",
  );
  assert.equal(
    AppCore.normalizeTrainDate({ id: "20260703_a" }, "2026-07-05"),
    "2026-07-05",
  );
  assert.equal(
    AppCore.normalizeTrainDate({ id: "20260703_a" }),
    "2026-07-03",
  );
  assert.equal(AppCore.normalizeTrainDate({ id: "train" }), "undated");
});

test("time parsing and departure selection retain current permissive semantics", () => {
  assert.equal(AppCore.parseTimeToMinutes("01:02 + 1"), 1502);
  assert.equal(AppCore.parseTimeToMinutes("25:99 trailing text"), 1599);
  assert.equal(AppCore.parseTimeToMinutes("not-a-time"), null);
  assert.equal(
    AppCore.getTrainDepartureMinutes({
      stops: [
        { departure: null },
        { stop_type: "origin", departure: "08:15" },
        { departure: "07:30" },
      ],
    }),
    495,
  );
});

test("train sorting is date, departure, then id with undated last", () => {
  const trains = [
    { id: "b", date: "undated", stops: [] },
    { id: "c", date: "2026-07-03", stops: [{ departure: "09:00" }] },
    { id: "a", date: "2026-07-03", stops: [{ departure: "08:00" }] },
    { id: "d", date: "2026-07-04", stops: [{ departure: "07:00" }] },
  ];
  assert.deepEqual(
    trains.sort(AppCore.compareTrainsByDateAndDeparture).map((train) => train.id),
    ["a", "c", "d", "b"],
  );
});

test("canonical scalar helpers preserve null and id behavior", () => {
  assert.equal(AppCore.normalizeNullableTime(undefined), null);
  assert.equal(AppCore.normalizeNullableTime(""), null);
  assert.equal(AppCore.normalizeNullableTime("00:00"), "00:00");
  assert.equal(
    AppCore.makeUniqueTrainId(" train ", new Set(["train", "train-2"])),
    "train-3",
  );
});

test("chunked FeatureCollection parsing preserves features and drops unused metadata", async () => {
  const source = JSON.stringify({
    type: "FeatureCollection",
    name: "ignored",
    crs: { name: "ignored" },
    features: [
      {
        type: "Feature",
        properties: { text: 'brace } and quote "' },
        geometry: null,
      },
      {
        type: "Feature",
        properties: { nested: { value: 2 } },
        geometry: null,
      },
    ],
  });
  assert.deepEqual(await AppCore.parseFeatureCollectionChunked(source), {
    type: "FeatureCollection",
    features: JSON.parse(source).features,
  });
});

test("chunked parser yields on large collections and falls back for other JSON", async () => {
  const source = JSON.stringify({
    type: "FeatureCollection",
    features: Array.from({ length: 256 }, (_, index) => ({
      type: "Feature",
      properties: { index },
      geometry: null,
    })),
  });
  let now = 0;
  let yields = 0;
  const parsed = await AppCore.parseFeatureCollectionChunked(source, {
    now: () => {
      now += 10;
      return now;
    },
    yieldControl: async () => {
      yields += 1;
    },
  });
  assert.equal(parsed.features.length, 256);
  assert.equal(yields, 1);

  const plain = { ok: true, values: [1, 2, 3] };
  assert.deepEqual(
    await AppCore.parseFeatureCollectionChunked(JSON.stringify(plain)),
    plain,
  );
});

test("cross-day breaks land on the last station timed before midnight", () => {
  // jsonspec §10.5: 25:xx is the next day, untimed pass-throughs inherit the
  // previous timed stop's day, so the break falls on 姫路 — the last station
  // whose recorded time is still before 24:00.
  const sunrise = {
    id: "20260726_sunrise",
    date: "2026-07-26",
    stops: [
      { name: "高松", departure: "21:26" },
      { name: "児島", arrival: "22:12", departure: "22:14" },
      { name: "岡山", arrival: "22:34", departure: "22:40" },
      { name: "姫路", arrival: "23:34", departure: "23:36" },
      { name: "西明石", arrival: null, departure: null },
      { name: "三ノ宮", arrival: "25:11", departure: "25:12" },
      { name: "東京", arrival: "31:08" },
    ],
  };
  assert.equal(AppCore.trainHasCrossDayTimes(sunrise), true);
  assert.deepEqual(AppCore.trainDayBreaks(sunrise), [{ index: 3, day: 1 }]);

  const breaks = AppCore.trainDayBreaks(sunrise);
  // The break station closes the outgoing day and opens the next one, so ONE
  // symbol serves both directions.
  assert.equal(AppCore.dayIndexForStop(breaks, 3), 0);
  assert.equal(AppCore.dayIndexForStop(breaks, 4), 1);
  // …while the segment LEAVING it is already next-day (that is the dashed one).
  assert.equal(AppCore.dayIndexForSegment(breaks, 2), 0);
  assert.equal(AppCore.dayIndexForSegment(breaks, 3), 1);
});

test("only the documented cross-day notations count as cross-day", () => {
  const wrapped = {
    stops: [{ departure: "23:50" }, { arrival: "00:10" }],
  };
  // A bare wrap is NOT read as next-day (jsonspec §10.1) — no guessing.
  assert.equal(AppCore.trainHasCrossDayTimes(wrapped), false);
  assert.deepEqual(AppCore.trainDayBreaks(wrapped), []);

  // The legacy "+N" suffix still parses.
  assert.deepEqual(
    AppCore.trainDayBreaks({
      stops: [{ departure: "23:50" }, { arrival: "00:10+1" }],
    }),
    [{ index: 0, day: 1 }],
  );

  // Ordinary same-day trains never allocate breaks.
  assert.deepEqual(
    AppCore.trainDayBreaks({
      stops: [{ departure: "09:00" }, { arrival: "10:30" }],
    }),
    [],
  );

  // A train whose FIRST timed stop already reads 25:xx is mis-dated, not
  // cross-day: there is no earlier station to break away from.
  assert.deepEqual(
    AppCore.trainDayBreaks({ stops: [{ departure: "25:00" }, { arrival: "26:00" }] }),
    [],
  );
});

test("date arithmetic rolls month ends without touching the local timezone", () => {
  assert.equal(AppCore.addDaysToDateString("2026-07-26", 1), "2026-07-27");
  assert.equal(AppCore.addDaysToDateString("2026-07-31", 1), "2026-08-01");
  assert.equal(AppCore.addDaysToDateString("2026-12-31", 2), "2027-01-02");
  assert.equal(AppCore.addDaysToDateString("2026-07-26", 0), "2026-07-26");
  assert.equal(AppCore.addDaysToDateString("undated", 1), null);
});
