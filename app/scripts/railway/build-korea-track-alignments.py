#!/usr/bin/env python3
"""Turn the OpenStreetMap South Korea extract into one groomed centre line per
physical Korean railway, with its stations in running order.

Why OSM: Korea publishes no open track geometry. 국토지리정보원's 철도중심선 lives
behind 국가공간정보포털 (the domain no longer resolves) and V-World's API needs an
account, so the tracks come from OSM (ODbL) while every station name, position
and distance comes from the official files (see fetch-korea-official-data.py).

Why not Overpass: nationwide queries time out and the tiled fallback is rate
limited; the Geofabrik regional extract is the same data in one download.

Two geometry sources, because Korean OSM is tagged two different ways:

* route relations — metro, light rail, monorail and KORAIL's metropolitan
  services carry their ways in running order and their stops as ordered
  members. Chaining ONE relation by exact shared node ids yields a single
  continuous line (the Hong Kong method).
* named ways — mainlines (경부선 …) have no infrastructure relation, only
  hundreds of named ways, one per track: `name=경부선` alone is 1,477 ways and
  1,079 km of rail for a 441.7 km railway. Chaining them would triple the
  mileage, so each line is rebuilt by routing between its own stations over a
  graph of just that name's track (the Taiwan method).

Output: data/raw/railway/kr/kr-track-alignments.json
"""
import argparse, collections, heapq, json, math, os, re, sys

APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_OUTPUT = os.path.join(
    APP_DIR, "data", "raw", "railway", "kr", "kr-track-alignments.json"
)

M_LAT, M_LON = 110540.0, 88800.0
RAIL_TYPES = {"rail", "light_rail", "subway", "monorail", "tram", "narrow_gauge"}
SKIP_SERVICE = {"yard", "siding", "spur", "crossover"}
STATION_TAGS = {"station", "halt", "tram_stop"}
JOIN_M = 150.0             # gap welded while chaining relation member ways
BRIDGE_M = 1200.0          # gap welded between components of one named line
STATION_RADIUS_M = 300.0   # station -> named line membership
DESPIKE_TURN = 55.0
DESPIKE_EDGE_M = 30.0
REVERSAL_TURN = 150.0
SIMPLIFY_M = 1.5
DIR_SUFFIX = re.compile(r"\s*[:：].*$")


def dist_m(a, b):
    return math.hypot((a[0] - b[0]) * M_LON, (a[1] - b[1]) * M_LAT)


def polyline_km(cs):
    return sum(dist_m(a, b) for a, b in zip(cs, cs[1:])) / 1000.0


def turn_deg(a, b, c):
    v1 = ((b[0] - a[0]) * M_LON, (b[1] - a[1]) * M_LAT)
    v2 = ((c[0] - b[0]) * M_LON, (c[1] - b[1]) * M_LAT)
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return 0.0
    cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(cos))


def despike(cs):
    """Drop micro spikes and 180-degree reversals (the Hong Kong grooming)."""
    out = list(cs)
    changed = True
    while changed and len(out) > 2:
        changed = False
        for i in range(1, len(out) - 1):
            t = turn_deg(out[i - 1], out[i], out[i + 1])
            e = min(dist_m(out[i - 1], out[i]), dist_m(out[i], out[i + 1]))
            if (t > DESPIKE_TURN and e < DESPIKE_EDGE_M) or t > REVERSAL_TURN:
                del out[i]
                changed = True
                break
    return out


def chaikin(cs, passes=2):
    for _ in range(passes):
        if len(cs) < 3:
            return cs
        out = [cs[0]]
        for a, b in zip(cs, cs[1:]):
            out.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
            out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        out.append(cs[-1])
        cs = out
    return cs


def simplify(cs, tol_m=SIMPLIFY_M):
    if len(cs) < 3:
        return cs
    keep = [False] * len(cs)
    keep[0] = keep[-1] = True
    stack = [(0, len(cs) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = cs[i]
        bx, by = cs[j]
        dx, dy = (bx - ax) * M_LON, (by - ay) * M_LAT
        L2 = dx * dx + dy * dy
        worst, wi = 0.0, None
        for k in range(i + 1, j):
            px, py = (cs[k][0] - ax) * M_LON, (cs[k][1] - ay) * M_LAT
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / L2))
            d = math.hypot(px - t * dx, py - t * dy)
            if d > worst:
                worst, wi = d, k
        if wi is not None and worst > tol_m:
            keep[wi] = True
            stack.append((i, wi))
            stack.append((wi, j))
    return [c for c, k in zip(cs, keep) if k]


