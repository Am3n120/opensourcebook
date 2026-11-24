import XCTest
@testable import OpenSourcebook

final class OutputDecodingTests: XCTestCase {

    private let id = "6F9619FF-8B86-D011-B42D-00C04FC964FF"

    func testDecodesTheEnginesAugustWireFormat() throws {
        let json = """
        {
          "id": "\(id)",
          "type": "paper",
          "title": "Attention is all you need",
          "subtitle": "arxiv.org",
          "byteDepth": "deep",
          "status": { "type": "ready" },
          "tags": ["ml"],
          "blocks": [ { "type": "heading", "text": "Intro" } ]
        }
        """
        let output = try Fixtures.decode(Output.self, json)

        XCTAssertEqual(output.id, UUID(uuidString: id))
        XCTAssertEqual(output.sourceKind, .paper, "wire `type` is the source kind")
        XCTAssertEqual(output.density, .deep, "wire `byteDepth` is the density")
        XCTAssertEqual(output.type, "byte", "no output type on the wire means a byte")
        XCTAssertFalse(output.isSaveOnly)
        XCTAssertEqual(output.blocks, [.heading("Intro")])
        XCTAssertNil(output.plan)
        XCTAssertNil(output.projectID)
    }

    func testWireStatusSaveOnlyMarksTheOutputSaveOnly() throws {
        let json = """
        { "id": "\(id)", "type": "link", "title": "A link", "byteDepth": "medium",
          "status": { "type": "saveOnly" } }
        """
        let output = try Fixtures.decode(Output.self, json)
        XCTAssertTrue(output.isSaveOnly)
        XCTAssertEqual(output.sourceKind, .link)
    }

    func testSaveOnlyDensityImpliesSaveOnlyWhenNoStatusIsGiven() throws {
        let json = """
        { "id": "\(id)", "type": "link", "title": "A link", "byteDepth": "saveOnly" }
        """
        let output = try Fixtures.decode(Output.self, json)
        XCTAssertEqual(output.density, .saveOnly)
        XCTAssertTrue(output.isSaveOnly)
    }

