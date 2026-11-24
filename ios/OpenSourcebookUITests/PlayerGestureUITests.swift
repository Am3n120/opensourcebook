import XCTest

/// The gesture rule on the phone (DECISIONS.md #36), driven with real swipes
/// on items handed to the in-memory store: scrolling up on the screen moves
/// to the next item, swiping sideways moves through a byte's bits.
final class PlayerGestureUITests: XCTestCase {

    private var app: XCUIApplication!
    private let timeout: TimeInterval = 10

    private let oldPageID = "00000000-0000-0000-0000-000000000001"
    private let byteID = "00000000-0000-0000-0000-000000000002"
    private let quizID = "00000000-0000-0000-0000-000000000003"

    /// An old stored page (format `read`, one long list of blocks) and a byte
    /// as the engine sends it, with three bits, the last one a block this
    /// build doesn't know.
    private var items: String {
        let paragraph = String(repeating: "A limit describes where a function is heading as its input approaches a point. ", count: 6)
        return """
        [
          { "id": "\(oldPageID)", "title": "Limits, the long page", "subtitle": "Week 3 notes",
            "outputType": "read", "createdAt": 1000,
            "blocks": [
              { "type": "kicker", "text": "1 · Start" }, { "type": "heading", "text": "What a limit is" },
              { "type": "text", "text": "\(paragraph)" }, { "type": "divider" },
              { "type": "heading", "text": "One-sided limits" }, { "type": "text", "text": "\(paragraph)" },
              { "type": "heading", "text": "Continuity" }, { "type": "text", "text": "\(paragraph)" }
            ] },
          { "id": "\(byteID)", "title": "One-sided limits", "subtitle": "Week 3 notes",
            "outputType": "byte", "createdAt": 2000,
            "bits": [
              { "id": "b1", "kind": "plain", "blocks": [ { "type": "heading", "text": "Both sides have to agree" } ] },
              { "id": "b2", "kind": "flip", "blocks": [ { "type": "flashcards", "cards": [ { "front": "What must hold?", "back": "Left equals right." } ] } ] },
              { "id": "b3", "kind": "plain", "blocks": [ { "type": "hologram", "beam": 3 } ] }
            ] },
          { "id": "\(quizID)", "title": "Limits quiz", "subtitle": "Week 3 notes",
            "outputType": "check", "createdAt": 3000,
            "payload": { "title": "Limits quiz", "passMark": 0.5, "feedback": "afterEach", "questions": [
              { "id": "q1", "kind": "choice", "topic": "one-sided", "prompt": "When does a limit exist?", "points": 1,
                "feedback": { "correct": "Both sides agree.", "incorrect": "Both sides must agree." }, "cites": [],
                "options": ["Always", "When both sides agree"], "answer": 1 },
              { "id": "q2", "kind": "choice", "topic": "continuity", "prompt": "Is a jump continuous?", "points": 1,
                "feedback": { "correct": "Right.", "incorrect": "A jump breaks continuity." }, "cites": [],
                "options": ["Yes", "No"], "answer": 1 }
            ] } }
        ]
        """
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uiTesting"]
        app.launchEnvironment["OPENSOURCEBOOK_TEST_OUTPUTS"] = items
        app.launch()
        let feed = app.buttons["tab-feed"]
        XCTAssertTrue(feed.waitForExistence(timeout: timeout))
        feed.tap()
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    private func waitForLabel(_ element: XCUIElement, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate(format: "label == %@", label)
        let found = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [found], timeout: timeout), .completed,
                       "expected \"\(label)\", got \"\(element.label)\"", file: file, line: line)
    }

    func testScrollingMovesBetweenItemsAndSwipingMovesThroughBits() {
        let position = element("player-position")
        waitForLabel(position, "1 of 3")
        XCTAssertTrue(app.staticTexts["Limits, the long page"].exists)

        // The old page opens as bits, one per screen.
        let oldBits = element("bit-position-\(oldPageID)")
        waitForLabel(oldBits, "Bit 1 of 3")
        element("byte-bits-\(oldPageID)").swipeLeft()
        waitForLabel(oldBits, "Bit 2 of 3")
        waitForLabel(position, "1 of 3")  // sideways stays inside the item

        // Scrolling down goes to the next item.
        element("player-pager").swipeUp()
        waitForLabel(position, "2 of 3")
        XCTAssertTrue(app.staticTexts["Both sides have to agree"].waitForExistence(timeout: timeout))

        // Through the byte's bits; a bit this build can't draw says so.
        let byteBits = element("bit-position-\(byteID)")
        element("byte-bits-\(byteID)").swipeLeft()
        waitForLabel(byteBits, "Bit 2 of 3")
        element("byte-bits-\(byteID)").swipeLeft()
        waitForLabel(byteBits, "Bit 3 of 3")
        XCTAssertTrue(app.staticTexts["Can't show this bit"].waitForExistence(timeout: timeout))

        // Up goes back, to the bit you left.
        element("player-pager").swipeDown()
        waitForLabel(position, "1 of 3")
        waitForLabel(oldBits, "Bit 2 of 3")

        // Next, three times, reaches the end.
        app.buttons["Next"].tap()
        waitForLabel(position, "2 of 3")
        app.buttons["Next"].tap()
        waitForLabel(position, "3 of 3")
        app.buttons["Next"].tap()
        XCTAssertTrue(app.staticTexts["That's everything"].waitForExistence(timeout: timeout))
    }

    func testAQuizStoredUnderTheOldIdIsAnsweredSidewaysAndFinished() {
        let position = element("player-position")
        waitForLabel(position, "1 of 3")
        element("player-pager").swipeUp()
        waitForLabel(position, "2 of 3")
        element("player-pager").swipeUp()
        waitForLabel(position, "3 of 3")
        XCTAssertTrue(app.staticTexts["quiz"].exists, "the old check id shows as quiz")

        let quizPosition = element("quiz-position-\(quizID)")
        waitForLabel(quizPosition, "Question 1 of 2")
        app.buttons["When both sides agree"].tap()
        XCTAssertTrue(app.staticTexts["Both sides agree."].waitForExistence(timeout: timeout), "feedback after the answer")

        element("quiz-questions-\(quizID)").swipeLeft()
        waitForLabel(quizPosition, "Question 2 of 2")
        app.buttons["Yes"].tap()
        XCTAssertTrue(app.staticTexts["A jump breaks continuity."].waitForExistence(timeout: timeout))

        element("quiz-questions-\(quizID)").swipeLeft()
        waitForLabel(quizPosition, "Result")
        XCTAssertTrue(app.staticTexts["50%"].waitForExistence(timeout: timeout))
        app.buttons["quiz-finish"].tap()
        XCTAssertTrue(app.staticTexts["Done, passed"].waitForExistence(timeout: timeout))
    }
}