def groom(cs):
    return simplify(chaikin(despike(cs)))


# ---------------------------------------------------------------- extraction
def extract(pbf_path):
    import osmium

    class Handler(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways, self.nodes, self.rels = [], [], []

        def node(self, n):
            rw = n.tags.get("railway")
            pt = n.tags.get("public_transport")
            if rw in STATION_TAGS or rw == "stop" or pt in {"stop_position", "station"}:
                self.nodes.append({
                    "id": n.id, "name": n.tags.get("name"),
                    "name_en": n.tags.get("name:en"),
                    "name_zh": n.tags.get("name:zh") or n.tags.get("name:ko-Hani"),
                    "railway": rw, "station": n.tags.get("station"),
                    "operator": n.tags.get("operator"),
                    "lon": round(n.location.lon, 7), "lat": round(n.location.lat, 7),
                })

        def way(self, w):
            if w.tags.get("railway") not in RAIL_TYPES:
                return
            if w.tags.get("service") in SKIP_SERVICE:
                return
            try:
                coords = [(round(n.location.lon, 7), round(n.location.lat, 7)) for n in w.nodes]
            except osmium.InvalidLocationError:
                return
            if len(coords) < 2:
                return
            t = w.tags
            self.ways.append({
                "id": w.id, "nodes": [n.ref for n in w.nodes], "coords": coords,
                "tags": {k: t.get(k) for k in ("railway", "name", "usage", "operator", "tunnel", "bridge")
                         if t.get(k)},
            })

        def relation(self, r):
            t = r.tags
            if t.get("type") != "route" or t.get("route") not in RAIL_TYPES | {"train", "railway"}:
                return
            self.rels.append({
                "id": r.id,
                "tags": {k: t.get(k) for k in ("route", "name", "ref", "operator", "colour", "network")
                         if t.get(k)},
                "members": [{"type": m.type, "ref": m.ref, "role": m.role} for m in r.members],
            })

    h = Handler()
    h.apply_file(pbf_path, locations=True, idx="flex_mem")
    return h.ways, h.nodes, h.rels


# ------------------------------------------------------------------ chaining
def chain(ways):
    parts, nodes, coords = [], [], []
    for w in ways:
        ns, cs = w["nodes"], [tuple(c) for c in w["coords"]]
        if not nodes:
            nodes, coords = list(ns), list(cs)
            continue
        if nodes[-1] == ns[0]:
            nodes += ns[1:]; coords += cs[1:]
        elif nodes[-1] == ns[-1]:
            nodes += ns[::-1][1:]; coords += cs[::-1][1:]
        elif nodes[0] == ns[-1]:
            nodes = ns + nodes[1:]; coords = cs + coords[1:]
        elif nodes[0] == ns[0]:
            nodes = ns[::-1] + nodes[1:]; coords = cs[::-1] + coords[1:]
        else:
            d0, d1 = dist_m(coords[-1], cs[0]), dist_m(coords[-1], cs[-1])
            if min(d0, d1) <= JOIN_M:
                if d1 < d0:
                    ns, cs = ns[::-1], cs[::-1]
                nodes += ns; coords += cs
            else:
                parts.append(coords)
                nodes, coords = list(ns), list(cs)
    if coords:
        parts.append(coords)
    return parts


def project(coords, cum, pt):
    """(chainage, deviation) of the nearest point; deviation is None if the
    polyline is degenerate, so the JSON never carries Infinity."""
    best = (0.0, float("inf"))
    for i in range(len(coords) - 1):
        ax, ay = coords[i]
        bx, by = coords[i + 1]
        dx, dy = (bx - ax) * M_LON, (by - ay) * M_LAT
        px, py = (pt[0] - ax) * M_LON, (pt[1] - ay) * M_LAT
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / L2))
        d = math.hypot(px - t * dx, py - t * dy)
        if d < best[1]:
            best = (cum[i] + t * math.sqrt(L2), d)
    return best if math.isfinite(best[1]) else (best[0], None)


def cumulative(coords):
    cum = [0.0]
    for a, b in zip(coords, coords[1:]):
        cum.append(cum[-1] + dist_m(a, b))
    return cum


def base_name(name):
    n = DIR_SUFFIX.sub("", name or "").strip()
    return re.sub(r"\s*(내선순환|외선순환|상행|하행|급행)\s*$", "", n).strip()


