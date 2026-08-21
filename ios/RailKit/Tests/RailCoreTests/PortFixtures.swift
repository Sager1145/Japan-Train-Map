import Foundation
import RailCore
import Testing

/// Shared access to `port-fixtures/` and the shipped rail packages.
///
/// This exists so that each ported function can bring its own test file
/// instead of everyone editing one. Porting runs in parallel; a single test
/// file every contributor has to touch is a file every contributor has to
/// merge.
enum PortFixtures {

    /// Locates the repository root by walking up from this source file.
    ///
    /// Deliberately not an SPM resource bundle: the fixtures are shared with
    /// the JavaScript side and live at the repository root, which is the point
    /// — a copy inside the package would be a copy that can drift.
    static func repositoryRoot(from file: StaticString = #filePath) throws -> URL {
        var directory = URL(filePath: "\(file)").deletingLastPathComponent()
        for _ in 0..<8 {
            if FileManager.default.fileExists(
                atPath: directory.appending(path: "port-fixtures").path)
            {
                return directory
            }
            directory = directory.deletingLastPathComponent()
        }
        throw CocoaError(.fileNoSuchFile)
    }

    static func data(_ name: String) throws -> Data {
        let url = try repositoryRoot().appending(path: "port-fixtures/\(name)")
        guard FileManager.default.fileExists(atPath: url.path) else {
            Issue.record(
                """
                port-fixtures/\(name) is missing. Generate it with:
                  cd app && node scripts/build/build-port-fixtures.mjs
                """
            )
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: data(name))
    }

    /// One country's compact package, cached — several suites read the same
    /// ones and Japan is 9 MB.
    static func package(country: String) throws -> CompactPackage {
        if let cached = cache[country] { return cached }
        let url = try repositoryRoot()
            .appending(path: "app/public/rail/\(country)-2025.json")
        let loaded = try CompactPackage.load(contentsOf: url)
        cache[country] = loaded
        return loaded
    }

    static let countries = ["mo", "hk", "tw", "kr", "jp"]

    nonisolated(unsafe) private static var cache: [String: CompactPackage] = [:]
}

extension Double {
    /// Distance in units in the last place — the unit a port disagreement is
    /// honestly measured in. See `FixtureParityTests.distances` for why a
    /// relative epsilon is the wrong tool.
    func ulpDistance(to other: Double) -> Int64 {
        if bitPattern == other.bitPattern { return 0 }
        return abs(Int64(bitPattern: bitPattern) - Int64(bitPattern: other.bitPattern))
    }
}
