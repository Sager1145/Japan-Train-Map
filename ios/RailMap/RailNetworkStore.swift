import Foundation
import RailCore
import SwiftUI

/// Loads a country's rail package out of the app bundle and turns it into
/// something the map can draw.
///
/// The decoding and the interval geometry both come from `RailCore`, which is
/// the point: this type contains no geometry of its own, so there is nothing
/// here that could disagree with the web app without a fixture catching it.
@MainActor
@Observable
final class RailNetworkStore {

    struct DrawnLine: Identifiable, Sendable {
        let id: String
        let name: String
        let nameRoma: String?
        let color: Color
        let rank: Int
        /// One polyline per station-to-station interval, exactly as the web
        /// app draws them.
        let intervals: [[Coordinate]]
        var vertexCount: Int { intervals.reduce(0) { $0 + $1.count } }
    }

    enum LoadState {
        case idle
        case loading
        case loaded(country: String, lines: [DrawnLine], elapsed: Duration)
        case failed(String)
    }

    private(set) var state: LoadState = .idle

    /// The five countries the packages cover, smallest first — which is also
    /// least to most demanding on the renderer, so the ordering doubles as the
    /// order to try things in when measuring.
    static let countries: [(code: String, label: String)] = [
        ("mo", "澳門 Macao"),
        ("hk", "香港 Hong Kong"),
        ("tw", "臺灣 Taiwan"),
        ("kr", "한국 Korea"),
        ("jp", "日本 Japan"),
    ]

    func load(country: String) {
        state = .loading
        Task {
            do {
                let decoded = try await Self.decode(country: country)
                state = .loaded(
                    country: country, lines: decoded.lines, elapsed: decoded.elapsed)
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    /// Decoding a national package is tens of thousands of coordinates, so it
    /// is `nonisolated` — it runs off the main actor and the main actor only
    /// sees the finished value. Marked `async` rather than dispatched by hand
    /// because that is what lets the compiler check the hand-off instead of
    /// trusting it.
    private nonisolated static func decode(
        country: String
    ) async throws -> (lines: [DrawnLine], elapsed: Duration) {
        let started = ContinuousClock.now
        guard let url = Bundle.main.url(forResource: "\(country)-2025", withExtension: "json")
        else { throw LoadError.missingResource(country) }

        let package = try CompactPackage.load(contentsOf: url)
        let lines = package.lines.map { line in
            DrawnLine(
                id: line.id,
                name: line.name,
                nameRoma: line.nameRoma,
                color: Color(hex: line.color) ?? .accentColor,
                rank: line.rank,
                intervals: CompactPackage.decodeIntervals(line)
            )
        }
        return (lines, ContinuousClock.now - started)
    }

    enum LoadError: LocalizedError {
        case missingResource(String)

        var errorDescription: String? {
            switch self {
            case .missingResource(let country):
                return """
                    \(country)-2025.json is not in the app bundle. \
                    Run ios/copy-rail-packages.sh — the packages are copied from \
                    app/public/rail rather than committed twice.
                    """
            }
        }
    }
}

extension Color {
    /// Reads the `#rrggbb` strings the rail packages store.
    ///
    /// The packages also carry `colorDark` for operators that publish a
    /// separate dark-mode colour; wiring that to the colour scheme is a
    /// follow-up, and doing it here rather than in `RailCore` is deliberate —
    /// which colour a theme picks is presentation, and presentation does not
    /// go in the pure tier.
    init?(hex: String?) {
        guard var text = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
