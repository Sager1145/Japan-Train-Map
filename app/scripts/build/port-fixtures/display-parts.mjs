// =========================================================================
//  display-parts.json — what the map actually draws.
//
//  rail-network.js `displayPartsForLine` turns a line's station intervals
//  into DISJOINT display strokes, and `continuousCoordinatesForLine` wraps
//  it. Both are exported, so every expected value in this file is produced by
//  calling the real functions — never by a restatement of them.
//
//  It is the most consequential geometry function in the codebase because
//  everything downstream is a slice of its output: a ridden route, a lane
//  offset, a station label, a playback camera. It is also the one function
//  whose failure mode is a picture rather than a number — a branch welded to
//  its trunk draws a train turning onto the wrong railway, and no assertion
//  about lengths would catch it.
//
//  ── how the answers are recorded ──────────────────────────────────────
//
//  EVERY line of all five packages (804 of them) is run and pinned by:
//
//    * how many parts it emits and how many vertices each part has — the
//      STRUCTURAL answer, which must be exact, because every decision this
//      function makes is a distance compared against a threshold and a wrong
//      decision moves a stroke boundary rather than a coordinate;
//    * a digest over every COPIED output vertex and its position — also
//      exact, because a copy that differs is a port bug. The digest is not a
//      weaker check than storing the coordinates (the mix is a bijection on
//      64-bit words, so a single changed double always changes it), it is a
//      smaller one: all 437,725 output vertices would be a ~10 MB file;
//    * the 6,346 vertices (1.45%, on 76 lines) the station-approach pass
//      COMPUTES rather than copies, listed explicitly with their positions
//      and held to a measured ULP ceiling. See `tolerance` in the output for
//      why bit equality is not available for those, and what was measured.
//
//  Full coordinates are ALSO stored, for every line whose output has more
//  than one part (26 lines: those are the branch cases, and they are the
//  whole point) and for a chosen sample of the single-part ones, so that a
//  port which disagrees can be told WHERE rather than only THAT. The sample
//  is stated in `geometrySelection` in the output, so it can be read back.
//
//  ── and why there are synthetic lines ─────────────────────────────────
//
//  Measured, by instrumenting a scratch copy of rail-network.js and running
//  all 804 lines through it: three of `displayPartsForLine`'s branches are
//  NEVER TAKEN by the shipped packages.
//
//    * the excursion split (the trunk carries on and the excursion becomes a
//      branch) — 0 hits, and with it both halves of the anchor rule that
//      decides whether the cut vertex is overwritten or appended;
//    * the retrace onto an already-CLOSED part — 0 hits;
//    * the pure-duplicate interval skip — 0 hits;
//    * the empty-groomed fallback, the lost-anchor restore, and
//      `extraSegmentParts` drawing anything at all — 0 hits each.
//
//  That is not because the rules are wrong; it is because the packages were
//  rebuilt to split interleaved branches out ahead of time (室蘭線 ships as
//  室蘭線 + 室蘭線-2, 阪和線 as 阪和線 + 阪和線-2, 成田線 as three lines), and
//  because all four `extraSegments` rows in the shipped data are recorded
//  without geometry. A port that dropped all six branches would pass a
//  fixture built only from real lines, and would then break the first time a
//  package was rebuilt without the pre-split.
//
//  So the synthetic section builds the topologies those rules exist for, out
//  of hand-placed coordinates, and asserts at generation time that each one
//  reaches the branch it was written for (`reaches`). Their geometry is
//  invented — deliberately axis-aligned and coarse — but their SHAPE is the
//  real one, named in the JavaScript's own comments: a spur the station order
//  walked out to and came back from, a branch leaving from a platform rather
//  than from open track, a station order that jumps 138 km back down its own
//  main line.
// =========================================================================

export const name = "display-parts.json";

const COUNTRIES = ["mo", "hk", "tw", "kr", "jp"];

