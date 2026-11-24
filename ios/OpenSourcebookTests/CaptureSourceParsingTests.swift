import UniformTypeIdentifiers
import XCTest
@testable import OpenSourcebook

final class CaptureSourceParsingTests: XCTestCase {

    func testEmptyAndWhitespaceTextIsNoSource() {
        XCTAssertNil(CaptureSourceParsing.fields(fromText: ""))
        XCTAssertNil(CaptureSourceParsing.fields(fromText: "  \n\t "))
    }

    func testPlainTextStaysTextAndIsTrimmed() {
        let fields = CaptureSourceParsing.fields(fromText: "  remember the milk  ")
        XCTAssertEqual(fields, CaptureSourceFields(sourceText: "remember the milk", sourceURL: nil, sourceKind: "text"))
    }

    func testBareLinkBecomesALinkSourceWithTheLinkAsText() {
        let fields = CaptureSourceParsing.fields(fromText: "https://www.youtube.com/watch?v=abc")
        XCTAssertEqual(fields?.sourceURL, "https://www.youtube.com/watch?v=abc")
        XCTAssertEqual(fields?.sourceText, "https://www.youtube.com/watch?v=abc")
        XCTAssertEqual(fields?.sourceKind, "youtube")
    }

    func testWordsAroundALinkStayAsContext() {
        let fields = CaptureSourceParsing.fields(fromText: "great talk https://example.com/post about focus")
        XCTAssertEqual(fields?.sourceURL, "https://example.com/post")
        XCTAssertEqual(fields?.sourceText, "great talk about focus")
        XCTAssertEqual(fields?.sourceKind, "web")
    }

    func testAHostWithoutASchemeIsNotALink() {
        XCTAssertNil(CaptureSourceParsing.firstHTTPURL(in: "see example.com for more"))
        XCTAssertEqual(CaptureSourceParsing.fields(fromText: "see example.com for more")?.sourceKind, "text")
    }

    func testOnlyTheFirstLinkIsUsed() {
        XCTAssertEqual(
            CaptureSourceParsing.firstHTTPURL(in: "a https://one.example/x and https://two.example/y"),
            "https://one.example/x"
        )
    }

    func testSourceKindFromHost() {
        func kind(_ string: String) -> String { CaptureSourceParsing.sourceKind(for: URL(string: string)!) }
        XCTAssertEqual(kind("https://youtu.be/abc"), "youtube")
        XCTAssertEqual(kind("https://m.youtube.com/watch?v=1"), "youtube")
        XCTAssertEqual(kind("https://x.com/user/status/1"), "x")
        XCTAssertEqual(kind("https://twitter.com/user"), "x")
        XCTAssertEqual(kind("https://www.instagram.com/p/1"), "instagram")
        XCTAssertEqual(kind("https://www.tiktok.com/@a/video/1"), "tiktok")
        XCTAssertEqual(kind("https://www.reddit.com/r/swift"), "reddit")
        XCTAssertEqual(kind("https://redd.it/abc"), "reddit")
        XCTAssertEqual(kind("https://vimeo.com/1"), "vimeo")
        XCTAssertEqual(kind("https://example.org/article"), "web")
    }

    func testSourceKindFromFileType() {
        XCTAssertEqual(CaptureSourceParsing.sourceKind(forFileType: .pdf), "pdf")
        XCTAssertEqual(CaptureSourceParsing.sourceKind(forFileType: .png), "image")
        XCTAssertEqual(CaptureSourceParsing.sourceKind(forFileType: .jpeg), "image")
        XCTAssertEqual(CaptureSourceParsing.sourceKind(forFileType: .mp3), "audio")
        XCTAssertEqual(CaptureSourceParsing.sourceKind(forFileType: .zip), "file")
        XCTAssertEqual(CaptureSourceParsing.sourceKind(forFileType: nil), "file")
    }

    func testFileSourceText() {
        XCTAssertEqual(CaptureSourceParsing.fileSourceText(filename: "notes.pdf", sourceKind: "pdf"), "PDF: notes.pdf")
        XCTAssertEqual(CaptureSourceParsing.fileSourceText(filename: "a.png", sourceKind: "image"), "Image: a.png")
        XCTAssertEqual(CaptureSourceParsing.fileSourceText(filename: "a.m4a", sourceKind: "audio"), "Audio: a.m4a")
        XCTAssertEqual(CaptureSourceParsing.fileSourceText(filename: "a.bin", sourceKind: "file"), "File: a.bin")
    }
}
