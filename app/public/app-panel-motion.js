// =========================================================================
//  app-panel-motion.js — the pull-up panel's physics, as arithmetic
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
//
//  §4.3 gives the panel three semantic stops and §9.3 says which one a
//  release lands on: "从速度投射决定停靠点，而不是从松手瞬间的位置". That is a
//  formula, and a formula written inside a pointerup handler cannot be tested
//  — which matters here because iOS reimplements the same three stops in
//  RailKit's PanelDetentResolver. The two are only known to agree because
//  both are checked against the same figures (test/panel-motion.test.mjs and
//  PanelDetentResolverTests.swift assert the same cases).
//
//  Nothing in this file touches the DOM, reads a global, or runs at load
//  time. That is a hard requirement, not tidiness: the precompute VM replays
//  this family with no document, and app-modal.js was made DOM-free at load
//  for the same reason.
// =========================================================================

// §4.3's three stops, smallest first. The array order IS the semantic order —
// nearestPanelDetent and the grabber's tap cycle both read it that way.
const PANEL_DETENTS = ["docked", "half", "full"];

// UIScrollView's own deceleration rate. Not a constant that happened to feel
// right: matching the system's rate is what makes the panel come to rest where
// a hand trained on every other scroll surface expects it to.
const PANEL_DECELERATION_RATE = 0.998;

// Apple's rubber-band constant. The curve leaves the limit at this slope, so
// the first point of overshoot already costs the finger 45% of its travel, and
// it gets stiffer from there.
const PANEL_RUBBER_BAND_CONSTANT = 0.55;

// A drag has to declare a direction before it counts as one, or a tap on the
// grabber that wobbles two pixels becomes a resize. §9.3: about 8–10 px.
const PANEL_DRAG_SLOP_PX = 8;

// How many pointermove samples the release velocity is measured over. Five is
// roughly the last 60–80 ms at a typical sample rate: long enough that one
// jittery frame cannot dominate, short enough that a slow drag which ended in
// a flick still reports the flick.
const PANEL_VELOCITY_SAMPLES = 5;

// How far a flick would carry if nothing stopped it.
//
// The closed form of exponential deceleration: a body released at `velocity`
// px/s decaying by `rate` per millisecond travels a further v/1000 · r/(1-r).
// At the default rate that is 499 ms of the release velocity, which is why a
// fast flick from just above docked reaches full without the finger ever
// travelling that far.
function projectPanelVelocity(
  velocityPixelsPerSecond,
  decelerationRate = PANEL_DECELERATION_RATE,
) {
  const velocity = Number(velocityPixelsPerSecond);
  if (!Number.isFinite(velocity)) return 0;
  // A rate outside (0, 1) is not a deceleration — refuse rather than divide by
  // zero and move the panel to Infinity.
  if (!(decelerationRate > 0 && decelerationRate < 1)) return 0;
  return (velocity / 1000) * (decelerationRate / (1 - decelerationRate));
}

// How far past its limit the panel actually moves.
//
// Two properties matter and neither is negotiable: it is progressive, so the
// gesture never feels like it snagged, and it asymptotes at `dimension` rather
// than clamping, so it never feels like it broke. A hard clamp at the extreme
// reads to the hand as the panel having stopped tracking the finger.
function rubberBandDistance(
  overshoot,
  dimension,
  constant = PANEL_RUBBER_BAND_CONSTANT,
) {
  const past = Number(overshoot);
  const span = Number(dimension);
  if (!(past > 0) || !(span > 0) || !(constant > 0)) return 0;
  return (past * span * constant) / (span + constant * past);
}

// The size the panel is drawn at for a given finger position: 1:1 between the
// extremes, resisted beyond them.
function constrainedPanelSize(rawSize, minSize, maxSize, dimension) {
  const size = Number(rawSize);
  if (!Number.isFinite(size)) return minSize;
  const span = Number(dimension) > 0 ? Number(dimension) : maxSize;
  if (size < minSize) return minSize - rubberBandDistance(minSize - size, span);
  if (size > maxSize) return maxSize + rubberBandDistance(size - maxSize, span);
  return size;
}