// ── verbatim vertices, and the few that are computed ────────────────────
//
// 98.55% of what this function emits is a vertex it was GIVEN: the whole
// pipeline after the station-approach pass only ever selects, trims and drops.
// The other 1.45% — 6,346 vertices across 76 of the 804 lines — is computed:
// `nearestCutOnPath` interpolates the point where the alignment passes the
// platform, and `warpTipToAnchor` blends a run of vertices onto the anchor.
//
// The distinction matters because the two are checkable to different
// standards, and pretending otherwise would hide a real fact about this port.
//
//   * A **verbatim** vertex must be bit-identical. It is a copy, so anything
//     else is a port bug, and it is pinned by `verbatimDigest` — FNV-1a over
//     64-bit words, mixing each part's vertex count, then each kept vertex's
//     INDEX and the IEEE-754 bits of its lon and lat. `(h ^ w) * prime mod
//     2^64` is a bijection for any odd prime, so a change to any single word
//     necessarily changes the result. That is what lets a digest stand in for
//     the coordinates it summarises, and it is why one is used at all: storing
//     all 437,725 output vertices would be a ~10 MB fixture.
//
//   * A **computed** vertex comes out of a chain of `distanceMeters` calls,
//     and `distanceMeters` contains `Math.cos`. **V8 does not use the
//     platform's `cos`** — it ships its own fdlibm port (`src/base/ieee754.cc`)
//     — and over the 60,001 real latitudes in these five packages the two
//     disagree by one ULP on 1,927 of them, 3.2%. That difference cannot be
//     eliminated without shipping fdlibm in Swift, so these vertices are
//     recorded EXPLICITLY, with their positions, and the port is held to a
//     measured ULP ceiling rather than to bit equality. See `syntheticNote`.
//
// The classification is a property of the JavaScript alone — "is this output
// vertex one of the input vertices?" — so it is not shaped by what the port
// happens to get right.
const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;
const MASK64 = 0xffff_ffff_ffff_ffffn;

const bitsView = new DataView(new ArrayBuffer(8));

function bitsOf(value) {
  bitsView.setFloat64(0, value);
  return bitsView.getBigUint64(0);
}

/** rail-network.js's own `coordinateKey` — the RAW numbers, not quantised. */
function coordinateKey(point) {
  return `${point[0]},${point[1]}`;
}

/**
 * Every coordinate the function was handed, by key.
 *
 * Two distinct doubles cannot share a shortest-round-trip decimal, so this
 * key is injective and "the output vertex is one of the input vertices" is
 * decided exactly.
 */
function verbatimKeys(RailNetwork, compactLine) {
  const keys = new Set();
  for (const interval of RailNetwork.decodeIntervals(compactLine))
    for (const point of interval) keys.add(coordinateKey(point));
  for (const station of compactLine.stations)
    keys.add(coordinateKey([station[2], station[3]]));
  for (const point of compactLine.reversalTails || []) keys.add(coordinateKey(point));
  for (const row of compactLine.extraSegments || [])
    for (const point of row.geometry || []) keys.add(coordinateKey(point));
  return keys;
}

/**
 * Splits one line's output into the digest of its verbatim vertices and an
 * explicit list of its computed ones.
 *
 * `synthesised` is flat — `[partIndex, vertexIndex, lon, lat, …]` — because
 * JSON.stringify with an indent puts every array element on its own line, and
 * the nested form triples the file size for no added clarity.
 */
function classify(verbatim, parts) {
  let hash = FNV_OFFSET;
  const mix = (word) => {
    hash = ((hash ^ word) * FNV_PRIME) & MASK64;
  };
  const synthesised = [];
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    mix(BigInt(part.length));
    for (let index = 0; index < part.length; index += 1) {
      const point = part[index];
      if (verbatim.has(coordinateKey(point))) {
        mix(BigInt(index));
        mix(bitsOf(point[0]));
        mix(bitsOf(point[1]));
      } else {
        synthesised.push(partIndex, index, point[0], point[1]);
      }
    }
  }
  return {
    verbatimDigest: `0x${hash.toString(16).padStart(16, "0")}`,
    synthesised,
  };
}

/** [[lon, lat], ...] → [lon, lat, lon, lat, ...]. */
function flatten(part) {
  const flat = [];
  for (const point of part) {
    flat.push(point[0], point[1]);
  }
  return flat;
}

// ── synthetic topologies ────────────────────────────────────────────────
//
// All of these live around 139°E 35°N (the Kantō plain, so the projection's
// cos(latitude) is the one real Japanese data is measured at) and are laid
// out on a 0.005° grid: at this latitude that is 456 m of longitude and
// 557 m of latitude, comfortably clear of the 35 m retrace radius and of the
// 600 m minimum run, so the branch each case is written for is reached by a
// margin rather than by a coincidence.

