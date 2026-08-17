#!/usr/bin/env python3
"""Build the Japan display package from the AUDITED rebuild inventory + N02 geometry.

Why this exists, and why it is not `n02/build_package.py`
---------------------------------------------------------
Japan is the one country whose ORIGINAL source is still archived: N02-25_GML.zip
sits in data/raw/railway/jp/. So unlike hk and tw — whose builders needed
downloads nobody kept — Japan can be rebuilt from the survey itself.

What it cannot be rebuilt from is `scripts/railway/n02/`. Those six modules are a
library with no driver, and they emit `compact-v2`: lane displacement baked into
each vertex, station rows of nine fields, structure rows that lead with a segment
index. The shipped package is `compact-v1` — six-field station rows, a separate
`lanes[]` table recomputed by build-parallel-corridors.mjs, structure rows that
lead with a metre measure. Running the v2 emitter and then finalize-japan-package
would read a segment index as a metre offset. They are two different formats and
only one of them is what the renderer and the other four countries read.

So this driver reuses n02_source.py for the ONE thing it is authoritative about —
parsing the Shift-JIS shapefiles correctly — and takes everything else from the
2026-08-13 audit inventory, which is where the corrections live.

What comes from where
---------------------
    geometry           N02-25_GML.zip RailroadSection, per (line, operator)
    station anchors    N02 Station platform polyline, along-line midpoint,
                       projected onto that line's own track
    station order      rebuild-inventory/stations/n02-station-connections.csv
                       (the corrected, directed adjacency graph)
    station identity   rebuild-inventory/stations/n02-station-network.json
    kind / colour      rebuild-inventory/lines/n02-line-shape-classification.csv
    English names      osm/osm-station-names.json (ODbL, keyed by N02_005g)
    rank / nameRoma /  carried by (operator, name) from the archived pre-rebuild
    logo               package — curated display attributes validated elsewhere
                       (the 2026-08-10 logo audit reviewed all 594 of them), so
                       re-deriving them would throw that review away

Interval geometry is cut as a SHORTEST PATH THROUGH THE LINE'S OWN TRACK between
two station anchors, not by slicing one stitched centre-line. A Japanese railway
is not always one polyline: 596 canonical lines hold branches, rejoins, loops and
switchbacks, and stitching them into a single route to slice would have to invent
an order the survey does not state. Cutting per interval asks the graph a
question it can answer, and the answer is checkable — every interval's length is
compared against the audited `distance_km` for the same pair.

What this refuses to do
-----------------------
A line whose corrected adjacency graph is not a simple chain or a simple ring is
SKIPPED with the graph facts that made it one (terminal count, junction count,
component count). compact-v1 stores an ordered list of DISTINCT stations; a
branched or disconnected line needs a decision about which path is the drawn one,
and that decision belongs to the session that owns the line, with its own
evidence, not to a default inside a builder.

Output is a staging package. public/rail/jp-2025.json is only ever written by
scripts/railway/promote-lines.mjs, one session's lines at a time.

Usage:
  python3 app/scripts/railway/build-japan-package-from-inventory.py
  python3 app/scripts/railway/build-japan-package-from-inventory.py --session 16
  python3 app/scripts/railway/build-japan-package-from-inventory.py \
      --lines '東海旅客鉄道␟東海道新幹線'
"""

from __future__ import annotations

import argparse
import collections
import csv
import gzip
import heapq
import importlib.util
import json
import math
import re
import sys
import tempfile
import zipfile
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = APP_DIR.parent
RAW = APP_DIR / "data" / "raw" / "railway" / "jp"
INVENTORY = RAW / "rebuild-inventory"
STAGING_DIR = APP_DIR / "data" / "staging"
BATCH_TABLE = REPO_ROOT / "RAILWAY_REBUILD_BATCHES.csv"

# The staging package carries the PUBLISHED package's version, not a new one.
# promote-lines.mjs upserts lines and leaves the target's metadata alone, so a
# version invented here would never reach anyone — it would only sit in staging
# claiming a release that does not exist. The rebuild's version bump is one
# deliberate act at S66, where `japan-rail-continuity` and
# `railway-display-curve` update the assertions that pin it.
PUBLISHED = APP_DIR / "public" / "rail" / "jp-2025.json"
PACKAGE_VERSION = (
    json.loads(PUBLISHED.read_text("utf-8")).get("version", "2025.4.2")
    if PUBLISHED.exists()
    else "2025.4.2"
)
GENERATED_AT = "2026-08-14T00:00:00.000Z"

# The batch table writes canonical jp keys as `operator␟line` (U+241F, the
# visible symbol for UNIT SEPARATOR); U+001F is accepted too. Same rule as
# scripts/railway/lib/rebuild-batches.mjs.
CANONICAL_SEPARATORS = ("␟", "")

# N02 files these two under their corporate names; every passenger-facing
# surface uses the brand. Same pairs as finalize-japan-package.mjs.
OPERATOR_ALIASES = {"東京地下鉄": "東京メトロ", "大阪市高速電気軌道": "Osaka Metro"}

# Node identity for the track graph: N02's own ordinate precision. Deeper and
# real junctions stop being shared nodes; shallower and separate tracks merge.
NODE_DP = 5

# An interval whose cut length disagrees with the audited distance by more than
# the tolerance is reported. The check exists to catch a path that went the wrong
# way, so the tolerance has to absorb the one difference that is EXPECTED and
# systematic: the audit measures node to node on its contracted graph, this cuts
# platform midpoint to platform midpoint. Those differ by up to about half a
# platform at each end, which is why the allowance below adds the two platforms'
# own lengths rather than a tuned constant — on the shinkansen that is ~200 m of
# real, explainable difference, and on a 1.5 km urban interval a flat 3 % would
# have flagged it as a defect. Measured on all four S16 mismatches, the cut sits
# CLOSER to the official kilometrage than the audited distance does.
LENGTH_TOLERANCE_M = 60.0
LENGTH_TOLERANCE_FRACTION = 0.03

# How far a station may sit from the track group its line runs on before it
# counts as not being on it at all. A platform is tens of metres from its own
# centre-line and a wrongly chosen parallel track is a few hundred; a station
# that belongs to a different piece of railway entirely is kilometres away.
ANCHOR_MAX_M = 1500.0

# Beyond this, the cut did not take a slightly different track — it went
# somewhere else. N02 files several physical tracks under one line key (東北線
# carries the 京浜東北, 山手, 宇都宮 and freight alignments), they meet at
# junctions, and the shortest path between two adjacent stations can therefore
# leave the alignment the service uses: 大宮 → 北与野 came out at 32.6 km
# against an audited 1.572 km and a straight-line 1.763 km.
#
# A part with such an interval is REFUSED rather than noted. A note leaves a
# 32 km stroke on the map where 1.6 km of railway is, and a wrong line drawn is
# worse than a line not yet drawn. Which of the parallel tracks a line should be
# drawn on is a real modelling decision — display rules §7.2, and the very
# question the session plan assigns to J03 — not something a builder may pick.
GROSS_DETOUR_FACTOR = 3.0
GROSS_DETOUR_FLOOR_M = 2000.0

# A loop line has more than three stations. Three mutually adjacent stations mean
# one of those edges skips the station between the other two — a survey error of
# the same kind the 2026-08-13 audit deleted twelve of, not a loop to draw.
MIN_RING_STATIONS = 4

# How badly a station's own anchor has to disagree with the measured
# kilometrage before another of its platforms may be tried instead. Small
# disagreements are normal — the audit measures a route, this draws track — and
# trading them for a moved station is a bad bargain. 上越線 is not a close call:
# 7.529 km drawn against an audited 3.493.
ANCHOR_AUDIT_SLACK_M = 1000.0

# A second alignment runs roughly where the first does. Below the floor it is a
# short cut-off rather than the other direction's track; above the ceiling the
# search has gone the long way round the network instead.
ALTERNATE_MIN_RATIO = 0.25
ALTERNATE_MAX_RATIO = 4.0
ALTERNATE_TOLERANCE = 0.25

# How far apart two alignments must get before they are a directional split
# rather than double track. Measured segment to segment (see max_separation_m —
# the vertex-to-vertex version inflated every tunnel pair). Known distances:
#
#   中央本線 笹子 / 新笹子      25 m   twin bores, ordinary double track
#   北陸本線 倶利伽羅          40 m   twin bores of the SAME tunnel
#   日本海ひすいライン 新子不知  124 m   a real 別線: 上り built inland, 下り the old coast line
#   上越線 清水 / 新清水      840 m   the flagship case
#
# 100 m sits between the widest twin-bore pair and the narrowest real 別線. It
# is only a pre-filter: nothing is drawn as a pair without a source either way.
SEPARATED_MIN_M = 100.0

# A separated alignment has two ends, and both have to be closed. The far end
# closes on the rejoin station's shared platform. The near end has no station to
# close on — the two bores part company somewhere BETWEEN stations — so the
# stroke has to be walked back along its own track until it reaches the primary.
# Without this the up stroke simply stopped at its platform: at 湯檜曽 that left
# it 71 m from the down line with nothing joining them, which reads on the map
# as a branch dangling in mid-air. OSM puts the real convergence 117 m south of
# the up platform, at the 新清水トンネル portal.
# A separated run therefore spans SHARED STATION to SHARED STATION. The far end
# already closed on the rejoin station; the near end has to reach back to the
# last station both bores share, because the bores part company BETWEEN
# stations and compact-v1 has no slot for track before a line's first station.
# Left unclosed, the up stroke stopped at its platform 71 m from the down line
# with nothing joining them — a branch dangling in mid-air.

# ...and how far apart they can get and still be the same railway's two tracks.
# Cutting an interval and re-asking the graph finds SOME route on a dense
# network: 函館線 answers 東森–駒ヶ岳 with the 砂原 route 13 km away, and 上越線
# answers with a 24 km loop through the neighbouring valley. Those are other
# routes, not this interval's other track.
#
# 3 km rather than 2, because the widest real one clears 2.5: 東海道本線's 下り
# takes the 新垂井線 from 南荒尾信号場 to 関ケ原, 2.7 km off the 垂井 alignment
# the 上り keeps — far enough that 新垂井駅 served down trains at a place no up
# train passed. A bound under that would cut the best case in the country.
SEPARATED_MAX_M = 3000.0

ROMA_SOURCE_OSM = 1

RANK_BY_KIND = {
    "shinkansen": 0,
    "jr_conventional": 3,
    "private": 3,
    "third_sector": 3,
    "subway": 2,
    "monorail": 2,
    "agt": 3,
    "maglev": 3,
    "funicular": 4,
    "tram": 4,
}


# ------------------------------------------------------------------ helpers


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def normalised(value: str) -> str:
    import unicodedata

    return re.sub(r"[\s　]", "", unicodedata.normalize("NFKC", value or ""))


def identity_key(operator: str, name: str) -> str:
    brand = OPERATOR_ALIASES.get(operator, operator)
    return f"{normalised(brand)} {normalised(name)}"


def split_canonical(key: str):
    for separator in CANONICAL_SEPARATORS:
        at = key.find(separator)
        if at >= 0:
            return key[:at], key[at + len(separator) :]
    return None


def line_id_for(operator: str, line: str) -> str:
    """`jp-<N02 operator>-<line>` — the ID keeps the CORPORATE name.

    The brand belongs in the `operator` FIELD, which is what the reader sees;
    the id is persisted identity that ridden routes, the check queue and the
    batch table all reference. The archived package proves which way round it
    goes: `jp-東京地下鉄-3号線銀座線` with `"operator": "東京メトロ"`. Aliasing
    the id instead renamed 東京メトロ's and Osaka Metro's lines out from under
    everything that points at them.
    """
    return f"jp-{operator}-{line}"


def nkey(point):
    return (round(point[0], NODE_DP), round(point[1], NODE_DP))


# ------------------------------------------------------------------ geometry


