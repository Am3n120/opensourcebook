import Foundation

/// A page of the player shell's vertical pager: one item, or the end.
enum PlayerPage: Hashable, Sendable {
    case item(UUID)
    /// After the last item; reaching it finishes the last one.
    case end

    var itemID: UUID? {
        if case .item(let id) = self { return id }
        return nil
    }
}

/// The gesture rule as logic (DECISIONS.md #36), kept apart from the views so
/// it can be tested: scrolling down goes to the next thing and up to the
/// previous, one per screen; swiping sideways moves inside the thing.
enum PlayerPaging {
    /// The pages of `order`, top to bottom, ending with `.end`.
    static func pages(_ order: [UUID]) -> [PlayerPage] {
        order.map(PlayerPage.item) + [.end]
    }

    /// The item finished by moving from `from` to `to`: the one left behind
    /// when moving down. Moving up, staying, or arriving from nowhere
    /// finishes nothing. A nil `from` is the first page.
    static func finished(movingFrom from: PlayerPage?, to: PlayerPage?, in order: [UUID]) -> UUID? {
        let pages = pages(order)
        let start = from ?? pages.first
        guard let start, let to,
              let a = pages.firstIndex(of: start), let b = pages.firstIndex(of: to),
              b > a else { return nil }
        return start.itemID
    }

    /// The page above or below `page`; nil past either end.
    static func neighbour(of page: PlayerPage?, in order: [UUID], down: Bool) -> PlayerPage? {
        let pages = pages(order)
        let index = page.flatMap { pages.firstIndex(of: $0) } ?? 0
        let target = index + (down ? 1 : -1)
        return pages.indices.contains(target) ? pages[target] : nil
    }

    /// How many sideways pages an item has: a byte's bits; a quiz's
    /// questions and its result; a video has none. A shape this build can't
    /// play has none.
    static func sidewaysCount(of output: Output, catalog: FormatCatalog = FormatRegistry.shared.catalog) -> Int {
        switch ItemShape(output.type, catalog: catalog) {
        case .byte: output.screens.count
        case .quiz: output.quiz.map { $0.questions.isEmpty ? 0 : $0.questions.count + 1 } ?? 0
        case .video, nil: 0
        }
    }

    /// A saved sideways position, kept inside the item's pages.
    static func clamped(_ position: Int, count: Int) -> Int {
        count > 0 ? min(max(0, position), count - 1) : 0
    }
}
