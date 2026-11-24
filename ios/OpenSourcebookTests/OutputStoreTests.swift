import SwiftData
import XCTest
@testable import OpenSourcebook

/// `OutputStore` with no model context: everything stays in memory.
@MainActor
final class OutputStoreTests: XCTestCase {

    private var store: OutputStore!

    override func setUp() async throws {
        store = OutputStore()
    }

    // MARK: Outputs

    func testUpsertAddsAnUnfiledOutputToTheInboxOnly() {
        let output = Fixtures.output("One", minutes: 1)
        store.upsert(output)

        XCTAssertEqual(store.outputs.map(\.id), [output.id])
        XCTAssertEqual(store.output(forID: output.id), output)
        XCTAssertEqual(store.inbox.map(\.id), [output.id])
        XCTAssertTrue(store.singles.isEmpty, "an unfiled output is not a single yet")
        XCTAssertFalse(store.meta(for: output.id).isFiled)
    }

    func testUpsertOfAnOutputInAProjectIsFiledAndSkipsTheInbox() {
        let project = store.createProject(title: "Math")
        let output = Fixtures.output("In project", projectID: project.id)
        store.upsert(output)

        XCTAssertTrue(store.meta(for: output.id).isFiled)
        XCTAssertTrue(store.inbox.isEmpty)
        XCTAssertTrue(store.singles.isEmpty)
        XCTAssertEqual(store.outputs(inProject: project.id).map(\.id), [output.id])
        XCTAssertEqual(store.outputCount(inProject: project.id), 1)
    }

    func testUpsertReplacesAnExistingOutputInsteadOfDuplicating() {
        var output = Fixtures.output("Draft")
        store.upsert(output)
        output.title = "Final"
        store.upsert(output)

        XCTAssertEqual(store.outputs.count, 1)
        XCTAssertEqual(store.output(forID: output.id)?.title, "Final")
    }

    func testReplacingAFiledOutputKeepsItFiled() {
        let output = Fixtures.output("x")
        store.upsert(output)
        store.file(output.id, into: nil)
        store.upsert(output)

        XCTAssertTrue(store.meta(for: output.id).isFiled, "a repeated delivery must not send it back to the Inbox")
    }

    func testOutputsAreNewestFirst() {
        let old = Fixtures.output("old", minutes: 1)
        let new = Fixtures.output("new", minutes: 9)
        store.upsert(old)
        store.upsert(new)
        XCTAssertEqual(store.outputs.map(\.title), ["new", "old"])
    }

    func testFilingIntoAProjectMovesItOutOfTheInboxAndSingles() {
        let project = store.createProject(title: "Cooking")
        let output = Fixtures.output("Pasta")
        store.upsert(output)

        store.file(output.id, into: project.id)

        XCTAssertEqual(store.output(forID: output.id)?.projectID, project.id)
        XCTAssertTrue(store.inbox.isEmpty)
        XCTAssertTrue(store.singles.isEmpty)
        XCTAssertEqual(store.outputs(inProject: project.id).map(\.id), [output.id])
    }

    func testFilingAsASingleLeavesTheInboxButStaysASingle() {
        let output = Fixtures.output("Keep alone")
        store.upsert(output)

        store.file(output.id, into: nil)

        XCTAssertTrue(store.inbox.isEmpty)
        XCTAssertEqual(store.singles.map(\.id), [output.id])
        XCTAssertNil(store.output(forID: output.id)?.projectID)
    }

    func testFilingIntoAProjectThatDoesNotExistChangesNothing() {
        let output = Fixtures.output("x")
        store.upsert(output)

        store.file(output.id, into: "ghost")

        XCTAssertNil(store.output(forID: output.id)?.projectID)
        XCTAssertEqual(store.inbox.map(\.id), [output.id])
    }

    func testFilingAnUnknownOutputIsIgnored() {
        let project = store.createProject(title: "P")
        store.file(UUID(), into: project.id)
        XCTAssertTrue(store.outputs.isEmpty)
    }

    func testFavorite() {
        let output = Fixtures.output("x")
        store.upsert(output)
        XCTAssertFalse(store.isFavorite(output.id))

        store.setFavorite(true, for: output.id)
        XCTAssertTrue(store.isFavorite(output.id))
        store.setFavorite(false, for: output.id)
        XCTAssertFalse(store.isFavorite(output.id))
    }

