"""
display_geometry.py — continuous lane displacement.

The rule this file exists to satisfy:

    A parallel line is NOT several independent segments carrying different
    constant offsets. It is a display curve generated from the complete
    railway centreline, with continuous position, continuous tangent and
    continuous curvature.

So instead of emitting `line-offset` steps we emit, per chain, a densified
vertex list where every vertex carries

    (lon, lat, s, d)

with `s` the along-line measure in metres and `d` the lane offset in LANE
UNITS. The renderer multiplies d by the screen-space lane pitch, so the
displacement is screen-constant at every zoom while d(s) stays C2.

d(s) is built as a piecewise quintic smoothstep:

    f(t) = 6t^5 - 15t^4 + 10t^3
    f(0)=0  f(1)=1  f'(0)=f'(1)=0  f''(0)=f''(1)=0

Transition length is chosen in screen space and converted to metres at a
reference zoom, then clamped by the geometry that is actually available.
"""

from __future__ import annotations

import math
from bisect import bisect_left

import numpy as np

# lane pitch in CSS px = railWidth(3) + parallelGap(1.2)
LANE_PITCH_PX = 4.2
# transitionPx = clamp(72, 16*|offsetPx|, 180)   (rule §17)
TRANS_MIN_PX, TRANS_MAX_PX, TRANS_K = 72.0, 180.0, 16.0
# reference zoom for converting the screen-space transition into metres.
# z13 is the middle of the band where lanes are actually legible.
REF_ZOOM = 13.0
# maximum lateral entry angle
MAX_ENTRY_DEG = 7.0
# adaptive tessellation targets (rule §19)
MAX_SCREEN_ERR_PX = 0.2
MAX_TURN_DEG = 2.0
# curvature safety factor: R >= KAPPA * max|d|  (rule §16.4)
KAPPA = 2.0

R_EARTH = 6378137.0


def m_per_px(zoom: float, lat: float) -> float:
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** zoom)