def lines_from_relations(ways_by_id, node_by_id, rels):
    groups = collections.defaultdict(list)
    for r in rels:
        nm = r["tags"].get("name") or r["tags"].get("ref")
        if nm:
            groups[base_name(nm)].append(r)
    out = {}
    for name, rs in groups.items():
        best = None
        for r in rs:
            stops = [m for m in r["members"] if m["type"] == "n" and m["role"].startswith(("stop", "platform"))]
            member_ways = [ways_by_id[m["ref"]] for m in r["members"]
                           if m["type"] == "w" and not m["role"] and m["ref"] in ways_by_id]
            if len(stops) < 2 or not member_ways:
                continue
            score = (len(stops), sum(len(w["coords"]) for w in member_ways))
            if best is None or score > best[0]:
                best = (score, r, stops, member_ways)
        if best is None:
            continue
        _, r, stops, member_ways = best
        parts = sorted(chain(member_ways), key=polyline_km, reverse=True)
        coords = groom(parts[0])
        cum = cumulative(coords)
        seq, seen = [], set()
        for m in stops:
            n = node_by_id.get(m["ref"])
            if not n or not n.get("name") or n["name"] in seen:
                continue
            seen.add(n["name"])
            ch, dev = project(coords, cum, (n["lon"], n["lat"]))
            seq.append({"name": n["name"], "name_en": n.get("name_en"), "name_zh": n.get("name_zh"),
                        "lon": n["lon"], "lat": n["lat"], "chainage_m": round(ch, 1),
                        "deviation_m": round(dev, 1) if dev is not None else None})
        if len(seq) < 2:
            continue
        out[name] = {"source": "relation", "relation": r["id"], "route": r["tags"].get("route"),
                     "operator": r["tags"].get("operator"), "colour": r["tags"].get("colour"),
                     "km": round(polyline_km(coords), 3), "parts": len(parts),
                     "coords": [[round(x, 7), round(y, 7)] for x, y in coords], "stops": seq}
    return out


def graph_of(ways):
    g = collections.defaultdict(list)
    xy = {}
    for w in ways:
        ns, cs = w["nodes"], [tuple(c) for c in w["coords"]]
        for n, c in zip(ns, cs):
            xy[n] = c
        for a, b, ca, cb in zip(ns, ns[1:], cs, cs[1:]):
            d = dist_m(ca, cb)
            if d > 0:
                g[a].append((b, d))
                g[b].append((a, d))
    return g, xy


def components(g):
    seen, out = set(), []
    for s in g:
        if s in seen:
            continue
        stack, comp = [s], []
        seen.add(s)
        while stack:
            n = stack.pop()
            comp.append(n)
            for nx, _ in g[n]:
                if nx not in seen:
                    seen.add(nx)
                    stack.append(nx)
        out.append(comp)
    return out


def weld(g, xy, comps):
    if len(comps) < 2:
        return 0
    comps = sorted(comps, key=len, reverse=True)
    merged, rest, welds = list(comps[0]), comps[1:], 0
    progress = True
    while progress and rest:
        progress = False
        for idx, comp in enumerate(rest):
            best = None
            for n in comp:
                for m in merged:
                    d = dist_m(xy[n], xy[m])
                    if best is None or d < best[0]:
                        best = (d, n, m)
            if best and best[0] <= BRIDGE_M:
                d, n, m = best
                g[n].append((m, d))
                g[m].append((n, d))
                merged.extend(comp)
                rest.pop(idx)
                welds += 1
                progress = True
                break
    return welds


def route(g, a, b, limit_m=700000):
    dist, prev = {a: 0.0}, {}
    pq = [(0.0, a)]
    while pq:
        d, n = heapq.heappop(pq)
        if d > dist.get(n, float("inf")):
            continue
        if n == b:
            break
        if d > limit_m:
            continue
        for nx, w in g[n]:
            nd = d + w
            if nd < dist.get(nx, float("inf")):
                dist[nx] = nd
                prev[nx] = n
                heapq.heappush(pq, (nd, nx))
    if b not in dist:
        return None, None
    path = [b]
    while path[-1] in prev:
        path.append(prev[path[-1]])
    return path[::-1], dist[b]


