/*
 * railmap-display-curve.mjs
 *
 * Turns the `compact-v2` package into drawable geometry.
 *
 * The whole point of this file is the two guarantees the rule set demands and
 * that a constant `line-offset` cannot give:
 *
 *   1. THE GAP IS THE SAME AT EVERY ZOOM.
 *      The offset is stored in LANE UNITS. One lane unit is `lanePitchPx`
 *      screen pixels — always. At draw time it is converted to metres with
 *      the ground resolution of the current zoom, so the on-screen gap is
 *      invariant. Nothing about the gap depends on the geometry.
 *
 *   2. A PAIR NEVER SWAPS SIDES.
 *      The sign of `d` was decided once, at build time, from a GLOBAL lane
 *      order over the whole corridor graph. The renderer only ever reads it.
 *      The unit normal is derived from the emitted vertex order, which is
 *      fixed in the package, so no client-side re-ordering, tile clipping or
 *      simplification can flip a side either.
 *
 * Both are covered by tests in verify-display-curve.mjs.
 */

export const EARTH_CIRCUMFERENCE = 40075016.685578488;

/** Ground metres per screen pixel at a given zoom and latitude. */
export function metresPerPixel(zoom, latDeg, tileSize = 512) {
  return (EARTH_CIRCUMFERENCE * Math.cos((latDeg * Math.PI) / 180)) /
    (tileSize * Math.pow(2, zoom));
}

/** Decode the delta-encoded integer coordinate array. */
export function decodeCoords(flat) {
  const n = flat.length / 2;
  const out = new Array(n);
  let x = flat[0];
  let y = flat[1];
  out[0] = [x / 1e5, y / 1e5];
  for (let i = 1; i < n; i += 1) {
    x += flat[i * 2];
    y += flat[i * 2 + 1];
    out[i] = [x / 1e5, y / 1e5];
  }
  return out;
}

/**
 * Expand the sparse lane array back to one value per vertex.
 * Stored form is `[startIndex, d0, d1, ...]` covering only the active window.
 */
export function decodeLane(laneArray, vertexCount, unitScale = 1000) {
  const d = new Float64Array(vertexCount);
  if (!laneArray || !laneArray.length) return d;
  const start = laneArray[0];
  for (let i = 1; i < laneArray.length; i += 1) {
    const j = start + i - 1;
    if (j >= vertexCount) break;
    d[j] = laneArray[i] / unitScale;
  }
  return d;
}

/**
 * Unit normal at every vertex, in the local metric frame.
 *
 * Derived from the FORWARD DIRECTION OF THE EMITTED VERTEX ORDER. That order
 * is part of the package contract: reversing a segment's coordinates would
 * mirror every lane on it, which is exactly the defect this design exists to
 * prevent. Interior vertices use a central difference so the normal turns
 * smoothly through a curve instead of stepping at each vertex.
 */
export function unitNormals(coords) {
  const n = coords.length;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  if (n < 2) return { nx, ny };
  for (let i = 0; i < n; i += 1) {
    const a = coords[Math.max(0, i - 1)];
    const b = coords[Math.min(n - 1, i + 1)];
    const cosLat = Math.cos((coords[i][1] * Math.PI) / 180);
    const vx = (b[0] - a[0]) * cosLat;
    const vy = b[1] - a[1];
    const len = Math.hypot(vx, vy) || 1;
    // left normal of the direction of travel
    nx[i] = -vy / len;
    ny[i] = vx / len;
  }
  return { nx, ny };
}

/**
 * Displace one segment for a given zoom.
 * Returns a fresh coordinate array; the canonical one is never mutated.
 */
export function displaceSegment(coords, d, zoom, lanePitchPx) {
  if (!d || !d.length) return coords;
  const { nx, ny } = unitNormals(coords);
  const out = new Array(coords.length);
  for (let i = 0; i < coords.length; i += 1) {
    const dv = d[i];
    if (!dv) {
      out[i] = coords[i];
      continue;
    }
    const lat = coords[i][1];
    const offsetM = dv * lanePitchPx * metresPerPixel(zoom, lat);
    const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
    // metres -> degrees, in the same local frame the normal was built in
    const dLon = (nx[i] * offsetM) / (111320.0 * cosLat);
    const dLat = (ny[i] * offsetM) / 110540.0;
    out[i] = [coords[i][0] + dLon, coords[i][1] + dLat];
  }
  return out;
}

