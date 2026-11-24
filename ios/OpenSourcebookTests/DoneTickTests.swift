import XCTest
@testable import OpenSourcebook

@MainActor
final class DoneTickTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "DoneTickTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    /// Records what it was asked to send and answers from a script.
    private final class FakeSync: DoneTickSyncing, @unchecked Sendable {
        var outcomes: [DoneTickOutcome]
        var sent: [DoneTick] = []
        var remote: Set<String>?
        init(_ outcomes: [DoneTickOutcome] = [.synced]) { self.outcomes = outcomes }
        func send(_ tick: DoneTick) async -> DoneTickOutcome {
            sent.append(tick)
            return outcomes.isEmpty ? .synced : outcomes.removeFirst()
        }
        func doneItemIDs(planID: String) async -> Set<String>? { remote }
    }

    private func planned(_ node: String = "n1") -> Output {
        Fixtures.output("Item", plan: PlanPosition(planID: "p1", nodeID: node, level: 0, ord: 0))
    }

    // MARK: Store

    func testTickShowsAtOnceAndSkipsOutputsWithoutAPlan() {
        let store = DoneTickStore(defaults: defaults, syncer: FakeSync(), sendsAtOnce: false)
        store.markDone(Fixtures.output("Single"))
        XCTAssertEqual(store.ticks.count, 0)
        store.markDone(planned())
        XCTAssertTrue(store.isDone(planID: "p1", itemID: "n1"))
        XCTAssertEqual(store.doneCount(planID: "p1"), 1)
        XCTAssertFalse(store.isDone(planID: "p1", itemID: "n2"))
    }

    func testSyncedTickIsSettledAndSentOnce() async {
        let sync = FakeSync([.synced])
        let store = DoneTickStore(defaults: defaults, syncer: sync, sendsAtOnce: false)
        store.markDone(planned())
        await store.flush()
        store.markDone(planned())
        await store.flush()
        XCTAssertEqual(sync.sent.count, 1)
        XCTAssertEqual(store.pendingCount, 0)
    }

    func testOfflineKeepsTheLocalTickAndRetriesLater() async {
        let sync = FakeSync([.retryLater, .synced])
        let store = DoneTickStore(defaults: defaults, syncer: sync, sendsAtOnce: false)
        store.markDone(planned())
        await store.flush()
        XCTAssertTrue(store.isDone(planID: "p1", itemID: "n1"))
        XCTAssertEqual(store.pendingCount, 1)
        await store.flush()
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(sync.sent.count, 2)
    }

    func testRefusedTickStaysLocalAndIsNotRetried() async {
        let sync = FakeSync([.refused])
        let store = DoneTickStore(defaults: defaults, syncer: sync, sendsAtOnce: false)
        store.markDone(planned())
        await store.flush()
        await store.flush()
        XCTAssertTrue(store.isDone(planID: "p1", itemID: "n1"))
        XCTAssertEqual(store.pendingCount, 0)
        XCTAssertEqual(sync.sent.count, 1)
    }

    func testTicksSurviveARelaunch() {
        let first = DoneTickStore(defaults: defaults, syncer: FakeSync([.retryLater]), sendsAtOnce: false)
        first.markDone(planned())
        let second = DoneTickStore(defaults: defaults, syncer: FakeSync(), sendsAtOnce: false)
        XCTAssertTrue(second.isDone(planID: "p1", itemID: "n1"))
        XCTAssertEqual(second.pendingCount, 1)
    }

    func testRefreshTakesInWebTicksAndKeepsLocalOnes() async {
        let sync = FakeSync()
        sync.remote = ["n2"]
        let store = DoneTickStore(defaults: defaults, syncer: sync, sendsAtOnce: false)
        store.markDone(planned("n1"))
        await store.refresh(planID: "p1")
        XCTAssertTrue(store.isDone(planID: "p1", itemID: "n1"))
        XCTAssertTrue(store.isDone(planID: "p1", itemID: "n2"))
        sync.remote = nil
        await store.refresh(planID: "p1")
        XCTAssertEqual(store.doneCount(planID: "p1"), 2)
    }

    // MARK: Service

    func testStatusMapping() {
        XCTAssertEqual(DoneTickService.outcome(forStatus: 200), .synced)
        for status in [400, 404, 413] { XCTAssertEqual(DoneTickService.outcome(forStatus: status), .refused) }
        for status in [0, 401, 409, 429, 500, 503] { XCTAssertEqual(DoneTickService.outcome(forStatus: status), .retryLater) }
    }

    func testProgressDecodingKeepsDoneItems() throws {
        let json = #"{"plan":{"id":"p1"},"items":[{"id":"a","done":true},{"id":"b","done":false}],"counts":{"total":2,"done":1}}"#
        XCTAssertEqual(try DoneTickService.doneItemIDs(fromProgress: Data(json.utf8)), ["a"])
    }

    func testRoutesNeedAConfiguredEngineAndKeepIdsInOneSegment() {
        XCTAssertNil(EngineConfiguration().doneURL(planID: "p", itemID: "i"))
        let configuration = EngineConfiguration(baseURL: URL(string: "https://engine.example.com"),
                                                clientToken: "abcd1234efgh5678.ijkl")
        XCTAssertEqual(configuration.doneURL(planID: "p1", itemID: "n1")?.absoluteString,
                       "https://engine.example.com/v1/plans/p1/items/n1/done")
        XCTAssertEqual(configuration.progressURL(planID: "p1")?.absoluteString,
                       "https://engine.example.com/v1/plans/p1/progress")
        XCTAssertEqual(configuration.progressURL(planID: "a/b")?.absoluteString,
                       "https://engine.example.com/v1/plans/a%2Fb/progress")
    }
}