    func testMissingOptionalFieldsTakeDefaults() throws {
        let output = try Fixtures.decode(Output.self, #"{ "id": "\#(id)", "title": "Bare" }"#)
        XCTAssertEqual(output.subtitle, "")
        XCTAssertEqual(output.sourceKind, .other)
        XCTAssertEqual(output.density, .medium)
        XCTAssertEqual(output.tags, [])
        XCTAssertEqual(output.blocks, [])
    }

    func testTitleIsRequired() {
        XCTAssertThrowsError(try Fixtures.decode(Output.self, #"{ "id": "\#(id)" }"#))
    }

    func testOwnFormatRoundTripsWithAPlanPosition() throws {
        let original = Output(
            type: "bits",
            title: "Eigenvalues",
            subtitle: "Lay §5",
            sourceKind: .paper,
            sourceDomain: "example.edu",
            author: "Lay",
            createdAt: Fixtures.date(3),
            tags: ["math", "la"],
            durationText: "4 min read",
            excerpt: "Why eigenvectors matter.",
            projectID: "project-1",
            plan: Fixtures.position("plan-1", level: 2, ord: 1),
            blocks: [.heading("Eigen"), .bullets(["a", "b"])],
            density: .light
        )
        let data = try PersistenceCoding.encode(original)
        let decoded = try PersistenceCoding.decode(Output.self, from: data)

        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "bits")
        XCTAssertEqual(decoded.plan?.level, 2)
        XCTAssertEqual(decoded.plan?.ord, 1)
    }

    func testOwnFormatRoundTripsWithoutAPlanPosition() throws {
        let original = Fixtures.output("Single", minutes: 1, type: "cards")
        let data = try PersistenceCoding.encode(original)

        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["plan"], "an unplanned output writes no plan key")
        XCTAssertNil(object["projectID"])
        XCTAssertEqual(object["outputType"] as? String, "cards")

        let decoded = try PersistenceCoding.decode(Output.self, from: data)
        XCTAssertEqual(decoded, original)
        XCTAssertNil(decoded.plan)
    }

    func testStoredOutputsWithOldOrRetiredFormatsStillDecode() throws {
        for raw in ["bits", "read", "check", "cards", "slides", "hologram"] {
            let json = """
            { "id": "\(UUID().uuidString)", "title": "Kept", "outputType": "\(raw)" }
            """
            let output = try Fixtures.decode(Output.self, json)
            XCTAssertEqual(output.type.rawValue, raw, "the stored id is kept as it is")
        }
        XCTAssertEqual(FormatCatalog.bundled.canonicalID(for: "check"), "quiz")
    }

    func testEncodingWritesTheOwnShapeNotTheWireShape() throws {
        let data = try PersistenceCoding.encode(Fixtures.output("x"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["type"])
        XCTAssertNil(object["byteDepth"])
        XCTAssertNil(object["status"])
        XCTAssertNotNil(object["sourceKind"])
    }

    func testFirstYouTubeIDComesFromTheFirstVideoBlock() {
        var output = Fixtures.output("Video")
        output.blocks = [.text("hi"), .video(youtubeID: "abc123", title: nil), .video(youtubeID: "zzz", title: nil)]
        XCTAssertEqual(output.firstYouTubeID, "abc123")
        output.blocks = [.text("hi")]
        XCTAssertNil(output.firstYouTubeID)
    }
}

final class BlockDecodingTests: XCTestCase {

    func testDecodesKnownBlocks() throws {
        XCTAssertEqual(try Fixtures.decode(Block.self, #"{"type":"heading","text":"H"}"#), .heading("H"))
        XCTAssertEqual(try Fixtures.decode(Block.self, #"{"type":"text","text":"body"}"#), .text("body"))
        XCTAssertEqual(try Fixtures.decode(Block.self, #"{"type":"divider"}"#), .divider)
        XCTAssertEqual(try Fixtures.decode(Block.self, #"{"type":"bullets","items":["a","b"]}"#), .bullets(["a", "b"]))
        XCTAssertEqual(
            try Fixtures.decode(Block.self, #"{"type":"quote","text":"Q","author":"A"}"#),
            .quote(text: "Q", author: "A", source: nil)
        )
        XCTAssertEqual(
            try Fixtures.decode(Block.self, #"{"type":"video","youtubeID":"yt1"}"#),
            .video(youtubeID: "yt1", title: nil)
        )
    }

    func testUnknownTypeFallsBackToUnsupportedAndKeepsItsPayload() throws {
        let block = try Fixtures.decode(
            Block.self,
            #"{"type":"hologram","depth":3,"label":"future","nested":{"a":[1,2]}}"#
        )
        guard case .unsupported(let type, let payload) = block else {
            return XCTFail("expected .unsupported, got \(block)")
        }
        XCTAssertEqual(type, "hologram")
        XCTAssertEqual(payload["label"]?.stringValue, "future")
        XCTAssertEqual(payload["depth"], .number(3))
        XCTAssertEqual(payload["nested"]?["a"], .array([.number(1), .number(2)]))
    }

    func testUnsupportedBlockSurvivesASaveAndLoad() throws {
        let block = try Fixtures.decode(Block.self, #"{"type":"hologram","label":"future"}"#)
        let data = try JSONEncoder().encode(block)
        let again = try JSONDecoder().decode(Block.self, from: data)
        XCTAssertEqual(again, block)
    }

    func testKnownTypeMissingARequiredFieldThrows() {
        XCTAssertThrowsError(try Fixtures.decode(Block.self, #"{"type":"heading"}"#))
    }

    func testTypeIsRequired() {
        XCTAssertThrowsError(try Fixtures.decode(Block.self, #"{"text":"no type"}"#))
    }

    func testKnownBlocksRoundTrip() throws {
        let blocks: [Block] = [
            .kicker("1 · START"), .heading("H"), .subheading("S"), .text("t"), .divider,
            .bullets(["x"]), .numbered(["y"]), .quote(text: "q", author: nil, source: "book")
        ]
        let data = try JSONEncoder().encode(blocks)
        XCTAssertEqual(try JSONDecoder().decode([Block].self, from: data), blocks)
    }
}

final class PlanDecodingTests: XCTestCase {

    func testUnknownStatusDecodesAsUnknownInsteadOfFailing() throws {
        let status = try Fixtures.decode([PlanNodeStatus].self, #"["running","paused","done"]"#)
        XCTAssertEqual(status, [.running, .unknown, .done])
    }

    func testOnlyQueuedAndRunningAreActive() {
        // Listed by hand: PlanNodeStatus is not CaseIterable.
        let all: [PlanNodeStatus] = [.pending, .queued, .running, .done, .failed, .skipped, .cancelled, .unknown]
        XCTAssertEqual(Set(all.filter(\.isActive)), [.queued, .running])
    }
}
