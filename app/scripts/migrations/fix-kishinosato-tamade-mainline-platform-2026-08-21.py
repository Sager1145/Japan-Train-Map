#!/usr/bin/env python3
"""Un-file the 高野線's platform from 南海本線 at 岸里玉出 (2026-08-21).

N02-25 gives station group 007517 two platform features and files BOTH under
BOTH line names at this station:

    高野線   007517  (135.496135,34.62866)  and  (135.494295,34.62813)
    南海本線 007518  (135.496135,34.62866)  and  (135.494295,34.62813)

Only one of those four rows is not a fact. 岸里玉出 has four platforms and five
tracks, and 南海 lists them east to west as 高野線 1・2番線 (相対式2面2線),
南海本線 3・4番線 (島式1面2線) and the 汐見橋線 stub at 6番線 — far enough apart
that the company directs 本線 ⇄ 高野線 transfers to 天下茶屋 instead. Measured
against the OSM platform areas, which carry the 番線 numbers directly:

    (135.496135,34.62866)   1.5 m from ref=1 (way/395284508)
                            7.4 m from ref=2 (way/395284511)
                          142.1 m from ref=3;4 (way/388952261)
    (135.494295,34.62813)   4.2 m from ref=3;4
                          177.0 m from ref=1

So the eastern point is the 高野線's platform, and 南海本線 has no platform
there at all — 5番線 is the 本線上り 通過線 and carries no platform by name.

What that costs the map: `resolveStationForTrain` breaks a tie between two
candidates by which one stands nearer the train's other stops, which is the
right rule for two stations of the same name in different cities and no rule
at all for two platforms of one station. Coming down from 天下茶屋 the eastern
point wins, so all three 南海本線 rides in the store — 20260730_07_nankai_sakai,
20260731_01_nankai_shinimamiya and 20260731_02_rapit_alpha3 — put their
岸里玉出 stop on the 高野線's island, 151 m off the rail they are drawn on, and
`canonicalizeRouteFeature`'s snap then swung a 90° chord out to reach it and
another one back. That elbow is what a reader sees at z17.

This deletes the one mis-filed row. Nothing is moved and no geometry is
imported: the 南海本線 keeps its own official feature, and the 高野線 keeps
BOTH of its own — the eastern one is 1・2番線, and the western one is the
closest official feature to the 汐見橋線's 6番線 stub, which N02 does not
survey separately.

The drawn network is corrected separately, by
scripts/railway/fix-kishinosato-koya-platform.mjs and the
`display_part_platforms` row beside it.

Sources:
  * ja.wikipedia 岸里玉出駅 のりば: 「高野線ホーム（1・2番線）は相対式の2面2線。
    南海本線ホーム（3・4番線）は島式1面2線……汐見橋線ホーム（6番線）は単式
    1面1線」, and 5番線 as a 本線上り pass-through track with no platform.
  * OpenStreetMap (ODbL) platform areas way/395284508 (ref 1), way/395284511
    (ref 2), way/388952261 (ref 3;4), way/388952260 (ref 6), read 2026-08-21.

Re-run `npm run precompute` afterwards; the precomputed parts under
app/data/sample-data are where the rides' geometry actually lives.
"""

import json
import pathlib

APP_DIR = pathlib.Path(__file__).resolve().parents[2]
STATIONS = APP_DIR / "data" / "stations.json"

GROUP = "007517"
LINE = "南海本線"
OPERATOR = "南海電気鉄道"
KOYA_PLATFORM = [135.496135, 34.62866]
MAIN_LINE_PLATFORM = [135.494295, 34.62813]


def main() -> None:
    raw = STATIONS.read_text(encoding="utf-8")
    document = json.loads(raw)
    features = document["features"]

    def is_group(feature: dict) -> bool:
        properties = feature["properties"]
        return (
            properties.get("N02_004") == OPERATOR
            and properties.get("N02_003") == LINE
            and properties.get("N02_005g") == GROUP
        )

    rows = [feature for feature in features if is_group(feature)]
    points = [feature["properties"]["display_point"] for feature in rows]
    if points == [MAIN_LINE_PLATFORM]:
        print(f"{LINE} {GROUP}: already carries only its own platform")
        return
    if sorted(map(tuple, points)) != sorted(
        map(tuple, [KOYA_PLATFORM, MAIN_LINE_PLATFORM])
    ):
        raise SystemExit(
            f"N02 now files {LINE} {GROUP} at {points}; this migration knows "
            f"only {[MAIN_LINE_PLATFORM, KOYA_PLATFORM]}"
        )

    dropped = [
        feature
        for feature in rows
        if feature["properties"]["display_point"] == KOYA_PLATFORM
    ]
    if len(dropped) != 1:
        raise SystemExit(
            f"expected exactly one {LINE} row on the 高野線 platform, found "
            f"{len(dropped)}"
        )
    document["features"] = [feature for feature in features if feature is not dropped[0]]

    STATIONS.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"{LINE} {GROUP}: dropped the 高野線 platform row "
        f"({KOYA_PLATFORM[0]},{KOYA_PLATFORM[1]}); "
        f"{len(document['features'])} station features remain"
    )


if __name__ == "__main__":
    main()
