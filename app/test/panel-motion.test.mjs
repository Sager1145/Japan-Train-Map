// JRM_FLIGHTY_UI_REFACTOR_SPEC.md §4.3 and §9.3 — the spec lives in the
// JTM-iOS-App repository — over the same figures the
// Swift port asserts in
// JTM-iOS-App 仓库的
// ios/RailKit/Tests/RailPresentationTests/PanelDetentResolverTests.swift。
//
// Both platforms implement the panel's physics separately — one in SwiftUI's
// gesture layer, one in pointer events — and the only thing that keeps them
// the same panel is that both are checked against these numbers. Where a case
// exists in both files it is written with the same detents (100 / 450 / 800)
// and the same velocities, so a divergence shows up as one file failing.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  PANEL_DETENTS,
  PANEL_DECELERATION_RATE,
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
  PANEL_SETTLE_MIN_MS,
  PANEL_SETTLE_MAX_MS,
  nextPanelDetent,
} = require("../public/app-panel-motion.js");

// The numbers inside a `linear(...)` easing, as the browser would read them.
function easingPoints(easing) {
  const inner = /^linear\((.*)\)$/.exec(easing);
  assert.ok(inner, `not a linear() easing: ${easing}`);
  return inner[1].split(",").map((value) => Number(value.trim()));
}

const DETENTS = [
  { state: "docked", size: 100 },
  { state: "half", size: 450 },
  { state: "full", size: 800 },
];

// A drag that ends at `size` having travelled at `velocity` px/s.
function samplesEndingAt(size, velocity) {
  const step = 16; // one frame
  return [4, 3, 2, 1, 0].map((back) => ({
    size: size - (velocity * back * step) / 1000,
    time: 1000 - back * step,
  }));
}

// ── §4.3: three stops, and only three ──────────────────────────────────────

test("only docked, half and full exist", () => {
  assert.deepEqual(PANEL_DETENTS, ["docked", "half", "full"]);
});

test("tapping the grabber cycles through all three and wraps", () => {
  assert.equal(nextPanelDetent("docked"), "half");
  assert.equal(nextPanelDetent("half"), "full");
  // Wraps rather than stopping: a handle that stops doing anything is a
  // handle the reader taps twice and then gives up on.
  assert.equal(nextPanelDetent("full"), "docked");
  assert.equal(nextPanelDetent("peek"), "docked"); // the retired name
});

// ── §9.3: the stop comes from where the flick was going ────────────────────

test("a fast upward release can skip half and land on full", () => {
  const projected = 180 + projectPanelVelocity(1500);
  assert.ok(Math.abs(projected - 928.5) < 0.001);
  assert.equal(nearestPanelDetent(projected, DETENTS).state, "full");
});

test("a fast downward release can skip half and land on docked", () => {
  const projected = 700 + projectPanelVelocity(-1500);
  assert.equal(nearestPanelDetent(projected, DETENTS).state, "docked");
});

test("zero velocity chooses the nearest detent", () => {
  assert.equal(nearestPanelDetent(120, DETENTS).state, "docked");
  assert.equal(nearestPanelDetent(430, DETENTS).state, "half");
  assert.equal(nearestPanelDetent(780, DETENTS).state, "full");
});

test("a slow drag of the same distance stays where it was let go", () => {
  const flicked = panelDetentForRelease(200, samplesEndingAt(200, 900), DETENTS);
  const placed = panelDetentForRelease(200, samplesEndingAt(200, 0), DETENTS);
  assert.equal(flicked.state, "full");
  assert.equal(placed.state, "docked");
});

test("an exact tie settles downwards so the map stays visible", () => {
  assert.equal(nearestPanelDetent(275, DETENTS).state, "docked");
});

test("the projection matches UIScrollView's deceleration rate", () => {
  assert.equal(PANEL_DECELERATION_RATE, 0.998);
  // 499 ms of the release velocity — the closed form of the system's own
  // deceleration, which is why the panel rests where the hand expects.
  assert.ok(Math.abs(projectPanelVelocity(1000) - 499) < 0.000001);
});

test("projection is symmetric about the release point", () => {
  assert.ok(
    Math.abs(projectPanelVelocity(800) + projectPanelVelocity(-800)) < 1e-9,
  );
});

test("a degenerate deceleration rate projects nowhere rather than to infinity", () => {
  for (const rate of [0, 1, -0.5, 2]) {
    assert.equal(projectPanelVelocity(5000, rate), 0);
  }
  assert.equal(projectPanelVelocity(Number.NaN), 0);
});

