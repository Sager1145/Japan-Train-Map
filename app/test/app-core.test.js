"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const AppCore = require("../public/app-core.js");

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
