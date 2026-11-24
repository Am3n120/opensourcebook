import XCTest
@testable import OpenSourcebook

final class FormatCatalogTests: XCTestCase {
    private let bundled = FormatCatalog.bundled

    func testBundledCatalogIsTheThreeShapes() {
        XCTAssertEqual(bundled.formats.map(\.id.rawValue), ["byte", "quiz", "video"])
        XCTAssertEqual(bundled.formats.map(\.label), ["byte", "quiz", "video"])
        XCTAssertEqual(bundled.formats.filter(\.isReady).map(\.id.rawValue), ["byte", "quiz"])
    }

    func testOldIdsResolveThroughAliases() {
        XCTAssertEqual(bundled.canonicalID(for: "bits"), "byte")
        XCTAssertEqual(bundled.canonicalID(for: "read"), "byte")
        XCTAssertEqual(bundled.canonicalID(for: "check"), "quiz")
        XCTAssertEqual(bundled.descriptor(for: "check")?.label, "quiz")
        XCTAssertEqual(bundled.style(for: "read").label, "byte")
    }

    func testRetiredFormatsAreNotShapes() {
        for id: FormatID in ["flashcards", "cards", "guidedWork", "hwRedo", "slides"] {
            XCTAssertNil(bundled.descriptor(for: id), "\(id) is not a format (DECISIONS.md #33)")
        }
    }

    func testAnEngineOnTheOldFormatSetLeavesTheShapesAndWords() throws {
        let old = try FormatCatalog.decode(Data("""
        { "formats": [
          { "id": "bits", "label": "bits", "ready": true },
          { "id": "read", "label": "read", "ready": true },
          { "id": "check", "label": "check", "ready": false },
          { "id": "flashcards", "label": "flashcards", "aliases": ["cards"], "ready": false }
        ] }
        """.utf8))
        let shaped = bundled.shaped(by: old)
        XCTAssertEqual(shaped.formats.map(\.label), ["byte", "quiz", "video"])
        XCTAssertTrue(try XCTUnwrap(shaped.descriptor(for: "byte")).isReady)
        XCTAssertFalse(try XCTUnwrap(shaped.descriptor(for: "quiz")).isReady, "readiness from the old check id")
        XCTAssertNil(shaped.descriptor(for: "flashcards"))
    }

    func testAnEngineOnTheShapesRefreshesThemAndKeepsOldIds() throws {
        let fresh = try FormatCatalog.decode(Data("""
        { "formats": [
          { "id": "quiz", "label": "quiz", "colorSlot": 4, "icon": "check", "ready": true },
          { "id": "byte", "label": "byte", "colorSlot": 2, "icon": "feed", "aliases": ["bits"],
            "settings": [{ "key": "tone", "label": "Tone", "kind": "text" }], "ready": true },
          { "id": "talk", "label": "talk", "ready": true }
        ] }
        """.utf8))
        let shaped = bundled.shaped(by: fresh)
        XCTAssertEqual(shaped.formats.map(\.id.rawValue), ["byte", "quiz", "video"], "talk is not a shape")
        XCTAssertEqual(shaped.descriptor(for: "byte")?.settings.map(\.key), ["tone"])
        XCTAssertEqual(shaped.descriptor(for: "byte")?.aliases, ["bits", "read"])
        XCTAssertEqual(shaped.canonicalID(for: "read"), "byte")
        XCTAssertEqual(shaped.canonicalID(for: "check"), "quiz")
        XCTAssertEqual(shaped.descriptor(for: "quiz")?.colorSlot, 4)
    }

    func testUnknownIdsStayAsTheyAre() {
        XCTAssertNil(bundled.descriptor(for: "slides"))
        XCTAssertEqual(bundled.canonicalID(for: "slides"), "slides")
        let style = bundled.style(for: "slides")
        XCTAssertFalse(style.isKnown)
        XCTAssertEqual(style.label, "slides")
        XCTAssertEqual(style.icon, FormatGlyphs.neutral)
        XCTAssertEqual(style.softColor, FormatPalette.neutral.soft)
    }

    func testStyleComesFromTheDescriptor() {
        let style = bundled.style(for: "video")
        XCTAssertTrue(style.isKnown)
        XCTAssertEqual(style.label, "video")
        XCTAssertEqual(style.icon, FormatGlyphs.symbol(for: "play"))
        XCTAssertEqual(style.color, FormatPalette.colors(forSlot: 1).color)
    }

