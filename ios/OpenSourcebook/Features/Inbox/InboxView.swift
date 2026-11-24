import SwiftUI

/// Unfiled outputs. Each one can be filed into a project, or kept as a
/// single on purpose (DECISIONS.md #8, #17).
struct InboxView: View {
    @EnvironmentObject private var store: OutputStore
    @State private var isCreatingProject = false
    @State private var pendingOutputID: UUID?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                if store.inbox.isEmpty {
                    EmptyStateView(
                        icon: "tray",
                        title: "Inbox is empty",
                        message: "Everything you capture lands here until you file it."
                    )
                } else {
                    ForEach(store.inbox) { output in
                        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                            OutputCardButton(output: output, style: .list)
                            fileMenu(for: output)
                        }
                    }
                }
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
        }
        .background(OpenSourcebookTheme.Colors.background)
        .navigationTitle("Inbox")
        .navigationBarTitleDisplayMode(.large)
        .sheet(isPresented: $isCreatingProject) {
            ProjectEditorSheet(project: nil)
        }
    }

    private func fileMenu(for output: Output) -> some View {
        Menu {
            ForEach(store.projects) { project in
                Button {
                    store.file(output.id, into: project.id)
                } label: {
                    Label(project.title, systemImage: project.icon)
                }
            }
            Button {
                isCreatingProject = true
            } label: {
                Label("New project", systemImage: "folder.badge.plus")
            }
            Divider()
            Button {
                store.file(output.id, into: nil)
            } label: {
                Label("Keep without a project", systemImage: "doc")
            }
        } label: {
            Label("File into…", systemImage: "folder")
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(OpenSourcebookTheme.Colors.primarySoft)
                .clipShape(Capsule())
        }
    }
}

#Preview {
    let store = OutputStore()
    store.upsert(Output(title: "Attention is all you need", subtitle: "arxiv.org", sourceKind: .paper))
    return NavigationStack { InboxView() }
        .environmentObject(store)
        .environmentObject(AppState())
}