def extract_n02(destination: Path) -> Path:
    """Unpack only the Shift-JIS layer; the UTF-8 twin is rounded and mojibaked."""
    archive = RAW / "N02-25_GML.zip"
    with zipfile.ZipFile(archive) as bundle:
        members = [
            name
            for name in bundle.namelist()
            if "/Shift-JIS/" in name and not name.endswith("/")
        ]
        bundle.extractall(destination, members=members)
    return destination / "N02-25_GML"


class TrackGraph:
    """One railway's own track, as a graph its stations can be routed over.

    Nodes are section endpoints at NODE_DP; edges are whole N02 sections. A
    station anchor is a position ALONG one section, so a path between two
    anchors is a partial section, a run of whole sections, and another partial
    section — which is exactly one station interval.
    """

    def __init__(self, sections, indices, geometry_lib):
        self.sections = sections
        self.geometry_lib = geometry_lib
        self.indices = []
        seen_geometry = set()
        for index in sorted(indices):
            key = sections[index].geom_key
            if key in seen_geometry:
                continue
            seen_geometry.add(key)
            self.indices.append(index)
        self.measures = {
            index: geometry_lib.route_measures(
                [list(point) for point in sections[index].coords]
            )
            for index in self.indices
        }
        self.adjacency = collections.defaultdict(list)
        for index in self.indices:
            coords = sections[index].coords
            a, b = nkey(coords[0]), nkey(coords[-1])
            self.adjacency[a].append((b, index))
            if a != b:
                self.adjacency[b].append((a, index))
        # Bounding box per section, so projecting a platform does not have to
        # measure against every vertex of a 400-section railway. A line like the
        # Tokaido main line has ~10^5 vertices and ~10^2 platforms; without this
        # the projection alone is the whole build's runtime.
        self.boxes = {}
        for index in self.indices:
            xs = [point[0] for point in sections[index].coords]
            ys = [point[1] for point in sections[index].coords]
            self.boxes[index] = (min(xs), min(ys), max(xs), max(ys))
        self.component = self._components()

    def _components(self):
        """section index -> id of the connected track group it belongs to.

        A railway's N02 sections are not always one connected graph: parallel
        up/down tracks are separate features and only meet where the survey has
        them meet, so a station's NEAREST section can belong to a fragment that
        the next station's section cannot be reached from. That is the whole of
        the "no path over this line's own track" failure — the track is there,
        the two anchors just landed on pieces that do not touch.
        """
        parent = {}

        def find(node):
            root = node
            while parent.get(root, root) != root:
                root = parent[root]
            while parent.get(node, node) != node:
                parent[node], node = root, parent[node]
            return root

        for index in self.indices:
            coords = self.sections[index].coords
            a, b = nkey(coords[0]), nkey(coords[-1])
            parent.setdefault(a, a)
            parent.setdefault(b, b)
            parent[find(a)] = find(b)
        return {
            index: find(nkey(self.sections[index].coords[0]))
            for index in self.indices
        }

    def length_m(self, index) -> float:
        return self.measures[index][-1]

    def slice(self, index, start_m, end_m):
        """Sub-polyline of one section between two measures, in travel order."""
        coords = [list(point) for point in self.sections[index].coords]
        measures = self.measures[index]
        low, high = min(start_m, end_m), max(start_m, end_m)
        piece = self.geometry_lib.route_slice(coords, measures, low, high)
        if start_m > end_m:
            piece = list(reversed(piece))
        return [list(point) for point in piece]

    def _box_distance_m(self, index, point):
        """Lower bound on the distance from a point to a section's bounding box."""
        min_x, min_y, max_x, max_y = self.boxes[index]
        scale_x = 111_320 * math.cos(math.radians(point[1]))
        dx = max(0.0, min_x - point[0], point[0] - max_x) * scale_x
        dy = max(0.0, min_y - point[1], point[1] - max_y) * 111_320
        return math.hypot(dx, dy)

    def project(self, point, component=None, exclude=()):
        """Nearest (section, measure, distance_m) over this railway's track.

        `component` restricts the search to one connected track group, which is
        what keeps a station chain on track it can actually be walked along.
        `exclude` bars sections outright, which is how a paired alignment's
        platform is kept off the track the OTHER direction uses — at 湯檜曽 the
        two bores pass within 15 m, so nearest-track alone picks the wrong one.
        """
        candidates = (
            self.indices
            if component is None
            else [index for index in self.indices if self.component[index] == component]
        )
        if exclude:
            candidates = [index for index in candidates if index not in exclude]
        best = None
        ordered = sorted(
            ((self._box_distance_m(index, point), index) for index in candidates),
        )
        for bound, index in ordered:
            # The boxes are sorted by a LOWER bound, so once the bound exceeds
            # the best real distance found, no later section can beat it.
            if best is not None and bound >= best[3]:
                break
            coords = [list(p) for p in self.sections[index].coords]
            measures = self.measures[index]
            distance, measure, projected = self.geometry_lib.project_to_route(
                point, coords, measures
            )
            if best is None or distance < best[3]:
                best = (index, measure, projected, distance)
        if best is None:
            return None
        return {
            "section": best[0],
            "measure_m": best[1],
            "point": [best[2][0], best[2][1]],
            "distance_m": best[3],
        }

    def _dijkstra(self, sources, exclude=()):
        """sources: {node: cost}. Returns cost and predecessor maps."""
        cost = dict(sources)
        previous = {}
        queue = [(value, node) for node, value in sources.items()]
        heapq.heapify(queue)
        while queue:
            here, node = heapq.heappop(queue)
            if here > cost.get(node, math.inf):
                continue
            for other, index in self.adjacency[node]:
                if index in exclude:
                    continue
                step = here + self.length_m(index)
                if step < cost.get(other, math.inf) - 1e-9:
                    cost[other] = step
                    previous[other] = (node, index)
                    heapq.heappush(queue, (step, other))
        return cost, previous

    def _assemble(self, start, end, walked, head_node, end_node, total):
        """Turn a walked run of sections into (coords, length_m, pieces)."""
        start_coords = self.sections[start["section"]].coords
        end_coords = self.sections[end["section"]].coords
        head_measure = (
            0.0 if nkey(start_coords[0]) == head_node else self.length_m(start["section"])
        )
        coords = self.slice(start["section"], start["measure_m"], head_measure)
        pieces = [(start["section"], start["measure_m"], head_measure)]
        for index, from_node, _to_node in walked:
            piece = [list(point) for point in self.sections[index].coords]
            forward = nkey(piece[0]) == from_node
            if not forward:
                piece = list(reversed(piece))
            span = self.length_m(index)
            pieces.append((index, 0.0, span) if forward else (index, span, 0.0))
            coords = join(coords, piece)
        tail_measure = (
            0.0 if nkey(end_coords[0]) == end_node else self.length_m(end["section"])
        )
        coords = join(coords, self.slice(end["section"], tail_measure, end["measure_m"]))
        pieces.append((end["section"], tail_measure, end["measure_m"]))
        return coords, total, pieces

    def path_matching(self, start, end, target_m, budget=60000):
        """The path whose length best matches the distance the audit states.

        Where several physical tracks share one N02 key — 東北線 carrying the
        京浜東北, 山手 and freight alignments, 東海道線 through 横浜, 鹿児島線
        through 折尾 — the SHORTEST path between two adjacent stations is often
        not the one the service runs on. Taking it drew 大阪 → 福島 at 8.4 km
        where the operator's own kilometrage says 0.683.

        Which track a service uses is not this builder's call, but it is not an
        open question either: the audit STATES the distance, and among the
        routes the track graph offers, the one that matches it is the one the
        operator measured. So this searches for that path instead of the
        shortest, and the caller still checks the result against the same
        tolerance — a match that is not close enough is refused as before.

        The walk is bounded by the target, which keeps it small: these are
        adjacent stations, so the target is a kilometre or two.
        """
        if start["section"] == end["section"]:
            return None
        limit = target_m * 2.0 + 1000.0
        start_coords = self.sections[start["section"]].coords
        end_coords = self.sections[end["section"]].coords
        end_ends = {
            nkey(end_coords[0]): end["measure_m"],
            nkey(end_coords[-1]): self.length_m(end["section"]) - end["measure_m"],
        }
        best = None
        seen = 0
        for head_node, head_len in (
            (nkey(start_coords[0]), start["measure_m"]),
            (nkey(start_coords[-1]), self.length_m(start["section"]) - start["measure_m"]),
        ):
            stack = [(head_node, head_len, (), frozenset((head_node,)))]
            while stack and seen < budget:
                seen += 1
                node, length, walked, visited = stack.pop()
                if node in end_ends and walked:
                    total = length + end_ends[node]
                    if best is None or abs(total - target_m) < abs(best[0] - target_m):
                        best = (total, walked, head_node, node)
                if length > limit:
                    continue
                for other, index in self.adjacency[node]:
                    if other in visited:
                        continue
                    stack.append(
                        (
                            other,
                            length + self.length_m(index),
                            walked + ((index, node, other),),
                            visited | {other},
                        )
                    )
        if best is None:
            return None
        total, walked, head_node, end_node = best
        return self._assemble(start, end, list(walked), head_node, end_node, total)

    def path_between(self, start, end, exclude=()):
        """Track between two anchors. Returns (coords, length_m, pieces) or None.

        `exclude` bars a set of sections, which is how the SECOND alignment
        between two stations is found: cut the first, then ask the graph for a
        route that reuses none of it.

        Both anchors sit at a measure along a section, so the search runs from
        the two ends of the start section to the two ends of the end section and
        the partial sections are added back at both ends.

        `pieces` is the run of (section, from_m, to_m) the cut traverses, in
        travel order and signed by it — from_m > to_m means the section is
        walked against its own digitised direction. Structure (tunnel, bridge)
        is surveyed against those section measures, so this is what lets a
        tunnel be placed on the drawn line rather than guessed at.
        """
        if start["section"] == end["section"]:
            piece = self.slice(start["section"], start["measure_m"], end["measure_m"])
            return (
                piece,
                abs(end["measure_m"] - start["measure_m"]),
                [(start["section"], start["measure_m"], end["measure_m"])],
            )

        start_coords = self.sections[start["section"]].coords
        end_coords = self.sections[end["section"]].coords
        start_ends = {
            nkey(start_coords[0]): start["measure_m"],
            nkey(start_coords[-1]): self.length_m(start["section"]) - start["measure_m"],
        }
        end_ends = {
            nkey(end_coords[0]): end["measure_m"],
            nkey(end_coords[-1]): self.length_m(end["section"]) - end["measure_m"],
        }
        # The anchors sit ON their sections, so those two can never be excluded
        # — only the track between them can.
        exclude = {index for index in exclude
                   if index not in (start["section"], end["section"])}
        cost, previous = self._dijkstra(start_ends, exclude=exclude)

        best = None
        for node, tail in end_ends.items():
            if node not in cost:
                continue
            total = cost[node] + tail
            if best is None or total < best[0]:
                best = (total, node)
        if best is None:
            return None

        total, node = best
        walked = []
        cursor = node
        while cursor in previous:
            parent, index = previous[cursor]
            walked.append((index, parent, cursor))
            cursor = parent
        walked.reverse()
        return self._assemble(start, end, walked, cursor, node, total)


def join(coords, piece):
    if not coords:
        return list(piece)
    if not piece:
        return coords
    if nkey(coords[-1]) == nkey(piece[0]):
        return coords + piece[1:]
    return coords + piece


def dedupe_points(points):
    out = []
    for point in points:
        if out and abs(out[-1][0] - point[0]) < 1e-12 and abs(out[-1][1] - point[1]) < 1e-12:
            continue
        out.append([point[0], point[1]])
    return out


# ------------------------------------------------------------------ ordering


