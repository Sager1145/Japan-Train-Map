// =========================================================================
//  grooming.json — micro-kink grooming, and the scale-relative limits it runs
//  under (rail-network.js smoothMicroKinks / MICRO_KINK_SCALES /
//  microKinkLimitsForSpacing / medianSpacingMeters).
//
//  smoothMicroKinks decides which surveyed vertices a line KEEPS. Get it
//  wrong in one direction and GIS digitising barbs render as thorns on every
//  approach; wrong in the other and a tram's genuine street corner is rubbed
//  flat. Neither failure is visible in a diff, and both are visible on the
//  map — which is exactly the shape of thing this fixture exists for.
//
//  smoothMicroKinks is exported, so every `keptIndices` below is produced by
//  calling THE REAL FUNCTION. The three helpers that pick its `limits` are
//  not exported, so the ladder is restated here (see MICRO_KINK_SCALES) and
//  every case RECORDS the limits object it was run with. The contract the
//  Swift port is held to is therefore:
//
//      given exactly these coordinates, exactly these limits and exactly
//      this protected-key set, the answer is exactly this polyline.
//
//  The derivation of the limits from a line's median station spacing is
//  checked separately, by recording `medianSpacingMeters` and `limitsIndex`
//  for every line of all five packages: the port re-derives both from the
//  same package and must land on the same rung.
// =========================================================================

export const name = "grooming.json";

// ── the ladder, restated from rail-network.js ────────────────────────────
// Not exported by rail-network.js, so this is a copy — and a copy is only
// admissible because it is DATA that the fixture writes down rather than
// behaviour it stands in for: every case carries the limits it used, so a
// port checking itself against this file is checking against numbers, not
// against a second implementation of the ladder.
//
// The scale-relativity is the whole point of the design. On a 150 km trunk a
// 30 m in-and-out barb with a 3 m bulge is certainly digitising noise; on a
// street tram the very same numbers describe a real corner, because a tram
// rounds a city block in tens of metres. So each line picks its limits from
// its own characteristic scale.
const MICRO_KINK_SCALES = [
  // Street trams, people movers, funiculars.
  { maxSpacingMeters: 700, edge: 8, turn: 75, deviation: 0.8 },
  // Dense urban metro / short private lines.
  { maxSpacingMeters: 1600, edge: 16, turn: 65, deviation: 1.5 },
  // Ordinary regional and trunk railways (the historic thresholds).
  { maxSpacingMeters: Infinity, edge: 30, turn: 55, deviation: 3 },
];
const DEFAULT_MICRO_KINK = MICRO_KINK_SCALES[MICRO_KINK_SCALES.length - 1];
// At this deflection the two edges are effectively anti-parallel: the vertex
// is a zero-width spike, which is noise at every scale, and the lateral
// deviation cap is skipped.
const SPIKE_MIN_TURN_DEGREES = 150;
// localMetric's metres-per-degree. Only the synthetic probes use it, and only
// on the latitude axis, where it is a single exact multiplication.
const METRES_PER_DEGREE = 111320;

/** rail-network.js medianSpacingMeters, restated. */
function medianSpacingMetersOf(segmentKilometres) {
  const spacings = segmentKilometres
    .map((value) => Number(value) * 1000)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (!spacings.length) return 0;
  // Upper median on an even count — `Math.floor(n / 2)`, not the mean of the
  // two middles. A port that averages lands between two rungs of the ladder
  // and moves lines across it.
  return spacings[Math.floor(spacings.length / 2)];
}

function medianSpacingMeters(compactLine) {
  return medianSpacingMetersOf(compactLine.segments.map((row) => row[0]));
}

/** rail-network.js microKinkLimitsForSpacing, restated. Returns the index. */
function limitsIndexForSpacing(meters) {
  // `!(meters > 0)` rather than `meters <= 0`: it is also the NaN guard, and
  // a line whose every segment length is zero reaches it.
  if (!(meters > 0)) return MICRO_KINK_SCALES.indexOf(DEFAULT_MICRO_KINK);
  for (let index = 0; index < MICRO_KINK_SCALES.length; index += 1)
    if (meters <= MICRO_KINK_SCALES[index].maxSpacingMeters) return index;
  return MICRO_KINK_SCALES.indexOf(DEFAULT_MICRO_KINK);
}