def lines_from_named_ways(ways, stations, skip_names):
    by_name = collections.defaultdict(list)
    for w in ways:
        n = w["tags"].get("name")
        if n and n not in skip_names:
            by_name[n].append(w)
    grid = collections.defaultdict(list)
    for s in stations:
        if s.get("name") and s.get("railway") in STATION_TAGS:
            grid[(int(s["lat"] / 0.01), int(s["lon"] / 0.01))].append(s)

    def near(lon, lat, radius):
        r = int(radius / (0.01 * M_LAT)) + 1
        ci, cj = int(lat / 0.01), int(lon / 0.01)
        for i in range(ci - r, ci + r + 1):
            for j in range(cj - r, cj + r + 1):
                for s in grid.get((i, j), ()):
                    d = dist_m((lon, lat), (s["lon"], s["lat"]))
                    if d <= radius:
                        yield d, s

    out = {}
    for name, group in by_name.items():
        members = {}
        for w in group:
            for c in w["coords"]:
                for d, s in near(c[0], c[1], STATION_RADIUS_M):
                    cur = members.get(s["name"])
                    if cur is None or d < cur[0]:
                        members[s["name"]] = (d, s)
        if len(members) < 2:
            continue
        g, xy = graph_of(group)
        welds = weld(g, xy, components(g))
        snapped = []
        for d, s in members.values():
            best, bd = None, float("inf")
            for nid, c in xy.items():
                dd = dist_m((s["lon"], s["lat"]), c)
                if dd < bd:
                    best, bd = nid, dd
            snapped.append({**s, "node": best, "snap_m": round(bd, 1)})
        far = max(((dist_m((a["lon"], a["lat"]), (b["lon"], b["lat"])), i, j)
                   for i, a in enumerate(snapped) for j, b in enumerate(snapped) if i < j), default=None)
        if not far:
            continue
        _, i, j = far
        spine, _ = route(g, snapped[i]["node"], snapped[j]["node"])
        if not spine:
            # Disconnected in OSM beyond BRIDGE_M (수인선 is mapped in pieces):
            # fall back to the longest continuous path in the biggest component
            # so the line is still published instead of silently vanishing.
            comps = components(g)
            big = max(comps, key=len)
            far_node = max(big, key=lambda n: dist_m(xy[n], xy[big[0]]))
            other = max(big, key=lambda n: dist_m(xy[n], xy[far_node]))
            spine, _ = route(g, far_node, other)
            print(f"  ~ {name}: station spine failed, used the longest component path")
            if not spine:
                print(f"  ! {name}: no usable geometry, dropped")
                continue
        coords = groom([xy[n] for n in spine])
        cum = cumulative(coords)
        seq = []
        for s in snapped:
            ch, dev = project(coords, cum, (s["lon"], s["lat"]))
            seq.append({"name": s["name"], "name_en": s.get("name_en"), "name_zh": s.get("name_zh"),
                        "lon": s["lon"], "lat": s["lat"], "chainage_m": round(ch, 1),
                        "deviation_m": round(dev, 1) if dev is not None else None})
        seq.sort(key=lambda s: s["chainage_m"])
        out[name] = {"source": "named-ways", "route": group[0]["tags"].get("railway"),
                     "usage": group[0]["tags"].get("usage"),
                     "operator": group[0]["tags"].get("operator"),
                     "km": round(polyline_km(coords), 3), "welds": welds,
                     "track_km": round(sum(polyline_km(w["coords"]) for w in group), 1),
                     "coords": [[round(x, 7), round(y, 7)] for x, y in coords], "stops": seq}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pbf", default=os.path.expanduser(
        "~/Library/Caches/japan-train-map/south-korea-latest.osm.pbf"))
    ap.add_argument("--output", default=DEFAULT_OUTPUT)
    args = ap.parse_args()
    ways, nodes, rels = extract(args.pbf)
    print(f"OSM: {len(ways)} rail ways, {len(nodes)} station/stop nodes, {len(rels)} route relations")
    ways_by_id = {w["id"]: w for w in ways}
    node_by_id = {n["id"]: n for n in nodes}
    rel_lines = lines_from_relations(ways_by_id, node_by_id, rels)
    print(f"relation lines: {len(rel_lines)}")
    named = lines_from_named_ways(ways, nodes, skip_names=set())
    print(f"named-way lines: {len(named)}")
    payload = {"relation_lines": rel_lines, "named_lines": named}
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, allow_nan=False)
    print("written:", args.output)
    for title, group in (("relation", rel_lines), ("named", named)):
        rows = sorted(((v["km"], len(v["stops"]), k) for k, v in group.items()), reverse=True)[:25]
        print(f"\n== {title} lines (top 25 by km)")
        for km, ns, k in rows:
            print(f"   {km:8.1f} km {ns:4d} stops  {k}")


if __name__ == "__main__":
    main()
