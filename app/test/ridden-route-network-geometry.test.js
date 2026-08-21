"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RailNetwork = require("../public/rail-network.js");

const PUBLIC_RAIL = path.join(__dirname, "../public/rail");
const DATA = path.join(__dirname, "../data");

function sampleDirectories(country) {
  if (country !== "jp") return [path.join(DATA, `sample-data-${country}`)];
  return [
    path.join(DATA, "sample-data"),
    path.join(DATA, "new-year-grand-loop-data"),
    path.join(DATA, "tokyo-limited-express-loop-data"),
  ];
}

function geometryLines(geometry) {
  return geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

for (const country of ["jp", "tw", "hk", "mo"]) {
  test(`every ${country} ridden sample uses complete-network geometry`, () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PUBLIC_RAIL, `${country}-2025.json`), "utf8"),
    );
    const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
    let sourceFeatureCount = 0;
    let unsliceable = 0;

    for (const directory of sampleDirectories(country)) {
      const partFiles = fs
        .readdirSync(directory)
        .filter((name) => /^part-.*\.json$/.test(name))
        .sort();
      for (const partFile of partFiles) {
        const part = JSON.parse(
          fs.readFileSync(path.join(directory, partFile), "utf8"),
        );
        for (const feature of part.route?.features || []) {
          sourceFeatureCount += 1;
          const rendered = RailNetwork.canonicalizeRouteFeature(network, feature);
          const label = `${country}/${path.basename(directory)}/${partFile}`;
          if (!rendered) {
            // A hop whose two stations only connect through a branch has no
            // continuous slice on any single display stroke; app-route-features
            // keeps the solver path there rather than drawing the wrong
            // railway. Rare by construction — pinned below.
            unsliceable += 1;
            continue;
          }
          assert.equal(
            rendered.properties.display_geometry_source,
            "all-railways-complete-line",
          );
          assert.ok(rendered.properties.display_line_ids.length > 0);

          const displayVertices = new Set();
          for (const lineId of rendered.properties.display_line_ids) {
            const displayLine = network.lineById.get(lineId);
            assert.ok(
              displayLine,
              `${lineId} must exist in the complete network`,
            );
            // A line that carries branches renders as several disjoint parts.
            for (const part of geometryLines(displayLine.geometry))
              for (const coordinate of part)
                displayVertices.add(`${coordinate[0]},${coordinate[1]}`);
          }
          for (const coordinates of geometryLines(rendered.geometry)) {
            assert.ok(coordinates.length >= 2);
            // Endpoints may be interpolated projections inside a canonical edge;
            // every interior point must be a literal vertex of the complete line.
            for (const coordinate of coordinates.slice(1, -1))
              assert.ok(
                displayVertices.has(`${coordinate[0]},${coordinate[1]}`),
                `${label} emitted a non-network interior vertex`,
              );
          }
        }
      }
    }
    assert.ok(sourceFeatureCount > 0, `${country} sample must contain routes`);
    assert.ok(
      unsliceable <= Math.ceil(sourceFeatureCount * 0.005),
      `${country}: ${unsliceable}/${sourceFeatureCount} hops fell back to the solver path`,
    );
  });
}

// Drawn hops reach their platforms along the rail, not by a chord swung off it.
//
// canonicalizeRouteFeature ends a hop at the PROJECTION of the solver's
// platform point onto the display line, then snapEndpoint overwrites that last
// vertex with the platform point itself. Where both name the same platform the
// move is metres and invisible; where the display line is a different track
// from the one the train used, the same line of code draws a right-angle jog
// into the station. validate-route-station-approach.mjs measures the sideways
// distance that jog covers; this pins how many are left, so a data or renderer
// change cannot quietly add one.
//
// The seven in jp are three known faults, all of them the drawn line being on
// track the train did not use:
//   大崎 → 西大井 (×2)   no display line reaches both — the 大崎支線 through
//                        the 蛇窪信号場 is not drawn, so the hop keeps the
//                        solver's own path and its 502 m station approach
//   新改 (×2)            a switchback station whose spur N02 never surveyed:
//                        the package draws one straight 137 m edge from the
//                        main line to the platform, the same gap 阿里山線's
//                        reversal tails had before OSM filled them in
//   東京 area (×3)       成田エクスプレス and 踊り子 stop rows list 有楽町 and
//                        浜松町, which have no platform on the 東京トンネル the
//                        train runs through, and 品川's package anchor and the
//                        solver's platform pick differ by 48 m
//
// 岸里玉出 was the fourth until 2026-08-21. N02 filed the 高野線's 1・2番線
// under 南海本線 as well, and the walk in from 天下茶屋 is 60 m shorter down
// that side, so a 南海本線 ride ended on the 高野線's island 178 m away. The
// mis-filed row is gone from stations.json and a route_section that names its
// line no longer expands its endpoints onto another line's platforms, so both
// hops now arrive along the rail they are drawn on.
test("no ridden hop reaches its platform by a chord off the rail", async () => {
  const { auditCountry, COUNTRIES } = await import(
    "../scripts/validation/validate-route-station-approach.mjs"
  );
  const budget = { jp: 7, tw: 0, hk: 0, mo: 0, kr: 0 };
  for (const country of COUNTRIES) {
    const report = auditCountry(country);
    if (!report) continue;
    const errors = report.findings.filter((row) => row.severity === "ERROR");
    assert.ok(
      errors.length <= budget[country],
      `${country} grew to ${errors.length} route-approach errors (budget ${budget[country]}):\n` +
        errors.map((row) => `  ${row.train} #${row.segment} ${row.detail}`).join("\n"),
    );
  }
});