def station_order(edges, strict=True):
    """(order, is_loop) from the corrected adjacency, or (None, reason).

    `strict` refuses a graph that carries more edges than a path needs. That
    extra edge is a real choice about which way the line runs, and the audit's
    partition is where such choices are recorded — so the caller tries that
    first and only falls back to `strict=False`, which walks the graph anyway
    and says so.
    """
    if not edges:
        return None, "no adjacency rows for this line"

    nodes = {row[0] for row in edges} | {row[1] for row in edges}
    neighbours = collections.defaultdict(set)
    for a, b in edges:
        neighbours[a].add(b)
        neighbours[b].add(a)

    # A ring: every station has exactly two neighbours and they form ONE cycle.
    if len(nodes) >= 3 and all(len(near) == 2 for near in neighbours.values()):
        start = min(nodes)
        order, previous, current = [], None, start
        while True:
            order.append(current)
            forward = [node for node in sorted(neighbours[current]) if node != previous]
            previous, current = current, forward[0]
            if current == start:
                break
        if len(order) != len(nodes):
            return None, "undirected edges form more than one ring"
        return order, True

    # A path has exactly n-1 edges. Counting terminals is not enough: 南武線 has
    # two terminals AND a cycle (30 stations, 30 edges), so the walk below covers
    # every station and looks like a chain — while the order it returns steps
    # 尻手 → 川崎 → 八丁畷, over a real edge, doubling the stroke back on itself.
    # The extra edge means there is a choice to make about which way the line
    # runs, and that choice belongs to the audit's partition, not to a walk.
    if strict and len(edges) != len(nodes) - 1:
        extra = len(edges) - (len(nodes) - 1)
        return None, (
            f"{len(nodes)} stations but {len(edges)} edges — {extra} more than a chain "
            f"({sum(1 for near in neighbours.values() if len(near) > 2)} junction(s))"
        )

    ends = sorted(node for node, near in neighbours.items() if len(near) == 1)
    if len(ends) != 2:
        junctions = sum(1 for near in neighbours.values() if len(near) > 2)
        return None, (
            f"not a simple chain: {len(ends)} terminal(s), {junctions} junction(s), "
            f"{len(nodes)} station(s)"
        )

    # Walk from one terminal, refusing to revisit. "Not the node I came from" is
    # NOT enough to terminate: a chain with two terminals can still carry a cycle
    # somewhere in the middle (宗谷線 does), and a walk that only avoids
    # backtracking rides that cycle round and round — it reported 50 stations on
    # a 35-station line, and on a different cycle it would not have stopped at
    # all. A visited set bounds the walk at n steps, and the count check below
    # then names what the graph really is.
    seen = set()
    order, previous, current = [], None, ends[0]
    while current is not None and current not in seen:
        seen.add(current)
        order.append(current)
        forward = [
            node
            for node in sorted(neighbours[current])
            if node != previous and node not in seen
        ]
        previous, current = current, (forward[0] if forward else None)
    if len(order) != len(nodes):
        cycles = len(edges) - len(nodes) + 1
        return None, (
            f"walked {len(order)} of {len(nodes)} stations — "
            + ("more than one component" if cycles <= 0 else f"{cycles} cycle(s) in the graph")
        )
    return order, False


def partition_by_audit(row, edges, uid_by_name):
    """Split one canonical line into a main path plus its audited branch parts.

    A Japanese railway is frequently not one chain: 函館線 carries the 砂原 route
    that leaves at 大沼 and rejoins at 森, 室蘭線 carries 東室蘭–室蘭, 根室線 has
    been in two pieces since the 富良野–新得 section closed in 2024. compact-v1
    stores ONE ordered list of distinct stations, so each of those has to become
    its own display line.

    WHICH path is the main one is not a question geometry can answer, and it is
    exactly the question the display rules forbid answering with a special case
    per train (`if line == Hokuto`). The 2026-08-13 audit already answered it,
    per line, against the operator's own 営業区間: `main_path` names the through
    route and `branch_parts_json` names every part that leaves it, with the
    stations each part holds. This reads that decision; it does not retake it.

    Returns (parts, reason). `parts` is a list of (suffix, station_uids, is_loop)
    with the main path first, or None when the audit's partition does not leave a
    simple chain behind — in which case the line is skipped, not guessed at.
    """
    raw = row.get("branch_parts_json") or "[]"
    try:
        branch_parts = json.loads(raw)
    except json.JSONDecodeError:
        return None, "branch_parts_json is not readable"
    if not branch_parts:
        return None, "audit records no branch parts to split on"

    neighbours = collections.defaultdict(set)
    for a, b in edges:
        neighbours[a].add(b)
        neighbours[b].add(a)

    branches = []
    undrawable = []
    for part in branch_parts:
        members = [uid_by_name[name] for name in part.get("stations", []) if name in uid_by_name]
        if len(members) < 2:
            # A part with fewer than two stations has no interval to draw. The
            # 石北線 0.2 km stub and the 海峡線 single-station component are real
            # track, but compact-v1 addresses geometry by station pair, so they
            # are reported as uncovered corridor rather than invented.
            undrawable.append(part.get("type", "part"))
            continue
        branches.append((part.get("type", "branch"), set(members)))

    if not branches:
        return None, (
            "every audited branch part holds fewer than two stations "
            f"({', '.join(undrawable)})"
        )

    # Which of a part's stations stay on the through route? The ones the through
    # route PASSES THROUGH — and a station it passes through has two neighbours
    # outside the part, one on each side. A station hanging off the part has at
    # most one, however many neighbours it has in total.
    #
    # "Every neighbour is inside the part" was the first rule here and it is
    # wrong, because the audit's branch station list does not always include the
    # junction: 水郡線's 常陸太田 branch is listed from 南酒出, whose neighbour
    # 上菅谷 is therefore outside it. That kept 南酒出 on the trunk, so the trunk
    # ran out onto the branch and back — 上菅谷 → 南酒出 → 常陸鴻巣 cut 4.9 km
    # over a 2.8 km gap and the topology validator caught it as a 140° branch
    # doubling back.
    interiors = set()
    for _kind, members in branches:
        interiors |= {
            uid for uid in members if len(neighbours[uid] - members) < 2
        }

    main_nodes = {uid for pair in edges for uid in pair} - interiors
    main_edges = sorted(
        pair for pair in edges if pair[0] in main_nodes and pair[1] in main_nodes
    )
    main_order, main_flag = station_order(main_edges)
    if main_order is None:
        return None, f"main path after removing audited branches is still {main_flag}"

    parts = [("", main_order, bool(main_flag))]
    for index, (kind, members) in enumerate(branches, start=2):
        branch_edges = sorted(
            pair for pair in edges if pair[0] in members and pair[1] in members
        )
        order, flag = station_order(branch_edges)
        if order is None:
            return None, f"audited {kind} part is not a simple chain: {flag}"
        parts.append((f"-{index}", order, bool(flag)))
    return parts, (
        f"{len(parts) - 1} audited branch part(s) drawn as sibling display line(s)"
        + (f"; {len(undrawable)} part(s) too short to draw" if undrawable else "")
    )


MAIN_PATH = re.compile(r"^(?P<from>.+?)\s*→\s*(?P<to>.+)$")


def neighbour_map(edges):
    near = collections.defaultdict(set)
    for a, b in edges:
        near[a].add(b)
        near[b].add(a)
    return near


def components(edges):
    """Split an adjacency edge set into its connected pieces, largest first.

    A railway filed as one line is not always one connected thing. 常磐線 and
    鹿児島線 are in two pieces, 信越線 in three — the Shinkansen took the middle
    of each away and the audit records them as `disconnected`. Each piece is one
    continuous stroke, so each is its own display line; nothing is bridged.
    """
    near = neighbour_map(edges)
    seen = set()
    out = []
    for start in sorted(near):
        if start in seen:
            continue
        stack, members = [start], set()
        while stack:
            node = stack.pop()
            if node in members:
                continue
            members.add(node)
            stack.extend(near[node] - members)
        seen |= members
        out.append(sorted(pair for pair in edges if pair[0] in members))
    out.sort(key=lambda part: (-len({u for pair in part for u in pair}), part))
    return out


def cycle_and_tails(edges):
    """Split a component that is one cycle with branches hanging off it.

    A `loop_with_tail` — 大江戸線's 光が丘 tail into its ring, ユーカリが丘線,
    ポートアイランド線, 京王線 — cannot be one ordered list of DISTINCT stations,
    because the service passes its junction twice. So the ring becomes one part
    and each tail another; they share the junction station, which is where the
    two drawn strokes meet.

    Returns (parts, None) or (None, reason). Only a SINGLE cycle is handled: two
    cycles mean a choice about which one the line is, and that is not a choice
    to make here.
    """
    near = {node: set(values) for node, values in neighbour_map(edges).items()}
    degree = {node: len(values) for node, values in near.items()}
    peeled = set()
    changed = True
    while changed:
        changed = False
        for node, count in list(degree.items()):
            if node in peeled or count > 1:
                continue
            peeled.add(node)
            changed = True
            for other in near[node]:
                if other not in peeled:
                    degree[other] -= 1
            degree[node] = 0

    core = {node for node in near if node not in peeled}
    if not core:
        return None, "no cycle to build the loop from"
    core_edges = sorted(pair for pair in edges if pair[0] in core and pair[1] in core)
    ring, ring_flag = station_order(core_edges)
    if ring is None or not ring_flag:
        return None, f"the cycle is not a simple ring ({ring if ring is None else 'open'})"
    if len(ring) < MIN_RING_STATIONS:
        # Three mutually adjacent stations are not a loop line — one of those
        # edges skips the station between the other two. The 2026-08-13 audit
        # deleted twelve such edges as survey errors and this is one it did not
        # reach: 広見線's 明智 / 日本ライン今渡 / 新可児 came out as a "ring",
        # and the stroke drawn round it left 新可児 172 m off its own line.
        # Naming it is useful; drawing it is not, and deleting the edge here
        # would be this builder deciding which of the three is wrong.
        return None, (
            f"the only cycle is {len(ring)} stations — a skip-station edge, not a loop"
        )

    parts = [ring]
    tail_edges = [pair for pair in edges if pair not in set(core_edges)]
    for tail in components(tail_edges):
        order, flag = station_order(tail)
        if order is None:
            return None, f"a tail off the loop is not a simple chain: {flag}"
        parts.append(order)
    return parts, None


# How close a cut has to come to a station to count as running past it. A
# platform is a few hundred metres long and its anchor sits at the middle, so a
# track through the station area can be this far from the anchor and still be
# the same track — 佐世保線's phantom 大塔→三河内 edge passes 334 m from 早岐.
# Two genuinely separate alignments are kilometres apart where they diverge
# (函館線 via 駒ヶ岳 against via 渡島砂原), so this does not reach them.
SKIP_PASSES_M = 400.0


def longest_path(edges, weight):
    """The heaviest leaf-to-leaf path through a component — its trunk."""
    near = neighbour_map(edges)
    if not near:
        return []

    def farthest(start):
        # Visited-guarded, so this is safe on a graph that still carries a
        # cycle: the walk is a spanning tree of it, and the path it reports is
        # a real route over real edges.
        best = (0.0, start)
        stack = [(start, 0.0)]
        parents = {start: None}
        seen = {start}
        while stack:
            node, distance = stack.pop()
            if distance > best[0]:
                best = (distance, node)
            for other in near[node]:
                if other in seen:
                    continue
                seen.add(other)
                parents[other] = node
                stack.append((other, distance + weight(node, other)))
        return best[0], best[1], parents

    _first, far_node, _parents = farthest(next(iter(near)))
    _second, end, parents = farthest(far_node)
    path = [end]
    while parents[path[-1]] is not None:
        path.append(parents[path[-1]])
    return path


