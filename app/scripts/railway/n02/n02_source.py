"""
n02_source.py — authoritative parse of MLIT 国土数値情報 鉄道データ N02.

Everything downstream reads the network through this module. No other file
touches the shapefiles.

Contract notes that are load-bearing (verified against N02-25 in this build,
not carried over from any earlier analysis):

  * Read the **Shift-JIS** shapefile. The UTF-8 copy of the same layer is
    rounded to 8 dp and its DBF carries LDID 0x00 with no .cpg, so a default
    read yields mojibake.
  * Every attribute is a STRING with meaningful zero padding. N02_001 is
    2 chars, N02_002 is 1 char, N02_005c / N02_005g are 6 chars.
    Casting any of them to int destroys the padding.
  * Geometry is 2-D LineString. There is no structure, colour or elevation
    attribute anywhere in the product.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import shapefile  # pyshp

# --------------------------------------------------------------------------
# code lists (国土数値情報 コード一覧)
# --------------------------------------------------------------------------

RAILWAY_CLASS = {
    "11": "普通鉄道JR",
    "12": "普通鉄道",
    "13": "鋼索鉄道",
    "14": "懸垂式鉄道",
    "15": "跨座式鉄道",
    "16": "案内軌条式鉄道",
    "17": "無軌条鉄道",
    "21": "軌道",
    "22": "懸垂式モノレール",
    "23": "跨座式モノレール",
    "24": "案内軌条式",
    "25": "浮上式",
}

# 14≡22, 15≡23, 16≡24 are the same physical thing under the two acts.
CLASS_CANONICAL = {
    "11": "heavy_rail", "12": "heavy_rail",
    "13": "funicular",
    "14": "monorail_suspended", "22": "monorail_suspended",
    "15": "monorail_straddle", "23": "monorail_straddle",
    "16": "agt", "24": "agt",
    "17": "trolleybus",
    "21": "tramway",
    "25": "maglev",
}

INSTITUTION_TYPE = {
    "1": "JR新幹線",
    "2": "JR在来線",
    "3": "公営鉄道",
    "4": "民営鉄道",
    "5": "第三セクター",
}

# N02 cannot distinguish a subway from a surface private railway: 東京地下鉄 is
# N02_001='12', N02_002='4'; 大阪市高速電気軌道 is N02_001='21' (tramway, for
# 軌道法 reasons); 札幌市 is '16' (AGT). Mode therefore comes from an explicit
# operator list, never from N02_001.
SUBWAY_OPERATORS = {
    "東京地下鉄", "東京都", "大阪市高速電気軌道", "名古屋市", "横浜市",
    "神戸市", "京都市", "札幌市", "仙台市", "福岡市",
}

# Operators on the subway list that ALSO run non-subway modes. Verified against
# N02-25 by listing every (operator, 路線名, N02_001) triple for those ten
# operators:  東京都 runs 都電荒川線 (a real tram, cls 21) and 日暮里・舎人ライナー
# (an AGT, cls 24) alongside four subway lines;  大阪市高速電気軌道 runs
# 南港ポートタウン線 / ニュートラム (AGT, cls 16+24) alongside eight subway lines.
# Conversely 札幌市's three subway lines are all cls 16 (AGT) and 大阪's eight are
# cls 21 (tramway) — so N02_001 cannot decide this in either direction.
SUBWAY_OPERATOR_EXCEPTIONS = {
    ("東京都", "荒川線"): "tram",
    ("東京都", "日暮里・舎人ライナー"): "agt",
    ("大阪市高速電気軌道", "南港ポートタウン線"): "agt",
}

# The only known attribute defect in N02-25: one RailroadSection row carries
# 路線名 and 運営会社 in the wrong columns.
SWAPPED_ROW_FIX = {("えちぜん鉄道", "三国芦原線"): ("三国芦原線", "えちぜん鉄道")}

# ONE geometry defect in N02-25 carries a registered patch: at 東京 the survey
# digitises 東北新幹線's station track AND its station feature as vertex-for-
# vertex copies of the 東海道新幹線 platform polyline, which anchored both
# Shinkansen on one dot. The patch (evidence/tokyo-station-platforms.json,
# applied by build-japan-package-from-inventory.py, rule R13) swaps in the
# OSM-surveyed centreline of the JR East 20-23 tracks; it matches the copied
# vertex string exactly and stops the build if the survey moves under it.
# Everything else needs none: the 2026-08-18 live-line gap audit found five
# drawn gaps (石北線 生田原—西留辺蘂, 常磐線 広野—Jヴィレッジ, 日豊線
# 中山香—杵築, 山陽線 富海—戸田, 長崎線 喜々津—東園) and every one is a
# T-junction blind spot, not missing track: a section ends digit-for-digit ON
# another section's INTERIOR vertex, which endpoint-only node building cannot
# see. Even 常磐線's supposed "218 m hole" south of Jヴィレッジ is covered —
# section 14782 is a three-vertex hairpin whose middle vertex IS section
# 14820's north end. All five are healed with zero geometry change by the
# package builder's TrackGraph node splitting
# (build-japan-package-from-inventory.py), not by touching the survey; the
# station-adjacency side of the same audit lives in the corrections ledger
# (data/raw/railway/jp/rebuild-inventory/evidence/network-corrections-2026-08-13.json,
# block `n02_gap_corrections_2026_08_18`).

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563


# --------------------------------------------------------------------------
# geodesy
# --------------------------------------------------------------------------

def geodesic_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Vincenty inverse on the GRS80/WGS84 ellipsoid, with a haversine
    fallback for the near-antipodal / non-convergent case. N02 segments are
    short so convergence is immediate in practice."""
    if lon1 == lon2 and lat1 == lat2:
        return 0.0
    b = WGS84_A * (1 - WGS84_F)
    u1 = math.atan((1 - WGS84_F) * math.tan(math.radians(lat1)))
    u2 = math.atan((1 - WGS84_F) * math.tan(math.radians(lat2)))
    ll = math.radians(lon2 - lon1)
    sin_u1, cos_u1 = math.sin(u1), math.cos(u1)
    sin_u2, cos_u2 = math.sin(u2), math.cos(u2)
    lam = ll
    for _ in range(64):
        sin_l, cos_l = math.sin(lam), math.cos(lam)
        sin_sigma = math.sqrt((cos_u2 * sin_l) ** 2 +
                              (cos_u1 * sin_u2 - sin_u1 * cos_u2 * cos_l) ** 2)
        if sin_sigma == 0:
            return 0.0
        cos_sigma = sin_u1 * sin_u2 + cos_u1 * cos_u2 * cos_l
        sigma = math.atan2(sin_sigma, cos_sigma)
        sin_alpha = cos_u1 * cos_u2 * sin_l / sin_sigma
        cos_sq_alpha = 1 - sin_alpha ** 2
        cos2sm = cos_sigma - 2 * sin_u1 * sin_u2 / cos_sq_alpha if cos_sq_alpha else 0.0
        c = WGS84_F / 16 * cos_sq_alpha * (4 + WGS84_F * (4 - 3 * cos_sq_alpha))
        lam_prev = lam
        lam = ll + (1 - c) * WGS84_F * sin_alpha * (
            sigma + c * sin_sigma * (cos2sm + c * cos_sigma * (-1 + 2 * cos2sm ** 2)))
        if abs(lam - lam_prev) < 1e-12:
            break
    else:
        # fallback: spherical
        r = 6371008.8
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
        return 2 * r * math.asin(min(1.0, math.sqrt(a)))
    u_sq = cos_sq_alpha * (WGS84_A ** 2 - b ** 2) / (b ** 2)
    aa = 1 + u_sq / 16384 * (4096 + u_sq * (-768 + u_sq * (320 - 175 * u_sq)))
    bb = u_sq / 1024 * (256 + u_sq * (-128 + u_sq * (74 - 47 * u_sq)))
    sin_l, cos_l = math.sin(lam), math.cos(lam)
    sin_sigma = math.sqrt((cos_u2 * sin_l) ** 2 +
                          (cos_u1 * sin_u2 - sin_u1 * cos_u2 * cos_l) ** 2)
    cos_sigma = sin_u1 * sin_u2 + cos_u1 * cos_u2 * cos_l
    sigma = math.atan2(sin_sigma, cos_sigma)
    sin_alpha = cos_u1 * cos_u2 * sin_l / sin_sigma if sin_sigma else 0.0
    cos_sq_alpha = 1 - sin_alpha ** 2
    cos2sm = cos_sigma - 2 * sin_u1 * sin_u2 / cos_sq_alpha if cos_sq_alpha else 0.0
    d_sigma = bb * sin_sigma * (cos2sm + bb / 4 * (
        cos_sigma * (-1 + 2 * cos2sm ** 2)
        - bb / 6 * cos2sm * (-3 + 4 * sin_sigma ** 2) * (-3 + 4 * cos2sm ** 2)))
    return b * aa * (sigma - d_sigma)


