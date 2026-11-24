import XCTest
@testable import OpenSourcebook

/// The engine's Studio shapes (engine/docs/api.md), read from the doc's own
/// examples and from outputs a real model made in a local run (Nov 12, 2026;
/// trimmed to a few bits and questions) in `OpenSourcebookTests/Fixtures`.
final class StudioDecodingTests: XCTestCase {

    static func fixture(_ name: String) throws -> Data {
        let bundle = Bundle(for: StudioDecodingTests.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: name, withExtension: "json")
                ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"),
            "missing fixture \(name).json"
        )
        return try Data(contentsOf: url)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try StudioJSON.decoder.decode(type, from: Data(json.utf8))
    }

    // MARK: Projects and plans

    func testTheProjectExampleDecodesAndOptionalFieldsMayBeMissing() throws {
        let full = try decode(StudioProject.self, """
        { "id": "p1", "title": "Calculus I", "icon": "book", "colorHex": 3355443, "category": "math",
          "settings": {}, "createdAt": "2026-11-12T18:22:37.974Z", "updatedAt": "2026-11-12T18:50:41Z",
          "archivedAt": "2026-11-13T00:00:00Z", "somethingNew": [1, 2] }
        """)
        XCTAssertEqual(full.title, "Calculus I")
        XCTAssertEqual(full.colorHex, 3355443)
        XCTAssertEqual(full.category, "math")
        XCTAssertNotNil(full.createdAt)
        XCTAssertNotNil(full.archivedAt)

        let bare = try decode(StudioProject.self, #"{ "id": "p2", "title": "Spanish" }"#)
        XCTAssertNil(bare.icon)
        XCTAssertNil(bare.colorHex)
        XCTAssertNil(bare.createdAt)
    }

    func testARealPlanViewDecodesInRunOrderWithItsStatuses() throws {
        let view = try StudioJSON.decoder.decode(StudioPlanView.self, from: Self.fixture("studio-plan-view"))
        XCTAssertEqual(view.plan.title, "Real run")
        XCTAssertEqual(view.plan.status, .failed)
        XCTAssertNotNil(view.plan.kickedOffAt)
        XCTAssertEqual(view.items.count, 6)
        XCTAssertEqual(view.items.map(\.type.rawValue), ["byte", "byte", "byte", "quiz", "quiz", "quiz"])
        XCTAssertEqual(view.items.first?.status, .failed)
        XCTAssertNil(view.items.first?.outputId)
        XCTAssertEqual(view.items[2].outputId, "7768ce3d-7624-4bc7-9e3b-3f91bcd9d0b9")
        XCTAssertNotNil(view.items[2].outputUUID)
        XCTAssertEqual(view.counts, StudioCounts(total: 6, done: 0))
        XCTAssertEqual(view.estimateUsd, 0)
    }

    func testAnItemKeepsItsBranchAskingAndResultAndUnknownValuesAsSent() throws {
        let item = try decode(StudioItem.self, """
        { "id": "i2", "parentId": "i1", "level": 1, "ord": 0, "type": "hologram", "title": "Fix the gaps",
          "prompt": "Only what was missed.", "settings": { "questions": 10 },
          "condition": { "kind": "ask", "question": "More practice?" },
          "enabled": true, "estCostUsd": 0.12, "status": "paused",
          "sources": [{ "sourceId": "s1", "range": { "page": 3, "endPage": 9 } }],
          "done": false, "result": { "score": 0.8 }, "asking": { "question": "More practice?" } }
        """)
        XCTAssertEqual(item.parentId, "i1")
        XCTAssertEqual(item.type, "hologram", "a format id no registry knows is kept")
        XCTAssertEqual(item.status, .unknown)
        XCTAssertEqual(item.condition?["kind"], .string("ask"))
        XCTAssertEqual(item.result?["score"], .number(0.8))
        XCTAssertEqual(item.asking?.question, "More practice?")
        XCTAssertNil(item.outputUUID)
    }

    func testAPlanViewSkipsAnItemItCannotReadAndKeepsTheRest() throws {
        let view = try decode(StudioPlanView.self, """
        { "plan": { "id": "pl", "projectId": "p", "title": "T", "status": "brand-new" },
          "stages": [{ "level": 1, "label": "Practice" }, { "nope": true }],
          "items": [{ "id": "a", "type": "byte", "title": "A" }, { "title": "no id" }],
          "edges": [], "issues": ["x"] }
        """)
        XCTAssertEqual(view.items.map(\.id), ["a"])
        XCTAssertEqual(view.items.first?.status, .unknown, "a missing status reads as unknown")
        XCTAssertEqual(view.stages, [StudioStage(level: 1, label: "Practice")])
        XCTAssertEqual(view.plan.status.rawValue, "brand-new")
        XCTAssertEqual(view.plan.status.label, "Brand-New")
    }

    // MARK: Made things

    func testARealByteBecomesBitsWithTheirCitesAndItsPlanPlace() throws {
        let body = try StudioJSON.decoder.decode([String: StudioOutput].self, from: Self.fixture("studio-output-byte"))
        let made = try XCTUnwrap(body["output"])
        XCTAssertEqual(made.type, "byte")
        let position = PlanPosition(planID: "dfc6feef-8fed-4836-836e-32d560fb7cbf", nodeID: "08ec8551-b6dd-4154-83cb-8ac6b9fc30ba", level: 0, ord: 2)

        let output = try XCTUnwrap(made.playable(at: position))

        XCTAssertEqual(output.id, UUID(uuidString: "7768ce3d-7624-4bc7-9e3b-3f91bcd9d0b9"))
        XCTAssertEqual(output.type, "byte")
        XCTAssertEqual(output.title, "The Printing Press")
        XCTAssertEqual(output.sourceKind, .article)
        XCTAssertEqual(output.projectID, "0b53b8ea-ddbc-4c59-9b00-c097cfcbaf4a")
        XCTAssertEqual(output.plan, position)
        XCTAssertEqual(output.bits.count, 3)
        XCTAssertEqual(output.bits.map(\.id), ["b1", "b2", "b3"])
        XCTAssertFalse(output.bits[0].cites.isEmpty)
        XCTAssertEqual(Cite.list(output.bits[0].cites).first?.spot, .passage)
        XCTAssertEqual(output.createdAt, StudioJSON.parse("2026-11-12T18:31:36.860Z"))
    }

    func testWithoutAPlanViewTheOutputStillNamesItsItem() throws {
        let body = try StudioJSON.decoder.decode([String: StudioOutput].self, from: Self.fixture("studio-output-byte"))
        let output = try XCTUnwrap(body["output"]?.playable(at: nil))
        XCTAssertEqual(output.plan?.planID, "dfc6feef-8fed-4836-836e-32d560fb7cbf")
        XCTAssertEqual(output.plan?.nodeID, "08ec8551-b6dd-4154-83cb-8ac6b9fc30ba")
    }

    func testARealQuizBecomesQuestionsWithTheirCites() throws {
        let body = try StudioJSON.decoder.decode([String: StudioOutput].self, from: Self.fixture("studio-output-quiz"))
        let output = try XCTUnwrap(body["output"]?.playable(at: nil))
        XCTAssertEqual(output.type, "quiz")
        let quiz = try XCTUnwrap(output.quiz)
        XCTAssertEqual(quiz.questions.count, 2)
        XCTAssertEqual(quiz.feedback, .afterEach)
        XCTAssertEqual(quiz.passMark, 0.7)
        let cites = Cite.list(quiz.questions[0].cites)
        XCTAssertFalse(cites.isEmpty)
        XCTAssertEqual(cites.first?.spot, .passage, "a quiz cite without a spot is a passage")
        XCTAssertNotNil(cites.first?.quote)
    }

    func testAnOldIdAVideoAndABadIdAreHandledHonestly() throws {
        let old = StudioOutput(id: UUID().uuidString, type: "read", title: "Old page", summary: "s",
                               payload: .object(["schemaVersion": .number(2), "title": .string("Old page"),
                                                 "subtitle": .string("x"), "sourceKind": .string("hologram"),
                                                 "bits": .array([.object(["id": .string("b1"), "kind": .string("plain"),
                                                                          "blocks": .array([.object(["type": .string("text"), "text": .string("Hi")])])])])]))
        let read = try XCTUnwrap(old.playable(at: nil))
        XCTAssertEqual(read.bits.count, 1, "an old id reads as a byte")
        XCTAssertEqual(read.sourceKind, .other, "an unknown source kind reads as other")
        XCTAssertEqual(read.type, "read", "the id is kept as sent; the catalog resolves it")

        let video = try XCTUnwrap(StudioOutput(id: UUID().uuidString, type: "video", title: "Clip").playable(at: nil))
        XCTAssertTrue(video.bits.isEmpty)
        XCTAssertNil(video.quiz)
        XCTAssertEqual(video.title, "Clip")

        let broken = try XCTUnwrap(StudioOutput(id: UUID().uuidString, type: "byte", title: "Broken", payload: .string("?")).playable(at: nil))
        XCTAssertEqual(broken.title, "Broken", "an unreadable payload keeps the title; the player says it has no bits")
        XCTAssertTrue(broken.screens.isEmpty)

        XCTAssertNil(StudioOutput(id: "out_1", type: "byte", title: "x").playable(at: nil), "the phone keys outputs by UUID")
    }

    func testAVideoPlaysItsFileAndSaysWhenItIsAStoryboard() throws {
        let body = try decode([String: StudioOutput].self, """
        { "output": { "id": "8a4c2f43-29a1-4c0e-9d37-2b0f4c6a1e55", "type": "video", "title": "Why the sky is blue",
          "schemaVersion": 1, "createdAt": "2026-11-13T09:00:00Z", "updatedAt": "2026-11-13T09:00:00Z", "citations": [],
          "payload": { "schemaVersion": 1, "title": "Why the sky is blue", "idea": "Blue scatters more.",
            "aspect": { "width": 9, "height": 16 },
            "scenes": [ { "id": "s1", "kind": "question", "durationMs": 5000,
                          "visual": { "kind": "photo", "description": "A clear sky." },
                          "narration": "Why blue?", "onScreenText": [], "cites": [] } ],
            "render": { "by": "storyboard", "storyboard": true, "assetId": "a1", "url": "/v1/assets/a1",
                        "contentType": "video/mp4", "width": 720, "height": 1280, "fps": 10, "durationMs": 5000,
                        "audio": false, "captions": true, "scenes": [ { "id": "s1", "startMs": 0, "endMs": 5000 } ],
                        "renderMs": 400, "madeAt": "2026-11-13T09:00:00Z" } } } }
        """)
        let output = try XCTUnwrap(body["output"]?.playable(at: nil))
        XCTAssertEqual(output.type, "video")
        XCTAssertEqual(output.video, VideoFile(url: "/v1/assets/a1", storyboard: true, by: "storyboard"))

        let stored = try JSONDecoder().decode(Output.self, from: JSONEncoder().encode(output))
        XCTAssertEqual(stored.video, output.video, "the file survives the phone's own store")

        let finished = VideoFile.from(payload: .object(["render": .object(["url": .string("/v1/assets/b"), "storyboard": .bool(false)])]))
        XCTAssertEqual(finished?.storyboard, false)
        let unsaid = VideoFile.from(payload: .object(["render": .object(["url": .string("/v1/assets/c")])]))
        XCTAssertEqual(unsaid?.storyboard, true, "a file that does not say it is finished is shown as a storyboard")
        XCTAssertNil(VideoFile.from(payload: .object(["scenes": .array([])])))
    }

    // MARK: Sources

    func testARealSourceDetailGivesItsTitleAndText() throws {
        let detail = try StudioJSON.decoder.decode(StudioSourceDetail.self, from: Self.fixture("studio-source"))
        XCTAssertEqual(detail.source.id, "b8fc6093-bb6f-48cb-b71e-845c56297859")
        XCTAssertEqual(detail.extraction?.status, "ready")
        XCTAssertEqual(detail.displayTitle, detail.source.title)
        XCTAssertEqual(detail.extraction?.text?.utf16.count, 1873)
    }

    func testALocatorReadsNumbersEitherWayAndACellAsText() throws {
        let locator = try decode(SourceLocator.self, #"{ "page": 4.0, "startMs": 1200, "cell": "B4", "future": 1 }"#)
        XCTAssertEqual(locator.page, 4)
        XCTAssertEqual(locator.startMs, 1200)
        XCTAssertEqual(locator.cell, "B4")
        XCTAssertEqual(try decode(SourceLocator.self, #"{ "cell": 7 }"#).cell, "7")
    }

    func testTimesWithAndWithoutFractionsRead() {
        XCTAssertNotNil(StudioJSON.parse("2026-11-12T18:22:37.974Z"))
        XCTAssertNotNil(StudioJSON.parse("2026-11-12T18:22:37Z"))
        XCTAssertNil(StudioJSON.parse("yesterday"))
    }
}