    func testFavoriteOfAnUnknownOutputLeavesNoState() {
        let ghost = UUID()
        store.setFavorite(true, for: ghost)
        XCTAssertFalse(store.isFavorite(ghost))
        XCTAssertTrue(store.meta.isEmpty)
    }

    func testArchiveHidesFromActiveListsAndUnarchiveRestores() {
        let output = Fixtures.output("x")
        store.upsert(output)

        store.archive(output.id)
        XCTAssertTrue(store.outputs.isEmpty)
        XCTAssertTrue(store.inbox.isEmpty)
        XCTAssertEqual(store.archivedOutputs.map(\.id), [output.id])
        XCTAssertNotNil(store.output(forID: output.id), "archived outputs are still found by id")
        XCTAssertTrue(store.meta(for: output.id).isArchived)

        store.unarchive(output.id)
        XCTAssertEqual(store.outputs.map(\.id), [output.id])
        XCTAssertTrue(store.archivedOutputs.isEmpty)
    }

    func testArchivedOutputsDoNotCountTowardAProject() {
        let project = store.createProject(title: "P")
        let output = Fixtures.output("x", projectID: project.id)
        store.upsert(output)
        store.archive(output.id)
        XCTAssertEqual(store.outputCount(inProject: project.id), 0)
    }

    func testDeleteRemovesTheOutputAndItsState() {
        let output = Fixtures.output("x")
        store.upsert(output)
        store.setFavorite(true, for: output.id)

        store.delete(output.id)

        XCTAssertNil(store.output(forID: output.id))
        XCTAssertTrue(store.outputs.isEmpty)
        XCTAssertFalse(store.isFavorite(output.id))
        XCTAssertNil(store.meta[output.id])
    }

    func testDeleteOfAnUnknownOutputIsIgnored() {
        let output = Fixtures.output("x")
        store.upsert(output)
        store.delete(UUID())
        XCTAssertEqual(store.outputs.count, 1)
    }

    func testMarkOpenedFeedsRecentlyOpenedMostRecentFirst() async throws {
        let a = Fixtures.output("a", minutes: 1)
        let b = Fixtures.output("b", minutes: 2)
        store.upsert(a)
        store.upsert(b)
        XCTAssertTrue(store.recentlyOpened.isEmpty)

        store.markOpened(a.id)
        try await Task.sleep(nanoseconds: 5_000_000)
        store.markOpened(b.id)
        XCTAssertEqual(store.recentlyOpened.map(\.title), ["b", "a"])

        try await Task.sleep(nanoseconds: 5_000_000)
        store.markOpened(a.id)
        XCTAssertEqual(store.recentlyOpened.map(\.title), ["a", "b"])
    }

    func testReadPositionIsRemembered() {
        let output = Fixtures.output("x")
        store.upsert(output)
        store.saveReadPosition(7, for: output.id)
        XCTAssertEqual(store.meta(for: output.id).readPosition, 7)
    }

    // MARK: Projects

    func testProjectsAreListedAlphabeticallyIgnoringCase() {
        store.createProject(title: "banana")
        store.createProject(title: "Apple")
        store.createProject(title: "cherry")
        XCTAssertEqual(store.projects.map(\.title), ["Apple", "banana", "cherry"])
    }

    func testCreateProjectKeepsIconAndColor() {
        let project = store.createProject(title: "Run", icon: "figure.run", colorHex: 0xEF4444)
        XCTAssertEqual(store.project(forID: project.id)?.icon, "figure.run")
        XCTAssertEqual(store.project(forID: project.id)?.colorHex, 0xEF4444)
        XCTAssertNil(store.project(forID: nil))
        XCTAssertNil(store.project(forID: "missing"))
    }

    func testUpdateProjectChangesItAndResortsTheList() {
        let a = store.createProject(title: "Alpha")
        _ = store.createProject(title: "Beta")

        var renamed = a
        renamed.title = "Zulu"
        store.updateProject(renamed)

        XCTAssertEqual(store.projects.map(\.title), ["Beta", "Zulu"])
        XCTAssertGreaterThanOrEqual(store.project(forID: a.id)?.updatedAt ?? .distantPast, a.updatedAt)
    }

