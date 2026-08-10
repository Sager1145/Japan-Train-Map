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
          assert.ok(rendered, `${label} must match a display line`);
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
            for (const coordinate of displayLine.geometry.coordinates)
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
  });
}
