import XCTest

/// Drives the app on a fresh, in-memory store. `-uiTesting` makes the app skip
/// the share inbox, leave the engine unconfigured and never open the owner's
/// library.
final class OpenSourcebookUITests: XCTestCase {

    private var app: XCUIApplication!
    private let timeout: TimeInterval = 10

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uiTesting"]
        app.launch()
    }

    private func tab(_ name: String) -> XCUIElement { app.buttons["tab-\(name)"] }

    private func openTab(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = tab(name)
        XCTAssertTrue(button.waitForExistence(timeout: timeout), "tab-\(name) missing", file: file, line: line)
        button.tap()
    }

    // MARK: Tab bar

    func testTabBarHasTheFiveControls() {
        for name in ["home", "feed", "library", "profile", "capture"] {
            XCTAssertTrue(tab(name).waitForExistence(timeout: timeout), "tab-\(name) missing")
        }
    }

    func testTabsSwitchBetweenScreens() {
        XCTAssertTrue(app.staticTexts["Nothing yet"].waitForExistence(timeout: timeout), "Home is the first tab")
        XCTAssertTrue(tab("home").isSelected)

        openTab("feed")
        XCTAssertTrue(app.staticTexts["Nothing to play"].waitForExistence(timeout: timeout))
        XCTAssertTrue(tab("feed").isSelected)
        XCTAssertFalse(tab("home").isSelected)

        openTab("library")
        XCTAssertTrue(app.staticTexts["No items yet"].waitForExistence(timeout: timeout))
        XCTAssertTrue(tab("library").isSelected)

        openTab("profile")
        XCTAssertTrue(app.textFields["profile-engine-url"].waitForExistence(timeout: timeout))
        XCTAssertTrue(tab("profile").isSelected)

        openTab("home")
        XCTAssertTrue(app.staticTexts["Nothing yet"].waitForExistence(timeout: timeout))
        XCTAssertTrue(tab("home").isSelected)
    }

    // MARK: Capture

    func testPlusOpensTheCaptureSheetAndItCanBeDismissed() {
        openTab("capture")

        let cancel = app.buttons["capture-cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: timeout), "capture sheet did not open")
        XCTAssertTrue(app.navigationBars["Capture"].exists)

        cancel.tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: cancel)
        waitForExpectations(timeout: timeout)
        XCTAssertTrue(tab("home").waitForExistence(timeout: timeout))
    }

    // MARK: Projects

    func testCreatingAProjectFromHomeListsItAndOpensItsScreen() {
        let name = "UI test project"
        let newProject = app.buttons["home-new-project"]
        XCTAssertTrue(newProject.waitForExistence(timeout: timeout))
        newProject.tap()

        let title = app.textFields["project-title"]
        XCTAssertTrue(title.waitForExistence(timeout: timeout))
        title.tap()
        title.typeText(name)
        app.buttons["Create"].tap()

        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: timeout), "the new project is not listed on Home")
        XCTAssertFalse(app.staticTexts["Nothing yet"].exists, "Home is no longer empty")

        row.tap()
        for segment in ["Items", "Plans", "Sources"] {
            XCTAssertTrue(app.buttons[segment].waitForExistence(timeout: timeout), "\(segment) segment missing")
        }
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.staticTexts["No items yet"].exists, "Items is the default segment")

        // A project made on the phone has no plans or sources from the Studio.
        app.buttons["Plans"].tap()
        XCTAssertTrue(app.staticTexts["No plans here"].waitForExistence(timeout: timeout))
        app.buttons["Sources"].tap()
        XCTAssertTrue(app.staticTexts["No sources here"].waitForExistence(timeout: timeout))
        app.buttons["Items"].tap()
        XCTAssertTrue(app.staticTexts["No items yet"].waitForExistence(timeout: timeout))
    }

    // MARK: Empty states

    func testLibraryAndFeedShowTheirEmptyStatesOnAFreshStore() {
        openTab("library")
        XCTAssertTrue(app.staticTexts["No items yet"].waitForExistence(timeout: timeout))

        openTab("feed")
        XCTAssertTrue(app.staticTexts["Nothing to play"].waitForExistence(timeout: timeout))
    }

    // MARK: Profile

    func testProfileShowsTheEngineSection() {
        openTab("profile")
        XCTAssertTrue(app.staticTexts["Engine"].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.textFields["profile-engine-url"].exists)
        XCTAssertTrue(app.secureTextFields["profile-engine-token"].exists)
        XCTAssertTrue(app.buttons["Check connection"].exists)
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Use a deployed HTTPS engine endpoint'"))
                .firstMatch.exists,
            "the engine is unconfigured under test"
        )
    }
}