/** rail-network.js coordinateKey — NOT the quantised app-coords one. */
function coordinateKey(coordinate) {
  return `${coordinate[0]},${coordinate[1]}`;
}

/** Length after smoothMicroKinks' leading adjacent-duplicate collapse. */
function dedupedLength(coordinates) {
  let count = 0;
  let last = null;
  for (const point of coordinates)
    if (!last || last[0] !== point[0] || last[1] !== point[1]) {
      count += 1;
      last = point;
    }
  return count;
}

// ── recording an answer ──────────────────────────────────────────────────

/**
 * The kept vertices, as indices into the input.
 *
 * smoothMicroKinks never synthesises a coordinate: it collapses adjacent
 * duplicates and then only ever DROPS vertices, so its output is always a
 * subsequence of its input. Recording indices instead of a second copy of the
 * geometry is what keeps this file under a megabyte while still pinning the
 * answer exactly — the port reconstructs the coordinates from the same input
 * array and compares bit patterns.
 *
 * The subsequence property is asserted rather than assumed: if a future
 * change to the groomer ever moved a vertex, this throws at generation time
 * instead of silently recording a wrong index.
 */
function keptIndicesOf(input, output) {
  const indices = [];
  let cursor = 0;
  for (const point of output) {
    while (
      cursor < input.length &&
      !(
        Object.is(input[cursor][0], point[0]) &&
        Object.is(input[cursor][1], point[1])
      )
    )
      cursor += 1;
    if (cursor >= input.length)
      throw new Error(
        "smoothMicroKinks returned a vertex that is not in its input — " +
          "this fixture's index encoding is no longer valid",
      );
    indices.push(cursor);
    cursor += 1;
  }
  return indices;
}

// ── the fixture ──────────────────────────────────────────────────────────

const COUNTRIES = ["mo", "hk", "tw", "kr", "jp"];

// Total input vertices allowed into `inputs`. The inputs dominate the file
// size (the answers are integers), so this is the knob that keeps the fixture
// reviewable. Raising it buys more lines, not more coverage of the branches.
const VERTEX_BUDGET = 18000;
// A chain longer than this is not more instructive than two shorter ones, and
// 山陰線 alone is 11,355 vertices.
const MAX_CHAIN_VERTICES = 1500;

