// Characterization/parity test for the compact rail-package loader.
//
// The committed compact package is always checked against a deterministic
// render-model hash. When a one-off legacy backup exists, the historical
// old-loader comparison also runs; the backup is optional and untracked.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_RENDER_HASH,
  renderRelevantSnapshot,
} from "../scripts/railway/lib/render-snapshot.mjs";

const require = createRequire(import.meta.url);
const RailNetwork = require("../public/rail-network.js");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RAIL_PACKAGE_PATH = path.join(
  SCRIPT_DIR,
  "../public/rail/jp-2025.json",
);
const LEGACY_PACKAGE_PATH = `${RAIL_PACKAGE_PATH}.legacy.bak`;

function oldLoad(pkg) {
  const lineById = new Map();
  const colorByLine = new Map();
  const lineMinZoomByLine = new Map();
  for (const line of pkg.lines) {
    lineById.set(line.lineId, line);
    colorByLine.set(
      line.lineId,
      line.color || RailNetwork.DEFAULT_LINE_COLOR,
    );
    lineMinZoomByLine.set(
      line.lineId,
      RailNetwork.minZoomForRank(line.rank),
    );
  }

  const segmentFeatures = pkg.segments.map((segment) => ({
    type: "Feature",
    geometry: segment.geometry,
    properties: {
      segmentId: segment.segmentId,
      lineId: segment.lineId,
      color:
        colorByLine.get(segment.lineId) || RailNetwork.DEFAULT_LINE_COLOR,
      minz: lineMinZoomByLine.get(segment.lineId) || 0,
    },
  }));

  const kmByLine = new Map();
  for (const segment of pkg.segments) {
    kmByLine.set(
      segment.lineId,
      (kmByLine.get(segment.lineId) || 0) + segment.km,
    );
  }

  const dotMinZoomByLine = new Map();
  const terminiByLine = new Map();
  for (const line of pkg.lines) {
    const lineMinZoom = lineMinZoomByLine.get(line.lineId) || 0;
    const stationCount = (line.stationOrder || []).length;
    dotMinZoomByLine.set(
      line.lineId,
      RailNetwork.stationMinZoomForLine(
        lineMinZoom,
        kmByLine.get(line.lineId) || 0,
        stationCount,
      ),
    );
    if (!line.isLoop && stationCount >= 2) {
      terminiByLine.set(
        line.lineId,
        new Set([
          line.stationOrder[0],
          line.stationOrder[stationCount - 1],
        ]),
      );
    }
  }

  const stationById = new Map();
  const groupMembers = new Map();
  const stationFeatures = pkg.stations.map((station) => {
    stationById.set(station.stationId, station);
    const groupKey =
      station.stationGroupId || `solo:${station.stationId}`;
    let members = groupMembers.get(groupKey);
    if (!members) {
      members = [];
      groupMembers.set(groupKey, members);
    }
    members.push(station);

    const termini = terminiByLine.get(station.lineId);
    const minZoom =
      termini && termini.has(station.stationId)
        ? lineMinZoomByLine.get(station.lineId) || 0
        : dotMinZoomByLine.get(station.lineId) || 0;
    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [station.lon, station.lat],
      },
      properties: {
        stationId: station.stationId,
        lineId: station.lineId,
        name: station.name,
        nameRoma: station.nameRoma || "",
        stationGroupId: station.stationGroupId || "",
        minz: minZoom,
      },
    };
  });

  return {
    version: pkg.version,
    segments: {
      type: "FeatureCollection",
      features: segmentFeatures,
    },
    stations: {
      type: "FeatureCollection",
      features: stationFeatures,
    },
    lineById,
    stationById,
    groupMembers,
  };
}

const compactPackage = JSON.parse(
  fs.readFileSync(RAIL_PACKAGE_PATH, "utf8"),
);
const currentNetwork =
  RailNetwork.buildNetworkFromCompactPackage(compactPackage);
assert.ok(currentNetwork, "compact loader returned null");

const digest = crypto
  .createHash("sha256")
  .update(JSON.stringify(renderRelevantSnapshot(currentNetwork)))
  .digest("hex");
assert.equal(digest, EXPECTED_RENDER_HASH, "render-model snapshot changed");
console.log(
  `SNAPSHOT OK — ${currentNetwork.segments.features.length} segments, ` +
    `${currentNetwork.stations.features.length} stations, ` +
    `${currentNetwork.lineById.size} lines`,
);

if (fs.existsSync(LEGACY_PACKAGE_PATH)) {
  const legacyNetwork = oldLoad(
    JSON.parse(fs.readFileSync(LEGACY_PACKAGE_PATH, "utf8")),
  );
  assert.deepEqual(
    renderRelevantSnapshot(currentNetwork),
    renderRelevantSnapshot(legacyNetwork),
  );
  console.log("LEGACY PARITY OK — all render/popup outputs identical");
} else {
  console.log(
    "Legacy fixture absent; deterministic snapshot coverage used instead.",
  );
}