def polyline_length_m(coords) -> float:
    return sum(geodesic_m(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
               for i in range(len(coords) - 1))


def cumulative_measures(coords):
    out = [0.0]
    for i in range(len(coords) - 1):
        out.append(out[-1] + geodesic_m(coords[i][0], coords[i][1],
                                        coords[i + 1][0], coords[i + 1][1]))
    return out


# --------------------------------------------------------------------------
# records
# --------------------------------------------------------------------------

def _round_key(coords, dp: int = 5):
    return tuple((round(x, dp), round(y, dp)) for x, y in coords)


def _geom_key(coords) -> str:
    """Canonical direction-insensitive hash of a section's geometry."""
    fwd = _round_key(coords, 7)
    rev = tuple(reversed(fwd))
    canon = fwd if fwd <= rev else rev
    return hashlib.blake2b(repr(canon).encode(), digest_size=16).hexdigest()


@dataclass
class Section:
    index: int
    cls: str            # N02_001
    inst: str           # N02_002
    line: str           # N02_003 (corrected)
    operator: str       # N02_004 (corrected)
    coords: list
    length_m: float = 0.0
    geom_key: str = ""          # canonical hash, direction-insensitive
    duplicate_group: int = -1
    is_duplicate_primary: bool = True

    @property
    def line_key(self):
        return (self.line, self.operator)

    @property
    def mode(self):
        return CLASS_CANONICAL.get(self.cls, "unknown")


@dataclass
class StationRow:
    index: int
    cls: str
    inst: str
    line: str
    operator: str
    name: str
    code: str           # N02_005c
    group: str          # N02_005g
    coords: list
    length_m: float = 0.0

    @property
    def line_key(self):
        return (self.line, self.operator)


@dataclass
class Network:
    sections: list = field(default_factory=list)
    stations: list = field(default_factory=list)
    nodes: dict = field(default_factory=dict)          # node key -> [section idx,…]
    line_sections: dict = field(default_factory=dict)  # line_key -> [section idx,…]
    duplicate_groups: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)


