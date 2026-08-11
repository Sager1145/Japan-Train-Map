"""Shared planar geometry for the rail-package build scripts.

Every function here was previously copy-pasted across the Hong Kong, Macao
and Japan builders — the same `chaikin`/`despike`/`metres` grooming pipeline
implemented two or three times, which is how a fix to one region's alignment
quietly failed to reach the others. The bodies below are the verbatim shared
implementations; extracting them was a behaviour-preserving move, not a
rewrite.

DELIBERATELY NOT HERE — two look-alikes that are NOT interchangeable:

  * `rebuild-japan-package-geometry.py` keeps its own `polyline_km`. It sums
    unrounded segment lengths and rounds once at the end; the Hong Kong and
    Macao packages round every segment to 3 decimals and then sum. The two
    disagree in the last decimal on long lines, and the committed packages
    were generated with their respective versions. Unifying them would
    silently rewrite shipped mileage.
  * `write_json` lives in `railpkg` (atomic + reproducible .gz sidecar).
    It is IO, not geometry.

All coordinates are [lon, lat] degree pairs. Distances are metres unless the
name says km. The planar approximation (111_320 m/deg, longitude scaled by
cos(lat)) is accurate enough at city scale and is what the shipped packages
were built with.
"""

from __future__ import annotations

import math

# Display-grooming thresholds shared by the Hong Kong and Macao alignment
# builders. Hong Kong named them; Macao inlined the same numbers.
SPIKE_TURN_DEGREES = 55.0
SPIKE_EDGE_METERS = 30.0
REVERSAL_TURN_DEGREES = 150.0

# Length of the short stub drawn from a station along its segment, shared by
# the Hong Kong and Macao package builders.
STATION_STUB_METERS = 180.0


def metres(a, b):
    latitude = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111_320 * math.cos(latitude), (a[1] - b[1]) * 111_320)