def tree_decompose(edges, weight):
    """Split a branched railway into a trunk and the arms hanging off it.

    The trunk is the longest through route; every remaining arm becomes its own
    stroke, keeping the junction station it leaves from, which is where the two
    strokes meet. Every edge is drawn exactly once.

    This runs on graphs that still carry a cycle, and that is deliberate: once
    skip edges are removed, a remaining cycle means the railway really does have
    two alignments between the same pair of stations — 長崎線 via 長与 and via
    市布 — which the audit classifies as `branch_rejoins`. Both are real track
    and both are drawn; the longer way round becomes a rejoining branch rather
    than being dropped.
    """
    remaining = set(edges)
    parts = []
    guard = 0
    while remaining and guard < 200:
        guard += 1
        for piece in components(sorted(remaining)):
            path = longest_path(piece, weight)
            if len(path) < 2:
                remaining -= set(piece)
                continue
            parts.append(path)
            for a, b in zip(path, path[1:]):
                remaining.discard(tuple(sorted((a, b))))
    return parts


def stations_passed_by_cut(graph, points, a, b, others, tolerance_m=SKIP_PASSES_M):
    """Stations of the same line whose platform the A–B track runs past."""
    start, end = graph.project(points[a]), graph.project(points[b])
    if start is None or end is None:
        return []
    cut = graph.path_between(start, end)
    if cut is None:
        return []
    coords = cut[0]
    passed = []
    for uid in others:
        target = points[uid]
        scale = 111_320 * math.cos(math.radians(target[1]))
        for point in coords:
            dx = (point[0] - target[0]) * scale
            dy = (point[1] - target[1]) * 111_320
            if math.hypot(dx, dy) <= tolerance_m:
                passed.append(uid)
                break
    return passed


def drop_skip_station_edges(edges, passes=None):
    """Remove service edges that run over track the drawn order already covers.

    An express that does not call at 武蔵白石 still runs over the 大川支線's only
    track, and 成田線 files 久住–空港第2ビル between two stations that are nowhere
    near each other in the order. Such an edge adds no track to draw; it only
    adds a cycle that makes the line's order ambiguous, and treating one as a
    second alignment drew a 26 km "branch" between adjacent stations.

    The test is geometric, and deliberately so. The audit's distances cannot
    arbitrate here — around 成田 it files 久住–下総松崎 at 10.556 km for a hop of
    about three — but the track can be cut and asked what it runs past. An edge
    whose own track passes another station OF THE SAME LINE is covering ground
    the hops through that station already cover. A genuine chord, the kind that
    earns its own stroke, passes no station it does not stop at: 函館線's 藤城線
    bypasses 七飯 rather than running through it.

    An edge is only dropped while the rest of the graph still connects its two
    ends, so nothing is ever severed from the line.
    """
    working = list(edges)
    dropped = []
    order = sorted(edges, key=lambda edge: -len(passes(edge[0], edge[1])) if passes else 0)
    for pair in order:
        if passes is None:
            break
        skipped = passes(pair[0], pair[1])
        if not skipped:
            continue
        remaining = [edge for edge in working if edge != pair]
        near = neighbour_map(remaining)
        seen, stack = {pair[0]}, [pair[0]]
        while stack:
            node = stack.pop()
            for other in near[node]:
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        if pair[1] not in seen:
            continue
        working = remaining
        dropped.append((pair, skipped))
    return working, dropped


def plan_parts(
    row, edges, uid_by_name, distances=None, station_by_uid=None, passes=None
):
    """Every drawn stroke this canonical line yields, largest first.

    One ordered list of distinct stations is all compact-v1 can hold, so a
    railway that is more than one stroke has to become more than one display
    line. The order the shapes are tried in matters: the audit's own partition
    outranks anything derived here, because it was decided against the
    operator's route data, and a graph decomposition is only a way of answering
    what the audit did not.

    Returns (parts, note) or (None, reason); parts are (suffix, order, is_loop).
    """
    if not edges:
        # Two stations and no service between them still has exactly one
        # possible order, and this map draws the INFRASTRUCTURE network: the
        # interval is justified by the track, not by a timetable. 海峡線 is the
        # case — its undersea platforms closed in 2014 so the audit records no
        # passenger adjacency, but the tunnel is real and the Shinkansen shares
        # it. Anything else with no adjacency has fewer than two stations, and
        # so no interval to draw at all.
        members = sorted(set(uid_by_name.values()))
        if len(members) == 2:
            return [("", members, False)], (
                "no passenger adjacency — the one interval is drawn from the "
                "track between its two stations"
            )
        return None, "no adjacency rows for this line"

    prefix = []
    if passes is not None:
        edges, dropped = drop_skip_station_edges(edges, passes=passes)
        for (a, b), skipped in dropped:
            name = (lambda uid: station_by_uid[uid]["station_name"]) if station_by_uid else str
            over = (
                name(skipped[0])
                if len(skipped) == 1
                else f"{len(skipped)} stations"
            )
            prefix.append(
                f"{name(a)}–{name(b)} runs past {over} — service edge over track "
                f"the order already draws, not a second alignment"
            )

    pieces = components(edges)
    planned = []
    notes = list(prefix)
    for piece in pieces:
        order, flag = station_order(piece)
        if order is not None:
            planned.append((order, bool(flag)))
            continue
        audited, reason = partition_by_audit(row, piece, uid_by_name)
        if audited is not None:
            planned.extend((part_order, part_loop) for _s, part_order, part_loop in audited)
            notes.append(reason)
            continue
        rings, why = cycle_and_tails(piece)
        if rings is None:
            weight = lambda a, b: (distances or {}).get(tuple(sorted((a, b))), 1.0) or 1.0
            branches = tree_decompose(piece, weight)
            if len(branches) > 1:
                planned.extend((branch, False) for branch in branches)
                cycles = len(piece) - len({u for pair in piece for u in pair}) + 1
                notes.append(
                    f"trunk plus {len(branches) - 1} branch(es) split from the graph"
                    + (f" ({cycles} rejoining route(s))" if cycles > 0 else "")
                )
                continue
        if rings is not None:
            planned.extend((part, len(part) > 2 and part[0] in neighbour_map(piece)[part[-1]]) for part in rings[:1])
            planned.extend((part, False) for part in rings[1:])
            notes.append(f"loop and {len(rings) - 1} tail(s) split from the graph")
            continue
        walked, walk_flag = station_order(piece, strict=False)
        if walked is None:
            return None, f"{flag}; {reason}; {why}"
        planned.append((walked, bool(walk_flag)))
        notes.append(f"no audited partition ({reason}) — order walked from the graph")

    if len(pieces) > 1:
        notes.append(f"{len(pieces)} disconnected piece(s) drawn as separate display lines")

    planned.sort(key=lambda item: -len(item[0]))
    parts = [
        ("" if index == 0 else f"-{index + 1}", order, is_loop)
        for index, (order, is_loop) in enumerate(planned)
    ]
    return parts, "; ".join(notes)


def orient(order, names, main_path):
    """Point a chain the way the AUDIT states it runs.

    The direction is not cosmetic — every downstream measure (lane sign, ridden
    slices, structure offsets) is stated against it — and geometry cannot settle
    it, because a chain reversed end to end is the same polyline. The audit's
    `main_path` is a decision already made and recorded, so it is the authority;
    a line whose main_path does not name both ends keeps the walk's own order.
    """
    if len(order) < 2:
        return order
    match = MAIN_PATH.match(main_path or "")
    if not match:
        return order
    head, tail = names[order[0]], names[order[-1]]
    if head == match.group("from") or tail == match.group("to"):
        return order
    if head == match.group("to") or tail == match.group("from"):
        return list(reversed(order))
    return order


# ------------------------------------------------------------------ build


def carried_display_attributes():
    """rank / nameRoma / logo from the archived package, by (operator, name)."""
    archive = RAW / "packages" / "jp-2025-pre-rebuild-25031fbc.json.gz"
    if not archive.exists():
        return {}
    with gzip.open(archive, "rt", encoding="utf-8") as handle:
        package = json.load(handle)
    carried = {}
    for line in package.get("lines", []):
        key = identity_key(line.get("operator", ""), line.get("name", ""))
        # A canonical line that the old package split into siblings resolves to
        # several entries; the first (longest-lived id) carries the attributes.
        carried.setdefault(
            key,
            {
                "rank": line.get("rank"),
                "nameRoma": line.get("nameRoma"),
                "logo": line.get("logo"),
            },
        )
    return carried


def selected_keys(args) -> set[str] | None:
    if args.lines:
        return {value.strip() for value in args.lines.split(",") if value.strip()}
    if args.session is None:
        return None
    keys = set()
    for row in read_csv(BATCH_TABLE):
        if int(row["session"]) == args.session and row["country"] == "jp":
            keys.add(row["line_id"])
    if not keys:
        raise SystemExit(f"batch table has no jp rows for session {args.session}")
    return keys


