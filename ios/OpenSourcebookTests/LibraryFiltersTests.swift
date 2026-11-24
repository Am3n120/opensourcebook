import XCTest
@testable import OpenSourcebook

final class LibraryFiltersTests: XCTestCase {

    private let swift = Fixtures.output(
        "Swift concurrency", minutes: 10, type: "byte", tags: ["Swift", "async"],
        subtitle: "Actors explained", domain: "swift.org"
    )
    private let cooking = Fixtures.output(
        "Weeknight pasta", minutes: 30, type: "quiz", tags: ["food"],
        subtitle: "Three ingredients", domain: "kitchen.example", projectID: "cook"
    )
    private let physics = Fixtures.output(
        "Entropy", minutes: 20, type: "byte", tags: ["science"],
        subtitle: "Why time has an arrow", domain: nil, projectID: "sci"
    )

    private var all: [Output] { [swift, cooking, physics] }

    private func titles(_ filters: LibraryFilters, favorites: Set<UUID> = [], unfiled: Set<UUID> = []) -> [String] {
        filters.apply(
            to: all,
            isFavorite: { favorites.contains($0) },
            isFiled: { !unfiled.contains($0) }
        ).map(\.title)
    }

    func testDefaultShowsEverythingNewestFirstAndIsNotActive() {
        let filters = LibraryFilters()
        XCTAssertFalse(filters.isActive)
        XCTAssertEqual(titles(filters), ["Weeknight pasta", "Entropy", "Swift concurrency"])
    }

    func testSearchMatchesTitleSubtitleTagAndDomainCaseInsensitively() {
        var filters = LibraryFilters()
        filters.searchText = "ENTROPY"
        XCTAssertEqual(titles(filters), ["Entropy"])
        filters.searchText = "arrow"
        XCTAssertEqual(titles(filters), ["Entropy"], "subtitle")
        filters.searchText = "ASYNC"
        XCTAssertEqual(titles(filters), ["Swift concurrency"], "tag")
        filters.searchText = "kitchen.example"
        XCTAssertEqual(titles(filters), ["Weeknight pasta"], "source domain")
        filters.searchText = "nothing matches this"
        XCTAssertEqual(titles(filters), [])
    }

    func testWhitespaceOnlySearchIsNotASearch() {
        var filters = LibraryFilters()
        filters.searchText = "   \n "
        XCTAssertFalse(filters.isSearching)
        XCTAssertFalse(filters.isActive)
        XCTAssertEqual(titles(filters).count, 3)
    }

    func testTypeFilter() {
        var filters = LibraryFilters()
        filters.type = "quiz"
        XCTAssertEqual(titles(filters), ["Weeknight pasta"])
        filters.type = "byte"
        XCTAssertEqual(titles(filters), ["Entropy", "Swift concurrency"])
        filters.type = "slides"
        XCTAssertEqual(titles(filters), [])
    }

    func testTypeFilterMatchesOutputsStoredUnderAnOldId() {
        let bits = Fixtures.output("Old bits", type: "bits")
        let read = Fixtures.output("Old read", type: "read")
        let check = Fixtures.output("Old check", type: "check")
        var filters = LibraryFilters()
        filters.type = "byte"
        let matched = filters.apply(to: [bits, read, check, swift], isFavorite: { _ in false },
                                    isFiled: { _ in true }, catalog: .bundled)
        XCTAssertEqual(Set(matched.map(\.title)), ["Old bits", "Old read", "Swift concurrency"])
        filters.type = "quiz"
        let quizzes = filters.apply(to: [bits, read, check, swift], isFavorite: { _ in false },
                                    isFiled: { _ in true }, catalog: .bundled)
        XCTAssertEqual(quizzes.map(\.title), ["Old check"])
    }

    func testTagFilterIgnoresCase() {
        var filters = LibraryFilters()
        filters.tag = "swift"
        XCTAssertEqual(titles(filters), ["Swift concurrency"])
    }

    func testFavoritesOnly() {
        var filters = LibraryFilters()
        filters.favoritesOnly = true
        XCTAssertEqual(titles(filters), [])
        XCTAssertEqual(titles(filters, favorites: [physics.id]), ["Entropy"])
        XCTAssertTrue(filters.isActive)
    }

    func testScopeSinglesAndProject() {
        var filters = LibraryFilters()
        filters.scope = .singles
        XCTAssertEqual(titles(filters), ["Swift concurrency"], "filed with no project means single")
        let unfiledIDs = Set(all.filter { $0.projectID == nil }.map(\.id))
        XCTAssertEqual(titles(filters, unfiled: unfiledIDs), [], "an Inbox item is not a single")
        filters.scope = .project("cook")
        XCTAssertEqual(titles(filters), ["Weeknight pasta"])
        filters.scope = .project("missing")
        XCTAssertEqual(titles(filters), [])
        filters.scope = .everything
        XCTAssertEqual(titles(filters).count, 3)
    }

    func testSortOldestAndFavoritesFirst() {
        var filters = LibraryFilters()
        filters.sort = .oldest
        XCTAssertEqual(titles(filters), ["Swift concurrency", "Entropy", "Weeknight pasta"])

        filters.sort = .favoritesFirst
        // Favorites lead, each group newest first.
        XCTAssertEqual(titles(filters, favorites: [swift.id]), ["Swift concurrency", "Weeknight pasta", "Entropy"])
    }

    func testSortAloneDoesNotMakeFiltersActive() {
        var filters = LibraryFilters()
        filters.sort = .oldest
        XCTAssertFalse(filters.isActive)
    }

    func testFiltersCombine() {
        var filters = LibraryFilters()
        filters.type = "byte"
        filters.scope = .project("sci")
        filters.searchText = "ent"
        XCTAssertEqual(titles(filters), ["Entropy"])
        filters.searchText = "swift"
        XCTAssertEqual(titles(filters), [])
    }

    func testResetClearsEveryNarrowingFilterButKeepsTheSort() {
        var filters = LibraryFilters()
        filters.searchText = "x"
        filters.type = "quiz"
        filters.tag = "food"
        filters.scope = .singles
        filters.favoritesOnly = true
        filters.sort = .oldest
        filters.reset()
        XCTAssertFalse(filters.isActive)
        XCTAssertEqual(filters.sort, .oldest)
    }
}
