import Foundation

/// What the full-screen player plays through: the outputs of the list it was
/// opened from, and the id of the ordering that decides their sequence.
/// Home, a project, Library and Inbox each build their own and pass it to
/// `AppState.present(_:in:)`.
struct PlayerQueue: Equatable, Sendable {
    var outputIDs: [UUID]
    var orderingID: String

    init(outputIDs: [UUID], orderingID: String = OutputOrderings.defaultOrdering.id) {
        self.outputIDs = outputIDs
        self.orderingID = orderingID
    }
}
