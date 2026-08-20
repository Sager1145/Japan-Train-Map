"""Current-service status, from the edge table to the package's `serviceSpans`.

ONE authority: the `network_status` column of
`rebuild-inventory/stations/n02-station-connections.csv`, which is edge-level
and therefore able to say what every layer above it needs to say — that 肥薩線
carries trains over 37 of its 124 km and none over the other 87. Everything
else about service status is DERIVED here and never hand-maintained:

  * a line's `serviceSpans` — the runs of consecutive intervals that share a
    non-active status, as [firstStation, lastStation, code] over the line's own
    station order;
  * a line's `serviceStatus` string — the bare status when every interval is
    non-active, `partial_<status>` when only some are.

Two hand-kept copies of the same fact drift; the 2026-08-13 audit already had
線-level and edge-level columns saying different things about 陸羽西線 the day
after it was written.

Why station ORDINALS and not metres. `structure` rows measure metres along the
N02 walk, but the drawn line is re-anchored to its platforms, cut at branch
junctions, trimmed of folds and smoothed of kinks before it reaches the screen
(rail-network.js displayPartsForLine), so N02 metres and display metres are not
the same ruler — which is why nothing in app/public/ has ever read `structure`.
Station ordinals survive all of it, because the stations are what those passes
anchor TO.

Skip edges are not span boundaries. 肥薩線's ledger carries 人吉↔矢岳 and
矢岳↔吉松 alongside the adjacent edges — the graph's way of recording the 大畑
and 真幸 reversals — so the run-length pass reads ADJACENT edges only and lets
the skip edges be redundant. `unmatched_skip_edges` reports any skip edge whose
endpoints are NOT already inside a derived span, which would mean a real gap
rather than a reversal.
"""

from __future__ import annotations

# The ledger's four values, in the order they appear in
# evidence/service-status-2026-08-13.json. The integers are the package's wire
# form; the strings stay the human-facing name everywhere else.
STATUS_CODES = {
    "service_suspended": 1,
    "substitute_bus": 2,
    "no_passenger_train": 3,
    "all_trains_pass": 4,
}
CODE_STATUS = {code: status for status, code in STATUS_CODES.items()}


def edge_status_index(connection_rows):
    """{(line_key, frozenset(uidA, uidB)): status} for every non-active edge.

    `line_key` is the builder's own `f"{operator}␟{line}"`. Rows are directed
    and an undirected edge appears twice; both carry the same status, and a
    disagreement is a data error worth raising rather than silently resolving.
    """
    index = {}
    for row in connection_rows:
        status = (row.get("network_status") or "active").strip()
        if not status or status == "active":
            continue
        if status not in STATUS_CODES:
            raise ValueError(f"unknown network_status {status!r}")
        key = f"{row['from_operator']}␟{row['line']}"
        edge = (key, frozenset((row["from_station_uid"], row["to_station_uid"])))
        previous = index.get(edge)
        if previous is not None and previous != status:
            raise ValueError(
                f"{row.get('connection_uid')}: {previous} and {status} on one edge"
            )
        index[edge] = status
    return index


def edge_status_index_by_group(connection_rows, operator_aliases=None):
    """The same index, in the alphabet a FINISHED package speaks.

    The builder knows stations by `operator␟group` uid and operators by their
    raw N02 name; a published line knows stations by bare group code (its
    `stations[i][0]`) and operators by the package's alias for them. Same
    derivation either way — `service_spans` treats both key kinds as opaque —
    so a tool reading the package can reach the identical spans without
    re-running the geometry build.
    """
    aliases = operator_aliases or {}
    index = {}
    for row in connection_rows:
        status = (row.get("network_status") or "active").strip()
        if not status or status == "active":
            continue
        if status not in STATUS_CODES:
            raise ValueError(f"unknown network_status {status!r}")
        operator = row["from_operator"]
        key = f"{aliases.get(operator, operator)}␟{row['line']}"
        edge = (key, frozenset((row["from_station_group"], row["to_station_group"])))
        previous = index.get(edge)
        if previous is not None and previous != status:
            raise ValueError(
                f"{row.get('connection_uid')}: {previous} and {status} on one edge"
            )
        index[edge] = status
    return index


def service_spans(line_key, station_uids, edge_status):
    """The line's non-active runs as [firstStation, lastStation, code].

    Adjacent intervals sharing one status merge into a single span; a change of
    status starts a new one. Returns [] for a line with nothing to say, which is
    the signal to omit the field entirely.
    """
    if len(station_uids) < 2:
        return []
    interval_status = [
        edge_status.get((line_key, frozenset((first, second))))
        for first, second in zip(station_uids, station_uids[1:])
    ]
    spans = []
    index = 0
    while index < len(interval_status):
        status = interval_status[index]
        if status is None:
            index += 1
            continue
        end = index
        while end + 1 < len(interval_status) and interval_status[end + 1] == status:
            end += 1
        spans.append([index, end + 1, STATUS_CODES[status]])
        index = end + 1
    return spans


def unmatched_skip_edges(line_key, station_uids, edge_status, spans):
    """Ledger edges that skip a station and are NOT covered by a derived span.

    A reversal's skip edge is redundant with the adjacent ones and lands inside
    a span; anything else means the run-length pass has lost track the ledger
    claims, and the caller should refuse rather than draw it solid.
    """
    seat = {uid: index for index, uid in enumerate(station_uids)}
    covered = [False] * max(0, len(station_uids) - 1)
    for first, last, _code in spans:
        for index in range(first, last):
            covered[index] = True
    missed = []
    for (key, edge), status in edge_status.items():
        if key != line_key:
            continue
        seats = sorted(seat[uid] for uid in edge if uid in seat)
        if len(seats) != 2 or seats[1] - seats[0] == 1:
            continue
        if all(covered[index] for index in range(seats[0], seats[1])):
            continue
        missed.append((seats[0], seats[1], status))
    return sorted(missed)


def line_service_status(spans, station_count):
    """The line-level string, derived from the spans it summarises.

    Bare status when every interval of the line is non-active and they agree;
    `partial_<status>` otherwise. `None` when there is nothing to report.
    """
    if not spans:
        return None
    statuses = {CODE_STATUS[span[2]] for span in spans}
    covered = sum(span[1] - span[0] for span in spans)
    whole = station_count >= 2 and covered == station_count - 1
    if whole and len(statuses) == 1:
        return next(iter(statuses))
    # A mixed-status line reports the gravest one it carries; the spans keep the
    # detail, and the code order IS the severity order.
    gravest = CODE_STATUS[min(span[2] for span in spans)]
    return f"partial_{gravest}"
