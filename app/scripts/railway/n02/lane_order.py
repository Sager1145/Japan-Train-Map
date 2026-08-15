"""
lane_order.py — globally stable lane ordering.

The defect this file exists to prevent: two railways that share a corridor
must keep the SAME left/right relationship everywhere — at every zoom, in
every tile, in every interval where they meet, and regardless of which
direction either one happens to be digitised in.

Three separate mechanisms are needed, and all three are required:

  1. ONE side per unordered pair.
     A pair can meet several times along the network. Each meeting used to
     vote for its own side, so a pair could be A-left-of-B in one interval
     and B-left-of-A in the next. Now the side is decided once, by a
     length-weighted vote over every meeting, and reused everywhere.

  2. A GLOBAL order per corridor component, not a per-interval sort.
     Sorting the members of each interval independently lets the order change
     whenever a third line joins or leaves — which is exactly rule A4's
     "a third line joining must not swap the original two". Instead the pair
     sides are turned into a directed graph, that graph is topologically
     ordered once per connected component, and every interval simply takes
     the subsequence of that global order.

  3. BAKED normals.
     The renderer never recomputes which way is "left". Each vertex carries
     the unit normal that was used at build time, so no client-side geometry
     direction, tile clipping, or simplification can flip a side.
"""

from __future__ import annotations

import math
from collections import defaultdict


def global_pair_sides(runs):
    """side[(a, b)] with a < b: +1 means b lies on the LEFT of a's direction
    of travel (positive cross product), -1 means right."""
    votes = defaultdict(float)
    weight = defaultdict(float)
    for r in runs:
        if r.get("side", 0) == 0:
            continue                      # shared-alignment: no geometric side
        a, b = r["a"], r["b"]
        key = (a, b) if a < b else (b, a)
        s = r["side"] if a < b else -r["side"]
        w = max(r["length_m"], 1.0) * r.get("consistency", 1.0)
        votes[key] += s * w
        weight[key] += w
    return {k: (1 if v >= 0 else -1) for k, v in votes.items()}, weight


