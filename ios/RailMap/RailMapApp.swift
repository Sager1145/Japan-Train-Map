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
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