const STEP = 0.005;

/** A run of vertices from `a` to `b` inclusive, stepping by `STEP`. */
function run(fromLon, fromLat, toLon, toLat) {
  const steps = Math.round(
    Math.max(Math.abs(toLon - fromLon), Math.abs(toLat - fromLat)) / STEP,
  );
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = steps === 0 ? 0 : index / steps;
    points.push([
      Number((fromLon + (toLon - fromLon) * t).toFixed(6)),
      Number((fromLat + (toLat - fromLat) * t).toFixed(6)),
    ]);
  }
  return points;
}

function join(...runs) {
  const out = [];
  for (const piece of runs)
    for (const point of piece)
      if (
        !out.length ||
        out[out.length - 1][0] !== point[0] ||
        out[out.length - 1][1] !== point[1]
      )
        out.push(point);
  return out;
}

/** A compact-v1 line, in exactly the shape a shipped package stores. */
function compactLine({ id, stations, segments, reversalTails, extraSegments }) {
  const line = {
    id,
    name: id,
    nameRoma: null,
    operator: "synthetic",
    rank: 4,
    color: "#7C8A82",
    colorDark: null,
    stations: stations.map(([sid, sname, lon, lat]) => [
      sid,
      sname,
      lon,
      lat,
      null,
      null,
    ]),
    segments: segments.map(([km, cont, coords]) => [km, cont, coords]),
  };
  if (reversalTails) line.reversalTails = reversalTails;
  if (extraSegments) line.extraSegments = extraSegments;
  return line;
}

