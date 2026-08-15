#!/usr/bin/env python3
"""Audit Taiwan or Hong Kong compact rail packages into rebuild inventories."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
from collections import Counter, defaultdict
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[2]
UID_SEP = "␟"
EARTH_RADIUS_M = 6_371_008.8

TW_SOURCES = {
    "THSR": "https://www.thsrc.com.tw/event/Governance/2020THSRC_Introduction.pdf",
    "TRA": "https://www.railway.gov.tw/tra-tip-web/tip/",
    "TRTC": "https://www.metro.taipei/cp.aspx?n=91974F2B13D997F1",
    "NTMETRO": "https://www.ntmetro.com.tw/",
    "TYMETRO": "https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/road.php",
    "TMRT": "https://www.tmrt.com.tw/",
    "KRTC": "https://www.krtc.com.tw/Guide/guide_map",
    "AFR": "https://afrch.forest.gov.tw/",
}

HK_MTR_SOURCE = "https://www.mtr.com.hk/en/customer/jp/index.php"
HK_MTR_STATIONS = "https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv"
HK_MTR_LIGHT_RAIL = "https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv"
HK_MTR_LIGHT_RAIL_SCHEDULE = "https://www.mtr.com.hk/ch/customer/services/schedule_index.html"
HK_TRAM_SOURCE = "https://www.hktramways.com/en/plan-your-ride/"
HK_TRAM_SERVICES = "https://www.hktramways.com/en/schedules-fares/en/schedules-fares"

APPLE_REFERENCES = {
    "TW": [
        {
            "filename": "tw-taipei-z15.png", "place": "Taipei", "zoom": 15,
            "latitude": 25.0478, "longitude": 121.5170,
            "check_scope": "urban_heavy_rail_parallel_corridors",
            "line_ids": [
                "tw-thsr-main", "tw-tra-western-north", "tw-trtc-bl", "tw-trtc-r",
                "tw-trtc-g", "tw-trtc-o-luzhou", "tw-trtc-o-huilong", "tw-trtc-br",
                "tw-trtc-y", "tw-tym-a",
            ],
            "visual_findings": (
                "可见台铁/高铁/捷运/机场捷运的独立色线、圆形车站点、线路文字和密集平行走廊；"
                "只证明台北画面的参考样式，不证明项目几何已与Apple逐像素对齐。"
            ),
        },
        {
            "filename": "tw-sanying-z15.png", "place": "Sanying", "zoom": 15,
            "latitude": 24.9500, "longitude": 121.3750,
            "check_scope": "new_compact_urban_end_to_end_line",
            "line_ids": ["tw-ntmetro-lb"],
            "visual_findings": (
                "三莺线全线在同一画面内可见，为单一浅蓝端到端线路；12站、山谷弯点、顶埔接轨端和"
                "莺桃福德终点均可辨。截图可作为完整Apple参考底图，但仍须与项目同范围截图叠加后才算通过。"
            ),
        },
        {
            "filename": "tw-kaohsiung-z14.png", "place": "Kaohsiung", "zoom": 14,
            "latitude": 22.6273, "longitude": 120.3014,
            "check_scope": "metro_and_closed_light_rail_loop",
            "line_ids": [
                "tw-thsr-main", "tw-tra-western-south", "tw-tra-pingtung",
                "tw-krtc-r", "tw-krtc-o", "tw-klrt-c",
            ],
            "visual_findings": (
                "可见高雄捷运红/橘线、台铁走廊及轻轨闭环；轻轨保持闭合且车站点逐站可辨；"
                "只证明高雄画面的参考样式，不证明项目几何已与Apple逐像素对齐。"
            ),
        },
    ],
    "HK": [
        {
            "filename": "hk-kowloon-z14.png", "place": "Kowloon", "zoom": 14,
            "latitude": 22.3125, "longitude": 114.1818,
            "check_scope": "heavy_rail_branches_and_shared_corridors",
            "line_ids": [
                "hk-mtr-ael", "hk-mtr-eal-low", "hk-mtr-isl", "hk-mtr-ktl",
                "hk-mtr-sil", "hk-mtr-tcl", "hk-mtr-tkl-poa", "hk-mtr-tkl-lhp",
                "hk-mtr-tml", "hk-mtr-twl", "hk-tram-east", "hk-tram-west",
                "hk-tram-hv", "hk-tram-np",
            ],
            "visual_findings": (
                "可见市区重铁分支、共享走廊、线路文字和圆形车站点；"
                "只证明九龙/港岛核心画面的参考样式，不证明项目几何已与Apple逐像素对齐。"
            ),
        },
        {
            "filename": "hk-tuen-mun-z15.png", "place": "Tuen Mun", "zoom": 15,
            "latitude": 22.3910, "longitude": 113.9730,
            "check_scope": "dense_short_light_rail_network",
            "line_ids": [
                "hk-mtr-tml", "hk-mtr-lr-505", "hk-mtr-lr-507", "hk-mtr-lr-610",
                "hk-mtr-lr-614", "hk-mtr-lr-614p", "hk-mtr-lr-615",
                "hk-mtr-lr-615p", "hk-mtr-lr-751",
            ],
            "visual_findings": (
                "可见屯门轻铁密集分支、短区间、共享轨道和屯马线；短线在此缩放仍逐站可辨；"
                "天水围705/706环线及元朗761P不在本图完整覆盖范围。"
            ),
        },
        {
            "filename": "hk-tin-shui-wai-z16.png", "place": "Tin Shui Wai", "zoom": 16,
            "latitude": 22.4580, "longitude": 114.0030,
            "check_scope": "opposite_direction_loop_services_on_one_physical_track",
            "line_ids": [
                "hk-mtr-lr-705", "hk-mtr-lr-706", "hk-mtr-lr-751", "hk-mtr-lr-761p",
            ],
            "visual_findings": (
                "705/706以相反方向使用同一闭环物理轨道，Apple画成单线而非两条平行环；站名附服务号，"
                "并显示现有资料包未列的720特别服务。"
            ),
        },
        {
            "filename": "hk-island-tram-z16.png", "place": "Hong Kong Island", "zoom": 16,
            "latitude": 22.2830, "longitude": 114.1810,
            "check_scope": "directional_tram_tracks_and_rejoining_branch",
            "line_ids": [
                "hk-tram-east", "hk-tram-west", "hk-tram-hv", "hk-tram-np",
            ],
            "visual_findings": (
                "香港电车东西行方向轨保持相邻独立细线，跑马地支线形成回转后重新并入主走廊；"
                "北角支线只在画面东缘部分可见。"
            ),
        },
    ],
}


def apple_zoom(detail_profile: str, check_kind: str) -> int:
    """Return a comparison zoom without applying long-line thresholds to short lines."""
    if detail_profile in {"short_tram", "mountain_short_line"}:
        return 17 if check_kind == "station_anchor" else 16
    if detail_profile == "compact_urban":
        return 16 if check_kind == "station_anchor" else 15
    return 16 if check_kind == "station_anchor" else 14


def apple_url(longitude: float, latitude: float, zoom: int) -> str:
    return f"https://maps.apple.com/?ll={latitude:.7f},{longitude:.7f}&z={zoom}&t=r"


def midpoint(points: list[list[float]]) -> tuple[float, float]:
    """Choose the geometry vertex nearest half of the polyline length."""
    if len(points) == 1:
        return float(points[0][0]), float(points[0][1])
    lengths = [haversine_m(a, b) for a, b in zip(points, points[1:])]
    target = sum(lengths) / 2
    walked = 0.0
    for a, b, length in zip(points, points[1:], lengths):
        if walked + length >= target and length:
            fraction = (target - walked) / length
            return (
                float(a[0]) + (float(b[0]) - float(a[0])) * fraction,
                float(a[1]) + (float(b[1]) - float(a[1])) * fraction,
            )
        walked += length
    return float(points[-1][0]), float(points[-1][1])


def decoded_segments(line: dict) -> list[list[list[float]]]:
    result = []
    previous_last = None
    for segment in line["segments"]:
        payload = segment[2]
        if segment[1]:
            if previous_last is None:
                raise ValueError(f"{line['id']}: shared compact segment has no prior boundary")
            points = [previous_last, *payload]
        else:
            points = payload
        result.append(points)
        previous_last = points[-1]
    return result


def tw_system(line_id: str) -> str:
    if line_id.startswith("tw-thsr-"):
        return "THSR"
    if line_id.startswith("tw-tra-"):
        return "TRA"
    if line_id.startswith("tw-trtc-"):
        return "TRTC"
    if line_id.startswith("tw-ntmetro-"):
        return "NTMETRO"
    if line_id.startswith("tw-tym-"):
        return "TYMETRO"
    if line_id.startswith("tw-tcmrt-"):
        return "TMRT"
    if line_id.startswith("tw-krtc-") or line_id.startswith("tw-klrt-"):
        return "KRTC"
    if line_id.startswith("tw-alsr-"):
        return "AFR"
    raise KeyError(line_id)


def line_policy(country: str, line: dict) -> dict:
    line_id = line["id"]
    policy = {
        "logical_line_id": line_id,
        "shape_class": "ordinary_linear",
        "network_role": "main",
        "detail_profile": "standard",
        "topology_status": "official_station_order_verified",
        "topology_source_urls": [],
        "notes": "",
    }
    if country == "TW":
        system = tw_system(line_id)
        policy["topology_source_urls"] = [TW_SOURCES[system]]
        if line_id.startswith(("tw-trtc-", "tw-ntmetro-", "tw-tym-", "tw-tcmrt-", "tw-krtc-")):
            policy["detail_profile"] = "compact_urban"
        if line_id.startswith("tw-klrt-"):
            policy["detail_profile"] = "short_tram"
        if line_id.startswith("tw-alsr-"):
            policy["detail_profile"] = "mountain_short_line"
        special = {
            "tw-tra-coast": ("tw-tra-western-corridor", "branch_rejoins", "rejoin_variant"),
            "tw-tra-taichung": ("tw-tra-western-corridor", "branch_rejoins", "main_variant"),
            "tw-trtc-r": ("tw-trtc-r-network", "branched_terminal", "main"),
            "tw-trtc-r-xinbeitou": ("tw-trtc-r-network", "branched_terminal", "terminal_branch"),
            "tw-trtc-g": ("tw-trtc-g-network", "branched_terminal", "main"),
            "tw-trtc-g-xiaobitan": ("tw-trtc-g-network", "branched_terminal", "terminal_branch"),
            "tw-trtc-o-huilong": ("tw-trtc-o-network", "branched_terminal", "main"),
            "tw-trtc-o-luzhou": ("tw-trtc-o-network", "branched_terminal", "terminal_branch"),
            "tw-ntmetro-v-green": ("tw-ntmetro-v-network", "branched_terminal", "main"),
            "tw-ntmetro-v-blue": ("tw-ntmetro-v-network", "branched_terminal", "terminal_branch"),
            "tw-klrt-c": ("tw-klrt-c", "loop", "closed_loop"),
            "tw-alsr-alishan": ("tw-alsr-network", "spiral_and_switchbacks", "main"),
            "tw-alsr-zhaoping": ("tw-alsr-network", "branched_terminal", "terminal_branch"),
            "tw-alsr-shenmu": ("tw-alsr-network", "branched_terminal", "terminal_branch"),
            "tw-alsr-zhushan": ("tw-alsr-network", "terminal_loop_line", "terminal_branch"),
        }
        if line_id in special:
            logical, shape, role = special[line_id]
            policy.update(logical_line_id=logical, shape_class=shape, network_role=role)
        if line_id == "tw-trtc-y":
            policy["notes"] = "线路名为环状线，但当前已运营区段尚未闭环，按普通端到端线路处理。"
        if line_id == "tw-alsr-alishan":
            policy["topology_source_urls"] = [TW_SOURCES["AFR"]]
            policy["notes"] = "官方资料确认独立山三圈螺旋、樟脑寮/屏遮那折返及Z形登山段。"
        if line_id == "tw-alsr-zhushan":
            policy["notes"] = "站序为端到端，但祝山端保留官方轨道的终端回转环。"
    else:
        policy["topology_source_urls"] = [HK_MTR_STATIONS]
        if line_id.startswith("hk-mtr-lr-"):
            policy.update(detail_profile="short_tram", topology_source_urls=[HK_MTR_LIGHT_RAIL])
        special = {
            "hk-mtr-eal-low": ("hk-mtr-eal-network", "branched_terminal", "main"),
            "hk-mtr-eal-lmc": ("hk-mtr-eal-network", "branched_terminal", "terminal_branch"),
            "hk-mtr-tkl-poa": ("hk-mtr-tkl-network", "branched_terminal", "main"),
            "hk-mtr-tkl-lhp": ("hk-mtr-tkl-network", "branched_terminal", "terminal_branch"),
            "hk-mtr-lr-705": ("hk-mtr-lr-705", "loop", "clockwise_loop_service"),
            "hk-mtr-lr-706": ("hk-mtr-lr-706", "loop", "counterclockwise_loop_service"),
            "hk-tram-east": ("hk-tram-physical-network", "directional_track", "eastbound_main_track"),
            "hk-tram-west": ("hk-tram-physical-network", "directional_track", "westbound_main_track"),
            "hk-tram-hv": ("hk-tram-physical-network", "branch_rejoins", "one_way_rejoin_branch"),
            "hk-tram-np": ("hk-tram-physical-network", "branch_rejoins", "one_way_rejoin_branch"),
        }
        if line_id in special:
            logical, shape, role = special[line_id]
            policy.update(logical_line_id=logical, shape_class=shape, network_role=role)
        if line_id.startswith("hk-tram-"):
            policy.update(
                detail_profile="short_tram",
                topology_source_urls=[HK_TRAM_SOURCE],
                topology_status="official_stops_and_services_osm_track_geometry",
            )
    return policy


def colour_policy(country: str, line: dict) -> dict:
    color = line["color"].lower()
    if country == "HK" and line["operator"] == "MTR":
        return {
            "official_line_color_hex": color,
            "official_map_sample_hex": color,
            "line_color_hex": color,
            "line_color_status": "official_data_hex",
            "line_color_authority": "operator_official_journey_planner",
            "line_color_confidence": "high",
            "line_color_source_url": HK_MTR_SOURCE,
            "render_color_hex": color,
            "render_color_basis": "official_line_color",
            "notes": "色号直接来自MTR官方旅程规划器线路数据。",
        }
    if country == "HK":
        return {
            "official_line_color_hex": "",
            "official_map_sample_hex": "",
            "line_color_hex": color,
            "line_color_status": "official_corporate_color_sample",
            "line_color_authority": "operator_brand_sample_not_track_line_color",
            "line_color_confidence": "medium",
            "line_color_source_url": HK_TRAM_SOURCE,
            "render_color_hex": color,
            "render_color_basis": "operator_color_fallback",
            "notes": "香港电车六条服务各有服务色；物理轨道使用运营者企业绿色，不能称为每条轨道的官方线路色。",
        }
    system = tw_system(line["id"])
    if line["id"] == "tw-ntmetro-lb":
        return {
            "official_line_color_hex": "",
            "official_map_sample_hex": color,
            "line_color_hex": color,
            "line_color_status": "official_map_raster_sample_no_published_hex",
            "line_color_authority": "operator_official_station_map_sample",
            "line_color_confidence": "medium",
            "line_color_source_url": "https://www.ntmetro.com.tw/archive/images/1150625-LB01MAP.jpg",
            "render_color_hex": color,
            "render_color_basis": "official_map_color_sample",
            "notes": "从新北捷运官方LB01车站位置图的浅蓝线路色块取样为#4EB7D5；JPEG取样不是运营者发布的品牌色规范，因此不冒称官方发布HEX。",
        }
    role = "operator_color_fallback" if system in {"TRA", "AFR", "THSR"} else "official_map_color_sample"
    return {
        "official_line_color_hex": "",
        "official_map_sample_hex": "",
        "line_color_hex": color,
        "line_color_status": "official_map_sample_no_published_hex",
        "line_color_authority": "editorial_hex_matched_to_official_map",
        "line_color_confidence": "medium",
        "line_color_source_url": TW_SOURCES[system],
        "render_color_hex": color,
        "render_color_basis": role,
        "notes": "官方页面/地图确认颜色语义，但官方接口未发布HEX；现有具体值是构建器的编辑色号，不标为官方精确HEX。",
    }


def haversine_m(a, b) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    dlon, dlat = lon2 - lon1, lat2 - lat1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(value)))


def station_uid(operator: str, group: str) -> str:
    return f"{operator}{UID_SEP}{group}"


def write_csv(path: Path, rows: list[dict], fieldnames=None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows and not fieldnames:
        return
    with path.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames or list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def primary_style(tags: set[str]) -> str:
    order = [
        "reversing_station", "spiral_station", "branch_origin", "multi_operator_interchange",
        "multi_line_station", "terminal_loop_station", "loop_station", "branch_terminal",
        "line_terminal", "ordinary_station",
    ]
    return next((tag for tag in order if tag in tags), "ordinary_station")


def current_coverage_rows(country: str) -> list[dict]:
    if country == "TW":
        return [
            {
                "network": "THSR", "scope": "台灣高速鐵路", "coverage_status": "no_gap_detected",
                "package_scope": "12 stations", "current_official_scope": "12 stations",
                "missing_or_future_scope": "", "severity": "info", "source_url": TW_SOURCES["THSR"],
                "notes": "现有运营站序与官方资料一致。",
            },
            {
                "network": "TRA", "scope": "台铁干线及客运支线", "coverage_status": "no_gap_detected",
                "package_scope": "16 display lines", "current_official_scope": "current passenger LineIDs",
                "missing_or_future_scope": "", "severity": "info", "source_url": TW_SOURCES["TRA"],
                "notes": "资料包构建器对官方Passenger LineID设有未消费即失败的完整性门禁。",
            },
            {
                "network": "TRTC", "scope": "台北捷运", "coverage_status": "no_gap_detected",
                "package_scope": "8 display lines", "current_official_scope": "current operating network",
                "missing_or_future_scope": "", "severity": "info", "source_url": TW_SOURCES["TRTC"],
                "notes": "新北投、小碧潭和中和新芦分支已拆分。",
            },
            {
                "network": "NTMETRO", "scope": "新北捷运", "coverage_status": "no_gap_detected",
                "package_scope": "环状线、三莺线、淡海轻轨、安坑轻轨", "current_official_scope": "current operating network",
                "missing_or_future_scope": "", "severity": "info",
                "source_url": "https://www.ntmetro.com.tw/basic/?mode=detail&node=867",
                "notes": "三莺线12站已按2026-06-30载客试营运公告纳入；站序/门牌来自新北捷运与新北市政府，中心线来自NLSC。",
            },
            {
                "network": "TYMETRO", "scope": "桃园机场捷运", "coverage_status": "operating_scope_complete_future_stations_excluded",
                "package_scope": "A1–A22 operating stops; 22 stations", "current_official_scope": "A1–A22 timetable stops",
                "missing_or_future_scope": "A14第三航厦、A23中坜仍非当前载客时刻表站", "severity": "info",
                "source_url": "https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/dep-A1",
                "notes": "官方路网页同时展示未来站，运营判定以当前时刻表可选站为准；不要提前渲染A14/A23。",
            },
            {
                "network": "TMRT", "scope": "台中捷运绿线", "coverage_status": "no_gap_detected",
                "package_scope": "18 stations", "current_official_scope": "18 stations",
                "missing_or_future_scope": "", "severity": "info", "source_url": TW_SOURCES["TMRT"], "notes": "",
            },
            {
                "network": "KRTC", "scope": "高雄捷运及环状轻轨", "coverage_status": "no_gap_detected",
                "package_scope": "红线、橘线、轻轨闭环", "current_official_scope": "current operating network",
                "missing_or_future_scope": "", "severity": "info", "source_url": TW_SOURCES["KRTC"],
                "notes": "轻轨按闭环线路处理。",
            },
            {
                "network": "AFR", "scope": "阿里山林业铁路", "coverage_status": "no_gap_detected",
                "package_scope": "主线及3条支线", "current_official_scope": "current published network",
                "missing_or_future_scope": "", "severity": "info", "source_url": TW_SOURCES["AFR"],
                "notes": "螺旋、折返和祝山终端回转环另行标注。",
            },
        ]
    return [
        {
            "network": "MTR_HEAVY_RAIL", "scope": "9 commuter lines + Airport Express",
            "coverage_status": "no_gap_detected", "package_scope": "12 display vectors / 10 logical lines",
            "current_official_scope": "9 commuter lines + Airport Express", "missing_or_future_scope": "",
            "severity": "info", "source_url": "https://www.mtr.com.hk/en/customer/services/domestic_train_services.html",
            "notes": "东铁及将军澳分支拆成显示向量，但逻辑线路仍各为一组。",
        },
        {
            "network": "MTR_LIGHT_RAIL", "scope": "regular numbered Light Rail services",
            "coverage_status": "regular_service_scope_complete_special_services_not_materialized",
            "package_scope": "11 regular services",
            "current_official_scope": "11 regular services plus weekday/peak special services",
            "missing_or_future_scope": "506P、507P、720、751P等特别服务未作为独立显示vectorline",
            "severity": "medium", "source_url": HK_MTR_LIGHT_RAIL_SCHEDULE,
            "notes": (
                "705/706按相反方向闭环服务处理。特别服务属于同一轻铁物理轨网，不应拆成独立平行轨道；"
                "但服务层/车站connected_lines必须另表登记。"
            ),
        },
        {
            "network": "HONG_KONG_TRAMWAYS", "scope": "physical tracks carrying six main services",
            "coverage_status": "physical_network_complete_service_vectors_intentionally_collapsed",
            "package_scope": "2 directional trunks + Happy Valley/North Point rejoining branches",
            "current_official_scope": "6 main passenger services", "missing_or_future_scope": "",
            "severity": "info", "source_url": HK_TRAM_SERVICES,
            "notes": "服务线路与物理轨道不是同一层；六条服务共享轨道，不机械展开成六条平行vectorline。",
        },
    ]


def rebuild_issue_rows(country: str) -> list[dict]:
    common_apple = {
        "issue_id": f"{country}-APPLE-TILES-001", "severity": "high", "country": country,
        "scope": "Apple Maps visual comparison", "status": "open",
        "issue": "只有2张城市抽样截图，尚未达到全境逐tile检查。",
        "evidence": "evidence/apple-maps-reference/line-coverage.csv; evidence/apple-maps-reference/check-queue.csv",
        "recommended_action": "依check-queue逐项保存Apple与项目同范围截图/叠加图，记录pass/fail、问题类型与修复提交。",
        "blocks_complete_rebuild": 1,
    }
    if country == "TW":
        return [
            {
                "issue_id": "TW-COLOR-001", "severity": "medium", "country": country,
                "scope": "all Taiwan lines", "status": "open",
                "issue": "官方页面确认颜色语义，但数据接口未发布可审计HEX；当前HEX为编辑取色。",
                "evidence": "colours/line-colours.csv",
                "recommended_action": "逐运营者保存官方矢量/PDF色样和提取坐标；在证据齐全前不得把编辑HEX标为官方精确值。",
                "blocks_complete_rebuild": 1,
            },
            common_apple,
        ]
    return [
        {
            "issue_id": "HK-LR-SERVICES-001", "severity": "medium", "country": country,
            "scope": "MTR Light Rail service layer", "status": "open",
            "issue": "显示包覆盖11条常规服务，但港铁当前另公布506P、507P、720、751P等繁忙时段特别服务。",
            "evidence": "issues/missing-current-lines.csv; issues/missing-current-line-stations.csv",
            "recommended_action": "在服务/车站关系层补齐特别服务；复用轻铁物理轨网，不新增独立平行vectorline。",
            "blocks_complete_rebuild": 0,
        },
        {
            "issue_id": "HK-GEOMETRY-001", "severity": "high", "country": country,
            "scope": "all Hong Kong track centrelines", "status": "open",
            "issue": "站序/服务拓扑为官方资料，轨道中心线仍来自OSM。",
            "evidence": "evidence/package-sources.md",
            "recommended_action": "逐线与官方图及Apple tile核对弯点、分岔、共享走廊和车站锚点，记录每tile差异。",
            "blocks_complete_rebuild": 1,
        },
        {
            "issue_id": "HK-TRAM-COLOR-001", "severity": "medium", "country": country,
            "scope": "Hong Kong Tramways", "status": "open",
            "issue": "物理轨道当前用企业绿色；六条服务色不能等同于四条物理vectorline颜色。",
            "evidence": "colours/line-colours.csv",
            "recommended_action": "渲染层明确选择物理轨道企业色或服务覆盖色，并保存官方服务色证据。",
            "blocks_complete_rebuild": 0,
        },
        common_apple,
    ]


def missing_current_line_rows(country: str) -> list[dict]:
    if country != "HK":
        return []
    return [
        {
            "line_or_service_id": "hk-mtr-lr-506p", "operator": "MTR", "name": "輕鐵506P綫",
            "record_type": "weekday_peak_special_service", "display_vector_required": 0,
            "status": "missing_service_layer", "source_url": HK_MTR_LIGHT_RAIL_SCHEDULE,
            "notes": "现有物理轨道已覆盖；不得因补服务而增加平行轨道。",
        },
        {
            "line_or_service_id": "hk-mtr-lr-507p", "operator": "MTR", "name": "輕鐵507P綫",
            "record_type": "weekday_peak_special_service", "display_vector_required": 0,
            "status": "missing_service_layer", "source_url": HK_MTR_LIGHT_RAIL_SCHEDULE,
            "notes": "现有物理轨道已覆盖；不得因补服务而增加平行轨道。",
        },
        {
            "line_or_service_id": "hk-mtr-lr-720", "operator": "MTR", "name": "輕鐵720綫",
            "record_type": "weekday_school_day_one_trip_special_service", "display_vector_required": 0,
            "status": "missing_service_layer", "source_url": HK_MTR_LIGHT_RAIL_SCHEDULE,
            "notes": "兆康→洪水桥→天耀→翠湖→天荣；Apple站名服务标签亦可见720。",
        },
        {
            "line_or_service_id": "hk-mtr-lr-751p", "operator": "MTR", "name": "輕鐵751P綫",
            "record_type": "peak_special_service", "display_vector_required": 0,
            "status": "missing_service_layer", "source_url": HK_MTR_LIGHT_RAIL_SCHEDULE,
            "notes": "繁忙时段运行；现有物理轨道已覆盖。",
        },
    ]


def missing_current_station_rows(country: str) -> list[dict]:
    if country != "HK":
        return []
    return [
        {
            "line_or_service_id": "hk-mtr-lr-720", "station_order": index,
            "station_name": name, "status": "missing_service_membership_not_missing_physical_station",
            "source_url": HK_MTR_LIGHT_RAIL_SCHEDULE,
        }
        for index, name in enumerate(
            ["兆康", "藍地", "泥圍", "鍾屋村", "洪水橋", "坑尾村", "天耀", "樂湖", "天瑞", "翠湖", "天榮"],
            start=1,
        )
    ]


def manual_station_tags(country: str, group: str) -> set[str]:
    tags = set()
    if country == "TW":
        if group in {
            "tw-official-afr-q0000001054",  # 樟腦寮
            "tw-official-afr-q0000001627",  # 屏遮那
            "tw-official-afr-q0000001651",  # 阿里山 station-throat reversal
        }:
            tags.add("reversing_station")
        if group == "tw-official-afr-q0000001073":
            tags.add("spiral_station")
        if group == "tw-official-afr-q0000004704":
            tags.add("terminal_loop_station")
    return tags


def audit(country: str, package_path: Path, sources_path: Path, output: Path) -> dict:
    package = json.loads(package_path.read_text(encoding="utf-8"))
    line_records = []
    line_lookup = {}
    station_occurrences = defaultdict(list)
    logical_edges = defaultdict(set)
    line_edges = defaultdict(list)
    validation_errors = []

    geometry_official = bool(package.get("geometrySource", {}).get("officialOnly") == 1)
    geometry_authority = "official_geometry" if geometry_official else "official_topology_osm_geometry"
    station_boundary_tolerance_m = float(
        package.get("geometrySource", {})
        .get("officialGeometryComparison", {})
        .get("toleranceMeters", 0.1)
    )

    for line in package["lines"]:
        policy = line_policy(country, line)
        colour = colour_policy(country, line)
        stations = line["stations"]
        segments = line["segments"]
        is_loop = len(segments) == len(stations)
        expected = len(stations) if is_loop else len(stations) - 1
        if len(segments) != expected:
            validation_errors.append(f"{line['id']}: segment/station count")
        endpoint_error = 0.0
        previous_last = None
        for index, segment in enumerate(segments):
            target = (index + 1) % len(stations)
            payload = segment[2]
            if segment[1]:
                if previous_last is None:
                    validation_errors.append(f"{line['id']}: shared compact segment has no prior boundary")
                    decoded = payload
                else:
                    decoded = [previous_last, *payload]
            else:
                decoded = payload
            start = decoded[0]
            end = decoded[-1]
            previous_last = end
            endpoint_error = max(
                endpoint_error,
                haversine_m(start, stations[index][2:4]),
                haversine_m(end, stations[target][2:4]),
            )
        if endpoint_error > station_boundary_tolerance_m:
            validation_errors.append(
                f"{line['id']}: station boundary drift "
                f"{endpoint_error:.3f}m > {station_boundary_tolerance_m:.3f}m"
            )
        row = {
            "line_id": line["id"],
            "logical_line_id": policy["logical_line_id"],
            "operator": line["operator"],
            "line": line["name"],
            "line_english": line.get("nameRoma", ""),
            "shape_class": policy["shape_class"],
            "network_role": policy["network_role"],
            "detail_profile": policy["detail_profile"],
            "main_path": f"{stations[0][1]} → {stations[-1][1]}" + (" → 闭环" if is_loop else ""),
            "station_count": len(stations),
            "segment_count": len(segments),
            "is_closed_loop": is_loop,
            "length_km": round(sum(float(segment[0]) for segment in segments), 3),
            "connectivity_status": (
                "continuous" if endpoint_error <= station_boundary_tolerance_m else "endpoint_mismatch"
            ),
            "max_station_boundary_error_m": round(endpoint_error, 4),
            "station_boundary_tolerance_m": station_boundary_tolerance_m,
            "topology_status": policy["topology_status"],
            "geometry_authority": geometry_authority,
            "topology_source_urls": json.dumps(policy["topology_source_urls"], ensure_ascii=False),
            **colour,
            "notes": "；".join(x for x in (policy["notes"], colour["notes"]) if x),
        }
        line_records.append(row)
        line_lookup[line["id"]] = row

        for station in stations:
            station_occurrences[(line["operator"], str(station[0]))].append((line, station))
        for index in range(len(segments)):
            target = (index + 1) % len(stations)
            a, b = str(stations[index][0]), str(stations[target][0])
            edge = tuple(sorted((a, b)))
            logical_edges[(line["operator"], policy["logical_line_id"])].add(edge)
            line_edges[line["id"]].append((stations[index], stations[target], segments[index]))

    degree = defaultdict(set)
    for (operator, logical), edges in logical_edges.items():
        for a, b in edges:
            degree[(operator, logical, a)].add(b)
            degree[(operator, logical, b)].add(a)

    operator_station_meta = {}
    operators_by_group = defaultdict(set)
    for (operator, group), occurrences in station_occurrences.items():
        uid = station_uid(operator, group)
        names = sorted({station[1] for _line, station in occurrences})
        english = sorted({station[4] for _line, station in occurrences if len(station) > 4 and station[4]})
        points = [(station[2], station[3]) for _line, station in occurrences]
        operator_station_meta[uid] = {
            "station_uid": uid,
            "operator": operator,
            "physical_station_group": group,
            "station_name": "/".join(names),
            "station_english": "/".join(english),
            "longitude": round(sum(p[0] for p in points) / len(points), 7),
            "latitude": round(sum(p[1] for p in points) / len(points), 7),
            "occurrences": occurrences,
        }
        operators_by_group[group].add(operator)

    connections = []
    rail_neighbors = defaultdict(list)
    for line_id, edges in line_edges.items():
        info = line_lookup[line_id]
        for a, b, segment in edges:
            for source, target in ((a, b), (b, a)):
                from_uid = station_uid(info["operator"], str(source[0]))
                to_uid = station_uid(info["operator"], str(target[0]))
                record = {
                    "connection_uid": f"{line_id}{UID_SEP}{source[0]}{UID_SEP}{target[0]}",
                    "physical_connection_uid": f"{line_id}{UID_SEP}{min(str(a[0]), str(b[0]))}{UID_SEP}{max(str(a[0]), str(b[0]))}",
                    "connection_type": "railway_adjacency",
                    "from_station_uid": from_uid,
                    "from_operator": info["operator"],
                    "from_station_name": source[1],
                    "to_station_uid": to_uid,
                    "to_operator": info["operator"],
                    "to_station_name": target[1],
                    "line_id": line_id,
                    "logical_line_id": info["logical_line_id"],
                    "line": info["line"],
                    "line_shape_type": info["shape_class"],
                    "network_role": info["network_role"],
                    "distance_km": round(float(segment[0]), 4),
                    "official_line_color_hex": info["official_line_color_hex"],
                    "line_color_hex": info["line_color_hex"],
                    "line_color_status": info["line_color_status"],
                    "render_color_hex": info["render_color_hex"],
                    "topology_status": info["topology_status"],
                    "geometry_authority": info["geometry_authority"],
                }
                connections.append(record)
                rail_neighbors[from_uid].append(record)

    interchanges = []
    for group, operators in sorted(operators_by_group.items()):
        for source in sorted(operators):
            for target in sorted(operators):
                if source == target:
                    continue
                a, b = station_uid(source, group), station_uid(target, group)
                interchanges.append({
                    "interchange_uid": f"{group}{UID_SEP}{source}{UID_SEP}{target}",
                    "physical_interchange_uid": f"{group}{UID_SEP}{min(source, target)}{UID_SEP}{max(source, target)}",
                    "from_station_uid": a,
                    "from_operator": source,
                    "from_station_name": operator_station_meta[a]["station_name"],
                    "to_station_uid": b,
                    "to_operator": target,
                    "to_station_name": operator_station_meta[b]["station_name"],
                    "physical_station_group": group,
                    "connection_type": "physical_interchange",
                    "source": "shared_official_station_group",
                })

    station_rows = []
    station_line_rows = []
    station_json = []
    for uid, meta in sorted(operator_station_meta.items()):
        operator, group = meta["operator"], meta["physical_station_group"]
        line_ids = sorted({line["id"] for line, _station in meta["occurrences"]})
        logical_ids = sorted({line_lookup[line_id]["logical_line_id"] for line_id in line_ids})
        tags = manual_station_tags(country, group)
        line_details = []
        for line_id in line_ids:
            info = line_lookup[line_id]
            line_points = sorted({
                (round(station[2], 7), round(station[3], 7))
                for occurrence_line, station in meta["occurrences"]
                if occurrence_line["id"] == line_id
            })
            local_degree = len(degree[(operator, info["logical_line_id"], group)])
            roles = set()
            if local_degree >= 3:
                roles.add("branch_origin")
            if info["shape_class"] == "loop":
                roles.add("loop_station")
            if info["network_role"] in {"terminal_branch", "one_way_rejoin_branch"} and local_degree == 1:
                roles.add("branch_terminal")
            elif local_degree == 1:
                roles.add("line_terminal")
            else:
                roles.add("ordinary_station")
            roles.update(manual_station_tags(country, group))
            tags.update(roles)
            line_details.append({
                "line_id": line_id,
                "logical_line_id": info["logical_line_id"],
                "line": info["line"],
                "line_shape_type": info["shape_class"],
                "network_role": info["network_role"],
                "station_roles": sorted(roles),
                "official_line_color_hex": info["official_line_color_hex"],
                "line_color_hex": info["line_color_hex"],
                "line_color_status": info["line_color_status"],
                "render_color_hex": info["render_color_hex"],
                "station_points": [
                    {"longitude": longitude, "latitude": latitude, "point_role": "on_line_render_anchor"}
                    for longitude, latitude in line_points
                ],
            })
            for point_index, (longitude, latitude) in enumerate(line_points):
                station_line_rows.append({
                    "station_line_point_uid": f"{uid}{UID_SEP}{line_id}{UID_SEP}{point_index}",
                    "station_uid": uid,
                    "operator": operator,
                    "physical_station_group": group,
                    "station_name": meta["station_name"],
                    "line_id": line_id,
                    "logical_line_id": info["logical_line_id"],
                    "line": info["line"],
                    "line_shape_type": info["shape_class"],
                    "network_role": info["network_role"],
                    "longitude": longitude,
                    "latitude": latitude,
                    "point_role": "on_line_render_anchor",
                    "station_roles_json": json.dumps(sorted(roles), ensure_ascii=False),
                    "render_color_hex": info["render_color_hex"],
                    "geometry_authority": info["geometry_authority"],
                })
        if len(logical_ids) >= 2:
            tags.add("multi_line_station")
        other_operators = sorted(operators_by_group[group] - {operator})
        if other_operators:
            tags.add("multi_operator_interchange")
        if tags == {"ordinary_station"} or not tags:
            tags.add("ordinary_station")
        record = {
            "station_uid": uid,
            "operator": operator,
            "station_name": meta["station_name"],
            "station_english": meta["station_english"],
            "physical_station_group": group,
            "longitude": meta["longitude"],
            "latitude": meta["latitude"],
            "station_style": primary_style(tags),
            "station_style_tags": sorted(tags),
            "line_count": len(logical_ids),
            "connected_lines": line_details,
            "rail_neighbor_count": len({row["to_station_uid"] for row in rail_neighbors[uid]}),
            "rail_connections": rail_neighbors[uid],
            "interchange_neighbor_count": len(other_operators),
            "interchange_station_uids": [station_uid(other, group) for other in other_operators],
            "identity_rule": "operator+official_station_group",
            "coordinate_role": "station_group_centroid_not_render_anchor",
            "render_anchor_policy": "use_station_line_points",
        }
        station_json.append(record)
        station_rows.append({
            **{key: value for key, value in record.items() if key not in {
                "station_style_tags", "connected_lines", "rail_connections", "interchange_station_uids"
            }},
            "station_style_tags_json": json.dumps(record["station_style_tags"], ensure_ascii=False),
            "connected_lines_json": json.dumps(record["connected_lines"], ensure_ascii=False, separators=(",", ":")),
            "rail_connections_json": json.dumps(record["rail_connections"], ensure_ascii=False, separators=(",", ":")),
            "interchange_station_uids_json": json.dumps(record["interchange_station_uids"], ensure_ascii=False),
        })

    groups = defaultdict(list)
    for row in line_records:
        groups[(row["operator"], row["logical_line_id"])].append(row)
    logical_rows = []
    for (operator, logical), members in sorted(groups.items()):
        shape_types = sorted({row["shape_class"] for row in members})
        logical_shape = (
            "spiral_switchbacks_with_branches" if "spiral_and_switchbacks" in shape_types and len(members) > 1
            else "branched_terminal" if any(row["network_role"] == "terminal_branch" for row in members)
            else "branch_rejoins" if any("rejoin" in row["network_role"] for row in members)
            else "spiral_and_switchbacks" if "spiral_and_switchbacks" in shape_types
            else "loop" if shape_types == ["loop"]
            else shape_types[0]
        )
        logical_rows.append({
            "logical_line_id": logical,
            "operator": operator,
            "logical_shape_class": logical_shape,
            "display_line_count": len(members),
            "display_line_ids_json": json.dumps([row["line_id"] for row in members], ensure_ascii=False),
            "display_line_names_json": json.dumps([row["line"] for row in members], ensure_ascii=False),
            "main_display_lines_json": json.dumps([row["line_id"] for row in members if row["network_role"] in {"main", "main_variant", "eastbound_main_track", "westbound_main_track"}], ensure_ascii=False),
            "branch_display_lines_json": json.dumps([row["line_id"] for row in members if "branch" in row["network_role"] or "variant" in row["network_role"]], ensure_ascii=False),
        })

    output.mkdir(parents=True, exist_ok=True)
    for stale_path in (
        output / "issues/missing-current-lines.csv",
        output / "issues/missing-current-line-stations.csv",
    ):
        stale_path.unlink(missing_ok=True)
    write_csv(output / "lines/line-classification.csv", line_records)
    write_csv(output / "lines/logical-line-groups.csv", logical_rows)
    write_csv(output / "stations/station-network.csv", station_rows)
    write_csv(output / "stations/station-line-points.csv", station_line_rows)
    write_csv(output / "stations/station-connections.csv", connections)
    write_csv(output / "stations/station-interchanges.csv", interchanges, fieldnames=[
        "interchange_uid", "physical_interchange_uid", "from_station_uid", "from_operator",
        "from_station_name", "to_station_uid", "to_operator", "to_station_name",
        "physical_station_group", "connection_type", "source",
    ])
    write_csv(output / "evidence/current-operation-coverage.csv", current_coverage_rows(country))
    write_csv(output / "issues/rebuild-issues.csv", rebuild_issue_rows(country))
    if missing_current_line_rows(country):
        write_csv(output / "issues/missing-current-lines.csv", missing_current_line_rows(country))
        write_csv(
            output / "issues/missing-current-line-stations.csv",
            missing_current_station_rows(country),
        )
    color_columns = [
        "line_id", "logical_line_id", "operator", "line", "official_line_color_hex",
        "official_map_sample_hex",
        "line_color_hex", "line_color_status", "line_color_authority",
        "line_color_confidence", "line_color_source_url", "render_color_hex",
        "render_color_basis", "notes",
    ]
    write_csv(output / "colours/line-colours.csv", [
        {key: row[key] for key in color_columns} for row in line_records
    ])
    (output / "stations/station-network.json").write_text(json.dumps({
        "schema_version": 1,
        "country": country,
        "identity_rule": "operator+official_station_group",
        "stations": station_json,
        "connections": connections,
        "interchanges": interchanges,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (output / "evidence").mkdir(parents=True, exist_ok=True)
    shutil.copy2(sources_path, output / "evidence/package-sources.md")
    shutil.copy2(package_path, output / "evidence/source-compact-package.json")
    apple_rows = []
    apple_source = APP_ROOT.parent / "outputs/apple-maps-reference"
    apple_output = output / "evidence/apple-maps-reference"
    apple_output.mkdir(parents=True, exist_ok=True)
    reference_files_by_line = defaultdict(list)
    for reference in APPLE_REFERENCES[country]:
        filename = reference["filename"]
        source = apple_source / filename
        present = source.is_file()
        if present:
            shutil.copy2(source, apple_output / filename)
            for line_id in reference["line_ids"]:
                reference_files_by_line[line_id].append(filename)
        apple_rows.append({
            "reference_file": filename,
            "place": reference["place"],
            "capture_date": "2026-08-12",
            "center_longitude": reference["longitude"],
            "center_latitude": reference["latitude"],
            "apple_zoom": reference["zoom"],
            "apple_map_url": apple_url(
                reference["longitude"], reference["latitude"], reference["zoom"]
            ),
            "check_scope": reference["check_scope"],
            "visible_line_ids_json": json.dumps(reference["line_ids"], ensure_ascii=False),
            "present": int(present),
            "review_status": "visually_reviewed_sample" if present else "missing",
            "comparison_status": "reference_only_no_project_overlay",
            "full_tile_audit_status": "not_complete",
            "visual_findings": reference["visual_findings"],
            "notes": "visible_line_ids仅表示Apple画面可见，不表示对应项目线路已通过几何比对。",
        })
    write_csv(apple_output / "index.csv", apple_rows)

    apple_check_rows = []
    apple_line_rows = []
    for line in package["lines"]:
        info = line_lookup[line["id"]]
        references = reference_files_by_line[line["id"]]
        line_checks = []

        station_points = [[float(station[2]), float(station[3])] for station in line["stations"]]
        line_center = midpoint(station_points)
        line_checks.append({
            "check_kind": "line_shape", "check_index": 0,
            "from_station": line["stations"][0][1],
            "to_station": line["stations"][-1][1],
            "longitude": line_center[0], "latitude": line_center[1],
            "required_verifications": (
                "main_and_branch_partition|shape_class|line_label|parallel_line_display|"
                "closed_loop_or_rejoin_when_applicable"
            ),
        })
        for index, station in enumerate(line["stations"]):
            line_checks.append({
                "check_kind": "station_anchor", "check_index": index,
                "from_station": station[1], "to_station": "",
                "longitude": float(station[2]), "latitude": float(station[3]),
                "required_verifications": (
                    "station_on_correct_track|operator_identity|connected_lines|station_style|"
                    "line_label_collision|smoothest_station_entry"
                ),
            })
        for index, (segment, points) in enumerate(zip(line["segments"], decoded_segments(line))):
            target = (index + 1) % len(line["stations"])
            segment_center = midpoint(points)
            line_checks.append({
                "check_kind": "segment_geometry", "check_index": index,
                "from_station": line["stations"][index][1],
                "to_station": line["stations"][target][1],
                "longitude": segment_center[0], "latitude": segment_center[1],
                "required_verifications": (
                    "continuous_connection|correct_turning_points|no_spatial_offset|"
                    "parallel_track_separation|branch_join|line_label"
                ),
            })
        for check in line_checks:
            zoom = apple_zoom(info["detail_profile"], check["check_kind"])
            kind_prefix = {"line_shape": "L", "station_anchor": "P", "segment_geometry": "S"}[
                check["check_kind"]
            ]
            apple_check_rows.append({
                "check_id": f"{country}-APPLE-{line['id']}-{kind_prefix}{check['check_index']:03d}",
                "country": country,
                "line_id": line["id"],
                "logical_line_id": info["logical_line_id"],
                "operator": line["operator"],
                "line": line["name"],
                "shape_class": info["shape_class"],
                "network_role": info["network_role"],
                "detail_profile": info["detail_profile"],
                **check,
                "apple_zoom": zoom,
                "apple_map_url": apple_url(check["longitude"], check["latitude"], zoom),
                "nearby_reference_files_json": json.dumps(references, ensure_ascii=False),
                "capture_status": "pending_dedicated_capture",
                "project_overlay_status": "pending",
                "visual_review_status": "pending",
                "issue_status": "not_reviewed",
                "review_notes": "",
                "fix_commit": "",
            })
        apple_line_rows.append({
            "line_id": line["id"],
            "logical_line_id": info["logical_line_id"],
            "operator": line["operator"],
            "line": line["name"],
            "shape_class": info["shape_class"],
            "network_role": info["network_role"],
            "detail_profile": info["detail_profile"],
            "station_checkpoints": len(line["stations"]),
            "segment_checkpoints": len(line["segments"]),
            "line_shape_checkpoints": 1,
            "total_checkpoints": len(line_checks),
            "completed_checkpoints": 0,
            "completion_percent": 0,
            "nearby_reference_files_json": json.dumps(references, ensure_ascii=False),
            "reference_sample_status": "sample_exists" if references else "no_sample",
            "dedicated_capture_status": "pending",
            "project_overlay_status": "pending",
            "full_line_apple_comparison_status": "not_started",
            "notes": "现有样图不计作项目几何通过；须完成该线全部车站、区间和形状检查点。",
        })
    write_csv(apple_output / "line-coverage.csv", apple_line_rows)
    write_csv(apple_output / "check-queue.csv", apple_check_rows)
    (apple_output / "README.md").write_text(
        "# Apple Maps逐项比对队列\n\n"
        "`index.csv`仅登记现有Apple Maps参考截图及人工观察；这些截图没有叠加项目输出，"
        "因此不能作为几何验收通过证据。\n\n"
        "`line-coverage.csv`覆盖资料包内每条显示线路。`check-queue.csv`为每条线路生成1个线路形状、"
        "每个车站1个锚点、每个相邻站区间1个几何检查点。短线/路面电车、都市线和长线使用不同缩放，"
        "每行包含可复现的Apple Map Link。只有保存Apple截图与项目同范围截图/叠加图、记录人工结论，"
        "并在需要时填写修复提交后，才可把状态改为完成。\n\n"
        "检查字段覆盖：断线、错误拐点、错位、车站在线位置、不同公司站点身份、连接线路、线路文字、"
        "平行线路、支线汇入、闭环/折返/回转，以及多轨多月台车站的顺直进站选择。\n",
        encoding="utf-8",
    )

    stats = {
        "display_lines": len(line_records),
        "logical_line_groups": len(logical_rows),
        "operator_stations": len(station_rows),
        "station_line_points": len(station_line_rows),
        "directed_rail_connections": len(connections),
        "directed_interchanges": len(interchanges),
        "official_exact_line_hex": sum(bool(row["official_line_color_hex"]) for row in line_records),
        "continuous_lines": sum(row["connectivity_status"] == "continuous" for row in line_records),
        "validation_errors": validation_errors,
        "open_rebuild_issues": sum(row["status"] == "open" for row in rebuild_issue_rows(country)),
        "apple_reference_samples": sum(row["present"] for row in apple_rows),
        "apple_line_coverage_rows": len(apple_line_rows),
        "apple_checkpoints": len(apple_check_rows),
        "apple_completed_checkpoints": 0,
        "full_apple_tile_audit_complete": False,
    }
    readme = f"""# {country} 铁路网络重建审计资料包

