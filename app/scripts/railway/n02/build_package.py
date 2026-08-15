"""
build_package.py — emit the rebuilt Japan rail package.

Format `compact-v2`. It is a superset of `compact-v1`: every field the old
client reads is still there and still means the same thing, so an unmodified
reader degrades to the old behaviour instead of breaking.

What is new:
  segments[i][3]   per-vertex lane offset d, in LANE UNITS x1000 (int)
  lines[i].kind / colorPolicy / labelPolicy / lineCode / operatorShort
  lines[i].structure   tunnel/bridge intervals, with provenance
  stations           gain English + kana where OSM has them

THE ZOOM-INVARIANCE CONTRACT
----------------------------
`d` is a property of the vertex, decided once at build time. The renderer
computes the offset as

    offset_metres = d * LANE_PITCH_PX * metresPerPixel(zoom, lat)

so the on-screen gap between two lanes is the same at every zoom, and the
SIDE cannot change because it is baked into d's sign. The unit normal is
taken from the emitted vertex order, which is fixed; nothing downstream may
reverse a segment's coordinate order.
"""

from __future__ import annotations

import json
import math
import unicodedata
from collections import defaultdict

import numpy as np

LANE_PITCH_PX = 4.2


# --------------------------------------------------------------------------
# enrichment tables
# --------------------------------------------------------------------------

def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", (s or "")).replace(" ", "").replace("　", "")


def load_colours(op_path, line_path):
    ops = json.load(open(op_path))
    lines = json.load(open(line_path))
    ops = ops if isinstance(ops, list) else ops.get("operators", [])
    lines = lines if isinstance(lines, list) else lines.get("lines", [])
    op_by = {_norm(o["operator_n02"]): o for o in ops}
    line_by = {}
    for l in lines:
        keys = {l.get("line_n02"), l.get("line_normalised"), *(l.get("aliases") or [])}
        for k in keys:
            if k:
                line_by[(_norm(k), _norm(l["operator_n02"]))] = l
    return op_by, line_by


def load_station_names(path):
    rows = json.load(open(path))
    rows = rows if isinstance(rows, list) else list(rows.values())[0]
    return {r["n02_005g"]: r for r in rows}


def load_structure(path):
    rows = json.load(open(path))
    rows = rows if isinstance(rows, list) else list(rows.values())[0]
    return {r["section_index"]: r for r in rows}


# --------------------------------------------------------------------------
# colour resolution
# --------------------------------------------------------------------------

FALLBACK_BY_KIND = {
    "shinkansen": "#4a6fd4",
    "jr_conventional": "#3a8f4f",
    "subway": "#6f7bd6",
    "private": "#7a86a8",
    "third_sector": "#8a7fa8",
    "tram": "#c07a4a",
    "monorail": "#5f9ea0",
    "agt": "#5f9ea0",
    "funicular": "#8a6a4a",
    "maglev": "#9a5fb0",
}


def _lum(hexstr):
    h = hexstr.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def lighten_for_dark(hexstr, target=0.12):
    """Raise lightness, preserving hue and saturation, until the colour is
    readable on a near-black surface. Identity beats perceptual uniformity
    here: a line's hue is what the reader recognises."""
    import colorsys
    h = hexstr.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    for _ in range(48):
        if _lum("#%02x%02x%02x" % tuple(int(c * 255) for c in
                                        colorsys.hls_to_rgb(hh, ll, ss))) >= target:
            break
        ll = min(1.0, ll + 0.02)
    r2, g2, b2 = colorsys.hls_to_rgb(hh, ll, ss)
    return "#%02x%02x%02x" % (int(r2 * 255), int(g2 * 255), int(b2 * 255))


