import XCTest
@testable import OpenSourcebook

/// The phone's copy of the Studio: what was fetched stays, an engine without
/// the routes is said so, a plan's made things reach the players, and moving
/// past one ticks its item with a quiz's result.
@MainActor
final class StudioStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var cacheURL: URL!

    override func setUp() {
        super.setUp()
        suiteName = "StudioStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        cacheURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("StudioStoreTests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("snapshot.json")
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: cacheURL.deletingLastPathComponent())
        super.tearDown()
    }

    /// Counts what is asked of a recorded engine; can be switched to failing.
    /// Outputs are fetched side by side, so what it records is behind a lock.
    private final class Counting: StudioClient, @unchecked Sendable {
        var recorded: RecordedStudio
        var failure: StudioError?
        private let lock = NSLock()
        private var reads: [String] = []
        private var answered: [(String, Bool)] = []
        var outputReads: [String] { lock.withLock { reads } }
        var answers: [(String, Bool)] { lock.withLock { answered } }
        init(_ recorded: RecordedStudio) { self.recorded = recorded }

        var isConfigured: Bool { true }
        private func check() throws { if let failure { throw failure } }
        func projects() async throws -> [StudioProject] { try check(); return try await recorded.projects() }
        func plans(inProject id: String) async throws -> [StudioPlan] { try check(); return try await recorded.plans(inProject: id) }
        func plan(_ id: String) async throws -> StudioPlanView { try check(); return try await recorded.plan(id) }
        func outputs(inProject id: String) async throws -> [StudioOutputSummary] { try check(); return try await recorded.outputs(inProject: id) }
        func output(_ id: String) async throws -> StudioOutput {
            try check()
            lock.withLock { reads.append(id) }
            return try await recorded.output(id)
        }
        func sources(inProject id: String) async throws -> [StudioSource] { try check(); return try await recorded.sources(inProject: id) }
        func source(_ id: String) async throws -> StudioSourceDetail { try check(); return try await recorded.source(id) }
        func answer(planID: String, itemID: String, answer: Bool) async throws {
            try check()
            lock.withLock { answered.append((itemID, answer)) }
            try await recorded.answer(planID: planID, itemID: itemID, answer: answer)
        }
        func assetURL(_ assetID: String) -> URL? { nil }
    }

    private final class FakeSync: DoneTickSyncing, @unchecked Sendable {
        var sent: [DoneTick] = []
        func send(_ tick: DoneTick) async -> DoneTickOutcome { sent.append(tick); return .synced }
        func doneItemIDs(planID: String) async -> Set<String>? { nil }
    }

    private let byteID = UUID()
    private let quizID = UUID()

    /// One project with one running plan: a byte (made, ticked on the web),
    /// a quiz (made), and an "ask me" branch after it.
    private func recorded() -> RecordedStudio {
        let plan = StudioPlan(id: "pl", projectId: "p", title: "Unit 1", status: .running, counts: StudioCounts(total: 3, done: 1))
        let items = [
            StudioItem(id: "i1", level: 0, ord: 0, type: "byte", title: "Limits", status: .done, outputId: byteID.uuidString, done: true),
            StudioItem(id: "i2", level: 1, ord: 0, type: "quiz", title: "Limits quiz", status: .done, outputId: quizID.uuidString),
            StudioItem(id: "i3", parentId: "i2", level: 2, ord: 0, type: "byte", title: "More practice",
                       condition: .object(["kind": .string("ask")]), status: .pending, asking: StudioAsking(question: "More practice?")),
        ]
        let bit = JSONValue.object(["id": .string("b1"), "kind": .string("plain"),
                                    "blocks": .array([.object(["type": .string("text"), "text": .string("Both sides agree.")])]),
                                    "cites": .array([.object(["sourceId": .string("s1"), "spot": .string("passage"), "quote": .string("agree")])])])
        let question = JSONValue.object(["id": .string("q1"), "kind": .string("choice"), "prompt": .string("Agree?"),
                                         "options": .array([.string("Yes"), .string("No")]), "answer": .number(0)])
        return RecordedStudio(
            projectList: [StudioProject(id: "p", title: "Calculus I")],
            plansByProject: ["p": [plan]],
            planViews: ["pl": StudioPlanView(plan: plan, items: items, counts: StudioCounts(total: 3, done: 1))],
            outputsByID: [
                byteID.uuidString: StudioOutput(id: byteID.uuidString, type: "byte", title: "Limits", projectId: "p",
                                                planId: "pl", itemId: "i1",
                                                payload: .object(["title": .string("Limits"), "subtitle": .string("Notes"),
                                                                  "bits": .array([bit])])),
                quizID.uuidString: StudioOutput(id: quizID.uuidString, type: "quiz", title: "Limits quiz", projectId: "p",
                                                planId: "pl", itemId: "i2",
                                                payload: .object(["title": .string("Limits quiz"), "passMark": .number(0.5),
                                                                  "questions": .array([question])])),
            ],
            sourcesByProject: ["p": [StudioSource(id: "s1", projectId: "p", kind: "pdf", title: "Week 3 notes")]],
            sourceDetails: ["s1": StudioSourceDetail(source: StudioSource(id: "s1", title: "Week 3 notes"),
                                                     extraction: .init(status: "ready", text: "Limits agree."))]
        )
    }

    func testWhatWasFetchedStaysForTheSameEngineOnly() async {
        let outputs = OutputStore()
        let first = StudioStore(client: RecordedStudio(projectList: [StudioProject(id: "p", title: "A")]), outputs: outputs,
                                cacheURL: cacheURL, engineKey: "https://one.example")
        await first.refreshProjects()
        XCTAssertEqual(first.projects.map(\.id), ["p"])
        XCTAssertEqual(first.reach, .available)
        XCTAssertNotNil(first.fetchedAt(StudioStore.projectsKey))

        let offline = Counting(RecordedStudio())
        offline.failure = .unreachable
        let again = StudioStore(client: offline, outputs: outputs, cacheURL: cacheURL, engineKey: "https://one.example")
        XCTAssertEqual(again.projects.map(\.id), ["p"], "readable before any request")
        await again.refreshProjects()
        XCTAssertEqual(again.projects.map(\.id), ["p"], "a failed read keeps what was fetched")
        XCTAssertNotNil(again.failure(StudioStore.projectsKey))

        let other = StudioStore(client: RecordedStudio(), outputs: outputs, cacheURL: cacheURL, engineKey: "https://two.example")
        XCTAssertTrue(other.projects.isEmpty, "another engine's answers are never shown")
    }

    func testAnEngineWithoutStudioRoutesIsSaidSoWithoutAFailure() async {
        let old = Counting(RecordedStudio())
        old.failure = .notFound
        let store = StudioStore(client: old, outputs: OutputStore())
        await store.refreshProjects()
        XCTAssertEqual(store.reach, .noStudio)
        XCTAssertNil(store.failure(StudioStore.projectsKey))
        XCTAssertTrue(store.projects.isEmpty)
    }

    func testNoEngineMeansNoReadsAndSaysSo() async {
        let store = StudioStore(client: NoStudio(), outputs: OutputStore())
        XCTAssertEqual(store.reach, .notConfigured)
        await store.refreshProjects()
        XCTAssertEqual(store.reach, .notConfigured)
        XCTAssertNil(store.failure(StudioStore.projectsKey))
    }

    func testReadOnceReadsOncePerLaunch() async {
        let store = StudioStore(client: RecordedStudio(), outputs: OutputStore())
        var reads = 0
        await store.readOnce("k") { reads += 1 }
        await store.readOnce("k") { reads += 1 }
        XCTAssertEqual(reads, 1)
    }

    func testAProjectReadsItsPlansMadeThingsAndSources() async {
        let store = StudioStore(client: recorded(), outputs: OutputStore())
        await store.refreshProject("p")
        XCTAssertEqual(store.plans(inProject: "p")?.map(\.id), ["pl"])
        XCTAssertEqual(store.madeThings(inProject: "p")?.count, 2)
        XCTAssertEqual(store.sources(inProject: "p")?.first?.title, "Week 3 notes")
        XCTAssertEqual(store.sourceName("s1"), "Week 3 notes")
        XCTAssertNil(store.sourceName("nope"))
    }

    func testAPlanBringsItsMadeThingsToThePhoneOnceWithTheirPlaces() async throws {
        let client = Counting(recorded())
        let outputs = OutputStore()
        let ticks = DoneTickStore(defaults: defaults, syncer: FakeSync(), sendsAtOnce: false)
        let store = StudioStore(client: client, outputs: outputs, doneTicks: ticks)

        await store.refreshPlan("pl")

        let byte = try XCTUnwrap(outputs.output(forID: byteID))
        XCTAssertEqual(byte.plan, PlanPosition(planID: "pl", nodeID: "i1", level: 0, ord: 0))
        XCTAssertEqual(byte.bits.first?.cites.count, 1)
        XCTAssertEqual(outputs.output(forID: quizID)?.quiz?.questions.count, 1)
        XCTAssertEqual(outputs.output(forID: quizID)?.plan?.level, 1)
        XCTAssertEqual(Set(client.outputReads), [byteID.uuidString, quizID.uuidString])
        XCTAssertTrue(ticks.isDone(planID: "pl", itemID: "i1"), "a tick made on the web shows on the phone")
        XCTAssertFalse(ticks.isDone(planID: "pl", itemID: "i2"))

        await store.refreshPlan("pl")
        XCTAssertEqual(client.outputReads.count, 2, "made things are fetched once")
    }

    func testMovingPastAPlansThingsTicksThemAndAQuizSendsItsResult() async throws {
        let sync = FakeSync()
        let outputs = OutputStore()
        let ticks = DoneTickStore(defaults: defaults, syncer: sync, sendsAtOnce: false)
        let store = StudioStore(client: recorded(), outputs: outputs, doneTicks: ticks)
        await store.refreshPlan("pl")
        let view = try XCTUnwrap(store.planView("pl"))
        let rows = PlanLayout.rows(view) { ticks.isDone(planID: "pl", itemID: $0) }
        let order = PlanLayout.playable(rows, has: { outputs.output(forID: $0) != nil })
        XCTAssertEqual(order, [byteID, quizID])
        XCTAssertEqual(PlanLayout.start(rows, has: { outputs.output(forID: $0) != nil }), quizID)

        // Scrolling down from the quiz to the end page finishes it.
        let finished = try XCTUnwrap(PlayerPaging.finished(movingFrom: .item(quizID), to: .end, in: order))
        let quiz = try XCTUnwrap(outputs.output(forID: finished))
        ticks.markDone(quiz)
        let result = QuizGrader.result(try XCTUnwrap(quiz.quiz), responses: ["q1": .choice(0)])
        ticks.markDone(quiz, result: result.json)
        await ticks.flush()

        let sent = try XCTUnwrap(sync.sent.last)
        XCTAssertEqual(sent.planID, "pl")
        XCTAssertEqual(sent.itemID, "i2")
        XCTAssertEqual(sent.outputID, quizID)
        XCTAssertEqual(sent.result?["score"], .number(1))
        XCTAssertEqual(DoneTickService.body(for: sent).outputId, quizID.uuidString.lowercased())
    }

    func testAnAskMeBranchIsAnsweredAndThePlanReadAgain() async {
        let client = Counting(recorded())
        let store = StudioStore(client: client, outputs: OutputStore())
        await store.refreshPlan("pl")

        let taken = await store.answer(planID: "pl", itemID: "i3", answer: true)
        XCTAssertTrue(taken)
        XCTAssertEqual(client.answers.first?.0, "i3")
        XCTAssertEqual(client.answers.first?.1, true)

        let refused = await store.answer(planID: "pl", itemID: "i1", answer: false)
        XCTAssertFalse(refused, "an item that isn't asking is refused")
        XCTAssertNotNil(store.failure(StudioStore.planKey("pl")))
    }

    func testAListedMadeThingIsFetchedOnceAndAUselessIdIsNot() async throws {
        let client = Counting(recorded())
        let outputs = OutputStore()
        let store = StudioStore(client: client, outputs: outputs)
        let summary = StudioOutputSummary(id: byteID.uuidString, type: "byte", title: "Limits", projectId: "p")
        let first = await store.output(for: summary)
        XCTAssertEqual(first?.id, byteID)
        _ = await store.output(for: summary)
        XCTAssertEqual(client.outputReads.count, 1)
        let none = await store.output(for: StudioOutputSummary(id: "missing", type: "byte", title: "x"))
        XCTAssertNil(none)
    }

    func testASourceIsReadOnceForItsCitations() async {
        let client = Counting(recorded())
        let store = StudioStore(client: client, outputs: OutputStore())
        let detail = await store.sourceDetail("s1")
        XCTAssertEqual(detail?.extraction?.text, "Limits agree.")
        XCTAssertEqual(store.sourceName("s1"), "Week 3 notes")
        let missing = await store.sourceDetail("s9")
        XCTAssertNil(missing)
    }
}