def build_lines(
    wanted: set[str] | None,
    n02_root: str = "",
    verbose: bool = False,
    progress: bool = False,
):
    """Every canonical line this builder can express, plus what it refused and why.

    Returned rather than written so the Apple check-queue generator can ask the
    SAME engine where a line and its stations are. A queue built from different
    geometry than the package would send a reviewer to look at a place the
    package never claimed anything about.

    Returns (lines, skipped, notes, context) where context carries the inventory
    tables the caller needs to describe a line the builder could not express.
    """
    sys.path.insert(0, str(APP_DIR / "scripts" / "railway" / "n02"))
    sys.path.insert(0, str(APP_DIR / "scripts" / "railway"))
    n02_source = load_module(APP_DIR / "scripts" / "railway" / "n02" / "n02_source.py", "n02_source")
    geometry_lib = importlib.import_module("lib.geometry")

    with tempfile.TemporaryDirectory(prefix="n02-") as scratch:
        root = Path(n02_root) if n02_root else extract_n02(Path(scratch))
        net = n02_source.load(root, verbose=verbose)

    classification = {
        row["canonical_key"]: row
        for row in read_csv(INVENTORY / "lines" / "n02-line-shape-classification.csv")
    }
    network = json.loads(
        (INVENTORY / "stations" / "n02-station-network.json").read_text("utf-8")
    )
    station_by_uid = {row["station_uid"]: row for row in network["stations"]}
    english = {
        row["n02_005g"]: row.get("name_en") or ""
        for row in json.loads((RAW / "osm" / "osm-station-names.json").read_text("utf-8"))
    }
    operator_short = {
        row["operator_n02"]: row.get("short") or row["operator_n02"]
        for row in json.loads((RAW / "colours" / "operator-colours.json").read_text("utf-8"))
    }
    carried = carried_display_attributes()
    structure_by_section = load_structure()
    pair_directions = load_pair_directions()
    pair_geometry = load_pair_geometry()

    # adjacency and per-line membership, keyed the way the batch table is
    adjacency = collections.defaultdict(set)
    audited_distance = {}
    for row in network["connections"]:
        key = f"{row['from_operator']}␟{row['line']}"
        pair = (row["from_station_uid"], row["to_station_uid"])
        adjacency[key].add(tuple(sorted(pair)))
        audited_distance[(key, tuple(sorted(pair)))] = float(row.get("distance_km") or 0)

    members = collections.defaultdict(list)
    for station in network["stations"]:
        for line in station.get("connected_lines", []):
            members[f"{station['operator']}␟{line['line']}"].append(
                station["station_uid"]
            )

    # N02 platform polylines, by (line, operator) and station group
    platforms = collections.defaultdict(dict)
    all_platforms = collections.defaultdict(lambda: collections.defaultdict(list))
    for station in net.stations:
        platforms[station.line_key].setdefault(station.group, station)
        all_platforms[station.line_key][station.group].append(station)

    lines, skipped, notes = [], [], []

    todo = [key for key in sorted(classification) if not wanted or key in wanted]
    for index, key in enumerate(todo, start=1):
        if progress:
            # stderr, flushed, one line per railway: a whole-country run takes
            # minutes and a silent process is indistinguishable from a hung one.
            print(f"[{index}/{len(todo)}] {key}", file=sys.stderr, flush=True)
        parts = split_canonical(key)
        if not parts:
            skipped.append((key, "canonical key has no operator/line separator"))
            continue
        operator, name = parts
        row = classification[key]
        section_indices = net.line_sections.get((name, operator))
        if not section_indices:
            skipped.append((key, "no N02 RailroadSection carries this (line, operator)"))
            continue

        graph = TrackGraph(net.sections, section_indices, geometry_lib)

        uids = members.get(key, [])
        if not uids:
            skipped.append((key, "no station in the audited network belongs to this line"))
            continue

        points = {}
        for uid in uids:
            record = station_by_uid[uid]
            platform = platforms.get((name, operator), {}).get(
                record["physical_station_group"]
            )
            points[uid] = (
                platform_midpoint(platform, geometry_lib)
                if platform is not None
                else [float(record["longitude"]), float(record["latitude"])]
            )

        edges = sorted(adjacency.get(key, set()))
        uid_by_name = {}
        for uid in uids:
            uid_by_name.setdefault(station_by_uid[uid]["station_name"], uid)
        parts, reason = plan_parts(
            row,
            edges,
            uid_by_name,
            distances={
                pair: audited_distance.get((key, pair), 0.0)
                for pair in edges
            },
            station_by_uid=station_by_uid,
            passes=lambda a, b: stations_passed_by_cut(
                graph, points, a, b, [uid for uid in uids if uid not in (a, b)]
            ),
        )
        if parts is None:
            skipped.append((key, reason))
            continue
        if reason:
            notes.append((key, reason))

        drawn_uids = {uid for _suffix, part_order, _loop in parts for uid in part_order}
        unordered = [uid for uid in uids if uid not in drawn_uids]
        if unordered:
            notes.append(
                (key, f"{len(unordered)} station(s) carry no adjacency and are not drawn")
            )

        info = n02_source.classify(
            name, operator, row["railway_class_code"], row["institution_code"]
        )
        display = carried.get(identity_key(operator, name), {})

        # A part whose stations sit on track that does not join up is really
        # several parts; splitting here means the anchoring below never has to
        # strand anything.
        expanded = []
        for suffix, order, is_loop in parts:
            runs = [order] if is_loop else split_by_track_group(order, points, graph)
            if len(runs) > 1:
                notes.append(
                    (
                        f"{key}{suffix}",
                        f"{len(runs)} unconnected track group(s) under one station order "
                        f"— drawn as separate lines",
                    )
                )
            for run in runs:
                expanded.append((suffix, run, is_loop and len(runs) == 1))
        expanded.sort(key=lambda item: -len(item[1]))
        parts = [
            ("" if index == 0 else f"-{index + 1}", run, loop)
            for index, (_old, run, loop) in enumerate(expanded)
            if len(run) >= 2
        ]
        dropped = [run for _s, run, _l in expanded if len(run) < 2]
        for run in dropped:
            notes.append(
                (
                    key,
                    f"{station_by_uid[run[0]]['station_name']} sits alone on its own track "
                    f"group — one station cannot form an interval, so it is not drawn",
                )
            )
        if not parts:
            skipped.append((key, "no part has two stations on connected track"))
            continue

        built_parts = []
        failed_trunk = False
        for suffix, order, is_loop in parts:
            # Anchor PER PART, not per railway. A part is one continuous stroke,
            # so its stations have to sit on one connected track group — and the
            # part's own stations are the ones entitled to choose which. Picking
            # one group for the whole railway breaks the lines that genuinely run
            # on two pieces (根室線 since the 2024 closure), and picking whatever
            # section is nearest each station breaks the lines whose parallel
            # tracks are separate features (東北線 at 日暮里): consecutive
            # stations land on track that never touches, and no interval between
            # them can be cut.
            anchors, stranded, far = anchor_part(
                order, points, graph, platforms.get((name, operator), {}), station_by_uid
            )
            if stranded:
                groups = len(set(graph.component.values()))
                skipped.append(
                    (
                        f"{key}{suffix}",
                        f"{len(stranded)} of {len(order)} station(s) are off the track group "
                        f"carrying the other {len(anchors)} ({groups} group(s) in this line's "
                        f"N02 sections): {stranded[:4]}",
                    )
                )
                if not suffix:
                    failed_trunk = True
                    break
                continue
            if far:
                notes.append(
                    (
                        f"{key}{suffix}",
                        f"{len(far)} station(s) anchored >250 m off their own track: {far[:4]}",
                    )
                )
            if not is_loop:
                order = orient(
                    order,
                    {uid: station_by_uid[uid]["station_name"] for uid in order},
                    row.get("main_path", "") if not suffix else "",
                )
            attempt = build_display_line(
                suffix=suffix,
                order=order,
                is_loop=is_loop,
                key=key,
                name=name,
                operator=operator,
                row=row,
                info=info,
                display=display,
                graph=graph,
                anchors=anchors,
                station_by_uid=station_by_uid,
                audited_distance=audited_distance,
                english=english,
                operator_short=operator_short,
                geometry_lib=geometry_lib,
                normalise_line_name=n02_source.normalise_line_name,
                structure_by_section=structure_by_section,
                platforms_by_group=all_platforms.get((name, operator), {}),
                surveyed=pair_geometry,
            )
            entry, problem, mismatched, alternates = attempt
            if problem and "several tracks share" in problem:
                # The nearest section is not always the track the service runs
                # on. Re-anchor the whole chain against the audited distances
                # and try once more; if that still cannot reproduce them, the
                # refusal below stands.
                refined = refine_anchors_by_distance(
                    order,
                    points,
                    graph,
                    anchors,
                    {
                        pair: (audited_distance.get((key, pair)) or 0) * 1000
                        for pair in adjacency.get(key, set())
                    },
                )
                if refined:
                    entry, problem, mismatched, alternates = build_display_line(
                        suffix=suffix,
                        order=order,
                        is_loop=is_loop,
                        key=key,
                        name=name,
                        operator=operator,
                        row=row,
                        info=info,
                        display=display,
                        graph=graph,
                        anchors=refined,
                        station_by_uid=station_by_uid,
                        audited_distance=audited_distance,
                        english=english,
                        operator_short=operator_short,
                        geometry_lib=geometry_lib,
                        normalise_line_name=n02_source.normalise_line_name,
                        structure_by_section=structure_by_section,
                        surveyed=pair_geometry,
                    )
                    if not problem:
                        notes.append(
                            (
                                f"{key}{suffix}",
                                "anchors re-chosen against the audited distances "
                                "— several tracks share this line's N02 key",
                            )
                        )
            if problem:
                skipped.append((f"{key}{suffix}", problem))
                if not suffix:
                    # The through route failed, so its branches do not get to be
                    # published on their own. A branch drawn without its trunk
                    # tells the reader the branch IS the railway — 函館線's 砂原
                    # route alone would put the main line through 渡島砂原.
                    failed_trunk = True
                    break
                continue
            if mismatched:
                notes.append(
                    (
                        f"{key}{suffix}",
                        f"{len(mismatched)} interval(s) differ from the audited distance: "
                        f"{mismatched[:3]}",
                    )
                )
            built_parts.append(entry)
            # A paired alignment is its OWN stroke with its own platforms — the
            # two bores of 上越線 put 湯檜曽 and 土合 in different places — so it
            # becomes a display line rather than an extra segment welded to the
            # other bore's dot, which would fold the stroke back to reach a
            # platform it does not serve.
            # The two detectors can answer for the same span — 北陸線's loop is
            # both "a second platform at 敦賀" and "another route to 新疋田" — and
            # emitting both would draw the pair twice and consume one evidence
            # row for each. Keep the widest, which is the one that actually
            # leaves the primary alignment.
            widest = {}
            for candidate in alternates:
                span_key = (candidate["uids"][0], candidate["uids"][-1])
                if candidate["separation_m"] > widest.get(
                    span_key, {"separation_m": -1.0}
                )["separation_m"]:
                    widest[span_key] = candidate
            position = 0
            for candidate in widest.values():
                # Geometry can show that a station's two platforms sit far
                # apart; it cannot show that the railway runs its two
                # DIRECTIONS over them. Both candidates rejected here look
                # exactly like 上越線 to a distance test and are neither:
                # 近鉄 大阪上本町's second platform is the underground 難波線
                # level 180 m under the 大阪線, and 新橋's is the 汐留 freight
                # curve, which draws 8.9 km to cross a 1.2 km gap. So a span is
                # only drawn once a source says it really is a directional
                # split — and each rejected one is reported, not dropped.
                sourced = pair_directions.get(
                    (
                        key,
                        station_by_uid[candidate["uids"][0]]["station_name"],
                        station_by_uid[candidate["uids"][-1]]["station_name"],
                    )
                )
                if sourced is None:
                    notes.append(
                        (
                            f"{key}{suffix}",
                            "separate platforms "
                            f"{station_by_uid[candidate['uids'][0]]['station_name']}"
                            f"–{station_by_uid[candidate['uids'][-1]]['station_name']} "
                            f"({candidate['length_m'] / 1000:.2f} km, up to "
                            f"{candidate['separation_m']:.0f} m apart) are not drawn as a "
                            "paired alignment: no source says the two directions split here",
                        )
                    )
                    continue
                position += 1
                alternate = candidate
                paired = dict(entry)
                paired["id"] = f"{entry['id']}-p{position}"
                paired["stations"] = [
                    [
                        station_by_uid[uid]["physical_station_group"],
                        station_by_uid[uid]["station_name"],
                        point[0],
                        point[1],
                        english.get(
                            station_by_uid[uid]["physical_station_group"], ""
                        ),
                        ROMA_SOURCE_OSM,
                    ]
                    for uid, point in zip(alternate["uids"], alternate["points"])
                ]
                # One interval per station pair, same as any other stroke.
                paired["segments"] = split_alternate_segments(
                    alternate,
                    geometry_lib,
                    line_key=key,
                    names=[
                        station_by_uid[uid]["station_name"]
                        for uid in alternate["uids"]
                    ],
                    surveyed=pair_geometry,
                )
                paired.pop("structure", None)
                paired.pop("isLoop", None)
                paired["alignmentOf"] = entry["id"]
                paired["alignmentRole"] = "paired_alignment"
                # Which bore carries 上り and which 下り is a fact about the
                # railway that N02 does not record, so it comes from the
                # evidence file or stays unassigned — never guessed here.
                source_url = sourced.get("source") or sourced["sources"][0]
                paired["alignmentDirection"] = sourced["paired_direction"]
                # Two different claims, two different sources. That the bores
                # exist can be sourced while WHICH carries 上り is not — 上伊集院
                # is stated by ja.wikipedia to run its directions on separate
                # track, but the only statement about which is which is a blog
                # contradicting itself. Recording one source for both would make
                # the map assert a direction nobody stands behind, and the ride
                # importer would then bias every ride onto a guess instead of
                # falling back to geometric fit.
                if paired["alignmentDirection"] == "unassigned":
                    paired["alignmentSplitSource"] = source_url
                else:
                    paired["alignmentSource"] = source_url
                entry.setdefault("alignmentPairs", []).append(
                    {
                        "with": paired["id"],
                        "from": station_by_uid[alternate["uids"][0]]["station_name"],
                        "to": station_by_uid[alternate["uids"][-1]]["station_name"],
                        "direction": sourced["primary_direction"],
                        "source": source_url,
                    }
                )
                built_parts.append(paired)

        if failed_trunk:
            for entry in built_parts:
                skipped.append(
                    (entry["id"], "held back: this railway's through route did not build")
                )
        else:
            lines.extend(built_parts)

    context = {
        "classification": classification,
        "station_by_uid": station_by_uid,
        "members": members,
        "adjacency": adjacency,
    }
    return lines, skipped, notes, context