// ── velocity measurement ───────────────────────────────────────────────────

test("release velocity is measured over several samples, not the last pair", () => {
  const samples = samplesEndingAt(400, 600);
  assert.ok(Math.abs(panelReleaseVelocity(samples) - 600) < 1);
});

test("a sample set that cannot express a velocity reports zero", () => {
  assert.equal(panelReleaseVelocity([]), 0);
  assert.equal(panelReleaseVelocity([{ size: 10, time: 0 }]), 0);
  // Two samples at the same instant: a division by zero waiting to happen.
  assert.equal(
    panelReleaseVelocity([
      { size: 10, time: 5 },
      { size: 90, time: 5 },
    ]),
    0,
  );
});

// ── §9.3: resisted past the ends, never clamped ────────────────────────────

test("the rubber band never hard clamps at the boundary", () => {
  let previous = constrainedPanelSize(800, 100, 800, 900);
  assert.equal(previous, 800);
  for (let overshoot = 5; overshoot <= 400; overshoot += 5) {
    const size = constrainedPanelSize(800 + overshoot, 100, 800, 900);
    // Still moving — a clamp would repeat the previous value…
    assert.ok(size > previous, `clamped at +${overshoot}`);
    // …but always less than the raw finger travel, which is what makes it
    // read as resistance rather than as tracking.
    assert.ok(size < 800 + overshoot);
    previous = size;
  }
});

test("resistance applies below docked as well as above full", () => {
  const size = constrainedPanelSize(100 - 120, 100, 800, 900);
  assert.ok(size < 100);
  assert.ok(size > 100 - 120);
});

test("inside the stops the panel tracks the finger exactly", () => {
  for (const raw of [100, 275, 450, 620, 800]) {
    assert.equal(constrainedPanelSize(raw, 100, 800, 900), raw);
  }
});

test("resistance asymptotes to the dimension it is scaled against", () => {
  const huge = rubberBandDistance(1_000_000, 900);
  assert.ok(huge < 900);
  assert.ok(huge > 890);
});

test("a non-overshoot moves nothing", () => {
  assert.equal(rubberBandDistance(0, 900), 0);
  assert.equal(rubberBandDistance(-40, 900), 0);
  assert.equal(rubberBandDistance(40, 0), 0);
});

test("the curve starts at the constant and only gets stiffer", () => {
  // Apple's curve leaves the limit at slope `c`, so the first point of
  // overshoot already costs the finger 45% of its travel.
  assert.ok(Math.abs(rubberBandDistance(0.001, 900) / 0.001 - 0.55) < 0.001);
  let previousGain = Number.POSITIVE_INFINITY;
  let previous = 0;
  for (let overshoot = 20; overshoot <= 400; overshoot += 20) {
    const moved = rubberBandDistance(overshoot, 900);
    const gain = moved - previous;
    assert.ok(gain < previousGain);
    previousGain = gain;
    previous = moved;
  }
});

// ── §9.3: "从手指速度交接给 spring，避免释放瞬间停顿" ───────────────────────

test("the settle starts at the release and ends at the stop", () => {
  const points = easingPoints(panelSettleMotion(300, 0).easing);
  assert.equal(points[0], 0);
  assert.equal(points[points.length - 1], 1);
  assert.ok(points.length >= 9, "too coarse to be distinguishable from steps");
});

test("a still release settles on the rhythm the fixed curve had", () => {
  // The 320 ms cubic-bezier this replaces was right for a release from rest;
  // only the momentum case was wrong. Nothing else in the app should change
  // pace because the settle became a spring.
  const { durationMs } = panelSettleMotion(300, 0);
  assert.ok(durationMs > 280 && durationMs < 400, `${durationMs}ms`);
});

test("the settle leaves at the speed the finger did", () => {
  // The defect this fixes: a finger travelling 1,800 px/s lifts, and a fixed
  // easing curve begins the settle at zero velocity — one frame of dead stop
  // that reads as the panel having let go of the hand.
  //
  // Asserted as the derivative at t = 0, because that IS the handoff: p′(0)
  // must equal the normalised release velocity and nothing else.
  const dt = 1e-5;
  for (const v0 of [0, 3, 6, 40, -8]) {
    assert.ok(
      Math.abs(panelSpringProgress(dt, v0) / dt - v0) < 0.01,
      `p′(0) is not ${v0}`,
    );
  }
  // And the sampled curve carries it: one frame in, a flick has covered
  // meaningfully more of the travel than a release from rest.
  const first = (motion) => {
    const points = easingPoints(motion.easing);
    return points[1] / (motion.durationMs / (points.length - 1));
  };
  assert.ok(
    first(panelSettleMotion(300, 1800)) > first(panelSettleMotion(300, 0)) * 1.5,
  );
});

