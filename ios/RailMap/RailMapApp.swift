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
            ContentView()
                .preferredColorScheme(preferredColorScheme)
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch appearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
}
