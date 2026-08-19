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
GENERATED_AT = "2026-08-18T00:00:00.000Z"

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

# Well inside the gross-detour refusal sits the fold-back band: the interval
# BUILDS, but only by leaving the station the wrong way and coming back past
# its own platform. 尾頭橋 → 名古屋 drew 3.594 km against an audited 2.583
# (+39 %) because 名古屋's nearest N02 platform section dead-ends south of the
# station, so the path had to run to the station's north node and fold 373 m
# back. That never reaches the 3×/+2 km gross check, so the re-anchoring pass
# below (refine_anchors_by_distance) also gets a shot at any interval drawn
# 30 % AND 300 m past its audited distance — big enough that no honest
# platform-projection slack reaches it, small enough to catch the folds. Real
# reversals (出雲坂根, 姨捨) are safe twice over: their 営業キロ includes the
# switchback, so the drawn length matches the audit and never trips this; and
# a retry is only KEPT when it measurably closes the gap to the audit.
REANCHOR_DETOUR_FACTOR = 1.30
REANCHOR_DETOUR_FLOOR_M = 300.0

# A loop line has more than three stations. Three mutually adjacent stations mean
# one of those edges skips the station between the other two — a survey error of
# the same kind the 2026-08-13 audit deleted twelve of, not a loop to draw.
MIN_RING_STATIONS = 4

# An interval that comes this close to the platform it is heading for and then
# travels this many times that distance to finish has run PAST its own station
# and come back. 東北線-4's 王子 → 日暮里 passed 52 m from the 日暮里 anchor,
# carried on 247 m down a parallel alignment, turned 168° and came back — 512 m
# of movement no train makes, bought because it brought the interval nearer the
# 6.282 km the audit states (a 26 % shortfall either way).
#
# The two numbers are the renderer's own fold test (rail-network.js
# FOLD_RETURN_METERS / FOLD_RATIO), so the builder refuses to draw the shape the
# renderer would have to trim.
#
# This can only PREFER a fold-free path over a folding one at the same two
# anchors, never invent one, which is what keeps real reversals intact: at 真幸
# and 新改 the switchback IS the only track, every candidate folds, and the
# choice is unchanged. Geometry alone cannot separate the two — 真幸's return
# leg runs 20 m from its outbound one and 日暮里's runs 35 m — so the test is
# never asked to; it only asks whether the same journey can be made without the
# fold.
PLATFORM_FOLD_NEAR_M = 250.0
PLATFORM_FOLD_RATIO = 2.0
# Candidates the fold test is worth assembling, best distance match first. The
# walk finds one route per way round a corridor, so the honest alternative to a
# fold is always among the first few.
PLATFORM_FOLD_CANDIDATES = 24

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


class _SplitSection:
    """One piece of an N02 section, cut at a T-junction node (see TrackGraph)."""

    __slots__ = ("coords",)

    def __init__(self, coords):
        self.coords = coords


class TrackGraph:
    """One railway's own track, as a graph its stations can be routed over.

    Nodes are section endpoints at NODE_DP; edges are whole N02 sections. A
    station anchor is a position ALONG one section, so a path between two
    anchors is a partial section, a run of whole sections, and another partial
    section — which is exactly one station interval.
    """

    def __init__(self, sections, indices, geometry_lib):
        # A local copy: T-junction splits append pieces, and those pieces
        # belong to THIS railway's graph, not to the shared national list.
        self.sections = list(sections)
        self.geometry_lib = geometry_lib
        self.indices = []
        seen_geometry = set()
        for index in sorted(indices):
            key = sections[index].geom_key
            if key in seen_geometry:
                continue
            seen_geometry.add(key)
            self.indices.append(index)
        self._split_t_junctions()
        self.measures = {
            index: geometry_lib.route_measures(
                [list(point) for point in self.sections[index].coords]
            )
            for index in self.indices
        }
        self.adjacency = collections.defaultdict(list)
        for index in self.indices:
            coords = self.sections[index].coords
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
            xs = [point[0] for point in self.sections[index].coords]
            ys = [point[1] for point in self.sections[index].coords]
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

    def _split_t_junctions(self):
        """Make a node where one section ENDS on another's interior vertex.

        Node identity above is a section's first and last vertex, and that is a
        blind spot for the survey's T-junctions: at 常紋信号場 the 石北線's old
        crossing-loop leg (section 21167) ends exactly ON an interior vertex of
        each through section — the vertices are digit-for-digit equal — yet the
        endpoint-only graph keeps them strangers, and the whole railway east of
        the loop became an unreachable second component. 生田原–西留辺蘂 was
        drawn as two strokes with a 19 km hole between them because of it.

        So any section carrying another section's endpoint as an interior
        vertex is split there, making the junction a real node. Splitting
        changes no geometry — the pieces cover the parent vertex for vertex —
        and a nationwide scan (2026-08-18) finds such touches on twelve
        railways. Six become a single connected track (石北線, 常磐線,
        武蔵野線, 日豊線, 肥薩線, 東武伊勢崎線), 山陽線 goes from three
        groups to two, 長崎線 stays one group but its 旧線 dead-end becomes
        routable, and on the rest (鹿児島線, 上越線, JR東 東海道線,
        ポートアイランド線) the new node only lets a cut cross the junction
        at the junction instead of via the nearest section seam.

        A vertex that shares the section's OWN endpoint key is left alone: the
        union-find above already knows those touch, and cutting there would
        only manufacture degenerate slivers out of near-coincident vertices.
        `self.source` remembers each piece's parent and measure offset so a
        cut can still be reported against the ORIGINAL section's measures,
        which is the space OSM structure was surveyed in.
        """
        ends = set()
        for index in self.indices:
            coords = self.sections[index].coords
            ends.add(nkey(coords[0]))
            ends.add(nkey(coords[-1]))
        self.source = {}
        rebuilt = []
        for index in self.indices:
            coords = self.sections[index].coords
            own = {nkey(coords[0]), nkey(coords[-1])}
            cuts = []
            for at in range(1, len(coords) - 1):
                key = nkey(coords[at])
                if key not in ends or key in own:
                    continue
                if cuts and nkey(coords[cuts[-1]]) == key:
                    continue
                cuts.append(at)
            if not cuts:
                rebuilt.append(index)
                continue
            measures = self.geometry_lib.route_measures(
                [list(point) for point in coords]
            )
            for start, stop in zip([0, *cuts], [*cuts, len(coords) - 1]):
                piece = len(self.sections)
                self.sections.append(
                    _SplitSection([list(point) for point in coords[start : stop + 1]])
                )
                self.source[piece] = (index, measures[start])
                rebuilt.append(piece)
        self.indices = rebuilt

    def to_source_pieces(self, pieces):
        """Translate cut pieces back into ORIGINAL section measure space.

        Cuts and exclusions speak this graph's own indices — including the
        pieces T-junction splitting created — but OSM structure is keyed by
        the N02 section it was matched to, at measures along THAT section. A
        split piece's measures are its parent's shifted by where the piece
        starts, so shifting back is exact.
        """
        out = []
        for index, start_m, end_m in pieces:
            source, offset = self.source.get(index, (index, 0.0))
            out.append((source, offset + start_m, offset + end_m))
        return out

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
        # The closest PLATFORM_FOLD_CANDIDATES matches, kept as a bounded
        # max-heap on the distance miss so a corridor with thousands of routes
        # costs the same as one with three. `rank` breaks ties without ever
        # comparing the walks themselves.
        scored = []
        rank = 0
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
                    miss = abs(total - target_m)
                    entry = (-miss, rank, total, walked, head_node, node)
                    rank += 1
                    if len(scored) < PLATFORM_FOLD_CANDIDATES:
                        heapq.heappush(scored, entry)
                    elif miss < -scored[0][0]:
                        heapq.heapreplace(scored, entry)
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
        if not scored:
            return None
        candidates = [
            (total, walked, head, node)
            for _miss, _rank, total, walked, head, node in sorted(
                scored, key=lambda item: -item[0]
            )
        ]

        # Best distance match first, but a path that runs PAST the platform it
        # is heading for and comes back is not track a service uses, so it may
        # not win on distance. Try the closest matches in turn and take the
        # first that reaches the station without folding.
        end_point = self.geometry_lib.point_at(
            [list(point) for point in end_coords],
            self.measures[end["section"]],
            end["measure_m"],
        )
        for total, walked, head_node, end_node in candidates:
            assembled = self._assemble(
                start, end, list(walked), head_node, end_node, total
            )
            if not folds_past_point(assembled[0], end_point):
                return assembled
        # Every route here folds, so the track itself reverses into this
        # station — 真幸, 新改, 出雲坂根. Draw the best match, as before.
        total, walked, head_node, end_node = candidates[0]
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