def build_operator_palette(chains_by_line, chain_ref, op_by, osm_colours):
    """Resolve ONE hue per operator, before any line is emitted.

    Doing this per line lets an operator whose own brand colour is unknown
    pick up a different OSM route colour on every line — which is exactly the
    per-line palette the colour policy exists to abolish. So: official brand
    value first; otherwise a single vote across that operator's OSM colours,
    weighted by line length; otherwise the kind fallback.
    """
    palette = {}
    votes = defaultdict(lambda: defaultdict(float))
    kinds = defaultdict(lambda: defaultdict(float))
    for (line, operator), cis in chains_by_line.items():
        ref = chain_ref(cis[0])
        length = sum(chain_ref(c)["length_m"] for c in cis)
        kinds[operator][ref["kind"]] += length
        rec = osm_colours.get((line, operator))
        if rec and rec.get("colour"):
            c = rec["colour"].lower()
            if not c.startswith("#"):
                c = "#" + c
            if len(c) == 4:
                c = "#" + "".join(ch * 2 for ch in c[1:])
            votes[operator][c] += length
    for operator in kinds:
        rec = op_by.get(_norm(operator))
        if rec and rec.get("color"):
            palette[operator] = (rec["color"].lower(),
                                 rec.get("source_url") or rec.get("source"))
            continue
        if votes[operator]:
            best = max(votes[operator].items(), key=lambda kv: kv[1])[0]
            palette[operator] = (best, "OpenStreetMap route relation (ODbL), "
                                       "majority vote over this operator's lines")
            continue
        kind = max(kinds[operator].items(), key=lambda kv: kv[1])[0]
        palette[operator] = (FALLBACK_BY_KIND[kind], "kind fallback")
    return palette


def resolve_colour(line, operator, info, op_by, line_by, osm_colours,
                   operator_palette=None):
    """Rule §9: per-LINE hue for the things the public calls a line,
    per-OPERATOR hue for the things it calls a company."""
    src = None
    colour = None
    code = None
    if info["colorPolicy"] == "line":
        rec = line_by.get((_norm(line), _norm(operator)))
        if rec and rec.get("color"):
            colour, src, code = rec["color"], rec.get("source_url") or rec.get("source"), rec.get("line_code")
    if colour is None and info["colorPolicy"] == "line":
        # a line-policy line with no published line colour still must not
        # invent one: fall back to its operator's single hue
        rec = osm_colours.get((line, operator))
        if rec and rec.get("colour"):
            colour, src = rec["colour"], "OpenStreetMap route relation (ODbL)"
    if colour is None and operator_palette is not None:
        colour, src = operator_palette.get(
            operator, (FALLBACK_BY_KIND[info["kind"]], "kind fallback"))
    if colour is None:
        colour, src = FALLBACK_BY_KIND[info["kind"]], "kind fallback"
    colour = colour.lower()
    if not colour.startswith("#"):
        colour = "#" + colour
    if len(colour) == 4:
        colour = "#" + "".join(c * 2 for c in colour[1:])
    return colour, src, code


# --------------------------------------------------------------------------
# emit
# --------------------------------------------------------------------------

def _decode_flat(flat):
    """Inverse of the delta-int encoder, for re-projecting stations onto the
    geometry that is actually emitted."""
    n = len(flat) // 2
    x, y = flat[0], flat[1]
    out = [(x / 1e5, y / 1e5)]
    for i in range(1, n):
        x += flat[i * 2]
        y += flat[i * 2 + 1]
        out.append((x / 1e5, y / 1e5))
    return out


def line_id(line, operator):
    return f"jp-{operator}-{line}"


