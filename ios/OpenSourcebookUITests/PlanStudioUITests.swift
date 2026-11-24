import XCTest

/// A plan from the web Studio on the phone, with the engine's answers handed
/// over by the test (`OPENSOURCEBOOK_TEST_STUDIO`): the project lists, the plan opens
/// with its items in order, Play goes through a byte and a quiz with real
/// swipes, a bit's citation opens the cited passage, and moving past each
/// thing ticks it done.
final class PlanStudioUITests: XCTestCase {

    private var app: XCUIApplication!
    private let timeout: TimeInterval = 10

    private let byteID = "10000000-0000-0000-0000-000000000001"
    private let quizID = "10000000-0000-0000-0000-000000000002"

    /// One project, one running plan: a byte, a quiz, and an "ask me" branch
    /// after the quiz; the byte's first bit cites a passage of the source.
    private var studio: String {
        let passage = "Week 3. A limit exists only when both one-sided limits agree. If they differ, there is no limit."
        let plan = #"{ "id": "pl1", "projectId": "p1", "title": "Limits, week 3", "status": "running", "counts": { "total": 3, "done": 0 } }"#
        return """
        {
          "projectList": [{ "id": "p1", "title": "Calculus I", "icon": "function" }],
          "plansByProject": { "p1": [\(plan)] },
          "planViews": { "pl1": { "plan": \(plan), "stages": [{ "level": 1, "label": "Check" }],
            "items": [
              { "id": "i1", "level": 0, "ord": 0, "type": "byte", "title": "One-sided limits", "enabled": true,
                "status": "done", "outputId": "\(byteID)", "done": false },
              { "id": "i2", "level": 1, "ord": 0, "type": "quiz", "title": "Limits quiz", "enabled": true,
                "status": "done", "outputId": "\(quizID)", "done": false },
              { "id": "i3", "parentId": "i2", "level": 2, "ord": 0, "type": "byte", "title": "More practice", "enabled": true,
                "status": "pending", "condition": { "kind": "ask" }, "done": false, "asking": { "question": "Want more practice?" } }
            ], "counts": { "total": 3, "done": 0 } } },
          "outputsByID": {
            "\(byteID)": { "id": "\(byteID)", "type": "byte", "title": "One-sided limits", "projectId": "p1",
              "planId": "pl1", "itemId": "i1", "schemaVersion": 2,
              "payload": { "schemaVersion": 2, "id": "x", "title": "One-sided limits", "subtitle": "Week 3 notes",
                "sourceKind": "note", "tags": [], "depth": "tiny",
                "bits": [
                  { "id": "b1", "kind": "plain", "blocks": [
                      { "type": "heading", "text": "Both sides have to agree" },
                      { "type": "text", "text": "A limit exists only when the left and right limits agree." } ],
                    "cites": [{ "sourceId": "s1", "spot": "passage", "locator": { "page": 4, "charStart": 8, "charEnd": 61 },
                                "quote": "both one-sided limits agree", "block": 1 }] },
                  { "id": "b2", "kind": "plain", "blocks": [ { "type": "heading", "text": "When they differ" } ], "cites": [] }
                ] } },
            "\(quizID)": { "id": "\(quizID)", "type": "quiz", "title": "Limits quiz", "projectId": "p1",
              "planId": "pl1", "itemId": "i2", "schemaVersion": 1,
              "payload": { "title": "Limits quiz", "passMark": 0.5, "feedback": "afterEach", "questions": [
                { "id": "q1", "kind": "choice", "topic": "limits", "prompt": "When does a limit exist?", "points": 1,
                  "feedback": { "correct": "Both sides agree.", "incorrect": "Both sides must agree." },
                  "options": ["Always", "When both sides agree"], "answer": 1, "cites": [] } ] } }
          },
          "sourcesByProject": { "p1": [{ "id": "s1", "projectId": "p1", "kind": "pdf", "title": "Week 3 notes", "status": "ready" }] },
          "sourceDetails": { "s1": { "source": { "id": "s1", "title": "Week 3 notes" },
                                     "extraction": { "status": "ready", "text": "\(passage)" } } }
        }
        """
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uiTesting"]
        app.launchEnvironment["OPENSOURCEBOOK_TEST_STUDIO"] = studio
        app.launch()
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    /// An element of the full-screen player. The Feed tab, mounted behind it,
    /// plays the same made things and is still in the accessibility tree; the
    /// player's copy comes first.
    private func player(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func waitForLabel(_ element: XCUIElement, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate(format: "label == %@", label)
        let found = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [found], timeout: timeout), .completed,
                       "expected \"\(label)\", got \"\(element.label)\"", file: file, line: line)
    }

    func testAPlanIsPlayedInOrderWithItsCitationsAndTicked() {
        // Home lists the Studio's project; it opens on what was made in it.
        let project = element("project-row-p1")
        XCTAssertTrue(project.waitForExistence(timeout: timeout))
        project.tap()
        XCTAssertTrue(app.staticTexts["Calculus I"].waitForExistence(timeout: timeout))

        // Its plans, then the plan: items in order, the branch asks.
        app.buttons["Plans"].tap()
        let planRow = element("plan-row-pl1")
        XCTAssertTrue(planRow.waitForExistence(timeout: timeout))
        planRow.tap()
        waitForLabel(element("plan-item-state-i1"), "Ready")
        waitForLabel(element("plan-item-state-i2"), "Ready")
        waitForLabel(element("plan-item-state-i3"), "Asks you")
        XCTAssertTrue(app.staticTexts["Want more practice?"].exists)
        XCTAssertTrue(app.staticTexts["Check"].exists, "a labelled stage shows its label")

        // Play: the byte first, its bits sideways.
        element("plan-play").tap()
        let position = player("player-position")
        waitForLabel(position, "1 of 2")
        let bits = player("bit-position-\(byteID)")
        waitForLabel(bits, "Bit 1 of 2")

        // Where the bit's claim comes from: the passage, with the quote in its place.
        let chip = player("cite-chip")
        XCTAssertTrue(chip.waitForExistence(timeout: timeout))
        waitForLabel(chip, "Source: Week 3 notes · page 4")
        chip.tap()
        let excerpt = element("cite-excerpt")
        XCTAssertTrue(excerpt.waitForExistence(timeout: timeout))
        XCTAssertTrue(excerpt.label.contains("both one-sided limits agree"), excerpt.label)
        app.buttons["Done"].tap()

        player("byte-bits-\(byteID)").swipeLeft()
        waitForLabel(bits, "Bit 2 of 2")
        waitForLabel(position, "1 of 2")

        // Down to the quiz, answered sideways and finished.
        player("player-pager").swipeUp()
        waitForLabel(position, "2 of 2")
        let quizPosition = player("quiz-position-\(quizID)")
        waitForLabel(quizPosition, "Question 1 of 1")
        app.buttons["When both sides agree"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Both sides agree."].waitForExistence(timeout: timeout))
        player("quiz-questions-\(quizID)").swipeLeft()
        waitForLabel(quizPosition, "Result")
        app.buttons["quiz-finish"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Done, passed"].waitForExistence(timeout: timeout))

        // Down past the quiz to the end, then back to the plan: both ticked.
        player("player-pager").swipeUp()
        XCTAssertTrue(app.staticTexts["That's everything"].waitForExistence(timeout: timeout))
        app.buttons["Close"].tap()
        waitForLabel(element("plan-item-state-i1"), "Done")
        waitForLabel(element("plan-item-state-i2"), "Done")
        waitForLabel(element("plan-progress"), "Being made · 2 of 3 done")
    }
}