export function build({ RailNetwork, railPackage }) {
  const inputs = [];
  const cases = [];
  const spacings = [];

  const scales = MICRO_KINK_SCALES.map((scale) => ({
    // JSON has no Infinity. `null` is the top rung's "no ceiling", and the
    // port must read it that way — a port that decodes it as 0 sends every
    // line to the tram thresholds.
    maxSpacingMeters: Number.isFinite(scale.maxSpacingMeters)
      ? scale.maxSpacingMeters
      : null,
    edge: scale.edge,
    turn: scale.turn,
    deviation: scale.deviation,
  }));

  // ── survey every line of every package ────────────────────────────────
  // The spacing table covers all five countries in full, because "which rung
  // does this line land on" is the part of the machinery with real data
  // spanning its whole range: the shipped packages run from a 169 m tram
  // spacing to a 46 km high-speed hop, and both ends have to sort correctly.
  const surveyed = [];
  for (const country of COUNTRIES) {
    for (const line of railPackage(country).lines) {
      const meters = medianSpacingMeters(line);
      const limitsIndex = limitsIndexForSpacing(meters);
      spacings.push({
        country,
        lineId: line.id,
        medianSpacingMeters: meters,
        limitsIndex,
      });

      // The realistic input: the whole drawn chain, intervals concatenated
      // WITHOUT removing the repeated station vertex at each seam. That
      // repeat is real — decodeIntervals ends one interval and starts the
      // next on the same anchor — and feeding it in exercises the groomer's
      // own leading de-duplication pass on production data rather than only
      // on invented cases.
      const chain = [];
      for (const interval of RailNetwork.decodeIntervals(line))
        for (const point of interval) chain.push([point[0], point[1]]);
      if (chain.length < 2) continue;

      const perLadder = MICRO_KINK_SCALES.map((limits) =>
        RailNetwork.smoothMicroKinks(chain, limits, null),
      );
      const deduped = dedupedLength(chain);
      surveyed.push({
        country,
        line,
        meters,
        limitsIndex,
        chain,
        perLadder,
        // How many vertices any rung of the ladder GROOMS AWAY — measured
        // against the de-duplicated length, not the raw one. Every chain
        // loses one vertex per interval seam to the leading de-duplication
        // pass no matter what the limits say, so counting from the raw length
        // would rank lines by how many stations they have and spend the whole
        // budget on the longest trunks while missing the barbs entirely.
        removals: perLadder.reduce(
          (total, output) => total + (deduped - output.length),
          0,
        ),
      });
    }
  }

  // ── choose the lines ──────────────────────────────────────────────────
  const chosen = [];
  const taken = new Set();
  let spent = 0;
  const take = (entry) => {
    if (!entry || taken.has(entry.line.id)) return;
    taken.add(entry.line.id);
    chosen.push(entry);
    spent += entry.chain.length;
  };

  // Macao and Hong Kong entire: two complete countries for the price of a
  // rounding error, and both are all-tram/metro, which is the rung the
  // Japanese and Korean packages have least of.
  for (const entry of surveyed)
    if (entry.country === "mo" || entry.country === "hk") take(entry);

  // 阿里山線 by name. It is the only line in five countries whose grooming
  // needs THIRTEEN passes to reach stability under the trunk rung — the
  // switchbacks leave a barb behind a barb behind a barb — so it is the only
  // case that proves the repeat-to-stability loop at all. Worth its 3,361
  // vertices; nothing shorter substitutes for it.
  take(surveyed.find((entry) => entry.line.id === "tw-alsr-alishan"));

  // Then the lines the groomer actually changes, most-changed first, so the
  // budget goes to geometry that exercises the thresholds rather than to
  // geometry that walks straight through them.
  const contested = surveyed
    .filter(
      (entry) =>
        entry.removals > 0 && entry.chain.length <= MAX_CHAIN_VERTICES,
    )
    .sort((a, b) => b.removals - a.removals || (a.line.id < b.line.id ? -1 : 1));
  for (const entry of contested)
    if (spent + entry.chain.length <= VERTEX_BUDGET) take(entry);

  // And a few the groomer leaves alone, one per remaining country: a port
  // that removes something here is as broken as one that keeps a barb, and
  // this is the only place that shows it.
  for (const country of ["tw", "kr", "jp"]) {
    const quiet = surveyed
      .filter(
        (entry) =>
          entry.country === country && entry.removals === 0 && !taken.has(entry.line.id),
      )
      .sort((a, b) => a.chain.length - b.chain.length);
    for (const entry of quiet.slice(0, 2)) take(entry);
  }

  // ── the cases ─────────────────────────────────────────────────────────
  for (const entry of chosen) {
    const inputIndex = inputs.length;
    // The id, not the display name: 本線 alone names a dozen unrelated
    // railways, and this string is what a failing port prints.
    const label = `${entry.country}:${entry.line.id}`;
    inputs.push({
      label,
      country: entry.country,
      lineId: entry.line.id,
      medianSpacingMeters: entry.meters,
      ownLimitsIndex: entry.limitsIndex,
      coordinates: entry.chain,
    });

    // Every line under every rung, not only its own. Running tram geometry
    // through the trunk thresholds is what makes the ladder's three rows
    // separable at all: under its own rung a tram loses nothing (measured —
    // all 99 lines on rung 0 are untouched by rung 0), so a port that mixed
    // the rows up would pass a fixture built only from own-rung answers.
    for (let index = 0; index < MICRO_KINK_SCALES.length; index += 1) {
      const limits = MICRO_KINK_SCALES[index];
      cases.push({
        note:
          `${label} under rung ${index}` +
          (index === entry.limitsIndex ? " (its own)" : ""),
        input: inputIndex,
        limitsIndex: index,
        limits: { edge: limits.edge, turn: limits.turn, deviation: limits.deviation },
        // An EMPTY protected set, which is not the same statement as a
        // missing one — see the `protectedKeys: null` cases below.
        protectedIndices: [],
        protectedKeys: [],
        keptIndices: keptIndicesOf(entry.chain, entry.perLadder[index]),
      });
    }

    const own = entry.perLadder[entry.limitsIndex];
    const ownLimits = MICRO_KINK_SCALES[entry.limitsIndex];
    const recordProtected = (note, indices) => {
      const keys = new Set(indices.map((i) => coordinateKey(entry.chain[i])));
      const output = RailNetwork.smoothMicroKinks(
        entry.chain,
        ownLimits,
        keys,
      );
      cases.push({
        note,
        input: inputIndex,
        limitsIndex: entry.limitsIndex,
        limits: {
          edge: ownLimits.edge,
          turn: ownLimits.turn,
          deviation: ownLimits.deviation,
        },
        protectedIndices: indices,
        // Recorded as strings as well as indices so the port's own spelling
        // of a coordinate is checked, not just its use of the set. These are
        // rail-network.js's `${lon},${lat}` — the RAW numbers, NOT the
        // 5-decimal quantised key app-coords.js builds. A port that reaches
        // for the quantised one protects the wrong vertices.
        protectedKeys: [...keys],
        keptIndices: keptIndicesOf(entry.chain, output),
      });
    };

    // The production set: station anchors. decodeIntervals forces both ends
    // of every interval onto the station table's coordinate, so these keys
    // really do land on vertices of this chain.
    const anchorIndices = [];
    const anchorKeys = new Set(
      entry.line.stations.map((row) => coordinateKey([row[2], row[3]])),
    );
    for (let i = 0; i < entry.chain.length; i += 1)
      if (anchorKeys.has(coordinateKey(entry.chain[i]))) anchorIndices.push(i);
    if (anchorIndices.length)
      recordProtected(
        `${label}: station anchors protected`,
        anchorIndices,
      );

    // The set that must change the answer: everything the unprotected run at
    // this line's own rung dropped. "Which vertices are untouchable" is the
    // part a port gets silently wrong, and a protected-set case whose answer
    // matches the unprotected one proves nothing about it.
    const removed = [];
    const kept = new Set(keptIndicesOf(entry.chain, own));
    for (let i = 0; i < entry.chain.length; i += 1) if (!kept.has(i)) removed.push(i);
    // Vertices dropped by the leading de-duplication pass are unreachable by
    // protection — they are gone before the loop starts — so only the ones a
    // pass actually judged are useful here.
    const judged = removed.filter(
      (i) =>
        i > 0 &&
        !(
          entry.chain[i][0] === entry.chain[i - 1][0] &&
          entry.chain[i][1] === entry.chain[i - 1][1]
        ),
    );
    if (judged.length) {
      recordProtected(
        `${label}: every groomed-away vertex protected`,
        judged,
      );
      if (judged.length > 1)
        recordProtected(
          `${label}: every other groomed-away vertex protected`,
          judged.filter((_, i) => i % 2 === 0),
        );
    }
  }

  // ── synthetic probes ──────────────────────────────────────────────────
  // Hand-built geometry for the branches real data cannot be relied on to
  // reach, and for the exact threshold comparisons it never lands on.
  //
  // Every probe is deliberately AXIS-ALIGNED in latitude. localMetric's
  // latitude axis is one exact multiplication (`lat * 111320`) with no
  // cos() in it, and hypot(0, y) is exactly |y| by definition in both
  // languages — so the metres these probes measure are the same double in V8
  // and in Darwin, and a threshold set exactly equal to one of them is a
  // legitimate boundary test rather than a coin toss between two libms.
  // (There is no equivalent probe for the `deviation` cap: the lateral
  // distance always crosses the longitude axis, and therefore cos(), whose
  // last bit the two runtimes do not promise each other. The deviation cap is
  // covered by real data instead, and well: across all five packages at all
  // three rungs it is the branch that removes 298 of the 366 groomed
  // vertices, the spike short-circuit accounting for the other 68.)
  const A = [139, 35];
  const spikeTip = [139, 35.0001];
  const spikeEdgeMeters = Math.abs(
    35.0001 * METRES_PER_DEGREE - 35 * METRES_PER_DEGREE,
  );
  // `(Math.acos(cosine) * 180) / Math.PI` with cosine exactly -1, which is
  // what an out-and-straight-back spike produces.
  const straightBackDegrees = (Math.acos(-1) * 180) / Math.PI;

  const probe = (note, coordinates, limits, protectedIndices) => {
    const keys =
      protectedIndices === null
        ? null
        : new Set(protectedIndices.map((i) => coordinateKey(coordinates[i])));
    const output = RailNetwork.smoothMicroKinks(coordinates, limits, keys);
    cases.push({
      note,
      input: inputs.length,
      limitsIndex: MICRO_KINK_SCALES.indexOf(limits),
      limits:
        limits === null
          ? null
          : { edge: limits.edge, turn: limits.turn, deviation: limits.deviation },
      protectedIndices,
      protectedKeys: keys === null ? null : [...keys],
      keptIndices: keptIndicesOf(coordinates, output),
    });
    inputs.push({
      label: `synthetic:${note}`,
      country: null,
      lineId: null,
      medianSpacingMeters: null,
      ownLimitsIndex: null,
      coordinates,
    });
  };

  const trunk = DEFAULT_MICRO_KINK;
  // `limitsIndex` is -1 for a bespoke limits object; the port reads `limits`.
  const at = (edge, turn, deviation) => ({ edge, turn, deviation });

  probe("empty input", [], trunk, []);
  probe("a single vertex survives", [A], trunk, []);
  probe("two identical vertices collapse to one", [A, A], trunk, []);
  probe("two distinct vertices are returned unchanged", [A, spikeTip], trunk, []);
  probe(
    "runs of duplicates collapse before any pass",
    [A, A, A, spikeTip, spikeTip, [139, 35.0002]],
    trunk,
    [],
  );
  // The spike itself, and what is left of a line once it is gone: out and
  // straight back leaves ONE vertex, not two — the trailing push is guarded
  // by sameCoordinate, so a caller has to be ready for a groomed part with
  // fewer than two vertices.
  probe("an out-and-back spike leaves a single vertex", [A, spikeTip, A], trunk, []);
  probe(
    "protecting the tip keeps the spike whole",
    [A, spikeTip, A],
    trunk,
    [1],
  );
  probe(
    "a null protected set protects nothing",
    [A, spikeTip, A],
    trunk,
    null,
  );
  probe(
    "null limits fall back to the trunk rung",
    [A, spikeTip, A],
    null,
    [],
  );
  // Once the tip is gone the vertex that follows it repeats the one already
  // kept, and the guard inside the pass drops that repeat too — so A,B,A,C
  // grooms to A,C and NOT to A,A,C. The second A is also the case where
  // turnDegrees sees a zero-length incoming edge and returns 0 rather than
  // dividing by it.
  probe(
    "the repeat left behind by a removed spike is dropped as well",
    [A, spikeTip, A, [139.001, 35]],
    trunk,
    [],
  );
  // Exact threshold comparisons. `shortEdge <= edge` and `deflection >= turn`
  // are inclusive; a port that writes `<` or `>` differs from this app on
  // exactly these four cases and on nothing else in five countries.
  probe(
    "shortEdge exactly at the edge limit is groomed (<=)",
    [A, spikeTip, A],
    at(spikeEdgeMeters, trunk.turn, trunk.deviation),
    [],
  );
  probe(
    "shortEdge one ULP above the edge limit is kept",
    [A, spikeTip, A],
    at(nextDown(spikeEdgeMeters), trunk.turn, trunk.deviation),
    [],
  );
  probe(
    "deflection exactly at the turn limit is groomed (>=)",
    [A, spikeTip, A],
    at(trunk.edge, straightBackDegrees, trunk.deviation),
    [],
  );
  probe(
    "deflection one ULP below the turn limit is kept",
    [A, spikeTip, A],
    at(trunk.edge, nextUp(straightBackDegrees), trunk.deviation),
    [],
  );
  // The spike short-circuit: at 180° the deviation cap is not consulted, so
  // even a cap of zero cannot save the vertex. Set the cap negative to make
  // the point unambiguous — if a port evaluates the deviation term anyway,
  // this case keeps the vertex and the port fails here.
  probe(
    "at 180 degrees the deviation cap is never consulted",
    [A, spikeTip, A],
    at(trunk.edge, trunk.turn, -1),
    [],
  );

  // ── spacings the shipped packages never produce ───────────────────────
  // Two rules of the ladder are unreachable from real data and therefore
  // untestable without this list — both measured: no line in five countries
  // carries a zero-length segment, and none has a median spacing of exactly
  // 700 or 1600 m (the nearest are 698 and 701). So a port that dropped the
  // `> 0` filter, or wrote `<` for the rung ceiling's `<=`, passed everything
  // real data could ask of it.
  //
  // These rows are the restated rule applied to invented segment lists rather
  // than an exported function's output — the same standing the `limits`
  // objects have, and stated here for the same reason.
  const syntheticSpacings = [
    { note: "no segments at all", segmentKilometres: [] },
    { note: "every segment zero-length", segmentKilometres: [0, 0, 0] },
    {
      note: "zero-length segments are filtered out, not sorted to the front",
      segmentKilometres: [0, 0.5, 0, 1],
    },
    { note: "exactly on the tram ceiling", segmentKilometres: [0.7] },
    { note: "one metre above the tram ceiling", segmentKilometres: [0.701] },
    { note: "exactly on the metro ceiling", segmentKilometres: [1.6] },
    { note: "one metre above the metro ceiling", segmentKilometres: [1.601] },
    {
      note: "even count takes the upper of the two middles",
      segmentKilometres: [0.3, 0.5, 0.9, 2],
    },
    {
      note: "odd count takes the middle",
      segmentKilometres: [0.3, 0.5, 0.9],
    },
    {
      note: "unsorted input is sorted first",
      segmentKilometres: [46.105, 0.169, 3.2],
    },
    { note: "a negative segment is filtered like a zero", segmentKilometres: [-1, 0.4] },
  ].map((row) => {
    const meters = medianSpacingMetersOf(row.segmentKilometres);
    return {
      ...row,
      medianSpacingMeters: meters,
      limitsIndex: limitsIndexForSpacing(meters),
    };
  });

  return {
    describes:
      "rail-network.js smoothMicroKinks, MICRO_KINK_SCALES, " +
      "microKinkLimitsForSpacing and medianSpacingMeters",
    contract:
      "smoothMicroKinks removes GIS digitising barbs at the line's OWN scale " +
      "and nothing else. Three facts a plausible port gets wrong: the " +
      "previous vertex of a corner is the last KEPT vertex, not the previous " +
      "input one, so removals cascade within a single pass; the loop repeats " +
      "to stability, which 阿里山線 needs thirteen passes of; and a " +
      "protected key is spelled `${lon},${lat}` from the RAW coordinate, not " +
      "from the 5-decimal quantised one app-coords.js builds. `keptIndices` " +
      "are indices into the case's input coordinates — the groomer never " +
      "synthesises a vertex, so its output is always a subsequence of its " +
      "input, and that is asserted when this file is written. The `limits` " +
      "on each case are recorded rather than derived because " +
      "microKinkLimitsForSpacing is not exported: the contract here is " +
      "'given exactly these limits, this answer', and the derivation is " +
      "checked separately through `spacings`, which carries every line of " +
      "all five packages.",
    scales,
    spikeMinTurnDegrees: SPIKE_MIN_TURN_DEGREES,
    spacings,
    syntheticSpacings,
    inputs,
    cases,
  };
}

// `Math.nextUp`/`nextDown` do not exist; these are the two-line equivalents,
// used only to place a threshold one representable step off a measured value.
function nextUp(value) {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  buffer.setBigUint64(0, buffer.getBigUint64(0) + 1n);
  return buffer.getFloat64(0);
}

function nextDown(value) {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  buffer.setBigUint64(0, buffer.getBigUint64(0) - 1n);
  return buffer.getFloat64(0);
}
