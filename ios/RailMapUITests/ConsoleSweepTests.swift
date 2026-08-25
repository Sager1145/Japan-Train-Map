import XCTest

/// One pass over every surface the app can reach, so the console has something
/// to say.
///
/// This is not an assertion suite — `RailMapUITests` holds those. Its job is to
/// **drive** the app: open every destination, every sheet, every menu and the
/// editor, so that a `log stream` running alongside it records what each of
/// those surfaces emits. A warning that only fires when the ride editor mounts
/// is invisible to a launch-and-screenshot check, and that is most of them.
///
/// It therefore asserts only that each surface actually appeared — if a tap
/// misses, the sweep silently covers nothing and the clean console it produces
/// is a lie. Everything else is left to the log.
@MainActor
final class ConsoleSweepTests: XCTestCase {
    override func setUp() {
        // The opposite of the sibling suite: one missed surface must not stop
        // the walk, or the first flake hides every screen after it.
        continueAfterFailure = true
    }

    func testWalkEverySurface() {
        let app = launch(tab: "all", stage: "expanded")
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))

        walkDestinations(app)
        walkSheetStops(app)
        walkMapSheets(app)
        walkUtilityMenu(app)
        walkJourneyDetailAndEditor(app)
        walkSearch(app)
    }

    // MARK: - the four destinations

    private func walkDestinations(_ app: XCUIApplication) {
        for tab in ["upcoming", "stats", "all", "search"] {
            let button = app.tabBars.buttons.element(boundBy: index(of: tab))
            guard button.waitForExistence(timeout: 8) else {
                XCTFail("destination \(tab) is not on the tab bar")
                continue
            }
            button.tap()
            settle()
        }
    }

    private func index(of tab: String) -> Int {
        switch tab {
        case "upcoming": 0
        case "stats": 1
        case "all": 2
        default: 3
        }
    }

    // MARK: - the resident sheet's three stops

    /// Docked → Half → Full, through the header, which is the only drag handle
    /// the sheet has (§9.5.6 hides the grabber).
    private func walkSheetStops(_ app: XCUIApplication) {
        let header = element("panelHeader", in: app)
        guard header.waitForExistence(timeout: 8) else {
            XCTFail("the panel header never appeared")
            return
        }
        for offset in [CGFloat(320), -320, -320, 320] {
            let start = header.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(
                CGVector(dx: 0, dy: offset)))
            settle()
        }
    }

    // MARK: - the sheets that are ABOUT the map

    private func walkMapSheets(_ app: XCUIApplication) {
        guard element("mapNetworkToggle", in: app).waitForExistence(timeout: 8) else {
            XCTFail("the map control rail never appeared")
            return
        }
        // By identifier rather than by label or by position: the labels are
        // the reader's language (the first version of this looked for "Map
        // layers" and found nothing on a Japanese simulator), and a
        // `boundBy:` index silently walks the wrong control the next time one
        // is added or removed.
        for label in ["mapLayersButton", "mapInfoButton"] {
            let control = element(label, in: app)
            guard control.waitForExistence(timeout: 6) else {
                XCTFail("map control “\(label)” is not reachable")
                continue
            }
            control.tap()
            settle()
            dismissSheet(app)
        }
        // The two toggles, twice each, so both states render.
        for label in ["mapNetworkToggle", "mapLocateToggle"] {
            let control = element(label, in: app)
            guard control.exists else { continue }
            control.tap()
            settle(0.6)
            control.tap()
            settle(0.6)
        }
    }

    // MARK: - Data Library and Settings

    private func walkUtilityMenu(_ app: XCUIApplication) {
        // The MENU ITEMS by identifier too, not only the gear that opens them.
        //
        // This loop asked for `app.buttons["Data"]` and `app.buttons["Settings"]`
        // while the simulator ran in Chinese, so it never opened either one:
        // the two surfaces with the most alerts in the app — Data Library and
        // its five confirmations, Settings and its diagnostics — were reported
        // as swept and were not, which is the failure mode the header comment
        // on this file exists to prevent. It is the same trap `walkMapSheets`
        // and the map control rail were pulled out of; identifiers are
        // language-independent, labels are for people.
        for destination in ["utilityDataButton", "utilitySettingsButton"] {
            let gear = element("utilityMenuButton", in: app)
            guard gear.waitForExistence(timeout: 8) else {
                XCTFail("the utility menu is not reachable")
                return
            }
            gear.tap()
            settle()
            let entry = element(destination, in: app)
            guard entry.waitForExistence(timeout: 6) else {
                XCTFail("“\(destination)” is not in the utility menu")
                // Close the menu rather than leaving it over everything after.
                app.tap()
                continue
            }
            entry.tap()
            settle(1.5)
            // Settings is a Form with many sections; scrolling it mounts the
            // rows below the fold, which is where the diagnostics live.
            if app.tables.firstMatch.exists || app.collectionViews.firstMatch.exists {
                app.swipeUp()
                settle(0.5)
                app.swipeUp()
                settle(0.5)
            }
            dismissSheet(app)
        }
    }

    // MARK: - a journey, its detail, and the editor

    private func walkJourneyDetailAndEditor(_ app: XCUIApplication) {
        app.tabBars.buttons.element(boundBy: index(of: "all")).tap()
        settle()

        let rows = app.collectionViews.cells
        guard rows.count > 0 else {
            // Not a failure: a store with no journeys is a legitimate state,
            // and the empty path is worth logging too.
            return
        }
        rows.element(boundBy: 0).tap()
        settle(1.5)

        // The card's own primary action, whatever the resolver picked — by
        // identifier, because both halves of the old lookup were wrong on this
        // simulator: the three English labels it guessed at are the reader's
        // language, and WHICH of them the card is showing is the resolver's
        // decision rather than something a test can name in advance.
        let primary = element("journeyPrimaryAction", in: app)
        if primary.waitForExistence(timeout: 6) {
            primary.tap()
            settle(1.5)
        } else {
            XCTFail("the journey card has no primary action")
        }
        // Stop anything that started, so the sweep does not leave playback
        // running under every screen after this one.
        let stop = element("playbackStopButton", in: app)
        if stop.exists {
            stop.tap()
            settle()
        }
    }

    // MARK: - search

    private func walkSearch(_ app: XCUIApplication) {
        app.tabBars.buttons.element(boundBy: index(of: "search")).tap()
        settle()
        // Open the panel first.
        //
        // `walkSheetStops` finishes on a downward drag, so the sheet is at
        // Docked by the time the walk reaches here — and Docked deliberately
        // shows the title row and nothing else (§9.5.6). Looking for the
        // search field at that stop reported "the search destination opened
        // without a field", which is the app behaving exactly as specified and
        // the sweep asking the wrong question.
        let header = element("panelHeader", in: app)
        if header.waitForExistence(timeout: 8) {
            let start = header.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(
                CGVector(dx: 0, dy: -320)))
            settle()
        }
        let field = element("journeySearchField", in: app)
        guard field.waitForExistence(timeout: 8) else {
            XCTFail("the search destination opened without a field")
            return
        }
        field.tap()
        field.typeText("1")
        settle(1.5)
        // And the no-results path, which draws a different empty state.
        field.typeText("zzzzzz")
        settle(1.5)
    }

    // MARK: - helpers

    private func dismissSheet(_ app: XCUIApplication) {
        // The identified close button first, then the English labels, then a
        // swipe — in that order, because the last of the three is the one that
        // silently does nothing. A Data Library that will not close is not a
        // missed surface, it is a surface left ON TOP of every screen the walk
        // visits afterwards: the run that found this reported "the utility
        // menu is not reachable" and stopped covering anything, because the
        // gear was underneath a sheet a swipe had only scrolled.
        let close = element("utilityCloseButton", in: app)
        if close.exists, close.isHittable {
            close.tap()
            settle()
            return
        }
        for label in ["Done", "Cancel", "Close"] where app.buttons[label].exists {
            app.buttons[label].tap()
            settle()
            return
        }
        // No labelled dismissal: swipe the sheet away instead.
        app.swipeDown()
        settle()
    }

    /// Long enough for the surface to mount, lay out and log. Not a race guard
    /// — every navigation above waits on an element — but the log lines this
    /// sweep exists to collect are emitted after the first frame.
    private func settle(_ seconds: TimeInterval = 1.0) {
        Thread.sleep(forTimeInterval: seconds)
    }

    private func launch(tab: String, stage: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["RAILMAP_UI_TEST_TAB"] = tab
        app.launchEnvironment["RAILMAP_UI_TEST_STAGE"] = stage
        app.launch()
        return app
    }

    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }
}