# --------------------------------------------------------------------------
# loader
# --------------------------------------------------------------------------

def _fix_swap(line: str, operator: str):
    return SWAPPED_ROW_FIX.get((line, operator), (line, operator))


def load(root: Path, verbose: bool = True) -> Network:
    """root = the extracted N02-25_GML directory."""
    sj = root / "Shift-JIS"
    net = Network()

    # ---- RailroadSection -------------------------------------------------
    r = shapefile.Reader(str(sj / "N02-25_RailroadSection"), encoding="cp932")
    fields = [f[0] for f in r.fields[1:]]
    if verbose:
        print(f"RailroadSection fields: {fields}  n={len(r)}")
    fixes = 0
    for i, sr in enumerate(r.iterShapeRecords()):
        rec, shp = sr.record, sr.shape
        raw_line, raw_op = rec["N02_003"], rec["N02_004"]
        line, operator = _fix_swap(raw_line, raw_op)
        if (line, operator) != (raw_line, raw_op):
            fixes += 1
        coords = [(float(x), float(y)) for x, y in shp.points]
        s = Section(index=i, cls=rec["N02_001"], inst=rec["N02_002"],
                    line=line, operator=operator, coords=coords)
        s.length_m = polyline_length_m(coords)
        s.geom_key = _geom_key(coords)
        net.sections.append(s)
    if verbose:
        print(f"  applied {fixes} swapped-column fix(es)")

    # ---- Station ---------------------------------------------------------
    r = shapefile.Reader(str(sj / "N02-25_Station"), encoding="cp932")
    fields = [f[0] for f in r.fields[1:]]
    if verbose:
        print(f"Station fields: {fields}  n={len(r)}")
    for i, sr in enumerate(r.iterShapeRecords()):
        rec, shp = sr.record, sr.shape
        line, operator = _fix_swap(rec["N02_003"], rec["N02_004"])
        coords = [(float(x), float(y)) for x, y in shp.points]
        st = StationRow(index=i, cls=rec["N02_001"], inst=rec["N02_002"],
                        line=line, operator=operator,
                        name=rec["N02_005"], code=rec["N02_005c"],
                        group=rec["N02_005g"], coords=coords)
        st.length_m = polyline_length_m(coords)
        net.stations.append(st)

    _index(net, verbose=verbose)
    return net


