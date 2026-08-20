#!/usr/bin/env python3
"""Resolve and apply theme-safe display colours to every drawn railway.

Two jobs, one rule.  For **jp** the canonical colour inventory is the source of
truth: `n02-official-line-colours.csv` resolves each line to a sourced value,
and the Apple Maps survey is a line-by-line visual cross-check that replaces
only a forbidden black/white fallback or the grey stand-in a line gets when no
source names a colour at all.  Published operator colours are never silently
relabelled as official line colours.

For **tw / hk / kr / mo** the packages already carry the operator's published
colour in `color`, written there by each country's own builder, so that value
(or `colorReference`, once this script has run) IS the reference.

Then the same transform runs for every country:

* `colorReference` keeps the sourced value verbatim — that is the operator's
  colour, and it stays readable in the package whatever the map needs;
* `color` and `colorDark` are display variants that keep the reference's hue
  and saturation and move only HSL lightness, until the stroke reaches 3:1
  against this app's light (`#f2f3f0`) and dark (`#0c0c0c`) map surfaces;
* neither display value may be pure black or pure white.

Because the basemap is the neutral positron palette, 3:1 against its background
also clears every one of its area fills — park, water, buildings, landuse — by
at least 1.9:1 in light and 2.3:1 in dark.  `railway-colour-separation.test.js`
holds both halves of that contract against the vendored basemap itself.

Re-run this after ANY package rebuild that rewrites `color`, otherwise a
country's `colorReference` outlives the value its builder just changed:

    python3 scripts/railway/apply-display-colours.py --country tw
"""

from __future__ import annotations

import argparse
import colorsys
import csv
import gzip
import json
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]
COUNTRIES = ("jp", "tw", "hk", "kr", "mo")
INVENTORY = (
    APP_DIR
    / "data/raw/railway/jp/rebuild-inventory/colours/n02-official-line-colours.csv"
)
APPLE_EVIDENCE = (
    APP_DIR
    / "data/raw/railway/jp/rebuild-inventory/colours/apple-map-line-colours.csv"
)
AUDIT_OUTPUT = (
    APP_DIR
    / "data/raw/railway/jp/rebuild-inventory/colours/resolved-display-line-colours.csv"
)
KEY_SEPARATOR = "␟"
LIGHT_SURFACE = "#f2f3f0"
DARK_SURFACE = "#0c0c0c"
MIN_CONTRAST = 3.0
FORBIDDEN = {"#000000", "#ffffff"}
# A stroke this close to neutral carries no line identity; the Apple survey is
# consulted for those the sourced chain leaves grey as well as for the
# forbidden black/white ones.
MIN_CHROMA = 24
PACKAGE_OPERATOR_ALIASES = {
    "Osaka Metro": "大阪市高速電気軌道",
    "東京メトロ": "東京地下鉄",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--country", default="jp", choices=(*COUNTRIES, "all"))
    parser.add_argument("--inventory", type=Path, default=INVENTORY)
    parser.add_argument("--apple-evidence", type=Path, default=APPLE_EVIDENCE)
    parser.add_argument("--audit-output", type=Path, default=None)
    parser.add_argument("--package", type=Path, default=None)
    return parser.parse_args()


def package_path(country: str) -> Path:
    return APP_DIR / f"public/rail/{country}-2025.json"


def audit_path(country: str) -> Path:
    if country == "jp":
        return AUDIT_OUTPUT
    return APP_DIR / f"data/raw/railway/{country}/colours/resolved-display-line-colours.csv"


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def rgb(value: str) -> tuple[int, int, int]:
    value = value.strip().lower()
    if len(value) != 7 or not value.startswith("#"):
        raise ValueError(f"invalid colour: {value!r}")
    return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))


def hex_colour(value: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02x}" for channel in value)


