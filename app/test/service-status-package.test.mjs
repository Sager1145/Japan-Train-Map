import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, "..");
const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

const CODE_STATUS = {
  1: "service_suspended",
  2: "substitute_bus",
  3: "no_passenger_train",
  4: "all_trains_pass",
};

function packageFor(country) {
  return JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "public", "rail", `${country}-2025.json`), "utf8"),
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") cell += character;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows[0];
  return rows
    .slice(1)
    .filter((values) => values.length >= header.length)
    .map((values) => Object.fromEntries(header.map((key, at) => [key, values[at]])));
}

test("service spans index real, ordered, non-overlapping station pairs", () => {
  const pkg = packageFor("jp");
  let lines = 0;
  let spans = 0;
  for (const line of pkg.lines) {
    if (!line.serviceSpans) continue;
    lines += 1;
    assert.ok(Array.isArray(line.serviceSpans) && line.serviceSpans.length);
    let previousEnd = -1;
    for (const span of line.serviceSpans) {
      spans += 1;
      assert.equal(span.length, 3, `${line.id}: a span is [first, last, code]`);
      const [first, last, code] = span;
      for (const value of span)
        assert.ok(Number.isInteger(value), `${line.id}: ${value} is not an integer`);
      // Station ORDINALS, in bounds, in order, and naming at least one interval.
      assert.ok(first >= 0, `${line.id}: span starts before the line`);
      assert.ok(
        last < line.stations.length,
        `${line.id}: span ends past station ${line.stations.length - 1}`,
      );
      assert.ok(last > first, `${line.id}: span ${first}–${last} names no interval`);
      assert.ok(CODE_STATUS[code], `${line.id}: unknown status code ${code}`);
      // Sorted and disjoint: two spans may touch at a station but never share
      // an interval, or the line's status over it would be ambiguous.
      assert.ok(
        first >= previousEnd,
        `${line.id}: span ${first}–${last} overlaps the one before it`,
      );
      previousEnd = last;
    }
    // The string and the spans are one fact stated twice and may never
    // disagree: bare when the whole line is out of service under one status,
    // `partial_` otherwise.
    const statuses = new Set(line.serviceSpans.map((span) => CODE_STATUS[span[2]]));
    const covered = line.serviceSpans.reduce(
      (sum, span) => sum + (span[1] - span[0]),
      0,
    );
    const whole = covered === line.stations.length - 1 && statuses.size === 1;
    const gravest = CODE_STATUS[Math.min(...line.serviceSpans.map((span) => span[2]))];
    assert.equal(
      line.serviceStatus,
      whole ? gravest : `partial_${gravest}`,
      `${line.id}: serviceStatus disagrees with its spans`,
    );
  }
  // Never a `serviceStatus` without the spans that justify it: the string
  // alone is what the pre-2026-08-19 package carried, and it is exactly what a
  // renderer cannot draw from.
  for (const line of pkg.lines)
    if (line.serviceStatus)
      assert.ok(line.serviceSpans, `${line.id}: serviceStatus with no spans`);
  assert.equal(lines, 8);
  assert.equal(spans, 9);
});

test("service spans restate the inventory's own edge column, line for line", () => {
  // The CSV is the single authority; the package is a derivation of it. This
  // re-derives independently of lib/service_status.py and compares.
  const pkg = packageFor("jp");
  const rows = parseCsv(
    fs
      .readFileSync(
        path.join(
          APP_DIR,
          "data/raw/railway/jp/rebuild-inventory/stations/n02-station-connections.csv",
        ),
        "utf8",
      )
      .replace(/^﻿/, ""),
  );
  const aliases = { 東京地下鉄: "東京メトロ", 大阪市高速電気軌道: "Osaka Metro" };
  const marked = new Map();
  for (const row of rows) {
    const status = (row.network_status || "active").trim();
    if (!status || status === "active") continue;
    const operator = aliases[row.from_operator] || row.from_operator;
    marked.set(
      `${operator}␟${row.line}␟${[row.from_station_group, row.to_station_group].sort().join("-")}`,
      status,
    );
  }
  const seen = new Set();
  for (const line of pkg.lines) {
    const groups = line.stations.map((station) => station[0]);
    for (const [first, last, code] of line.serviceSpans || [])
      for (let index = first; index < last; index += 1) {
        const key = `${line.operator}␟${line.name}␟${[groups[index], groups[index + 1]].sort().join("-")}`;
        assert.equal(
          marked.get(key),
          CODE_STATUS[code],
          `${line.id} ${groups[index]}–${groups[index + 1]} is not marked ${CODE_STATUS[code]} in the inventory`,
        );
        seen.add(key);
      }
  }
  // …and nothing the inventory marks is missing from the package. 肥薩線's
  // 人吉↔矢岳 and 矢岳↔吉松 are the graph's record of the 大畑 and 真幸
  // reversals: they skip a station and are redundant with the adjacent edges
  // that already sit inside the span, so they are allowed to be unseated.
  const SKIP_EDGES = new Set([
    "九州旅客鉄道␟肥薩線␟009915-009928",
    "九州旅客鉄道␟肥薩線␟009928-009944",
  ]);
  for (const key of marked.keys())
    if (!seen.has(key))
      assert.ok(SKIP_EDGES.has(key), `${key} is marked but in no package span`);
});

test("the builder's own input carries the same statuses the CSV does", () => {
  // The inventory keeps the 19,256 connection rows twice: the CSV for people,
  // and n02-station-network.json for build-japan-package-from-inventory.py,
  // which reads `network["connections"]` and nothing else. A correction
  // applied to only one of them looks right in review and is silently undone
  // by the next full rebuild — which is exactly what happened to 美祢線 and
  // 日田彦山線 mid-batch, so it is asserted here rather than remembered.
  const csv = parseCsv(
    fs
      .readFileSync(
        path.join(
          APP_DIR,
          "data/raw/railway/jp/rebuild-inventory/stations/n02-station-connections.csv",
        ),
        "utf8",
      )
      .replace(/^﻿/, ""),
  );
  const json = JSON.parse(
    fs.readFileSync(
      path.join(
        APP_DIR,
        "data/raw/railway/jp/rebuild-inventory/stations/n02-station-network.json",
      ),
      "utf8",
    ),
  ).connections;
  assert.equal(json.length, csv.length);
  const statusOf = (rows) => {
    const out = new Map();
    for (const row of rows) {
      const status = (row.network_status || "active").trim();
      if (!status || status === "active") continue;
      out.set(
        `${row.connection_uid}␟${row.from_station_name}→${row.to_station_name}`,
        [status, row.record_origin, row.change_source_url].join("␟"),
      );
    }
    return out;
  };
  const fromCsv = statusOf(csv);
  const fromJson = statusOf(json);
  assert.deepEqual(
    [...fromJson.entries()].sort(),
    [...fromCsv.entries()].sort(),
    "n02-station-network.json and n02-station-connections.csv disagree",
  );
  // 138 directed rows = 69 undirected edges over eight lines: the 2026-08-13
  // audit's 49 edges, plus 美祢線's 11 and 日田彦山線's 9 from 2026-08-19.
  assert.equal(fromCsv.size, 138);
});

test("service spans are a Japan-only field and never leak into another country", () => {
  for (const country of COUNTRIES.filter((name) => name !== "jp"))
    for (const line of packageFor(country).lines) {
      assert.equal(line.serviceSpans, undefined, `${country} ${line.id}`);
      assert.equal(line.serviceStatus, undefined, `${country} ${line.id}`);
    }
});