// The stop nearest a projected size.
//
// Nearest, not "the next one in the direction of travel": a slow drag that
// crosses most of the way to the next stop should land there, and a flick that
// would overshoot full by a screen height should still land on full rather
// than on nothing.
//
// `detents` is [{ state, size }, ...]. An exact tie keeps the SMALLER stop —
// a release exactly halfway has expressed no preference, and settling
// downwards leaves more map visible, which is the choice a map-first layout
// should make on the reader's behalf.
function nearestPanelDetent(projectedSize, detents) {
  if (!Array.isArray(detents) || detents.length === 0) return null;
  const ordered = [...detents].sort((a, b) => a.size - b.size);
  let best = ordered[0];
  for (const candidate of ordered.slice(1)) {
    if (
      Math.abs(candidate.size - projectedSize) <
      Math.abs(best.size - projectedSize)
    )
      best = candidate;
  }
  return best;
}

// Release velocity in px/s, from the tail of the drag's size/time samples.
//
// Measured over several samples rather than the last pair because a single
// pointermove pair can straddle a dropped frame and report a velocity an order
// of magnitude off — which, projected through 499 ms, is the difference
// between half and full.
function panelReleaseVelocity(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const recent = samples.slice(-PANEL_VELOCITY_SAMPLES);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const seconds = (last.time - first.time) / 1000;
  if (!(seconds > 0)) return 0;
  const velocity = (last.size - first.size) / seconds;
  return Number.isFinite(velocity) ? velocity : 0;
}

// The whole release decision: project, then snap.
function panelDetentForRelease(currentSize, samples, detents) {
  const velocity = panelReleaseVelocity(samples);
  return nearestPanelDetent(
    Number(currentSize) + projectPanelVelocity(velocity),
    detents,
  );
}

// =========================================================================
//  The settle — §9.3's "从手指速度交接给 spring，避免释放瞬间停顿"
// =========================================================================
//
// Choosing the right stop is only half of a release. The other half is HOW the
// panel travels the remaining distance, and a fixed easing curve always starts
// that journey from a standstill: the finger is moving at 1,800 px/s, it lifts,
// and the panel stops dead for one frame before starting again. That stall is
// the single most legible difference between a sheet that feels attached to
// the hand and one that feels like a form control.
//
// So the settle is a real spring, seeded with the velocity the finger left.

// Natural frequency, rad/s. Critically damped at this ω a still release lands
// in ~340 ms — which is where the fixed 320 ms curve this replaces already
// put it, so nothing about the app's ordinary rhythm changes. Overshoot can
// therefore only come from momentum the reader actually supplied, which is the
// one case §9.2 allows it in.
const PANEL_SPRING_OMEGA = 26;

// How close to the target counts as arrived. 0.15% of the travel is well under
// one device pixel for any distance this panel moves.
const PANEL_SETTLE_EPSILON = 0.0015;

// Even a spring that is already home needs a frame or two, and none of them
// may run past the point where a "settle" reads as a "transition".
const PANEL_SETTLE_MIN_MS = 120;
const PANEL_SETTLE_MAX_MS = 640;

// Roughly one control point per frame at 60 Hz. CSS `linear()` interpolates
// straight lines between its points, so this is the resolution at which the
// curve stops being distinguishable from the spring it samples.
const PANEL_SETTLE_SAMPLE_MS = 16;

// A normalised velocity beyond this is not a flick, it is a rounding artefact:
// a 2 px remaining distance with a 1,500 px/s release divides out to 750/s,
// and a curve built from that spends its whole duration overshooting. The cap
// costs nothing on real gestures, where the remaining distance is tens of
// pixels or more.
const PANEL_SETTLE_MAX_NORMALIZED_VELOCITY = 120;

// Remaining fraction of the travel at time `seconds`, for a critically damped
// spring released with normalised velocity `v0` (in units of travel per
// second, positive meaning "already heading towards the target").
//
//   e(t) = (1 + (ω − v₀)·t)·e^(−ωt),  e(0) = 1, e′(0) = −v₀
//
// A v₀ greater than ω makes the bracket negative, e crosses zero, and the
// panel passes the stop before coming back — which is exactly the overshoot a
// hard flick should produce and a fixed curve cannot.
function panelSpringRemainder(seconds, v0, omega = PANEL_SPRING_OMEGA) {
  const t = Number(seconds);
  if (!(t > 0)) return 1;
  return (1 + (omega - v0) * t) * Math.exp(-omega * t);
}

// Progress along the travel: 0 at release, 1 at the stop.
function panelSpringProgress(seconds, v0, omega = PANEL_SPRING_OMEGA) {
  return 1 - panelSpringRemainder(seconds, v0, omega);
}