STRUCTURE_KIND = {"tunnel": 1, "bridge": 2}


def load_pair_directions():
    """Sourced 上り/下り labels for paired alignments, keyed by line and stations.

    N02 says THAT the two directions run on separate track — a second platform
    feature at each end — but carries no direction attribute, so this cannot be
    derived. Every row in the evidence file names a source; a pair with no row
    stays `unassigned` and the importer falls back to geometric fit.
    """
    path = RAW / "evidence" / "paired-alignment-directions.json"
    if not path.exists():
        return {}
    rows = json.loads(path.read_text("utf-8")).get("pairs", [])
    return {
        (row["line"], row["from_station"], row["to_station"]): row for row in rows
    }


def load_pair_geometry():
    """OSM track for the bores of a paired alignment, keyed by line and stations.

    N02-25 carries one coarse centre-line for a second bore. On 上越線's
    湯檜曽ループ it stands up to 222 m off the track OSM and the basemap both
    draw, which reads on the map as a stroke that does not follow the railway.
    OSM keeps the bores as separate named ways, so the loop can be taken from it
    way by way.

    Only intervals listed in the file are replaced. The lead-in from the last
    shared station is deliberately absent: there N02 has a single centre-line
    for both directions and the paired stroke has to stay EXACTLY coincident
    with the primary, which a second survey's geometry would break.
    """
    path = RAW / "evidence" / "paired-alignment-geometry.json"
    if not path.exists():
        return {}
    rows = json.loads(path.read_text("utf-8")).get("intervals", [])
    return {
        (
            row.get("role", "paired"),
            row["line"],
            row["from_station"],
            row["to_station"],
        ): row["coordinates"]
        for row in rows
    }


def load_structure():
    """OSM tunnel/bridge intervals, keyed by the N02 section they were matched to.

    Surveyed against each SECTION's own measures, which is why the cut has to
    report the sections it traversed: a tunnel is at 300–900 m along section 412,
    and only the cut knows where section 412 sits along the drawn line.
    """
    path = RAW / "osm" / "osm-structure.json.gz"
    if not path.exists():
        return {}
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        rows = json.load(handle)
    rows = rows if isinstance(rows, list) else list(rows.values())[0]
    return {row["section_index"]: row.get("intervals", []) for row in rows}


def structure_on_cut(pieces, measure, structure_by_section):
    """Place a cut's tunnels and bridges on the drawn line's own measure.

    A piece walked against its section's digitised direction has from_m > to_m,
    and its structure has to be mirrored with it — otherwise a tunnel at the far
    end of the section is drawn at the near end of the line.
    """
    out = []
    offset = measure
    for section, start_m, end_m in pieces:
        span = abs(end_m - start_m)
        forward = end_m >= start_m
        low, high = min(start_m, end_m), max(start_m, end_m)
        for interval in structure_by_section.get(section, []):
            kind = STRUCTURE_KIND.get(interval.get("structure"))
            if not kind:
                continue
            from_m = max(low, float(interval.get("from_m", 0)))
            to_m = min(high, float(interval.get("to_m", 0)))
            if to_m - from_m < 1.0:
                continue
            if forward:
                begin, finish = offset + (from_m - low), offset + (to_m - low)
            else:
                begin, finish = offset + (high - to_m), offset + (high - from_m)
            out.append((begin, finish, kind, int(interval.get("layer") or 0)))
        offset += span
    return out


def split_by_track_group(order, points, graph, keep_within_m=250.0):
    """Cut a station order where the track underneath it stops being connected.

    Some railways run on track that does not join up, even though their stations
    form one adjacency chain: 阪急今津線's two halves have been physically
    separate at 西宮北口 since 1984, and 南海高野線's 汐見橋 end is the 汐見橋線.
    Anchoring such an order to one track group leaves the other half stranded
    kilometres from any stroke.

    A station stays with the run it follows as long as it can still be anchored
    within `keep_within_m` of that run's group — which keeps junction stations,
    reachable from both, from splitting the line at every junction. Otherwise the
    run ends and a new one starts.
    """
    runs = []
    for uid in order:
        nearest = graph.project(points[uid])
        group = graph.component[nearest["section"]] if nearest else None
        if runs and group is not None and runs[-1][0] != group:
            same = graph.project(points[uid], component=runs[-1][0])
            if same is not None and same["distance_m"] <= keep_within_m:
                group = runs[-1][0]
        if runs and runs[-1][0] == group:
            runs[-1][1].append(uid)
        else:
            runs.append((group, [uid]))
    return [members for _group, members in runs]


ANCHOR_CANDIDATE_M = 400.0
ANCHOR_CANDIDATES = 6
ANCHOR_STAY_WEIGHT = 0.5
ANCHOR_OFF_END_PENALTY_M = 150.0


def anchor_candidates(point, graph, component, limit=ANCHOR_CANDIDATE_M):
    """Every section near enough to a platform to be the one it stands on."""
    out = []
    for index in graph.indices:
        if graph.component[index] != component:
            continue
        if graph._box_distance_m(index, point) > limit:
            continue
        coords = [list(vertex) for vertex in graph.sections[index].coords]
        distance, measure, projected = graph.geometry_lib.project_to_route(
            point, coords, graph.measures[index]
        )
        if distance <= limit:
            out.append(
                {
                    "section": index,
                    "measure_m": measure,
                    "point": [projected[0], projected[1]],
                    "distance_m": distance,
                }
            )
    out.sort(key=lambda anchor: anchor["distance_m"])
    return out[:ANCHOR_CANDIDATES]


def refine_anchors_by_distance(order, points, graph, anchors, audited_m):
    """Choose which of several parallel tracks each station stands on.

    In a multi-track corridor a platform is metres from more than one N02
    section, and the nearest one is not always the one its service runs on:
    東十条 and 赤羽 both project onto track at 0.0 m, but onto DIFFERENT
    parallel alignments, so the route between them came out at 5.926 km where
    the operator's kilometrage says 1.369.

    The operator's own distances settle it. Anchoring both to the section they
    share gives 1.370 km — so the chain of audited distances is read as the
    evidence it is, and the anchors that reproduce it are the right ones. This
    is a Viterbi pass over the station order: each station's candidates are the
    sections within reach, and the cost of a step is how far the track between
    two candidates falls from the distance the audit states.

    Returns new anchors, or None when nothing better than the current ones
    exists — in which case the caller refuses the part exactly as before.
    """
    if len(order) < 2:
        return None
    component = graph.component[anchors[order[0]]["section"]]
    candidates = {
        uid: anchor_candidates(points[uid], graph, component) or [anchors[uid]]
        for uid in order
    }

    cache = {}

    def step_cost(first, second, target):
        pair = (first["section"], round(first["measure_m"]), second["section"], round(second["measure_m"]))
        if pair not in cache:
            cut = graph.path_between(first, second)
            cache[pair] = None if cut is None else cut[1]
        length = cache[pair]
        if length is None:
            return 1e9
        if not target:
            return length
        return abs(length - target)

    # The platform's own position is evidence too: a station sits on the track
    # it stands beside unless the kilometrage says otherwise. Charging half a
    # metre per metre of displacement breaks ties toward the nearest section
    # without ever outweighing a real distance mismatch, which is measured in
    # hundreds of metres. Without it the pass moved 王子 19.5 m onto a parallel
    # track that matched just as well, and the drawn line left the dot behind.
    def stay_cost(candidate):
        cost = candidate["distance_m"] * ANCHOR_STAY_WEIGHT
        # A projection that lands on a section's very end means the platform is
        # PAST that track, not beside it, and the drawn line then stops short of
        # its own dot — 初台 ended up 21 m off the stroke that way. Prefer a
        # section the station stands within.
        span = graph.length_m(candidate["section"])
        if candidate["measure_m"] <= 1.0 or candidate["measure_m"] >= span - 1.0:
            cost += ANCHOR_OFF_END_PENALTY_M
        return cost

    best = [
        {
            index: (stay_cost(candidate), None)
            for index, candidate in enumerate(candidates[order[0]])
        }
    ]
    for position in range(1, len(order)):
        previous_uid, uid = order[position - 1], order[position]
        target = audited_m.get(tuple(sorted((previous_uid, uid))), 0.0)
        layer = {}
        for index, candidate in enumerate(candidates[uid]):
            choice = None
            for prior, (accrued, _back) in best[-1].items():
                cost = (
                    accrued
                    + step_cost(candidates[previous_uid][prior], candidate, target)
                    + stay_cost(candidate)
                )
                if choice is None or cost < choice[0]:
                    choice = (cost, prior)
            layer[index] = choice
        best.append(layer)

    tail = min(best[-1].items(), key=lambda item: item[1][0])
    picked = [tail[0]]
    for position in range(len(order) - 1, 0, -1):
        picked.append(best[position][picked[-1]][1])
    picked.reverse()
    return {
        uid: {**candidates[uid][index], "platform_len_m": anchors[uid]["platform_len_m"]}
        for uid, index in zip(order, picked)
    }


def choose_platform_by_audit(
    order,
    anchors,
    graph,
    geometry_lib,
    platforms_by_group,
    station_by_uid,
    audited_distance,
    key,
):
    """At a station with two platforms, keep the one the audit agrees with.

    Anchoring projects ONE point per station onto the nearest track, so a
    station whose two directions stop in different places never reconsiders —
    and at 湯檜曽 the nearest track to the point N02 offers first is the UP line.
    The main stroke then climbed the 湯檜曽ループ: 7.529 km against an audited
    3.493, with the down bore through 新清水トンネル left for the paired stroke.
    Both alignments were drawn, but as each other, so the 上り/下り labels were
    backwards and the paired stroke started by running south out of the station
    to reach track the main line had taken.

    The audit settles it without guessing: try each platform and keep the one
    whose distance to its neighbours matches the measured kilometrage. Only
    stations with a real choice and a real measurement are touched, and the
    walk is in order so each station is judged against a neighbour already
    settled.
    """
    # Only stations inside a separated run are eligible. A second platform on
    # its own means nothing much — 大沼 is a junction and has one — and moving a
    # junction's anchor is how 函館線's branch came back out at 159°. What marks
    # a directional split is a RUN of them, which is the same signal the drawn
    # alignment is derived from.
    eligible = set()
    for first, last in separated_direction_runs(
        order, platforms_by_group, station_by_uid
    ):
        eligible.update(order[first:last])
    for position, uid in enumerate(order):
        if uid not in eligible:
            continue
        options = platforms_by_group.get(
            station_by_uid[uid]["physical_station_group"]
        ) or []
        if len(options) < 2 or uid not in anchors:
            continue
        neighbours = []
        if position:
            neighbours.append(order[position - 1])
        if position + 1 < len(order):
            neighbours.append(order[position + 1])
        measured = [
            (other, audited_distance.get((key, tuple(sorted((uid, other))))))
            for other in neighbours
        ]
        measured = [
            (other, km) for other, km in measured if km and other in anchors
        ]
        if not measured:
            continue
        def audit_error(candidate):
            error = 0.0
            for other, km in measured:
                cut = graph.path_between(candidate, anchors[other])
                if cut is None:
                    return math.inf
                error += abs(cut[1] - km * 1000)
            return error

        standing = audit_error(anchors[uid])
        # Only a decisive disagreement may move a station. A station is anchored
        # for many reasons — branch junctions read their direction off it — and
        # trading a few metres of audit agreement for that is a bad bargain: it
        # sent 函館線's branch back out of its junction at 159°. 上越線 is what
        # this is for, and it is not a close call there: 7.529 km drawn against
        # an audited 3.493 becomes 4.135.
        if standing <= ANCHOR_AUDIT_SLACK_M:
            continue
        best = None
        for platform in options:
            candidate = graph.project(platform_midpoint(platform, geometry_lib))
            if candidate is None or candidate["distance_m"] > ANCHOR_MAX_M:
                continue
            error = audit_error(candidate)
            if error is math.inf:
                continue
            if best is None or error < best[0]:
                best = (error, candidate)
        if best is None or best[0] > standing - ANCHOR_AUDIT_SLACK_M:
            continue
        chosen = best[1]
        chosen["platform_len_m"] = anchors[uid].get("platform_len_m", 0.0)
        anchors[uid] = chosen


