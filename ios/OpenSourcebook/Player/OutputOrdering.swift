import Foundation

/// What an ordering may look at besides the outputs themselves.
struct OrderingContext: Sendable {
    var meta: [UUID: OutputMeta] = [:]
    var now: Date = .now
}

/// Decides what comes next in the player and the Feed (DECISIONS.md #5, #6).
/// The player shell and the Feed tab only ever talk to this protocol, so
/// spaced repetition or any other algorithm drops in as one more type.
protocol OutputOrdering: Sendable {
    /// Stable identifier, used to remember the user's choice.
    var id: String { get }
    var label: String { get }
    /// Returns `outputs` in play order. Must return every output exactly once.
    func ordered(_ outputs: [Output], context: OrderingContext) -> [Output]
}

extension OutputOrdering {
    /// The output after `current`, or nil at the end.
    func next(after current: UUID, in outputs: [Output], context: OrderingContext) -> Output? {
        let order = ordered(outputs, context: context)
        guard let index = order.firstIndex(where: { $0.id == current }), index + 1 < order.count else { return nil }
        return order[index + 1]
    }

    /// The output before `current`, or nil at the start.
    func previous(before current: UUID, in outputs: [Output], context: OrderingContext) -> Output? {
        let order = ordered(outputs, context: context)
        guard let index = order.firstIndex(where: { $0.id == current }), index > 0 else { return nil }
        return order[index - 1]
    }
}

/// The default: plan order. Outputs of one plan stay together and run by
/// level, then position; plans and unplanned outputs are placed by when they
/// first appeared, oldest first, so swiping moves forward in time.
struct PlanOrdering: OutputOrdering {
    let id = "plan"
    let label = "Plan order"

    func ordered(_ outputs: [Output], context: OrderingContext) -> [Output] {
        // Group by plan; an unplanned output is a group of one.
        var groups: [String: [Output]] = [:]
        for output in outputs {
            groups[output.plan?.planID ?? output.id.uuidString, default: []].append(output)
        }
        return groups.values
            .map { group in
                group.sorted { a, b in
                    let ka = (a.plan?.level ?? 0, a.plan?.ord ?? 0, a.createdAt, a.id.uuidString)
                    let kb = (b.plan?.level ?? 0, b.plan?.ord ?? 0, b.createdAt, b.id.uuidString)
                    return ka < kb
                }
            }
            .sorted { a, b in
                let ka = (a.map(\.createdAt).min() ?? .distantPast, a[0].id.uuidString)
                let kb = (b.map(\.createdAt).min() ?? .distantPast, b[0].id.uuidString)
                return ka < kb
            }
            .flatMap { $0 }
    }
}

/// Newest first, ignoring plans. What Library uses when it opens the player.
struct RecencyOrdering: OutputOrdering {
    let id = "recent"
    let label = "Newest first"

    func ordered(_ outputs: [Output], context: OrderingContext) -> [Output] {
        outputs.sorted { ($0.createdAt, $0.id.uuidString) > ($1.createdAt, $1.id.uuidString) }
    }
}
