#!/bin/sh
# Runs the UI test against the simulator's real Reduce Motion setting, then
# restores the reader's previous setting even when the test fails.
set -eu

device=${1:-booted}
udid=$(xcrun simctl getenv "$device" SIMULATOR_UDID)
here=$(cd "$(dirname "$0")/.." && pwd)

previous=$(xcrun simctl spawn "$device" defaults read \
    com.apple.Accessibility ReduceMotionEnabled 2>/dev/null || echo 0)
case "$previous" in
    1|true|TRUE|yes|YES) restore=true ;;
    *) restore=false ;;
esac

set_reduce_motion() {
    xcrun simctl spawn "$device" defaults write \
        com.apple.Accessibility ReduceMotionEnabled -bool "$1"
    xcrun simctl spawn "$device" notifyutil \
        -p com.apple.accessibility.cache.app.ax
}

restore_setting() {
    set_reduce_motion "$restore"
}
trap restore_setting EXIT INT TERM

set_reduce_motion true

xcodebuild \
    -project "$here/RailMap.xcodeproj" \
    -scheme RailMap \
    -destination "platform=iOS Simulator,id=$udid" \
    -only-testing:RailMapUITests/RailMapUITests/testSystemReduceMotionPathRemainsReachable \
    test