def separated_direction_runs(order, platforms_by_group, station_by_uid):
    """Spans where a railway's two directions run on their own track.

    N02 marks this by filing a SECOND platform feature at a station: the two
    directions stop there in different places. A run of such stations is the
    separated span, and it ENDS at the next ordinary station, which is where the
    two alignments rejoin — that station has one platform because both
    directions use it.

    上越線 is the shape: 水上 has one platform, 湯檜曽 and 土合 have two each,
    土樽 has one. The separation therefore runs 湯檜曽 → 土合 → 土樽, which is
    exactly what the 清水トンネル article states — the alignments part at 湯檜曽
    and meet again at 土樽. Detecting only the middle hop left the up line as a
    4 km stub that stopped inside the mountain instead of rejoining the railway.

    Returns a list of index ranges into `order`.
    """
    def platforms(uid):
        return platforms_by_group.get(
            station_by_uid[uid]["physical_station_group"]
        ) or []

    runs = []
    index = 0
    while index < len(order):
        if len(platforms(order[index])) < 2:
            index += 1
            continue
        # Back up one station first. The bores part company BETWEEN stations —
        # at 湯檜曽 the down line dives into 新清水トンネル 117 m south of the up
        # platform — so the run has to start at the last station both still
        # share, or the paired stroke begins in mid-air with nothing joining it
        # to the railway. Symmetric with the rejoin at the far end.
        first = max(index - 1, 0)
        while index < len(order) and len(platforms(order[index])) >= 2:
            index += 1
        # ...and on to the rejoin, when the order has one.
        last = min(index, len(order) - 1)
        if last > first:
            runs.append((first, last))
    return runs


def divergent_alignment(graph, start, end, pieces, primary_coords):
    """A second, edge-disjoint track between the SAME two stations.

    The platform test cannot see this shape. It finds a separated alignment by
    the second platform feature N02 files at each station inside it — but where
    the two directions rejoin AT every station and only the track between them
    parts company, both stations have one platform and there is nothing to
    detect. 羽越本線 村上–間島 is that case: the down line hugs the coast (it
    lost its roadbed to a storm in 2000, and trains ran single-track on the up
    line until it was rebuilt) while the up line takes 村上トンネル, 2,308 m
    inland. N02 carries both, 778 m apart, and the package drew only one.

    So cut the track the primary interval uses and ask the graph for a route
    between the same two anchors that reuses none of it. A line with real
    double track filed as one centreline has no such route; one with two
    alignments does.
    """
    # Cutting the WHOLE primary demands a fully edge-disjoint route, and that is
    # stricter than the railway. 北陸本線's 鳩原ループ carries the up line a
    # kilometre away and then rejoins the main line short of 新疋田, so every
    # route to that platform reuses the last stretch — the strict search calls
    # it "no alternate" and misses the best case on JR West. Cutting the primary
    # longest piece instead forces the answer to diverge where the interval
    # actually is one piece of track, while letting both ends share an approach.
    spans = sorted(
        pieces, key=lambda piece: abs(piece[2] - piece[1]), reverse=True
    )
    cut = None
    for excluded in ({piece[0] for piece in pieces}, {spans[0][0]} if spans else set()):
        if not excluded:
            continue
        cut = graph.path_between(start, end, exclude=excluded)
        if cut is not None:
            break
    if cut is None:
        return None
    coords, length_m, _pieces = cut
    coords = dedupe_points(coords)
    if len(coords) < 2 or length_m <= 0:
        return None
    primary_m = polyline_m(primary_coords)
    # A detour several times as long is a different route — a freight avoiding
    # line or a branch that happens to reconnect — not this interval's other
    # track. The same ratio window the audit-driven retry uses.
    if primary_m > 0 and not (
        ALTERNATE_MIN_RATIO <= length_m / primary_m <= ALTERNATE_MAX_RATIO
    ):
        return None
    coords[0] = anchor_point(start)
    coords[-1] = anchor_point(end)
    separation_m = max_separation_m(coords, primary_coords)
    if not (SEPARATED_MIN_M <= separation_m <= SEPARATED_MAX_M):
        return None
    return {
        "separation_m": separation_m,
        "points": [anchor_point(start), anchor_point(end)],
        "coords": coords,
        "length_m": length_m,
    }


def polyline_m(coords):
    total = 0.0
    for first, second in zip(coords, coords[1:]):
        scale = 111_320 * math.cos(math.radians(first[1]))
        total += math.hypot(
            (second[0] - first[0]) * scale, (second[1] - first[1]) * 111_320
        )
    return total


def max_separation_m(alternate, primary):
    """How far the two alignments get from each other, at their widest.

    This is what separates a real directional split from ordinary double track.
    上越線's bores are kilometres apart through the mountain; 中央本線's 笹子 and
    新笹子 tunnels are 25 m apart, which is side-by-side double track that
    happens to be bored twice; and two tram stops facing each other across a
    street are a few metres apart. Only the first is a separate alignment.
    """
    if not primary:
        return 0.0
    widest = 0.0
    for point in alternate:
        scale = 111_320 * math.cos(math.radians(point[1]))
        px, py = point[0] * scale, point[1] * 111_320
        best = math.inf
        for start, end in zip(primary, primary[1:]):
            # Distance to the SEGMENT, not to its nearer endpoint. N02 files
            # tunnel centre-lines with roughly 270 m between vertices, so
            # measuring vertex to vertex inflates every tunnel pair by about
            # half that: 倶利伽羅's twin bores measured 180 m apart this way and
            # are 40 m apart in fact, which is ordinary double track wearing a
            # separated alignment's clothes.
            ax, ay = start[0] * scale, start[1] * 111_320
            bx, by = end[0] * scale, end[1] * 111_320
            dx, dy = bx - ax, by - ay
            span = dx * dx + dy * dy
            t = 0.0 if span == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / span))
            best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
            if best <= widest:
                break
        if best is not math.inf:
            widest = max(widest, best)
    return widest


def separated_alignment(
    graph,
    geometry_lib,
    platforms_by_group,
    order,
    anchors,
    station_by_uid,
    span,
    primary_coords=(),
    primary_sections=frozenset(),
):
    """The other direction's track across one separated span, end to end.

    Every station inside the span is anchored on its SECOND platform, because
    that is the one on this alignment; the station that closes the span keeps
    its shared platform, so the stroke rejoins the railway there instead of
    stopping in mid-air.
    """
    first, last = span
    picked = []
    for position in range(first, last + 1):
        uid = order[position]
        group = station_by_uid[uid]["physical_station_group"]
        options = platforms_by_group.get(group) or []
        if position == last or len(options) < 2:
            picked.append((uid, anchors[uid]))
            continue
        taken = anchors[uid]
        best = None
        for platform in options:
            # Project onto the nearest track, NOT onto "any track the other
            # direction does not use". Forcing the latter walked 湯檜曽's up
            # platform 190 m up the valley to reach the first section N02 files
            # separately, and left the coordinate that IS the station — its
            # surface platform, 7 m from the real building — used by neither
            # stroke. Where the two bores separate is a question about track;
            # where a platform is, is not.
            point = platform_midpoint(platform, geometry_lib)
            candidate = graph.project(point)
            if candidate is None or candidate["section"] == taken["section"]:
                continue
            if best is None or candidate["distance_m"] < best["distance_m"]:
                best = candidate
        if best is None:
            return None
        picked.append((uid, best))

    coords = []
    total = 0.0
    for (start_uid, start_anchor), (end_uid, end_anchor) in zip(picked, picked[1:]):
        # ...and the track between them must be the OTHER track too. Without
        # this the walk is free to hop onto the primary alignment wherever the
        # two run close: at 湯檜曽 the two bores pass within 15 m, so the up
        # stroke left the station southwards along the DOWN line before turning
        # round — a stub pointing away from 土合, which is the next station.
        cut = graph.path_between(
            start_anchor, end_anchor, exclude=primary_sections
        )
        cut = cut or graph.path_between(start_anchor, end_anchor)
        if cut is None:
            return None
        piece = dedupe_points(cut[0])
        if len(piece) < 2:
            return None
        piece[0] = anchor_point(start_anchor)
        piece[-1] = anchor_point(end_anchor)
        coords = join(coords, piece) if coords else piece
        total += cut[1]
    if len(coords) < 2:
        return None

    return {
        "separation_m": max_separation_m(coords, primary_coords),
        "uids": [uid for uid, _anchor in picked],
        "points": [anchor_point(anchor) for _uid, anchor in picked],
        "coords": coords,
        "km": round(geometry_lib.polyline_km(coords), 3),
        "length_m": total,
    }


def split_alternate_segments(
    alternate, geometry_lib, line_key=None, names=(), surveyed=None
):
    """Cut a separated alignment into one interval per station pair.

    An interval the evidence file has OSM track for is taken from there instead
    of from the N02 walk, with both ends still pinned to the package's own
    station anchors so the stroke meets its neighbours to the vertex.
    """
    coords = alternate["coords"]
    points = alternate["points"]
    segments = []
    cursor = 0
    for index in range(1, len(points)):
        target = points[index]
        replacement = None
        if surveyed and line_key and len(names) > index:
            replacement = surveyed.get(
                ("paired", line_key, names[index - 1], names[index])
            )
        if replacement:
            piece = [list(point) for point in replacement]
            piece[0] = list(points[index - 1])
            piece[-1] = list(target)
            kilometres = round(geometry_lib.polyline_km(piece), 3)
            segments.append(
                [kilometres, 0, piece] if not segments else [kilometres, 1, piece[1:]]
            )
            # The walk's own cursor still has to advance past this interval so
            # the next one starts in the right place.
            for position in range(cursor + 1, len(coords)):
                if coords[position] == target:
                    cursor = position
                    break
            else:
                cursor = len(coords) - 1
            continue
        at = cursor
        for position in range(cursor + 1, len(coords)):
            if coords[position] == target:
                at = position
                break
        else:
            at = len(coords) - 1
        piece = coords[cursor : at + 1]
        if len(piece) < 2:
            piece = [coords[cursor], target]
        kilometres = round(geometry_lib.polyline_km(piece), 3)
        segments.append(
            [kilometres, 0, piece] if not segments else [kilometres, 1, piece[1:]]
        )
        cursor = at
    return segments


def anchor_point(anchor):
    """An anchor's coordinate at the package's own precision, in one place.

    Station rows and the interval ends that must coincide with them have to be
    written the same way; deriving both from here is what keeps them identical.
    """
    return [round(anchor["point"][0], 6), round(anchor["point"][1], 6)]


def anchor_part(order, points, graph, platforms_by_group, station_by_uid):
    """Anchor one part's stations onto the one track group they mostly sit on.

    Returns (anchors, stranded, far). `stranded` is the stations that group
    cannot reach — never bridged over, because N02 either has a gap there or the
    part really is two pieces, and both of those need saying rather than hiding.
    """
    votes = collections.Counter()
    for uid in order:
        first = graph.project(points[uid])
        if first is not None:
            votes[graph.component[first["section"]]] += 1
    if not votes:
        return {}, [(station_by_uid[uid]["station_name"], None) for uid in order], []
    component = votes.most_common(1)[0][0]

    anchors, stranded, far = {}, [], []
    for uid in order:
        anchor = graph.project(points[uid], component=component)
        name = station_by_uid[uid]["station_name"]
        if anchor is None or anchor["distance_m"] > ANCHOR_MAX_M:
            stranded.append((name, round(anchor["distance_m"]) if anchor else None))
            continue
        platform = platforms_by_group.get(station_by_uid[uid]["physical_station_group"])
        anchor["platform_len_m"] = platform.length_m if platform is not None else 0.0
        anchors[uid] = anchor
        if anchor["distance_m"] > 250:
            far.append((name, round(anchor["distance_m"])))
    return anchors, stranded, far


