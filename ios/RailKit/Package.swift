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
//   RailPresentation
//             the display-state tier: JRM_FLIGHTY_UI_REFACTOR_SPEC.md §11.1's
//             state model and §11.2's information-priority resolver. Imports
//             Foundation and RailCore, and nothing else.
//
//             §16 forbids putting display state in RailCore and §1.2 puts it in
//             the platform display layer — but the app target has no tests, and
//             §15 Slice 1 requires unit tests for the failure/hidden/playback
//             priority. A module one step below SwiftUI is what makes both true
//             at once: the compiler keeps it free of MapKit and SwiftUI, and
//             `swift test` can run it.
//
// The app target (RailMap.xcodeproj) sits above this package and owns the
// things that cannot be shared: Apple Maps, SwiftUI, storage.
let package = Package(
    name: "RailKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "RailCore", targets: ["RailCore"]),
        .library(name: "RailPresentation", targets: ["RailPresentation"]),
    ],
    targets: [
        .target(name: "RailCore"),
        .target(name: "RailPresentation", dependencies: ["RailCore"]),
        .testTarget(name: "RailCoreTests", dependencies: ["RailCore"]),
        .testTarget(name: "RailPresentationTests", dependencies: ["RailPresentation"]),
    ]
)