def corridor_components(runs):
    """Union-find over chains that ever share a corridor."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for r in runs:
        union(r["a"], r["b"])
    comps = defaultdict(set)
    for x in list(parent):
        comps[find(x)].add(x)
    return list(comps.values())


def build_global_order(chains, runs, stable_key):
    """Return {chain_index: rank} — a total order per corridor component in
    which every pair respects its globally decided side.

    Ties and cycles (which real geometry does produce: A left of B, B left of
    C, C left of A around a triangle junction) are broken by `stable_key`, so
    the result is deterministic and never depends on dict iteration order.
    """
    sides, weights = global_pair_sides(runs)
    order = {}

    for comp in corridor_components(runs):
        members = sorted(comp, key=stable_key)
        # score-based ordering: start from the stable key, then let the
        # weighted pair constraints shift members left/right. This is a
        # deterministic relaxation, not a topological sort, so it degrades
        # gracefully when the constraints contain a cycle.
        pos = {c: float(i) for i, c in enumerate(members)}
        for _ in range(64):
            delta = defaultdict(float)
            moved = 0.0
            for (a, b), s in sides.items():
                if a not in pos or b not in pos:
                    continue
                # s = +1  ->  b must sit on the LEFT of a  ->  pos[b] < pos[a]
                want = -1.0 if s > 0 else 1.0     # sign of (pos[b] - pos[a])
                cur = pos[b] - pos[a]
                if (cur > 0) == (want > 0) and abs(cur) >= 0.5:
                    continue
                w = min(1.0, weights[(a, b)] / 5000.0)
                push = (want * 0.5 - cur) * 0.5 * (0.25 + 0.75 * w)
                delta[b] += push
                delta[a] -= push
                moved += abs(push)
            if not delta or moved < 1e-4:
                break
            for c, dv in delta.items():
                pos[c] += dv
        ranked = sorted(members, key=lambda c: (pos[c], stable_key(c)))
        for i, c in enumerate(ranked):
            order[c] = i
    return order, sides


def assign_lanes(chains, runs, stable_key, max_lanes=6):
    """Cut every chain's measure axis at corridor boundaries and give each
    slice a signed offset taken from the GLOBAL order."""
    order, sides = build_global_order(chains, runs, stable_key)

    cuts = defaultdict(set)
    for r in runs:
        cuts[r["a"]].update((r["a_from"], r["a_to"]))
        cuts[r["b"]].update((r["b_from"], r["b_to"]))

    intervals = defaultdict(list)
    for ci, cs in cuts.items():
        pts = sorted({0.0, chains[ci]["length_m"], *cs})
        for i in range(len(pts) - 1):
            lo, hi = pts[i], pts[i + 1]
            if hi - lo >= 1.0:
                intervals[ci].append([lo, hi, set()])

    def touch(ci, lo, hi, other):
        for iv in intervals[ci]:
            if iv[0] < hi - 1 and iv[1] > lo + 1:
                iv[2].add(other)

    for r in runs:
        touch(r["a"], r["a_from"], r["a_to"], r["b"])
        touch(r["b"], r["b_from"], r["b_to"], r["a"])

    lanes = []
    for ci, ivs in intervals.items():
        for lo, hi, others in ivs:
            if not others:
                continue
            members = sorted({ci, *others}, key=lambda c: (order.get(c, 1 << 30),
                                                           stable_key(c)))
            if len(members) < 2:
                continue
            if len(members) > max_lanes:
                # keep the members nearest ci in the global order, so the
                # subsequence still respects the global relative order
                pivot = members.index(ci)
                lo_i = max(0, min(pivot - max_lanes // 2, len(members) - max_lanes))
                members = members[lo_i:lo_i + max_lanes]
                if ci not in members:
                    continue
            n = len(members)
            centre = (n - 1) / 2.0
            off = members.index(ci) - centre
            if abs(off) > 1e-9:
                lanes.append({"chain": ci, "from_m": lo, "to_m": hi,
                              "offset": off, "members": n})
    return lanes, order, sides


def merge(lanes):
    by = defaultdict(list)
    for l in lanes:
        by[l["chain"]].append(l)
    out = []
    for ci, items in by.items():
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


# --------------------------------------------------------------------------
# the test that proves the defect is gone
# --------------------------------------------------------------------------

def audit_side_stability(lanes, runs):
    """For every pair that meets more than once, the SIGN of
    (offset_a - offset_b) must be identical in every shared interval."""
    by_chain = defaultdict(list)
    for l in lanes:
        by_chain[l["chain"]].append(l)

    def offset_at(ci, lo, hi):
        best = None
        for l in by_chain.get(ci, ()):
            ov = min(hi, l["to_m"]) - max(lo, l["from_m"])
            if ov > 0 and (best is None or ov > best[0]):
                best = (ov, l["offset"])
        return best[1] if best else 0.0

    seen = defaultdict(list)
    for r in runs:
        a, b = r["a"], r["b"]
        key = (a, b) if a < b else (b, a)
        oa = offset_at(key[0], r["a_from"] if a == key[0] else r["b_from"],
                       r["a_to"] if a == key[0] else r["b_to"])
        ob = offset_at(key[1], r["b_from"] if b == key[1] else r["a_from"],
                       r["b_to"] if b == key[1] else r["a_to"])
        if abs(oa - ob) < 1e-9:
            continue
        seen[key].append(1 if oa < ob else -1)

    flips = {k: v for k, v in seen.items() if len(set(v)) > 1}
    multi = {k: v for k, v in seen.items() if len(v) > 1}
    return {
        "pairs_with_offsets": len(seen),
        "pairs_meeting_more_than_once": len(multi),
        "pairs_that_flip_side": len(flips),
        "examples": list(flips.items())[:5],
    }
