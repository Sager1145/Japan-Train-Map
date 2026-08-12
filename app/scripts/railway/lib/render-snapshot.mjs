// Deterministic render-model snapshot of a loaded rail network, shared by
// test/rail-loader-parity.test.mjs and test/rail-network.test.js so a
// regeneration of public/rail/jp-2025.json needs exactly ONE hash update.
// The snapshot covers everything the map render/popup path reads; hash it
// with sha256(JSON.stringify(...)).

// 2025.3.4 — scripts/migrations/restore-n02-loop-line-geometry.py gave
// ゆりかもめ, 上越線 and 中村線 back the loops the package's shortest-path cut
// had been skipping. Segment/station/line/group counts are unchanged (890 /
// 10161 / 607 / 9046); only three intervals grew vertices.
export const EXPECTED_RENDER_HASH =
  "b79f623816e5aa71ae85b71cea36d329437f074cf69a46b18e09757b54346657";

export function renderRelevantSnapshot(network) {
  return {
    version: network.version,
    segments: network.segments.features,
    stations: network.stations.features,
    lines: [...network.lineById.entries()],
    stationRows: [...network.stationById.entries()],
    groups: [...network.groupMembers.entries()].map(([key, rows]) => [
      key,
      rows.map((row) => row.stationId),
    ]),
  };
}
