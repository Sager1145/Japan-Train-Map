#!/usr/bin/env node
/*
 * validate-corner-radius.mjs — the standing corner-radius audit.
 *
 * One rule: WHERE THE SURVEYED ALIGNMENT TURNS ON A CURVE THE READER COULD
 * SEE, THE LINE THE RENDERER ACTUALLY DRAWS THERE IS STILL A CURVE. Not a
 * corner with the curve's endpoints, not "within tolerance of" the curve — a
 * turn delivered over enough screen path that the eye reads a radius.
 *
 * The defect this exists to catch is not in the geometry. The package is
 * surveyed track and turns the way track turns. It is manufactured on the way
 * to the screen: MapLibre feeds every GeoJSON source through geojson-vt, which
 * drops vertices per zoom, and Douglas–Peucker keeps the point that deviates
 * MOST — the apex — while dropping the transition points either side of it.
 * Generalisation therefore does not roughen a curve, it replaces the curve
 * with its extremal polyline. Pull far enough back and a surveyed 400 m arc is
 * drawn as one kink.
 *
 * Three things are measured at every audited zoom and reported apart, because
 * only the first is anybody's fault. The simplifier is replayed exactly —
 * geojson-vt's scorer is transcribed below, tie-break included, and checked
 * against the tiles MapLibre really built (a switchback is the shape that
 * catches a wrong tie-break, because a retrace hands the scorer two vertices
 * at the SAME coordinate):
 *
 *   collapsed  (corner_collapsed_by_generalisation)
 *       the drawn line turns at ONE vertex, while the alignment underneath it
 *       turns on an arc whose screen radius clears the minimum below. The
 *       reader could have seen that curve and the renderer threw it away.
 *       This is the rule. WARNING from 60°, ERROR from 90° — the deflection at
 *       which a reader stops calling it a bend and calls it a corner.
 *
 *   below-pen
 *       the same kink, but the alignment's own arc is tighter than the stroke
 *       drawing it. No tolerance, no LOD budget and no chamfer can show a
 *       radius the pen is wider than: at a nationwide view a 372 m curve is a
 *       fifth of a pixel. Counted, never failed — honesty about the physics,
 *       not a defect to chase.
 *
 *   data-kink
 *       the alignment turns at one vertex too: two straights meeting with no
 *       transition surveyed between them, so the radius it presents is under
 *       half a stroke and the round join has already drawn all the rounding
 *       there is. Nothing on the render side can round what was never curved.
 *       A geometry-layer question, counted here so the render-side number is
 *       not quietly carrying it.
 *
 * And one thing that must NOT be smoothed, checked from the other direction:
 *
 *   reversal_flattened_by_generalisation
 *       a real switchback — 姨捨, 出雲坂根, 真幸, 立野, 常紋, 出山, 上大平台,
 *       二萬平, 阿里山, 神木 — folds back on itself at one vertex ON PURPOSE.
 *       The audit finds every fold in the package by the topology audit's own
 *       criterion (SHARP_TURN_DEGREES over SHARP_TURN_RUN_METERS of real track
 *       each way) and requires the drawn line to still fold there. A corner
 *       audit that only ever asked for rounder corners would happily accept a
 *       renderer that ironed the switchbacks flat.
 *
 * Usage:
 *   node scripts/validation/validate-corner-radius.mjs                # everywhere
 *   node scripts/validation/validate-corner-radius.mjs --country jp
 *   node scripts/validation/validate-corner-radius.mjs --zooms 8,12,16
 *   node scripts/validation/validate-corner-radius.mjs --tolerance 0.125
 *   node scripts/validation/validate-corner-radius.mjs --min-radius-strokes 0
 *   node scripts/validation/validate-corner-radius.mjs --reversals   # name them
 *   node scripts/validation/validate-corner-radius.mjs --json out.json
 *
 * Exit code is 0 unless --strict is given, in which case any ERROR fails.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import {
  distanceMeters,
  straightRunMeters,
  turnDegrees,
} from "../railway/lib/railway-topology.mjs";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

export const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

// ── the renderer, restated ──────────────────────────────────────────────────
// Read out of public/vendor/maplibre/maplibre-gl.js so the audit measures the
// renderer that ships rather than a remembered one:
//
//   GeoJSONSource      minzoom 0, maxzoom 18, tileSize 512
//   geojsonVtOptions   tolerance: _pixelsToTileUnits(style.tolerance ?? 0.375)
//                      where _pixelsToTileUnits(px) = px * (EXTENT / tileSize)
//   convert()          sqTolerance = (tolerance / ((1 << maxZoom) * EXTENT))²
//   createTile()       keep a vertex when its stored significance exceeds
//                      (tolerance / ((1 << z) * EXTENT))², and keep every
//                      vertex when z === maxZoom
//
// EXTENT cancels out of both, so the whole simplifier is one number: a vertex
// survives at zoom z when the polyline it sits on would move by more than
// `tolerance` CSS PIXELS without it. That makes the source's `tolerance`
// literally "how far, in screen pixels, the drawn line is allowed off the
// surveyed one" — and the audit works in the same unit throughout.
const GEOJSON_MAXZOOM = 18;
const TILE_SIZE = 512;

// Zooms audited by default. z18 and above are exempt by construction
// (createTile hands back every vertex at maxZoom), and below z6 the length LOD
// has taken all but the trunk lines off the map.
const DEFAULT_ZOOMS = [6, 8, 10, 12, 14, 16];

// ── the minimum screen radius ───────────────────────────────────────────────
// Not restated here. RAILWAY_STYLE.minCornerRadiusPx in railmap-style.js is
// the promise and carries its own derivation — one stroke width, because
// `line-join: round` has already rounded the ink to half a stroke and nothing
// tighter than that can show — and this audit reads it off the built style at
// each zoom, through the same railwayScale() ramp the stroke itself rides. A
// second opinion here is exactly the drift the mirror exists to prevent.
//
// This multiplier is the falsification handle: --min-radius-strokes 0 asks for
// no radius at all, and every kink on the map becomes a finding.
const MIN_CORNER_RADIUS_SCALE = 1;

// What counts as a corner at all, and how badly. Mirrors
// validate-station-render-anchoring.mjs, which draws the same three lines for
// the same reason: under 30° a joint is a railway on a curve and is not worth
// a row, 60° is worth a look, and 90° IS the right angle this audit exists to
// keep off the map.
const CORNER_REPORT_DEGREES = 30;
const CORNER_SUSPICIOUS_DEGREES = 60;
const CORNER_ERROR_DEGREES = 90;

// Below this a vertex is survey jitter rather than a turn, and including it
// would let a run of noise stand in for the ends of an arc.
const NOISE_DEGREES = 0.5;

// A corner both of whose arms are shorter on screen than the stroke is wide is
// inside its own ink: there is nothing sticking out to read as a corner. Those
// are counted and not reported.
const ARM_VISIBILITY_STROKES = 1;

// ── the reversals, restated from the topology audit ─────────────────────────
// validate-railway-topology.mjs SHARP_TURN_DEGREES / SHARP_TURN_RUN_METERS.
// The two audits must not hold separate opinions about what a fold is: this
// one asks that every fold the topology audit can see is still drawn, and the
// topology audit asks that no fold exists which real track does not justify.
const REVERSAL_DEGREES = 110;
const REVERSAL_RUN_METERS = 60;
const REVERSAL_RUN_CAP_METERS = 600;

const SEVERITY_ORDER = { PASS: 0, INFO: 1, WARNING: 2, ERROR: 3 };

// ── screen space ────────────────────────────────────────────────────────────

function metersPerPixel(zoom, latitude) {
  return (
    (40075016.686 * Math.cos((latitude * Math.PI) / 180)) /
    (TILE_SIZE * 2 ** zoom)
  );
}

/** The simplifier's threshold at zoom z, in the projected unit square. */
function toleranceUnitSquare(tolerancePx, zoom) {
  if (zoom >= GEOJSON_MAXZOOM) return 0;
  return tolerancePx / (TILE_SIZE * 2 ** zoom);
}

