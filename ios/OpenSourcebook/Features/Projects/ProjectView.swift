import SwiftUI

/// One project: what was made in it, its plans and its sources. A project
/// made in the web Studio is read from the engine (pull to refresh); one made
/// on this phone holds what was captured into it and can be edited here.
struct ProjectView: View {
    @EnvironmentObject private var store: OutputStore
    @EnvironmentObject private var studio: StudioStore
    @Environment(\.dismiss) private var dismiss
    let projectID: String
    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    @State private var segment: ProjectSegment = .outputs

    /// Made on this phone (editable here) rather than read from the Studio.
    private var localProject: Project? { store.project(forID: projectID) }
    private var isInStudio: Bool { studio.project(projectID) != nil }

    var body: some View {
        Group {
            if let project = localProject ?? studio.project(projectID)?.asProject {
                content(for: project)
            } else {
                EmptyStateView(icon: "folder", title: "Project not found", message: "It may have been deleted.")
            }
        }
        .background(OpenSourcebookTheme.Colors.background)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: PlanRoute.self) { PlanView(planID: $0.planID) }
        .task(id: projectID) {
            guard isInStudio else { return }
            await studio.readOnce(StudioStore.projectKey(projectID)) { await studio.refreshProject(projectID) }
        }
    }

    private func content(for project: Project) -> some View {
        let entries = ProjectEntries.make(held: store.outputs(inProject: project.id),
                                          listed: studio.madeThings(inProject: project.id) ?? [])
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
                HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    Image(systemName: project.icon)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .background(project.color)
                        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.title)
                            .font(OpenSourcebookTheme.Fonts.title)
                            .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                            .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        Text(entries.count == 1 ? "1 item" : "\(entries.count) items")
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    }
                    Spacer()
                }
                .padding(.bottom, OpenSourcebookTheme.Spacing.xs)

                if let failure = studio.failure(StudioStore.projectKey(projectID)),
                   studio.plans(inProject: projectID) != nil {
                    Text(failure)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.accentText)
                }

                Picker("Section", selection: $segment) {
                    ForEach(ProjectSegment.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.bottom, OpenSourcebookTheme.Spacing.xs)

                switch segment {
                case .outputs:
                    outputs(entries)
                case .plans:
                    ProjectPlansSection(projectID: project.id)
                case .sources:
                    ProjectSourcesSection(projectID: project.id)
                }
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
        }
        .refreshable {
            if isInStudio { await studio.refreshProject(projectID) }
        }
        .toolbar {
            if localProject != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Edit") { isEditing = true }
                        Button("Delete project", role: .destructive) { isConfirmingDelete = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .sheet(isPresented: $isEditing) { ProjectEditorSheet(project: project) }
        .confirmationDialog(
            "Delete \(project.title)?",
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete project", role: .destructive) {
                store.deleteProject(project.id)
                dismiss()
            }
        } message: {
            Text("Its items stay and go back to the Inbox.")
        }
    }

    @ViewBuilder
    private func outputs(_ entries: [ProjectEntry]) -> some View {
        if entries.isEmpty {
            if isInStudio && studio.madeThings(inProject: projectID) == nil {
                ProjectContentStatusView(message: studio.failure(StudioStore.projectKey(projectID))) {
                    Task { await studio.refreshProject(projectID) }
                }
            } else {
                EmptyStateView(
                    icon: "tray",
                    title: "No items yet",
                    message: isInStudio
                        ? "Things made from this project's plans will appear here."
                        : "File something from the Inbox, or capture into this project."
                )
            }
        } else {
            let queue = PlayerQueue(outputIDs: entries.compactMap(\.held).map(\.id))
            ForEach(entries) { entry in
                switch entry {
                case .held(let output):
                    OutputCardButton(output: output, style: .list, queue: queue)
                case .listed(let summary):
                    StudioMadeRow(summary: summary)
                }
            }
        }
    }
}

/// A made thing in a project: on the phone already, or only listed by the engine.
enum ProjectEntry: Identifiable, Equatable {
    case held(Output)
    case listed(StudioOutputSummary)

    var id: String {
        switch self {
        case .held(let output): output.id.uuidString.lowercased()
        case .listed(let summary): summary.id.lowercased()
        }
    }

    var held: Output? {
        if case .held(let output) = self { return output }
        return nil
    }

    var date: Date {
        switch self {
        case .held(let output): output.createdAt
        case .listed(let summary): summary.createdAt ?? .distantPast
        }
    }
}

enum ProjectEntries {
    /// What the phone holds in the project, plus what the engine lists that
    /// the phone doesn't hold yet, newest first, each once.
    static func make(held: [Output], listed: [StudioOutputSummary]) -> [ProjectEntry] {
        let heldIDs = Set(held.map(\.id))
        let missing = listed.filter { summary in summary.uuid.map { !heldIDs.contains($0) } ?? false }
        return (held.map(ProjectEntry.held) + missing.map(ProjectEntry.listed))
            .sorted { ($0.date, $0.id) > ($1.date, $1.id) }
    }
}

/// A made thing the engine lists that is not on the phone yet: tapping it
/// fetches it and plays it.
private struct StudioMadeRow: View {
    @EnvironmentObject private var studio: StudioStore
    @EnvironmentObject private var appState: AppState
    let summary: StudioOutputSummary
    @State private var isFetching = false
    @State private var failed = false

    var body: some View {
        Button {
            guard !isFetching else { return }
            isFetching = true
            Task {
                let output = await studio.output(for: summary)
                isFetching = false
                failed = output == nil
                if let output, PlayerRegistry.standard.canPlay(output.type) { appState.present(output) }
            }
        } label: {
            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                TypeBadge(summary.type)
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.title)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(2)
                    Text(failed ? "Couldn't fetch it. Tap to try again." : (summary.summary ?? "Tap to fetch it."))
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(failed ? OpenSourcebookTheme.Colors.accentText : OpenSourcebookTheme.Colors.muted)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                if isFetching {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.down.circle")
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }
            }
            .padding(OpenSourcebookTheme.Spacing.sm)
            .background(OpenSourcebookTheme.Colors.surface)
            .openSourcebookCardStyle()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The three parts of a project screen.
enum ProjectSegment: String, CaseIterable, Identifiable {
    case outputs, plans, sources

    var id: String { rawValue }

    var label: String {
        switch self {
        case .outputs: "Items"
        case .plans: "Plans"
        case .sources: "Sources"
        }
    }
}

#Preview {
    let store = OutputStore()
    let project = store.createProject(title: "Linear algebra", icon: "function")
    store.upsert(Output(title: "Echelon forms", subtitle: "Lay §1.2", projectID: project.id))
    return NavigationStack { ProjectView(projectID: project.id) }
        .environmentObject(store)
        .environmentObject(AppState())
        .environmentObject(DoneTickStore())
        .environmentObject(StudioStore(client: NoStudio(), outputs: store))
}
