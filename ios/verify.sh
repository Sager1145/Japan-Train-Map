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
    echo "  RailCore and RailPresentation build"

    if ! swift test --scratch-path "$scratch" >"$scratch.log" 2>&1; then
        grep -E '^✘|error:' "$scratch.log" | head -30
        fail "swift test (full log: $scratch.log)"
    fi
    # Counted rather than described as "parity tests": most of them are, but
    # RailPresentationTests checks an invariant no fixture can express — that
    # one set of inputs resolves to one primary action — and calling that a
    # parity test would misreport what the number means.
    passed=$(grep -cE '^✔ Test ' "$scratch.log" || true)
    echo "  $passed tests pass"

    # Warnings in our own sources fail the gate.
    #
    # Not pedantry: six ports can be in flight at once, each writing a
    # thousand-odd lines, and a warning nobody owns is one nobody fixes. Scoped
    # to RailCore, RailPresentation and RailMap so an SDK or toolchain warning
    # cannot fail a build for something we did not write and cannot fix.
    warnings=$(swift build --scratch-path "$scratch" 2>&1 \
        | grep 'warning:' \
        | grep -E '/(RailCore|RailPresentation|RailMap)/' \
        | sort -u)
    if [ -n "$warnings" ]; then
        echo "$warnings"
        fail "warnings in our own sources"
    fi
    echo "  no warnings in RailCore or RailPresentation"

    # RailCore must not reach for a platform. That constraint is what makes the
    # port checkable at all — with no platform underneath it, the same code can
    # be run against the same fixtures as the JavaScript. Enforced here because
    # a stray `import MapKit` compiles perfectly well and quietly ends that.
    #
    # RailPresentation is held to the same ban for the same reason. It is the
    # display-state tier of JRM_FLIGHTY_UI_REFACTOR_SPEC.md §11 — the thing that
    # decides which single task a surface is about — and the only reason that
    # decision is testable at all is that it is made without a view underneath
    # it. One `import SwiftUI` and the priority resolver is back inside the app
    # target, where nothing runs it.
    if grep -rlE '^import (MapKit|SwiftUI|UIKit|CoreLocation)' \
        Sources/RailCore/ Sources/RailPresentation/ 2>/dev/null | grep .; then
        fail "a pure target imported a platform framework (see the files above)"
    fi
    echo "  RailCore imports nothing but Foundation"

    # And RailPresentation nothing but Foundation and RailCore: it may consume
    # the ported business logic, never the app's storage or map objects.
    if grep -rhE '^import ' Sources/RailPresentation/ 2>/dev/null \
        | sort -u | grep -vE '^import (Foundation|RailCore)$' | grep .; then
        fail "RailPresentation imported something other than Foundation/RailCore (above)"
    fi
    echo "  RailPresentation imports nothing but Foundation and RailCore"

    # Both renderers decimate, and how far the drawn line may leave the
    # surveyed one is ONE number they have to agree on.
    #
    # Nothing else can catch a disagreement. The DisplayParts fixtures compare
    # the two apps' line geometry BEFORE either of them simplifies, so for as
    # long as this app decimated at 0.5 against the web app's 0.0625 every
    # parity test passed while the drawn line stood eight times further off the
    # track — a difference visible on the map and nowhere in the suite. This is
    # a text contract for the same reason `${API_BASE}` is: the style tier is
    # the one part of the web app that does not port as data.
    js_tolerance=$(grep -oE 'SEGMENT_SIMPLIFY_TOLERANCE_PX = [0-9.]+' \
        "$repo/app/public/railmap-style.js" | sed 's/.*= //')
    swift_tolerance=$(grep -oE 'simplifyTolerance: Double = [0-9.]+' \
        "$here/RailMap/RailStyle.swift" | sed 's/.*= //')
    [ -n "$js_tolerance" ] || fail "SEGMENT_SIMPLIFY_TOLERANCE_PX not found in railmap-style.js"
    [ "$js_tolerance" = "$swift_tolerance" ] || fail \
        "simplify tolerance disagrees: railmap-style.js $js_tolerance, RailStyle.swift ${swift_tolerance:-none}"

    # Equal declarations are not enough: the regression this contract exists
    # for lived in the final MapKit renderer, below every geometry parity test.
    # Keep the renderer wired to the shared value, and keep both subjects of
    # the contract — the complete network and ridden routes — on that one
    # epsilon. A new third simplifier is review-worthy rather than something
    # this textual gate should silently bless.
    grep -q '\* RailStyle\.simplifyTolerance' \
        "$here/RailMap/RailMapView.swift" \
        || fail "RailMapView no longer derives epsilon from RailStyle.simplifyTolerance"
    renderer_simplifiers=$(grep -c \
        'Geometry\.douglasPeuckerIndices(.*epsilonMeters: epsilon)' \
        "$here/RailMap/RailMapView.swift" || true)
    [ "$renderer_simplifiers" = 2 ] || fail \
        "expected network and ridden-route simplifiers to share epsilon; found $renderer_simplifiers"
    echo "  both renderers decimate to the same $js_tolerance pt"

    # The five packages are WGS84 and must stay that way for the WebUI, but
    # Apple's Taiwan, Hong Kong, Macao and Korea basemaps are presented in GCJ-02.
    # Keep the datum correction
    # at the MapKit boundary and on every subject that can be drawn: network
    # lines, network stations and ridden routes. The latter keeps its WGS84
    # copy for statistics and the on-disk route cache, or fixing the picture
    # would silently break route classification and double-shift cached rides.
    datum_network_calls=$(grep -c 'AppleMapDatum\.display' \
        "$here/RailMap/RailNetworkStore.swift" || true)
    [ "$datum_network_calls" = 2 ] || fail \
        "expected Apple datum conversion on network lines and stations; found $datum_network_calls"
    grep -q 'self\.coordinates = AppleMapDatum\.display(coordinates, country: country)' \
        "$here/RailMap/RiddenRouteStore.swift" \
        || fail "ridden routes no longer enter MapKit through AppleMapDatum"
    grep -q 'coordinates: \$0\.sourceCoordinates\.map' \
        "$here/RailMap/RiddenRouteStore.swift" \
        || fail "route cache no longer preserves canonical WGS84 coordinates"
    grep -q 'lines: \[segment\.sourceCoordinates\]' \
        "$here/RailMap/RailMapView.swift" \
        || fail "ridden-line statistics no longer use canonical WGS84 coordinates"
    grep -q 'gcj02Countries: Set<String> = \["tw", "hk", "mo", "kr"\]' \
        "$here/RailMap/AppleMapDatum.swift" \
        || fail "Apple datum correction is no longer scoped to Taiwan, Hong Kong, Macao and Korea"
    echo "  Taiwan, Hong Kong, Macao and Korea enter Apple Maps in GCJ-02; shared data stays WGS84"

    # A station hands Apple Maps a PLACE, and every link to one is built in the
    # single tier that is tested.
    #
    # The card used to assemble `maps.apple.com/?ll=…&q=…` inline, which is a
    # dropped pin: it arrives at the other end with no exits, no platforms and
    # no name of its own. `StationPlaceLink` is where both links now come from
    # — `/place?place-id=` for a resolved station and the captioned pin for a
    # station no map service could answer for — and it is checked by
    # `StationPlaceLinkTests` against recorded live answers. A second builder
    # anywhere would be a link nothing tests, so there may not be one.
    builders=$(grep -rl 'maps\.apple\.com' --include='*.swift' \
        "$here/RailMap" "$here/RailKit/Sources" "$here/RailMapUITests" "$here/tools" \
        2>/dev/null | grep -v 'StationPlaceLink\.swift' || true)
    if [ -n "$builders" ]; then
        echo "$builders"
        fail "an Apple Maps link is built outside StationPlaceLink (files above)"
    fi

    # And the card actually resolves one. Both halves live in a SwiftUI body
    # with no test target underneath them, and dropping either silently
    # restores the pin: without the lookup there is no place, and without
    # `openInMaps()` on the resolved item the button re-opens a URL that Maps
    # has to resolve for a second time.
    # The lookup also carries the station's aliases, so its arguments are
    # intentionally formatted over several lines. Match the call rather than
    # requiring SwiftFormat to collapse it to one exact line.
    awk '
        /place = await StationPlaceStore\.shared\.place\(/ { in_call = 1 }
        in_call && /for: card[,)]/ { found = 1 }
        in_call && /\)/ { in_call = 0 }
        END { exit !found }
    ' "$here/RailMap/StationCardView.swift" \
        || fail "the station card no longer looks up its Apple Maps place"
    grep -q 'item.openInMaps()' "$here/RailMap/StationCardView.swift" \
        || fail "the station card no longer opens the resolved map item"
    echo "  every station link is built by StationPlaceLink, and the card resolves its place"
