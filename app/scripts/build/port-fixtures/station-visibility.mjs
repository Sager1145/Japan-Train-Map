// =========================================================================
//  station-visibility.json — the zoom at which a line's station dots appear
//
//  rail-network.js decides LINE visibility from length (minZoomForLength,
//  already covered by visibility.json) and STATION-DOT visibility from
//  density: a line whose stops sit 300 m apart would draw its beads on top of
//  one another at the zoom where the line itself first appears, so the dots
//  are held back until there is room for them. stationMinZoomForLine is that
//  rule, and it is the only part of the level-of-detail code that does real
//  floating-point arithmetic — a log2, a Math.round and two clamps — which is
//  exactly the shape of thing a port gets subtly wrong.
//
//  Every expected value comes from the exported function itself, and the
//  package cases feed it the arguments the real network build feeds it, taken
//  from buildNetworkFromCompactPackage rather than re-derived here. The one
//  constant recomputed below (STATION_LOD_K) selects INPUTS and never an
//  answer; see the comment on it.
// =========================================================================

export const name = "station-visibility.json";

// A copy of rail-network.js's STATION_LOD_K — the km one 256 px tile spans at
// latitude 35, which is the scale the density ladder is measured against. It
// is here ONLY to pick the adversarial spacings below; it never produces an
// expected value. If it ever drifts from the real constant the synthetic cases
// quietly stop landing on rounding ties, so each one records whether it still
// is one (`exactTie`) and the Swift test counts them rather than trusting the
// arithmetic here.
const STATION_LOD_K = (22 * 40075.017) / (256 * Math.cos((35 * Math.PI) / 180));

// The average spacing whose density lands exactly on zoom `z`. A half-integer
// `z` is a Math.round tie; an integer `z` sits precisely on a ladder rung.
const spacingForZoom = (z) => STATION_LOD_K / Math.pow(2, z);

