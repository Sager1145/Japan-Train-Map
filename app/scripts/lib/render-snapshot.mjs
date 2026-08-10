// Deterministic render-model snapshot of a loaded rail network, shared by
// scripts/test-rail-loader-parity.mjs and test/rail-network.test.js so a
// regeneration of public/rail/jp-2025.json needs exactly ONE hash update.
// The snapshot covers everything the map render/popup path reads; hash it
// with sha256(JSON.stringify(...)).

export const EXPECTED_RENDER_HASH =
  "b144c01616ce4253a8098c1de1c197121e158d5fcdd466a21be3d322d2ea23a0";

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
