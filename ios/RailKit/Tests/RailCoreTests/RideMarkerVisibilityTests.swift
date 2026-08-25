import RailCore
import Testing

struct RideMarkerVisibilityTests {
    @Test("service spellings select the intended marker tier", arguments: [
        ("新幹線", "jp", RideMarkerVisibility.ServiceTier.highSpeed),
        ("新干线", "jp", RideMarkerVisibility.ServiceTier.highSpeed),
        ("KTX", "kr", RideMarkerVisibility.ServiceTier.highSpeed),
        ("特急", "jp", RideMarkerVisibility.ServiceTier.limitedExpress),
        ("Limited Express", "jp", RideMarkerVisibility.ServiceTier.limitedExpress),
        ("快速", "jp", RideMarkerVisibility.ServiceTier.rapid),
        ("普通", "jp", RideMarkerVisibility.ServiceTier.local),
    ])
    func serviceTiers(item: (String, String, RideMarkerVisibility.ServiceTier)) {
        #expect(RideMarkerVisibility.serviceTier(trainType: item.0, country: item.1) == item.2)
    }

    @Test("boundaries remain visible at every zoom")
    func boundaryVisibility() {
        #expect(RideMarkerVisibility.minimumMapLibreZoom(
            role: "terminal", trainType: "普通", country: "jp", densityMinZoom: 14) == nil)
        #expect(RideMarkerVisibility.minimumMapLibreZoom(
            role: "xday", trainType: "普通", country: "jp", densityMinZoom: 14) == nil)
    }

    @Test("sparser and faster services reveal markers earlier")
    func tierAndDensityOrdering() throws {
        let highSpeed = try #require(RideMarkerVisibility.minimumMapLibreZoom(
            role: "stop", trainType: "新幹線", country: "jp", densityMinZoom: 8))
        let limited = try #require(RideMarkerVisibility.minimumMapLibreZoom(
            role: "stop", trainType: "特急", country: "jp", densityMinZoom: 8))
        let local = try #require(RideMarkerVisibility.minimumMapLibreZoom(
            role: "stop", trainType: "普通", country: "jp", densityMinZoom: 8))
        let denseLocal = try #require(RideMarkerVisibility.minimumMapLibreZoom(
            role: "stop", trainType: "普通", country: "jp", densityMinZoom: 12))
        let densePass = try #require(RideMarkerVisibility.minimumMapLibreZoom(
            role: "pass", trainType: "普通", country: "jp", densityMinZoom: 12))

        #expect(highSpeed < limited)
        #expect(limited < local)
        #expect(local < denseLocal)
        #expect(denseLocal < densePass)
    }
}
