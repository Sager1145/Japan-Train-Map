// Deterministic render-model snapshot of a loaded rail network, shared by
// test/rail-loader-parity.test.mjs and test/rail-network.test.js so a
// regeneration of public/rail/jp-2025.json needs exactly ONE hash update.
// The snapshot covers everything the map render/popup path reads; hash it
// with sha256(JSON.stringify(...)).

export const EXPECTED_RENDER_HASH =
  "74cf1e805190034797f03be1a0d3dbd030a7932c86cd68225a1e88c74ee3cd3f";

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
