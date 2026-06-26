#!/usr/bin/env python3
"""
Build the offline basemap tile cache for the WebUI.

Computes a tile set covering a corridor around the current itinerary
(train-store.json stops, densified between consecutive stations) for zoom
levels 5-12, then downloads OSM tiles into app/public/tiles/{z}/{x}/{y}.png.

Re-run any time to refresh or after editing the itinerary. Existing tiles are
skipped, so it resumes safely. Tweak ZMIN/ZMAX/BUF below to change coverage.

Usage:  python3 scripts/build-offline-tiles.py [--list-only] [-P N]
Politeness: keep parallelism modest; these tiles come from the public OSM
tile servers whose usage policy discourages heavy bulk downloading.
"""
import json, math, os, sys, subprocess, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
TILES = os.path.join(HERE, "..", "public", "tiles")
ZMIN, ZMAX = 5, 12
BUF = {5:1,6:1,7:1,8:1,9:1,10:1,11:2,12:2}      # per-zoom tile buffer radius
STEP_KM = 3                                       # interstation densify step
# CARTO Positron-with-labels. NOTE: tile.openstreetmap.org refuses bulk/
# datacenter downloads (it serves an identical "access blocked" placeholder
# PNG for every request), so we use CARTO's basemaps, which serve real tiles.
# {s} is a CARTO subdomain a/b/c/d chosen per-tile to spread load.
TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

def station_points():
    s = json.load(open(os.path.join(DATA, "stations.json"), encoding="utf-8"))
    code = {}
    for f in s["features"]:
        g = f["geometry"]
        pts = (g["coordinates"] if g["type"] == "LineString"
               else max(g["coordinates"], key=len) if g["type"] == "MultiLineString"
               else [g["coordinates"]])
        mid = pts[len(pts)//2]
        code[f["properties"].get("N02_005c")] = (mid[1], mid[0])
    return code

def hav(a, b):
    R=6371; la1,lo1=map(math.radians,a); la2,lo2=map(math.radians,b)
    h=math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))

def corridor():
    code = station_points()
    store = json.load(open(os.path.join(DATA, "train-store.json"), encoding="utf-8"))
    pts = []
    for t in store["trains"]:
        seq = [code[st["n02_station_code"]] for st in t["stops"]
               if st["n02_station_code"] in code]
        for i, p in enumerate(seq):
            pts.append(p)
            if i+1 < len(seq):
                a, b = p, seq[i+1]; n = max(1, int(hav(a, b)/STEP_KM))
                for k in range(1, n):
                    f = k/n; pts.append((a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f))
    return pts

def deg2tile(lat, lon, z):
    n = 2**z
    return (int((lon+180)/360*n),
            int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n))

def tile_set():
    pts = corridor(); tiles = set()
    for z in range(ZMIN, ZMAX+1):
        b = BUF[z]
        for lat, lon in pts:
            x0, y0 = deg2tile(lat, lon, z)
            for dx in range(-b, b+1):
                for dy in range(-b, b+1):
                    x, y = x0+dx, y0+dy
                    if 0 <= x < 2**z and 0 <= y < 2**z:
                        tiles.add((z, x, y))
    return tiles

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-only", action="store_true")
    ap.add_argument("-P", type=int, default=16)
    a = ap.parse_args()
    tiles = sorted(tile_set())
    print(f"{len(tiles)} tiles z{ZMIN}-{ZMAX}")
    if a.list_only:
        return
    missing = [(z,x,y) for (z,x,y) in tiles
               if not (os.path.exists(f"{TILES}/{z}/{x}/{y}.png")
                       and os.path.getsize(f"{TILES}/{z}/{x}/{y}.png") > 0)]
    print(f"{len(missing)} missing — downloading with -P {a.P} ...")
    import concurrent.futures as cf
    def get(t):
        z,x,y = t; out = f"{TILES}/{z}/{x}/{y}.png"
        os.makedirs(os.path.dirname(out), exist_ok=True)
        s = "abcd"[(x + y) % 4]
        subprocess.run(["curl","-s","--max-time","12","-A",UA,"-o",out,
                        TILE_URL.format(s=s,z=z,x=x,y=y)], check=False)
        with open(out,"rb") as fh:
            if fh.read(4)[1:4] != b"PNG":
                os.remove(out); return 0
        return 1
    ok = 0
    with cf.ThreadPoolExecutor(max_workers=a.P) as ex:
        for i, r in enumerate(ex.map(get, missing), 1):
            ok += r
            if i % 200 == 0: print(f"  {i}/{len(missing)}")
    print(f"done: {ok} fetched, total on disk now {len(tiles)-len(missing)+ok}")

if __name__ == "__main__":
    main()
