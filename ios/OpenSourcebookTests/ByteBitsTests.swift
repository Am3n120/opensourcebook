import XCTest
@testable import OpenSourcebook

/// A byte is its bits (DECISIONS.md #34): bits from the engine as sent, and
/// old one-page outputs cut into bits on the phone without losing anything.
final class ByteBitsTests: XCTestCase {

    // MARK: - Old pages

    func testAnOldPageSplitsAtHeadingsAndKeepsAKickerWithItsHeading() {
        let page: [Block] = [
            .text("Opening line."),
            .kicker("1 · Start"),
            .heading("Limits"),
            .text("Both sides have to agree."),
            .heading("Continuity"),
            .bullets(["No jumps", "No holes"]),
        ]
        let bits = ByteCutter.bits(from: page)
        XCTAssertEqual(bits.map(\.blocks), [
            [.text("Opening line.")],
            [.kicker("1 · Start"), .heading("Limits"), .text("Both sides have to agree.")],
            [.heading("Continuity"), .bullets(["No jumps", "No holes"])],
        ])
        XCTAssertEqual(bits.map(\.id), ["b1", "b2", "b3"])
    }

    func testPageLayoutBlocksAreDroppedAndEverythingElseIsKeptInOrder() {
        let page: [Block] = [
            .toc(title: nil, items: ["A"]), .heading("A"), .text("one"), .divider, .spacer,
            .text("two"), .continuation, .quote(text: "q", author: nil, source: nil),
        ]
        let bits = ByteCutter.bits(from: page)
        XCTAssertEqual(bits.flatMap(\.blocks), [.heading("A"), .text("one"), .text("two"),
                                                .quote(text: "q", author: nil, source: nil)])
    }

    func testABitStaysInsideTheBudget() {
        let paragraph = String(repeating: "word ", count: 60) // 300 characters
        let page: [Block] = Array(repeating: .text(paragraph), count: 7)
        let bits = ByteCutter.bits(from: page)
        XCTAssertGreaterThan(bits.count, 1)
        for bit in bits {
            let cost = bit.blocks.map(ByteCutter.cost(of:)).reduce(0, +)
            XCTAssertLessThanOrEqual(cost, ByteCutter.budget)
        }
        XCTAssertEqual(bits.flatMap(\.blocks).count, 7, "no block lost")
    }

    func testALongTextIsSplitAtParagraphsThenSentencesWithNoWordLost() {
        let sentence = "This sentence is about sixty characters long, give or take. "
        let longParagraph = String(repeating: sentence, count: 40)
        let text = "Short first paragraph.\n\n" + longParagraph + "\n\nShort last paragraph."
        let bits = ByteCutter.bits(from: [.heading("Long"), .text(text)])

        XCTAssertGreaterThan(bits.count, 2)
        var pieces: [String] = []
        for bit in bits {
            for block in bit.blocks {
                if case .text(let piece) = block {
                    XCTAssertLessThanOrEqual(ByteCutter.cost(of: block), ByteCutter.budget)
                    pieces.append(piece)
                }
            }
        }
        let squeeze = { (s: String) in s.filter { !$0.isWhitespace } }
        XCTAssertEqual(squeeze(pieces.joined()), squeeze(text), "same words, same order")
    }

    func testFlashcardsBecomeOneFlipBitPerCardAndHeroAndAudioChangeShape() {
        let cards = [Flashcard(front: "f1", back: "b1"), Flashcard(front: "f2", back: "b2")]
        let bits = ByteCutter.bits(from: [
            .hero(url: "https://x.example/h.png", title: "Title", subtitle: nil),
            .flashcards(cards: cards),
            .audio(url: "https://pod.example/e1.mp3", title: "Episode", subtitle: nil),
        ])
        XCTAssertEqual(bits.map(\.kind), ["plain", "flip", "flip", "plain"])
        XCTAssertEqual(bits[0].blocks, [.figure(url: "https://x.example/h.png", caption: "Title", credit: nil, systemIcon: nil)])
        XCTAssertEqual(bits[1].blocks, [.flashcards(cards: [cards[0]])])
        XCTAssertEqual(bits[3].blocks, [.linkCard(url: "https://pod.example/e1.mp3", title: "Episode", domain: "pod.example")])
    }