def turn_degrees(a, b, c):
    v1 = (b[0] - a[0], b[1] - a[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    l1 = math.hypot(*v1)
    l2 = math.hypot(*v2)
    if l1 == 0 or l2 == 0:
        return 0.0
    cosine = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


def point_segment_metres(point, start, end):
    latitude = math.radians(point[1])
    scale_x = 111_320 * math.cos(latitude)
    ax, ay = (start[0] - point[0]) * scale_x, (start[1] - point[1]) * 111_320
    bx, by = (end[0] - point[0]) * scale_x, (end[1] - point[1]) * 111_320
    dx, dy = bx - ax, by - ay
    if dx == dy == 0:
        return math.hypot(ax, ay)
    ratio = max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + ratio * dx, ay + ratio * dy)


def haversine_km(a: list[float], b: list[float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return round(6371.0088 * 2 * math.asin(math.sqrt(h)), 3)


def polyline_km(points: list[list[float]]) -> float:
    """Hong Kong / Macao convention: round each segment, then sum.

    See the module docstring — Japan's builder rounds only the total.
    """
    return round(sum(haversine_km(a, b) for a, b in zip(points, points[1:])), 3)


def dedupe(points):
    """Drop consecutive duplicate vertices."""
    result = [points[0]]
    for point in points[1:]:
        if point != result[-1]:
            result.append(point)
    return result


def chaikin(points, iterations=2):
    """Chaikin corner-cutting smoothing."""
    for _ in range(iterations):
        if len(points) < 3:
            return points
        result = [points[0]]
        for a, b in zip(points, points[1:]):
            result.append([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25])
            result.append([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
        result.append(points[-1])
        points = result
    return points


def simplify(points, tolerance=5):
    """Douglas-Peucker decimation with a metre tolerance."""
    if len(points) <= 2:
        return points
    start, end = points[0], points[-1]
    index, maximum = 0, 0.0
    for candidate in range(1, len(points) - 1):
        distance = point_segment_metres(points[candidate], start, end)
        if distance > maximum:
            index, maximum = candidate, distance
    if maximum <= tolerance:
        return [start, end]
    return simplify(points[: index + 1], tolerance)[:-1] + simplify(points[index:], tolerance)


def despike(
    points,
    *,
    spike_turn=SPIKE_TURN_DEGREES,
    spike_edge=SPIKE_EDGE_METERS,
    reversal_turn=REVERSAL_TURN_DEGREES,
):
    """Remove micro-spikes and reversal artifacts until stable."""
    changed = True
    while changed and len(points) > 2:
        changed = False
        result = [points[0]]
        index = 1
        while index < len(points) - 1:
            a, b, c = result[-1], points[index], points[index + 1]
            turn = turn_degrees(a, b, c)
            short_edge = metres(a, b) < spike_edge or metres(b, c) < spike_edge
            if turn > reversal_turn or (turn > spike_turn and short_edge):
                changed = True
                index += 1
                continue
            result.append(b)
            index += 1
        result.append(points[-1])
        points = result
    return points


def point_at(route, measures, target):
    """Interpolate the coordinate at `target` along a measured polyline."""
    target = max(0, min(measures[-1], target))
    for index in range(len(measures) - 1):
        if measures[index + 1] >= target:
            span = measures[index + 1] - measures[index]
            ratio = 0 if span == 0 else (target - measures[index]) / span
            return [
                route[index][0] + ratio * (route[index + 1][0] - route[index][0]),
                route[index][1] + ratio * (route[index + 1][1] - route[index][1]),
            ]
    return route[-1]


def route_measures(route):
    # Cumulative METERS along the polyline.
    measures = [0.0]
    for a, b in zip(route, route[1:]):
        measures.append(measures[-1] + haversine_km(a, b) * 1000)
    return measures


def route_slice(route, measures, start, end):
    result = [point_at(route, measures, start)]
    result.extend(route[index] for index in range(1, len(route) - 1) if start < measures[index] < end)
    result.append(point_at(route, measures, end))
    deduped = [result[0]]
    for point in result[1:]:
        if point != deduped[-1]:
            deduped.append(point)
    return deduped


def split_route(route, station_points, *, loop=False):
    """Cut a route into per-station segments, choosing the better orientation.

    Contract relied on by the packages: segment i runs station i -> station
    i+1 (mod n for loop lines), with shared endpoints.
    """
    candidates = []
    for oriented in (route, list(reversed(route))):
        measures = route_measures(oriented)
        projected = [project_to_route(point, oriented, measures) for point in station_points]
        if loop:
            start = projected[0][1]
            rotated = route_slice(oriented, measures, start, measures[-1])
            tail = route_slice(oriented, measures, 0, start)
            rotated.extend(tail[1:])
            oriented, measures = rotated, route_measures(rotated)
            projected = [project_to_route(point, oriented, measures) for point in station_points]
            projected[0] = (projected[0][0], 0.0, oriented[0])
        ordered = list(projected)
        for index in range(len(ordered) - 2, -1, -1):
            if ordered[index][1] > ordered[index + 1][1]:
                minimum_gap = min(50, haversine_km(station_points[index], station_points[index + 1]) * 250)
                ordered[index] = project_to_route(station_points[index], oriented, measures, max_measure=ordered[index + 1][1] - minimum_gap)
        for index in range(1, len(ordered)):
            if ordered[index][1] < ordered[index - 1][1]:
                ordered[index] = project_to_route(station_points[index], oriented, measures, min_measure=ordered[index - 1][1])
        fit_penalty = sum(item[0] for item in ordered)
        endpoint_penalty = ordered[0][0] + ordered[-1][0]
        candidates.append((fit_penalty, endpoint_penalty, oriented, measures, ordered))
    _, _, route, measures, projected = min(candidates, key=lambda item: (item[0], item[1]))
    station_coordinates = [item[2] for item in projected]
    segment_count = len(station_points) if loop else len(station_points) - 1
    segments = []
    for index in range(segment_count):
        start = projected[index][1]
        end = measures[-1] if loop and index == len(station_points) - 1 else projected[index + 1][1]
        segments.append(route_slice(route, measures, start, end))
    return station_coordinates, segments


def station_stub(segment_coords: list, stub_metres: float = STATION_STUB_METERS) -> list:
    measures = route_measures(segment_coords)
    limit = min(stub_metres, measures[-1])
    if limit <= 0:
        return [segment_coords[0], segment_coords[-1]]
    return route_slice(segment_coords, measures, 0.0, limit)


def project_to_route(point, route, measures, min_measure=0.0, max_measure=float("inf")):
    """Nearest point on a measured polyline -> (distance_m, measure, coordinate)."""
    best = (float("inf"), 0.0, route[0])
    latitude = math.radians(point[1])
    scale_x = 111_320 * math.cos(latitude)
    for index, (start, end) in enumerate(zip(route, route[1:])):
        if measures[index + 1] + 1e-6 < min_measure or measures[index] - 1e-6 > max_measure:
            continue
        ax, ay = (start[0] - point[0]) * scale_x, (start[1] - point[1]) * 111_320
        bx, by = (end[0] - point[0]) * scale_x, (end[1] - point[1]) * 111_320
        dx, dy = bx - ax, by - ay
        lower = 0 if measures[index + 1] == measures[index] else max(0, (min_measure - measures[index]) / (measures[index + 1] - measures[index]))
        upper = 1 if measures[index + 1] == measures[index] else min(1, (max_measure - measures[index]) / (measures[index + 1] - measures[index]))
        ratio = lower if dx == dy == 0 else max(lower, min(upper, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        distance = math.hypot(ax + ratio * dx, ay + ratio * dy)
        projected = [start[0] + ratio * (end[0] - start[0]), start[1] + ratio * (end[1] - start[1])]
        measure = measures[index] + ratio * (measures[index + 1] - measures[index])
        if distance < best[0]:
            best = (distance, measure, projected)
    return best
