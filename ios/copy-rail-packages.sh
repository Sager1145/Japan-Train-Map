#!/bin/sh
# Xcode build phase: put the shipped rail packages into the app bundle.
#
# They are read straight out of app/public/rail rather than copied into the
# iOS target's own sources, because `*-2025.json` is a cross-language data
# contract (REFACTOR_FOR_SWIFT_FORK_PROMPT.md §三 contract 7). A second
# committed copy is a copy that drifts: the first time a package is
# regenerated and the iOS one is not, the two apps disagree about where a
# railway is and nothing reports it.
#
# Run standalone for a non-Xcode build, or let the "Copy rail packages" phase
# run it. When run outside Xcode it needs a destination as $1.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
source_dir="$here/../app/public/rail"

if [ -n "${BUILT_PRODUCTS_DIR:-}" ] && [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]; then
    target_dir="$BUILT_PRODUCTS_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
else
    target_dir="${1:?usage: copy-rail-packages.sh <destination>}"
fi

mkdir -p "$target_dir"

for country in jp tw hk mo kr; do
    package="$source_dir/$country-2025.json"
    if [ ! -f "$package" ]; then
        echo "error: missing $package — is the repository complete?" >&2
        exit 1
    fi
    cp -p "$package" "$target_dir/$country-2025.json"
done

# The route pipeline reads three additional country-scoped datasets. They are
# copied under the web app's own resource names so the native loader can apply
# the same `countrySuffixed` rule without maintaining a second manifest.
for country in jp tw hk mo kr; do
    if [ "$country" = "jp" ]; then
        suffix=""
    else
        suffix="-$country"
    fi

    for family in stations rail-sections station-readings; do
        resource="$here/../app/data/$family$suffix.json"
        if [ ! -f "$resource" ]; then
            echo "error: missing $resource — the native route pipeline cannot load $country" >&2
            exit 1
        fi
        cp -p "$resource" "$target_dir/$family$suffix.json"
    done
done

# The operator and line badges the C5 station popup draws.
#
# `OperatorBranding.logoForLine` returns a WEB PATH — `/rail/logos/<id>.png`,
# `/rail/line-logos/<key>.png` or `/rail/operator-logos/jp-badges/badge-NNN.png`
# — because the rule is ported verbatim from the JavaScript and the JavaScript
# hands those straight to an <img>. Copying the three directories under the
# same relative names means the native side can resolve a path by stripping the
# leading slash instead of maintaining a second mapping that could disagree
# with the ported one.
#
# ~6 MB over 519 files. That is the whole set: which badge a line draws is a
# per-line decision made by a table, so shipping a subset would mean shipping
# the table's answer rather than the table.
for family in logos line-logos operator-logos; do
    source="$source_dir/$family"
    if [ ! -d "$source" ]; then
        echo "error: missing $source — the station popup cannot draw its badges" >&2
        exit 1
    fi
    /usr/bin/ditto "$source" "$target_dir/rail/$family"
done

# The legacy matched pair is still the instant route source for stores whose
# ids it covers, and the progressive sample parts carry a precomputed route for
# every bundled sample train. Keeping those parts lets the native app draw the
# shipped journeys before it ever has to invoke the on-device solver.
for resource in matched-routes matched-stops; do
    file="$here/../app/data/$resource.json"
    if [ ! -f "$file" ]; then
        echo "error: missing $file" >&2
        exit 1
    fi
    cp -p "$file" "$target_dir/$resource.json"
done

for dataset in \
    sample-data sample-data-tw sample-data-hk sample-data-mo sample-data-kr \
    new-year-grand-loop-data tokyo-limited-express-loop-data
do
    source="$here/../app/data/$dataset"
    if [ ! -d "$source" ]; then
        echo "error: missing $source" >&2
        exit 1
    fi
    /usr/bin/ditto "$source" "$target_dir/$dataset"
done

# The string catalog goes in as raw JSON, under a .json name, and it lives in
# ios/Resources rather than ios/RailMap on purpose.
#
# Inside the target's synchronized folder Xcode would recognise a .xcstrings
# file and *compile* it into per-language .lproj/Localizable.strings, and the
# raw JSON would never reach the bundle. RailCore needs the raw file: the
# lookup rules here are the web app's, not Foundation's — a four-language
# fallback chain, a country-variant key rule, and {name} placeholders that
# String(format:) does not speak. NSLocalizedString implements none of that.
catalog="$here/Resources/Localizable.xcstrings"
if [ ! -f "$catalog" ]; then
    echo "error: missing $catalog — run: cd app && node scripts/build/build-port-fixtures.mjs" >&2
    exit 1
fi
cp -p "$catalog" "$target_dir/Localizable.json"

# Every sample itinerary the web app can load, under the same names. Same rule
# as the rail packages: read from app/data rather than copied into the iOS
# target, because they are the files the web app itself reads and a second
# committed copy is a copy that drifts.
#
# The five country stores plus the two special itineraries are exactly the set
# behind index.html's 載入*示例資料 buttons.
for store in train-store train-store-tw train-store-hk train-store-mo train-store-kr; do
    file="$here/../app/data/$store.json"
    if [ -f "$file" ]; then
        cp -p "$file" "$target_dir/$store.json"
    else
        echo "note: $file absent — that sample will not be offered" >&2
    fi
done

for sample in new-year-grand-loop tokyo-limited-express-loop; do
    file="$here/../app/data/special-samples/$sample.json"
    if [ -f "$file" ]; then
        cp -p "$file" "$target_dir/$sample.json"
    else
        echo "note: $file absent — that sample will not be offered" >&2
    fi
done

echo "copied map, route, localization and sample resources into $target_dir"