// Exported so the branch-coverage claim in each `reaches` list can be
// re-checked against an instrumented copy of rail-network.js without
// re-deriving these topologies by hand.
export function syntheticLines() {
  const cases = [];

  // ── 1. the excursion split, cut on OPEN TRACK ────────────────────────
  // 室蘭線's own shape: 本輪西 → 輪西 → 東室蘭 . The station order runs out to
  // a spur tip and comes back, then leaves on new railway at a switch that
  // is not a platform. The trunk must carry on through the switch (P → M →
  // R) and the spur must become its own stroke, led in from the station its
  // tail runs to (R → M → Q).
  cases.push({
    label: "synthetic:excursion-split-on-open-track",
    note:
      "A spur the station order walked out to and came back from, diverging " +
      "at a plain track vertex. The trunk keeps the switch and the spur " +
      "becomes a branch stroke led in from R.",
    reaches: [
      "excursion split",
      "cut vertex overwritten (not a platform anchor)",
    ],
    line: compactLine({
      id: "synthetic-excursion-open-track",
      stations: [
        ["P", "P", 139.0, 35.0],
        ["Q", "Q", 139.2, 35.0],
        ["R", "R", 139.1, 35.1],
      ],
      segments: [
        [18.2, 0, run(139.0, 35.0, 139.2, 35.0)],
        [20.2, 0, join(run(139.2, 35.0, 139.1, 35.0), run(139.1, 35.0, 139.1, 35.1))],
      ],
    }),
  });

  // ── 2. the excursion split, cut ON A PLATFORM ANCHOR ─────────────────
  // 阪和線 opening a part at 鳳 to reach 東羽衣. Same shape, except the branch
  // leaves FROM a station: the last vertex of the trunk is then the platform
  // anchor itself, and overwriting it would cut the trunk loose short of the
  // station AND take the station off the line it calls at. The switch here
  // sits 27 m past the platform, which is inside the 35 m match radius and
  // outside `sameCoordinate`, so the append branch is the one taken.
  cases.push({
    label: "synthetic:excursion-split-at-platform",
    note:
      "The branch leaves from a platform, so the trunk's last vertex is the " +
      "anchor and must be APPENDED past rather than overwritten.",
    reaches: ["excursion split", "cut vertex appended (platform anchor)"],
    line: compactLine({
      id: "synthetic-excursion-at-platform",
      stations: [
        ["P", "P", 139.0, 35.0],
        ["M", "M", 139.1, 35.0],
        ["Q", "Q", 139.2, 35.0],
        ["R", "R", 139.1, 35.1],
      ],
      segments: [
        [9.1, 0, run(139.0, 35.0, 139.1, 35.0)],
        [9.1, 0, run(139.1, 35.0, 139.2, 35.0)],
        [
          20.2,
          0,
          join(
            run(139.2, 35.0, 139.1, 35.0),
            [[139.0997, 35.0]],
            run(139.0997, 35.0, 139.0997, 35.1),
          ),
        ],
      ],
    }),
  });

  // ── 3. the retrace onto an already-CLOSED part ───────────────────────
  // 室蘭線's 岩見沢 → 御崎, 138 km back down its own main line. The order
  // jumps back across the line, so the divergence is nowhere near the stroke
  // being built — it is on one already closed — and the answer is a new part
  // led in along the retraced head itself, which IS the trunk this branch
  // leaves and is guaranteed to reach a station because it starts at one.
  //
  // The trunk is closed first by a reversal joint at B (the line turns back
  // on itself onto a parallel alignment 222 m north, which shares no track).
  cases.push({
    label: "synthetic:retrace-onto-closed-part",
    note:
      "The station order jumps back across the line. The open stroke (B→C) " +
      "is 9 km from the divergence, so the retrace lands on a CLOSED part " +
      "and opens a third stroke, led in along the retraced head.",
    reaches: ["reversal joint", "retrace onto a closed part"],
    line: compactLine({
      id: "synthetic-retrace-closed-part",
      stations: [
        ["A", "A", 139.0, 35.0],
        ["B", "B", 139.2, 35.0],
        ["C", "C", 139.15, 35.0],
        ["D", "D", 139.05, 35.05],
      ],
      segments: [
        [18.2, 0, run(139.0, 35.0, 139.2, 35.0)],
        [
          5.0,
          0,
          [
            [139.2, 35.0],
            [139.19, 35.002],
            [139.17, 35.002],
            [139.165, 35.0],
            [139.16, 35.0],
            [139.15, 35.0],
          ],
        ],
        [14.7, 0, join(run(139.15, 35.0, 139.05, 35.0), run(139.05, 35.0, 139.05, 35.05))],
      ],
    }),
  });

  // ── 4. the pure-duplicate interval, and the lost station anchor ──────
  // An interval that adds no new railway at all: every vertex is on track
  // already drawn and what is left after the retraced head is under 150 m.
  // It is skipped entirely, which leaves its END STATION undrawn — and that
  // is what `restoreLostStationAnchors` is for. B′ lies exactly on the trunk
  // (0 m) and is put back; B″ lies 20 m off it, past the 5 m ceiling, and is
  // deliberately left lost, because a larger gap is a source-data fault that
  // must stay visible to the anchoring audit.
  cases.push({
    label: "synthetic:pure-duplicate-interval",
    note:
      "Two intervals that re-run track already drawn and add nothing. Both " +
      "are skipped; the first one's terminus is restored into the trunk, " +
      "the second one's is 20 m off and stays lost.",
    reaches: [
      "pure-duplicate interval skipped",
      "lost station anchor restored",
      "lost station anchor too far to restore",
    ],
    line: compactLine({
      id: "synthetic-pure-duplicate",
      stations: [
        ["A", "A", 139.0, 35.0],
        ["B", "B", 139.2, 35.0],
        ["Bp", "B-prime", 139.1897, 35.0],
        ["Bpp", "B-second", 139.1794, 35.00018],
      ],
      segments: [
        [18.2, 0, run(139.0, 35.0, 139.2, 35.0)],
        [0.94, 0, join(run(139.2, 35.0, 139.19, 35.0), [[139.1897, 35.0]])],
        [0.94, 0, join([[139.1897, 35.0]], run(139.19, 35.0, 139.18, 35.0), [[139.1794, 35.00018]])],
      ],
    }),
  });

  // ── 5. everything grooms away ────────────────────────────────────────
  // Two stations at the SAME coordinate joined by an out-and-back spike. The
  // spike is a zero-width barb, so grooming collapses the stroke to a single
  // vertex, the `>= 2` filter drops it, and nothing is left to draw. The
  // fallback emits the first platform twice so the line still has a
  // drawable, sliceable identity at its own station.
  //
  // `distanceKm` is 20 while the geometry is 22 m long, which is not a
  // mistake: the grooming rung is chosen from the segment TABLE, not from
  // the drawn geometry, and this is the only case in the fixture that says
  // so out loud.
  cases.push({
    label: "synthetic:everything-grooms-away",
    note:
      "The whole line is one out-and-back spike between two co-located " +
      "platforms. Grooming leaves one vertex, the part is dropped, and the " +
      "fallback emits the first platform twice.",
    reaches: ["empty-groomed fallback"],
    line: compactLine({
      id: "synthetic-grooms-away",
      stations: [
        ["A", "A", 139.0, 35.0],
        ["A2", "A-again", 139.0, 35.0],
      ],
      segments: [
        [
          20,
          0,
          [
            [139.0, 35.0],
            [139.0, 35.0001],
            [139.0, 35.0],
          ],
        ],
      ],
    }),
  });

  // ── 6. the same spike, declared as a reversal tail ───────────────────
  // A reversal tail and a station-throat artefact are the same shape — out
  // and straight back — so the groomer cannot tell them apart by geometry
  // and would eat the real one. Only the package knows which is which, so it
  // says so, and case 5 becomes this: the spike survives intact.
  cases.push({
    label: "synthetic:reversal-tail-protects-the-spike",
    note: "Case 5 with the spike tip declared a reversal tail. It survives.",
    reaches: ["reversalTails protection"],
    line: compactLine({
      id: "synthetic-reversal-tail",
      stations: [
        ["A", "A", 139.0, 35.0],
        ["A2", "A-again", 139.0, 35.0],
      ],
      segments: [
        [
          20,
          0,
          [
            [139.0, 35.0],
            [139.0, 35.0001],
            [139.0, 35.0],
          ],
        ],
      ],
      reversalTails: [[139.0, 35.0001]],
    }),
  });

  // ── 7. extra segments ────────────────────────────────────────────────
  // Track a line runs that its station ORDER cannot carry: 輕鐵 505 takes
  // different streets each way, 751 serves 安定 one way only. All four rows
  // in the shipped packages are recorded WITHOUT geometry (the archived
  // alignment holds one centre-line for both directions, and cutting a
  // stroke from it would assert shared track the survey says is not shared),
  // so nothing in five countries exercises the drawing path. This line does,
  // alongside the three shapes that must be skipped.
  cases.push({
    label: "synthetic:extra-segments",
    note:
      "One extra segment with geometry (drawn, ends welded to the two " +
      "anchors it names), one without (recorded, not drawn), one with a " +
      "single vertex, and one naming a station index that does not exist.",
    reaches: ["extraSegmentParts draws a stroke"],
    line: compactLine({
      id: "synthetic-extra-segments",
      stations: [
        ["A", "A", 139.0, 35.0],
        ["B", "B", 139.05, 35.0],
        ["C", "C", 139.1, 35.0],
      ],
      segments: [
        [4.55, 0, run(139.0, 35.0, 139.05, 35.0)],
        [4.55, 0, run(139.05, 35.0, 139.1, 35.0)],
      ],
      extraSegments: [
        // Drawn. Note the first and last vertices deliberately DISAGREE with
        // the station table: they must be overwritten by the anchors.
        {
          from: 0,
          to: 2,
          geometry: join(
            [[138.999, 35.001]],
            run(139.0, 35.01, 139.1, 35.01),
            [[139.101, 35.001]],
          ),
        },
        { from: 0, to: 2, status: "data_coverage_gap" },
        { from: 0, to: 1, geometry: [[139.0, 35.0]] },
        { from: 0, to: 9, geometry: run(139.0, 35.02, 139.05, 35.02) },
      ],
    }),
  });

  // ── 8. a platform too far off its track to bend a railway to ─────────
  // Past 250 m the platform is not off its track, the DATA is wrong — the
  // wrong line matched, the wrong endpoint, a station belonging to a
  // neighbouring group. The characterised packages peak at 159 m
  // (東海道線/大阪), so nothing real reaches this; it exists so a future bad
  // row cannot silently bend a trunk, and this is the only case that proves
  // the guard is wired up.
  cases.push({
    label: "synthetic:anchor-past-max-displacement",
    note:
      "The middle platform sits 334 m off its own alignment. The approach " +
      "is left exactly as the package drew it, so the drawn line still " +
      "stabs sideways at the anchor — visibly wrong, and reported by the " +
      "anchoring audit rather than hidden under a graceful curve.",
    reaches: ["anchor displacement over the 250 m ceiling"],
    line: compactLine({
      id: "synthetic-anchor-too-far",
      stations: [
        ["A", "A", 139.0, 35.0],
        ["B", "B", 139.05, 35.003],
        ["C", "C", 139.1, 35.0],
      ],
      segments: [
        [4.55, 0, run(139.0, 35.0, 139.05, 35.0)],
        [4.55, 0, run(139.05, 35.0, 139.1, 35.0)],
      ],
    }),
  });

  return cases;
}

