import SwiftUI

/// Japan Train Map, native.
///
/// The app shell owns exactly the three things the pure tier is forbidden to
/// touch: the window, Apple Maps, and the file system. Everything it draws it
/// gets from `RailCore`, which is verified line by line against the JavaScript
/// implementation by `port-fixtures/` — so a disagreement between this app and
/// the web app is a test failure before it is a bug report.
@main
struct RailMapApp: App {
    @AppStorage("appearance") private var appearance = "system"

    var body: some Scene {
        WindowGroup {
            testableContent
                .preferredColorScheme(preferredColorScheme)
        }
    }

    // There is no `RAILMAP_UI_TEST_REDUCE_MOTION` hook, and there cannot be
    // one shaped like the others.
    //
    // `EnvironmentValues.accessibilityReduceMotion` is declared `{ get }`, so
    // its key path is a `KeyPath` and not a `WritableKeyPath` — the same
    // `.environment(_:_:)` call that installs `AppLocalization` simply does not
    // typecheck against it. It is the SYSTEM's answer about the reader, not a
    // value the app is allowed to assert.
    //
    // A screenshot harness sets it where it actually lives, before launching:
    //
    //     xcrun simctl spawn <udid> defaults write com.apple.Accessibility \
    //         ReduceMotionEnabled -bool true
    //     xcrun simctl spawn <udid> notifyutil -p com.apple.accessibility.cache.app.ax
    //
    // That drives every `@Environment(\.accessibilityReduceMotion)` in the app
    // at once, which a shadowed app-level flag would not: the tokens in
    // `RailMotion` are read by views that would still be looking at the real
    // setting, so half the interface would degrade and half would not — and a
    // review run on that is worse than no review run at all.
    private var testableContent: some View { ContentView() }

    private var preferredColorScheme: ColorScheme? {
        switch appearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
}

// There is no Dynamic Type ceiling here any more, and its removal is the
// point rather than a simplification.
//
// `railTypeCeiling()` used to clamp the whole app at `xxxLarge`, so the five
// accessibility sizes were never rendered. The stated reason was true — a
// half-height sheet at `accessibility5` holds a title and nothing else — but
// the lever was wrong. Clamping made every AX-size path already written in
// this app unreachable by the readers it was written for: `RouteTimingView`'s
// stacked layout, the journey name's three-line ceiling, and the panel's own
// measured compact row. §10.1 asks the LAYOUT to follow the setting.
//
// So the layout follows it now, in the one place where the fit actually
// breaks: `BottomChromeMetrics` measures its compact stop from the reader's
// text size and drops the half stop entirely at an accessibility size, which
// is the stop that could not hold anything. See `BottomChromeMetrics.detents`.
