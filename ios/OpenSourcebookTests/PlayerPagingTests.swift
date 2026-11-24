import XCTest
@testable import OpenSourcebook

/// The gesture rule (DECISIONS.md #36): down is the next item, up the
/// previous; moving down past an item finishes it; sideways is inside.
final class PlayerPagingTests: XCTestCase {
    private let a = UUID()
    private let b = UUID()
    private let c = UUID()
    private var order: [UUID] { [a, b, c] }

    func testPagesAreTheItemsThenTheEnd() {
        XCTAssertEqual(PlayerPaging.pages(order), [.item(a), .item(b), .item(c), .end])
        XCTAssertEqual(PlayerPaging.pages([]), [.end])
    }

    func testMovingDownFinishesTheItemLeftBehind() {
        XCTAssertEqual(PlayerPaging.finished(movingFrom: .item(a), to: .item(b), in: order), a)
        XCTAssertEqual(PlayerPaging.finished(movingFrom: .item(c), to: .end, in: order), c, "reaching the end finishes the last")
        XCTAssertEqual(PlayerPaging.finished(movingFrom: nil, to: .item(b), in: order), a, "nil is the first page")
    }

    func testMovingUpOrStayingFinishesNothing() {
        XCTAssertNil(PlayerPaging.finished(movingFrom: .item(b), to: .item(a), in: order))
        XCTAssertNil(PlayerPaging.finished(movingFrom: .end, to: .item(c), in: order))
        XCTAssertNil(PlayerPaging.finished(movingFrom: .item(b), to: .item(b), in: order))
        XCTAssertNil(PlayerPaging.finished(movingFrom: .item(a), to: nil, in: order))
        XCTAssertNil(PlayerPaging.finished(movingFrom: .item(UUID()), to: .item(b), in: order), "an item not in the list")
    }

    func testNeighboursStopAtBothEnds() {
        XCTAssertEqual(PlayerPaging.neighbour(of: .item(a), in: order, down: true), .item(b))
        XCTAssertEqual(PlayerPaging.neighbour(of: .item(c), in: order, down: true), .end)
        XCTAssertNil(PlayerPaging.neighbour(of: .end, in: order, down: true))
        XCTAssertNil(PlayerPaging.neighbour(of: .item(a), in: order, down: false))
        XCTAssertEqual(PlayerPaging.neighbour(of: nil, in: order, down: true), .item(b), "nil is the first page")
    }

    func testAByteMovesSidewaysThroughItsBits() {
        var byte = Fixtures.output("Byte", type: "byte")
        byte.blocks = [.heading("One"), .text("1"), .heading("Two"), .text("2"), .heading("Three"), .text("3")]
        XCTAssertEqual(PlayerPaging.sidewaysCount(of: byte, catalog: .bundled), 3)

        var old = Fixtures.output("Old", type: "bits")
        old.blocks = byte.blocks
        XCTAssertEqual(PlayerPaging.sidewaysCount(of: old, catalog: .bundled), 3, "an old bits output too")
    }

    func testAVideoFillsTheScreenWithNothingSideways() throws {
        let video = try Fixtures.decode(Output.self, Self.videoFixture)
        XCTAssertEqual(ItemShape(video.type, catalog: .bundled), .video)
        XCTAssertEqual(PlayerPaging.sidewaysCount(of: video, catalog: .bundled), 0,
                       "even with several blocks, a video has nothing sideways")
        XCTAssertEqual(VideoPlayerView.media(of: video), .clip(url: "https://example.com/lecture.mp4", startSeconds: 120,
                                                              endSeconds: 180, title: "The key minute", posterURL: nil, platform: nil))
        XCTAssertNil(VideoPlayerView.media(of: Fixtures.output("No media", type: "video")))
    }

    /// A video output as the phone might store one: its moving picture is a
    /// clip block, with words around it that are not drawn sideways.
    private static let videoFixture = """
    { "id": "00000000-0000-0000-0000-0000000000a1", "title": "Limits in one minute", "outputType": "video",
      "blocks": [
        { "type": "heading", "text": "Limits" },
        { "type": "clip", "url": "https://example.com/lecture.mp4", "startSeconds": 120, "endSeconds": 180,
          "title": "The key minute" },
        { "type": "text", "text": "Both sides agree." }
      ] }
    """

    func testASavedSidewaysPositionStaysInRange() {
        XCTAssertEqual(PlayerPaging.clamped(7, count: 3), 2, "an old block index from a long page")
        XCTAssertEqual(PlayerPaging.clamped(-1, count: 3), 0)
        XCTAssertEqual(PlayerPaging.clamped(4, count: 0), 0)
    }
}