def build_display_line(
    *,
    suffix,
    order,
    is_loop,
    key,
    name,
    operator,
    row,
    info,
    display,
    graph,
    anchors,
    station_by_uid,
    audited_distance,
    english,
    operator_short,
    geometry_lib,
    normalise_line_name,
    structure_by_section=None,
    platforms_by_group=None,
    surveyed=None,
):
    """One ordered station list -> one compact-v1 display line.

    A canonical line yields one of these per audited part: the through route, and
    a `-2`, `-3`… sibling for each branch it carries. Siblings share the parent's
    name, operator and colour — they are the same railway, drawn as the separate
    strokes it actually has.
    """
    if not is_loop:
        choose_platform_by_audit(
            order,
            anchors,
            graph,
            geometry_lib,
            platforms_by_group or {},
            station_by_uid,
            audited_distance,
            key,
        )
    pairs = [(order[i], order[i + 1]) for i in range(len(order) - 1)]
    if is_loop:
        pairs.append((order[-1], order[0]))

    segments = []
    failed = None
    mismatched = []
    structure = []
    alternates = []
    interval_sections = []
    measure = 0.0
    for start_uid, end_uid in pairs:
        cut = graph.path_between(anchors[start_uid], anchors[end_uid])
        if cut is None:
            failed = (
                f"{station_by_uid[start_uid]['station_name']} → "
                f"{station_by_uid[end_uid]['station_name']}: no path over this line's own track"
            )
            break
        coords, length_m, pieces = cut
        coords = dedupe_points(coords)
        if len(coords) < 2:
            failed = (
                f"{station_by_uid[start_uid]['station_name']} → "
                f"{station_by_uid[end_uid]['station_name']}: cut collapsed to a point"
            )
            break
        audited = audited_distance.get((key, tuple(sorted((start_uid, end_uid))))) or 0
        if audited and length_m > max(
            audited * 1000 * GROSS_DETOUR_FACTOR, audited * 1000 + GROSS_DETOUR_FLOOR_M
        ):
            # The shortest route is not the one the operator measured, so ask
            # the graph for the route that IS. This is not the builder choosing
            # a track: the audit states the distance and the search returns the
            # path that satisfies it, which is then held to the same tolerance
            # as every other interval below.
            retry = graph.path_matching(
                anchors[start_uid], anchors[end_uid], audited * 1000
            )
            if retry is not None and abs(retry[1] - audited * 1000) < abs(
                length_m - audited * 1000
            ):
                coords, length_m, pieces = retry
                coords = dedupe_points(coords)
        # Rounded to the SAME precision the station rows are written at. The
        # renderer's contract is that an interval's end and its station's dot
        # are the same point, and the package is compared as text — a full
        # precision endpoint beside a 6 dp station row breaks the seam even
        # though the two are millimetres apart.
        coords[0] = anchor_point(anchors[start_uid])
        coords[-1] = anchor_point(anchors[end_uid])
        if audited and length_m > max(
            audited * 1000 * GROSS_DETOUR_FACTOR, audited * 1000 + GROSS_DETOUR_FLOOR_M
        ):
            failed = (
                f"{station_by_uid[start_uid]['station_name']} → "
                f"{station_by_uid[end_uid]['station_name']}: cut {length_m / 1000:.3f} km "
                f"against an audited {audited:.3f} km — the path left the alignment the "
                f"service uses (several tracks share this line's N02 key)"
            )
            break
        if audited:
            slack = max(
                LENGTH_TOLERANCE_M, audited * 1000 * LENGTH_TOLERANCE_FRACTION
            ) + (
                anchors[start_uid]["platform_len_m"]
                + anchors[end_uid]["platform_len_m"]
            ) / 2
            if abs(length_m - audited * 1000) > slack:
                mismatched.append(
                    (
                        station_by_uid[start_uid]["station_name"],
                        station_by_uid[end_uid]["station_name"],
                        round(length_m / 1000, 3),
                        round(audited, 3),
                    )
                )
        interval_sections.append({piece[0] for piece in pieces})
        divergent = divergent_alignment(
            graph, anchors[start_uid], anchors[end_uid], pieces, coords
        )
        if divergent is not None:
            divergent["uids"] = [start_uid, end_uid]
            alternates.append(divergent)
        structure.extend(
            structure_on_cut(pieces, measure, structure_by_section or {})
        )
        measure += length_m
        # compact-v1's seam encoding: every interval after the first drops the
        # vertex it shares with its predecessor and sets the flag, and the
        # renderer puts it back from the previous interval's last point. Storing
        # it twice is not merely larger — the two copies can drift, and then the
        # stroke opens at a station.
        # Both bores of a separated span need surveyed track, not just the
        # sibling stroke. N02 carries ONE coarse centre-line per bore, so the
        # down line stood up to 656 m off 新清水トンネル while the up line was
        # already on OSM's: on the map that read as one straight line ignoring
        # the railway, beside another one following it.
        #
        # Only the drawn geometry is replaced. `measure` and the structure rows
        # keep the N02 walk's own kilometrage, because a tunnel's position was
        # surveyed against THAT and re-basing it here would move every structure
        # on the line to fix a stroke.
        surveyed_primary = (surveyed or {}).get(
            (
                "primary",
                key,
                station_by_uid[start_uid]["station_name"],
                station_by_uid[end_uid]["station_name"],
            )
        )
        if surveyed_primary:
            coords = [list(point) for point in surveyed_primary]
            coords[0] = anchor_point(anchors[start_uid])
            coords[-1] = anchor_point(anchors[end_uid])
        kilometres = round(geometry_lib.polyline_km(coords), 3)
        if segments:
            segments.append([kilometres, 1, coords[1:]])
        else:
            segments.append([kilometres, 0, coords])
    if failed:
        return None, failed, [], []

    station_rows = []
    for uid in order:
        record = station_by_uid[uid]
        group = record["physical_station_group"]
        anchor = anchors[uid]
        station_rows.append(
            [
                group,
                record["station_name"],
                *anchor_point(anchor),
                english.get(group, ""),
                ROMA_SOURCE_OSM,
            ]
        )

    colour = (row["render_color_hex"] or "").lower()
    entry = {
        "id": f"{line_id_for(operator, name)}{suffix}",
        "name": name,
        "operator": OPERATOR_ALIASES.get(operator, operator),
        "rank": display.get("rank")
        if display.get("rank") is not None
        else RANK_BY_KIND[info["kind"]],
        "color": colour,
        "nameRoma": display.get("nameRoma") or "",
        "stations": station_rows,
        "segments": segments,
        "colorDark": (row["render_color_dark_hex"] or row["render_color_hex"] or "").lower(),
        "colorSource": row["render_color_source_url"] or row["render_color_basis"],
        "kind": info["kind"],
        "colorPolicy": info["colorPolicy"],
        "labelPolicy": info["labelPolicy"],
        "nameNorm": normalise_line_name(name),
        "operatorShort": operator_short.get(operator, operator),
    }
    # Siblings carry the flag too: they are the same railway, and the renderer
    # resolves a `-N` id to the parent's badge file, which is what the art is
    # named after.
    if display.get("logo"):
        entry["logo"] = display["logo"]
    if row.get("line_code"):
        entry["lineCode"] = row["line_code"]
    if info["kind"] == "shinkansen":
        entry["isHSR"] = 1
    if is_loop:
        entry["isLoop"] = 1
    if row.get("network_status") and row["network_status"] != "active":
        entry["serviceStatus"] = row["network_status"]
    if not is_loop:
        for span in separated_direction_runs(order, platforms_by_group or {}, station_by_uid):
            primary_sections = set()
            for index in range(span[0], min(span[1], len(interval_sections))):
                primary_sections |= interval_sections[index]
            found = separated_alignment(
                graph,
                geometry_lib,
                platforms_by_group or {},
                order,
                anchors,
                station_by_uid,
                span,
                primary_coords=[point for segment in segments for point in segment[2]],
                primary_sections=primary_sections,
            )
            if found is not None and found["separation_m"] >= SEPARATED_MIN_M:
                alternates.append(found)

    if structure:
        total_m = sum(segment[0] for segment in segments) * 1000
        clipped = []
        for start, end, kind, layer in structure:
            start = max(0.0, min(total_m, start))
            end = max(0.0, min(total_m, end))
            if end - start >= 1.0:
                clipped.append([round(start), round(end), kind, layer])
        if clipped:
            entry["structure"] = clipped
    return entry, None, mismatched, alternates


def build(args) -> None:
    lines, skipped, notes, _ = build_lines(
        selected_keys(args),
        n02_root=args.n02_root,
        verbose=args.verbose,
        progress=args.progress,
    )

    package = {
        "format": "compact-v1",
        "version": PACKAGE_VERSION,
        "generatedAt": GENERATED_AT,
        "crs": "WGS84",
        "country": "JP",
        "lines": lines,
        "geometrySource": {
            "officialOnly": 0,
            "stationData": "data/raw/railway/jp/rebuild-inventory (2026-08-13 audited station graph)",
            "geometry": "N02-25_GML.zip Shift-JIS RailroadSection (国土交通省 国土数値情報 N02-25)",
            "method": (
                "Station order walked from the corrected directed adjacency graph; each "
                "interval cut as the shortest path over that line's own N02 sections "
                "between two platform-midpoint anchors, and checked against the audited "
                "distance for the same pair."
            ),
        },
        "attributeSources": {
            "stationNames": (
                "OpenStreetMap contributors, Geofabrik japan-latest.osm.pbf 2026-08-11, ODbL 1.0"
            ),
            "colours": "data/raw/railway/jp/rebuild-inventory/colours/sources.md",
        },
        "lanes": [],
    }

    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    # A build report beside the package: what each line's build decided, so the
    # per-line checklist can carry it without re-deriving or scraping stdout.
    (STAGING_DIR / "jp-2025.build-report.json").write_text(
        json.dumps(
            {
                "built": [line["id"] for line in lines],
                "skipped": [{"key": key, "reason": reason} for key, reason in skipped],
                "notes": [{"key": key, "note": note} for key, note in notes],
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    destination = STAGING_DIR / "jp-2025.staging.json"
    destination.write_text(json.dumps(package, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"jp: {len(lines)} lines -> {destination.relative_to(APP_DIR)}")
    for line in lines:
        loop = " loop" if line.get("isLoop") else ""
        print(
            f"  {line['id']:<34}{len(line['stations']):>4} stations"
            f"{len(line['segments']):>5} intervals"
            f"{sum(row[0] for row in line['segments']):>9.2f} km  {line['color']}{loop}"
        )
    for key, reason in notes:
        print(f"  NOTE    {key}: {reason}")
    for key, reason in skipped:
        print(f"  SKIPPED {key}: {reason}")
    print(f"built {len(lines)}, skipped {len(skipped)}, notes {len(notes)}")


def platform_midpoint(platform, geometry_lib):
    """A platform polyline's along-line midpoint.

    N02 files a station as a COPY of the track it sits on, so the centroid of a
    curved platform drifts off the track it is meant to mark — by up to ~139 m on
    the worst of them. The midpoint by arc length stays on it.
    """
    coords = [list(point) for point in platform.coords]
    if len(coords) == 1:
        return coords[0]
    measures = geometry_lib.route_measures(coords)
    return list(geometry_lib.point_at(coords, measures, measures[-1] / 2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", type=int, default=None)
    parser.add_argument("--lines", default="")
    parser.add_argument("--n02-root", default="")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--progress", action="store_true", help="one stderr line per railway"
    )
    build(parser.parse_args())


if __name__ == "__main__":
    main()
