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
// 2026-08-18 batch 14 — 918 / 10223 / 657 / 9039, counts still: the builder's
// re-anchoring pass now also fires when a built interval runs 30 %+300 m past
// its audited distance, so a station standing on a dead-end platform section
// is re-seated on the through platform instead of drawing an out-and-back
// fold. Exactly six parts nationwide are in that band and all six re-anchor
// clean in staging; five are promoted: 東海道線 (JR東海) 尾頭橋→名古屋
// 3.60→2.85 km (the 180° fold at 名古屋), 中央線 中野→東中野 2.75→1.76 built
// clean at source (the standing trim case becomes a guard) with 新宿→代々木
// 1.01→0.73 riding along, 南海本線 岸里玉出→粉浜 1.84→1.24, 山陽線
// 天神川→広島 and 横川→西広島, and 阪和線-2 東羽衣→鳳. Every moved dot lands
// exactly on a sibling N02 platform feature of its own line. The sixth,
// 東北線-3 西日暮里→日暮里 1.17→0.63, is deliberately NOT promoted, pending
// the batch-9 review.
//
// 2026-08-18: screen-space lane offsets were removed from the render, so a
// line is one feature on its own surveyed geometry again instead of one
// feature per lane it took (jp 918 → 657 segment features). Every coordinate
// is unchanged; what the hash moved for is the feature split, and nothing
// else.
//
// 2026-08-19: batch 1 of the multi-line station audit. Four registered
// platform picks (evidence/station-platform-assignments.json) move six lines'
// dots onto the platform their own trains use, measured against OSM:
// 岸里玉出 高野線 185 m → 1.2 m from a way named 南海電気鉄道高野線, 品川
// 東海道線 32 → 6.9, 西船橋 総武線 24.2 → 11.0, 大阪 東海道線 23.5 → 2.1.
// Every pick selects an EXISTING N02 feature — no official geometry is
// overridden — so what moved is which of several surveyed platforms each
// stroke anchors on.
//
// 2026-08-19 batch 2 — 13 registered station-anchor overrides
// (evidence/station-anchor-overrides.json, generated by
// build-station-anchor-evidence.mjs). Each replaces ONE N02 station feature
// with the surveyed OSM platform its own line serves, leaving RailroadSection
// geometry untouched, and is written only when that platform sits within 25 m
// of a way named for the line. Resolved: 横浜 相鉄本線 130.6→0.2 m,
// 京成高砂 北総線 48.3→9.4, 東武日光 日光線 139.5→…, 福島 飯坂線 94.8→8.6,
// 橿原神宮前 吉野線 →0.3, 糸魚川 大糸線, 宮古 山田線, 伊予立川 予讃線-2,
// 多久 唐津線, 穴内 阿佐線, 土佐昭和 予土線.
// A 14th row (名古屋 西名古屋港線, platform ref 14;15) was REVERTED: applying
// it measured worse, 148.9→195.7 m, because ref 14;15 is a JR island and
// あおなみ線 uses its own — the 25 m gate passed on a naming artifact. It
// waits for route-relation evidence. 広島電鉄 宇品線 is built but NOT
// promoted: moving 紙屋町西 splits the line into a trunk plus a branch, which
// is a topology change and needs its own review.
//
// 2026-08-19 品川 revert — batch 1's 東海道線 platform pick is withdrawn. It
// improved the dot (32.0 m to 1.6 m from a way named 東海道本線) but forced
// 高輪ゲートウェイ→品川 to double back: 0.837 km / 12 deg became 1.294 km /
// 169 deg, +695 m over the audited 0.599 km, because the chosen feature sits
// at the north end of the group. Reverted, and the interval is 838 m / 10 deg
// again. Reported by the parallel audit session's isolation build;
// validate-railway-topology missed it because sharp_artificial_turn requires
// BOTH edges at a corner to be >=60 m and these are 70 m and 36 m. A fold scan
// with no edge-length floor over every line this campaign touched finds no
// other new fold: 北赤羽 168, 王子 168, 成東 163 and 東京 90 all predate it.
export const EXPECTED_RENDER_HASH =
  "84a8ae76db65cd562a7e117b42027c9a0faf01464027e0c8f341b6f67b3ce866";

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
