import Foundation

/// Which part of the library to show by where outputs live.
enum LibraryScope: Hashable {
    case everything
    case singles
    case project(String)
}

enum LibrarySort: String, CaseIterable, Identifiable {
    case newest, oldest, favoritesFirst

    var id: String { rawValue }

    var label: String {
        switch self {
        case .newest: return "Newest"
        case .oldest: return "Oldest"
        case .favoritesFirst: return "Favorites first"
        }
    }

    var icon: String {
        switch self {
        case .newest: return "arrow.down"
        case .oldest: return "arrow.up"
        case .favoritesFirst: return "heart"
        }
    }
}

/// Search text and filter state for the Library, applied to a list of outputs.
/// Pure value logic so it stays independent of the view.
struct LibraryFilters: Equatable {
    var searchText = ""
    /// A format id as the catalog names it; an output under an old alias
    /// matches its format.
    var type: FormatID?
    var tag: String?
    var scope: LibraryScope = .everything
    var favoritesOnly = false
    var sort: LibrarySort = .newest

    var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// True when anything narrows the list (sort does not).
    var isActive: Bool {
        isSearching || type != nil || tag != nil || scope != .everything || favoritesOnly
    }

    mutating func reset() {
        searchText = ""
        type = nil
        tag = nil
        scope = .everything
        favoritesOnly = false
    }

    /// Filters and orders `outputs`. `isFavorite` comes from the store's meta.
    func apply(
        to outputs: [Output],
        isFavorite: (UUID) -> Bool,
        isFiled: (UUID) -> Bool,
        catalog: FormatCatalog = FormatRegistry.shared.catalog
    ) -> [Output] {
        let filtered = outputs.filter { output in
            if let type, catalog.canonicalID(for: output.type) != catalog.canonicalID(for: type) { return false }
            if let tag, !output.tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) {
                return false
            }
            switch scope {
            case .everything: break
            case .singles: if output.projectID != nil || !isFiled(output.id) { return false }
            case .project(let id): if output.projectID != id { return false }
            }
            if favoritesOnly, !isFavorite(output.id) { return false }
            return matches(output)
        }

        switch sort {
        case .newest:
            return filtered.sorted { $0.createdAt > $1.createdAt }
        case .oldest:
            return filtered.sorted { $0.createdAt < $1.createdAt }
        case .favoritesFirst:
            return filtered.sorted { lhs, rhs in
                let l = isFavorite(lhs.id), r = isFavorite(rhs.id)
                if l != r { return l }
                return lhs.createdAt > rhs.createdAt
            }
        }
    }

    /// Case-insensitive match over title, subtitle, tags and source domain.
    private func matches(_ output: Output) -> Bool {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        let fields = [output.title, output.subtitle, output.sourceDomain ?? ""] + output.tags
        return fields.contains { $0.localizedCaseInsensitiveContains(query) }
    }
}
