import SwiftUI

/// Home: the Inbox, captures still generating, what you were last in, then projects and singles grouped
/// by category (DECISIONS.md #2, #16, #17). Ungrouped when a project or single
/// has no category. Projects are the ones made on this phone and the ones
/// the engine lists from the web Studio; pull to refresh reads the list again.
struct HomeView: View {
    @EnvironmentObject private var store: OutputStore
    @EnvironmentObject private var studio: StudioStore
    @State private var editingProject: Project?
    @State private var isCreatingProject = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xl) {
                header
                inboxRow
                studioStatus
                CaptureJobsSection()

                if !store.recentlyOpened.isEmpty {
                    continueSection
                }

                if projects.isEmpty && store.singles.isEmpty {
                    EmptyStateView(
                        icon: "tray",
                        title: "Nothing yet",
                        message: "Tap + to capture a link, file or note. Projects and things without a project show up here."
                    )
                } else {
                    ForEach(sections) { section in
                        sectionView(section)
                    }
                }
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            .padding(.top, OpenSourcebookTheme.Spacing.sm)
            .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
        }
        .refreshable { await studio.refreshProjects() }
        .task { await studio.readOnce(StudioStore.projectsKey) { await studio.refreshProjects() } }
        .background(OpenSourcebookTheme.Colors.background)
        .navigationBarHidden(true)
        .navigationDestination(for: Project.self) { ProjectView(projectID: $0.id) }
        .navigationDestination(for: InboxRoute.self) { _ in InboxView() }
        .sheet(isPresented: $isCreatingProject) {
            ProjectEditorSheet(project: nil)
        }
        .sheet(item: $editingProject) { ProjectEditorSheet(project: $0) }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text("Home")
                .font(OpenSourcebookTheme.Fonts.title)
                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
            Spacer()
            Button {
                isCreatingProject = true
            } label: {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                    .frame(width: 40, height: 40)
                    .background(OpenSourcebookTheme.Colors.primarySoft)
                    .clipShape(Circle())
            }
            .accessibilityLabel("New project")
            .accessibilityIdentifier("home-new-project")
        }
    }

    private var inboxRow: some View {
        NavigationLink(value: InboxRoute()) {
            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Image(systemName: "tray")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                    .frame(width: 36, height: 36)
                    .background(OpenSourcebookTheme.Colors.primarySoft)
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                Text("Inbox")
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                Spacer()
                Text("\(store.inbox.count)")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(store.inbox.isEmpty ? OpenSourcebookTheme.Colors.muted : OpenSourcebookTheme.Colors.primary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(store.inbox.isEmpty ? OpenSourcebookTheme.Colors.fill : OpenSourcebookTheme.Colors.primarySoft)
                    .clipShape(Capsule())
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            .padding(OpenSourcebookTheme.Spacing.sm)
            .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("home-inbox")
    }

    // MARK: - Studio

    /// Projects made on this phone, then the Studio's that aren't, by title.
    private var projects: [Project] {
        let studioOnly = studio.projects
            .filter { store.project(forID: $0.id) == nil && $0.archivedAt == nil }
            .map(\.asProject)
        return (store.projects + studioOnly)
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    /// How many things are in the project; nil for a Studio project whose
    /// made things haven't been read yet (nothing is known, so nothing is said).
    private func itemCount(_ project: Project) -> Int? {
        let listed = studio.madeThings(inProject: project.id)
        if listed == nil, store.project(forID: project.id) == nil, store.outputs(inProject: project.id).isEmpty { return nil }
        return ProjectEntries.make(held: store.outputs(inProject: project.id), listed: listed ?? []).count
    }

    /// Says so when the Studio can't be read: an engine without the Studio
    /// routes, or a failed read (what was fetched before still shows).
    @ViewBuilder
    private var studioStatus: some View {
        if studio.reach == .noStudio {
            Text("This engine doesn't serve projects and plans from the web Studio yet.")
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                .accessibilityIdentifier("home-studio-status")
        } else if let failure = studio.failure(StudioStore.projectsKey) {
            Button {
                Task { await studio.refreshProjects() }
            } label: {
                Text("\(failure) Tap to try again.")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.accentText)
                    .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("home-studio-status")
        }
    }

    // MARK: - Continue

    private var continueSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            SectionHeader("Recently opened")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
                    ForEach(store.recentlyOpened.prefix(8)) { output in
                        OutputCardButton(output: output, style: .tile)
                            .frame(width: 220)
                    }
                }
                .padding(.vertical, OpenSourcebookTheme.Spacing.xxs)
            }
            .scrollClipDisabled()
        }
    }

    // MARK: - Categories

    private struct CategorySection: Identifiable {
        let title: String?
        let projects: [Project]
        let singles: [Output]
        var id: String { title ?? "" }
    }

    /// Named categories alphabetically, then everything without one.
    private var sections: [CategorySection] {
        // Outputs carry no category yet, so singles stay ungrouped until the
        // categorizer fills one in.
        let projects = projects
        let titles = Set(projects.compactMap(\.category))
        var result: [CategorySection] = titles.sorted().map { title in
            CategorySection(
                title: title,
                projects: projects.filter { $0.category == title },
                singles: []
            )
        }
        let uncategorizedProjects = projects.filter { $0.category == nil }
        if !uncategorizedProjects.isEmpty || !store.singles.isEmpty {
            result.append(CategorySection(
                title: nil,
                projects: uncategorizedProjects,
                singles: store.singles
            ))
        }
        return result
    }

    @ViewBuilder
    private func sectionView(_ section: CategorySection) -> some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            SectionHeader(section.title ?? (projects.isEmpty ? "Without a project" : "Projects and things without a project"))

            ForEach(section.projects) { project in
                NavigationLink(value: project) {
                    ProjectRow(project: project, count: itemCount(project))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("project-row-\(project.id)")
                .contextMenu {
                    if store.project(forID: project.id) != nil {
                        Button("Edit") { editingProject = project }
                    }
                }
            }

            ForEach(section.singles) { output in
                OutputCardButton(output: output, style: .list)
            }
        }
    }
}

/// Navigation value for the Inbox screen.
struct InboxRoute: Hashable {}

struct ProjectRow: View {
    let project: Project
    /// Nil when it isn't known yet.
    let count: Int?

    var body: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            Image(systemName: project.icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(project.color)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(project.title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .lineLimit(1)
                Text(count.map { $0 == 1 ? "1 item" : "\($0) items" } ?? "From the web Studio")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
    }
}

#Preview {
    let store = OutputStore()
    store.createProject(title: "Linear algebra", icon: "function")
    store.upsert(Output(title: "Attention is all you need", subtitle: "arxiv.org", sourceKind: .paper))
    return NavigationStack { HomeView() }
        .environmentObject(store)
        .environmentObject(AppState())
        .environmentObject(GenerationService(store: store))
        .environmentObject(StudioStore(client: NoStudio(), outputs: store))
}
