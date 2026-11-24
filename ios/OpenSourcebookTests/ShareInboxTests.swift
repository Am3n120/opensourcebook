import XCTest
@testable import OpenSourcebook

/// The share inbox on a temporary directory. `containerOverride` keeps every
/// read and write away from the real App Group container.
@MainActor
final class ShareInboxTests: XCTestCase {

    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenSourcebookTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        OpenSourcebookShareInbox.containerOverride = directory
    }

    override func tearDown() async throws {
        OpenSourcebookShareInbox.containerOverride = nil
        try? FileManager.default.removeItem(at: directory)
    }

    private func item(
        _ text: String = "hello",
        destination: OpenSourcebookShareDestination = .inbox,
        id: UUID = UUID(),
        dataPath: String? = nil
    ) -> OpenSourcebookShareInboxItem {
        OpenSourcebookShareInboxItem(
            id: id,
            sourceText: text,
            sourceURL: nil,
            sourceKind: "text",
            destination: destination,
            createdAt: Fixtures.date(0),
            filename: nil,
            dataPath: dataPath
        )
    }

    // MARK: Encoding

    func testEveryDestinationSurvivesJSON() throws {
        let destinations: [OpenSourcebookShareDestination] = [
            .auto, .inbox, .project(id: "p-1"), .newProject(title: "Brand new")
        ]
        let encoder = JSONEncoder()
        for destination in destinations {
            let data = try encoder.encode(destination)
            XCTAssertEqual(try JSONDecoder().decode(OpenSourcebookShareDestination.self, from: data), destination)
        }
    }

    func testItemRoundTripsThroughTheInboxEncoding() throws {
        let original = OpenSourcebookShareInboxItem(
            sourceText: "see this",
            sourceURL: "https://example.com/a",
            sourceKind: "web",
            destination: .newProject(title: "Reading"),
            createdAt: Fixtures.date(5),
            filename: "a.pdf",
            dataPath: "re-share-attachments/x-a.pdf"
        )
        try OpenSourcebookShareInbox.append(original)

        let read = try OpenSourcebookShareInbox.read()
        XCTAssertEqual(read.count, 1)
        XCTAssertEqual(read[0].id, original.id)
        XCTAssertEqual(read[0].sourceText, "see this")
        XCTAssertEqual(read[0].sourceURL, "https://example.com/a")
        XCTAssertEqual(read[0].sourceKind, "web")
        XCTAssertEqual(read[0].destination, .newProject(title: "Reading"))
        XCTAssertEqual(read[0].createdAt, Fixtures.date(5))
        XCTAssertEqual(read[0].filename, "a.pdf")
        XCTAssertEqual(read[0].dataPath, "re-share-attachments/x-a.pdf")
    }

    // MARK: Inbox file

    func testReadWithNoInboxFileIsEmpty() throws {
        XCTAssertEqual(try OpenSourcebookShareInbox.read().count, 0)
    }

    func testAppendKeepsEarlierItemsAndIgnoresADuplicateID() throws {
        let first = item("one")
        try OpenSourcebookShareInbox.append(first)
        try OpenSourcebookShareInbox.append(item("two"))
        try OpenSourcebookShareInbox.append(item("one again", id: first.id))

        XCTAssertEqual(try OpenSourcebookShareInbox.read().map(\.sourceText), ["one", "two"])
    }

    func testDrainConsumesEverythingAndClearsTheInbox() throws {
        try OpenSourcebookShareInbox.append(item("a"))
        try OpenSourcebookShareInbox.append(item("b"))

        var seen: [String] = []
        let drained = try OpenSourcebookShareInbox.drain { seen = $0.map(\.sourceText) }

        XCTAssertEqual(seen, ["a", "b"])
        XCTAssertEqual(drained.count, 2)
        XCTAssertEqual(try OpenSourcebookShareInbox.read().count, 0)
    }

    func testDrainOfAnEmptyInboxDoesNotCallTheConsumer() throws {
        var called = false
        let drained = try OpenSourcebookShareInbox.drain { _ in called = true }
        XCTAssertFalse(called)
        XCTAssertTrue(drained.isEmpty)
    }

    func testDrainKeepsTheInboxWhenTheConsumerThrows() throws {
        try OpenSourcebookShareInbox.append(item("keep me"))
        struct Boom: Error {}

        XCTAssertThrowsError(try OpenSourcebookShareInbox.drain { _ in throw Boom() })

        XCTAssertEqual(try OpenSourcebookShareInbox.read().map(\.sourceText), ["keep me"])
    }

    func testACorruptInboxFileIsReportedAndNotOverwritten() throws {
        let file = directory.appendingPathComponent(OpenSourcebookShareInbox.inboxFilename)
        try Data("not json".utf8).write(to: file)

        XCTAssertThrowsError(try OpenSourcebookShareInbox.read())
        XCTAssertThrowsError(try OpenSourcebookShareInbox.append(item("x")))
        XCTAssertEqual(try Data(contentsOf: file), Data("not json".utf8))
    }

    // MARK: Projects

    func testProjectsRoundTripAndAMissingFileMeansNone() throws {
        XCTAssertTrue(try OpenSourcebookShareInbox.readProjects().isEmpty)

        let projects = [
            OpenSourcebookShareProject(id: "a", title: "Alpha", icon: "book", colorHex: 0x6C5CE7),
            OpenSourcebookShareProject(id: "b", title: "Beta", icon: "folder", colorHex: 0xEF4444)
        ]
        try OpenSourcebookShareInbox.writeProjects(projects)
        XCTAssertEqual(try OpenSourcebookShareInbox.readProjects(), projects)
    }

    // MARK: Attachments

    func testStoredAttachmentIsWrittenUnderTheContainerAndResolvable() throws {
        let relative = try OpenSourcebookShareInbox.storeAttachment(Data("pdf bytes".utf8), filename: "My Notes (1).pdf")

        XCTAssertTrue(relative.hasPrefix("\(OpenSourcebookShareInbox.attachmentsDirectoryName)/"))
        XCTAssertTrue(relative.hasSuffix("-My_Notes__1_.pdf"), "unsafe characters are replaced: \(relative)")

        let url = try OpenSourcebookShareInbox.attachmentURL(for: relative)
        XCTAssertEqual(try Data(contentsOf: url), Data("pdf bytes".utf8))
    }

    func testAttachmentNameKeepsOnlyTheLastPathComponent() {
        let name = OpenSourcebookShareInbox.attachmentName(for: "../../etc/passwd")
        XCTAssertTrue(name.hasSuffix("-passwd"), name)
        XCTAssertFalse(name.contains("/"))
        XCTAssertTrue(OpenSourcebookShareInbox.attachmentName(for: nil).hasSuffix("-attachment"))
        XCTAssertTrue(OpenSourcebookShareInbox.attachmentName(for: "").hasSuffix("-attachment"))
    }

    func testEmptyAttachmentIsRejected() {
        XCTAssertThrowsError(try OpenSourcebookShareInbox.storeAttachment(Data(), filename: "a.pdf")) { error in
            guard case OpenSourcebookShareInboxError.emptyAttachment = error else {
                return XCTFail("expected emptyAttachment, got \(error)")
            }
        }
    }

    func testAttachmentPathsThatEscapeTheContainerAreRejected() {
        XCTAssertThrowsError(try OpenSourcebookShareInbox.attachmentURL(for: "../outside.txt"))
        XCTAssertThrowsError(try OpenSourcebookShareInbox.attachmentURL(for: "re-share-attachments/../../outside.txt"))
        XCTAssertThrowsError(try OpenSourcebookShareInbox.attachmentURL(for: ""))
    }

    // MARK: The app's side

    func testDrainingTheBridgeQueuesEachShareOnceWithTheRightDestination() throws {
        let store = OutputStore()
        let existing = store.createProject(title: "Existing")
        let ids = (0..<5).map { _ in UUID() }

        try OpenSourcebookShareInbox.append(item("auto", destination: .auto, id: ids[0]))
        try OpenSourcebookShareInbox.append(item("inbox", destination: .inbox, id: ids[1]))
        try OpenSourcebookShareInbox.append(item("into project", destination: .project(id: existing.id), id: ids[2]))
        try OpenSourcebookShareInbox.append(item("deleted project", destination: .project(id: "gone"), id: ids[3]))
        try OpenSourcebookShareInbox.append(item("new project", destination: .newProject(title: "  Fresh  "), id: ids[4]))

        ShareInboxBridge.drain(into: store)

        XCTAssertEqual(store.jobs.count, 5)
        XCTAssertEqual(store.job(ids[0])?.destination, .auto)
        XCTAssertEqual(store.job(ids[1])?.destination, .inbox)
        XCTAssertEqual(store.job(ids[2])?.destination, .project(id: existing.id))
        XCTAssertEqual(store.job(ids[3])?.destination, .inbox, "a project deleted since the share falls back to the Inbox")

        let fresh = store.projects.first { $0.title == "Fresh" }
        XCTAssertNotNil(fresh, "a new project is created, trimmed")
        XCTAssertEqual(store.job(ids[4])?.destination, .project(id: fresh?.id ?? ""))

        XCTAssertEqual(try OpenSourcebookShareInbox.read().count, 0)

        // Handing the same ids over again must not queue them twice.
        for (index, id) in ids.enumerated() {
            try OpenSourcebookShareInbox.append(item("again \(index)", id: id))
        }
        ShareInboxBridge.drain(into: store)
        XCTAssertEqual(store.jobs.count, 5)
        XCTAssertEqual(store.projects.count, 2)
    }

    func testABlankNewProjectNameFallsBackToTheInbox() throws {
        let store = OutputStore()
        let id = UUID()
        try OpenSourcebookShareInbox.append(item("x", destination: .newProject(title: "   "), id: id))

        ShareInboxBridge.drain(into: store)

        XCTAssertEqual(store.job(id)?.destination, .inbox)
        XCTAssertTrue(store.projects.isEmpty)
    }

    func testAnAttachmentIsHandedToTheJobAsAFileURL() throws {
        let store = OutputStore()
        let relative = try OpenSourcebookShareInbox.storeAttachment(Data("x".utf8), filename: "scan.png")
        let id = UUID()
        try OpenSourcebookShareInbox.append(item("Image: scan.png", id: id, dataPath: relative))

        ShareInboxBridge.drain(into: store)

        let sourceURL = try XCTUnwrap(store.job(id)?.sourceURL)
        let url = try XCTUnwrap(URL(string: sourceURL))
        XCTAssertTrue(url.isFileURL)
        XCTAssertTrue(url.lastPathComponent.hasSuffix("-scan.png"))
    }
}
