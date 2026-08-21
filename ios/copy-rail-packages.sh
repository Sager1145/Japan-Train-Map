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

echo "copied 5 rail packages and the string catalog into $target_dir"
