#!/usr/bin/env python3
"""Codec for the rail package (public/rail/jp-2025.json), "compact-v1" format.

The on-disk format is compact-v1: stations and segments are nested inside
their line, and everything derivable is omitted. Compared to the legacy flat
RailGeoPackage it removes, losslessly:

  * the `lineId` prefix repeated in every stationId / segmentId /
    fromStationId / toStationId / stationOrder entry (~60k repetitions)
  * `lines[].geometry`      — always the concatenation of the line's segments
  * `lines[].stationOrder`  — always the line's stations sorted by `seq`
  * `stations[].stationId`  — always `{lineId}:{stationGroupId}`
  * `stations[].seq`        — the array index
  * `segments[].segmentId/fromStationId/toStationId/fromSeq/toSeq` —
    segment i always joins station i to station i+1 (mod n for loop lines)
  * `segments[].isHSR`      — always equal to the line's isHSR
  * `lines[].country`       — always the package-level country
  * `lines[].logo`          — always `/rail/logos/{lineId}.png` when present
  * each segment's first coordinate when it equals the previous segment's
    last (the `shared` flag)

On-disk shapes:

  station row: [stationGroupId, name, lon, lat, (nameRoma, romaSourceCode)]
  segment row: [km, shared, coordinates, (arcDirection)]
  romaSource:  1 = "osm", 2 = "wikidata"

`load()` returns the EXPANDED legacy structure so existing tooling keeps
working; `save()` always writes compact-v1 (minified) plus a .gz sidecar.
Round-tripping expand(compress(pkg)) == pkg is guaranteed and asserted by
scripts/convert-rail-package.py before it overwrites anything.
"""

import gzip
import json
import os
import shutil
from collections import defaultdict

FORMAT = "compact-v1"
_RS_ENC = {"osm": 1, "wikidata": 2}
_RS_DEC = {v: k for k, v in _RS_ENC.items()}
_META_KEYS = ("version", "generatedAt", "crs", "country")


def compress(pkg):
    """Legacy flat RailGeoPackage -> compact-v1 dict."""
    segs_by = defaultdict(list)
    sts_by = defaultdict(list)
    for s in pkg["segments"]:
        segs_by[s["lineId"]].append(s)
    for s in pkg["stations"]:
        sts_by[s["lineId"]].append(s)

    out = {"format": FORMAT}
    for k in _META_KEYS:
        if k in pkg:
            out[k] = pkg[k]
    out["lines"] = []
    for l in pkg["lines"]:
        cl = {
            "id": l["lineId"],
            "name": l["name"],
            "operator": l["operator"],
            "rank": l["rank"],
            "color": l["color"],
        }
        if "nameRoma" in l:
            cl["nameRoma"] = l["nameRoma"]
        if l["isHSR"]:
            cl["isHSR"] = 1
        if l["isLoop"]:
            cl["isLoop"] = 1
        if "logo" in l:
            expected = "/rail/logos/%s.png" % l["lineId"]
            assert l["logo"] == expected, (l["lineId"], l["logo"])
            cl["logo"] = 1
        assert l.get("country", out.get("country")) == out.get("country")

        stations = sorted(sts_by[l["lineId"]], key=lambda x: x["seq"])
        assert [s["seq"] for s in stations] == list(range(len(stations)))
        rows = []
        for i, s in enumerate(stations):
            assert s["stationId"] == "%s:%s" % (l["lineId"], s["stationGroupId"])
            row = [s["stationGroupId"], s["name"], s["lon"], s["lat"]]
            if "nameRoma" in s:
                row += [s["nameRoma"], _RS_ENC[s["romaSource"]]]
            rows.append(row)
        cl["stations"] = rows

        segs = sorted(segs_by[l["lineId"]], key=lambda x: x["fromSeq"])
        n = len(stations)
        seg_rows = []
        prev_last = None
        for i, s in enumerate(segs):
            f, t = i, (i + 1) % n
            assert s["fromSeq"] == f and s["toSeq"] == t, s["segmentId"]
            assert s["fromStationId"] == "%s:%s" % (l["lineId"], rows[f][0])
            assert s["toStationId"] == "%s:%s" % (l["lineId"], rows[t][0])
            assert s["isHSR"] == l["isHSR"], s["segmentId"]
            c = s["geometry"]["coordinates"]
            shared = 1 if (prev_last is not None and c[0] == prev_last) else 0
            row = [s["km"], shared, c[1:] if shared else c]
            if "arcDirection" in s:
                row.append(s["arcDirection"])
            seg_rows.append(row)
            prev_last = c[-1]
        # a non-loop line has n-1 segments, a loop line n
        assert len(seg_rows) == (n if cl.get("isLoop") else max(n - 1, 0))
        cl["segments"] = seg_rows
        out["lines"].append(cl)
    return out