def _index(net: Network, verbose: bool = True):
    # duplicate geometry groups (direction-insensitive)
    by_geom = defaultdict(list)
    for s in net.sections:
        by_geom[s.geom_key].append(s.index)
    groups = [v for v in by_geom.values() if len(v) > 1]
    groups.sort(key=lambda g: g[0])
    for gi, members in enumerate(groups):
        for idx in members:
            net.sections[idx].duplicate_group = gi
            net.sections[idx].is_duplicate_primary = (idx == members[0])
    net.duplicate_groups = groups

    # topology nodes at 5 dp
    for s in net.sections:
        for pt in (s.coords[0], s.coords[-1]):
            net.nodes.setdefault((round(pt[0], 5), round(pt[1], 5)), []).append(s.index)

    # line -> sections
    for s in net.sections:
        net.line_sections.setdefault(s.line_key, []).append(s.index)

    total_km = sum(s.length_m for s in net.sections) / 1000
    redundant_km = sum(net.sections[i].length_m
                       for g in groups for i in g[1:]) / 1000
    deg = Counter(len(v) for v in net.nodes.values())
    net.stats = {
        "sections": len(net.sections),
        "stations": len(net.stations),
        "total_km": round(total_km, 3),
        "line_keys": len(net.line_sections),
        "operators": len({s.operator for s in net.sections}),
        "line_names": len({s.line for s in net.sections}),
        "station_groups": len({st.group for st in net.stations}),
        "nodes": len(net.nodes),
        "node_degree_hist": dict(sorted(deg.items())),
        "junction_nodes_ge3": sum(c for d, c in deg.items() if d >= 3),
        "duplicate_groups": len(groups),
        "duplicate_features": sum(len(g) for g in groups),
        "redundant_km": round(redundant_km, 3),
    }
    if verbose:
        for k, v in net.stats.items():
            print(f"  {k}: {v}")


# --------------------------------------------------------------------------
# classification used by the renderer
# --------------------------------------------------------------------------

def classify(line: str, operator: str, cls: str, inst: str) -> dict:
    """Return the render class for a line. `colorPolicy` decides whether the
    hue is looked up per line or per operator."""
    forced = SUBWAY_OPERATOR_EXCEPTIONS.get((operator, normalise_line_name(line)))
    is_subway = operator in SUBWAY_OPERATORS and forced is None
    if forced == "tram":
        cls = "21"
    elif forced == "agt":
        cls = "16"
    if inst == "1":
        kind, policy, label = "shinkansen", "line", "line"
    elif is_subway:
        kind, policy, label = "subway", "line", "line"
    elif inst == "2":
        kind, policy, label = "jr_conventional", "operator", "operator"
    elif cls == "21":
        kind, policy, label = "tram", "operator", "operator"
    elif cls in ("13",):
        kind, policy, label = "funicular", "operator", "operator"
    elif cls in ("14", "15", "22", "23"):
        kind, policy, label = "monorail", "operator", "operator"
    elif cls in ("16", "24"):
        kind, policy, label = "agt", "operator", "operator"
    elif cls == "25":
        kind, policy, label = "maglev", "operator", "operator"
    elif inst == "5":
        kind, policy, label = "third_sector", "operator", "operator"
    else:
        kind, policy, label = "private", "operator", "operator"

    rank = {
        "shinkansen": 2000, "maglev": 1400, "monorail": 1400,
        "agt": 1400, "funicular": 1400,
        "jr_conventional": 1100, "private": 1100, "third_sector": 1100,
        "subway": 900, "tram": 600,
    }[kind]
    return {"kind": kind, "colorPolicy": policy, "labelPolicy": label, "rank": rank}


_NUM_PREFIX = re.compile(r"^\d+号線[（(]?")
_PAREN = re.compile(r"[（(]([^）)]+)[）)]")


def normalise_line_name(name: str) -> str:
    """`4号線丸ノ内線` -> `丸ノ内線`; `1号線(御堂筋線)` -> `御堂筋線`;
    bare `1号線` stays as-is (Yokohama / Chiba Monorail have no other name)."""
    m = _PAREN.search(name)
    if m and _NUM_PREFIX.match(name):
        return m.group(1)
    stripped = _NUM_PREFIX.sub("", name).rstrip("）)")
    return stripped or name
