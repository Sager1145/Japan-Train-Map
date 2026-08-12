// Deterministic render-model snapshot of a loaded rail network, shared by
// test/rail-loader-parity.test.mjs and test/rail-network.test.js so a
// regeneration of public/rail/jp-2025.json needs exactly ONE hash update.
// The snapshot covers everything the map render/popup path reads; hash it
// with sha256(JSON.stringify(...)). Geometry grooming uses Math.hypot/cos and
// friends, whose final few binary digits can differ between the libm shipped
// by macOS and Linux. Those differences are many orders of magnitude below a
// rendered pixel, but an exact JSON hash would still turn them into unrelated
// digests. Canonicalize non-integer numbers to 10 decimal places (~0.01 mm for
// longitude/latitude) so the characterization remains visually exact while
// being deterministic on both local machines and GitHub's Linux runners.

// 2025.3.4 — scripts/migrations/restore-n02-loop-line-geometry.py gave
// ゆりかもめ, 上越線 and 中村線 back the loops the package's shortest-path cut
// had been skipping. Segment/station/line/group counts are unchanged (890 /
// 10161 / 607 / 9046); only three intervals grew vertices.
export const EXPECTED_RENDER_HASH =
  "880596d8b981c24c8defc5a6b2ba7d853148c696c27623d0e844fa5ffb10b276";

const SNAPSHOT_DECIMAL_PLACES = 10;

function canonicalizeRenderValue(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    return Number(value.toFixed(SNAPSHOT_DECIMAL_PLACES));
  }
  if (Array.isArray(value)) return value.map(canonicalizeRenderValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        canonicalizeRenderValue(child),
      ]),
    );
  }
  return value;
}

export function renderRelevantSnapshot(network) {
  return canonicalizeRenderValue({
    version: network.version,
    segments: network.segments.features,
    stations: network.stations.features,
    lines: [...network.lineById.entries()],
    stationRows: [...network.stationById.entries()],
    groups: [...network.groupMembers.entries()].map(([key, rows]) => [
      key,
      rows.map((row) => row.stationId),
    ]),
  });
}
