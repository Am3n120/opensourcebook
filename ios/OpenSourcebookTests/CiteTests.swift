import XCTest
@testable import OpenSourcebook

/// Citations as the phone shows them: one chip per source with where, and
/// the cited spot in its place in the source's text.
final class CiteTests: XCTestCase {

    private func cite(_ json: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    func testCitesGroupBySourceInFirstCitedOrderWithoutRepeats() {
        let raw = [
            cite(#"{ "sourceId": "s2", "spot": "passage", "locator": { "page": 4 }, "quote": "both sides", "block": 1 }"#),
            cite(#"{ "sourceId": "s1", "spot": "image", "assetId": "a1", "locator": { "page": 2 } }"#),
            cite(#"{ "sourceId": "s2", "spot": "passage", "locator": { "page": 4 }, "quote": "both sides", "block": 2 }"#),
            cite(#"{ "sourceId": "s2", "spot": "passage", "locator": { "page": 5 }, "quote": "other words" }"#),
            cite(#"{ "not": "a cite" }"#),
        ]
        let groups = CiteGroup.groups(raw)
        XCTAssertEqual(groups.map(\.sourceId), ["s2", "s1"])
        XCTAssertEqual(groups[0].cites.count, 2, "the same spot and quote for two blocks shows once")
        XCTAssertEqual(groups[1].cites.first?.assetId, "a1")
    }

    func testChipLabelsNameTheSourceAndWhereWhenThereIsOnePlace() {
        let onePage = CiteGroup.groups([cite(#"{ "sourceId": "s", "locator": { "page": 4 } }"#),
                                        cite(#"{ "sourceId": "s", "locator": { "page": 4 }, "quote": "q" }"#)])[0]
        XCTAssertEqual(onePage.chipLabel(sourceName: "Week 3 notes", position: 0), "Week 3 notes · page 4")

        let twoPages = CiteGroup.groups([cite(#"{ "sourceId": "s", "locator": { "page": 4 } }"#),
                                         cite(#"{ "sourceId": "s", "locator": { "page": 5 } }"#)])[0]
        XCTAssertEqual(twoPages.chipLabel(sourceName: "Week 3 notes", position: 0), "Week 3 notes")

        let charsOnly = CiteGroup.groups([cite(#"{ "sourceId": "s", "locator": { "charStart": 0, "charEnd": 9 } }"#)])[0]
        XCTAssertEqual(charsOnly.chipLabel(sourceName: nil, position: 1), "Source 2", "without a name, a number")
        XCTAssertEqual(charsOnly.chipLabel(sourceName: "  ", position: 0), "Source 1")
    }

    func testPlacesInWords() {
        XCTAssertEqual(Cite(sourceId: "s", locator: SourceLocator(page: 3, endPage: 9)).place, "pages 3–9")
        XCTAssertEqual(Cite(sourceId: "s", locator: SourceLocator(page: 3, endPage: 3)).place, "page 3")
        XCTAssertEqual(Cite(sourceId: "s", locator: SourceLocator(slide: 2)).place, "slide 2")
        XCTAssertEqual(Cite(sourceId: "s", spot: .moment, locator: SourceLocator(startMs: 42_000, endMs: 65_500)).place, "0:42–1:05")
        XCTAssertEqual(Cite(sourceId: "s", locator: SourceLocator(startMs: 3_725_000)).place, "1:02:05")
        XCTAssertEqual(Cite(sourceId: "s", spot: .cell, locator: SourceLocator(cell: "B4")).place, "cell B4")
        XCTAssertNil(Cite(sourceId: "s", locator: SourceLocator(charStart: 0, charEnd: 10)).place)
        XCTAssertNil(Cite(sourceId: "s").place)
    }

    func testAnUnknownSpotIsDrawnAsAPassageAndKeepsItsName() throws {
        let decoded = try XCTUnwrap(Cite.list([cite(#"{ "sourceId": "s", "spot": "hologram", "quote": "  hi  " }"#)]).first)
        XCTAssertEqual(decoded.spot.rawValue, "hologram")
        XCTAssertEqual(decoded.spot.drawnAs, .passage)
        XCTAssertEqual(decoded.spot.label, "Passage")
        XCTAssertEqual(decoded.quote, "hi")
        XCTAssertTrue(CiteSpot.graph.isPicture)
        XCTAssertFalse(CiteSpot.moment.isPicture)
        XCTAssertEqual(CiteSpot.known.count, 7)
    }

    // MARK: The spot in its place

    func testTheQuoteIsMarkedInsideItsSpan() throws {
        let text = "Intro. A limit exists only when both one-sided limits agree. Otherwise there is none."
        let span = (text as NSString).range(of: "A limit exists only when both one-sided limits agree.")
        let cite = Cite(sourceId: "s", locator: SourceLocator(charStart: span.location, charEnd: span.location + span.length),
                        quote: "both ONE-SIDED limits agree")
        let excerpt = try XCTUnwrap(CiteExcerpt.make(text: text, cite: cite))
        XCTAssertEqual(excerpt.marked, "both one-sided limits agree")
        XCTAssertEqual(excerpt.before, "Intro. A limit exists only when ")
        XCTAssertEqual(excerpt.after, ". Otherwise there is none.")
    }

    func testWithoutTheQuoteTheSpanIsMarkedAndWithoutASpanTheQuoteIsFound() throws {
        let text = "One. Two three. Four."
        let span = try XCTUnwrap(CiteExcerpt.make(text: text, cite: Cite(sourceId: "s", locator: SourceLocator(charStart: 5, charEnd: 15))))
        XCTAssertEqual(span.marked, "Two three.")
        let found = try XCTUnwrap(CiteExcerpt.make(text: text, cite: Cite(sourceId: "s", quote: "four")))
        XCTAssertEqual(found.marked, "Four")
        XCTAssertNil(CiteExcerpt.make(text: text, cite: Cite(sourceId: "s", quote: "five")))
        XCTAssertNil(CiteExcerpt.make(text: text, cite: Cite(sourceId: "s")))
        XCTAssertNil(CiteExcerpt.make(text: text, cite: Cite(sourceId: "s", locator: SourceLocator(charStart: 90, charEnd: 99))))
    }

    func testOffsetsAreTheEnginesUTF16OffsetsAndNeverSplitACharacter() throws {
        // "👋" is two UTF-16 units: the engine's offset 3 is just after it.
        let text = "👋 hello world"
        let cite = Cite(sourceId: "s", locator: SourceLocator(charStart: 3, charEnd: 8))
        XCTAssertEqual(try XCTUnwrap(CiteExcerpt.make(text: text, cite: cite)).marked, "hello")
        let inside = Cite(sourceId: "s", locator: SourceLocator(charStart: 1, charEnd: 2))
        XCTAssertEqual(try XCTUnwrap(CiteExcerpt.make(text: text, cite: inside)).marked, "👋")
    }

    func testALongPassageIsTrimmedAtWordsAroundTheMark() throws {
        let words = (1...200).map { "w\($0)" }.joined(separator: " ")
        let text = words + " THE QUOTE " + words
        let excerpt = try XCTUnwrap(CiteExcerpt.make(text: text, cite: Cite(sourceId: "s", quote: "the quote"), radius: 40))
        XCTAssertEqual(excerpt.marked, "THE QUOTE")
        XCTAssertTrue(excerpt.before.hasPrefix("…"))
        XCTAssertTrue(excerpt.after.hasSuffix("…"))
        XCTAssertLessThanOrEqual(excerpt.before.count, 42)
        XCTAssertFalse(excerpt.before.dropFirst().hasPrefix(" "))
    }

    func testARealByteCitesQuotesThatAreInTheRealSource() throws {
        let body = try StudioJSON.decoder.decode([String: StudioOutput].self, from: StudioDecodingTests.fixture("studio-output-byte"))
        let output = try XCTUnwrap(body["output"]?.playable(at: nil))
        let detail = try StudioJSON.decoder.decode(StudioSourceDetail.self, from: StudioDecodingTests.fixture("studio-source"))
        let text = try XCTUnwrap(detail.extraction?.text)
        let cites = Cite.list(output.bits[0].cites)
        XCTAssertFalse(cites.isEmpty)
        for cite in cites {
            let excerpt = try XCTUnwrap(CiteExcerpt.make(text: text, cite: cite))
            XCTAssertEqual(excerpt.marked, cite.quote, "the quote is found word for word in its span")
        }
    }
}
