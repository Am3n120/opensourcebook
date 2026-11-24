import XCTest
@testable import OpenSourcebook

final class OutputOrderingTests: XCTestCase {

    private let context = OrderingContext()

    /// An early single, one plan whose outputs are listed out of order, and a late single.
    private struct Library {
        let earlySingle = Fixtures.output("early single", minutes: 0)
        let lateSingle = Fixtures.output("late single", minutes: 100)
        let planLast = Fixtures.output("plan L1", minutes: 12, plan: Fixtures.position("A", level: 1, ord: 0))
        let planSecond = Fixtures.output("plan L0 O1", minutes: 11, plan: Fixtures.position("A", level: 0, ord: 1))
        let planFirst = Fixtures.output("plan L0 O0", minutes: 30, plan: Fixtures.position("A", level: 0, ord: 0))
        let otherPlan = Fixtures.output("other plan", minutes: 50, plan: Fixtures.position("B", level: 0, ord: 0))

        var shuffled: [Output] {
            [lateSingle, planLast, otherPlan, planFirst, earlySingle, planSecond]
        }
    }

    func testPlanOrderingReturnsEveryOutputExactlyOnce() {
        let lib = Library()
        let ordered = PlanOrdering().ordered(lib.shuffled, context: context)
        XCTAssertEqual(ordered.count, lib.shuffled.count)
        XCTAssertEqual(Set(ordered.map(\.id)), Set(lib.shuffled.map(\.id)))
    }

    func testPlanOrderingKeepsOnePlanTogetherByLevelThenOrd() {
        let lib = Library()
        let titles = PlanOrdering().ordered(lib.shuffled, context: context).map(\.title)

        let planTitles = ["plan L0 O0", "plan L0 O1", "plan L1"]
        guard let start = titles.firstIndex(of: planTitles[0]) else { return XCTFail("plan output missing") }
        XCTAssertEqual(Array(titles[start..<(start + 3)]), planTitles, "contiguous and in level, ord order")
    }

    func testPlanOrderingPlacesGroupsAndSinglesByWhenTheyFirstAppeared() {
        let lib = Library()
        let titles = PlanOrdering().ordered(lib.shuffled, context: context).map(\.title)
        // Plan A first appeared at minute 11, so it follows the minute-0 single
        // and precedes plan B (50) and the minute-100 single.
        XCTAssertEqual(titles, [
            "early single", "plan L0 O0", "plan L0 O1", "plan L1", "other plan", "late single"
        ])
    }

    func testPlanOrderingHandlesNothing() {
        XCTAssertTrue(PlanOrdering().ordered([], context: context).isEmpty)
    }

    func testRecencyOrderingIsNewestFirstAndIgnoresPlans() {
        let lib = Library()
        let ordered = RecencyOrdering().ordered(lib.shuffled, context: context)
        XCTAssertEqual(ordered.map(\.title), [
            "late single", "other plan", "plan L0 O0", "plan L1", "plan L0 O1", "early single"
        ])
        XCTAssertEqual(Set(ordered.map(\.id)), Set(lib.shuffled.map(\.id)))
    }

    func testNextAndPreviousWalkTheOrder() {
        let lib = Library()
        let ordering = PlanOrdering()
        let order = ordering.ordered(lib.shuffled, context: context)

        XCTAssertEqual(ordering.next(after: order[0].id, in: lib.shuffled, context: context)?.id, order[1].id)
        XCTAssertEqual(ordering.previous(before: order[2].id, in: lib.shuffled, context: context)?.id, order[1].id)
    }

    func testNextIsNilAtTheEndAndPreviousIsNilAtTheStart() {
        let lib = Library()
        for ordering in [PlanOrdering() as any OutputOrdering, RecencyOrdering()] {
            let order = ordering.ordered(lib.shuffled, context: context)
            XCTAssertNil(ordering.next(after: order.last!.id, in: lib.shuffled, context: context), ordering.id)
            XCTAssertNil(ordering.previous(before: order.first!.id, in: lib.shuffled, context: context), ordering.id)
        }
    }

    func testNextAndPreviousAreNilForAnOutputNotInTheList() {
        let lib = Library()
        let stranger = UUID()
        XCTAssertNil(PlanOrdering().next(after: stranger, in: lib.shuffled, context: context))
        XCTAssertNil(PlanOrdering().previous(before: stranger, in: lib.shuffled, context: context))
    }

    func testRegistryFallsBackToPlanOrderingForAnUnknownID() {
        XCTAssertEqual(OutputOrderings.ordering(forID: "recent").id, "recent")
        XCTAssertEqual(OutputOrderings.ordering(forID: "plan").id, "plan")
        XCTAssertEqual(OutputOrderings.ordering(forID: "spaced-repetition-from-the-future").id, "plan")
    }
}