本目录按与日本相同的目标整理：线路形状和主/支线角色、公司级车站身份、逐站连接、跨公司换乘、车站样式及颜色来源等级。

- 显示线路：**{stats['display_lines']}**
- 逻辑线路组：**{stats['logical_line_groups']}**
- 公司级车站：**{stats['operator_stations']}**
- 车站×线路渲染锚点：**{stats['station_line_points']}**
- 有向铁路连接：**{stats['directed_rail_connections']}**
- 跨公司换乘关系：**{stats['directed_interchanges']}**
- 连续线路：**{stats['continuous_lines']} / {stats['display_lines']}**
- 官方精确线路 HEX：**{stats['official_exact_line_hex']}**

`lines/line-classification.csv` 每个显示线路一行；`lines/logical-line-groups.csv` 把同一官方线路的主干与支线组合起来。`stations/` 保存逐站关系；`colours/` 区分官方精确HEX、官方地图取色和企业色回退；`evidence/` 保存源包与来源说明。

`evidence/current-operation-coverage.csv` 将资料包与当前官方运营状态分开核对；`issues/rebuild-issues.csv` 是后续重建的阻塞问题表。Apple Maps现有参考仅 **{stats['apple_reference_samples']}** 张抽样图，已纳入 `evidence/apple-maps-reference/`；逐线清单覆盖 **{stats['apple_line_coverage_rows']}** 条显示线路，共 **{stats['apple_checkpoints']}** 个线路形状/车站/区间检查点，当前完成 **{stats['apple_completed_checkpoints']}** 个，全境逐项状态仍为 **未完成**。