    func testUnknownIconAndSlotFallBackToNeutral() {
        XCTAssertEqual(FormatGlyphs.symbol(for: "hologram"), FormatGlyphs.neutral)
        XCTAssertEqual(FormatPalette.colors(forSlot: nil), FormatPalette.neutral)
        XCTAssertEqual(FormatPalette.colors(forSlot: 9), FormatPalette.neutral)
    }

    func testEightSlotsLiveInTheTheme() {
        XCTAssertEqual(OpenSourcebookTheme.FormatSlots.all.count, FormatDescriptor.colorSlots.count)
        XCTAssertEqual(FormatPalette.colors(forSlot: 1).color, OpenSourcebookTheme.Colors.danger)
        XCTAssertEqual(FormatPalette.colors(forSlot: 6).soft, OpenSourcebookTheme.Colors.tealSoft)
        XCTAssertEqual(FormatPalette.colors(forSlot: 5), OpenSourcebookTheme.FormatSlots.neutral)
        XCTAssertEqual(FormatPalette.colors(forSlot: 8), OpenSourcebookTheme.FormatSlots.neutral)
    }

    func testOrderedFoldsAliasesAndPutsUnknownLast() {
        let ids: [FormatID] = ["slides", "check", "read", "video", "bits", "audio"]
        XCTAssertEqual(bundled.ordered(ids).map(\.rawValue), ["byte", "quiz", "video", "audio", "slides"])
    }

    func testDecodeSkipsUnknownSettingKindsAndBadDescriptors() throws {
        let json = """
        { "formats": [
          { "id": "talk", "label": "talk", "colorSlot": 12, "icon": "mic",
            "settings": [
              { "key": "voice", "label": "Voice", "kind": "voicePicker" },
              { "key": "minutes", "label": "Length", "kind": "number", "min": 1, "max": 20, "unit": "min" },
              { "key": "seed", "label": "Seed", "kind": "text", "hidden": true }
            ],
            "defaults": { "minutes": 5 }, "ready": true },
          { "label": "no id" },
          { "id": "audio" }
        ] }
        """
        let catalog = try FormatCatalog.decode(Data(json.utf8))
        XCTAssertEqual(catalog.formats.map(\.id.rawValue), ["talk", "audio"])

        let talk = try XCTUnwrap(catalog.descriptor(for: "talk"))
        XCTAssertNil(talk.colorSlot, "a slot outside 1-8 is neutral")
        XCTAssertEqual(talk.settings.map(\.key), ["minutes", "seed"], "unknown kind left out")
        XCTAssertEqual(talk.visibleSettings.map(\.key), ["minutes"], "hidden field left out of forms")
        XCTAssertEqual(talk.settings.first?.kind, .number(min: 1, max: 20, step: nil, unit: "min"))
        XCTAssertEqual(talk.defaults["minutes"], .number(5))
        XCTAssertTrue(talk.isReady)

        let audio = try XCTUnwrap(catalog.descriptor(for: "audio"))
        XCTAssertEqual(audio.label, "audio", "label defaults to the id")
        XCTAssertFalse(audio.isReady)
        XCTAssertEqual(catalog.style(for: "audio").icon, FormatGlyphs.neutral)
    }

    func testABodyWithNoFormatsIsAnError() {
        XCTAssertThrowsError(try FormatCatalog.decode(Data(#"{ "formats": [] }"#.utf8)))
        XCTAssertThrowsError(try FormatCatalog.decode(Data(#"{ "error": "unauthorized" }"#.utf8)))
    }

    func testDuplicateIdsKeepTheFirst() {
        let first = bundled.formats[0]
        let catalog = FormatCatalog(formats: [first, first])
        XCTAssertEqual(catalog.formats.count, 1)
    }

    func testFormatIdDecodesAndEncodesAsABareString() throws {
        let ids = try JSONDecoder().decode([FormatID].self, from: Data(#"["bits","hologram"]"#.utf8))
        XCTAssertEqual(ids, ["bits", "hologram"])
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(ids), as: UTF8.self), #"["bits","hologram"]"#)
    }
}