    func testCuttingIsStable() {
        let page: [Block] = [.heading("A"), .text(String(repeating: "x ", count: 700)), .heading("B"), .text("y")]
        XCTAssertEqual(ByteCutter.bits(from: page), ByteCutter.bits(from: page))
    }

    func testAnEmptyPageHasNoBits() {
        XCTAssertEqual(ByteCutter.bits(from: []), [])
        XCTAssertEqual(ByteCutter.bits(from: [.divider, .spacer]), [])
    }

    func testCostFollowsTheContract() {
        XCTAssertEqual(ByteCutter.cost(of: .text("hi")), 40, "at least 40")
        XCTAssertEqual(ByteCutter.cost(of: .text(String(repeating: "a", count: 100))), 100)
        XCTAssertEqual(ByteCutter.cost(of: .bullets(["a", "b", "c"])), 40 + 80, "40 per item after the first")
        XCTAssertEqual(ByteCutter.cost(of: .image(url: "https://example.com/a-long-url.png", caption: nil, systemIcon: "photo")),
                       40 + 350, "urls and icons are not counted; media takes half a screen")
    }

    // MARK: - Stored outputs

    func testAnOldOutputOpensAsBitsAndANewOneKeepsItsOwn() {
        let old = Fixtures.output("Old", type: "read")
        var page = old
        page.blocks = [.heading("A"), .text("a"), .heading("B"), .text("b")]
        XCTAssertEqual(page.screens.count, 2)

        var made = old
        made.bits = [Bit(id: "x1", blocks: [.text("only")])]
        made.blocks = [.heading("ignored when bits exist")]
        XCTAssertEqual(made.screens.map(\.id), ["x1"])
        XCTAssertEqual(made.allBlocks, [.text("only")])
    }

    func testTheEngineByteDecodesWithItsBits() throws {
        let json = """
        {
          "schemaVersion": 2,
          "id": "0f6f2a3e-5a43-4a51-9d1c-3c2b9e1f7a10",
          "title": "One-sided limits",
          "subtitle": "Week 3 notes",
          "sourceKind": "note",
          "tags": ["calculus"],
          "depth": "tiny",
          "bits": [
            { "id": "b1", "kind": "plain", "section": "Limits",
              "blocks": [ { "type": "heading", "text": "Both sides have to agree" },
                          { "type": "hologram", "beam": 3 } ],
              "cites": [ { "sourceId": "src_7", "spot": "passage", "block": 1 } ] },
            { "id": "b2", "kind": "flip",
              "blocks": [ { "type": "flashcards", "cards": [ { "front": "Q", "back": "A" } ] } ] }
          ]
        }
        """
        let output = try Fixtures.decode(Output.self, json)
        XCTAssertEqual(output.type, "byte")
        XCTAssertEqual(output.density, .tiny)
        XCTAssertEqual(output.screens.map(\.id), ["b1", "b2"])
        XCTAssertEqual(output.screens[0].section, "Limits")
        XCTAssertEqual(output.screens[0].cites.count, 1)
        XCTAssertEqual(output.screens[0].blocks.count, 2, "an unknown block is kept, drawn as a fallback")
        XCTAssertTrue(output.screens[0].isDrawable)

        let data = try PersistenceCoding.encode(output)
        XCTAssertEqual(try PersistenceCoding.decode(Output.self, from: data).bits, output.bits, "bits survive a save")
    }

    func testABitWithNothingDrawableSaysSo() {
        let bit = Bit(id: "b1", blocks: [.unsupported(type: "hologram", payload: .object([:]))])
        XCTAssertFalse(bit.isDrawable)
        XCTAssertFalse(Bit(id: "b2", blocks: []).isDrawable)
    }
}
