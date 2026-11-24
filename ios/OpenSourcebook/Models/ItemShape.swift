import Foundation

/// The three shapes Open Sourcebook makes, by how they are held and swiped
/// (DECISIONS.md #33, #36). Fixed: makers add variety inside a shape, never a
/// new one (#37).
enum ItemShape: String, CaseIterable, Sendable {
    /// One or more bits, swiped sideways.
    case byte
    /// Questions, swiped sideways, with a result at the end.
    case quiz
    /// Fills the screen; nothing sideways.
    case video

    var formatID: FormatID { FormatID(rawValue) }

    /// The shape of a stored format id, old aliases included; nil for an id
    /// that is not one of the shapes.
    init?(_ format: FormatID, catalog: FormatCatalog = FormatRegistry.shared.catalog) {
        self.init(rawValue: catalog.canonicalID(for: format).rawValue)
    }
}