fi

if [ "$run_app" = 1 ] && [ "$run_swift" = 1 ]; then
    echo "== app ========================================================="
    cd "$here"
    xcodebuild -project RailMap.xcodeproj -scheme RailMap -sdk iphonesimulator \
        -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
        -derivedDataPath "$scratch-app" build >"$scratch-app.log" 2>&1 \
        || { grep -E 'error: ' "$scratch-app.log" | head -20; fail "app build"; }
    echo "  RailMap.app builds"

    # Every badge the branding tables name must resolve, in the built bundle,
    # to a file iOS can actually decode.
    #
    # "Resolves to a real file" is not enough, and believing it was is how a
    # quarter of the station popup's rows shipped wearing a colour swatch: 95
    # of the paths name an SVG, ImageIO has no SVG decoder on iOS, and
    # `UIImage(contentsOfFile:)` returned nil for every one of them. macOS
    # decodes SVG perfectly well, so nothing on the host could see it —
    # `sips`, Preview and Xcode all open the artwork. That is why the check
    # below is written against the *extension* rather than against a decoder:
    # a host-side decode test passes on exactly the files the device rejects.
    #
    # It applies the loader's own rule from OperatorBadge.image — strip the
    # leading slash, and append `.png` to an `.svg` — so it fails if the rule,
    # the rasterized companions or the copy phase drift apart.
    app_bundle="$scratch-app/Build/Products/Debug-iphonesimulator/RailMap.app"
    [ -d "$app_bundle" ] || fail "no built RailMap.app at $app_bundle"
    python3 - "$repo" "$app_bundle" <<'PY' || fail "badge artwork the device cannot decode (above)"
