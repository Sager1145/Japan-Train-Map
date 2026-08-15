"""
corridors.py — detect display corridors and assign stable lanes.

Rules implemented (from the rule set, Part III):

  * A corridor is created only between DISTINCT railway identities. Service
    variants and trunk/branch sharing real track never produce lanes.
  * Detection is geometric: sustained proximity with compatible bearing.
    A brief crossing does not qualify.
  * Lane order is stable across zoom, tiles and geometry direction, because
    the side is measured against the corridor's own reference axis, not
    against each feature's digitisation direction.
  * Offsets are symmetric about the true centreline: 2 lanes -> -0.5/+0.5,
    3 -> -1/0/+1, so no line is privileged with the "real" position.
"""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

# ---- tuning ---------------------------------------------------------------
SAMPLE_M = 20.0          # resample pitch for detection
NEAR_M = 28.0            # "same corridor" distance  (see calibration note)
BEARING_TOL_DEG = 32.0   # parallel, not crossing
MIN_RUN_M = 250.0        # a corridor must persist to be worth drawing
GAP_BRIDGE_M = 180.0     # close short holes inside an otherwise steady run
MAX_LANES = 6

R_EARTH = 6378137.0


def _to_local(coords, lat0):
    """Equirectangular metres about lat0 — accurate enough at corridor scale."""
    k = math.cos(math.radians(lat0))
    a = np.asarray(coords, dtype=np.float64)
    x = np.radians(a[:, 0]) * R_EARTH * k
    y = np.radians(a[:, 1]) * R_EARTH
    return x, y