function projectX(longitude) {
  return longitude / 360 + 0.5;
}

function projectY(latitude) {
  const sin = Math.sin((latitude * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

// ── geojson-vt's simplifier, verbatim ───────────────────────────────────────
// simplify.js. Every vertex is scored ONCE, at maxZoom, with the squared
// distance to the chord of the sub-range its own recursion split; the per-zoom
// pass is then a plain threshold on that score. That is an approximation of
// Douglas–Peucker rather than Douglas–Peucker itself — a point's score is
// measured against a chord that may not survive to the zoom being drawn — and
// the gap between the two is one of the things this audit puts a number on.

function squaredSegmentDistance(px, py, x, y, bx, by) {
  let dx = bx - x;
  let dy = by - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = bx;
      y = by;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}

function simplifyRange(coords, first, last, squaredTolerance) {
  let maxSquared = squaredTolerance;
  const mid = first + ((last - first) >> 1);
  let minPosToMid = last - first;
  let index;
  for (let i = first + 3; i < last; i += 3) {
    const d = squaredSegmentDistance(
      coords[i],
      coords[i + 1],
      coords[first],
      coords[first + 1],
      coords[last],
      coords[last + 1],
    );
    if (d > maxSquared) {
      index = i;
      maxSquared = d;
    } else if (d === maxSquared) {
      const posToMid = Math.abs(i - mid);
      if (posToMid < minPosToMid) {
        index = i;
        minPosToMid = posToMid;
      }
    }
  }
  if (maxSquared > squaredTolerance) {
    if (index - first > 3) simplifyRange(coords, first, index, squaredTolerance);
    coords[index + 2] = maxSquared;
    if (last - index > 3) simplifyRange(coords, index, last, squaredTolerance);
  }
}

/** Each vertex's stored significance, exactly as convert.js computes it. */
function significanceOf(ring, tolerancePx) {
  const coords = new Float64Array(ring.length * 3);
  for (let i = 0; i < ring.length; i += 1) {
    coords[i * 3] = projectX(ring[i][0]);
    coords[i * 3 + 1] = projectY(ring[i][1]);
    coords[i * 3 + 2] = 0;
  }
  coords[2] = 1;
  coords[coords.length - 1] = 1;
  // convert.js scores against the threshold at maxZoom, so a vertex inside
  // the tolerance even at the closest tile is never stored as significant.
  const atMaxZoom = tolerancePx / (TILE_SIZE * 2 ** GEOJSON_MAXZOOM);
  simplifyRange(coords, 0, coords.length - 3, atMaxZoom * atMaxZoom);
  const significance = new Float64Array(ring.length);
  for (let i = 0; i < ring.length; i += 1) significance[i] = coords[i * 3 + 2];
  return significance;
}

/** The vertices createTile() keeps at this zoom, as ascending source indices. */
function drawnIndices(significance, tolerancePx, zoom) {
  const tolerance = toleranceUnitSquare(tolerancePx, zoom);
  const kept = [];
  if (tolerance === 0) {
    for (let i = 0; i < significance.length; i += 1) kept.push(i);
    return kept;
  }
  const squared = tolerance * tolerance;
  for (let i = 0; i < significance.length; i += 1)
    if (significance[i] > squared) kept.push(i);
  return kept;
}

// ── what the alignment does under a drawn corner ────────────────────────────

/**
 * The radius the ALIGNMENT presents where the drawn line put a corner.
 *
 * Measured in the window the drawn corner would have occupied had it obeyed
 * the promise: a turn of Θ drawn at radius R covers R·Θ of path, so the audit
 * looks R·Θ/2 either side of the corner — no further — and asks how much of
 * the turn the surveyed track delivers inside it.
 *
 *   radius = (path inside the window) / (turning inside the window)
 *
 * That single formula separates the two cases the audit must never confuse,
 * because it asks both of them the same question at the same scale:
 *
 *   the alignment kinks here too   all of its turning is inside the window and
 *                                  the path there is a few metres, so the
 *                                  radius comes out at or below the pen's own
 *                                  and there was never a curve to lose
 *
 *   the alignment is on a curve    only the window's share of the turn is
 *                                  inside it, spread over the window's whole
 *                                  length, so the radius comes out wide — and
 *                                  the drawn line spent all of it on one vertex
 *
 * Sizing the window by the promise rather than by the stretch the simplifier
 * happened to cut is what keeps a long gentle street from being read as the
 * radius of the sharp corner at the end of it.
 */
function sourceCornerRadius(ring, at, from, to, mpp, windowMeters) {
  // Each surveyed vertex inside the window, as (how much it turns, where it
  // sits along the path relative to the drawn corner).
  const weights = [];
  const positions = [];
  const add = (index, position) => {
    if (index <= 0 || index >= ring.length - 1) return;
    const turn = turnDegrees(ring[index - 1], ring[index], ring[index + 1]);
    if (turn <= 0) return;
    weights.push(turn);
    positions.push(position);
  };
  add(at, 0);
  let travelled = 0;
  for (let i = at; i > from && travelled < windowMeters; i -= 1) {
    travelled += distanceMeters(ring[i - 1], ring[i]);
    if (travelled > windowMeters) break;
    add(i - 1, -travelled);
  }
  travelled = 0;
  for (let i = at; i < to && travelled < windowMeters; i += 1) {
    travelled += distanceMeters(ring[i], ring[i + 1]);
    if (travelled > windowMeters) break;
    add(i + 1, travelled);
  }

  let degrees = 0;
  let moment = 0;
  for (let i = 0; i < weights.length; i += 1) {
    degrees += weights[i];
    moment += weights[i] * positions[i];
  }
  // The alignment is straight exactly where the drawn line put a corner: the
  // whole turn was manufactured, and there is no radius at all to compare.
  if (degrees <= NOISE_DEGREES)
    return { degrees, spanMeters: 0, radiusPx: Infinity, radiusMeters: Infinity };

  // How far the turning is SPREAD, weighted by how much each vertex turns.
  // A threshold ("the first vertex that turns more than x°") would let survey
  // jitter at the edge of the window stand in for the end of an arc and read a
  // kink as a wide curve; weighting cannot, because jitter carries almost no
  // weight. Calibrated so a uniformly sampled arc returns its own radius: for
  // an arc of length L the weighted mean deviation is L/4, so four times it is
  // L, and L over the turn is the radius by definition. A turn carried on one
  // vertex has zero deviation and therefore zero radius, which is the honest
  // answer — a kink has no radius to lose.
  const centre = moment / degrees;
  let spread = 0;
  for (let i = 0; i < weights.length; i += 1)
    spread += weights[i] * Math.abs(positions[i] - centre);
  const spanMeters = (4 * spread) / degrees;
  const radians = (degrees * Math.PI) / 180;
  return {
    degrees,
    spanMeters,
    radiusMeters: spanMeters / radians,
    radiusPx: spanMeters / mpp / radians,
  };
}

function ringsOf(feature) {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

// ── the shipped style, asked rather than copied ─────────────────────────────

function loadStyle() {
  const context = { window: {}, console };
  context.window.RailNetwork = RailNetwork;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["railmap-basemap.js", "railmap-style.js"])
    vm.runInContext(
      fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"),
      context,
      { filename: file },
    );
  return context.window.RailMapStyle;
}

/**
 * The two numbers the audit needs out of the style it is auditing: how far off
 * the surveyed line the source lets the renderer draw, and how wide the pen is
 * at each zoom. Both read from the built style, never restated here, so a
 * change to either lands in this audit without anybody remembering to mirror
 * it.
 */
function styleFacts(style, country) {
  const built = style.buildBaseStyle({ country, theme: "light" });
  const source = built.sources[style.SEGMENTS_SOURCE];
  // MapLibre's own default when a source states none.
  const tolerancePx = source.tolerance ?? 0.375;
  const widthExpression = style.railwayScale(style.RAILWAY_STYLE.railWidthPx);
  const radiusExpression = style.railwayScale(
    style.RAILWAY_STYLE.minCornerRadiusPx,
  );
  return {
    tolerancePx,
    strokeWidthPx: (zoom) => style.evaluateScreenValue(widthExpression, zoom),
    minCornerRadiusPx: (zoom) =>
      style.evaluateScreenValue(radiusExpression, zoom),
  };
}

// ── the audit ───────────────────────────────────────────────────────────────

function emptyZoomCounts() {
  return {
    corners: 0,
    coveredByInk: 0,
    collapsed: 0,
    collapsedError: 0,
    collapsedWarning: 0,
    belowPen: 0,
    dataKink: 0,
    worstLostRadiusPx: 0,
    worstDisplacementPx: 0,
    worstDisplacementAt: null,
    drawnVertices: 0,
  };
}

export function auditCountry(country, options = {}) {
  const packagePath = path.join(APP_DIR, "public/rail", `${country}-2025.json`);
  if (!fs.existsSync(packagePath)) return null;
  const style = options.style || loadStyle();
  const facts = styleFacts(style, country);
  const tolerancePx = options.tolerancePx ?? facts.tolerancePx;
  const minRadiusScale = options.minRadiusStrokes ?? MIN_CORNER_RADIUS_SCALE;
  const zooms = options.zooms || DEFAULT_ZOOMS;

  const network = RailNetwork.buildNetworkFromCompactPackage(
    JSON.parse(fs.readFileSync(packagePath, "utf8")),
  );

  const byZoom = new Map(zooms.map((zoom) => [zoom, emptyZoomCounts()]));
  const findings = [];
  const reversalFindings = [];
  const reversals = [];
  let sourceVertices = 0;
  let sourceReversals = 0;

  for (const feature of network.segments.features) {
    const properties = feature.properties || {};
    const minz = Number(properties.minz ?? 0);
    for (const ring of ringsOf(feature)) {
      if (ring.length < 3) continue;
      sourceVertices += ring.length;
      const significance = significanceOf(ring, tolerancePx);

      // Every fold the topology audit can see, found once and then checked at
      // each zoom against the line the renderer draws.
      const folds = [];
      for (let i = 1; i < ring.length - 1; i += 1) {
        if (turnDegrees(ring[i - 1], ring[i], ring[i + 1]) < REVERSAL_DEGREES)
          continue;
        const back = straightRunMeters(ring, i, -1, {
          maxMeters: REVERSAL_RUN_CAP_METERS,
        });
        const forward = straightRunMeters(ring, i, +1, {
          maxMeters: REVERSAL_RUN_CAP_METERS,
        });
        if (back < REVERSAL_RUN_METERS || forward < REVERSAL_RUN_METERS)
          continue;
        folds.push({ index: i, back, forward, drawn: {} });
      }
      sourceReversals += folds.length;

      for (const zoom of zooms) {
        // The length LOD paints a line out entirely below its own minz, so a
        // corner nobody can see is not a corner anybody lost.
        if (minz > zoom) continue;
        const counts = byZoom.get(zoom);
        const kept = drawnIndices(significance, tolerancePx, zoom);
        counts.drawnVertices += kept.length;
        if (kept.length < 3) continue;
        const keptAt = new Map(kept.map((index, order) => [index, order]));
        const minRadiusPx = minRadiusScale * facts.minCornerRadiusPx(zoom);
        const armFloorPx = ARM_VISIBILITY_STROKES * facts.strokeWidthPx(zoom);

        for (let order = 1; order < kept.length - 1; order += 1) {
          const before = kept[order - 1];
          const at = kept[order];
          const after = kept[order + 1];
          const drawnTurn = turnDegrees(ring[before], ring[at], ring[after]);
          if (drawnTurn < CORNER_REPORT_DEGREES) continue;
          counts.corners += 1;

          const mpp = metersPerPixel(zoom, ring[at][1]);
          const armBackPx = distanceMeters(ring[before], ring[at]) / mpp;
          const armForwardPx = distanceMeters(ring[at], ring[after]) / mpp;
          if (Math.min(armBackPx, armForwardPx) < armFloorPx) {
            counts.coveredByInk += 1;
            continue;
          }

          // How far the drawn line actually stands off the alignment it
          // replaced — the simplifier's own nominal promise, measured. The
          // drawn line here is the two segments before→at and at→after, never
          // the chord across them, so each dropped vertex is measured against
          // the segment that took its place and the corner vertex itself —
          // which IS drawn — is not counted as an error against itself.
          let displacementPx = 0;
          for (let i = before + 1; i < at; i += 1) {
            const d = pointToSegmentMeters(ring[i], ring[before], ring[at]);
            if (d / mpp > displacementPx) displacementPx = d / mpp;
          }
          for (let i = at + 1; i < after; i += 1) {
            const d = pointToSegmentMeters(ring[i], ring[at], ring[after]);
            if (d / mpp > displacementPx) displacementPx = d / mpp;
          }
          if (displacementPx > counts.worstDisplacementPx) {
            counts.worstDisplacementPx = displacementPx;
            counts.worstDisplacementAt = {
              lineId: properties.lineId,
              name: properties.name,
              at: ring[at],
              droppedVertices: after - before - 1,
            };
          }

          const windowMeters =
            ((minRadiusPx * ((drawnTurn * Math.PI) / 180)) / 2) * mpp;
          const arc = sourceCornerRadius(
            ring,
            at,
            before,
            after,
            mpp,
            windowMeters,
          );
          const radiusPx = arc.radiusPx;

          if (radiusPx < minRadiusPx) {
            // Under half a stroke the round join has already drawn whatever
            // rounding there is, so the alignment is a kink here in exactly
            // the sense the screen can express; above it the alignment does
            // curve, just tighter than the pen can show at this scale.
            if (radiusPx <= minRadiusPx / 2) counts.dataKink += 1;
            else counts.belowPen += 1;
            continue;
          }

          // The alignment offered a radius the reader could have seen and the
          // drawn line spent it on one vertex.
          counts.collapsed += 1;
          const severity =
            drawnTurn >= CORNER_ERROR_DEGREES
              ? "ERROR"
              : drawnTurn >= CORNER_SUSPICIOUS_DEGREES
                ? "WARNING"
                : "INFO";
          if (severity === "ERROR") counts.collapsedError += 1;
          if (severity === "WARNING") counts.collapsedWarning += 1;
          if (radiusPx > counts.worstLostRadiusPx)
            counts.worstLostRadiusPx = radiusPx;
          // INFO rows are kept too — --all lists them, and a gentle facet on a
          // wide curve is exactly what somebody investigating a regression
          // wants to see the coordinates of.
          findings.push({
              code: "corner_collapsed_by_generalisation",
              severity,
              country,
              zoom,
              lineId: properties.lineId,
              name: properties.name,
              at: ring[at],
              drawnTurn,
              sourceTurn: arc.degrees,
              sourceRadiusPx: radiusPx,
              sourceRadiusMeters: arc.radiusMeters,
              minRadiusPx,
              displacementPx,
              droppedVertices: after - before - 1,
              detail:
                `${drawnTurn.toFixed(0)}° at one vertex where the alignment ` +
                `turns ${arc.degrees.toFixed(0)}° spread over ${arc.spanMeters.toFixed(0)} m ` +
                `of the ${(2 * windowMeters).toFixed(0)} m a ${minRadiusPx.toFixed(1)} px ` +
                `corner would occupy — radius ` +
                `${Number.isFinite(arc.radiusMeters) ? `${arc.radiusMeters.toFixed(0)} m` : "straight"} ` +
                `(${Number.isFinite(radiusPx) ? radiusPx.toFixed(1) : "∞"} px, floor ` +
                `${minRadiusPx.toFixed(1)} px); ${after - before - 1} vertices dropped, ` +
                `drawn line ${displacementPx.toFixed(2)} px off the surveyed one`,
            });
        }

        // …and the folds, from the other side.
        for (const fold of folds) {
          const order = keptAt.get(fold.index);
          const mpp = metersPerPixel(zoom, ring[fold.index][1]);
          const tailPx = Math.min(fold.back, fold.forward) / mpp;
          let drawnTurn = 0;
          if (order != null && order > 0 && order < kept.length - 1)
            drawnTurn = turnDegrees(
              ring[kept[order - 1]],
              ring[fold.index],
              ring[kept[order + 1]],
            );
          fold.drawn[zoom] = drawnTurn;
          if (drawnTurn >= REVERSAL_DEGREES) continue;
          // A fold whose shorter leg is thinner than the pen cannot be drawn
          // as a fold at this zoom by anybody. Recorded, never failed.
          const severity =
            tailPx >= minRadiusScale * facts.minCornerRadiusPx(zoom)
              ? "ERROR"
              : "INFO";
          reversalFindings.push({
            code: "reversal_flattened_by_generalisation",
            severity,
            country,
            zoom,
            lineId: properties.lineId,
            name: properties.name,
            at: ring[fold.index],
            drawnTurn,
            tailPx,
            tailMeters: Math.min(fold.back, fold.forward),
            detail:
              `fold drawn at ${drawnTurn.toFixed(0)}° (needs ${REVERSAL_DEGREES}°); ` +
              `shorter leg ${Math.min(fold.back, fold.forward).toFixed(0)} m = ` +
              `${tailPx.toFixed(2)} px`,
          });
        }
      }

      for (const fold of folds)
        reversals.push({
          country,
          lineId: properties.lineId,
          name: properties.name,
          at: ring[fold.index],
          site: nearestStation(network, ring[fold.index]),
          tailMeters: Math.min(fold.back, fold.forward),
          drawn: fold.drawn,
        });
    }
  }

  return {
    country,
    tolerancePx,
    minRadiusScale,
    zooms,
    sourceVertices,
    sourceReversals,
    byZoom: [...byZoom.entries()].map(([zoom, counts]) => ({ zoom, ...counts })),
    findings,
    reversalFindings,
    reversals,
  };
}

/** The platform a fold sits at, so the switchbacks can be called by name. */
function nearestStation(network, point) {
  let best = null;
  let bestMeters = Infinity;
  for (const station of network.stations.features) {
    const meters = distanceMeters(point, station.geometry.coordinates);
    if (meters < bestMeters) {
      bestMeters = meters;
      best = station.properties?.name || null;
    }
  }
  return best ? `${best} (${bestMeters.toFixed(0)} m)` : null;
}

function pointToSegmentMeters(point, start, end) {
  const latitude = point[1];
  const scale = Math.cos((latitude * Math.PI) / 180) * 111320;
  const px = point[0] * scale;
  const py = point[1] * 111320;
  const sx = start[0] * scale;
  const sy = start[1] * 111320;
  const ex = end[0] * scale;
  const ey = end[1] * 111320;
  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared ? ((px - sx) * dx + (py - sy) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (sx + dx * t), py - (sy + dy * t));
}

// ── report ──────────────────────────────────────────────────────────────────

export function renderReport(report, options = {}) {
  const errors =
    report.findings.filter((row) => row.severity === "ERROR").length +
    report.reversalFindings.filter((row) => row.severity === "ERROR").length;
  const warnings = report.findings.filter(
    (row) => row.severity === "WARNING",
  ).length;
  const out = [
    `${report.country}: ${report.sourceVertices} surveyed vertices, ` +
      `${report.sourceReversals} reversals — tolerance ${report.tolerancePx} px, ` +
      `minimum corner radius ${report.minRadiusScale} × RAILWAY_STYLE.minCornerRadiusPx — ` +
      `${errors} ERROR, ${warnings} WARNING`,
    "  zoom   drawn   corners  in-ink  collapsed(E/W)  below-pen  data-kink  worst-lost  worst-off",
  ];
  for (const row of report.byZoom)
    out.push(
      `  ${String(row.zoom).padStart(4)}  ${String(row.drawnVertices).padStart(6)}  ` +
        `${String(row.corners).padStart(7)}  ${String(row.coveredByInk).padStart(6)}  ` +
        `${String(`${row.collapsed} (${row.collapsedError}/${row.collapsedWarning})`).padStart(14)}  ` +
        `${String(row.belowPen).padStart(9)}  ${String(row.dataKink).padStart(9)}  ` +
        `${row.worstLostRadiusPx.toFixed(1).padStart(10)}  ${row.worstDisplacementPx.toFixed(2).padStart(9)}`,
    );

  const shown = [...report.findings, ...report.reversalFindings]
    .filter((row) => options.all || row.severity !== "INFO")
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        (b.sourceRadiusPx || 0) - (a.sourceRadiusPx || 0),
    );
  const limit = options.limit || 25;
  if (shown.length) {
    out.push("");
    for (const row of shown.slice(0, limit))
      out.push(
        `  ${row.severity} ${row.code}  z${row.zoom}  ${row.name || row.lineId}` +
          `  @ ${row.at[0].toFixed(5)},${row.at[1].toFixed(5)}`,
        `      ${row.detail}`,
      );
    if (shown.length > limit)
      out.push(`  … ${shown.length - limit} more`);
  }
  if (options.reversals && report.reversals.length) {
    out.push(
      "",
      `  ${report.reversals.length} reversals in the package — deflection of the DRAWN line at each zoom` +
        ` (${REVERSAL_DEGREES}° or more is still a fold; — means the length LOD has taken the line off the map):`,
      `    site${" ".repeat(28)}line${" ".repeat(14)}tail  ${report.zooms.map((z) => `z${z}`.padStart(5)).join("")}`,
    );
    for (const row of report.reversals)
      out.push(
        `    ${String(row.site || "—").padEnd(32).slice(0, 32)}${String(row.name || row.lineId).padEnd(18).slice(0, 18)}` +
          `${`${row.tailMeters.toFixed(0)} m`.padStart(6)}  ` +
          report.zooms
            .map((z) =>
              `${row.drawn[z] == null ? "—" : row.drawn[z].toFixed(0)}°`.padStart(5),
            )
            .join(""),
      );
  }
  return out.join("\n");
}

function parseArgs(argv) {
  const options = { strict: false, all: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--country") options.country = argv[++index];
    else if (arg === "--zooms")
      options.zooms = argv[++index].split(",").map(Number).filter(Boolean);
    else if (arg === "--tolerance") options.tolerancePx = Number(argv[++index]);
    else if (arg === "--min-radius-strokes")
      options.minRadiusStrokes = Number(argv[++index]);
    else if (arg === "--limit") options.limit = Number(argv[++index]) || 25;
    else if (arg === "--json") options.json = argv[++index];
    else if (arg === "--all") options.all = true;
    else if (arg === "--reversals") options.reversals = true;
    else if (arg === "--strict") options.strict = true;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const countries = options.country ? [options.country] : COUNTRIES;
  const style = loadStyle();
  const reports = [];
  let errors = 0;
  for (const country of countries) {
    const report = auditCountry(country, { ...options, style });
    if (!report) continue;
    reports.push(report);
    process.stdout.write(`${renderReport(report, options)}\n\n`);
    errors +=
      report.findings.filter((row) => row.severity === "ERROR").length +
      report.reversalFindings.filter((row) => row.severity === "ERROR").length;
  }
  if (options.json)
    fs.writeFileSync(options.json, JSON.stringify(reports, null, 1));
  process.stdout.write(`TOTAL ${errors} ERROR\n`);
  if (options.strict && errors) process.exitCode = 1;
}

// Run only as a command; importing this module (tests) must not audit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
