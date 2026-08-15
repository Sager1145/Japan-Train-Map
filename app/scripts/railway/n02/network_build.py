"""
network_build.py — turn the raw N02 section soup into the renderer's object
model: physical alignments -> railway identities -> chains -> station anchors.

Object model (matches the rule set):

  physicalAlignment   one real corridor/track centre. Duplicate N02 geometry
                      collapses onto ONE of these, so 439.762 km of redundant
                      centreline is drawn once.
  railwayIdentity     (路線名, 運営会社). 596 of them.
  chain               a maximal continuous path within one railwayIdentity.
                      Carries the measure axis `s` that lanes, stations, dash
                      phase and labels all reference.
  stationPlatform     one station on one railway, anchored at a measure.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict

from n02_source import (classify, cumulative_measures, geodesic_m,
                        normalise_line_name, polyline_length_m)

NODE_DP = 5


def nkey(pt):
    return (round(pt[0], NODE_DP), round(pt[1], NODE_DP))


# --------------------------------------------------------------------------
# 1. physical alignments — collapse exact duplicate geometry
# --------------------------------------------------------------------------

def build_alignments(net):
    """Every duplicate group becomes ONE alignment carrying N railway ids.
    Returns (alignments, section_to_alignment)."""
    alignments = []
    sec2ali = {}
    by_geom = defaultdict(list)
    for s in net.sections:
        by_geom[s.geom_key].append(s.index)
    for gi, (gk, members) in enumerate(sorted(by_geom.items(), key=lambda kv: kv[1][0])):
        primary = net.sections[members[0]]
        alignments.append({
            "id": gi,
            "coords": primary.coords,
            "length_m": primary.length_m,
            "sections": members,
            "railways": sorted({net.sections[i].line_key for i in members}),
        })
        for i in members:
            sec2ali[i] = gi
    return alignments, sec2ali


# --------------------------------------------------------------------------
# 2. chains — maximal continuous paths inside one railway identity
# --------------------------------------------------------------------------

def _walk_chains(section_indices, sections):
    """Decompose one railway's sections into maximal paths.

    Node degree drives the walk: start at odd-degree/terminal nodes first so
    branches come out as separate chains rather than an arbitrary zig-zag,
    then mop up any remaining cycles (loop lines).
    """
    adj = defaultdict(list)          # node -> [(section_index, other_node)]
    for idx in section_indices:
        c = sections[idx].coords
        a, b = nkey(c[0]), nkey(c[-1])
        adj[a].append((idx, b))
        adj[b].append((idx, a))

    unused = set(section_indices)
    chains = []

    def walk(start):
        path, node = [], start
        while True:
            nxt = None
            for idx, other in adj[node]:
                if idx in unused:
                    nxt = (idx, other)
                    break
            if nxt is None:
                break
            idx, other = nxt
            unused.discard(idx)
            path.append((idx, node, other))
            node = other
            # stop at a junction so branches become their own chains
            if len(adj[node]) > 2:
                break
        return path

    # terminals first, then junctions, then whatever is left (cycles)
    order = ([n for n in adj if len(adj[n]) == 1]
             + [n for n in adj if len(adj[n]) > 2]
             + list(adj.keys()))
    for start in order:
        while any(idx in unused for idx, _ in adj[start]):
            p = walk(start)
            if p:
                chains.append(p)
    return chains


def _stitch(path, sections):
    """Concatenate a walked path into one coordinate list, flipping sections
    that are digitised against the direction of travel."""
    coords = []
    members = []
    for idx, from_node, _to in path:
        c = sections[idx].coords
        if nkey(c[0]) != from_node:
            c = list(reversed(c))
        if coords and nkey(coords[-1]) == nkey(c[0]):
            coords.extend(c[1:])
        else:
            coords.extend(c)
        members.append(idx)
    return coords, members


def build_chains(net, alignments, sec2ali):
    """One entry per (railway identity, chain)."""
    chains = []
    for line_key, indices in sorted(net.line_sections.items()):
        # drop duplicate-geometry twins WITHIN one railway (rare but real)
        seen_geom = set()
        keep = []
        for i in sorted(indices):
            g = net.sections[i].geom_key
            if g in seen_geom:
                continue
            seen_geom.add(g)
            keep.append(i)
        for ci, path in enumerate(_walk_chains(keep, net.sections)):
            coords, members = _stitch(path, net.sections)
            if len(coords) < 2:
                continue
            s0 = net.sections[members[0]]
            cls_counts = Counter(net.sections[i].cls for i in members)
            cls = cls_counts.most_common(1)[0][0]
            info = classify(s0.line, s0.operator, cls, s0.inst)
            chains.append({
                "line_key": line_key,
                "line": s0.line,
                "line_norm": normalise_line_name(s0.line),
                "operator": s0.operator,
                "chain_index": ci,
                "cls": cls,
                "inst": s0.inst,
                "coords": coords,
                "measures": cumulative_measures(coords),
                "length_m": polyline_length_m(coords),
                "sections": members,
                "alignments": [sec2ali[i] for i in members],
                **info,
            })
    return chains


# --------------------------------------------------------------------------
# 3. station anchors
# --------------------------------------------------------------------------

def _project_point(coords, measures, pt):
    """Nearest point on a polyline; returns (measure_m, distance_m)."""
    best = (0.0, float("inf"))
    px, py = pt
    coslat = math.cos(math.radians(py))
    for i in range(len(coords) - 1):
        ax, ay = coords[i]
        bx, by = coords[i + 1]
        dx, dy = (bx - ax) * coslat, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            t = 0.0
        else:
            t = ((px - ax) * coslat * dx + (py - ay) * dy) / L2
            t = max(0.0, min(1.0, t))
        qx, qy = ax + (bx - ax) * t, ay + (by - ay) * t
        d = geodesic_m(px, py, qx, qy)
        if d < best[1]:
            seg_len = measures[i + 1] - measures[i]
            best = (measures[i] + seg_len * t, d)
    return best


def build_station_anchors(net, chains):
    """Anchor every N02 station row onto the chain of its own railway.

    The station polyline IS a copy of a RailroadSection polyline, so the
    correct anchor is the ALONG-LINE MIDPOINT of that platform interval —
    not the centroid, which diverges by up to ~139 m on curved platforms.
    """
    by_line = defaultdict(list)
    for ci, ch in enumerate(chains):
        by_line[ch["line_key"]].append(ci)

    anchors = []
    unmatched = []
    for st in net.stations:
        cands = by_line.get(st.line_key, [])
        if not cands:
            unmatched.append((st.index, "no chain for line"))
            continue
        # midpoint of the platform polyline, by arc length
        pm = cumulative_measures(st.coords)
        half = pm[-1] / 2 if pm[-1] > 0 else 0.0
        mid = st.coords[0]
        for i in range(len(pm) - 1):
            if pm[i] <= half <= pm[i + 1]:
                seg = pm[i + 1] - pm[i]
                t = (half - pm[i]) / seg if seg else 0.0
                a, b = st.coords[i], st.coords[i + 1]
                mid = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                break
        best = None
        for ci in cands:
            ch = chains[ci]
            m, d = _project_point(ch["coords"], ch["measures"], mid)
            if best is None or d < best[2]:
                best = (ci, m, d)
        ci, m, d = best
        anchors.append({
            "station_index": st.index,
            "code": st.code,
            "group": st.group,
            "name": st.name,
            "line_key": st.line_key,
            "chain": ci,
            "measure_m": m,
            "anchor_error_m": d,
            "lon": mid[0], "lat": mid[1],
            "platform_len_m": st.length_m,
        })
    return anchors, unmatched


# --------------------------------------------------------------------------
# 4. station groups (places)
# --------------------------------------------------------------------------

def build_groups(net, anchors):
    g = defaultdict(lambda: {"platforms": [], "names": set(), "operators": set(),
                             "lines": set(), "insts": set()})
    by_index = {a["station_index"]: a for a in anchors}
    for st in net.stations:
        e = g[st.group]
        e["names"].add(st.name)
        e["operators"].add(st.operator)
        e["lines"].add(st.line_key)
        e["insts"].add(st.inst)
        if st.index in by_index:
            e["platforms"].append(by_index[st.index])
    out = {}
    for gid, e in g.items():
        lons = [p["lon"] for p in e["platforms"]] or [0]
        lats = [p["lat"] for p in e["platforms"]] or [0]
        out[gid] = {
            "group": gid,
            "name": sorted(e["names"])[0],
            "names": sorted(e["names"]),
            "operators": sorted(e["operators"]),
            "lines": sorted(e["lines"]),
            "platform_count": len(e["platforms"]),
            "operator_count": len(e["operators"]),
            "line_count": len(e["lines"]),
            "best_inst": min(e["insts"]) if e["insts"] else "5",
            "lon": sum(lons) / len(lons),
            "lat": sum(lats) / len(lats),
            "interchange": len(e["lines"]) > 1,
        }
    return out