import os, re, sys

repo, bundle = sys.argv[1], sys.argv[2]
source = os.path.join(repo, "app", "public", "rail")

# What ImageIO decodes on iOS. SVG is decodable on macOS and not on iOS, which
# is the whole reason this list is spelled out rather than inferred from a
# host-side decode: a decode test passes on exactly the files the device
# rejects. Anything in the artwork directories that is not one of these and
# not an SVG with a companion is something the popup cannot draw.
DECODABLE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".tiff"}
ARTWORK = DECODABLE | {".svg"}


def resolve(relative):
    """OperatorBadge.image: an .svg is served by its rasterized companion."""
    return relative + ".png" if relative.endswith(".svg") else relative


# Every piece of artwork that ships must be loadable. Driven from the source
# tree rather than from the tables, so that art added without a companion is
# caught even before a line is pointed at it.
missing, undecodable = [], []
for family in ("logos", "line-logos", "operator-logos"):
    for directory, _, names in os.walk(os.path.join(source, family)):
        for name in names:
            full = os.path.join(directory, name)
            relative = os.path.relpath(full, source)
            if os.path.splitext(name)[1].lower() not in ARTWORK:
                continue  # README.md, logo-credits.json — not artwork
            resolved = resolve(relative)
            if os.path.splitext(resolved)[1].lower() not in DECODABLE:
                undecodable.append(relative)
            elif not os.path.isfile(os.path.join(bundle, "rail", resolved)):
                missing.append(resolved)

# And every answer the ported rule gives for the popup must land on one of
# them. `station-display.json` is the fixture that records what the C5 popup
# draws; `operator-branding.json` is not used here because it feeds the rule
# invented inputs — a `logo` field of `/rail/logos/anything.png` — to prove
# which branch wins, and those are not artwork that ships.
raw = open(os.path.join(repo, "port-fixtures", "station-display.json"), encoding="utf-8").read()
paths = sorted(set(re.findall(r'/rail/[^"\\ ]+?\.[A-Za-z0-9]+', raw)))
unresolved = [
    path for path in paths
    if not os.path.isfile(os.path.join(bundle, "rail", resolve(path.lstrip("/")[len("rail/"):])))
]

