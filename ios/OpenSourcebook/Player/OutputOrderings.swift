import Foundation

/// The orderings the app offers, in one place. A new algorithm (spaced
/// repetition, say) is one more entry in `all` (DECISIONS.md #6).
enum OutputOrderings {
    static let all: [any OutputOrdering] = [
        PlanOrdering(),
        RecencyOrdering(),
    ]

    static let defaultOrdering: any OutputOrdering = PlanOrdering()

    /// The ordering with this id, or the default when the id is unknown
    /// (for example a choice saved by a build that had more algorithms).
    static func ordering(forID id: String) -> any OutputOrdering {
        all.first { $0.id == id } ?? defaultOrdering
    }
}