    func testUpdateOfAnUnknownProjectIsIgnored() {
        store.updateProject(Project(title: "Ghost"))
        XCTAssertTrue(store.projects.isEmpty)
    }

    func testDeletingAProjectSendsItsOutputsAndJobsBackToTheInbox() {
        let project = store.createProject(title: "Doomed")
        let output = Fixtures.output("Inside", projectID: project.id)
        store.upsert(output)
        let job = store.enqueueJob(
            sourceText: "x", sourceKind: "text", destination: .project(id: project.id)
        )
        XCTAssertTrue(store.inbox.isEmpty)

        store.deleteProject(project.id)

        XCTAssertNil(store.project(forID: project.id))
        XCTAssertNil(store.output(forID: output.id)?.projectID, "the output survives")
        XCTAssertEqual(store.inbox.map(\.id), [output.id])
        XCTAssertTrue(store.singles.isEmpty)
        XCTAssertEqual(job.destination, .inbox)
        XCTAssertNil(job.projectID)
    }

    func testDeletingAProjectLeavesOtherProjectsOutputsAlone() {
        let doomed = store.createProject(title: "Doomed")
        let kept = store.createProject(title: "Kept")
        let keptOutput = Fixtures.output("Stays", projectID: kept.id)
        store.upsert(keptOutput)

        store.deleteProject(doomed.id)

        XCTAssertEqual(store.output(forID: keptOutput.id)?.projectID, kept.id)
        XCTAssertTrue(store.inbox.isEmpty)
    }

    // MARK: Capture jobs

    func testEnqueueQueuesAJobWithItsDestination() {
        let project = store.createProject(title: "P")
        let job = store.enqueueJob(
            sourceText: "https://example.com/a", sourceURL: "https://example.com/a",
            sourceKind: "web", destination: .project(id: project.id)
        )

        XCTAssertEqual(store.jobs.map(\.id), [job.id])
        XCTAssertEqual(job.stage, .queued)
        XCTAssertEqual(job.projectID, project.id)
        XCTAssertEqual(store.jobs(inProject: project.id).map(\.id), [job.id])
        XCTAssertEqual(store.activeJobs.map(\.id), [job.id])
    }

    func testEnqueueWithAFixedIDIsNotQueuedTwice() {
        let id = UUID()
        let first = store.enqueueJob(id: id, sourceText: "first", sourceKind: "text", destination: .inbox)
        let second = store.enqueueJob(id: id, sourceText: "second", sourceKind: "text", destination: .auto)

        XCTAssertEqual(store.jobs.count, 1)
        XCTAssertTrue(first === second, "the existing job is returned")
        XCTAssertEqual(second.sourceText, "first", "the second delivery does not overwrite the first")
        XCTAssertEqual(second.destination, .inbox)
    }

    func testJobsWithoutAProjectAreFoundUnderNil() {
        let job = store.enqueueJob(sourceText: "x", sourceKind: "text", destination: .inbox)
        XCTAssertEqual(store.jobs(inProject: nil).map(\.id), [job.id])
    }

    func testUpdateJobClampsProgressAndFinishedJobsAreNotActive() {
        let job = store.enqueueJob(sourceText: "x", sourceKind: "text", destination: .inbox)

        store.updateJob(job.id, stage: .writing, progress: 7)
        XCTAssertEqual(job.progress, 1, "clamped to 1")
        store.updateJob(job.id, stage: .writing, progress: -3)
        XCTAssertEqual(job.progress, 0, "clamped to 0")
        XCTAssertEqual(store.activeJobs.count, 1)

        store.updateJob(job.id, stage: .failed, errorMessage: "boom")
        XCTAssertEqual(job.errorMessage, "boom")
        XCTAssertTrue(store.activeJobs.isEmpty)
    }

    func testRetryReturnsAFailedJobToTheQueue() throws {
        let job = store.enqueueJob(sourceText: "x", sourceKind: "text", destination: .inbox)
        store.updateJob(job.id, stage: .failed, progress: 0.4, errorMessage: "boom")

        let retried = try XCTUnwrap(store.retryJob(job.id))

        XCTAssertEqual(retried.stage, .queued)
        XCTAssertEqual(retried.progress, 0)
        XCTAssertNil(retried.errorMessage)
        XCTAssertEqual(retried.retryCount, 1)
        XCTAssertNil(store.retryJob(UUID()))
    }