export function build({ RailNetwork, railPackage }) {
  const cases = [];

  const emit = (label, lineMinZoom, totalKm, stationCount, extra = {}) => {
    const spacingKm = stationCount >= 2 ? totalKm / (stationCount - 1) : null;
    cases.push({
      label,
      lineMinZoom,
      totalKm,
      stationCount,
      // Diagnostics, for whoever reads a failure. Nothing on the Swift side
      // decodes them except `exactTie`.
      spacingKm,
      densityRaw:
        spacingKm != null && Number.isFinite(spacingKm)
          ? Math.log2(STATION_LOD_K / spacingKm)
          : null,
      ...extra,
      stationMinZoom: RailNetwork.stationMinZoomForLine(
        lineMinZoom,
        totalKm,
        stationCount,
      ),
    });
  };

  // ── every shipped line, all five countries ────────────────────────────
  // Not a sample. This function decides what a reader sees, and the packages
  // are the only place the real spacing distribution lives: 255 m between
  // Hong Kong tram stops at one end, tens of km between Hokkaido stations at
  // the other. 804 lines is cheap.
  //
  // The arguments come out of a real buildNetworkFromCompactPackage rather
  // than being re-derived, because the call site has an asymmetry that is the
  // easiest thing in this port to get wrong: `minZoom` is the whole
  // visibility GROUP's length-derived zoom, so every administrative piece of
  // one physical railway vanishes together — but `km` is the line's OWN
  // length, paired with its own station count. Building the network is how
  // the fixture states that pairing without restating the grouping rule.
  for (const country of ["mo", "hk", "tw", "kr", "jp"]) {
    const pkg = railPackage(country);
    const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
    for (const line of pkg.lines) {
      const built = network.lineById.get(line.id);
      emit(`${country}:${line.id}`, built.minZoom, built.km, line.stations.length, {
        country,
        lineId: line.id,
        visibilityKm: built.visibilityKm,
      });
    }
  }

  // ── the guard, which no shipped line reaches ──────────────────────────
  // 0 of 804 lines have fewer than two stations or a non-positive length, so
  // the early return is untested by real data — and it carries a quirk worth
  // pinning: it hands back `lineMinZoom` RAW. Neither clamp is applied on
  // that path, so it is the one way this function answers above the cap.
  // (A -0 total takes the guard too, in both languages, since `-0 <= 0`; it
  // is not a case here because JSON cannot carry the sign of a zero.)
  emit("guard: a line with a single station", 5, 12.5, 1);
  emit("guard: a line with no stations at all", 5, 12.5, 0);
  emit("guard: two stations but zero total km", 6, 0, 2);
  emit("guard: negative km", 6, -40, 9);
  emit("guard: the cap does NOT apply on this path", 99, 0, 5);
  emit("guard: nor is a negative floored", -3, 0, 5);

  // ── Math.round ties ───────────────────────────────────────────────────
  // The trap this fixture exists for. JavaScript's Math.round breaks a tie
  // toward +∞ (`Math.round(-2.5) === -2`); Swift's `.rounded()` breaks it away
  // from zero (`(-2.5).rounded() == -3`). A port that reaches for the obvious
  // standard-library call is wrong here and nowhere else — but only where the
  // tie survives Math.max, which means lineMinZoom has to sit below it. No
  // shipped line comes close (the nearest is 0.001 away, kr-gwangjuseon at
  // 9.4990), so these are synthetic on purpose.
  //
  // The negative ties need average spacings of 12,000–48,000 km, which makes
  // them the enormous-spacing case as well: a km column read as metres, or a
  // coordinate typo that stretches one interval across the planet, lands
  // here, and the answer still has to be a zoom the map can filter on.
  for (const [z, floor] of [
    [-3.5, -9],
    [-2.5, -5],
    [-1.5, -4],
    [1.5, -2],
    [6.5, 0],
    [10.5, 0],
    [13.5, 0],
  ]) {
    const spacing = spacingForZoom(z);
    emit(`tie: density lands exactly on ${z}`, floor, spacing, 2, {
      // Recorded rather than assumed: K / 2^z only round-trips back through
      // the division for some z, and would stop doing so entirely if the
      // constant moved. The Swift test counts the surviving ties.
      exactTie: Math.log2(STATION_LOD_K / spacing) === z,
    });
  }
  // The same enormous spacing under an ordinary line zoom, where Math.max
  // discards the density entirely — a branch 0 of 804 shipped lines take.
  emit("enormous spacing, ordinary line zoom", 3, spacingForZoom(-2.5), 2);
  emit("sparse trunk: the line's own zoom wins", 7, 700, 2);

  // ── the cap ───────────────────────────────────────────────────────────
  // 41 shipped lines already clamp at 14 — Hong Kong's trams and light rail,
  // a quarter of a kilometre between stops. These pin the boundary itself.
  emit("cap: density lands exactly on 14", 3, spacingForZoom(14), 2);
  emit("cap: one zoom past it", 3, spacingForZoom(15), 2);
  emit("cap: far past it", 3, spacingForZoom(30), 2);
  emit("cap: applies even when lineMinZoom exceeds it", 20, 1e300, 2);
  // K / 1e-306 overflows to Infinity, so the log2 and the Math.round are
  // Infinity too and only the cap brings the answer back. A port that
  // narrows to an integer before clamping traps here instead of saying 14.
  emit("cap: spacing so small the quotient overflows", 3, 1e-306, 2);
  emit("floor: spacing so large the density underflows", 4, 1e300, 2);

  // ── negative zero out of Math.round ───────────────────────────────────
  // Math.round(-0.26) is -0, and `Math.max(0, -0)` is +0 in JavaScript while
  // Swift's `max` — written `y >= x ? y : x` — hands back -0.0. Both become
  // integer 0, so the difference cannot escape this function; pinned so that
  // stays a measured fact rather than an assumption.
  emit("negative zero: density rounds to -0", 0, spacingForZoom(-0.26), 2);
  emit("negative zero: and then loses to a real floor", 5, spacingForZoom(-0.26), 2);

  // ── gaps, not stations ────────────────────────────────────────────────
  // The average divides by stationCount - 1. Dividing by stationCount instead
  // is off by a factor of n/(n-1), which at two stations is a whole octave —
  // one entire zoom level. Every two-station case below already catches that;
  // this one catches the subtler three-station form (factor 1.5, still enough
  // to move the rounded answer).
  emit("gaps, not stations: three stations span two gaps", 3, 2 * spacingForZoom(9), 3);

  // ── the ordinary ladder, one rung at a time ───────────────────────────
  // Dividing K by an exact power of two is exact, so these sit precisely on
  // an integer instead of near one: an off-by-one in the ladder shows up as a
  // whole zoom level rather than as a boundary case.
  for (let z = 4; z <= 15; z += 1)
    emit(`ladder: density exactly ${z}`, 3, spacingForZoom(z), 2);

  return {
    describes: "rail-network.js stationMinZoomForLine (the station-density ladder)",
    contract:
      "Station dots are held back until the average gap between them is worth " +
      "at least STATION_DOT_GAP_PX (22 px), so density = round(log2(K / " +
      "average spacing km)) where K is the km one 256 px tile spans at " +
      "latitude 35. Two clamps then apply, and ONLY on the arithmetic path: " +
      "stations may declutter EARLIER than their line but never outlive it " +
      "(never below the line's own length-derived minzoom), and never survive " +
      "past zoom 14. The early return for a degenerate line applies NEITHER " +
      "clamp — it hands the line's minzoom straight back, which is the one " +
      "way this function answers above the cap. The average divides by the " +
      "number of GAPS (stationCount - 1), not of stations; and the km it " +
      "divides is the line's own, while the minzoom it is floored by belongs " +
      "to the line's whole visibility group.",
    cases,
  };
}