def build(chains, anchors, groups, lanes, curves, net,
          op_by, line_by, osm_names, osm_struct, osm_colours,
          version="2025.4.0"):
    lane_by_chain = defaultdict(list)
    for l in lanes:
        lane_by_chain[l["chain"]].append(l)

    chains_by_line = defaultdict(list)
    for ci, ch in enumerate(chains):
        chains_by_line[ch["line_key"]].append(ci)

    anchors_by_line = defaultdict(list)
    for a in anchors:
        anchors_by_line[a["line_key"]].append(a)

    operator_palette = build_operator_palette(
        chains_by_line, lambda c: chains[c], op_by, osm_colours)

    out_lines = []
    stats = {"laned_chains": 0, "coloured_from_line": 0, "coloured_from_operator": 0,
             "coloured_from_osm": 0, "coloured_fallback": 0,
             "stations": 0, "stations_with_en": 0, "structure_intervals": 0}

    for line_key in sorted(chains_by_line):
        line, operator = line_key
        cis = sorted(chains_by_line[line_key],
                     key=lambda c: -chains[c]["length_m"])
        ref = chains[cis[0]]
        info = {"kind": ref["kind"], "colorPolicy": ref["colorPolicy"],
                "labelPolicy": ref["labelPolicy"], "rank": ref["rank"]}
        colour, csrc, code = resolve_colour(line, operator, info,
                                            op_by, line_by, osm_colours,
                                            operator_palette)
        if csrc == "kind fallback":
            stats["coloured_fallback"] += 1
        elif csrc and "OpenStreetMap" in str(csrc):
            stats["coloured_from_osm"] += 1
        elif info["colorPolicy"] == "line":
            stats["coloured_from_line"] += 1
        else:
            stats["coloured_from_operator"] += 1

        op_rec = op_by.get(_norm(operator)) or {}
        seg_pos = {ci: k for k, ci in enumerate(cis)}
        segments = []
        for ci in cis:
            cur = curves.get(ci)
            ch = chains[ci]
            if cur is not None and cur.get("resampled"):
                lon, lat, d = cur["lon"], cur["lat"], cur["d"]
                stats["laned_chains"] += 1
            else:
                base = ch.get("coords_dense") or ch["coords"]
                lon = np.array([c[0] for c in base])
                lat = np.array([c[1] for c in base])
                d = np.zeros(len(lon))
            # Delta-encoded integer coordinates at 1e-5 deg (~1.1 m), which is
            # exactly N02's own precision — 98.3% of its ordinates already lie
            # on that grid, so nothing is lost. Deltas are small integers, so
            # gzip compresses them far better than repeated 6-dp floats.
            qi = np.round(np.asarray(lon) * 1e5).astype(np.int64)
            qj = np.round(np.asarray(lat) * 1e5).astype(np.int64)
            # Densified samples can be closer than the 1e-5 deg (~1.1 m) grid,
            # in which case two of them quantise to the SAME point. Drop the
            # collapsed ones — a zero-length segment is a defect, and the lane
            # value they carried is preserved by keeping the first of the run.
            keep = [0]
            for k in range(1, len(qi)):
                if qi[k] != qi[keep[-1]] or qj[k] != qj[keep[-1]]:
                    keep.append(k)
            if len(keep) < 2:
                keep = [0, len(qi) - 1]
            qi, qj = qi[keep], qj[keep]
            d = np.asarray(d)[keep]
            flat = [int(qi[0]), int(qj[0])]
            for k in range(1, len(qi)):
                flat.append(int(qi[k] - qi[k - 1]))
                flat.append(int(qj[k] - qj[k - 1]))
            seg = [round(ch["length_m"] / 1000.0, 3), 0 if ci == cis[0] else 1,
                   flat]
            if np.any(np.abs(d) > 1e-6):
                dq = np.round(np.asarray(d) * 1000).astype(np.int64)
                nz = np.nonzero(dq)[0]
                lo_i, hi_i = int(nz[0]), int(nz[-1])
                # store only the active window, plus its start index
                seg.append([lo_i] + [int(v) for v in dq[lo_i:hi_i + 1]])
            segments.append(seg)

        # Stations are re-projected onto the FINAL emitted geometry.
        # The anchor measure was computed against the canonical polyline; the
        # emitted curve is arc-densified and, on a laned stretch, displaced.
        # The rule is that the dot centre lies on the line the reader actually
        # sees, so the authority is the emitted vertex list, not the input.
        emitted = []
        for seg in segments:
            emitted.append(_decode_flat(seg[2]))

        def snap(lon, lat, si):
            pts = emitted[si] if si < len(emitted) else None
            if not pts or len(pts) < 2:
                return lon, lat
            cl = math.cos(math.radians(lat))
            best = (lon, lat, float("inf"))
            for i in range(len(pts) - 1):
                ax, ay = pts[i]
                bx, by = pts[i + 1]
                dx, dy = (bx - ax) * cl, by - ay
                l2 = dx * dx + dy * dy
                t = 0.0 if l2 == 0 else max(0.0, min(1.0, (((lon - ax) * cl) * dx + (lat - ay) * dy) / l2))
                qx, qy = ax + (bx - ax) * t, ay + (by - ay) * t
                dd = ((qx - lon) * cl) ** 2 + (qy - lat) ** 2
                if dd < best[2]:
                    best = (qx, qy, dd)
            return best[0], best[1]

        # stations, ordered along the longest chain then by measure
        sts = []
        for a in sorted(anchors_by_line[line_key],
                        key=lambda a: (a["chain"], a["measure_m"])):
            g = groups.get(a["group"], {})
            nm = osm_names.get(a["group"]) or {}
            si = seg_pos.get(a["chain"], 0)
            slon, slat = snap(a["lon"], a["lat"], si)
            row = [a["code"], a["name"],
                   round(slon, 5), round(slat, 5)]
            en = nm.get("name_en")
            row.append(en or "")
            row.append(1 if g.get("interchange") else 0)
            row.append(int(round(a["measure_m"])))
            row.append(si)
            row.append(a["group"])
            sts.append(row)
            stats["stations"] += 1
            if en:
                stats["stations_with_en"] += 1

        # structure intervals, mapped onto chain measures
        structure = []
        for ci in cis:
            ch = chains[ci]
            acc = 0.0
            for k, sec_idx in enumerate(ch["sections"]):
                seg_len = ch["section_lengths"][k]
                rec = osm_struct.get(sec_idx)
                if rec:
                    for iv in rec.get("intervals", []):
                        if iv["structure"] in ("tunnel", "bridge"):
                            structure.append([
                                seg_pos[ci],
                                int(round(acc + iv["from_m"])),
                                int(round(acc + iv["to_m"])),
                                1 if iv["structure"] == "tunnel" else 2,
                                iv.get("layer", 0) or 0,
                                round(float(iv.get("confidence", 0)), 2),
                            ])
                            stats["structure_intervals"] += 1
                acc += seg_len

        entry = {
            "id": line_id(line, operator),
            "name": line,
            "nameNorm": ref["line_norm"],
            "operator": operator,
            "operatorShort": op_rec.get("short") or operator,
            "kind": info["kind"],
            "colorPolicy": info["colorPolicy"],
            "labelPolicy": info["labelPolicy"],
            "rank": info["rank"],
            "color": colour,
            "colorSource": csrc,
            "stations": sts,
            "segments": segments,
        }
        entry["colorDark"] = lighten_for_dark(colour)
        if code:
            entry["lineCode"] = code
        if ref["kind"] == "shinkansen":
            entry["isHSR"] = 1
        if structure:
            entry["structure"] = structure
        out_lines.append(entry)

    pkg = {
        "format": "compact-v2",
        "version": version,
        "generatedAt": "2026-08-12T00:00:00.000Z",
        "crs": "WGS84",
        "country": "JP",
        "lanePitchPx": LANE_PITCH_PX,
        "laneUnitScale": 1000,
        "coordEncoding": "delta-int-1e5",
        "geometrySource": {
            "officialOnly": 0,
            "providers": [
                "国土交通省 国土数値情報 鉄道データ N02-25 (geometry, line identity, operator, stations)",
                "OpenStreetMap contributors (English/kana station names, tunnel/bridge intervals) ODbL 1.0",
            ],
            "license": "N02: 国土数値情報ダウンロードサービス 利用約款 (CC BY 4.0 相当)｜OSM: ODbL 1.0",
            "method": (
                "Chains assembled from N02 RailroadSection by endpoint equality at 5 dp; "
                "duplicate geometry collapsed onto shared physical alignments; "
                "stations anchored at the along-line midpoint of their own platform polyline; "
                "parallel corridors detected geometrically and given a GLOBAL lane order so the "
                "left/right relationship of any pair is identical everywhere; lane displacement "
                "d(s) is a piecewise quintic smoothstep, C2, applied in screen space at render time."
            ),
            "separateTables": "OSM-derived attributes are kept as their own fields with provenance; N02 geometry is never conflated with OSM geometry.",
        },
        "lines": out_lines,
        "stats": stats,
    }
    return pkg