def quintic(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


# --------------------------------------------------------------------------
# profile
# --------------------------------------------------------------------------

def build_profile(length_m, lane_records, lat, ref_zoom=REF_ZOOM,
                  radius_cap=None):
    """Return d(s), the transition windows, and the (possibly amended) steps.

    Implements the rule-set §17 fallback ladder in order:
      1. extend the transition outside the parallel interval
      2. merge adjacent lane changes into one continuous change
      5. reduce lane spacing for that interval
      6. cancel the parallel expansion for that interval
    A lane change is NEVER allowed to degrade into a step.
    """
    mpp = m_per_px(ref_zoom, lat)
    lat_m_per_unit = LANE_PITCH_PX * mpp          # metres per lane unit on screen
    max_slope = math.tan(math.radians(MAX_ENTRY_DEG))

    recs = [dict(r) for r in sorted(lane_records, key=lambda r: r["from_m"])]

    # Rule R2 / fallback 5, applied BEFORE the quintic so the profile stays
    # exactly C2: on a run whose tightest radius is R, |d| may not exceed
    # R / (KAPPA * lane_metres), else the offset curve cusps on the concave
    # side. Narrow the run instead of emitting a cusp.
    if radius_cap is not None:
        for r in recs:
            rmin = radius_cap(r["from_m"], r["to_m"])
            if rmin and math.isfinite(rmin):
                allowed = rmin / (KAPPA * lat_m_per_unit)
                if abs(r["offset"]) > allowed:
                    r["offset"] = round(math.copysign(max(allowed, 0.0),
                                                      r["offset"]), 4)
        recs = [r for r in recs if abs(r["offset"]) >= 0.2]

    for _attempt in range(6):
        steps = []
        cursor = 0.0
        for r in recs:
            if r["from_m"] > cursor + 1e-6:
                steps.append([cursor, r["from_m"], 0.0, None])
            steps.append([r["from_m"], r["to_m"], float(r["offset"]), r])
            cursor = r["to_m"]
        if cursor < length_m - 1e-6:
            steps.append([cursor, length_m, 0.0, None])
        if not steps:
            steps = [[0.0, length_m, 0.0, None]]

        # ---- 1. desired half-window, asymmetric: intrude little into a laned
        #         run, freely into an un-laned one.
        raw = []
        for i in range(len(steps) - 1):
            d0, d1 = steps[i][2], steps[i + 1][2]
            if abs(d1 - d0) < 1e-9:
                continue
            want_px = min(TRANS_MAX_PX,
                          max(TRANS_MIN_PX, TRANS_K * abs(d1 - d0) * LANE_PITCH_PX))
            want_half = want_px * mpp / 2.0
            def room(step):
                span = step[1] - step[0]
                return span * (0.45 if abs(step[2]) > 1e-9 else 0.92)
            raw.append({"at": steps[i][1], "d0": d0, "d1": d1,
                        "want": want_half,
                        "left_room": room(steps[i]),
                        "right_room": room(steps[i + 1]),
                        "li": i, "ri": i + 1})

        # ---- 2. merge: two boundaries closer than their combined windows
        #         become one monotone change; clip halves to the midpoint.
        for k in range(len(raw) - 1):
            gap = raw[k + 1]["at"] - raw[k]["at"]
            mid = gap / 2.0
            raw[k]["right_room"] = min(raw[k]["right_room"], mid)
            raw[k + 1]["left_room"] = min(raw[k + 1]["left_room"], mid)

        windows = []
        failures = []
        for w in raw:
            hl = min(w["want"], w["left_room"])
            hr = min(w["want"], w["right_room"])
            span = hl + hr
            slope = abs(w["d1"] - w["d0"]) * lat_m_per_unit / max(span, 1e-6)
            windows.append({"at": w["at"], "hl": hl, "hr": hr,
                            "d0": w["d0"], "d1": w["d1"], "slope": slope})
            if slope > max_slope:
                failures.append((w, span))

        if not failures:
            break

        # ---- 5 then 6: shrink the offending run's magnitude; if it is already
        #      small, or shrinking is not enough, cancel that run entirely.
        changed = False
        for w, span in failures:
            for side in ("li", "ri"):
                st = steps[w[side]]
                rec = st[3]
                if rec is None:
                    continue
                allowed = max_slope * span / lat_m_per_unit
                target = math.copysign(min(abs(rec["offset"]), allowed), rec["offset"])
                if abs(target) < 0.2:
                    if rec in recs:
                        recs.remove(rec)          # fallback 6: cancel
                        changed = True
                elif abs(target - rec["offset"]) > 1e-6:
                    rec["offset"] = round(target, 4)   # fallback 5: narrow
                    changed = True
        if not changed:
            break

    steps_out = [(a, b, c) for a, b, c, _ in steps]

    def d_of(s):
        s = np.asarray(s, dtype=np.float64)
        edges = np.array([st[0] for st in steps_out] + [steps_out[-1][1]])
        vals = np.array([st[2] for st in steps_out])
        idx = np.clip(np.searchsorted(edges, s, side="right") - 1, 0, len(vals) - 1)
        out = vals[idx].astype(np.float64)
        for w in windows:
            lo, hi = w["at"] - w["hl"], w["at"] + w["hr"]
            if hi - lo <= 0:
                continue
            m = (s >= lo) & (s <= hi)
            if not m.any():
                continue
            t = (s[m] - lo) / (hi - lo)
            out[m] = w["d0"] + (w["d1"] - w["d0"]) * quintic(t)
        return out

    return d_of, windows, steps_out


# --------------------------------------------------------------------------
# densify + curvature
# --------------------------------------------------------------------------

def _local_frame(coords, lat0):
    k = math.cos(math.radians(lat0))
    a = np.asarray(coords, dtype=np.float64)
    return np.radians(a[:, 0]) * R_EARTH * k, np.radians(a[:, 1]) * R_EARTH


def _to_lonlat(x, y, lat0):
    k = math.cos(math.radians(lat0))
    return np.degrees(x / (R_EARTH * k)), np.degrees(y / R_EARTH)


def curvature_radius(x, y, s=None, smooth_m=60.0):
    """Radius of curvature at every vertex (metres, inf on straights).

    `s` MUST be passed for a non-uniform grid — np.gradient assumes unit
    spacing otherwise and the result is meaningless. Surveyed centrelines are
    noisy at the vertex scale, so the coordinates are pre-smoothed over
    `smooth_m` before differentiating; without that the radius oscillates and
    anything driven by it oscillates with it.
    """
    if s is not None and len(s) > 8:
        step = max(1e-6, float(np.median(np.diff(s))))
        k = max(3, int(smooth_m / step) | 1)
        if k < len(x):
            w = np.hanning(k); w /= w.sum()
            pad = k // 2
            x = np.convolve(np.pad(x, pad, mode="edge"), w, mode="valid")[:len(s)]
            y = np.convolve(np.pad(y, pad, mode="edge"), w, mode="valid")[:len(s)]
    if s is None:
        dx = np.gradient(x); dy = np.gradient(y)
        ddx = np.gradient(dx); ddy = np.gradient(dy)
    else:
        dx = np.gradient(x, s, edge_order=1); dy = np.gradient(y, s, edge_order=1)
        ddx = np.gradient(dx, s, edge_order=1); ddy = np.gradient(dy, s, edge_order=1)
    num = (dx * dx + dy * dy) ** 1.5
    den = dx * ddy - dy * ddx
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(np.abs(den) < 1e-12, np.inf, num / den)
    return r


def build_display_curve(chain, lane_records, ref_zoom=REF_ZOOM,
                        want_pitch_m=None):
    """Return dict with densified lon/lat, measure s, lane offset d, plus the
    diagnostics the continuity tests read."""
    # Prefer the arc-densified canonical geometry when it is available: the
    # lane displacement rides on it, so smoothing the base curve smooths the
    # offset curve too.
    coords = chain.get("coords_dense") or chain["coords"]
    if chain.get("coords_dense") and "measures_dense" in chain:
        meas = np.asarray(chain["measures_dense"], dtype=np.float64)
    elif chain.get("coords_dense"):
        from n02_source import cumulative_measures
        meas = np.asarray(cumulative_measures(coords), dtype=np.float64)
        chain["measures_dense"] = meas.tolist()
    else:
        meas = np.asarray(chain["measures"], dtype=np.float64)
    length = float(meas[-1])
    lat0 = coords[len(coords) // 2][1]

    if not lane_records:
        lon = np.array([c[0] for c in coords])
        lat = np.array([c[1] for c in coords])
        return {"lon": lon, "lat": lat, "s": meas,
                "d": np.zeros(len(coords)), "windows": [],
                "max_entry_deg": 0.0, "min_radius_m": math.inf,
                "radius_violations": 0, "resampled": False}

    # a first pass on the raw geometry gives the radius envelope the profile
    # needs; it is computed once and reused.
    cx0, cy0 = _local_frame(coords, lat0)
    r0 = curvature_radius(cx0, cy0, meas)
    r0_abs = np.abs(r0)

    def radius_cap(lo, hi):
        m = (meas >= lo) & (meas <= hi)
        if not m.any():
            return math.inf
        v = r0_abs[m]
        v = v[np.isfinite(v)]
        return float(np.min(v)) if len(v) else math.inf

    d_of, windows, steps = build_profile(length, lane_records, lat0, ref_zoom,
                                         radius_cap=radius_cap)

    # densify: uniform base pitch, then extra samples inside every transition
    mpp = m_per_px(ref_zoom, lat0)
    # rule §4.6: resample to <=10 m before smoothing, or tight urban curves
    # polygonise at z16+. N02's own median vertex spacing is 47 m.
    base = want_pitch_m if want_pitch_m else 10.0
    # Densify ONLY where it buys something: inside a laned run and inside a
    # transition window. Everywhere else d is exactly 0 and the canonical
    # vertices already describe the line, so adding samples would triple the
    # package for no visual gain.
    active = []
    for a, b, c in steps:
        if abs(c) > 1e-9:
            active.append((a, b))
    for w in windows:
        active.append((w["at"] - w["hl"], w["at"] + w["hr"]))
    s = [float(v) for v in meas]
    for lo, hi in active:
        lo = max(0.0, lo - base)
        hi = min(length, hi + base)
        if hi > lo:
            s.extend(np.arange(lo, hi + base * 0.5, base))
    for w in windows:
        lo, hi = w["at"] - w["hl"], w["at"] + w["hr"]
        if hi > lo:
            s.extend(np.linspace(lo, hi, 41))
    # Merge the uniform grid with the per-window samples, enforcing a minimum
    # spacing. Without this two samples can land ~1e-4 m apart, and every
    # finite-difference derivative computed downstream blows up.
    MIN_DS = 0.5
    s = sorted(np.clip(np.asarray(s, dtype=np.float64), 0.0, length))
    merged = [s[0]]
    for v in s[1:]:
        if v - merged[-1] >= MIN_DS:
            merged.append(v)
    if length - merged[-1] > 1e-9:
        if length - merged[-1] < MIN_DS and len(merged) > 1:
            merged[-1] = length
        else:
            merged.append(length)
    s = np.array(merged)

    cx, cy = _local_frame(coords, lat0)
    x = np.interp(s, meas, cx)
    y = np.interp(s, meas, cy)
    d = d_of(s)

    # unit tangent / normal from the CANONICAL curve
    dx = np.gradient(x, s, edge_order=1)
    dy = np.gradient(y, s, edge_order=1)
    nrm = np.hypot(dx, dy)
    nrm[nrm == 0] = 1.0
    tx, ty = dx / nrm, dy / nrm
    nx, ny = -ty, tx

    r = curvature_radius(x, y, s)
    lane_m = LANE_PITCH_PX * mpp
    r_abs = np.abs(r)
    cap = np.where(np.isfinite(r_abs), r_abs / (KAPPA * lane_m), np.inf)
    viol = int(np.sum(np.abs(d) > cap + 1e-9))
    finite = np.isfinite(r_abs)
    min_r = float(np.min(r_abs[finite])) if finite.any() else math.inf

    # entry angle: d'(s) in metres per metre -> atan
    dd = np.gradient(d, s, edge_order=1) * LANE_PITCH_PX * mpp
    max_entry = float(np.degrees(np.arctan(np.max(np.abs(dd)))))

    lon, lat = _to_lonlat(x, y, lat0)
    return {"lon": lon, "lat": lat, "s": s, "d": d,
            "tx": tx, "ty": ty, "nx": nx, "ny": ny,
            "windows": windows, "steps": steps,
            "max_entry_deg": max_entry,
            "min_radius_m": min_r, "radius_violations": viol,
            "lat0": lat0, "resampled": True}


# --------------------------------------------------------------------------
# continuity audit (the acceptance criteria of rule §10 / §19)
# --------------------------------------------------------------------------

def audit(curve):
    """Return the continuity metrics the tests assert on."""
    s, d = curve["s"], curve["d"]
    if len(s) < 3:
        return {"max_d_jump": 0.0, "max_dd_jump": 0.0, "added_turn_deg": 0.0,
                "zero_len": 0, "dup_pts": 0,
                "max_entry_deg": curve.get("max_entry_deg", 0.0),
                "radius_violations": curve.get("radius_violations", 0)}
    ds = np.diff(s)
    # position continuity: d must never step
    jump = np.max(np.abs(np.diff(d))) if len(d) > 1 else 0.0
    # tangent continuity of the displacement profile
    d1 = np.gradient(d, s, edge_order=1)
    dd_jump = float(np.max(np.abs(np.diff(d1)))) if len(d1) > 1 else 0.0
    # Turn angle: what matters is the turn the DISPLACEMENT adds, not the turn
    # already present in the surveyed centreline (N02 has real curves and a
    # 47 m median vertex spacing, so canonical turn is large by nature).
    lat0 = curve.get("lat0", float(np.mean(curve["lat"])))
    k = math.cos(math.radians(lat0))
    x = np.radians(curve["lon"]) * R_EARTH * k
    y = np.radians(curve["lat"]) * R_EARTH
    mpp = m_per_px(REF_ZOOM, lat0)
    off_m = d * LANE_PITCH_PX * mpp
    px = x + curve["nx"] * off_m
    py = y + curve["ny"] * off_m

    def turns(ax, ay):
        vx, vy = np.diff(ax), np.diff(ay)
        ang = np.arctan2(vy, vx)
        t = np.abs(np.diff(ang))
        return np.minimum(t, 2 * np.pi - t)

    t_can = turns(x, y)
    t_dis = turns(px, py)
    added = np.degrees(np.abs(t_dis - t_can)) if len(t_can) else np.array([0.0])
    max_turn = float(np.max(added))
    return {
        "max_d_jump": float(jump),
        "max_dd_jump": dd_jump,
        "added_turn_deg": max_turn,
        "zero_len": int(np.sum(ds <= 0)),
        "dup_pts": int(np.sum((np.diff(curve["lon"]) == 0)
                              & (np.diff(curve["lat"]) == 0))),
        "max_entry_deg": curve["max_entry_deg"],
        "radius_violations": curve["radius_violations"],
    }


# --------------------------------------------------------------------------
# curvature-adaptive densification (rule §19 / G3)
# --------------------------------------------------------------------------

def _circum(p0, p1, p2):
    """Centre and radius of the circle through three points, in a local metric
    frame. Returns (cx, cy, R) or None when the points are collinear."""
    ax, ay = p0
    bx, by = p1
    cx_, cy_ = p2
    d = 2.0 * (ax * (by - cy_) + bx * (cy_ - ay) + cx_ * (ay - by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy_) + (bx * bx + by * by) * (cy_ - ay)
          + (cx_ * cx_ + cy_ * cy_) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx_ - bx) + (bx * bx + by * by) * (ax - cx_)
          + (cx_ * cx_ + cy_ * cy_) * (bx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)


def densify_arcs(coords, target_zoom=16.0, max_err_px=MAX_SCREEN_ERR_PX,
                 max_extra=8):
    """Insert vertices on the CIRCULAR ARC through each vertex triple wherever
    the straight chord would deviate from that arc by more than `max_err_px`
    at `target_zoom`.

    Arcs, not Beziers, on purpose: a curve parallel to a circular arc is itself
    a circular arc, so a lane offset applied to this geometry stays exactly
    parallel through the bend. Straight runs are left completely alone, so the
    vertex count only grows where the eye can actually see the facets.
    """
    n = len(coords)
    if n < 3:
        return coords, 0
    lat0 = coords[n // 2][1]
    k = math.cos(math.radians(lat0))
    xs = [math.radians(c[0]) * R_EARTH * k for c in coords]
    ys = [math.radians(c[1]) * R_EARTH for c in coords]
    err_m = max_err_px * m_per_px(target_zoom, lat0)

    out = [coords[0]]
    added = 0
    for i in range(n - 1):
        p1 = (xs[i], ys[i])
        p2 = (xs[i + 1], ys[i + 1])
        chord = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        # use the neighbour on the longer side to define the arc
        p0 = (xs[i - 1], ys[i - 1]) if i > 0 else None
        p3 = (xs[i + 2], ys[i + 2]) if i + 2 < n else None
        # Fit both neighbouring triples and take the LARGER radius. Taking the
        # smaller one biases towards whichever triple is most degenerate — a
        # digitising spike or a doubling-back vertex yields a tiny circle whose
        # arc swings far away from the real alignment.
        cands = []
        for trio in ((p0, p1, p2), (p1, p2, p3)):
            if trio[0] is None or trio[2] is None:
                continue
            c = _circum(*trio)
            if c and math.isfinite(c[2]) and c[2] > chord / 2:
                cands.append(c)
        best = max(cands, key=lambda c: c[2]) if cands else None
        if best is not None and chord > 1.0:
            R = best[2]
            sagitta = R - math.sqrt(max(0.0, R * R - (chord / 2) ** 2))
            if sagitta > err_m:
                steps = min(max_extra,
                            max(1, int(math.ceil(math.sqrt(sagitta / err_m)))))
                cx_, cy_, _ = best
                a1 = math.atan2(p1[1] - cy_, p1[0] - cx_)
                a2 = math.atan2(p2[1] - cy_, p2[0] - cx_)
                da = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
                # Guard: every inserted point must stay within the sagitta of
                # the chord it subdivides. A fit that violates this is a bad
                # circle, not a real curve — skip the segment rather than
                # invent geometry that the station anchors no longer sit on.
                pts = []
                ok = True
                ux, uy = (p2[0] - p1[0]) / chord, (p2[1] - p1[1]) / chord
                for t in range(1, steps):
                    a = a1 + da * (t / steps)
                    px = cx_ + R * math.cos(a)
                    py = cy_ + R * math.sin(a)
                    dev = abs(-uy * (px - p1[0]) + ux * (py - p1[1]))
                    proj = ux * (px - p1[0]) + uy * (py - p1[1])
                    if dev > sagitta * 1.6 + 0.5 or proj < -1.0 or proj > chord + 1.0:
                        ok = False
                        break
                    pts.append((math.degrees(px / (R_EARTH * k)),
                                math.degrees(py / R_EARTH)))
                if ok:
                    out.extend(pts)
                    added += len(pts)
        out.append(coords[i + 1])
    return out, added