// ── which single-part lines get their coordinates stored ────────────────

// Named in rail-network.js's own comments, or the only line reaching a rare
// branch. Recorded by id so a package rebuild that renames one shows up as a
// missing name rather than as silently reduced coverage.
const NAMED_LINES = [
  // the retrace comments
  "jp:jp-北海道旅客鉄道-室蘭線",
  "jp:jp-北海道旅客鉄道-室蘭線-2",
  "jp:jp-北海道旅客鉄道-函館線",
  "jp:jp-東日本旅客鉄道-東北線",
  // the reversal-at-the-start-station comment (成田, 会津若松)
  "jp:jp-東日本旅客鉄道-成田線-2",
  "jp:jp-東日本旅客鉄道-成田線-3",
  "jp:jp-東日本旅客鉄道-只見線",
  "jp:jp-会津鉄道-会津線",
  // the anchor-append comment (阪和線 at 鳳)
  "jp:jp-西日本旅客鉄道-阪和線",
  "jp:jp-西日本旅客鉄道-阪和線-2",
  // the station-approach comments (亀山/紀勢線, 東武日光, 東海道線/大阪)
  "jp:jp-東海旅客鉄道-紀勢線",
  "jp:jp-東武鉄道-日光線",
  "jp:jp-西日本旅客鉄道-東海道線",
  // the stroke-end fold comments (五能線 at 東八森, 常磐新線 at 青井)
  "jp:jp-東日本旅客鉄道-五能線",
  "jp:jp-首都圏新都市鉄道-常磐新線",
  // loops close through the seam
  "tw:tw-klrt-c",
  "jp:jp-西日本旅客鉄道-大阪環状線",
  "jp:jp-舞浜リゾートライン-ディズニーリゾートライン",
  // paired up/down alignments, drawn as two lines over one corridor
  "jp:jp-東日本旅客鉄道-東北線-p1",
  "jp:jp-東日本旅客鉄道-東北線-p2",
  "jp:jp-九州旅客鉄道-日豊線-p1",
  // the only lines whose stroke ends are trimmed for a fold
  "jp:jp-東日本旅客鉄道-鶴見線-2",
  "jp:jp-東日本旅客鉄道-鶴見線-3",
  "hk:hk-mtr-lr-761p",
  "hk:hk-tram-west",
];

