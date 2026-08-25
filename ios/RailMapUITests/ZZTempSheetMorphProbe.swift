import XCTest

/// TEMPORARY diagnostic — delete before committing.
@MainActor
final class ZZTempSheetMorphProbe: XCTestCase {
    private func launch(stage: String, tab: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["RAILMAP_UI_TEST_TAB"] = tab
        app.launchEnvironment["RAILMAP_UI_TEST_STAGE"] = stage
        app.launch()
        return app
    }

    private func header(_ app: XCUIApplication) -> XCUIElement {
        let h = app.descendants(matching: .any).matching(identifier: "panelHeader").firstMatch
        XCTAssertTrue(h.waitForExistence(timeout: 20))
        return h
    }

    /// Release well short of Half: the sheet then springs ~137 pt on its own,
    /// which is the settle the header used to skip.
    func testPartialRelease() {
        let app = launch(stage: "compact", tab: "upcoming")
        Thread.sleep(forTimeInterval: 3)
        let start = header(app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        NSLog("RAILANIM ==== partial release begins")
        start.press(forDuration: 0.15, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -140)))
        NSLog("RAILANIM ==== partial release ends")
        Thread.sleep(forTimeInterval: 3)
    }

    /// Slow drag past the crossover with the finger held down well past it —
    /// the case a mid-drag detent write breaks.
    func testSlowDragHold() {
        let app = launch(stage: "compact", tab: "upcoming")
        Thread.sleep(forTimeInterval: 3)
        let start = header(app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        NSLog("RAILANIM ==== slow drag begins")
        start.press(
            forDuration: 0.2,
            thenDragTo: start.withOffset(CGVector(dx: 0, dy: -320)),
            withVelocity: .slow,
            thenHoldForDuration: 1.5)
        NSLog("RAILANIM ==== slow drag ends")
        Thread.sleep(forTimeInterval: 2.5)
    }

    /// Fast flicks in both directions, where the stale-detent flash was 3/3.
    func testFastFlicks() {
        let app = launch(stage: "compact", tab: "upcoming")
        Thread.sleep(forTimeInterval: 3)
        for (i, dy) in [-150, -200, 250, -60].enumerated() {
            let c = header(app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            NSLog("RAILANIM ==== flick %d (%d) begins", i, dy)
            c.press(forDuration: 0.12, thenDragTo: c.withOffset(CGVector(dx: 0, dy: CGFloat(dy))))
            NSLog("RAILANIM ==== flick %d ends", i)
            Thread.sleep(forTimeInterval: 2.5)
        }
    }
}