    func testCompletingAJobStoresTheOutputInTheJobsProject() {
        let project = store.createProject(title: "P")
        let job = store.enqueueJob(sourceText: "x", sourceKind: "text", destination: .project(id: project.id))
        let result = Fixtures.output("Generated")

        store.completeJob(job.id, with: result)

        XCTAssertEqual(job.stage, .done)
        XCTAssertEqual(job.resultOutputID, result.id)
        XCTAssertEqual(store.output(forID: result.id)?.projectID, project.id)
        XCTAssertTrue(store.inbox.isEmpty, "a project job's output is filed")
    }

    func testCompletingAJobTwiceStoresOneOutput() {
        let job = store.enqueueJob(sourceText: "x", sourceKind: "text", destination: .inbox)
        let result = Fixtures.output("Generated")
        store.completeJob(job.id, with: result)
        store.completeJob(job.id, with: result)

        XCTAssertEqual(store.outputs.count, 1)
        XCTAssertEqual(store.inbox.map(\.id), [result.id])
    }

    func testCompletingAnUnknownJobStoresNothing() {
        store.completeJob(UUID(), with: Fixtures.output("Orphan"))
        XCTAssertTrue(store.outputs.isEmpty)
    }

    func testDeleteJob() {
        let job = store.enqueueJob(sourceText: "x", sourceKind: "text", destination: .inbox)
        store.deleteJob(job.id)
        XCTAssertTrue(store.jobs.isEmpty)
        XCTAssertNil(store.job(job.id))
    }
}

/// `OutputStore` backed by an in-memory SwiftData container: what is written
/// must come back when a second store loads the same context.
@MainActor
final class OutputStorePersistenceTests: XCTestCase {

    private func makeContainer() throws -> ModelContainer {
        try ModelContainer(
            for: Schema(OpenSourcebookModelSchema.models),
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
    }

    func testOutputsStateProjectsAndJobsSurviveReloading() throws {
        let container = try makeContainer()
        let first = OutputStore(modelContext: container.mainContext)

        let project = first.createProject(title: "Persisted", icon: "book", colorHex: 0x2563EB)
        let filed = Fixtures.output("Filed", minutes: 2)
        let archived = Fixtures.output("Archived", minutes: 1)
        first.upsert(filed)
        first.upsert(archived)
        first.file(filed.id, into: project.id)
        first.setFavorite(true, for: filed.id)
        first.archive(archived.id)
        first.saveReadPosition(4, for: filed.id)
        let job = first.enqueueJob(sourceText: "x", sourceKind: "text", destination: .project(id: project.id))

        let second = OutputStore(modelContext: container.mainContext)

        XCTAssertEqual(second.projects.map(\.title), ["Persisted"])
        XCTAssertEqual(second.projects.first?.colorHex, 0x2563EB)
        XCTAssertEqual(second.outputs.map(\.id), [filed.id])
        XCTAssertEqual(second.output(forID: filed.id)?.projectID, project.id)
        XCTAssertEqual(second.archivedOutputs.map(\.id), [archived.id])
        XCTAssertTrue(second.isFavorite(filed.id))
        XCTAssertEqual(second.meta(for: filed.id).readPosition, 4)
        XCTAssertTrue(second.meta(for: filed.id).isFiled)
        XCTAssertEqual(second.jobs.map(\.id), [job.id])
        XCTAssertEqual(second.job(job.id)?.projectID, project.id)
    }

    func testDeletesSurviveReloading() throws {
        let container = try makeContainer()
        let first = OutputStore(modelContext: container.mainContext)
        let project = first.createProject(title: "Gone")
        let output = Fixtures.output("Gone too", projectID: project.id)
        first.upsert(output)
        first.deleteProject(project.id)
        first.delete(output.id)

        let second = OutputStore(modelContext: container.mainContext)
        XCTAssertTrue(second.projects.isEmpty)
        XCTAssertTrue(second.outputs.isEmpty)
    }
}
