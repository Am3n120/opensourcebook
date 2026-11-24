import OSLog
import SwiftUI

/// Library: every output, searchable, in gallery / list / compact layouts
/// (VISION.md "Phone"). Replaces the August Deck tab; its bins live here as
/// the Archive (DECISIONS.md #1, #2).
struct LibraryView: View {
    enum Layout: String, CaseIterable, Identifiable {
        case gallery, list, compact

        var id: String { rawValue }

        var icon: String {
            switch self {
            case .gallery: return "square.grid.2x2"
            case .list: return "list.bullet.rectangle"
            case .compact: return "list.bullet"
            }
        }

        var label: String {
            switch self {
            case .gallery: return "Gallery"
            case .list: return "List"
            case .compact: return "Compact"
            }
        }

        var cardStyle: OutputCardView.Style {
            switch self {
            case .gallery: return .gallery
            case .list: return .list
            case .compact: return .compact
            }
        }
    }

    @EnvironmentObject private var store: OutputStore
    @AppStorage("library.layout") private var layoutRaw = Layout.gallery.rawValue
    @State private var filters = LibraryFilters()
    @State private var isArchivePresented = false
    @State private var pendingDelete: Output?
    @State private var filingOutput: Output?

    private let logger = Logger(subsystem: "app.opensourcebook", category: "Library")

    private var layout: Layout { Layout(rawValue: layoutRaw) ?? .gallery }

    private var results: [Output] {
        filters.apply(to: store.outputs, isFavorite: store.isFavorite,
                       isFiled: { store.meta(for: $0).isFiled })
    }

    /// Only formats that occur, in the catalog's order, unknown ones last.
    private var availableTypes: [FormatID] {
        FormatRegistry.shared.catalog.ordered(store.outputs.map(\.type))
    }