for relative in undecodable[:10]:
    print(f"  undecodable on iOS, no companion: {relative}")
for relative in missing[:10]:
    print(f"  artwork missing from the bundle: {relative}")
for path in unresolved[:10]:
    print(f"  popup badge path resolves to nothing: {path}")
if missing or undecodable or unresolved:
    print(f"  {len(undecodable)} undecodable, {len(missing)} missing, "
          f"{len(unresolved)} of {len(paths)} popup paths unresolved")
    sys.exit(1)
print(f"  {len(paths)} popup badge paths resolve to artwork iOS can decode")
PY

    # Three behaviours the app target cannot unit-test, because they live in
    # SwiftUI view bodies with no test target underneath them. All three were
    # real regressions, and each is one deleted line away from coming back.

    # An edit that is not written to the library survives until the next
    # launch and no further. `ItineraryStore` holds the store in memory;
    # `RideLibrary` is what puts it on disk. Passport shipped with the first
    # half only, so the same edit was durable in Journeys and not in Passport.
    for file in $(grep -rl 'itineraries\.replace(\|itineraries\.rebuildRoute' \
        RailMap/ | grep -v 'ItineraryStore.swift'); do
        grep -q 'library\.save(' "$file" \
            || fail "$file commits an edit without persisting it"
    done
    echo "  every surface that edits a journey also persists it"

    # A store arriving from outside this app is placed in its region BEFORE it
    # is published, never corrected afterwards.
    #
    # An untagged ride is `Region.resolved`-as-Japanese: drawn against Japan's
    # package and solved against Japan's station table. The four non-Japanese
    # stores carry the operator's own station codes — `MLM-TAIPA-MLM-BARRA`,
    # `TYMC-A13`, `AEL-MTR-HOK` — which name no region on their face, so the
    # string rule cannot place them and only `RegionCodeIndex` can. That pass
    # used to run at launch only, so loading the Macanese sample asked Japan's
    # solver for 媽閣 and the card said 無法繪製路線 until the app was next
    # launched. Three doors admit a store — `load`, `merge`, `replaceAll`. A
    # fourth is not forbidden; it just has to place its rides too, and be
    # counted here.
    doors=$(grep -c 'await MergedStore.regionTagged(' RailMap/ItineraryStore.swift || true)
    [ "$doors" = 3 ] || fail \
        "expected 3 doors that place an incoming store in its region; found $doors"
    echo "  a sample loads into its own region on the launch that loads it"

    # The route reload key must be the whole record, not a projection of it.
    #
    # `DrawnRide` bakes in a journey's colour, visibility, stops and day span,
    # and solves its geometry from the stops, sections and policy. A key built
    # from some of those fields reports "nothing changed" for an edit that
    # changed the rest, and the map then draws the previous line — in the
    # previous colour, along the previous path — under the record the list is
    # already showing. `[Train]` is Equatable; anything narrower is a guess.
    grep -q 'private var routeLoadKey: \[Train\]? { itineraries.loaded?.trains }' \
        RailMap/AppShell.swift \
        || fail "routeLoadKey no longer keys the route reload on the whole record"
    echo "  editing a journey reloads what the map draws of it"

    # One PlaybackController serves the whole app (§5.3.5 gives Passport its
    # own replay entry point over the same transport). A TabView calls
    # onDisappear on every tab switch, so stopping playback there means a run
    # started in Journeys dies the moment the reader opens Passport to watch
    # it. Stopping is a thing the reader asks for, from the transport controls.
    if awk '/\.onDisappear \{/ { n = 10 }
            n && /playback\.stop\(\)/ { print FILENAME ":" FNR; found = 1 }
            n { n-- }
            END { exit !found }' RailMap/*.swift; then
        fail "a workspace stops the shared playback when its tab goes off screen"
    fi
    echo "  playback survives a tab switch"
fi

echo "OK"