def folds_past_point(coords, point):
    """Does this path reach `point`, carry on, and come back to it?

    Walked from the far end: a vertex within PLATFORM_FOLD_NEAR_M of the target
    that still costs PLATFORM_FOLD_RATIO times its own distance to finish from
    is a vertex the path had already arrived at and then left. An honest
    approach spends its last metres getting closer, so its run and its distance
    stay in step and the ratio is never reached.
    """
    if len(coords) < 3:
        return False
    scale = 111_320 * math.cos(math.radians(point[1]))
    run = 0.0
    for index in range(len(coords) - 2, -1, -1):
        nxt = coords[index + 1]
        run += math.hypot(
            (coords[index][0] - nxt[0]) * scale, (coords[index][1] - nxt[1]) * 111_320
        )
        if run > PLATFORM_FOLD_NEAR_M * 8:
            return False
        gap = math.hypot(
            (coords[index][0] - point[0]) * scale,
            (coords[index][1] - point[1]) * 111_320,
        )
        if gap <= PLATFORM_FOLD_NEAR_M and run >= PLATFORM_FOLD_RATIO * max(gap, 1.0):
            return True
    return False


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
    junctions = set()
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
        junctions |= {
            uid_by_name[name]
            for name in part.get("junctions", [])
            if name in uid_by_name
        }

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
    #
    # A junction the audit NAMES is never an interior, however few neighbours it
    # has outside the part. Two outside neighbours is what a station the trunk
    # PASSES THROUGH has; a junction the trunk ENDS AT has one, and the test
    # cannot tell that apart from a branch station. ユーカリが丘線 is the case:
    # 公園 is where the ユーカリが丘 tail meets the residential ring, so peeling
    # it left the trunk as 地区センター–ユーカリが丘 and the 449 m 公園–地区セン
    # ター interval drawn by nobody — a visible break between the two strokes.
    # 中央線's 塩尻, where the 辰野支線 leaves, lost みどり湖–塩尻 the same way.
    # Which stations join a part to the rest of the line is not a question to
    # re-derive from degree: the audit states it per part, in `junctions`.
    interiors = set()
    for _kind, members in branches:
        interiors |= {
            uid
            for uid in members - junctions
            if len(neighbours[uid] - members) < 2
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
        # A hop between two junctions is not this part's to draw. Both of them
        # stay on the trunk, so the trunk already holds that pair — and the cut
        # is a shortest path between two station anchors, which returns the SAME
        # track for the same pair however many alignments really run between
        # them. 上越線's 湯檜曽–土合 variant is the whole of the 下り線 新清水
        # トンネル and would have come out as a second copy of the 上り線 stroke;
        # 東海道線's 梅田貨物線 the same over 新大阪–大阪. compact-v1 addresses
        # geometry by station pair and so cannot hold a second alignment between
        # one pair: that corridor is reported uncovered, not drawn twice.
        branch_edges = sorted(
            pair
            for pair in edges
            if pair[0] in members
            and pair[1] in members
            and not (pair[0] in junctions and pair[1] in junctions)
        )
        if not branch_edges:
            undrawable.append(kind)
            continue
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
            # Tie-break on the station uid, not on arrival order. Two leaves the
            # same distance away are a real occurrence on a symmetric branch, and
            # `distance > best[0]` silently kept whichever the walk reached
            # first — which depended on set iteration order and so on the
            # interpreter's per-process string hashing.
            if (distance, node) > best:
                best = (distance, node)
            # `near[node]` is a set, so iterating it raw let the SAME input
            # produce different parentage from one run to the next: 東海道線 and
            # its sibling traded 15 km of track between rebuilds, and 成田線-3/-4
            # swapped their mileage outright. Sorting makes the trunk, and every
            # part split that follows from it, a function of the data alone.
            for other in sorted(near[node]):
                if other in seen:
                    continue
                seen.add(other)
                parents[other] = node
                stack.append((other, distance + weight(node, other)))
        return best[0], best[1], parents

    _first, far_node, _parents = farthest(min(near))
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


def drop_skip_station_edges(edges, passes=None, keep=frozenset(), shield=frozenset()):
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

    `keep` names the hops the audit's own partition rides — consecutive station
    pairs of an audited branch part — and they are never candidates here. The
    geometric test cannot be trusted with them: 東海道線's 大垣–垂井 is the main
    line itself, but it passes 121 m from 荒尾 — a branch-only station whose
    platform sits up its own stub near 南荒尾信号場 — so the test read the
    trunk's own hop as a duplicate of 大垣–荒尾–垂井. That verdict assumes the
    covering hops end up drawn TOGETHER, and the audited partition then put
    大垣 on the trunk and 垂井 on the branch part, so the 南荒尾–垂井 track was
    drawn by neither stroke. A hop the audit's partition names is an interval
    that WILL be drawn; dropping it is never this test's call. (On every other
    jp line this is inert: no audited part names a consecutive pair this test
    currently drops.)

    `shield` is the same trust boundary approached from the skipped station's
    side: the branch-only members of the audited parts. `keep` protects the
    hops a part RIDES; it cannot protect the main line where the main line is
    not a hop of any part. 長崎線's 現川–浦上 is the 市布新線 itself, but the
    new line passes inside the 400 m window of 西浦上 — a station of the
    audited 旧線 part — so the test read the trunk's own hop as a duplicate of
    現川–西浦上–浦上 and cut the main line at its own junction. 西浦上's track
    is the audited part's to draw, on its own stroke; an edge is not covering
    ground already covered just because it runs past a station whose hops live
    on a DIFFERENT stroke. So: an edge whose skipped stations include a
    shielded one is not cut — unless the edge itself ends at a shielded
    station, because then it runs INTO the part it would have to duplicate
    (東海道線's 大垣–関ヶ原 ends at 関ヶ原, a member of the audited 垂井経由
    part, and really is the 新垂井線 chord the test should go on dropping).

    An edge is only dropped while the rest of the graph still connects its two
    ends, so nothing is ever severed from the line.
    """
    working = list(edges)
    dropped = []
    order = sorted(edges, key=lambda edge: -len(passes(edge[0], edge[1])) if passes else 0)
    for pair in order:
        if passes is None:
            break
        if pair in keep:
            continue
        skipped = passes(pair[0], pair[1])
        if not skipped:
            continue
        if (
            any(uid in shield for uid in skipped)
            and pair[0] not in shield
            and pair[1] not in shield
        ):
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

    # The audit's partition outranks the skip-edge test, so the hops it rides
    # are settled before the test runs: an edge between CONSECUTIVE stations of
    # an audited branch part is that part's own interval, already decided to be
    # drawn. Non-consecutive members stay fair game — 大垣–関ヶ原 spans the same
    # part and really is a chord (the 新垂井線, drawn from its evidence row).
    #
    # The branch-only members of those parts shield the OTHER side of the same
    # decision: an edge is not "already covered" merely because it runs past a
    # station whose hops the partition draws on a different stroke (長崎線's
    # 現川–浦上 passes 西浦上, a 旧線-part station). Only parts whose junctions
    # resolve to real stations of this line can vouch for that — a rejoin
    # variant leaves and rejoins at stations (two), a terminal branch leaves at
    # one. 山手線's auto part hangs off 新宿 and a bare coordinate, so it names
    # no drawable partition and must not shield 代々木; shielding it would
    # reroute the main line over its own skip edge.
    audited_hops = set()
    audited_interiors = set()
    try:
        for part in json.loads(row.get("branch_parts_json") or "[]"):
            names = [
                name for name in part.get("stations", []) if name in uid_by_name
            ]
            members = [uid_by_name[name] for name in names]
            audited_hops |= {
                tuple(sorted(pair)) for pair in zip(members, members[1:])
            }
            if part.get("type") not in ("rejoin_variant", "terminal_branch"):
                continue
            if len(members) < 2:
                continue
            junctions = {
                name for name in part.get("junctions", []) if name in uid_by_name
            }
            if len(junctions) < (2 if part["type"] == "rejoin_variant" else 1):
                continue
            audited_interiors |= {
                uid_by_name[name] for name in names if name not in junctions
            }
    except json.JSONDecodeError:
        pass

    prefix = []
    if passes is not None:
        edges, dropped = drop_skip_station_edges(
            edges, passes=passes, keep=audited_hops, shield=audited_interiors
        )
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
    """rank / nameRoma / logo from the archived package, by (operator, name).

    A canonical line the archive NEVER carried — it did not exist as its own
    line then — states the same three attributes in INTRODUCED_DISPLAY below,
    decided against its family rather than re-derived. 京王新線 is the first:
    born of batch 7's split of the「京王線」N02 key, it wears the 京王
    corporate mark every KO-family line wears (the badge PNG is published
    beside theirs), ranks with 京王線 — it is the same trunk corridor's second
    pair of tracks, not a spur — and takes OSM's name:en for its relation
    (10056074) as the roma name, the same source the family's names came from.
    """
    carried = {}
    archive = RAW / "packages" / "jp-2025-pre-rebuild-25031fbc.json.gz"
    if archive.exists():
        with gzip.open(archive, "rt", encoding="utf-8") as handle:
            package = json.load(handle)
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
    for key, attributes in INTRODUCED_DISPLAY.items():
        carried.setdefault(key, dict(attributes))
    return carried


INTRODUCED_DISPLAY = {
    identity_key("京王電鉄", "京王新線"): {
        "rank": 2,
        "nameRoma": "Keio New Line",
        "logo": 1,
    },
}


def split_source_line_keys(net):
    """canonical_key -> (source line_key, [section idx…]) for split N02 keys.

    n02-source-line-keys.csv holds one row per (raw N02 key, canonical line)
    mapping, and `source_section_indices` names the exact RailroadSection
    features that mapping claims. For the ordinary key the mapping is identity
    on a single row, and this function ignores it — `net.line_sections` is
    already the answer. A key that appears on SEVERAL rows is a real split:
    N02 files the 京王新線 under「京王線」because the operator's 路線名称 does,
    while 1978's platform moves made 初台・幡ヶ谷 新線-only stations and the
    two corridors separate railways to draw. For a split key every row becomes
    authoritative: each canonical draws exactly the sections its row lists.
    Shared approach track may be listed by both sides — the 新線 rides the
    本線's centre-line from their junction into 笹塚, and shared track must
    stay point-identical — but the union has to reproduce the source key's
    full section list: a split may reapportion track, never invent or lose it.
    """
    rows_by_source = collections.defaultdict(list)
    for row in read_csv(INVENTORY / "lines" / "n02-source-line-keys.csv"):
        rows_by_source[(row["source_line"], row["source_operator"])].append(row)

    splits = {}
    for source_key, rows in sorted(rows_by_source.items()):
        if len(rows) < 2:
            continue
        full = set(net.line_sections.get(source_key, []))
        union = set()
        for row in rows:
            indices = json.loads(row["source_section_indices"])
            union.update(indices)
            splits[row["canonical_key"]] = (source_key, sorted(indices))
        if union != full:
            raise SystemExit(
                f"n02-source-line-keys.csv splits {source_key} but its rows do not "
                f"reproduce that key's sections: missing {sorted(full - union)[:8]}, "
                f"invented {sorted(union - full)[:8]}"
            )
    return splits


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
    apply_station_geometry_patches(net, n02_source)
    apply_station_anchor_overrides(net, n02_source)

    source_splits = split_source_line_keys(net)
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
    for interval in load_station_platform_corrections()["surveyed_intervals"]:
        pair_geometry[
            (
                interval.get("role", "primary"),
                interval["line"],
                interval["from_station"],
                interval["to_station"],
            )
        ] = interval["coordinates"]
    pair_bypasses = load_pair_bypasses()

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
    assign_station_platforms(platforms, all_platforms, geometry_lib)
    exact_platform_groups = collections.defaultdict(set)
    for assignment in load_station_platform_corrections()["platform_assignments"]:
        exact_platform_groups[assignment["line"]].add(assignment["station_group"])
    # An anchor override has to pin its dot for the same reason an assignment
    # does: without it the anchoring pass re-projects the moved feature onto
    # whatever track is nearest along the part and undoes most of the move
    # (measured: 名古屋 came back 107 m, 和歌山市 113 m).
    for override in load_station_platform_corrections()["station_anchor_overrides"]:
        exact_platform_groups[override["line"]].add(override["station_group"])

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
        # A canonical line normally IS its N02 key. A split canonical draws the
        # listed subset of ANOTHER key's sections instead — 京王新線 lives under
        # N02's「京王線」— and its platform features are filed under that source
        # key too, so every platform lookup below asks with `source_key`.
        source_key, section_indices = source_splits.get(key, (None, None))
        if section_indices is None:
            source_key = (name, operator)
            section_indices = net.line_sections.get(source_key)
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
            platform = platforms.get(source_key, {}).get(
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
            (
                order,
                part_points,
                part_platforms,
                extension_reason,
                extension_display_as,
            ) = (
                extend_display_part_at_platforms(
                    key,
                    order,
                    points,
                    platforms.get(source_key, {}),
                    all_platforms.get(source_key, {}),
                    uid_by_name,
                    station_by_uid,
                    geometry_lib,
                )
            )
            part_points, part_platforms, part_platform_reason = (
                apply_display_part_platforms(
                    key,
                    order,
                    dict(part_points),
                    dict(part_platforms),
                    all_platforms.get(source_key, {}),
                    uid_by_name,
                    station_by_uid,
                    geometry_lib,
                )
            )
            if extension_reason:
                notes.append((f"{key}{suffix}", extension_reason))
            if part_platform_reason:
                notes.append((f"{key}{suffix}", part_platform_reason))
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
                order, part_points, graph, part_platforms, station_by_uid
            )

            def pin_registered_platform_points(anchor_map):
                for uid in order:
                    group = station_by_uid[uid]["physical_station_group"]
                    if group in exact_platform_groups.get(key, set()):
                        anchor_map[uid]["point"] = list(points[uid])
                    if part_points.get(uid) != points.get(uid):
                        anchor_map[uid]["point"] = list(part_points[uid])

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
            # The registered geometry supplies the stroke shape; keep its ends
            # exactly on the selected platforms instead of exposing N02's
            # 20-90 m projection offsets as station dots.
            pin_registered_platform_points(anchors)
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
                platforms_by_group=all_platforms.get(source_key, {}),
                surveyed=pair_geometry,
                bypasses=pair_bypasses,
            )
            entry, problem, mismatched, alternates = attempt
            pinned_uids = {
                uid
                for uid in order
                if station_by_uid[uid]["physical_station_group"]
                in exact_platform_groups.get(key, set())
            }
            audited_m_by_pair = {
                pair: (audited_distance.get((key, pair)) or 0) * 1000
                for pair in adjacency.get(key, set())
            }
            if problem and "several tracks share" in problem:
                # The nearest section is not always the track the service runs
                # on. Re-anchor the whole chain against the audited distances
                # and try once more; if that still cannot reproduce them, the
                # refusal below stands.
                refined = refine_anchors_by_distance(
                    order,
                    part_points,
                    graph,
                    anchors,
                    audited_m_by_pair,
                    pinned=pinned_uids,
                )
                if refined:
                    pin_registered_platform_points(refined)
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
                bypasses=pair_bypasses,
                    )
                    if not problem:
                        notes.append(
                            (
                                f"{key}{suffix}",
                                "anchors re-chosen against the audited distances "
                                "— several tracks share this line's N02 key",
                            )
                        )
            elif not problem and fold_back_intervals(mismatched):
                # The part BUILT, but an interval got its length by leaving a
                # station the wrong way and folding back past its own platform:
                # 名古屋's nearest platform section dead-ends south of the
                # station, so 尾頭橋 → 名古屋 drew 3.594 km against an audited
                # 2.583 by running through the station and 373 m back. Same
                # cure as the refusal above — re-anchor the chain against the
                # audited distances — but this retry would REPLACE a working
                # part, so it is only kept when it provably improves: it must
                # build, it must resolve at least one fold, and the part as a
                # whole must land closer to the audit than it stood.
                folds = fold_back_intervals(mismatched)
                refined = refine_anchors_by_distance(
                    order,
                    part_points,
                    graph,
                    anchors,
                    audited_m_by_pair,
                    pinned=pinned_uids,
                )
                if refined:
                    pin_registered_platform_points(refined)
                    retry = build_display_line(
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
                        platforms_by_group=all_platforms.get(source_key, {}),
                        surveyed=pair_geometry,
                        bypasses=pair_bypasses,
                    )
                    _, retry_problem, retry_mismatched, _ = retry
                    if (
                        not retry_problem
                        and len(fold_back_intervals(retry_mismatched)) < len(folds)
                        and sum(abs(row[2] - row[3]) for row in retry_mismatched)
                        < sum(abs(row[2] - row[3]) for row in mismatched)
                    ):
                        entry, problem, mismatched, alternates = retry
                        notes.append(
                            (
                                f"{key}{suffix}",
                                f"anchors re-chosen against the audited distances — "
                                f"{len(folds)} interval(s) drew a fold-back past a station",
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
            if extension_display_as:
                entry["_displayAsLine"] = extension_display_as
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

    apply_display_line_reassignments(lines)
    apply_registered_shared_junctions(lines)
    share_junction_anchors(lines)
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
    payload = json.loads(path.read_text("utf-8"))
    # A bypass is a pair as far as the DIRECTION gate is concerned — it is only
    # found differently — so its rows answer here too. Without this the bypass
    # geometry is built and then dropped for having no source behind it.
    rows = payload.get("pairs", []) + payload.get("bypasses", [])
    return {
        (row["line"], row["from_station"], row["to_station"]): row for row in rows
    }


def load_pair_bypasses():
    """Sourced 別線 that skip a station, keyed like any other pair row.

    Separate from `pairs` because the geometry is found a different way: by
    excluding the skipped station's own track rather than by following second
    platform features. The direction rules are identical.
    """
    path = RAW / "evidence" / "paired-alignment-directions.json"
    if not path.exists():
        return {}
    rows = json.loads(path.read_text("utf-8")).get("bypasses", [])
    return {
        (row["line"], row["from_station"], row["to_station"]): row for row in rows
    }


def load_pair_geometry():
    """Registered replacement track for an interval, keyed by role and stations.

    Two evidence files, one schema, one consumer:

    * `paired-alignment-geometry.json` — N02-25 carries one coarse centre-line
      for a second bore. On 上越線's 湯檜曽ループ it stands up to 222 m off the
      track OSM and the basemap both draw, which reads on the map as a stroke
      that does not follow the railway. OSM keeps the bores as separate named
      ways, so the loop can be taken from it way by way.
    * `stale-alignment-geometry.json` — intervals where N02-25 still carries an
      alignment the railway no longer uses (尼崎's pre-1997 上り線, 折尾's
      pre-2022 line, the 飯田線's pre-1977 第一久頭合 route, 板谷峠's pre-tunnel
      surface line, the 芸備線's pre-2006 route). The 2026-08-18 basemap
      comparison found each of them by measuring the drawn stroke against OSM's
      own disused/abandoned/razed ways.

    Only intervals listed in a file are replaced. The lead-in from the last
    shared station is deliberately kept as N02: there N02 has a single
    centre-line for both directions and a paired stroke — or a stroke sharing a
    station throat with a neighbour — has to stay EXACTLY coincident with it,
    which a second survey's geometry would break.
    """
    geometry = {}
    for name in (
        "paired-alignment-geometry.json",
        "stale-alignment-geometry.json",
    ):
        path = RAW / "evidence" / name
        if not path.exists():
            continue
        for row in json.loads(path.read_text("utf-8")).get("intervals", []):
            geometry[
                (
                    row.get("role", "paired"),
                    row["line"],
                    row["from_station"],
                    row["to_station"],
                )
            ] = row["coordinates"]
    return geometry


def load_station_platform_corrections():
    """Registered per-line platform truth (R13), merged over every evidence file.

    N02-25 digitises 東北新幹線's station track AND its station feature at 東京
    as vertex-for-vertex copies of the 東海道新幹線 platform polyline, so both
    Shinkansen anchored ONE dot on the JR Central platforms. The evidence file
    carries the surveyed centreline of the JR East 20-23 tracks (OSM, ODbL),
    names which platform feature each surface line's dot stands on, and joins
    the 品鶴線 stroke to the 総武地下ホーム so the underground alignment does
    not stop at 東京. Same ODbL-for-geometry precedent as
    paired-alignment-geometry.json.
    """
    blocks = (
        "station_anchor_overrides",
        "geometry_patches",
        "platform_assignments",
        "display_part_platforms",
        "display_part_extensions",
        "shared_junctions",
        "surveyed_intervals",
    )
    merged = {block: [] for block in blocks}
    # 東京 first (it is the precedent and carries the geometry patches), then
    # every other station-platform evidence file in name order. One schema, one
    # consumer: a new batch adds a FILE, never a second code path.
    directory = RAW / "evidence"
    paths = [directory / "tokyo-station-platforms.json"] + sorted(
        path
        for pattern in ("station-platform-*.json", "station-anchor-*.json")
        for path in directory.glob(pattern)
        if path.name != "tokyo-station-platforms.json"
    )
    for path in paths:
        if not path.exists():
            continue
        payload = json.loads(path.read_text("utf-8"))
        for block in blocks:
            merged[block].extend(payload.get(block, []))
    return merged


def _coords_key(coords):
    return tuple((round(x, NODE_DP), round(y, NODE_DP)) for x, y in coords)


def apply_station_geometry_patches(net, n02_source):
    """Swap a registered N02 station-track copy for the railway's own track.

    A patch names the line, the station, and the EXACT vertex string it
    replaces; a survey update that redraws that feature makes the match fail
    and the build stop, so a patch can never silently rewrite track it was not
    written against. Both the RailroadSection and the Station feature carrying
    the copied geometry are replaced, because anchoring reads the platform and
    path cutting reads the track — patching only one would put the dot off the
    stroke or the stroke off the dot.
    """
    corrections = load_station_platform_corrections()
    for patch in corrections["geometry_patches"]:
        operator, _, line = patch["line"].partition("␟")
        key = (line, operator)
        wanted = _coords_key(patch["n02_coords"])

        sections = [
            net.sections[index]
            for index in net.line_sections.get(key, [])
            if _coords_key(net.sections[index].coords) == wanted
        ]
        stations = [
            row
            for row in net.stations
            if row.line_key == key
            and row.name == patch["station"]
            and _coords_key(row.coords) == wanted
        ]
        if len(sections) != 1 or len(stations) != 1:
            raise SystemExit(
                f"station platform evidence patch for {patch['line']} expects "
                f"exactly one section and one station feature matching its "
                f"n02_coords, found {len(sections)} section(s) and "
                f"{len(stations)} station feature(s) — the survey moved under it"
            )
        for record, coords in (
            (sections[0], patch["section_coords"]),
            (stations[0], patch["platform_coords"]),
        ):
            record.coords = [list(point) for point in coords]
            record.length_m = n02_source.polyline_length_m(record.coords)
            if hasattr(record, "geom_key"):
                record.geom_key = n02_source._geom_key(record.coords)


def apply_station_anchor_overrides(net, n02_source):
    """Move ONE station feature onto its surveyed platform. Never moves track.

    `geometry_patches` replaces a RailroadSection *and* its station feature,
    because 東京's defect was a copied TRACK. The defect here is different and
    much commoner: N02 puts a line's station feature on the wrong platform of a
    shared station — 京成高砂's 北総線 dot 169 m from platform 5, 宮古's 山田線
    dot 156 m from platform 0 — while the track itself is fine. Reusing
    geometry_patches would force us to invent replacement track we have not
    surveyed, so this block exists to do the smaller, safer thing.

    Two guards, both stop the build rather than guessing:
      * the current feature must still be where the evidence says it is
        (midpoint within 1 m), so a survey update cannot be silently overwritten;
      * exactly one feature may match, so an ambiguous key is never patched.
    The generator additionally refuses to write a row whose target does not sit
    on a section the line already rides (build-station-anchor-evidence.mjs), so
    a moved dot cannot leave its own stroke.
    """
    corrections = load_station_platform_corrections()
    for row in corrections["station_anchor_overrides"]:
        operator, _, line = row["line"].partition("␟")
        key = (line, operator)
        target = row["n02_midpoint"]
        matches = [
            station
            for station in net.stations
            if station.line_key == key
            and station.name == row["station"]
            and geometry_lib_metres(platform_midpoint_coords(station.coords), target) <= 1.0
        ]
        if len(matches) != 1:
            raise SystemExit(
                f"station_anchor_overrides for {row['line']} {row['station']} expects "
                f"exactly one N02 feature within 1 m of {target}, found {len(matches)} "
                f"— the survey moved under it"
            )
        record = matches[0]
        record.coords = [list(point) for point in row["platform_coords"]]
        record.length_m = n02_source.polyline_length_m(record.coords)
        if hasattr(record, "geom_key"):
            record.geom_key = n02_source._geom_key(record.coords)


def platform_midpoint_coords(coords):
    return [
        sum(point[0] for point in coords) / len(coords),
        sum(point[1] for point in coords) / len(coords),
    ]


def geometry_lib_metres(a, b):
    return math.hypot(
        (a[0] - b[0]) * 111320 * math.cos(math.radians((a[1] + b[1]) / 2)),
        (a[1] - b[1]) * 111320,
    )


def assign_station_platforms(platforms, all_platforms, geometry_lib):
    """Pin a station's platform pick where file order is not the right chooser.

    `platforms` keeps the FIRST feature per (line, group), which is right when
    a group has one feature and arbitrary when it has four. At 東京 the 東北線
    group carries the west 304 m feature first while 上野東京ライン's trains
    stand at the east 398 m one — the same feature 東海道線 anchors — so the
    two strokes drew two dots 100 m apart. Each assignment row names both the
    local axis of the line and the midpoint of the feature it really serves.
    Candidates that do not run with that axis are rejected first; the nearest
    eligible midpoint then wins. A group the inventory no longer carries, or
    whose platforms no longer match the registered direction, stops the build.

    Bearings are platform AXES rather than directed travel bearings: 9 degrees
    northbound is the same physical platform as 189 degrees southbound. This
    lets 東北線 and 東海道線 select the same 7-10 surface feature while their
    trains leave 東京 in opposite directions.
    """

    def axis_bearing(platform):
        coords = [list(point) for point in platform.coords]
        if len(coords) < 2:
            return None
        first = coords[0]
        last = next(
            (point for point in reversed(coords[1:]) if point != first),
            None,
        )
        if last is None:
            return None
        latitude = (first[1] + last[1]) / 2
        east = (last[0] - first[0]) * math.cos(math.radians(latitude))
        north = last[1] - first[1]
        return math.degrees(math.atan2(east, north)) % 180

    def axis_error(first, second):
        return abs((first - second + 90) % 180 - 90)

    corrections = load_station_platform_corrections()
    for row in corrections["platform_assignments"]:
        operator, _, line = row["line"].partition("␟")
        key = (line, operator)
        group = row["station_group"]
        candidates = all_platforms.get(key, {}).get(group)
        if not candidates:
            raise SystemExit(
                f"station platform evidence assigns a platform for "
                f"{row['line']} group {group}, but that line carries no such "
                f"station group"
            )
        indexed = list(enumerate(candidates))
        expected_axis = row.get("line_axis_bearing_degrees")
        if expected_axis is not None:
            max_error = float(row.get("max_axis_bearing_error_degrees", 5.0))
            aligned = [
                (index, candidate)
                for index, candidate in indexed
                if (bearing := axis_bearing(candidate)) is not None
                and axis_error(bearing, float(expected_axis)) <= max_error
            ]
            if not aligned:
                actual = [
                    None
                    if axis_bearing(candidate) is None
                    else round(axis_bearing(candidate), 1)
                    for candidate in candidates
                ]
                raise SystemExit(
                    f"station platform evidence assigns {row['line']} group "
                    f"{group} along axis {expected_axis}° (+/-{max_error}°), but "
                    f"its candidate platform axes are {actual}"
                )
            indexed = aligned
        target = row["prefer_midpoint_near"]
        chosen = min(
            indexed,
            key=lambda item: (
                geometry_lib.metres(
                    platform_midpoint(item[1], geometry_lib), target
                ),
                item[0],
            ),
        )[1]
        platforms[key][group] = chosen


def extend_display_part_at_platforms(
    key,
    order,
    points,
    selected_platforms_by_group,
    platforms_by_group,
    uid_by_name,
    station_by_uid,
    geometry_lib,
):
    """Apply a registered continuation that uses another platform in one part.

    東京's underground southbound track is filed under 東海道線 in N02 while
    its northbound continuation is 総武線. The 東海道 main stroke must use the
    shared middle surface platform, but its 品鶴線 sibling must start on the
    総武地下ホーム and follow the tunnel south. That cannot be represented by
    one global platform choice per railway, so the evidence may extend exactly
    one matching part and override only that part's platform features.
    """
    names = [station_by_uid[uid]["station_name"] for uid in order]
    for row in load_station_platform_corrections()["display_part_extensions"]:
        if row["line"] != key:
            continue
        existing = row["existing_edge"]
        before = row["prepend_stations"]
        if names[: len(existing)] == existing:
            additions = [uid_by_name[name] for name in before]
            extended = additions + list(order)
        elif names[-len(existing) :] == list(reversed(existing)):
            additions = [uid_by_name[name] for name in reversed(before)]
            extended = list(order) + additions
        else:
            continue

        part_points = dict(points)
        part_platforms = dict(selected_platforms_by_group)
        for station_name, target in row["platform_midpoints"].items():
            uid = uid_by_name.get(station_name)
            if uid is None:
                raise SystemExit(
                    f"tokyo-station-platforms.json extends {key} through "
                    f"{station_name}, but that station is absent from the line"
                )
            group = station_by_uid[uid]["physical_station_group"]
            candidates = platforms_by_group.get(group) or []
            if not candidates:
                raise SystemExit(
                    f"tokyo-station-platforms.json extends {key} through "
                    f"{station_name}, but group {group} has no platform feature"
                )
            platform = min(
                candidates,
                key=lambda candidate: geometry_lib.metres(
                    platform_midpoint(candidate, geometry_lib), target
                ),
            )
            midpoint = platform_midpoint(platform, geometry_lib)
            if geometry_lib.metres(midpoint, target) > 25:
                raise SystemExit(
                    f"tokyo-station-platforms.json target for {key} {station_name} "
                    f"is no longer within 25 m of an N02 platform feature"
                )
            part_points[uid] = midpoint
            part_platforms[group] = platform
        return (
            extended,
            part_points,
            part_platforms,
            row.get("reason", ""),
            row.get("display_as_line", ""),
        )
    return list(order), points, selected_platforms_by_group, "", ""


def apply_display_part_platforms(
    key,
    order,
    part_points,
    part_platforms,
    platforms_by_group,
    uid_by_name,
    station_by_uid,
    geometry_lib,
):
    """Give ONE display stroke its own platform picks, without extending it.

    `platform_assignments` chooses one platform per (source line, station
    group), which is the right grain for a railway drawn as one stroke and the
    wrong grain for a 複々線. 東北線 is drawn as several strokes from ONE N02
    source line: the 列車線 (上野東京ライン) and the 電車線 both call at 日暮里
    and 上野, so a single pick puts both on the same platform, their shortest
    paths ride the same N02 sections, and the map paints one corridor twice
    (measured: 2,240 m of shared sections per pair, audit-section-usage.py).

    `display_part_extensions` already overrides platforms for one part, but only
    as part of extending it through extra stations. This is the same override
    without the extension: match the part by its own station sequence — in
    either direction, since a part's order is a drawing direction and not a
    fact — and repoint the named stations.

    A row whose sequence no longer matches simply does not apply; a row that
    matches but names a station the part does not carry, or a target no longer
    within 25 m of an N02 feature, stops the build. Same safety property as
    every other registered mechanism here: the survey may move under us, and
    when it does we want to hear about it.
    """
    names = [station_by_uid[uid]["station_name"] for uid in order]
    reasons = []
    for row in load_station_platform_corrections()["display_part_platforms"]:
        if row["line"] != key:
            continue
        wanted = list(row["match_stations"])
        if names != wanted and names != list(reversed(wanted)):
            continue
        for station_name, target in row["platform_midpoints"].items():
            uid = uid_by_name.get(station_name)
            if uid is None or uid not in order:
                raise SystemExit(
                    f"display_part_platforms for {key} names {station_name}, "
                    f"which this part does not carry"
                )
            group = station_by_uid[uid]["physical_station_group"]
            candidates = platforms_by_group.get(group) or []
            if not candidates:
                raise SystemExit(
                    f"display_part_platforms for {key} {station_name}: group "
                    f"{group} has no platform feature"
                )
            platform = min(
                candidates,
                key=lambda candidate: geometry_lib.metres(
                    platform_midpoint(candidate, geometry_lib), target
                ),
            )
            midpoint = platform_midpoint(platform, geometry_lib)
            if geometry_lib.metres(midpoint, target) > 25:
                raise SystemExit(
                    f"display_part_platforms target for {key} {station_name} is "
                    f"no longer within 25 m of an N02 platform feature"
                )
            part_points[uid] = midpoint
            part_platforms[group] = platform
        reasons.append(row.get("reason", ""))
    return part_points, part_platforms, "; ".join(filter(None, reasons))


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


def apply_display_line_reassignments(lines):
    """Style a cross-source through stroke as the service shown on the map.

    N02 inventories 東京's southbound 総武快速/横須賀 track as a branch of
    東海道線. Apple Maps shows that underground continuation with the blue
    総武 stroke, not with the orange surface 東海道 main line, so registered
    evidence may reassign only the display identity after the source geometry
    has built. The original source remains explicit in the evidence record.
    """
    occupied = {line["id"] for line in lines}
    style_keys = {
        "name",
        "operator",
        "rank",
        "color",
        "nameRoma",
        "colorDark",
        "colorSource",
        "kind",
        "colorPolicy",
        "labelPolicy",
        "nameNorm",
        "operatorShort",
        "logo",
        "lineCode",
        "isHSR",
        "serviceStatus",
    }
    for line in lines:
        target = line.pop("_displayAsLine", "")
        if not target:
            continue
        operator, _, name = target.partition("␟")
        base = line_id_for(operator, name)
        parent = next((candidate for candidate in lines if candidate["id"] == base), None)
        if parent is None:
            raise SystemExit(
                f"tokyo-station-platforms.json displays a stroke as {target}, "
                "but that display line was not built"
            )
        suffix = 2
        while f"{base}-{suffix}" in occupied:
            suffix += 1
        occupied.discard(line["id"])
        line["id"] = f"{base}-{suffix}"
        occupied.add(line["id"])
        for key in style_keys:
            if key in parent:
                line[key] = parent[key]
            else:
                line.pop(key, None)


def pin_compact_station(line, index, point):
    """Rewrite one compact station and every interval end encoded for it."""
    shared = [round(float(point[0]), 7), round(float(point[1]), 7)]
    line["stations"][index][2] = shared[0]
    line["stations"][index][3] = shared[1]
    segments = line["segments"]
    if index < len(segments):
        # A flag=1 interval dropped the vertex it shares with its predecessor,
        # so its first point IS the previous interval's last point.
        target = segments[index]
        if target[1]:
            if index:
                segments[index - 1][2][-1] = list(shared)
        else:
            target[2][0] = list(shared)
    if index and index - 1 < len(segments):
        segments[index - 1][2][-1] = list(shared)


def apply_registered_shared_junctions(lines):
    """Weld named cross-line continuations to one physical rail junction.

    Sapporo's two 函館線 strokes already get this contract from
    `share_junction_anchors`: separate compact strokes, one exact endpoint and
    one railway identity, so the renderer cannot assign different lanes at the
    seam. Tokyo's 東北線 and 東海道線 are different canonical names despite being
    the two halves of the same Ueno–Tokyo through rail, so their cross-family
    weld is explicit evidence rather than inferred from a shared station name.
    """
    by_id = {line["id"]: line for line in lines}
    for row in load_station_platform_corrections()["shared_junctions"]:
        targets = []
        for line_id in row["line_ids"]:
            line = by_id.get(line_id)
            if line is None:
                # Targeted builds may intentionally omit the other half. The
                # full/package build must still find at least two below.
                continue
            index = next(
                (
                    at
                    for at, station in enumerate(line["stations"])
                    if station[0] == row["station_group"]
                    and station[1] == row["station"]
                ),
                None,
            )
            if index is None:
                raise SystemExit(
                    f"{line_id} lacks registered shared junction "
                    f"{row['station']} ({row['station_group']})"
                )
            targets.append((line, index))
        if len(targets) == 1 and len(lines) > 1:
            raise SystemExit(
                f"registered shared junction {row['station']} built only one of "
                f"{row['line_ids']}"
            )
        for line, index in targets:
            pin_compact_station(line, index, row["point"])
            line["railwayIdentity"] = row["railway_identity"]


def share_junction_anchors(lines):
    """One station, one dot — even where two sibling strokes anchor it apart.

    A junction station belongs to both strokes that meet there, and across jp
    that is already how it looks: 44 such stations carry the SAME coordinate in
    every stroke. Seven did not, because each stroke anchored the station on its
    own track group and those groups stand apart — 札幌 by 208 m, which drew the
    city's main station as two dots with a hole between them instead of one point
    the lines meet at.

    The shared point is an EXISTING anchor on the canonical/main stroke, never
    an average invented between tracks.  A sibling branch is led over its real
    approach to that already surveyed platform point.  If a family has no
    unsuffixed stroke, the longest member elects the point; this is still a
    source vertex and keeps the main physical railway stable.

    A paired alignment is exempt: its whole point is that the two directions
    stop in DIFFERENT places, so 湯檜曽's two platforms 73 m apart are the fact
    being drawn, not a disagreement to average away.

    Interval ends are rewritten with the station rows, because the renderer pins
    each interval to its station row anyway (`rail-network.js:734`) and a package
    whose own two copies differ would drift.
    """
    families = collections.defaultdict(list)
    for line in lines:
        families[re.sub(r"(-p?\d+)+$", "", line["id"])].append(line)
    for railway_identity, members in families.items():
        # The family name is not merely a convenient grouping key.  Every
        # sibling display stroke, including a separately surveyed up/down
        # alignment, is one physical railway for lane computation.  Persist
        # that fact in the package so a rebuild, the browser and an external
        # audit all reach the same answer without re-inferring it from an id
        # suffix.
        #
        # An explicit cross-canonical identity (Tokyo's Ueno–Tokyo through
        # rail) belongs to the WHOLE canonical family, not only to the one
        # stroke named by the registered junction.  Leaving 東北線-2 on the
        # through identity while 東北線/-3/-4 kept the family default made the
        # parallel-corridor pass call sibling strokes independent railways.
        # Around 日暮里 that turned one 東北線 into several side-by-side lines.
        explicit_identities = {
            line["railwayIdentity"]
            for line in members
            if line.get("railwayIdentity")
        }
        if len(explicit_identities) > 1:
            raise SystemExit(
                f"{railway_identity} sibling strokes carry conflicting railway "
                f"identities: {sorted(explicit_identities)}"
            )
        family_identity = next(iter(explicit_identities), railway_identity)
        for line in members:
            line["railwayIdentity"] = family_identity
        if len(members) < 2:
            continue
        # A paired alignment exists precisely because its station/track points
        # may differ from the primary.  It shares railway identity but never
        # participates in the junction-coordinate weld below.
        weldable = [line for line in members if not line.get("alignmentRole")]
        if len(weldable) < 2:
            continue
        seats = collections.defaultdict(list)
        for line in weldable:
            for index, station in enumerate(line["stations"]):
                seats[station[0]].append((line, index))
        for group, places in seats.items():
            if len(places) < 2:
                continue
            points = [
                (line["stations"][index][2], line["stations"][index][3])
                for line, index in places
            ]
            if len(set(points)) == 1:
                continue
            elected_line, elected_index = next(
                (
                    place
                    for place in places
                    if place[0]["id"] == railway_identity
                ),
                max(
                    places,
                    key=lambda place: sum(
                        float(segment[0]) for segment in place[0]["segments"]
                    ),
                ),
            )
            shared = [
                elected_line["stations"][elected_index][2],
                elected_line["stations"][elected_index][3],
            ]
            for line, index in places:
                pin_compact_station(line, index, shared)


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
            # A run boundary is a junction, and a junction station belongs to
            # BOTH strokes — the same contract a branch already has, where the
            # branch keeps the station it leaves from so the two meet there.
            #
            # Without this the line lost the interval ACROSS the boundary. 函館線
            # is filed as two track groups either side of 札幌; 札幌's chosen
            # platform sits in the 旭川-side group while it also anchors 33 m
            # from the 桑園-side one, so the 桑園–札幌 main line — 1.314 km by the
            # audit, active, and plainly there on the ground — was drawn by
            # neither stroke and left a hole at Sapporo's own station.
            carry = []
            if runs and group is not None:
                previous = runs[-1][1][-1]
                shared = graph.project(points[previous], component=group)
                if shared is not None and shared["distance_m"] <= keep_within_m:
                    carry = [previous]
            runs.append((group, carry + [uid]))
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


def fold_back_intervals(mismatched):
    """The mismatched intervals long enough to be lead-in folds, not slack.

    `mismatched` rows are (from_name, to_name, drawn_km, audited_km). An
    interval qualifies when it is drawn PAST its audited distance by both
    REANCHOR_DETOUR_FACTOR and REANCHOR_DETOUR_FLOOR_M — the shape of a path
    that left the station the wrong way, not of a platform-projection offset.
    """
    return [
        row
        for row in mismatched
        if row[3]
        and row[2] * 1000
        > max(
            row[3] * 1000 * REANCHOR_DETOUR_FACTOR,
            row[3] * 1000 + REANCHOR_DETOUR_FLOOR_M,
        )
    ]


def refine_anchors_by_distance(order, points, graph, anchors, audited_m, pinned=frozenset()):
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

    `pinned` stations keep their standing anchor as their ONLY candidate. A
    registered platform assignment (tokyo-station-platforms.json) is a stronger
    statement than any kilometrage inference — it names the physical platform —
    so the Viterbi may route around it but never move it.
    """
    if len(order) < 2:
        return None
    component = graph.component[anchors[order[0]]["section"]]
    candidates = {
        uid: (
            [anchors[uid]]
            if uid in pinned
            else anchor_candidates(points[uid], graph, component) or [anchors[uid]]
        )
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


def declared_bypasses(
    graph,
    geometry_lib,
    order,
    anchors,
    station_by_uid,
    key,
    bypasses,
    primary_coords=(),
):
    """A sourced 別線 that SKIPS a station, so no platform test can find it.

    上越線's shape is two platforms at one station; 函館線's 藤城線 is the other
    shape entirely — 「当駅と大沼駅の間には下り線専用の別線（通称：藤城線）が
    設置されている。」 It leaves 七飯, bypasses 新函館北斗 and 仁山 altogether, and
    rejoins at 大沼, so both its endpoints have one platform each and the
    stations that WOULD have two are simply not on it.

    It cannot be found by asking for the shortest path either, because the route
    through the skipped station is the shorter of the two (13.285 km against
    13.309). That is also what defeated the skip-station test: it cuts a
    candidate edge along the shortest path, gets the route through 新函館北斗,
    and concludes the edge "runs past" a station its own track misses by 2.9 km.

    So the skipped station is named in the evidence file and excluded from the
    search outright. What comes back is verified before it is drawn: it must
    clear the same separation gate as any other pair, which is what stops this
    from becoming a way to declare track into existence.
    """
    out = []
    by_name = {station_by_uid[uid]["station_name"]: uid for uid in order}
    for (line, first, last), row in bypasses.items():
        if line != key or first not in by_name or last not in by_name:
            continue
        start_uid, end_uid = by_name[first], by_name[last]
        if start_uid not in anchors or end_uid not in anchors:
            continue
        skipped = set()
        for name in row.get("skips", []):
            uid = by_name.get(name)
            if uid is None or uid not in anchors:
                continue
            skipped.add(anchors[uid]["section"])
        if not skipped:
            continue
        cut = graph.path_between(anchors[start_uid], anchors[end_uid], exclude=skipped)
        if cut is None:
            continue
        coords = dedupe_points(cut[0])
        if len(coords) < 2:
            continue
        coords[0] = anchor_point(anchors[start_uid])
        coords[-1] = anchor_point(anchors[end_uid])
        separation = max_separation_m(coords, primary_coords)
        if separation < SEPARATED_MIN_M:
            continue
        out.append(
            {
                "separation_m": separation,
                "uids": [start_uid, end_uid],
                "points": [anchor_point(anchors[start_uid]), anchor_point(anchors[end_uid])],
                "coords": coords,
                "km": round(geometry_lib.polyline_km(coords), 3),
                "length_m": cut[1],
            }
        )
    return out


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
    bypasses=None,
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
            structure_on_cut(
                graph.to_source_pieces(pieces), measure, structure_by_section or {}
            )
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
        start_name = station_by_uid[start_uid]["station_name"]
        end_name = station_by_uid[end_uid]["station_name"]
        surveyed_primary = (surveyed or {}).get(
            ("primary", key, start_name, end_name)
        )
        if not surveyed_primary:
            # Evidence is recorded in the geographically useful direction
            # (for Tokyo, outwards from the selected platform).  The audited
            # station order is allowed to run the other way — both Shinkansen
            # terminate at Tokyo — without forcing a second, reversed copy of
            # the same registered track into the evidence file.
            reverse_survey = (surveyed or {}).get(
                ("primary", key, end_name, start_name)
            )
            if reverse_survey:
                surveyed_primary = list(reversed(reverse_survey))
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
        alternates.extend(
            declared_bypasses(
                graph,
                geometry_lib,
                order,
                anchors,
                station_by_uid,
                key,
                bypasses or {},
                primary_coords=[point for segment in segments for point in segment[2]],
            )
        )

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
                "distance for the same pair. Tokyo Station's copied Tohoku Shinkansen "
                "platform section and every Tokyo-adjacent interval selected for the two "
                "Shinkansen, shared surface through line, and Sobu/Yokosuka tunnel are "
                "replaced by registered OSM physical-track geometry; the two named "
                "halves of the Ueno–Tokyo surface rail share one junction and render lane."
            ),
            "osmGeometry": {
                "lines": [
                    "jp-東日本旅客鉄道-東北新幹線",
                    "jp-東日本旅客鉄道-東北線-2",
                    "jp-東日本旅客鉄道-東海道線",
                    "jp-東日本旅客鉄道-総武線",
                    "jp-東日本旅客鉄道-総武線-3",
                    "jp-東海旅客鉄道-東海道新幹線",
                ],
                "evidence": "data/raw/railway/jp/evidence/tokyo-station-platforms.json",
                "license": "OpenStreetMap contributors, ODbL 1.0",
            },
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


def arc_midpoint(coords, geometry_lib):
    """The point half way along an open polyline, by arc length."""
    measures = geometry_lib.route_measures(coords)
    return list(geometry_lib.point_at(coords, measures, measures[-1] / 2))


def outline_midpoint(coords, geometry_lib):
    """The centre of a CLOSED platform outline.

    An outline is not a path along the platform, it is a path AROUND it — out
    along one side and back along the other — so half its perimeter is not its
    middle, it is the far END. That is the whole of the defect this fixes: every
    one of the thirteen platforms that batch surveyed for
    station-anchor-overrides.json is a closed OSM way, and reading each as an
    open polyline put its dot 15.1 m to 187.5 m past the centre (糸魚川 landed
    on the buffer-stop end of a 313 m platform, 和歌山市 121.8 m out,
    橿原神宮前 90.6 m). Two of the thirteen have since been withdrawn to
    `reverted`, so eleven rows carry it now.

    So the ring is split at its two farthest-apart vertices — the platform's two
    ends — and the arc midpoints of the two sides averaged. That is the middle
    of the outline's own medial axis, and on all thirteen it is the only
    estimator that lands INSIDE the platform it marks:

      * the vertex mean falls outside at 横浜 and 伊予立川, and it leans on an
        accident of the data — where the ring happens to close. At 和歌山市 the
        duplicated closing corner drags it 16 m off centre, because that corner
        is counted twice out of five.
      * the midpoint of the long axis is a CHORD midpoint, so it cuts the corner
        of every curved platform: outside at 横浜, 伊予立川 and 橿原神宮前.
      * the shoelace centroid is unusable here. These outlines are slivers — 3
        to 10 m wide over 30 to 313 m — so the signed area is near zero and the
        centroid is numerically meaningless: it lands 295 m from 宮古's platform
        and 65 m from 東武日光's.

    A ring has no orientation and no start, and neither does this: the two ends
    are a property of the shape, and averaging the two sides cancels the half
    width of the end caps, which is why it agrees with the vertex mean wherever
    the vertex mean is sound (within 3.4 m on ten of the thirteen).
    """
    ring = coords[:-1]
    first, second, span = 0, 0, -1.0
    for index, point in enumerate(ring):
        for other in range(index + 1, len(ring)):
            gap = geometry_lib_metres(point, ring[other])
            if gap > span:
                span, first, second = gap, index, other

    def side(start, end):
        chain, cursor = [], start
        while True:
            chain.append(ring[cursor])
            if cursor == end:
                return chain
            cursor = (cursor + 1) % len(ring)

    middles = [
        chain[0] if len(chain) == 1 else arc_midpoint(chain, geometry_lib)
        for chain in (side(first, second), side(second, first))
    ]
    return [
        (middles[0][0] + middles[1][0]) / 2,
        (middles[0][1] + middles[1][1]) / 2,
    ]


def platform_midpoint(platform, geometry_lib):
    """A platform feature's centre.

    N02 files a station as a COPY of the track it sits on, so the centroid of a
    curved platform drifts off the track it is meant to mark — by up to ~139 m on
    the worst of them. The midpoint by arc length stays on it. No N02 station
    feature is closed (checked: 0 of 10,234), so that is the whole of the survey;
    a ring can only arrive through station_anchor_overrides, where the source is
    an OSM platform AREA, and it is measured as an outline instead.
    """
    coords = [list(point) for point in platform.coords]
    if len(coords) == 1:
        return coords[0]
    if len(coords) > 3 and coords[0] == coords[-1]:
        return outline_midpoint(coords, geometry_lib)
    return arc_midpoint(coords, geometry_lib)


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