    private var availableTags: [String] {
        Array(Set(store.outputs.flatMap(\.tags))).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.md) {
                header
                if store.outputs.isEmpty {
                    emptyLibrary
                } else {
                    SearchField(text: $filters.searchText, placeholder: "Search title, tags, source")
                    chipRow
                    if results.isEmpty {
                        EmptyStateView(
                            icon: "magnifyingglass",
                            title: "No results",
                            message: "Nothing matches this search and these filters.",
                            actionTitle: "Clear filters"
                        ) {
                            withAnimation(OpenSourcebookTheme.Motion.quick) { filters.reset() }
                        }
                    } else {
                        content
                    }
                }
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            .padding(.top, OpenSourcebookTheme.Spacing.sm)
            .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
        }
        .background(OpenSourcebookTheme.Colors.background)
        .navigationBarHidden(true)
        .sheet(isPresented: $isArchivePresented) { ArchiveSheet() }
        .sheet(item: $filingOutput) { output in
            FileIntoProjectSheet(output: output)
        }
        .confirmationDialog(
            "Delete this item for good?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { output in
            Button("Delete", role: .destructive) {
                logger.info("Deleting output \(output.id.uuidString)")
                store.delete(output.id)
            }
        } message: { output in
            Text("\(output.title) can't be recovered.")
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            Text("Library")
                .font(OpenSourcebookTheme.Fonts.title)
                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
            Spacer()
            Menu {
                Picker("Layout", selection: $layoutRaw) {
                    ForEach(Layout.allCases) { option in
                        Label(option.label, systemImage: option.icon).tag(option.rawValue)
                    }
                }
                Picker("Sort", selection: $filters.sort) {
                    ForEach(LibrarySort.allCases) { sort in
                        Label(sort.label, systemImage: sort.icon).tag(sort)
                    }
                }
            } label: {
                headerIcon(layout.icon)
            }
            .accessibilityLabel("Layout and sort")

            Button {
                isArchivePresented = true
            } label: {
                headerIcon("archivebox")
            }
            .accessibilityLabel("Archive, \(store.archivedOutputs.count) items")
        }
    }

    private func headerIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(OpenSourcebookTheme.Colors.primary)
            .frame(width: 40, height: 40)
            .background(OpenSourcebookTheme.Colors.primarySoft)
            .clipShape(Circle())
    }

    // MARK: - Filters

    private var chipRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                FilterChip("All", isSelected: !filters.isActive) {
                    withAnimation(OpenSourcebookTheme.Motion.quick) { filters.reset() }
                }
                FilterChip("Favorites", isSelected: filters.favoritesOnly) {
                    filters.favoritesOnly.toggle()
                }
                ForEach(availableTypes) { type in
                    FilterChip(type.style.label, isSelected: filters.type == type) {
                        filters.type = filters.type == type ? nil : type
                    }
                }
                scopeMenu
                if !availableTags.isEmpty { tagMenu }
            }
        }
        .scrollClipDisabled()
    }

    private var scopeMenu: some View {
        Menu {
            Picker("Where", selection: $filters.scope) {
                Text("Everywhere").tag(LibraryScope.everything)
                Text("Without a project").tag(LibraryScope.singles)
                ForEach(store.projects) { project in
                    Label(project.title, systemImage: project.icon).tag(LibraryScope.project(project.id))
                }
            }
        } label: {
            menuChipLabel(scopeTitle, isSelected: filters.scope != .everything)
        }
    }

    private var scopeTitle: String {
        switch filters.scope {
        case .everything: return "Project"
        case .singles: return "Without a project"
        case .project(let id): return store.project(forID: id)?.title ?? "Project"
        }
    }

    private var tagMenu: some View {
        Menu {
            Picker("Tag", selection: $filters.tag) {
                Text("Any tag").tag(String?.none)
                ForEach(availableTags, id: \.self) { tag in
                    Text(tag).tag(String?.some(tag))
                }
            }
        } label: {
            menuChipLabel(filters.tag ?? "Tag", isSelected: filters.tag != nil)
        }
    }

    private func menuChipLabel(_ title: String, isSelected: Bool) -> some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
        }
        .font(OpenSourcebookTheme.Fonts.label)
        .foregroundStyle(isSelected ? OpenSourcebookTheme.Colors.surface : OpenSourcebookTheme.Colors.text)
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(isSelected ? OpenSourcebookTheme.Colors.text : OpenSourcebookTheme.Colors.fill)
        .clipShape(Capsule())
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch layout {
        case .gallery:
            MasonryLayout(spacing: OpenSourcebookTheme.Spacing.sm) {
                ForEach(results) { card($0) }
            }
        case .list:
            LazyVStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                ForEach(results) { card($0) }
            }
        case .compact:
            LazyVStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                ForEach(results) { card($0) }
            }
        }
    }

    private func card(_ output: Output) -> some View {
        OutputCardButton(output: output, style: layout.cardStyle)
            .contextMenu { menu(for: output) }
    }

    @ViewBuilder
    private func menu(for output: Output) -> some View {
        let favorite = store.isFavorite(output.id)
        Button(favorite ? "Remove favorite" : "Favorite", systemImage: favorite ? "heart.slash" : "heart") {
            store.setFavorite(!favorite, for: output.id)
        }
        Button("File into project", systemImage: "folder") {
            filingOutput = output
        }
        Button("Archive", systemImage: "archivebox") {
            store.archive(output.id)
        }
        Button("Delete", systemImage: "trash", role: .destructive) {
            pendingDelete = output
        }
    }

    private var emptyLibrary: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.md) {
            EmptyStateView(
                icon: "square.grid.2x2",
                title: "No items yet",
                message: "Everything you generate shows up here. Tap + to capture a link, file or note."
            )
            if !store.archivedOutputs.isEmpty {
                Button("Open archive (\(store.archivedOutputs.count))") { isArchivePresented = true }
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
            }
        }
    }
}

/// Picks a project (or none, making it a single) for one output.
private struct FileIntoProjectSheet: View {
    @EnvironmentObject private var store: OutputStore
    @Environment(\.dismiss) private var dismiss
    let output: Output

    var body: some View {
        NavigationStack {
            List {
                Button {
                    store.file(output.id, into: nil)
                    dismiss()
                } label: {
                    row("Keep without a project", icon: "doc", isCurrent: output.projectID == nil && store.meta(for: output.id).isFiled)
                }
                ForEach(store.projects) { project in
                    Button {
                        store.file(output.id, into: project.id)
                        dismiss()
                    } label: {
                        row(project.title, icon: project.icon, isCurrent: output.projectID == project.id)
                    }
                }
            }
            .navigationTitle("File into project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ title: String, icon: String, isCurrent: Bool) -> some View {
        HStack {
            Label(title, systemImage: icon)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
            Spacer()
            if isCurrent {
                Image(systemName: "checkmark").foregroundStyle(OpenSourcebookTheme.Colors.primary)
            }
        }
    }
}

#Preview {
    let store = OutputStore()
    let project = store.createProject(title: "Linear algebra", icon: "function")
    store.upsert(Output(title: "Attention is all you need", subtitle: "arxiv.org", sourceKind: .paper, tags: ["ml"]))
    store.upsert(Output(title: "Eigenvalues, visually", subtitle: "youtube.com", sourceKind: .video, projectID: project.id))
    return NavigationStack { LibraryView() }
        .environmentObject(store)
        .environmentObject(AppState())
}