def luminance(value: str) -> float:
    channels = []
    for channel in rgb(value):
        normal = channel / 255
        channels.append(
            normal / 12.92
            if normal <= 0.04045
            else ((normal + 0.055) / 1.055) ** 2.4
        )
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(left: str, right: str) -> float:
    high, low = sorted((luminance(left), luminance(right)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def chroma(value: str) -> int:
    red, green, blue = rgb(value)
    return max(red, green, blue) - min(red, green, blue)


def hls_colour(hue: float, lightness: float, saturation: float) -> str:
    channels = colorsys.hls_to_rgb(hue, lightness, saturation)
    return hex_colour(tuple(round(channel * 255) for channel in channels))


def display_variant(reference: str, surface: str, lighten: bool) -> str:
    """Keep hue/saturation and move only lightness until the stroke is legible."""
    reference = reference.lower()
    red, green, blue = (channel / 255 for channel in rgb(reference))
    hue, lightness, saturation = colorsys.rgb_to_hls(red, green, blue)

    # A neutral black/white reference has no recoverable line identity.  The
    # resolver replaces those from Apple evidence before reaching this point.
    if saturation < 0.08:
        saturation = 0.10
        hue = 0.58

    candidate = reference
    if candidate not in FORBIDDEN and contrast(candidate, surface) >= MIN_CONTRAST:
        return candidate

    values = range(round(lightness * 1000), 1000 if lighten else -1, 1 if lighten else -1)
    for value in values:
        candidate = hls_colour(hue, value / 1000, saturation)
        if candidate not in FORBIDDEN and contrast(candidate, surface) >= MIN_CONTRAST:
            return candidate
    raise ValueError(f"cannot produce a contrasting display colour from {reference}")


def apple_validation(reference: str, apple: dict | None) -> str:
    if not apple or not apple.get("apple_map_sample_hex"):
        return "not_detected"
    distance = float(apple.get("apple_map_sample_distance_from_prior") or 1)
    confidence = apple.get("apple_map_sample_confidence", "none")
    if distance <= 0.10 and confidence in {"high", "medium"}:
        return "matched"
    if distance <= 0.16:
        return "approximate"
    return "ambiguous_or_conflicting"



def japan_reference_rows(args) -> tuple[list[dict], dict]:
    """The jp inventory resolved to one reference colour per canonical line."""
    inventory_rows = read_csv(args.inventory)
    apple = {row["canonical_key"]: row for row in read_csv(args.apple_evidence)}
    rows = []
    counters = {"black_white_replaced_from_apple": 0, "neutral_replaced_from_apple": 0}
    for row in inventory_rows:
        key = row["canonical_key"]
        evidence = apple.get(key)
        reference = row["render_color_hex"].lower()
        basis = row["render_color_basis"]
        source = row["render_color_source_url"]
        sample = (evidence or {}).get("apple_map_sample_hex", "").lower()
        usable_sample = bool(
            sample and sample not in FORBIDDEN and chroma(sample) >= MIN_CHROMA
        )
        if reference in FORBIDDEN:
            if not usable_sample:
                raise ValueError(f"black/white line has no usable Apple sample: {key}")
            reference = sample
            basis = "apple_map_sample_replaces_black_white_fallback"
            source = (evidence or {}).get("apple_map_source", "")
            counters["black_white_replaced_from_apple"] += 1
        elif basis == "neutral_fallback" and usable_sample:
            # No source anywhere names a colour for this line.  Apple draws one,
            # and a sampled chromatic stroke says more than the grey stand-in —
            # recorded as raster evidence, never as an operator value.
            reference = sample
            basis = "apple_map_sample_replaces_neutral_fallback"
            source = (evidence or {}).get("apple_map_source", "")
            counters["neutral_replaced_from_apple"] += 1
        rows.append(
            {
                "key": key,
                "operator": row["operator"],
                "line": row["line"],
                "reference": reference,
                "basis": basis,
                "source": source,
                "apple_map_sample_hex": (evidence or {}).get("apple_map_sample_hex", ""),
                "apple_map_confidence": (evidence or {}).get(
                    "apple_map_sample_confidence", "none"
                ),
                "apple_map_validation": apple_validation(
                    row["render_color_hex"].lower(), evidence
                ),
            }
        )
    return rows, counters


def authored_reference_rows(package: dict) -> tuple[list[dict], dict]:
    """tw / hk / kr / mo: the builder already wrote the operator's own colour.

    `colorReference` wins once it exists, so re-running is idempotent; a line
    that has neither is a package defect, not something to paint grey.
    """
    rows = []
    missing = []
    for line in package["lines"]:
        reference = (line.get("colorReference") or line.get("color") or "").lower()
        if not reference:
            missing.append(line["id"])
            continue
        if reference in FORBIDDEN:
            raise ValueError(f"{line['id']}: authored colour is black/white")
        rows.append(
            {
                "key": line["id"],
                "operator": line.get("operator", ""),
                "line": line.get("name", ""),
                "reference": reference,
                "basis": "package_authored_line_color",
                "source": line.get("colorSource", ""),
            }
        )
    if missing:
        raise ValueError(f"package lines without any colour: {missing[:10]}")
    return rows, {}


def apply_country(country: str, args) -> dict:
    package_file = args.package or package_path(country)
    audit_file = args.audit_output or audit_path(country)
    package = json.loads(package_file.read_text(encoding="utf-8"))

    if country == "jp":
        rows, counters = japan_reference_rows(args)
    else:
        rows, counters = authored_reference_rows(package)

    resolved = {}
    audit = []
    adjusted_light = 0
    adjusted_dark = 0
    for row in rows:
        reference = row["reference"]
        light = display_variant(reference, LIGHT_SURFACE, lighten=False)
        dark = display_variant(reference, DARK_SURFACE, lighten=True)
        adjusted_light += light != reference
        adjusted_dark += dark != reference
        resolved[row["key"]] = {
            "reference": reference,
            "light": light,
            "dark": dark,
            "source": row["source"],
        }
        entry = {
            "canonical_key" if country == "jp" else "line_id": row["key"],
            "operator": row["operator"],
            "line": row["line"],
            "reference_color_hex": reference,
            "reference_basis": row["basis"],
            "reference_source_url": row["source"],
        }
        if country == "jp":
            entry.update(
                {
                    "apple_map_sample_hex": row["apple_map_sample_hex"],
                    "apple_map_confidence": row["apple_map_confidence"],
                    "apple_map_validation": row["apple_map_validation"],
                }
            )
        entry.update(
            {
                "display_color_light_hex": light,
                "display_color_dark_hex": dark,
                "light_surface_hex": LIGHT_SURFACE,
                "dark_surface_hex": DARK_SURFACE,
                "light_contrast": f"{contrast(light, LIGHT_SURFACE):.3f}",
                "dark_contrast": f"{contrast(dark, DARK_SURFACE):.3f}",
                "light_adjusted": int(light != reference),
                "dark_adjusted": int(dark != reference),
            }
        )
        audit.append(entry)

    unmatched = []
    for line in package["lines"]:
        if country == "jp":
            operator = PACKAGE_OPERATOR_ALIASES.get(line["operator"], line["operator"])
            key = f'{operator}{KEY_SEPARATOR}{line["name"]}'
        else:
            key = line["id"]
        colour = resolved.get(key)
        if not colour:
            unmatched.append(key)
            continue
        line["colorReference"] = colour["reference"]
        line["color"] = colour["light"]
        line["colorDark"] = colour["dark"]
        if colour["source"]:
            line["colorSource"] = colour["source"]
    if unmatched:
        raise ValueError(
            f"package lines absent from the colour inventory: {unmatched[:10]}"
        )

    if country == "jp":
        package.setdefault("attributeSources", {})["colours"] = (
            "data/raw/railway/jp/colours/sources.md (per-value provenance); "
            "data/raw/railway/jp/rebuild-inventory/colours/apple-map-line-colours.csv "
            "(line-by-line raster cross-check); resolved-display-line-colours.csv "
            "(theme contrast transformations)"
        )
    else:
        package.setdefault("attributeSources", {})["colours"] = (
            "operator-published line colours carried by this package's builder "
            f"(colorReference); data/raw/railway/{country}/colours/"
            "resolved-display-line-colours.csv (theme contrast transformations)"
        )

    audit_file.parent.mkdir(parents=True, exist_ok=True)
    with audit_file.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(audit[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(audit)

    raw = (json.dumps(package, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    package_file.write_bytes(raw)
    with package_file.with_suffix(package_file.suffix + ".gz").open("wb") as raw_gzip:
        with gzip.GzipFile(
            filename="", mode="wb", fileobj=raw_gzip, compresslevel=9, mtime=0
        ) as stream:
            stream.write(raw)

    return {
        "country": country,
        "reference_lines": len(audit),
        "package_lines": len(package["lines"]),
        **counters,
        "light_variants_adjusted": adjusted_light,
        "dark_variants_adjusted": adjusted_dark,
        "audit": str(audit_file),
    }


def main() -> None:
    args = parse_args()
    countries = COUNTRIES if args.country == "all" else (args.country,)
    if len(countries) > 1 and (args.package or args.audit_output):
        raise SystemExit("--package/--audit-output apply to a single country")
    report = [apply_country(country, args) for country in countries]
    print(json.dumps(report if len(report) > 1 else report[0], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