车站身份为 `运营公司 + 官方物理站组`。铁路邻接与跨公司换乘分开保存。`station_style` 是主要渲染样式，完整复合语义在 `station_style_tags_json`。站群经纬度只是检索中心，不可直接画点；渲染必须使用 `stations/station-line-points.csv` 中逐线路的线上锚点。

几何权威：`{geometry_authority}`。台湾线路几何经过官方源20米阈值校验；香港站序和服务拓扑来自官方资料，但轨道中心线来自OSM，不能标成官方测量几何。
"""
    (output / "README.md").write_text(readme, encoding="utf-8")

    files = []
    for path in sorted(
        p for p in output.rglob("*")
        if p.is_file() and p.name != "MANIFEST.json" and not p.name.startswith(".")
    ):
        files.append({
            "path": str(path.relative_to(output)),
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    manifest = {"schema_version": 1, "country": country, "stats": stats, "files": files}
    (output / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("country", choices=("TW", "HK"))
    parser.add_argument("--package", type=Path)
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    slug = args.country.lower()
    package = args.package or APP_ROOT / f"public/rail/{slug}-2025.json"
    sources = args.sources or APP_ROOT / f"public/rail/{slug}-2025.sources.md"
    output = args.output or APP_ROOT / f"data/raw/railway/{slug}/rebuild-inventory"
    result = audit(args.country, package, sources, output)
    print(json.dumps({"output": str(output.resolve()), "stats": result["stats"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