/**
 * Build a GeoJSON FeatureCollection for the current zoom.
 *
 * `zoom` is quantised before use: recomputing on every fractional zoom change
 * would rebuild the whole network on every animation frame for a sub-pixel
 * difference. A quarter-zoom step keeps the gap within ~4% of nominal, which
 * is far below the 1 px that would be visible.
 */
export function buildNetworkGeoJSON(pkg, zoom, options = {}) {
  const {
    quantiseZoom = 0.25,
    theme = 'dark',
    minRank = 0,
    filter = null,
  } = options;
  const z = Math.round(zoom / quantiseZoom) * quantiseZoom;
  const lanePitchPx = pkg.lanePitchPx ?? 4.2;
  const unitScale = pkg.laneUnitScale ?? 1000;
  const features = [];

  for (const line of pkg.lines) {
    if (line.rank < minRank) continue;
    if (filter && !filter(line)) continue;
    const colour = theme === 'dark' && line.colorDark ? line.colorDark : line.color;
    for (let si = 0; si < line.segments.length; si += 1) {
      const seg = line.segments[si];
      const coords = decodeCoords(seg[2]);
      const d = seg.length > 3 ? decodeLane(seg[3], coords.length, unitScale) : null;
      const drawn = d ? displaceSegment(coords, d, z, lanePitchPx) : coords;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: drawn },
        properties: {
          lineId: line.id,
          name: line.name,
          nameNorm: line.nameNorm,
          label: line.labelPolicy === 'operator' ? line.operatorShort : line.nameNorm,
          lineCode: line.lineCode || '',
          operator: line.operator,
          kind: line.kind,
          rank: line.rank,
          color: colour,
          segIndex: si,
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Station dots. A station sits on its line's FINAL DISPLAYED curve, so its
 * position is read off the same displaced geometry the line is drawn from —
 * never offset by an icon translation, which would drift from the line inside
 * a transition or on a curve.
 */
export function buildStationGeoJSON(pkg, zoom, options = {}) {
  const { quantiseZoom = 0.25, theme = 'dark', minZoom = 11 } = options;
  if (zoom < minZoom) return { type: 'FeatureCollection', features: [] };
  const z = Math.round(zoom / quantiseZoom) * quantiseZoom;
  const lanePitchPx = pkg.lanePitchPx ?? 4.2;
  const unitScale = pkg.laneUnitScale ?? 1000;
  const features = [];

  for (const line of pkg.lines) {
    const colour = theme === 'dark' && line.colorDark ? line.colorDark : line.color;
    // cache displaced geometry per segment so N stations cost one pass
    const cache = new Map();
    const getSeg = (si) => {
      if (!cache.has(si)) {
        const seg = line.segments[si];
        if (!seg) { cache.set(si, null); }
        else {
          const coords = decodeCoords(seg[2]);
          const d = seg.length > 3 ? decodeLane(seg[3], coords.length, unitScale) : null;
          cache.set(si, {
            coords,
            drawn: d ? displaceSegment(coords, d, z, lanePitchPx) : coords,
          });
        }
      }
      return cache.get(si);
    };

    for (const st of line.stations) {
      const [code, name, lon, lat, en, interchange, , segIdx, group] = st;
      const entry = getSeg(segIdx ?? 0);
      let pos = [lon, lat];
      if (entry) {
        // nearest vertex on the CANONICAL curve, then take the matching
        // vertex on the DISPLACED curve — this is what keeps the dot centred
        // on the line through a lane transition.
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < entry.coords.length; i += 1) {
          const dx = entry.coords[i][0] - lon;
          const dy = entry.coords[i][1] - lat;
          const dd = dx * dx + dy * dy;
          if (dd < bestD) { bestD = dd; best = i; }
        }
        if (best >= 0) pos = entry.drawn[best];
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pos },
        properties: {
          code, name, nameEn: en || '', group: group || '',
          lineId: line.id, color: colour,
          interchange: interchange ? 1 : 0,
          rank: line.rank,
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
