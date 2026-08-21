// swift-tools-version: 6.0
import PackageDescription

// RailKit — the Swift side of the Japan Train Map fork.
//
// The layering here is not a matter of taste; it is the portability tiering
// measured in REFACTOR_FOR_SWIFT_FORK_PROMPT.md §二, made into targets so the
// compiler enforces it:
//
//   RailCore  the pure-logic tier. Imports Foundation and NOTHING ELSE — no
//             MapKit, no SwiftUI, no persistence. This is the 14,369 lines of
//             JavaScript that carry the actual behaviour, and the whole point
//             of keeping it import-free is that it can be verified against the
//             JavaScript by running both over the same fixtures.
//
// The app target (RailMap.xcodeproj) sits above this package and owns the
// things that cannot be shared: Apple Maps, SwiftUI, storage.
let package = Package(
    name: "RailKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "RailCore", targets: ["RailCore"])
    ],
    targets: [
        .target(name: "RailCore"),
        .testTarget(name: "RailCoreTests", dependencies: ["RailCore"]),
    ]
)