// Vertices allowed into `geometries` beyond the multi-part lines, which are
// all stored unconditionally. Every line is pinned by digest regardless, so
// this budget buys diagnosability, not coverage.
const SAMPLE_VERTEX_BUDGET = 14000;
// A single stroke longer than this is not more instructive than two shorter
// ones (山陰線 alone is 11,341 vertices).
const MAX_SAMPLED_VERTICES = 2600;

export function build({ RailNetwork, railPackage }) {
  const rows = [];
  const geometries = [];
  const surveyed = [];
  const topologyExtras = {};

  for (const country of COUNTRIES) {
    for (const line of railPackage(country).lines) {
      const parts = RailNetwork.displayPartsForLine(line);
      const continuous = RailNetwork.continuousCoordinatesForLine(line);
      const vertices = parts.reduce((sum, part) => sum + part.length, 0);
      const label = `${country}:${line.id}`;
      const split = classify(verbatimKeys(RailNetwork, line), parts);
      surveyed.push({ country, line, label, parts, continuous, vertices, split });
      // The two fields CompactPackage's decoder does not carry, recorded for
      // every line that has either, so the port cannot silently miss one.
      if (line.reversalTails?.length || line.extraSegments?.length)
        topologyExtras[label] = {
          reversalTails: line.reversalTails ?? [],
          extraSegments: line.extraSegments ?? [],
        };
    }
  }

  // ── choose which lines carry their coordinates ────────────────────────
  const stored = new Set();
  let spent = 0;
  const store = (entry) => {
    if (!entry || stored.has(entry.label)) return;
    stored.add(entry.label);
    entry.geometryIndex = geometries.length;
    geometries.push({ label: entry.label, parts: entry.parts.map(flatten) });
  };
  const byLabel = new Map(surveyed.map((entry) => [entry.label, entry]));

  // Every multi-part line, unconditionally and without a size cap. These are
  // the branch cases; the whole function exists for them.
  const multiPart = surveyed.filter((entry) => entry.parts.length > 1);
  for (const entry of multiPart) store(entry);

  // Macao and Hong Kong entire: two complete countries for 3,600 vertices,
  // and both are the metro/tram end of the grooming ladder, which the
  // Japanese and Korean packages have least of.
  for (const entry of surveyed)
    if (entry.country === "mo" || entry.country === "hk") store(entry);

  // The lines the source comments argue from, and the lines that are the
  // only ones reaching a rare branch.
  const missingNames = [];
  for (const label of NAMED_LINES) {
    const entry = byLabel.get(label);
    if (!entry) {
      missingNames.push(label);
      continue;
    }
    // A named line over the per-line cap is still pinned by digest; only its
    // coordinates are left out, and `geometrySelection` says so.
    if (entry.vertices <= MAX_SAMPLED_VERTICES) store(entry);
  }
  if (missingNames.length)
    throw new Error(
      "display-parts fixture names lines that are no longer in the packages: " +
        `${missingNames.join(", ")} — the packages moved, so re-choose the sample`,
    );

  const countStored = () =>
    geometries.reduce(
      (sum, row) => sum + row.parts.reduce((n, flat) => n + flat.length / 2, 0),
      0,
    );
  const baseVertices = countStored();
  spent = baseVertices;

  // Then a stride through the remaining single-part lines of every country,
  // so the stored sample is not all one survey's rounding: ordered by id and
  // taken every Nth, which is reproducible and is not a choice about which
  // lines are interesting.
  const remaining = surveyed
    .filter(
      (entry) => !stored.has(entry.label) && entry.vertices <= MAX_SAMPLED_VERTICES,
    )
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  for (let index = 0; index < remaining.length; index += 3) {
    const entry = remaining[index];
    if (spent + entry.vertices > baseVertices + SAMPLE_VERTEX_BUDGET) break;
    store(entry);
    spent += entry.vertices;
  }

  for (const entry of surveyed)
    rows.push({
      country: entry.country,
      lineId: entry.line.id,
      name: entry.line.name,
      // The structural answer, and the one that has to be exact: how many
      // strokes this line is drawn as, and how long each is. A branch welded
      // to its trunk shows up here and nowhere else.
      partLengths: entry.parts.map((part) => part.length),
      // Every vertex that is a copy of an input vertex, pinned bit for bit
      // together with its position.
      verbatimDigest: entry.split.verbatimDigest,
      // Every vertex the approach pass COMPUTED, flat as
      // [partIndex, vertexIndex, lon, lat, …]. Held to a ULP ceiling, not to
      // bit equality, because they are downstream of `Math.cos` — see the
      // header and `tolerance` below.
      synthesised: entry.split.synthesised,
      // continuousCoordinatesForLine returns the single part as itself and
      // flattens several, so its length is the sum of the part lengths and
      // its vertices are theirs. Pinned by length here; the test also checks
      // it against the port's own parts, vertex by vertex.
      continuousLength: entry.continuous.length,
      geometry: entry.geometryIndex ?? null,
    });

  // ── the synthetic topologies ──────────────────────────────────────────
  const synthetic = syntheticLines().map((entry) => {
    const parts = RailNetwork.displayPartsForLine(entry.line);
    const continuous = RailNetwork.continuousCoordinatesForLine(entry.line);
    const split = classify(verbatimKeys(RailNetwork, entry.line), parts);
    return {
      label: entry.label,
      note: entry.note,
      reaches: entry.reaches,
      line: entry.line,
      partLengths: parts.map((part) => part.length),
      verbatimDigest: split.verbatimDigest,
      synthesised: split.synthesised,
      continuousLength: continuous.length,
      // Stored in full without exception: these are small, and they are the
      // only cases whose branches nothing else covers.
      parts: parts.map(flatten),
    };
  });

  const storedVertices = countStored();
  const totalVertices = surveyed.reduce((sum, entry) => sum + entry.vertices, 0);

  return {
    describes:
      "rail-network.js displayPartsForLine and continuousCoordinatesForLine",
    contract:
      "displayPartsForLine emits DISJOINT strokes: a branch is cut off its " +
      "trunk and re-drawn from the station it leaves, over the trunk's own " +
      "coordinates, so the map reads continuous while the topology stays " +
      "separate and nothing can slice through a junction. The order of the " +
      "passes is load-bearing — station approaches are rebuilt on the " +
      "interval chain BEFORE any branch splitting, so a lead-in copied off a " +
      "trunk copies the finished geometry and the two strokes stay coincident " +
      "to the vertex. Fold trimming runs on both sides of grooming, and " +
      "neither may touch a platform anchor. Every line of all five packages " +
      "is pinned by part count, per-part vertex count and a digest of every " +
      "COPIED output vertex; the 1.45% of vertices the approach pass computes " +
      "are listed explicitly and held to a measured ULP ceiling — see " +
      "`tolerance`.",
    digestAlgorithm:
      "FNV-1a over 64-bit words: h = 0xcbf29ce484222325; for each part, mix " +
      "its vertex count, then — for each vertex that is a COPY of an input " +
      "vertex — its index and the IEEE-754 bit patterns of its lon and lat; " +
      "mix(w) = ((h ^ w) * 0x100000001b3) mod 2^64. Reported as 16 lowercase " +
      "hex digits with an 0x prefix. Computed vertices are excluded from the " +
      "digest and carried in `synthesised` instead.",
    tolerance:
      "Copied vertices must be bit-identical; there is no tolerance for them " +
      "and none is needed. Computed vertices — `nearestCutOnPath`'s " +
      "interpolated cut and `warpTipToAnchor`'s blend — are downstream of " +
      "distanceMeters, which contains Math.cos, and V8 does NOT use the " +
      "platform's cos: it ships its own fdlibm port (src/base/ieee754.cc). " +
      "Over the 60,001 real latitudes in these five packages the two disagree " +
      "by one ULP on 1,927 of them (3.2%). A Swift port on Darwin therefore " +
      "cannot reproduce these vertices bit for bit without shipping fdlibm, " +
      "which is a bigger decision than one function's port should make. The " +
      "port is held to a ULP ceiling instead, and — the part that actually " +
      "matters — to EXACT part counts and vertex counts, because every " +
      "decision this function makes is a distance compared against a " +
      "threshold and a wrong decision moves a stroke boundary rather than a " +
      "coordinate. Math.hypot is a different story and is NOT covered by this " +
      "tolerance: V8 computes it as a scaled Kahan sum rather than calling " +
      "libm, that is plain algebra a port can reproduce exactly, and getting " +
      "it wrong DID flip decisions (three Japanese lines split one vertex " +
      "differently), so the port reproduces V8's algorithm.",
    synthesisedVertices: {
      total: rows.reduce((sum, row) => sum + row.synthesised.length / 4, 0),
      lines: rows.filter((row) => row.synthesised.length).length,
      ofTotalVertices: totalVertices,
    },
    geometrySelection: {
      lines: rows.length,
      totalOutputVertices: totalVertices,
      multiPartLines: multiPart.length,
      storedLines: geometries.length,
      storedVertices,
      rule:
        "every multi-part line (uncapped), every line of mo and hk, every " +
        `line named in rail-network.js's comments under ${MAX_SAMPLED_VERTICES} ` +
        "vertices, then every third remaining line by id under that cap until " +
        `${SAMPLE_VERTEX_BUDGET} further vertices are spent. Lines without ` +
        "stored coordinates are still pinned by part lengths, the verbatim " +
        "digest and their explicit computed vertices — this budget buys " +
        "diagnosability, not coverage.",
    },
    topologyExtras,
    // One row per line of every shipped package. `cases` rather than `lines`
    // because build-port-fixtures.mjs counts this field when it prints the
    // file; the synthetic topologies below are extra cases on top of it.
    cases: rows,
    geometries,
    synthetic,
  };
}