def resample(chain, pitch=SAMPLE_M):
    """Return (measures, x, y, bearing) sampled at a fixed arc-length pitch."""
    coords, meas = chain["coords"], chain["measures"]
    total = meas[-1]
    if total < pitch:
        n = 2
    else:
        n = int(total // pitch) + 1
    targets = np.linspace(0.0, total, max(n, 2))
    lat0 = coords[len(coords) // 2][1]
    cx, cy = _to_local(coords, lat0)
    m = np.asarray(meas)
    x = np.interp(targets, m, cx)
    y = np.interp(targets, m, cy)
    dx = np.gradient(x)
    dy = np.gradient(y)
    brg = np.arctan2(dy, dx)
    lon = np.degrees(x / (R_EARTH * math.cos(math.radians(lat0))))
    lat = np.degrees(y / R_EARTH)
    return targets, x, y, brg, lat0, lon, lat


def _angdiff(a, b):
    d = np.abs(a - b) % (2 * math.pi)
    d = np.minimum(d, 2 * math.pi - d)
    return np.minimum(d, math.pi - d)          # direction-insensitive


def detect(chains, verbose=True):
    """Find parallel runs between distinct railway identities.

    Returns a list of pair-runs:
      {a, b, a_from, a_to, b_from, b_to, side, mean_sep_m, length_m}
    where a/b are chain indices and side is +1/-1 for b relative to a's own
    direction of travel.
    """
    samples = {}
    for ci, ch in enumerate(chains):
        if ch["length_m"] < MIN_RUN_M / 2:
            continue
        samples[ci] = resample(ch)

    # global grid hash in a single equirectangular frame (Japan-wide is fine
    # for a 28 m test: the scale error over 20 deg of latitude is handled by
    # re-projecting each chain about its OWN lat0, then binning on lon/lat)
    cell = NEAR_M
    grid = defaultdict(list)
    for ci, (m, x, y, b, lat0, lon, lat) in samples.items():
        for k in range(len(m)):
            gx = int(lon[k] * 111320 * math.cos(math.radians(lat[k])) // cell)
            gy = int(lat[k] * 110540 // cell)
            grid[(gx, gy)].append((ci, k, lon[k], lat[k]))

    pair_hits = defaultdict(list)          # (a,b) -> [(ia, ib)]
    for (gx, gy), items in grid.items():
        neigh = []
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                neigh.extend(grid.get((gx + ox, gy + oy), ()))
        for ci, ia, lon1, lat1 in items:
            ka = chains[ci]["line_key"]
            for cj, ib, lon2, lat2 in neigh:
                if cj <= ci:
                    continue
                if chains[cj]["line_key"] == ka:
                    continue          # same railway identity -> never a lane
                coslat = math.cos(math.radians(lat1))
                dx = (lon2 - lon1) * 111320 * coslat
                dy = (lat2 - lat1) * 110540
                if dx * dx + dy * dy > NEAR_M * NEAR_M:
                    continue
                pair_hits[(ci, cj)].append((ia, ib))

    runs = []
    tol = math.radians(BEARING_TOL_DEG)
    for (a, b), hits in pair_hits.items():
        ma, xa, ya, ba, _la, lona, lata = samples[a]
        mb, xb, yb, bb, _lb, lonb, latb = samples[b]
        def brg_at(lon, lat, i):
            j = min(i + 1, len(lon) - 1); k = max(i - 1, 0)
            cl = math.cos(math.radians(lat[i]))
            return math.atan2((lat[j] - lat[k]) * 110540.0,
                              (lon[j] - lon[k]) * 111320.0 * cl)
        ok = [(ia, ib) for ia, ib in hits
              if _angdiff(np.float64(brg_at(lona, lata, ia)),
                          np.float64(brg_at(lonb, latb, ib))) < tol]
        if not ok:
            continue
        ok.sort()
        # group by contiguity in a's measure
        cur = [ok[0]]
        groups = []
        for h in ok[1:]:
            if (h[0] - cur[-1][0]) * SAMPLE_M <= GAP_BRIDGE_M:
                cur.append(h)
            else:
                groups.append(cur)
                cur = [h]
        groups.append(cur)
        for g in groups:
            a_from, a_to = ma[g[0][0]], ma[g[-1][0]]
            if a_to - a_from < MIN_RUN_M:
                continue
            ibs = [h[1] for h in g]
            b_from, b_to = mb[min(ibs)], mb[max(ibs)]
            # side of b relative to a's direction of travel
            sides, seps = [], []
            for ia, ib in g:
                # everything in ONE local metric frame anchored at a's sample
                coslat = math.cos(math.radians(lata[ia]))
                px = (lonb[ib] - lona[ia]) * 111320.0 * coslat
                py = (latb[ib] - lata[ia]) * 110540.0
                # a's travel direction, recomputed in the same frame
                j = min(ia + 1, len(lona) - 1)
                k = max(ia - 1, 0)
                vx = (lona[j] - lona[k]) * 111320.0 * coslat
                vy = (lata[j] - lata[k]) * 110540.0
                n = math.hypot(vx, vy) or 1.0
                vx, vy = vx / n, vy / n
                cross = vx * py - vy * px
                sides.append(1 if cross >= 0 else -1)
                seps.append(abs(cross))
            side = 1 if sum(sides) >= 0 else -1
            consistency = abs(sum(sides)) / len(sides)
            mean_sep = sum(seps) / len(seps)
            # near-coincident geometry is Path A's job; an unstable side means
            # the two lines weave rather than run parallel — neither is a lane.
            if mean_sep < 3.0 or consistency < 0.8:
                continue
            runs.append({
                "kind": "near_parallel",
                "a": a, "b": b,
                "a_from": float(a_from), "a_to": float(a_to),
                "b_from": float(b_from), "b_to": float(b_to),
                "side": side,
                "consistency": abs(sum(sides)) / len(sides),
                "mean_sep_m": float(sum(seps) / len(seps)),
                "length_m": float(a_to - a_from),
            })
    if verbose:
        print(f"  pair candidates: {len(pair_hits)}  qualified runs: {len(runs)}")
    return runs


# --------------------------------------------------------------------------
# Path A — chains that share a PHYSICAL ALIGNMENT
#
# 913 N02 alignments (423.6 km) carry more than one railway identity: the
# geometry is byte-identical, so separation is exactly zero and the cross
# product that decides "side" is pure noise. These need no geometric matching
# at all — membership is already known from the alignment table — so they get
# their own deterministic path and never reach the near-parallel detector.
# --------------------------------------------------------------------------

def detect_shared_alignments(chains, verbose=True):
    """Return runs for chains that share alignments, with side=0 (undecided);
    `assign` orders them purely by the stable key."""
    ali_to_chains = defaultdict(set)
    for ci, ch in enumerate(chains):
        for a in ch["alignments"]:
            ali_to_chains[a].add(ci)

    # per chain, the measure interval covered by each alignment
    spans = defaultdict(dict)          # chain -> alignment -> [lo, hi]
    for ci, ch in enumerate(chains):
        meas = ch["measures"]
        pos = 0
        # walk stitched sections to recover each section's measure span
        acc = 0.0
        for k, sec_idx in enumerate(ch["sections"]):
            a = ch["alignments"][k]
            # section length within the chain
            seg_len = ch["section_lengths"][k]
            lo, hi = acc, acc + seg_len
            acc = hi
            cur = spans[ci].get(a)
            if cur is None:
                spans[ci][a] = [lo, hi]
            else:
                cur[0] = min(cur[0], lo)
                cur[1] = max(cur[1], hi)

    runs = []
    for a, cis in ali_to_chains.items():
        if len(cis) < 2:
            continue
        cis = sorted(cis)
        for i in range(len(cis)):
            for j in range(i + 1, len(cis)):
                ca, cb = cis[i], cis[j]
                if chains[ca]["line_key"] == chains[cb]["line_key"]:
                    continue
                sa, sb = spans[ca].get(a), spans[cb].get(a)
                if not sa or not sb:
                    continue
                if (sa[1] - sa[0]) < 1.0:
                    continue
                runs.append({
                    "a": ca, "b": cb,
                    "a_from": sa[0], "a_to": sa[1],
                    "b_from": sb[0], "b_to": sb[1],
                    "side": 0, "consistency": 1.0,
                    "mean_sep_m": 0.0,
                    "length_m": sa[1] - sa[0],
                    "kind": "shared_alignment",
                })
    if verbose:
        print(f"  shared-alignment runs: {len(runs)}"
              f"  km={sum(r['length_m'] for r in runs)/1000:.1f}")
    return runs


# --------------------------------------------------------------------------
# lane assignment
# --------------------------------------------------------------------------

def assign(chains, runs, verbose=True):
    """Break each chain's measure axis into intervals and give each interval a
    signed lane, so that within any corridor the members are ordered
    consistently and symmetric about the shared centreline."""
    # 1. collect breakpoints per chain
    cuts = defaultdict(set)
    for r in runs:
        cuts[r["a"]].update((r["a_from"], r["a_to"]))
        cuts[r["b"]].update((r["b_from"], r["b_to"]))

    # 2. for every chain interval, which other chains share it, and on which side
    intervals = defaultdict(list)
    for ci, cs in cuts.items():
        pts = sorted({0.0, chains[ci]["length_m"], *cs})
        for i in range(len(pts) - 1):
            lo, hi = pts[i], pts[i + 1]
            if hi - lo < 1.0:
                continue
            intervals[ci].append([lo, hi, []])

    def touch(ci, lo, hi, other, side, sep):
        for iv in intervals[ci]:
            if iv[0] >= hi - 1 or iv[1] <= lo + 1:
                continue
            iv[2].append((other, side, sep))

    for r in runs:
        touch(r["a"], r["a_from"], r["a_to"], r["b"], r["side"], r["mean_sep_m"])
        touch(r["b"], r["b_from"], r["b_to"], r["a"], -r["side"], r["mean_sep_m"])

    # 3. stable ordering key — never object iteration order
    def sort_key(ci):
        ch = chains[ci]
        return (-ch["rank"], ch["operator"], ch["line"], ch["chain_index"])

    lanes = []
    stats = {"intervals": 0, "laned": 0, "max_members": 0}
    for ci, ivs in intervals.items():
        for lo, hi, others in ivs:
            stats["intervals"] += 1
            if not others:
                continue
            # members of this corridor slice = self + others, deduped
            members = {ci: 0}
            for oc, side, sep in others:
                members.setdefault(oc, side)
            if len(members) < 2:
                continue
            stats["max_members"] = max(stats["max_members"], len(members))
            # order: left side first, then the stable key
            ordered = sorted(members.items(),
                             key=lambda kv: (kv[1], sort_key(kv[0])))
            n = min(len(ordered), MAX_LANES)
            ordered = ordered[:n]
            centre = (n - 1) / 2.0
            for rank_i, (mc, _side) in enumerate(ordered):
                if mc != ci:
                    continue
                off = rank_i - centre
                if abs(off) > 1e-9:
                    lanes.append({
                        "chain": ci,
                        "from_m": lo,
                        "to_m": hi,
                        "offset": off,
                        "members": n,
                    })
                    stats["laned"] += 1
    if verbose:
        print(f"  chain intervals: {stats['intervals']}  laned: {stats['laned']}"
              f"  max corridor members: {stats['max_members']}")
    return lanes, stats


def merge_lanes(lanes):
    """Join touching intervals that carry the same offset, so the displacement
    profile has as few transitions as possible."""
    by_chain = defaultdict(list)
    for l in lanes:
        by_chain[l["chain"]].append(l)
    out = []
    for ci, items in by_chain.items():
        items.sort(key=lambda l: l["from_m"])
        cur = dict(items[0])
        for nxt in items[1:]:
            if (abs(nxt["offset"] - cur["offset"]) < 1e-9
                    and nxt["from_m"] - cur["to_m"] < 1.0):
                cur["to_m"] = nxt["to_m"]
            else:
                out.append(cur)
                cur = dict(nxt)
        out.append(cur)
    return out