// Release velocity expressed as "travels per second", clamped.
//
// Signed so that positive always means *towards* the landing stop, whichever
// direction that is: a flick up that lands on full and a flick down that lands
// on docked produce the same curve, which is what makes the panel feel like
// one object rather than two behaviours.
function normalizedPanelVelocity(distancePx, velocityPixelsPerSecond) {
  const distance = Number(distancePx);
  const velocity = Number(velocityPixelsPerSecond);
  if (!Number.isFinite(distance) || !Number.isFinite(velocity)) return 0;
  if (Math.abs(distance) < 0.5) return 0;
  const normalized = velocity / distance;
  const cap = PANEL_SETTLE_MAX_NORMALIZED_VELOCITY;
  return Math.max(-cap, Math.min(cap, normalized));
}

// How long the spring takes to be indistinguishable from arrived.
//
// Scanned from the END rather than the start, because a spring with overshoot
// passes exactly through the target on its way past it: a forward scan for
// "close enough" would stop at that crossing and cut the animation off at the
// precise moment the panel is moving fastest.
function panelSettleDuration(v0, omega = PANEL_SPRING_OMEGA) {
  for (let ms = PANEL_SETTLE_MAX_MS; ms >= PANEL_SETTLE_MIN_MS; ms -= 1) {
    if (Math.abs(panelSpringRemainder(ms / 1000, v0, omega)) >= PANEL_SETTLE_EPSILON)
      return Math.min(PANEL_SETTLE_MAX_MS, ms + 1);
  }
  return PANEL_SETTLE_MIN_MS;
}

// The settle as CSS can run it: a duration, and a `linear()` easing sampled
// from the spring above.
//
// `linear()` rather than a cubic-bezier because a bezier cannot express
// overshoot-and-return at all — it is monotone in the only two control points
// it has — and because matching a spring's *initial slope* with a bezier still
// leaves the rest of the curve to guesswork. Sampling states the whole curve.
//
// Returns `{ durationMs: 0, easing: "linear" }` when there is nothing to
// travel; the caller then places the panel without animating it.
function panelSettleMotion(distancePx, velocityPixelsPerSecond, options = {}) {
  const omega = Number(options.omega) > 0 ? Number(options.omega) : PANEL_SPRING_OMEGA;
  const distance = Number(distancePx);
  if (!Number.isFinite(distance) || Math.abs(distance) < 0.5)
    return { durationMs: 0, easing: "linear" };

  const v0 = normalizedPanelVelocity(distance, velocityPixelsPerSecond);
  const durationMs = panelSettleDuration(v0, omega);
  const steps = Math.max(
    8,
    Math.min(48, Math.round(durationMs / PANEL_SETTLE_SAMPLE_MS)),
  );
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    if (i === 0) points.push(0);
    else if (i === steps) points.push(1);
    else
      points.push(
        Number(
          panelSpringProgress((durationMs * (i / steps)) / 1000, v0, omega).toFixed(
            4,
          ),
        ),
      );
  }
  return { durationMs, easing: `linear(${points.join(", ")})` };
}

// The stop a tap on the grabber advances to. It wraps, because a handle that
// stops doing anything at the top is a handle the reader taps twice and then
// gives up on; the drag is still the precise control.
function nextPanelDetent(state) {
  const index = PANEL_DETENTS.indexOf(state);
  if (index < 0) return PANEL_DETENTS[0];
  return PANEL_DETENTS[(index + 1) % PANEL_DETENTS.length];
}

// Exported for the Node test harness. The browser reads these off the shared
// global scope like every other module in this family; `module` is guarded
// exactly as the two browser/Node shared libraries guard it.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PANEL_DETENTS,
    PANEL_DECELERATION_RATE,
    PANEL_RUBBER_BAND_CONSTANT,
    PANEL_DRAG_SLOP_PX,
    PANEL_SPRING_OMEGA,
    PANEL_SETTLE_MIN_MS,
    PANEL_SETTLE_MAX_MS,
    projectPanelVelocity,
    rubberBandDistance,
    constrainedPanelSize,
    nearestPanelDetent,
    panelReleaseVelocity,
    panelDetentForRelease,
    panelSpringRemainder,
    panelSpringProgress,
    normalizedPanelVelocity,
    panelSettleDuration,
    panelSettleMotion,
    nextPanelDetent,
  };
}
