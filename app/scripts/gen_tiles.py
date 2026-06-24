#!/usr/bin/env python3
import json, math, os, sys
from collections import defaultdict
from PIL import Image, ImageDraw

KIND, ZMIN, ZMAX, OUT, DATA = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5]
SS = 2
TILE = 256
T = TILE * SS

if KIND == "rail":
    LINE_RGBA = (110, 110, 110, 150); LINE_W = 1 * SS; DRAW_DOTS = False
else:
    FOOT_RGBA = (70, 70, 70, 90); FOOT_W = 2 * SS
    DOT_R = 3 * SS; DOT_FILL = (255, 255, 255, 230); DOT_OUTLINE = (60, 60, 60, 230); DRAW_DOTS = True

data = json.load(open(DATA)); feats = data["features"]

def g(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n * TILE
    lr = math.radians(lat)
    y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n * TILE
    return x, y

def disp(ft):
    dp = ft["properties"].get("display_point")
    if isinstance(dp, (list, tuple)) and len(dp) == 2: return dp
    c = ft["geometry"]["coordinates"]; return c[len(c)//2]

total = 0
for z in range(ZMIN, ZMAX + 1):
    buckets = defaultdict(list); dots = defaultdict(list)
    for ft in feats:
        line = [g(lon, lat, z) for lon, lat in ft["geometry"]["coordinates"]]
        xs = [p[0] for p in line]; ys = [p[1] for p in line]
        tx0, tx1 = int(min(xs))//TILE, int(max(xs))//TILE
        ty0, ty1 = int(min(ys))//TILE, int(max(ys))//TILE
        if (tx1-tx0) <= 4 and (ty1-ty0) <= 4:
            for tx in range(tx0, tx1+1):
                for ty in range(ty0, ty1+1): buckets[(tx,ty)].append(line)
        else:
            for a, b in zip(line, line[1:]):
                for tx in range(int(min(a[0],b[0]))//TILE, int(max(a[0],b[0]))//TILE+1):
                    for ty in range(int(min(a[1],b[1]))//TILE, int(max(a[1],b[1]))//TILE+1):
                        buckets[(tx,ty)].append([a,b])
        if DRAW_DOTS:
            dx, dy = g(*disp(ft), z); dots[(int(dx)//TILE, int(dy)//TILE)].append((dx,dy))
    NMOD=int(os.environ.get("NMOD","1")); NREM=int(os.environ.get("NREM","0"))
    tiles = set(buckets) | set(dots)
    tiles = {t for t in tiles if t[0]%NMOD==NREM}
    for (tx, ty) in tiles:
        ox, oy = tx*TILE, ty*TILE
        img = Image.new("RGBA", (T, T), (0,0,0,0)); d = ImageDraw.Draw(img)
        for line in buckets.get((tx,ty), []):
            pts = [((px-ox)*SS, (py-oy)*SS) for px,py in line]
            if len(pts) >= 2:
                d.line(pts, fill=(LINE_RGBA if KIND=="rail" else FOOT_RGBA),
                       width=(LINE_W if KIND=="rail" else FOOT_W), joint="curve")
        if DRAW_DOTS:
            for px, py in dots.get((tx,ty), []):
                cx, cy = (px-ox)*SS, (py-oy)*SS
                d.ellipse([cx-DOT_R, cy-DOT_R, cx+DOT_R, cy+DOT_R], fill=DOT_FILL, outline=DOT_OUTLINE, width=SS)
        img = img.resize((TILE, TILE), Image.LANCZOS)
        td = os.path.join(OUT, str(z), str(tx)); os.makedirs(td, exist_ok=True)
        img.save(os.path.join(td, f"{ty}.png")); total += 1
    print(f"z{z}: {len(tiles)} tiles", flush=True)
print(f"TOTAL {total} -> {OUT}", flush=True)
