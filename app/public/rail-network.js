(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.RailNetwork = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_LINE_COLOR = "#7C8A82";
  const RANK_MINZOOM = [3, 4, 5, 6, 7];
  const STATION_DOT_GAP_PX = 22;
  const STATION_LOD_K =
    (STATION_DOT_GAP_PX * 40075.017) /
    (256 * Math.cos((35 * Math.PI) / 180));
  const STATION_MINZ_CAP = 14;
  const ROMA_SOURCE = { 1: "osm", 2: "wikidata" };

  function minZoomForRank(rank) {
    return rank == null
      ? 0
      : RANK_MINZOOM[rank] != null
        ? RANK_MINZOOM[rank]
        : 0;
  }

  function stationMinZoomForLine(lineMinZoom, totalKm, stationCount) {
    if (stationCount < 2 || totalKm <= 0) return lineMinZoom;
    const averageSpacingKm = totalKm / (stationCount - 1);
    const densityMinZoom = Math.round(
      Math.log2(STATION_LOD_K / averageSpacingKm),
    );
    return Math.min(
      STATION_MINZ_CAP,
      Math.max(lineMinZoom, densityMinZoom),
    );
  }

  function buildNetworkFromCompactPackage(pkg) {
    if (!pkg || pkg.format !== "compact-v1" || !Array.isArray(pkg.lines))
      return null;

    const lineById = new Map();
    const stationById = new Map();
    const groupMembers = new Map();
    const segmentFeatures = [];
    const stationFeatures = [];

    for (const compactLine of pkg.lines) {
      const lineId = compactLine.id;
      const stationCount = compactLine.stations.length;
      const featureColor = compactLine.color || DEFAULT_LINE_COLOR;
      const lineMinZoom = minZoomForRank(compactLine.rank);
      const stationIds = compactLine.stations.map(
        (row) => `${lineId}:${row[0]}`,
      );
      const totalKm = compactLine.segments.reduce(
        (sum, row) => sum + row[0],
        0,
      );

      lineById.set(lineId, {
        lineId,
        name: compactLine.name,
        operator: compactLine.operator,
        nameRoma: compactLine.nameRoma,
        isHSR: Boolean(compactLine.isHSR),
        isLoop: Boolean(compactLine.isLoop),
        rank: compactLine.rank,
        color: compactLine.color,
        logo: compactLine.logo ? `/rail/logos/${lineId}.png` : null,
        stationOrder: stationIds,
        km: totalKm,
      });

      let previousLastCoordinate = null;
      compactLine.segments.forEach((row, index) => {
        const coordinates = row[1]
          ? [previousLastCoordinate].concat(row[2])
          : row[2];
        previousLastCoordinate = coordinates[coordinates.length - 1];
        segmentFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates },
          properties: {
            segmentId:
              `${lineId}:${compactLine.stations[index][0]}-` +
              compactLine.stations[(index + 1) % stationCount][0],
            lineId,
            color: featureColor,
            minz: lineMinZoom,
          },
        });
      });

      const stationMinZoom = stationMinZoomForLine(
        lineMinZoom,
        totalKm,
        stationCount,
      );
      const termini =
        !compactLine.isLoop && stationCount >= 2
          ? new Set([stationIds[0], stationIds[stationCount - 1]])
          : null;

      compactLine.stations.forEach((row, index) => {
        const station = {
          stationId: stationIds[index],
          name: row[1],
          lineId,
          seq: index,
          lon: row[2],
          lat: row[3],
          stationGroupId: row[0],
        };
        if (row.length > 4) {
          station.nameRoma = row[4];
          station.romaSource = ROMA_SOURCE[row[5]];
        }
        stationById.set(station.stationId, station);

        const groupKey =
          station.stationGroupId || `solo:${station.stationId}`;
        let members = groupMembers.get(groupKey);
        if (!members) {
          members = [];
          groupMembers.set(groupKey, members);
        }
        members.push(station);

        stationFeatures.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [station.lon, station.lat],
          },
          properties: {
            stationId: station.stationId,
            lineId,
            name: station.name,
            nameRoma: station.nameRoma || "",
            stationGroupId: station.stationGroupId || "",
            minz:
              termini && termini.has(station.stationId)
                ? lineMinZoom
                : stationMinZoom,
          },
        });
      });
    }

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

  return Object.freeze({
    DEFAULT_LINE_COLOR,
    buildNetworkFromCompactPackage,
    minZoomForRank,
    stationMinZoomForLine,
  });
});
