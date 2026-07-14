#!/usr/bin/env python3
"""Expand itinerary stops against the bundled 2025 N02 railway network.

The N02 data provides the physical station order. Passenger-stop decisions are
kept separately and come from the July 2026 timetable sources documented in
this script's TRAIN_SPECS table. Run without --write for an audit; use --write
only after every configured route has passed the endpoint and adjacency checks.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
STORE_PATH = DATA / "train-store.json"
STATIONS_PATH = DATA / "stations.json"
RAILS_PATH = DATA / "rail-sections.json"

JR_EAST = "東日本旅客鉄道"
JR_CENTRAL = "東海旅客鉄道"
JR_WEST = "西日本旅客鉄道"
JR_HOKKAIDO = "北海道旅客鉄道"


def coord_key(coord: list[float] | tuple[float, float]) -> tuple[float, float]:
    return (round(float(coord[0]), 6), round(float(coord[1]), 6))


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = math.radians((a[1] + b[1]) / 2)
    dx = (a[0] - b[0]) * 111_320 * math.cos(lat)
    dy = (a[1] - b[1]) * 110_540
    return math.hypot(dx, dy)


def project_m(
    point: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
) -> tuple[float, float]:
    """Return (distance metres, fraction along a-b)."""
    lat = math.radians((a[1] + b[1] + point[1]) / 3)
    scale_x = 111_320 * math.cos(lat)
    scale_y = 110_540
    ax, ay = a[0] * scale_x, a[1] * scale_y
    bx, by = b[0] * scale_x, b[1] * scale_y
    px, py = point[0] * scale_x, point[1] * scale_y
    vx, vy = bx - ax, by - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / denom))
    qx, qy = ax + t * vx, ay + t * vy
    return math.hypot(px - qx, py - qy), t


@dataclass(frozen=True)
class Segment:
    start: str
    end: str
    line: str
    operator: str
    tolerance_m: float = 260.0


@dataclass(frozen=True)
class ManualSegment:
    names: tuple[str, ...]
    line: str | None = None
    operator: str | None = None


@dataclass(frozen=True)
class TrainSpec:
    pieces: tuple[Segment | ManualSegment, ...]
    passenger_stops: frozenset[str] = frozenset()
    all_passenger: bool = False
    excluded_stations: frozenset[str] = frozenset()


def s(start: str, end: str, line: str, operator: str, tolerance_m: float = 260.0) -> Segment:
    return Segment(start, end, line, operator, tolerance_m)


def m(*names: str, line: str | None = None, operator: str | None = None) -> ManualSegment:
    return ManualSegment(tuple(names), line, operator)


def spec(
    *pieces: Segment | ManualSegment,
    passenger: Iterable[str] = (),
    all_passenger: bool = False,
    exclude: Iterable[str] = (),
) -> TrainSpec:
    return TrainSpec(
        tuple(pieces), frozenset(passenger), all_passenger, frozenset(exclude)
    )


# Passenger-stop sources used for the non-local services below (July 2026):
# - JR East train-specific timetables: Hayabusa 11/27/59, Super Tsugaru 2,
#   Inaho 14, Toki 308, Hakutaka 555/560/565, Kagayaki 501, Yamabiko 221.
# - JR West train-specific timetables: Hikari 648/706/713/718 and Haruka.
# - JR Hokkaido March 2026 timetable: Hokuto 21, Ozora 3/12, and the Kushiro
#   station timetable for Nemuro Line locals 5625D/5630D.
# - Operator route timetables for metro/private/local services.
# N02 supplies physical station order only; it is not used to infer stops.
TRAIN_SPECS: dict[str, TrainSpec] = {}

# Common physical routes.
TOKAIDO_SHINKANSEN = lambda a, b: s(a, b, "東海道新幹線", JR_CENTRAL)
TOHOKU_SHINKANSEN = lambda a, b: s(a, b, "東北新幹線", JR_EAST)
JOETSU_SHINKANSEN = lambda a, b: s(a, b, "上越新幹線", JR_EAST)
HOKURIKU_EAST = lambda a, b: s(a, b, "北陸新幹線", JR_EAST)
HOKURIKU_WEST = lambda a, b: s(a, b, "北陸新幹線", JR_WEST)

TRAIN_SPECS["20260703_01_haruka"] = spec(
    s("関西空港", "日根野", "関西空港線", JR_WEST),
    s("日根野", "天王寺", "阪和線", JR_WEST),
    m(
        "天王寺", "新今宮", "今宮", "芦原橋", "大正", "弁天町", "西九条", "福島", "大阪",
        line="大阪環状線", operator=JR_WEST,
    ),
    s("大阪", "新大阪", "東海道線", JR_WEST),
    passenger=("関西空港", "天王寺", "大阪", "新大阪"),
)
TRAIN_SPECS["20260703_02_tokaido_shinkansen_hikari_kodama"] = spec(
    TOKAIDO_SHINKANSEN("新大阪", "三島"), all_passenger=True
)

for train_id, start, end in (
    ("20260703_03_tokaido_main_local", "三島", "沼津"),
    ("20260704_01_local", "沼津", "三島"),
    ("20260704_14_local", "三島", "沼津"),
    ("20260705_01_local", "沼津", "三島"),
    ("20260708_05_local", "三島", "沼津"),
    ("20260709_01_local", "沼津", "三島"),
    ("20260710_03_local", "三島", "沼津"),
    ("20260710_04_local", "沼津", "三島"),
    ("20260713_03_tokaido_main_local", "三島", "沼津"),
    ("20260713_04_tokaido_main_local", "沼津", "三島"),
):
    TRAIN_SPECS[train_id] = spec(
        s(start, end, "東海道線", JR_CENTRAL), all_passenger=True
    )

for train_id, start, end in (
    ("20260704_02_kodama918", "三島", "品川"),
    ("20260704_13_kodama915", "新横浜", "三島"),
    ("20260705_02_kodama802", "三島", "東京"),
    ("20260710_02_kodama824", "名古屋", "三島"),
    ("20260713_02_kodama801", "東京", "三島"),
    ("20260713_05_kodama816", "三島", "東京"),
):
    TRAIN_SPECS[train_id] = spec(TOKAIDO_SHINKANSEN(start, end), all_passenger=True)

TRAIN_SPECS["20260704_03_keikyu_asakusa_line"] = spec(
    s("品川", "泉岳寺", "本線", "京浜急行電鉄"),
    s("泉岳寺", "大門", "1号線浅草線", "東京都"),
    all_passenger=True,
)
TRAIN_SPECS["20260704_04_oedo_line"] = spec(
    s("大門", "赤羽橋", "12号線大江戸線", "東京都"), all_passenger=True
)
TRAIN_SPECS["20260704_05_mita_line"] = spec(
    s("芝公園", "大手町", "6号線三田線", "東京都"), all_passenger=True
)
TRAIN_SPECS["20260704_06_marunouchi_line"] = spec(
    s("大手町", "池袋", "4号線丸ノ内線", "東京地下鉄"), all_passenger=True
)
TRAIN_SPECS["20260704_07_saikyo_line"] = spec(
    s("池袋", "赤羽", "赤羽線", JR_EAST),
    m(
        "赤羽", "北赤羽", "浮間舟渡", "戸田公園", "戸田", "北戸田", "武蔵浦和",
        "中浦和", "南与野", "与野本町", "北与野", "大宮",
        line="東北線", operator=JR_EAST,
    ),
    all_passenger=True,
)
TRAIN_SPECS["20260704_08_shonan_shinjuku_line"] = spec(
    s("大宮", "赤羽", "東北線", JR_EAST),
    s("赤羽", "池袋", "赤羽線", JR_EAST),
    s("池袋", "大崎", "山手線", JR_EAST),
    m("大崎", "西大井", "武蔵小杉", line="東海道線", operator=JR_EAST),
    s("武蔵小杉", "横浜", "東海道線", JR_EAST),
    passenger=(
        "大宮", "浦和", "赤羽", "池袋", "新宿", "渋谷", "大崎", "武蔵小杉", "横浜"
    ),
)
TRAIN_SPECS["20260704_09_negishi_line"] = spec(
    s("横浜", "桜木町", "根岸線", JR_EAST), all_passenger=True
)
TRAIN_SPECS["20260704_10_minatomirai_line"] = spec(
    s("みなとみらい", "横浜", "みなとみらい21線", "横浜高速鉄道"), all_passenger=True
)
TRAIN_SPECS["20260704_11_keihin_tohoku_line"] = spec(
    s("横浜", "東神奈川", "東海道線", JR_EAST), all_passenger=True
)
TRAIN_SPECS["20260704_12_yokohama_line"] = spec(
    s("東神奈川", "新横浜", "横浜線", JR_EAST), all_passenger=True
)

TRAIN_SPECS["20260705_03_chuo_line"] = spec(
    m("東京", "神田", line="中央線", operator=JR_EAST),
    s("神田", "新宿", "中央線", JR_EAST),
    passenger=("東京", "神田", "御茶ノ水", "四ツ谷", "新宿"),
)
TRAIN_SPECS["20260705_04_chuo_sobu_line"] = spec(
    s("新宿", "市ヶ谷", "中央線", JR_EAST), all_passenger=True
)
TRAIN_SPECS["20260705_05_yurakucho_line"] = spec(
    s("市ヶ谷", "江戸川橋", "8号線有楽町線", "東京地下鉄"), all_passenger=True
)
TRAIN_SPECS["20260705_06_yurakucho_line"] = spec(
    s("江戸川橋", "池袋", "8号線有楽町線", "東京地下鉄"), all_passenger=True
)
TRAIN_SPECS["20260705_07_yamanote_line"] = spec(
    m(
        "池袋", "大塚", "巣鴨", "駒込", "田端",
        line="山手線", operator=JR_EAST,
    ),
    s("田端", "上野", "東北線", JR_EAST),
    all_passenger=True,
)

TRAIN_SPECS["20260705_08_hayabusa59"] = spec(
    TOHOKU_SHINKANSEN("上野", "仙台"), passenger=("上野", "大宮", "仙台")
)
TRAIN_SPECS["20260706_01_hayabusa11"] = spec(
    TOHOKU_SHINKANSEN("仙台", "新青森"), passenger=("仙台", "盛岡", "新青森")
)
TRAIN_SPECS["20260706_02_super_tsugaru2"] = spec(
    s("新青森", "秋田", "奥羽線", JR_EAST),
    passenger=("新青森", "弘前", "大鰐温泉", "大館", "鷹ノ巣", "東能代", "秋田"),
    exclude=("津軽湯の沢",),
)
TRAIN_SPECS["20260706_03_inaho14"] = spec(
    s("秋田", "新発田", "羽越線", JR_EAST),
    s("新発田", "新潟", "白新線", JR_EAST),
    passenger=(
        "秋田", "羽後本荘", "仁賀保", "象潟", "遊佐", "酒田", "余目", "鶴岡",
        "あつみ温泉", "府屋", "村上", "坂町", "中条", "新発田", "豊栄", "新潟",
    ),
)

TRAIN_SPECS["20260707_01_toki308"] = spec(
    JOETSU_SHINKANSEN("新潟", "高崎"), all_passenger=True
)
TRAIN_SPECS["20260707_02_hakutaka555"] = spec(
    HOKURIKU_EAST("高崎", "長野"),
    passenger=("高崎", "軽井沢", "佐久平", "上田", "長野"),
)
for train_id, start, end in (
    ("20260707_03_local", "長野", "篠ノ井"),
    ("20260707_04_local", "篠ノ井", "長野"),
):
    TRAIN_SPECS[train_id] = spec(s(start, end, "信越線", JR_EAST), all_passenger=True)
TRAIN_SPECS["20260707_05_local"] = spec(
    s("長野", "須坂", "長野線", "長野電鉄"), all_passenger=True
)
TRAIN_SPECS["20260707_06_a_ltdexp"] = spec(
    s("須坂", "長野", "長野線", "長野電鉄"),
    passenger=("須坂", "権堂", "長野"),
)
TRAIN_SPECS["20260707_07_hakutaka565"] = spec(
    HOKURIKU_EAST("長野", "上越妙高"),
    HOKURIKU_WEST("上越妙高", "加賀温泉"),
    all_passenger=True,
)

TRAIN_SPECS["20260708_01_tsurugi17"] = spec(
    HOKURIKU_WEST("加賀温泉", "敦賀"), all_passenger=True
)
TRAIN_SPECS["20260708_02_shirasagi2"] = spec(
    s("敦賀", "米原", "北陸線", JR_WEST), passenger=("敦賀", "米原")
)
TRAIN_SPECS["20260708_03_hikari648"] = spec(
    TOKAIDO_SHINKANSEN("米原", "名古屋"), all_passenger=True
)
TRAIN_SPECS["20260708_04_hikari706"] = spec(
    TOKAIDO_SHINKANSEN("名古屋", "三島"),
    passenger=("名古屋", "浜松", "静岡", "三島"),
)

TRAIN_SPECS["20260709_02_hikari713"] = spec(
    TOKAIDO_SHINKANSEN("三島", "京都"),
    passenger=("三島", "静岡", "浜松", "名古屋", "京都"),
)
TRAIN_SPECS["20260709_03_miyakoji_rapid"] = spec(
    s("京都", "宇治", "奈良線", JR_WEST),
    passenger=("京都", "東福寺", "稲荷", "六地蔵", "宇治"),
)
TRAIN_SPECS["20260709_04_d_section_rapid"] = spec(
    s("宇治", "京都", "奈良線", JR_WEST),
    passenger=("宇治", "六地蔵", "東福寺", "京都"),
)

TRAIN_SPECS["20260710_01_nozomi252"] = spec(
    TOKAIDO_SHINKANSEN("京都", "名古屋"), passenger=("京都", "名古屋")
)
TRAIN_SPECS["20260710_05_hikari718"] = spec(
    TOKAIDO_SHINKANSEN("三島", "東京"),
    passenger=("三島", "新横浜", "品川", "東京"),
)
TRAIN_SPECS["20260710_06_yamabiko221"] = spec(
    TOHOKU_SHINKANSEN("東京", "大宮"), all_passenger=True
)
TRAIN_SPECS["20260710_07_keihin_tohoku_local"] = spec(
    s("大宮", "南浦和", "東北線", JR_EAST), all_passenger=True
)
TRAIN_SPECS["20260711_01_keihin_tohoku_negishi_local"] = spec(
    s("南浦和", "大宮", "東北線", JR_EAST), all_passenger=True
)
TRAIN_SPECS["20260711_02_kagayaki501"] = spec(
    JOETSU_SHINKANSEN("大宮", "高崎"),
    HOKURIKU_EAST("高崎", "上越妙高"),
    HOKURIKU_WEST("上越妙高", "金沢"),
    passenger=("大宮", "長野", "富山", "金沢"),
)
TRAIN_SPECS["20260711_03_hakutaka560"] = spec(
    HOKURIKU_WEST("金沢", "上越妙高"),
    HOKURIKU_EAST("上越妙高", "高崎"),
    JOETSU_SHINKANSEN("高崎", "大宮"),
    passenger=(
        "金沢", "新高岡", "富山", "黒部宇奈月温泉", "糸魚川", "上越妙高",
        "飯山", "長野", "高崎", "大宮",
    ),
)
TRAIN_SPECS["20260711_04_saikyo_local"] = spec(
    m(
        "大宮", "北与野", "与野本町", "南与野", "中浦和", "武蔵浦和", "北戸田",
        "戸田", "戸田公園", "浮間舟渡", "北赤羽", "赤羽",
        line="東北線", operator=JR_EAST,
    ),
    s("赤羽", "池袋", "赤羽線", JR_EAST),
    all_passenger=True,
)
TRAIN_SPECS["20260711_05_seibu_ikebukuro_semiexp"] = spec(
    s("池袋", "西所沢", "池袋線", "西武鉄道"),
    passenger=(
        "池袋", "練馬", "石神井公園", "大泉学園", "保谷", "ひばりヶ丘", "東久留米",
        "清瀬", "秋津", "所沢", "西所沢",
    ),
)
TRAIN_SPECS["20260711_06_seibu_sayama_local"] = spec(
    s("西所沢", "西武球場前", "狭山線", "西武鉄道"), all_passenger=True
)

for train_id, start, end in (
    ("20260712_01_musashino_local", "南浦和", "新秋津"),
    ("20260712_05_musashino_local", "新秋津", "南浦和"),
):
    TRAIN_SPECS[train_id] = spec(s(start, end, "武蔵野線", JR_EAST), all_passenger=True)
TRAIN_SPECS["20260712_02_seibu_ikebukuro_semiexp"] = spec(
    s("秋津", "西所沢", "池袋線", "西武鉄道"), all_passenger=True
)
TRAIN_SPECS["20260712_03_seibu_sayama_local"] = spec(
    s("西所沢", "西武球場前", "狭山線", "西武鉄道"), all_passenger=True
)
TRAIN_SPECS["20260712_04_seibu_sayama_ikebukuro_local"] = spec(
    s("西武球場前", "西所沢", "狭山線", "西武鉄道"),
    s("西所沢", "秋津", "池袋線", "西武鉄道"),
    all_passenger=True,
)

TRAIN_SPECS["20260713_01_keihin_tohoku_negishi_local"] = spec(
    s("南浦和", "東京", "東北線", JR_EAST), all_passenger=True
)
TRAIN_SPECS["20260713_06_hayabusa27"] = spec(
    TOHOKU_SHINKANSEN("東京", "新青森"),
    s("新青森", "新函館北斗", "北海道新幹線", JR_HOKKAIDO),
    passenger=("東京", "上野", "大宮", "仙台", "盛岡", "八戸", "新青森", "新函館北斗"),
)
TRAIN_SPECS["20260713_07_hokuto21"] = spec(
    s("新函館北斗", "長万部", "函館線", JR_HOKKAIDO),
    s("長万部", "沼ノ端", "室蘭線", JR_HOKKAIDO),
    s("沼ノ端", "白石", "千歳線", JR_HOKKAIDO),
    s("白石", "札幌", "函館線", JR_HOKKAIDO),
    passenger=(
        "新函館北斗", "森", "八雲", "長万部", "洞爺", "伊達紋別", "東室蘭",
        "登別", "苫小牧", "南千歳", "新札幌", "札幌",
    ),
)

OZORA_ROUTE = (
    s("札幌", "白石", "函館線", JR_HOKKAIDO),
    s("白石", "南千歳", "千歳線", JR_HOKKAIDO),
    s("南千歳", "新得", "石勝線", JR_HOKKAIDO),
    s("新得", "釧路", "根室線", JR_HOKKAIDO),
)
TRAIN_SPECS["20260714_01_ozora3"] = spec(
    *OZORA_ROUTE,
    passenger=(
        "札幌", "新札幌", "南千歳", "追分", "新夕張", "占冠", "トマム", "新得",
        "帯広", "池田", "白糠", "釧路",
    ),
)
TRAIN_SPECS["20260714_02_nemuro_main_local"] = spec(
    s("釧路", "根室", "根室線", JR_HOKKAIDO),
    passenger=(
        "釧路", "東釧路", "武佐", "別保", "上尾幌", "尾幌", "門静", "厚岸", "茶内",
        "浜中", "姉別", "厚床", "別当賀", "落石", "昆布盛", "根室",
    ),
)
TRAIN_SPECS["20260714_03_nemuro_main_local"] = spec(
    s("根室", "釧路", "根室線", JR_HOKKAIDO), all_passenger=True
)
TRAIN_SPECS["20260714_04_ozora12"] = spec(
    *tuple(
        s(piece.end, piece.start, piece.line, piece.operator, piece.tolerance_m)
        for piece in reversed(OZORA_ROUTE)
    ),
    passenger=("釧路", "白糠", "池田", "帯広", "新得", "南千歳", "新札幌", "札幌"),
)


@dataclass
class LineGraph:
    adjacency: dict[tuple[float, float], list[tuple[tuple[float, float], float]]]
    nodes: list[tuple[float, float]]
    stations: list[dict]


class N02RouteIndex:
    def __init__(self) -> None:
        self.station_features = json.loads(STATIONS_PATH.read_text())["features"]
        self.rail_features = json.loads(RAILS_PATH.read_text())["features"]
        self._graphs: dict[tuple[str, str], LineGraph] = {}

    def line_graph(self, line: str, operator: str) -> LineGraph:
        cache_key = (line, operator)
        if cache_key in self._graphs:
            return self._graphs[cache_key]
        adjacency: dict[tuple[float, float], list[tuple[tuple[float, float], float]]] = {}
        for feature in self.rail_features:
            props = feature.get("properties", {})
            if props.get("N02_003") != line or props.get("N02_004") != operator:
                continue
            geometry = feature.get("geometry", {})
            groups = geometry.get("coordinates", [])
            if geometry.get("type") == "LineString":
                groups = [groups]
            for coords in groups:
                for raw_a, raw_b in zip(coords, coords[1:]):
                    a, b = coord_key(raw_a), coord_key(raw_b)
                    weight = distance_m(a, b)
                    adjacency.setdefault(a, []).append((b, weight))
                    adjacency.setdefault(b, []).append((a, weight))
        stations = [
            feature
            for feature in self.station_features
            if feature.get("properties", {}).get("N02_003") == line
            and feature.get("properties", {}).get("N02_004") == operator
        ]
        graph = LineGraph(adjacency, list(adjacency), stations)
        if not graph.nodes:
            raise ValueError(f"No N02 rail geometry for {operator} / {line}")
        self._graphs[cache_key] = graph
        return graph

    @staticmethod
    def station_point(feature: dict) -> tuple[float, float]:
        props = feature.get("properties", {})
        raw = props.get("display_point")
        if isinstance(raw, list) and len(raw) >= 2:
            return coord_key(raw)
        coords = feature.get("geometry", {}).get("coordinates", [])
        if coords:
            return coord_key(coords[len(coords) // 2])
        raise ValueError(f"Station feature has no coordinate: {props.get('N02_005')}")

    @staticmethod
    def closest_nodes(
        point: tuple[float, float], nodes: list[tuple[float, float]], limit: int = 6
    ) -> list[tuple[float, tuple[float, float]]]:
        return heapq.nsmallest(limit, ((distance_m(point, node), node) for node in nodes))

    def endpoint_nodes(self, graph: LineGraph, name: str) -> list[tuple[float, tuple[float, float]]]:
        matching = [f for f in graph.stations if f.get("properties", {}).get("N02_005") == name]
        if not matching:
            raise ValueError(f"Station {name} is absent from configured line")
        candidates: dict[tuple[float, float], float] = {}
        for feature in matching:
            point = self.station_point(feature)
            for dist, node in self.closest_nodes(point, graph.nodes):
                candidates[node] = min(dist, candidates.get(node, float("inf")))
        return sorted((dist, node) for node, dist in candidates.items())[:12]

    @staticmethod
    def dijkstra(
        graph: LineGraph,
        starts: list[tuple[float, tuple[float, float]]],
        ends: list[tuple[float, tuple[float, float]]],
    ) -> list[tuple[float, float]]:
        end_cost = {node: snap for snap, node in ends}
        queue: list[tuple[float, tuple[float, float]]] = []
        dist: dict[tuple[float, float], float] = {}
        previous: dict[tuple[float, float], tuple[float, float]] = {}
        for snap, node in starts:
            initial = snap * 4
            if initial < dist.get(node, float("inf")):
                dist[node] = initial
                heapq.heappush(queue, (initial, node))
        best_end = None
        best_total = float("inf")
        while queue:
            current, node = heapq.heappop(queue)
            if current != dist.get(node):
                continue
            if node in end_cost and current + end_cost[node] * 4 < best_total:
                best_total = current + end_cost[node] * 4
                best_end = node
            if current > best_total:
                break
            for nxt, weight in graph.adjacency.get(node, []):
                candidate = current + weight
                if candidate < dist.get(nxt, float("inf")):
                    dist[nxt] = candidate
                    previous[nxt] = node
                    heapq.heappush(queue, (candidate, nxt))
        if best_end is None:
            raise ValueError("No path between configured station endpoints")
        path = [best_end]
        while path[-1] in previous:
            path.append(previous[path[-1]])
        path.reverse()
        return path

    @staticmethod
    def station_projection(
        point: tuple[float, float], path: list[tuple[float, float]]
    ) -> tuple[float, float]:
        cumulative = 0.0
        best = (float("inf"), 0.0)
        for a, b in zip(path, path[1:]):
            segment_length = distance_m(a, b)
            dist, fraction = project_m(point, a, b)
            if dist < best[0]:
                best = (dist, cumulative + segment_length * fraction)
            cumulative += segment_length
        return best

    def stations_on_segment(self, segment: Segment) -> list[dict]:
        graph = self.line_graph(segment.line, segment.operator)
        path = self.dijkstra(
            graph,
            self.endpoint_nodes(graph, segment.start),
            self.endpoint_nodes(graph, segment.end),
        )
        selected = []
        for feature in graph.stations:
            props = feature.get("properties", {})
            point = self.station_point(feature)
            distance, progress = self.station_projection(point, path)
            if distance <= segment.tolerance_m:
                selected.append(
                    {
                        "name": props.get("N02_005"),
                        "n02_station_code": props.get("N02_005c"),
                        "n02_group_code": props.get("N02_005g"),
                        "line": segment.line,
                        "operator": segment.operator,
                        "distance_m": round(distance, 1),
                        "progress_m": round(progress, 1),
                    }
                )
        selected.sort(key=lambda item: (item["progress_m"], item["distance_m"]))
        deduped: list[dict] = []
        seen: set[str] = set()
        for item in selected:
            key = item.get("n02_group_code") or item.get("name")
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        names = [item["name"] for item in deduped]
        if segment.start not in names or segment.end not in names:
            raise ValueError(
                f"Endpoint missing after projection for {segment.start}->{segment.end} "
                f"on {segment.line}: {names[:3]} ... {names[-3:]}"
            )
        start_i, end_i = names.index(segment.start), names.index(segment.end)
        if start_i > end_i:
            deduped.reverse()
            names.reverse()
            start_i, end_i = names.index(segment.start), names.index(segment.end)
        return deduped[start_i : end_i + 1]

    def manual_stations(self, segment: ManualSegment) -> list[dict]:
        result = []
        for name in segment.names:
            candidates = [
                feature
                for feature in self.station_features
                if feature.get("properties", {}).get("N02_005") == name
                and (
                    segment.line is None
                    or feature.get("properties", {}).get("N02_003") == segment.line
                )
                and (
                    segment.operator is None
                    or feature.get("properties", {}).get("N02_004") == segment.operator
                )
            ]
            props = candidates[0].get("properties", {}) if candidates else {}
            result.append(
                {
                    "name": name,
                    "n02_station_code": props.get("N02_005c"),
                    "n02_group_code": props.get("N02_005g"),
                    "line": segment.line,
                    "operator": segment.operator,
                    "distance_m": 0.0,
                    "progress_m": float(len(result)),
                }
            )
        return result


def expand_train(index: N02RouteIndex, train: dict, train_spec: TrainSpec) -> dict:
    expanded_pieces: list[list[dict]] = []
    for piece in train_spec.pieces:
        try:
            stations = (
                index.stations_on_segment(piece)
                if isinstance(piece, Segment)
                else index.manual_stations(piece)
            )
        except Exception as exc:
            raise ValueError(f"{train['id']}: {exc}") from exc
        stations = [s for s in stations if s["name"] not in train_spec.excluded_stations]
        if len(stations) < 2:
            raise ValueError(f"{train['id']}: route piece has fewer than two stations")
        expanded_pieces.append(stations)

    ordered: list[dict] = []
    route_sections: list[dict] = []
    for stations in expanded_pieces:
        if ordered and ordered[-1]["name"] != stations[0]["name"]:
            raise ValueError(
                f"{train['id']}: discontinuous pieces {ordered[-1]['name']}->{stations[0]['name']}"
            )
        if not ordered:
            ordered.extend(stations)
        else:
            ordered.extend(stations[1:])
        for start, end in zip(stations, stations[1:]):
            section = {
                "from": start["name"],
                "to": end["name"],
                "from_n02_station_code": start.get("n02_station_code"),
                "to_n02_station_code": end.get("n02_station_code"),
            }
            if end.get("line"):
                section["line_names"] = [end["line"]]
            if end.get("operator"):
                section["operator_names"] = [end["operator"]]
            route_sections.append(section)

    if ordered[0]["name"] != train["origin"] or ordered[-1]["name"] != train["destination"]:
        raise ValueError(
            f"{train['id']}: expanded endpoints {ordered[0]['name']}->{ordered[-1]['name']} "
            f"do not match {train['origin']}->{train['destination']}"
        )
    missing_passenger = sorted(train_spec.passenger_stops - {item["name"] for item in ordered})
    if missing_passenger:
        raise ValueError(f"{train['id']}: passenger stations absent from route: {missing_passenger}")

    old_by_name = {stop["name"]: stop for stop in train.get("stops", [])}
    stops = []
    for position, station in enumerate(ordered):
        name = station["name"]
        if position == 0:
            stop_type = "origin"
        elif position == len(ordered) - 1:
            stop_type = "destination"
        elif train_spec.all_passenger or name in train_spec.passenger_stops:
            stop_type = "passenger_stop"
        else:
            stop_type = "pass_through"
        old = old_by_name.get(name, {})
        stops.append(
            {
                "name": name,
                "n02_station_code": station.get("n02_station_code"),
                "arrival": old.get("arrival") if stop_type != "pass_through" else None,
                "departure": old.get("departure") if stop_type != "pass_through" else None,
                "stop_type": stop_type,
                "ride_segment": True,
            }
        )
    stops[0]["arrival"] = None
    stops[-1]["departure"] = None
    result = dict(train)
    result["stops"] = stops
    result["route_sections"] = route_sections
    result.pop("route_geometry_cache", None)
    return result


def audit_store(store: dict, cutoff: str = "2026-07-14") -> list[str]:
    errors = []
    ids = set()
    valid_types = {"origin", "passenger_stop", "pass_through", "operational_stop", "destination"}
    for train in store.get("trains", []):
        train_id = train.get("id")
        if train_id in ids:
            errors.append(f"duplicate train id: {train_id}")
        ids.add(train_id)
        stops = train.get("stops", [])
        sections = train.get("route_sections", [])
        if len(stops) < 2:
            errors.append(f"{train_id}: fewer than two stops")
            continue
        if stops[0].get("stop_type") != "origin" or stops[-1].get("stop_type") != "destination":
            errors.append(f"{train_id}: invalid endpoint stop_type")
        if any(stop.get("stop_type") not in valid_types for stop in stops):
            errors.append(f"{train_id}: invalid stop_type")
        if any(not isinstance(stop.get("ride_segment"), bool) for stop in stops):
            errors.append(f"{train_id}: ride_segment must be boolean")
        expected = [(a["name"], b["name"]) for a, b in zip(stops, stops[1:])]
        actual = [(section.get("from"), section.get("to")) for section in sections]
        if expected != actual:
            errors.append(f"{train_id}: route_sections are not adjacent stop pairs")
        if train.get("date", "9999-99-99") <= cutoff and train_id not in TRAIN_SPECS:
            errors.append(f"{train_id}: no completion spec for cutoff")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--segment", nargs=4, metavar=("LINE", "OPERATOR", "FROM", "TO"))
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    index = N02RouteIndex()
    if args.segment:
        line, operator, start, end = args.segment
        stations = index.stations_on_segment(Segment(start, end, line, operator))
        for station in stations:
            print(
                f"{station['name']}\t{station['n02_station_code']}\t"
                f"{station['distance_m']}m\t{station['progress_m']}m"
            )
        return
    store = json.loads(STORE_PATH.read_text())
    cutoff_trains = [train for train in store["trains"] if train.get("date", "9999-99-99") <= "2026-07-14"]
    missing_specs = [train["id"] for train in cutoff_trains if train["id"] not in TRAIN_SPECS]
    if missing_specs:
        raise SystemExit("Missing TRAIN_SPECS: " + ", ".join(missing_specs))
    old_counts = {train["id"]: len(train["stops"]) for train in cutoff_trains}
    store["trains"] = [
        expand_train(index, train, TRAIN_SPECS[train["id"]])
        if train.get("date", "9999-99-99") <= "2026-07-14"
        else train
        for train in store["trains"]
    ]
    errors = audit_store(store)
    if errors:
        raise SystemExit("\n".join(errors))
    for train in store["trains"]:
        if train["id"] in old_counts:
            passenger = sum(stop["stop_type"] != "pass_through" for stop in train["stops"])
            through = sum(stop["stop_type"] == "pass_through" for stop in train["stops"])
            print(
                f"{train['id']}\t{old_counts[train['id']]}->{len(train['stops'])}\t"
                f"stop={passenger}\tpass={through}"
            )
    if args.write:
        # The canonical store uses one-space indentation; preserving it keeps
        # this data-only update reviewable instead of producing format churn.
        STORE_PATH.write_text(json.dumps(store, ensure_ascii=False, indent=1) + "\n")
        print(f"Wrote {STORE_PATH}")
    else:
        print("Audit only; pass --write to update train-store.json.")


if __name__ == "__main__":
    main()