def expand(compact):
    """compact-v1 dict -> legacy flat RailGeoPackage."""
    assert compact.get("format") == FORMAT, compact.get("format")
    lines, segments, stations = [], [], []
    country = compact.get("country")
    for cl in compact["lines"]:
        lid = cl["id"]
        n = len(cl["stations"])
        st_ids = ["%s:%s" % (lid, row[0]) for row in cl["stations"]]
        for i, row in enumerate(cl["stations"]):
            st = {
                "stationId": st_ids[i],
                "name": row[1],
                "lineId": lid,
                "seq": i,
                "lon": row[2],
                "lat": row[3],
                "stationGroupId": row[0],
            }
            if len(row) > 4:
                st["nameRoma"] = row[4]
                st["romaSource"] = _RS_DEC[row[5]]
            stations.append(st)

        line_coords = []
        prev_last = None
        for i, row in enumerate(cl["segments"]):
            km, shared, c = row[0], row[1], row[2]
            coords = ([prev_last] + c) if shared else c
            f, t = i, (i + 1) % n
            seg = {
                "segmentId": "%s:%s-%s" % (lid, cl["stations"][f][0], cl["stations"][t][0]),
                "lineId": lid,
                "fromStationId": st_ids[f],
                "toStationId": st_ids[t],
                "fromSeq": f,
                "toSeq": t,
                "km": km,
                "isHSR": bool(cl.get("isHSR")),
                "geometry": {"type": "LineString", "coordinates": coords},
            }
            if len(row) > 3:
                seg["arcDirection"] = row[3]
            segments.append(seg)
            if line_coords and line_coords[-1] == coords[0]:
                line_coords.extend(coords[1:])
            else:
                line_coords.extend(coords)
            prev_last = coords[-1]

        line = {
            "lineId": lid,
            "name": cl["name"],
            "country": country,
            "operator": cl["operator"],
            "isHSR": bool(cl.get("isHSR")),
            "isLoop": bool(cl.get("isLoop")),
            "stationOrder": st_ids,
            "geometry": {"type": "LineString", "coordinates": line_coords},
            "rank": cl["rank"],
            "color": cl["color"],
        }
        if cl.get("logo"):
            line["logo"] = "/rail/logos/%s.png" % lid
        if "nameRoma" in cl:
            line["nameRoma"] = cl["nameRoma"]
        lines.append(line)

    pkg = {k: compact[k] for k in _META_KEYS if k in compact}
    pkg.update(lines=lines, segments=segments, stations=stations)
    return pkg


def load(path):
    """Read a rail package (compact-v1 or legacy) -> expanded legacy dict."""
    with open(path) as f:
        data = json.load(f)
    return expand(data) if data.get("format") == FORMAT else data


def save(path, pkg):
    """Write `pkg` (expanded legacy dict) as compact-v1 + refresh .gz sidecar."""
    compact = pkg if pkg.get("format") == FORMAT else compress(pkg)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(compact, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    with open(path, "rb") as src, gzip.open(path + ".gz", "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst)
