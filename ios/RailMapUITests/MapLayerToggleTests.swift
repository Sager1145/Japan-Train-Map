import XCTest

/// The two switches the map is toggled with most, and the master/subordinate
/// relationship between them.
///
/// These assert on the CONTROLS rather than on pixels — a UI test cannot see
/// whether a station dot is drawn — so each one also attaches a screenshot.
/// The assertion catches a control that stopped working; the attachment is
/// what a person looks at to see that the map actually changed.
@MainActor
final class MapLayerToggleTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// 列車経路 is reachable from the rail, and reports its own state.
    func testTrainRoutesToggleLivesOnTheRail() {
        let app = launch()
        let routes = app.buttons["mapRoutesToggle"]
        XCTAssertTrue(
            routes.waitForExistence(timeout: 12),
            "列車経路 must be a control on the map rail, not only inside the layers sheet.")
        XCTAssertTrue(routes.isSelected, "It starts on, with every ride drawn.")
        attach(app, named: "01-routes-on")

        routes.tap()
        // The selected trait is the accessibility half of §10.5's rule that a
        // state may not be carried by colour alone; if it does not clear, the
        // switch moved the map without telling anyone who cannot see the tint.
        XCTAssertTrue(
            waitFor(timeout: 6) { !routes.isSelected },
            "Turning 列車経路 off must clear the control's selected trait.")
        attach(app, named: "02-routes-off")

        routes.tap()
        XCTAssertTrue(waitFor(timeout: 6) { routes.isSelected })
    }

    /// With 列車経路 off, the three ride-marker switches are disabled rather
    /// than silently ignored — `MapLayers.routes` is their master.
    func testRideMarkerSwitchesFollowTheirMaster() {
        let app = launch()
        let routes = app.buttons["mapRoutesToggle"]
        XCTAssertTrue(routes.waitForExistence(timeout: 12))
        routes.tap()

        app.buttons["mapLayersButton"].tap()
        let stops = app.switches["layerStops"]
        XCTAssertTrue(stops.waitForExistence(timeout: 8), "the layers sheet never opened")
        XCTAssertFalse(
            stops.isEnabled,
            "With 列車経路 off there are no routes for a stop marker to sit on, so its "
                + "switch must not look operable.")
        attach(app, named: "03-markers-disabled")

        // And back: the master returns, the subordinates come back with the
        // values the reader left them at rather than being reset.
        dismissLayers(app)
        routes.tap()
        app.buttons["mapLayersButton"].tap()
        XCTAssertTrue(waitFor(timeout: 8) { app.switches["layerStops"].isEnabled })
        attach(app, named: "04-markers-enabled")
    }

    /// The network group exists and both of its switches operate.
    func testNetworkStationSwitchesExist() {
        let app = launch()
        XCTAssertTrue(app.buttons["mapLayersButton"].waitForExistence(timeout: 12))
        app.buttons["mapLayersButton"].tap()

        for label in ["layerNetworkStations", "layerNetworkStationNames"] {
            let toggle = app.switches[label]
            XCTAssertTrue(
                toggle.waitForExistence(timeout: 8),
                "the 全部線路 group must offer the “\(label)” switch")
            XCTAssertTrue(toggle.isEnabled)
            toggle.tap()
        }
        attach(app, named: "05-network-stations-off")

        dismissLayers(app)
        // Give the map a moment to rebuild without the network's dots.
        Thread.sleep(forTimeInterval: 3)
        attach(app, named: "06-map-without-network-stations")
    }

    // MARK: - helpers

    /// The layers sheet's dismissal.
    ///
    /// By position, not by the word: 完了 / Done / 完成 all live on the same
    /// toolbar and the label depends on the reader's language, which is what
    /// made the first version of this suite fail on a Japanese simulator.
    private func dismissLayers(_ app: XCUIApplication) {
        let done = app.navigationBars.buttons.element(boundBy: 0)
        if done.waitForExistence(timeout: 6) { done.tap() }
    }

    private func waitFor(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    private func attach(_ app: XCUIApplication, named: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = named
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["RAILMAP_UI_TEST_TAB"] = "all"
        app.launchEnvironment["RAILMAP_UI_TEST_STAGE"] = "medium"
        app.launch()
        return app
    }
}
