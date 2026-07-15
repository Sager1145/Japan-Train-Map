#!/usr/bin/env python3
"""Restore full N02 accuracy to the map's rail package (public/rail/jp-2025.json).

The packaged segment geometries were simplified (~85k vertices vs ~405k in the
source). This script map-matches every segment's simplified polyline back onto
the untouched N02-25 RailroadSection data (data/rail-sections.json, identical
to the MLIT original), producing full-resolution geometry:

  per (operator, line) N02 sub-network
    -> vertex graph (consecutive coordinate pairs = edges, weight = meters)
    -> corridor-penalized A* from segment start to end: edge cost is inflated
       by squared distance from the segment's own simplified polyline, so the
       search stays on the correct track through parallel-line areas
       (総武快速/緩行 etc.) instead of zigzagging between tracks
    -> validate restored length against the package's original `km` field
       (which was computed BEFORE simplification and is ground truth)

Segment `km` fields are recomputed from the restored geometry; `lines[].geometry`
is rebuilt by concatenating each line's restored segments in stationOrder.
A `.bak` of the original package is written next to it once (reused as the
pristine input on re-runs, so the script is idempotent).
"""

import json, math, os, heapq, gzip, shutil
from collections import defaultdict

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG_PATH = os.path.join(APP, "public/rail/jp-2025.json")
N02_PATH = os.path.join(APP, "data/rail-sections.json")

# Package operator name -> N02_004 operator name.
OP_ALIASES = {
    "東京メトロ": "東京地下鉄",
    "Osaka Metro": "大阪市高速電気軌道",
}

R_LAT = 110574.0  # meters per degree latitude
def meters(a, b):
    dx = (a[0] - b[0]) * 111320.0 * math.cos(math.radians((a[1] + b[1]) / 2))
    dy = (a[1] - b[1]) * R_LAT
    return math.hypot(dx, dy)

def polyline_m(cs):
    return sum(meters(cs[i], cs[i + 1]) for i in range(len(cs) - 1))

def pt_seg_m(p, a, b):
    """meters from point p to segment a-b (local equirect projection)."""
    kx = 111320.0 * math.cos(math.radians(p[1]))
    px, py = p[0] * kx, p[1] * R_LAT
    ax, ay = a[0] * kx, a[1] * R_LAT
    bx, by = b[0] * kx, b[1] * R_LAT
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

CELL = 0.004  # spatial-hash cell (~400 m)

# Display geometry may be mildly decimated (invisible at map zooms) — the km
# fields are ALWAYS computed from the full-resolution matched path first, so
# statistics keep full precision. Override with DISPLAY_EPSILON_M=0 to ship
# the undecimated geometry.
DISPLAY_EPSILON_M = float(os.environ.get("DISPLAY_EPSILON_M", "5"))

def douglas_peucker(pts, eps_m):
    """Iterative DP keeping original points; eps in meters."""
    n = len(pts)
    if n < 3 or eps_m <= 0:
        return pts
    sx = 111320.0 * math.cos(math.radians(pts[0][1]))
    sy = R_LAT
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        s, e = stack.pop()
        ax, ay = pts[s][0] * sx, pts[s][1] * sy
        bx, by = pts[e][0] * sx, pts[e][1] * sy
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        max_d, idx = -1.0, -1
        for i in range(s + 1, e):
            px, py = pts[i][0] * sx, pts[i][1] * sy
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > max_d:
                max_d, idx = d, i
        if max_d > eps_m and idx != -1:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [p for i, p in enumerate(pts) if keep[i]]

