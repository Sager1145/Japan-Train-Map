#!/bin/sh
# The gate. Everything the port has to survive, in one command.
#
# Porting runs in parallel, so "it compiles on my branch" is not a useful
# report — this is what every piece of work is checked against before it is
# claimed to be done, and it is the same command whether a person or an agent
# runs it.
#
#   ./verify.sh            everything
#   ./verify.sh --swift    Swift + app build
#   ./verify.sh --core     RailCore + its parity tests only (the porting loop)
#   ./verify.sh --js       JavaScript only
#
# SCRATCH lets parallel workers avoid fighting over one build directory:
#
#   SCRATCH=/tmp/port-a ./verify.sh --swift
#
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)

# The repository is on an iCloud-backed path. The file provider re-adds
# com.apple.FinderInfo to build products and codesign then refuses to sign
# them ("resource fork, Finder information, or similar detritus not allowed"),
# so the build directory has to live off the synced volume.
scratch=${SCRATCH:-${TMPDIR:-/tmp}railkit-verify}

# Prefer the beta toolchain when it is installed, because that is what this
# port is developed against — but only when it is actually there, or CI (and
# anyone with a plain Xcode) inherits a path that does not exist.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode-beta.app ]; then
    DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
    export DEVELOPER_DIR
fi

run_js=1
run_swift=1
run_app=1
case "${1:-}" in
    --swift) run_js=0 ;;
    # --core skips the app build: several ports can run at once, and the
    # simulator build is both the slowest step and the one that does not
    # contend well.
    --core) run_js=0; run_app=0 ;;
    --js) run_swift=0; run_app=0 ;;
    "") ;;
    *) echo "usage: verify.sh [--swift|--core|--js]" >&2; exit 2 ;;
esac

fail() { echo "FAIL: $1" >&2; exit 1; }

if [ "$run_js" = 1 ]; then
    echo "== JavaScript =================================================="
    cd "$repo/app"

    # The web app is the reference implementation. If its behaviour moved, the
    # fixtures are stale and every Swift result checked against them is
    # meaningless, so this runs first.
    npm test >/dev/null 2>&1 || fail "npm test"
    echo "  tests pass"

    npm run lint >/dev/null 2>&1 || fail "npm run lint"
    echo "  lint passes"

    # --check regenerates into memory and fails if anything moved. A fixture
    # may only change deliberately: a diff here is the list of answers the
    # Swift port has to be re-verified against.
    node scripts/build/build-port-fixtures.mjs --check >/dev/null 2>&1 \
        || fail "fixtures are stale — rerun build-port-fixtures.mjs and review the diff"
    echo "  fixtures match the code that generated them"
fi

if [ "$run_swift" = 1 ]; then
    echo "== Swift ======================================================="
    cd "$here/RailKit"

    swift build --scratch-path "$scratch" >/dev/null 2>&1 || {
        swift build --scratch-path "$scratch" 2>&1 | grep -E 'error:' | head -20
        fail "swift build"
    }
    echo "  RailCore builds"

    if ! swift test --scratch-path "$scratch" >"$scratch.log" 2>&1; then
        grep -E '^✘|error:' "$scratch.log" | head -30
        fail "swift test (full log: $scratch.log)"
    fi
    passed=$(grep -cE '^✔ Test ' "$scratch.log" || true)
    echo "  $passed parity tests pass"

    # RailCore must not reach for a platform. That constraint is what makes the
    # port checkable at all — with no platform underneath it, the same code can
    # be run against the same fixtures as the JavaScript. Enforced here because
    # a stray `import MapKit` compiles perfectly well and quietly ends that.
    if grep -rlE '^import (MapKit|SwiftUI|UIKit|CoreLocation)' Sources/RailCore/ 2>/dev/null | grep .; then
        fail "RailCore imported a platform framework (see the files above)"
    fi
    echo "  RailCore imports nothing but Foundation"
fi

if [ "$run_app" = 1 ] && [ "$run_swift" = 1 ]; then
    echo "== app ========================================================="
    cd "$here"
    xcodebuild -project RailMap.xcodeproj -scheme RailMap -sdk iphonesimulator \
        -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
        -derivedDataPath "$scratch-app" build >"$scratch-app.log" 2>&1 \
        || { grep -E 'error: ' "$scratch-app.log" | head -20; fail "app build"; }
    echo "  RailMap.app builds"
fi

echo "OK"
