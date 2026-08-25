import Foundation

/// Level-of-detail policy for the stations attached to a recorded journey.
///
/// Network stations already derive their visibility from line density in
/// ``Visibility/stationMinZoom(lineMinZoom:totalKm:stationCount:)``. Journey
/// markers need one more input: the service pattern. A Shinkansen can usefully
/// show its sparse calls while a local train covering the same screen would
/// turn every station into an unreadable chain of dots.
public enum RideMarkerVisibility {
    public enum ServiceTier: Sendable, Equatable {
        case highSpeed
        case limitedExpress
        case rapid
        case local
    }

    /// Classify user-entered train types into the four display tiers.
    ///
    /// The statistics layer's three service groups remain the first source of
    /// truth. Extra spellings cover Simplified Chinese, English and Korean
    /// imports, and split rapid services from the statistics layer's broader
    /// `other` bucket for display purposes only.
    public static func serviceTier(trainType: String?, country: String) -> ServiceTier {
        let value = trainType ?? ""
        let group = Statistics.serviceGroupOfTrain(trainType: trainType, country: country)
        if group == "hsr" || containsAny(
            value, ["新干线", "高鐵", "高铁", "high-speed", "high speed", "ktx", "srt"])
        {
            return .highSpeed
        }
        if group == "ltd" || containsAny(
            value,
            ["特快", "limited express", "自強", "自强", "太魯閣", "太鲁阁", "普悠瑪", "普悠玛", "莒光"])
        {
            return .limitedExpress
        }
        if containsAny(
            value,
            ["快速", "急行", "準急", "准急", "快特", "通勤", "rapid", "express"])
        {
            return .rapid
        }
        return .local
    }

    /// The MapLibre zoom at which a marker starts drawing, or `nil` when it is
    /// a journey boundary and therefore remains visible at every scale.
    ///
    /// `densityMinZoom` comes from the same 22-pixel station-spacing ladder as
    /// the network. It is applied as a bounded adjustment instead of an
    /// absolute floor, so service type continues to matter even where two
    /// services pass through the same dense city centre.
    public static func minimumMapLibreZoom(
        role: String,
        trainType: String?,
        country: String,
        densityMinZoom: Int
    ) -> Double? {
        if role == "terminal" || role == "xday" { return nil }

        let tier = serviceTier(trainType: trainType, country: country)
        let base: Double
        if role == "pass" {
            switch tier {
            case .highSpeed: base = 7
            case .limitedExpress: base = 8
            case .rapid: base = 9.5
            case .local: base = 10.5
            }
        } else {
            switch tier {
            case .highSpeed: base = 5.5
            case .limitedExpress: base = 6.5
            case .rapid: base = 7.5
            case .local: base = 8.5
            }
        }

        let densityAdjustment = min(2.5, max(0, Double(densityMinZoom - 8) * 0.5))
        return base + densityAdjustment
    }

    private static func containsAny(_ value: String, _ needles: [String]) -> Bool {
        let folded = value.lowercased()
        return needles.contains { folded.contains($0.lowercased()) }
    }
}
