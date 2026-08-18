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
// 2026-08-18 batch 6 — 915 / 10222 / 658 / 9039: 長崎線 and 東海道線(JR東日本)
// take their official shapes. 長崎線's trunk runs 鳥栖–長崎 via the 市布新線
// (the shield generalisation stops the skip-edge test cutting 現川–浦上 at its
// own junction) and the 旧線 via 長与 is a rejoining branch 喜々津–浦上, so
// 長崎線-3 folds in. 東海道線's trunk runs 東京–熱海 via 品川・川崎・横浜, the
// 品鶴線 is its own 品川–鶴見 stroke (whose 新幹線-corridor lane pairing
// re-solved, 2→5 features) and the 相鉄連絡線 renumbers -4 → -3.
// 2026-08-18 batch 7 — 916 / 10223 / 658 / 9039: 京王新線 becomes its own
// line (新線新宿–初台–幡ヶ谷–笹塚, carved from the「京王線」N02 key), 京王線
// runs 新宿–笹塚 direct and the 初台–幡ヶ谷 orphan 京王線-2 folds away, so
// the line count holds still while the 新宿–笹塚 corridor gains the 新線's
// lane feature and 新宿 gains its 新線 platform row.
// 2026-08-18 batch 8 — 916 / 10223 / 658 / 9039, all counts still: 東京駅
// takes its per-line platform dots (R13). 東北新幹線 leaves the 東海道新幹線
// platforms N02 copied it onto and stands on its own 20-23 group 48 m west
// (registered geometry patch, OSM centreline); 東北線-2 and 東海道線 share
// one surface dot; 総武線's rapid
// takes its own 馬喰町 tunnel with 両国 handed back to the 御茶ノ水 local
// stroke (one station row each way, so the totals hold).
// 2026-08-18 batch 9 — 916 / 10225 / 658 / 9039: the shared conventional dot
// moves to the middle platform feature; the 総武快速 stroke continues from its
// underground 東京 dot southwest along OSM's 東京トンネル through underground
// 新橋・品川 to 西大井. Its existing 品鶴 display part becomes blue 総武線-3,
// adding the two intermediate platform rows without adding a line or feature.
// 2026-08-18 batch 10 — 918 / 10225 / 658 / 9039: both Shinkansen, the shared
// 東北線–東海道線 surface stroke and the north half of the 総武 underground
// stroke follow their selected OSM physical rails through Tokyo's adjacent
// intervals. Two display features are added where the registered corridors now
// enter/leave the existing screen-space lane stretches at their real junctions.
// 2026-08-18 batch 11 — 916 / 10225 / 658 / 9039: Tokyo's 東北線 and
// 東海道線 are welded at track 10's exact OSM node and registered as one
// Ueno–Tokyo through railway. Both halves now take the same -0.5 render lane,
// removing the two lane-transition features that batch 10 introduced and
// making the station one smooth Sapporo-style junction rather than two dots.
// 2026-08-18 batch 12 — 910 / 10223 / 657 / 9039: the whole-country
// multi-line-station audit removes the stale 函館線-4 鹿部–大沼 duplicate that
// the current inventory no longer emits, records railwayIdentity on every
// sibling family, and derives junction-aware lane ramps. Two-stroke
// continuations carry one screen-side lane through their shared platform;
// true branches return to lane 0 at the physical junction, so no offset tears
// one railway into two visible station points.
// 2026-08-18 batch 13 — 918 / 10223 / 657 / 9039: propagate Tokyo's explicit
// Ueno–Tokyo identity from the registered 東北線-2 / 東海道線 junction to every
// sibling display stroke in both canonical families. This removes the false
// independent-railway split around 日暮里; the eight extra render pieces are
// the resulting lane-profile boundaries against genuinely separate railways.
// 2026-08-18 close-out — 918 / 10223 / 657 / 9039, counts still: the standing
// doubling-back repairs re-applied after the day's promotes. 中央線 中野→東中野
// (2.75 → 1.76 km) and 奥羽線 秋田→四ツ小屋 (7.26 → 6.37 km) had shipped
// untrimmed when their staging strokes were promoted wholesale; the CASES
// script re-cut both against their official mileages and remapped 128
// structure rows, exactly as the batch-5 landing first did.
export const EXPECTED_RENDER_HASH =
  "41a09696cc2f48dcef4bbc786e6c3a37d1b534a73bf696ef61aa458188c4b91e";

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
