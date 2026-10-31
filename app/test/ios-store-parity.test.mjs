import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  evaluateAppScripts,
  makeSandbox,
} from "../scripts/lib/app-family-sandbox.mjs";

function loadAppFamily() {
  const context = makeSandbox({ userAgent: "ios-store-parity-test" });
  evaluateAppScripts(context);
  return context;
}

function iosTrain(overrides = {}) {
  return {
    id: "20260930_rapid_101",
    date: "2026-09-30",
    number: "快速101号",
    number_en: "Rapid 101",
    train_type: "快速",
    vehicle_type: "E233系",
    company: "JR東日本",
    origin: "東京",
    destination: "横浜",
    direction: "down",
    visible: true,
    region: "jp",
    style: { color: "#1d7f8c" },
    route_sections: [
      {
        from: "東京",
        to: "横浜",
        from_n02_station_code: "003770",
        to_n02_station_code: "004634",
        line_names: ["東海道線"],
        operator_names: ["JR東日本"],
      },
    ],
    stops: [
      {
        name: "東京",
        n02_station_code: "003770",
        platform_number: 10,
        arrival: null,
        actual_arrival: "08:58",
        departure: "09:00",
        actual_departure: "09:02",
        stop_type: "origin",
        ride_segment: true,
      },
      {
        name: "横浜",
        n02_station_code: "004634",
        platform_number: null,
        arrival: "09:28",
        actual_arrival: "09:31",
        departure: null,
        stop_type: "destination",
        ride_segment: true,
      },
    ],
    ...overrides,
  };
}

function normalizeValidateExport(context, train) {
  context.__iosTrain = train;
  return JSON.parse(
    JSON.stringify(
      vm.runInContext(
        `(() => {
          const normalized = normalizeImportedTrain(__iosTrain);
          validateTrainStore({ schema_version: SCHEMA_VERSION, trains: [normalized] });
          return {
            normalized,
            exported: normalizeExportTrain(normalized),
          };
        })()`,
        context,
      ),
    ),
  );
}

test("iOS train and observed-time fields survive canonical web round trip", () => {
  const context = loadAppFamily();
  const { normalized, exported } = normalizeValidateExport(context, iosTrain());

  for (const train of [normalized, exported]) {
    assert.equal(train.region, "jp");
    assert.equal(train.number_en, "Rapid 101");
    assert.equal(train.vehicle_type, "E233系");
    assert.equal(train.stops[0].actual_arrival, "08:58");
    assert.equal(train.stops[0].actual_departure, "09:02");
    assert.equal(train.stops[1].actual_arrival, "09:31");
    assert.equal("actual_departure" in train.stops[1], false);
  }
});

test("canonical export omits absent iOS optional fields", () => {
  const context = loadAppFamily();
  const train = iosTrain();
  delete train.region;
  delete train.number_en;
  delete train.vehicle_type;
  for (const stop of train.stops) {
    delete stop.actual_arrival;
    delete stop.actual_departure;
  }

  const { exported } = normalizeValidateExport(context, train);
  assert.equal("region" in exported, false);
  assert.equal("number_en" in exported, false);
  assert.equal("vehicle_type" in exported, false);
  for (const stop of exported.stops) {
    assert.equal("actual_arrival" in stop, false);
    assert.equal("actual_departure" in stop, false);
  }
});

test("iOS parity fields retain strict type, region, and key validation", () => {
  const context = loadAppFamily();

  assert.throws(
    () => normalizeValidateExport(context, iosTrain({ number_en: 101 })),
    /number_en must be a string when present/,
  );
  assert.throws(
    () => normalizeValidateExport(context, iosTrain({ vehicle_type: false })),
    /vehicle_type must be a string when present/,
  );
  assert.throws(
    () => normalizeValidateExport(context, iosTrain({ region: "xx" })),
    /region must be one of jp \/ tw \/ hk \/ mo \/ kr \/ us \/ ca/,
  );

  const invalidTime = iosTrain();
  invalidTime.stops[0].actual_arrival = 858;
  assert.throws(
    () => normalizeValidateExport(context, invalidTime),
    /actual_arrival must be a string or null/,
  );

  assert.throws(
    () => normalizeValidateExport(context, iosTrain({ unsupported_ios_field: true })),
    /Train contains unsupported field: unsupported_ios_field/,
  );

  const unknownStop = iosTrain();
  unknownStop.stops[0].unsupported_ios_field = true;
  assert.throws(
    () => normalizeValidateExport(context, unknownStop),
    /Stop contains unsupported field: unsupported_ios_field/,
  );
});
