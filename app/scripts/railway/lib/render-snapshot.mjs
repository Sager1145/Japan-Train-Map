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

// 2026-08-15 rebuild — 913 / 10189 / 649 / 9039, from 888 / 10161 / 607 / 9046.
//
// The drawn set grew because each railway's separate alignments became their
// own strokes: a rejoining route, a physically detached half, a branch off a
// tree. Platforms rose with it (a junction shared by two strokes is a row on
// each) while station GROUPS fell by seven, since four lines with no passenger
// adjacency at all are no longer drawn.
//
// This hash is the single point that pins the whole render model. Update it
// only alongside the package it characterises, never to make a suite pass.
//
// 2026-08-18 batch 5 — 914 / 10222 / 660 / 9039: four audit pseudo-edges
// deleted (大井町—西大井 蛇窪 V; the three 成田-skipping edges of the 成田線
// K4 clique), so the 東海道線(JR東日本) family re-settled around its real
// 品川–鶴見 ring and 成田線 folded to three strokes sharing 成田 (成田線-4
// gone), plus three doubling-back lead-ins trimmed at 中野, 秋田 and 幡ヶ谷.
export const EXPECTED_RENDER_HASH =
  "fb7f4956f9a2a4878b5c1668fd4dda8158373f9720dad0f94cfe9c63fe71cac4";

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