def main():
    bak = PKG_PATH + ".bak"
    src_pkg = bak if os.path.exists(bak) else PKG_PATH  # idempotent re-runs
    pkg = json.load(open(src_pkg))
    n02 = json.load(open(N02_PATH))

    feats_by_key = defaultdict(list)
    for f in n02["features"]:
        p = f["properties"]
        feats_by_key[(p["N02_004"], p["N02_003"])].append(f["geometry"]["coordinates"])

    line_by_id = {l["lineId"]: l for l in pkg["lines"]}
    segs_by_line = defaultdict(list)
    for s in pkg["segments"]:
        segs_by_line[s["lineId"]].append(s)

    stats = dict(restored=0, kept=0, nokey=0, badlen=0)
    km_old_total = km_new_total = 0.0
    v_old = v_new = 0

    for line_id, segs in segs_by_line.items():
        line = line_by_id[line_id]
        key = (OP_ALIASES.get(line["operator"], line["operator"]), line["name"])
        for s in segs:
            km_old_total += s["km"]
            v_old += len(s["geometry"]["coordinates"])
        if key not in feats_by_key:
            stats["nokey"] += len(segs)
            stats["kept"] += len(segs)
            for s in segs:
                km_new_total += s["km"]
                v_new += len(s["geometry"]["coordinates"])
            continue

        # ---- vertex graph + spatial hash for this line ----
        adj = defaultdict(list)
        grid = defaultdict(list)
        seen = set()
        for coords in feats_by_key[key]:
            pts = [tuple(c) for c in coords]
            for i, p in enumerate(pts):
                if p not in seen:
                    seen.add(p)
                    grid[(int(p[0] / CELL), int(p[1] / CELL))].append(p)
                if i:
                    w = meters(pts[i - 1], p)
                    adj[pts[i - 1]].append((p, w))
                    adj[p].append((pts[i - 1], w))

        def snap(pt, max_m=600.0):
            cx, cy = int(pt[0] / CELL), int(pt[1] / CELL)
            best, bd = None, max_m
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for v in grid.get((cx + dx, cy + dy), ()):
                        d = meters(pt, v)
                        if d < bd:
                            bd, best = d, v
            return best

        for s in segs:
            guides = [tuple(c) for c in s["geometry"]["coordinates"]]
            a = snap(guides[0])
            b = snap(guides[-1])
            keep = False
            if a is None or b is None or a == b:
                keep = True
            else:
                # corridor index over guide polyline segments
                gseg_cells = defaultdict(list)
                for i in range(len(guides) - 1):
                    p, q = guides[i], guides[i + 1]
                    x0, x1 = sorted((int(p[0] / CELL), int(q[0] / CELL)))
                    y0, y1 = sorted((int(p[1] / CELL), int(q[1] / CELL)))
                    for cx in range(x0 - 1, x1 + 2):
                        for cy in range(y0 - 1, y1 + 2):
                            gseg_cells[(cx, cy)].append(i)

                dist_cache = {}
                def corridor_m(p):
                    d = dist_cache.get(p)
                    if d is None:
                        idxs = gseg_cells.get((int(p[0] / CELL), int(p[1] / CELL)))
                        if not idxs:
                            d = 900.0
                        else:
                            d = min(pt_seg_m(p, guides[i], guides[i + 1]) for i in idxs)
                        dist_cache[p] = d
                    return d

                def cost(u, v, w):
                    d = 0.5 * (corridor_m(u) + corridor_m(v))
                    k = min(d, 600.0) / 60.0
                    return w * (1.0 + k * k)

                guide_len = max(polyline_m(guides), meters(a, b))
                limit = guide_len * 8.0 + 2000.0
                gs = {a: 0.0}
                prev = {}
                pq = [(meters(a, b), a)]
                path = None
                while pq:
                    f, u = heapq.heappop(pq)
                    if u == b:
                        path = [u]
                        while u in prev:
                            u = prev[u]
                            path.append(u)
                        path = path[::-1]
                        break
                    gu = gs[u]
                    if gu > limit:
                        break
                    for v, w in adj[u]:
                        ng = gu + cost(u, v, w)
                        if ng < gs.get(v, 1e18):
                            gs[v] = ng
                            prev[v] = u
                            heapq.heappush(pq, (ng + meters(v, b), v))
                if path is None or len(path) < 2:
                    keep = True
                else:
                    full_coords = [[round(x, 5), round(y, 5)] for x, y in path]
                    full_coords = [c for i, c in enumerate(full_coords) if i == 0 or c != full_coords[i - 1]]
                    # km from the FULL-resolution matched path — statistics keep
                    # full precision regardless of display decimation below
                    new_km = round(polyline_m(full_coords) / 1000.0, 3)
                    # the pre-simplification km field is ground truth: reject wrong paths
                    if s["km"] > 0.05 and abs(new_km - s["km"]) / s["km"] > 0.20 and abs(new_km - s["km"]) > 0.4:
                        keep = True
                        stats["badlen"] += 1
                    else:
                        # display geometry: mild DP decimation (<= DISPLAY_EPSILON_M
                        # deviation, sub-pixel at map zooms)
                        disp = douglas_peucker(full_coords, DISPLAY_EPSILON_M)
                        s["geometry"] = {"type": "LineString", "coordinates": disp}
                        s["km"] = new_km
                        stats["restored"] += 1
                        km_new_total += new_km
                        v_new += len(disp)
            if keep:
                stats["kept"] += 1
                km_new_total += s["km"]
                v_new += len(s["geometry"]["coordinates"])

    # ---- rebuild lines[].geometry from restored segments ---------------------
    for line in pkg["lines"]:
        segs = sorted(segs_by_line.get(line["lineId"], []), key=lambda s: (s["fromSeq"], s["toSeq"]))
        if not segs:
            continue
        coords = []
        for s in segs:
            cs = s["geometry"]["coordinates"]
            if coords and coords[-1] == cs[0]:
                coords.extend(cs[1:])
            else:
                coords.extend(cs)
        if len(coords) >= 2:
            line["geometry"] = {"type": "LineString", "coordinates": coords}

    if not os.path.exists(bak):
        shutil.copyfile(PKG_PATH, bak)
    with open(PKG_PATH, "w") as f:
        json.dump(pkg, f, ensure_ascii=False, separators=(",", ":"))
    with open(PKG_PATH, "rb") as srcf, gzip.open(PKG_PATH + ".gz", "wb", compresslevel=9) as dst:
        shutil.copyfileobj(srcf, dst)

    print(json.dumps(stats))
    print(f"vertices: {v_old} -> {v_new}")
    print(f"km field total: {km_old_total:.0f} -> {km_new_total:.0f}")

if __name__ == "__main__":
    main()
