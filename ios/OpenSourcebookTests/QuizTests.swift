import XCTest
@testable import OpenSourcebook

/// Quiz (DECISIONS.md #35): the engine's payload decodes, answers grade the
/// way the engine's `gradeQuiz` does, and the result rides on the done tick.
final class QuizTests: XCTestCase {

    private let payload = """
    {
      "title": "Limits check",
      "passMark": 0.7,
      "feedback": "afterEach",
      "questions": [
        { "id": "q1", "kind": "choice", "topic": "one-sided", "prompt": "When does a limit exist?",
          "points": 1, "feedback": { "correct": "Yes.", "incorrect": "Both sides must agree." },
          "cites": [ { "passageId": "p1", "sourceId": "s1", "quote": "both one-sided limits agree" } ],
          "options": ["Always", "When both sides agree"], "answer": 1 },
        { "id": "q2", "kind": "worked", "topic": "continuity", "prompt": "Work it out.",
          "points": 2, "feedback": { "correct": "Good.", "incorrect": "Look again." }, "cites": [],
          "steps": [
            { "prompt": "Left limit?", "input": "entries", "values": ["1/2"], "hint": "Plug in." },
            { "prompt": "Continuous?", "input": "choice", "options": ["yes", "no"], "answer": 0 }
          ] },
        { "id": "q3", "kind": "hologram", "topic": "continuity", "prompt": "Rotate it.",
          "points": 1, "feedback": { "correct": "", "incorrect": "" }, "cites": [] },
        { "kind": "choice", "prompt": "no id, dropped" }
      ]
    }
    """

    private func quiz() throws -> QuizPayload {
        try JSONDecoder().decode(QuizPayload.self, from: Data(payload.utf8))
    }

    func testThePayloadDecodesWithUnknownKindsKeptAndBrokenQuestionsDropped() throws {
        let quiz = try quiz()
        XCTAssertEqual(quiz.questions.map(\.id), ["q1", "q2", "q3"])
        XCTAssertEqual(quiz.questions.map(\.kind), ["choice", "worked", "hologram"])
        XCTAssertEqual(quiz.feedback, .afterEach)
        guard case .worked(let steps) = quiz.questions[1].body else { return XCTFail("worked") }
        XCTAssertEqual(steps[0].input, .entries(values: ["1/2"]))
        XCTAssertEqual(steps[1].input, .choice(options: ["yes", "no"], answer: 0))

        let again = try JSONDecoder().decode(QuizPayload.self, from: JSONEncoder().encode(quiz))
        XCTAssertEqual(again, quiz, "round trip, the unknown kind included")
    }

    func testGradingMatchesTheEngine() throws {
        let quiz = try quiz()
        let result = QuizGrader.result(quiz, responses: [
            "q1": .choice(1),
            "q2": .worked([WorkedStepResponse(value: .entries([" 0.5 "])), WorkedStepResponse(value: nil, revealed: true)]),
        ])
        XCTAssertEqual(result.questions.map(\.outcome), [.right, .partial, .skipped])
        XCTAssertEqual(result.earned, 2)
        XCTAssertEqual(result.total, 4)
        XCTAssertEqual(result.score, 0.5)
        XCTAssertFalse(result.passed)
        XCTAssertEqual(result.correct, 1)
        XCTAssertEqual(result.answered, 2)
        XCTAssertEqual(result.missed, ["q2", "q3"])
        XCTAssertEqual(result.topicsMissed, ["continuity"])

        let json = try XCTUnwrap(result.json)
        XCTAssertEqual(json["format"], .string("quiz"))
        XCTAssertEqual(json["score"], .number(0.5))
    }

    func testTypedAnswersCompareLikeTheEngine() {
        XCTAssertTrue(QuizGrader.sameAnswer("1/2", "0.5"))
        XCTAssertTrue(QuizGrader.sameAnswer(" Yes ", "yes"))
        XCTAssertTrue(QuizGrader.sameAnswer("−3", "-3"))
        XCTAssertFalse(QuizGrader.sameAnswer("1/0", "0"))
        XCTAssertFalse(QuizGrader.sameAnswer("2", "3"))
    }

    @MainActor
    func testAQuizOutputDecodesFromTheEngineAndUnderTheOldCheckId() throws {
        let id = UUID().uuidString
        for type in ["quiz", "check"] {
            let output = try Fixtures.decode(Output.self, """
            { "id": "\(id)", "title": "Limits check", "outputType": "\(type)", "payload": \(payload) }
            """)
            XCTAssertEqual(ItemShape(output.type, catalog: .bundled), .quiz)
            XCTAssertEqual(output.quiz?.questions.count, 3)
            XCTAssertEqual(PlayerPaging.sidewaysCount(of: output, catalog: .bundled), 4, "questions, then the result")
            XCTAssertEqual(try PersistenceCoding.decode(Output.self, from: PersistenceCoding.encode(output)).quiz,
                           output.quiz, "kept on save")
        }
        XCTAssertTrue(PlayerRegistry.standard.canPlay("check", catalog: .bundled))
    }

    @MainActor
    func testAFinishedQuizSendsItsResultWithTheTickEvenAfterMovingPast() throws {
        let defaults = UserDefaults(suiteName: "QuizTests.\(UUID().uuidString)")!
        let store = DoneTickStore(defaults: defaults, sendsAtOnce: false)
        let output = Fixtures.output("Quiz", type: "quiz",
                                     plan: PlanPosition(planID: "p1", nodeID: "n1", level: 0, ord: 0))
        store.markDone(output)  // scrolled past first
        let result = JSONValue.object(["score": .number(0.8)])
        store.markDone(output, result: result)
        let tick = try XCTUnwrap(store.ticks.values.first)
        XCTAssertEqual(tick.result, result)
        XCTAssertFalse(tick.isSettled, "sent again with the result")

        let body = String(decoding: try JSONEncoder().encode(DoneTickService.body(for: tick)), as: UTF8.self)
        XCTAssertTrue(body.contains(#""result":{"score":0.8}"#), body)
        XCTAssertTrue(body.contains(#""done":true"#))
    }
}