test("only a flick overshoots; a release from rest never does", () => {
  const still = easingPoints(panelSettleMotion(300, 0).easing);
  assert.ok(still.every((p) => p <= 1));
  // §9.2 allows overshoot only where the reader supplied the momentum.
  const flicked = easingPoints(panelSettleMotion(40, 2400).easing);
  assert.ok(flicked.some((p) => p > 1), "a hard flick should carry past");
  assert.equal(flicked[flicked.length - 1], 1);
});

test("a release moving AWAY from the stop still arrives", () => {
  // Possible whenever the projection lands back where the drag came from: the
  // finger is still travelling down as it lifts, and docked is the nearest
  // stop upwards. The panel must give ground first — anything else is the
  // same dead stop, mirrored.
  const points = easingPoints(panelSettleMotion(300, -3000).easing);
  assert.ok(points[1] < 0, `it should give ground first, got ${points[1]}`);
  assert.equal(points[points.length - 1], 1);
  assert.ok(points.every((p) => Number.isFinite(p)));
});

test("no travel means no animation to run", () => {
  assert.equal(panelSettleMotion(0, 1800).durationMs, 0);
  assert.equal(panelSettleMotion(0.2, 1800).durationMs, 0);
  assert.equal(panelSettleMotion(NaN, 1800).durationMs, 0);
});

test("the settle is bounded at both ends whatever it is handed", () => {
  for (const [distance, velocity] of [
    [4, 6000],
    [900, -6000],
    [300, 0],
    [1, 1],
    [800, 12000],
  ]) {
    const { durationMs } = panelSettleMotion(distance, velocity);
    assert.ok(durationMs >= PANEL_SETTLE_MIN_MS, `${durationMs}ms`);
    assert.ok(durationMs <= PANEL_SETTLE_MAX_MS, `${durationMs}ms`);
  }
});

test("a tiny remaining distance cannot divide out into an absurd curve", () => {
  // 2 px left with a 1,500 px/s release normalises to 750 travels/second, and
  // a spring built from that spends its whole duration overshooting.
  assert.equal(normalizedPanelVelocity(2, 1500), 120);
  assert.equal(normalizedPanelVelocity(-2, 1500), -120);
  assert.equal(normalizedPanelVelocity(0, 1500), 0);
  assert.equal(normalizedPanelVelocity(300, 1800), 6);
});

test("the spring is critically damped: no bounce without momentum", () => {
  assert.equal(panelSpringRemainder(0, 0), 1);
  let previous = 1;
  for (let ms = 10; ms <= 400; ms += 10) {
    const remainder = panelSpringRemainder(ms / 1000, 0);
    assert.ok(remainder < previous, `grew at ${ms}ms`);
    assert.ok(remainder >= 0, `crossed the stop at ${ms}ms`);
    previous = remainder;
  }
  assert.ok(panelSpringProgress(0.4, 0) > 0.99);
});

test("the settle duration is measured from the END of the curve", () => {
  // A spring with overshoot passes exactly through the target on the way past
  // it. A forward scan for "close enough" stops at that crossing and cuts the
  // animation off at the moment the panel is moving fastest.
  const overshooting = panelSettleDuration(90);
  assert.ok(Math.abs(panelSpringRemainder(overshooting / 1000, 90)) < 0.01);
  assert.ok(
    Math.abs(panelSpringRemainder(overshooting / 2000, 90)) > 0.05,
    "the mid-point of the curve is not already settled",
  );
});

// ── degenerate inputs ──────────────────────────────────────────────────────

test("an empty detent set returns nothing rather than throwing", () => {
  assert.equal(nearestPanelDetent(400, []), null);
  assert.equal(nearestPanelDetent(400, null), null);
});

test("detents are compared by size, whatever order they arrive in", () => {
  const shuffled = [DETENTS[2], DETENTS[0], DETENTS[1]];
  assert.equal(nearestPanelDetent(430, shuffled).state, "half");
});

// ── the two platforms agree ────────────────────────────────────────────────

test("the module runs with no DOM, as the precompute sandbox requires", () => {
  // Every consumer of the app family replays it in a Node vm with no
  // document. A module that touched one at load time would break the offline
  // route export, not merely this test.
  assert.equal(typeof document, "undefined");
  assert.equal(nearestPanelDetent(450, DETENTS).state, "half");
});
