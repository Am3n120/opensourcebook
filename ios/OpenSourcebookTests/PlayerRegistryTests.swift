import SwiftUI
import XCTest
@testable import OpenSourcebook

@MainActor
final class PlayerRegistryTests: XCTestCase {
    private let catalog = FormatCatalog.bundled

    func testStandardPlaysBytesAndOldBitsAndReadAndStreamsThemInTheFeed() {
        let registry = PlayerRegistry.standard
        for id: FormatID in ["byte", "bits", "read"] {
            XCTAssertTrue(registry.canPlay(id, catalog: catalog))
            XCTAssertTrue(registry.playsInFeed(id, catalog: catalog))
        }
    }

    func testEachShapeHasAPlayerAndVideoStaysOutOfTheFeedForNow() {
        let registry = PlayerRegistry.standard
        for shape in ItemShape.allCases {
            XCTAssertTrue(registry.canPlay(shape.formatID, catalog: catalog), "\(shape)")
        }
        XCTAssertTrue(registry.playsInFeed("quiz", catalog: catalog))
        XCTAssertFalse(registry.playsInFeed("video", catalog: catalog))
    }

    func testFormatsWithoutAPlayerOrUnknownToTheCatalogHaveNone() {
        let registry = PlayerRegistry.standard
        for id: FormatID in ["flashcards", "slides", "hologram"] {
            XCTAssertFalse(registry.canPlay(id, catalog: catalog))
            XCTAssertFalse(registry.playsInFeed(id, catalog: catalog))
        }
        XCTAssertNil(registry.player(for: Fixtures.output("x", type: "slides"), catalog: catalog))
    }

    func testAnOldIdPlaysWithItsFormatsPlayer() {
        var registry = PlayerRegistry()
        registry.register("quiz") { _ in EmptyView() }
        XCTAssertTrue(registry.canPlay("check", catalog: catalog))
        XCTAssertFalse(registry.playsInFeed("check", catalog: catalog), "not registered for the feed")
        XCTAssertNotNil(registry.player(for: Fixtures.output("x", type: "check"), catalog: catalog))
    }
}
