import XCTest
@testable import OpenSourcebook

/// A plan on the phone: run order, branch depth, where each item stands,
/// and what Play goes through.
final class PlanLayoutTests: XCTestCase {
    private let made = UUID()
    private let madeToo = UUID()

    private func plan(_ items: [StudioItem], stages: [StudioStage] = []) -> StudioPlanView {
        StudioPlanView(plan: StudioPlan(id: "pl", projectId: "p", title: "Unit 1", status: .running),
                       stages: stages, items: items)
    }

    func testItemsRunByStageThenPositionWithBranchesIndented() {
        let view = plan([
            StudioItem(id: "fix", parentId: "q", level: 2, ord: 0, type: "byte", title: "Fix",
                       condition: .object(["kind": .string("metric")])),
            StudioItem(id: "q", level: 1, ord: 0, type: "quiz", title: "Quiz"),
            StudioItem(id: "b2", level: 0, ord: 1, type: "byte", title: "Second"),
            StudioItem(id: "b1", level: 0, ord: 0, type: "byte", title: "First"),
            StudioItem(id: "more", parentId: "fix", level: 3, ord: 0, type: "quiz", title: "Again",
                       condition: .object(["kind": .string("ask")])),
        ], stages: [StudioStage(level: 1, label: "Check"), StudioStage(level: 9, label: nil)])

        let rows = PlanLayout.rows(view) { _ in false }

        XCTAssertEqual(rows.map(\.id), ["b1", "b2", "q", "fix", "more"])
        XCTAssertEqual(rows.map(\.depth), [0, 0, 0, 1, 2])
        XCTAssertEqual(rows.map(\.stageLabel), [nil, nil, "Check", nil, nil])
        XCTAssertEqual(rows.map(\.startsStage), [false, false, true, true, true])
    }

    func testABranchLoopDoesNotHang() {
        let rows = PlanLayout.rows(plan([
            StudioItem(id: "a", parentId: "b", type: "byte", title: "A"),
            StudioItem(id: "b", parentId: "a", ord: 1, type: "byte", title: "B"),
        ])) { _ in false }
        XCTAssertEqual(rows.count, 2)
        XCTAssertLessThanOrEqual(rows.map(\.depth).max() ?? 0, 8)
    }

    func testWhereEachItemStands() {
        func state(_ item: StudioItem, ticked: Bool = false) -> PlanItemState {
            PlanLayout.state(of: item, isTicked: ticked)
        }
        let id = made.uuidString
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .done, outputId: id)), .ready)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .done, outputId: id), ticked: true), .done)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .done, outputId: id, done: true)), .done,
                       "a tick made on the web counts")
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .running)), .making)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .queued)), .making)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .pending)), .waiting)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", condition: .object([:]), status: .pending)), .behindBranch)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", condition: .object([:]), status: .unknown)), .behindBranch)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", condition: .object([:]), status: .pending,
                                        asking: StudioAsking(question: "More?"))), .asking(question: "More?"))
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .skipped)), .skipped)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .failed)), .failed)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .cancelled)), .cancelled)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", enabled: false, status: .done, outputId: id), ticked: true), .off)
        XCTAssertEqual(state(StudioItem(id: "a", type: "byte", title: "", status: .done)), .waiting,
                       "done with nothing made is not something to play")
    }

    func testPlayGoesThroughWhatIsMadeAndHeldInOrderStartingAtTheFirstNotDone() {
        let missing = UUID()
        let rows = PlanLayout.rows(plan([
            StudioItem(id: "a", level: 0, ord: 0, type: "byte", title: "A", status: .done, outputId: made.uuidString),
            StudioItem(id: "b", level: 0, ord: 1, type: "byte", title: "B", status: .done, outputId: missing.uuidString),
            StudioItem(id: "c", level: 1, ord: 0, type: "quiz", title: "C", status: .done, outputId: madeToo.uuidString),
            StudioItem(id: "d", level: 2, ord: 0, type: "byte", title: "D", status: .running),
        ])) { $0 == "a" }
        let held: (UUID) -> Bool = { $0 != missing }

        XCTAssertEqual(PlanLayout.playable(rows, has: held), [made, madeToo])
        XCTAssertEqual(PlanLayout.start(rows, has: held), madeToo, "a is done, b isn't on the phone")

        let allDone = PlanLayout.rows(plan([
            StudioItem(id: "a", type: "byte", title: "A", status: .done, outputId: made.uuidString),
        ])) { _ in true }
        XCTAssertEqual(PlanLayout.start(allDone, has: held), made, "with everything done, Play starts at the top")
        XCTAssertNil(PlanLayout.start([], has: held))
    }

    func testPlanStatusWords() {
        XCTAssertEqual(StudioPlanStatus.draft.label, "Not started")
        XCTAssertTrue(StudioPlanStatus.approved.isBeforeStart)
        XCTAssertFalse(StudioPlanStatus.running.isBeforeStart)
        XCTAssertEqual(StudioPlanStatus.running.label, "Being made")
    }
}
