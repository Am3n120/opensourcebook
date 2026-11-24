import SwiftUI

/// Archived outputs (August's bins, moved here by DECISIONS.md #2): restore or
/// delete for good.
struct ArchiveSheet: View {
    @EnvironmentObject private var store: OutputStore
    @Environment(\.dismiss) private var dismiss
    @State private var pendingDelete: Output?

    var body: some View {
        NavigationStack {
            ScrollView {
                if store.archivedOutputs.isEmpty {
                    EmptyStateView(
                        icon: "archivebox",
                        title: "Archive is empty",
                        message: "Archived items wait here until you restore or delete them."
                    )
                } else {
                    LazyVStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                        ForEach(store.archivedOutputs) { output in
                            OutputCardView(output, style: .list)
                                .contextMenu {
                                    Button("Unarchive", systemImage: "tray.and.arrow.up") {
                                        store.unarchive(output.id)
                                    }
                                    Button("Delete", systemImage: "trash", role: .destructive) {
                                        pendingDelete = output
                                    }
                                }
                        }
                    }
                    .padding(OpenSourcebookTheme.Spacing.md)
                }
            }
            .background(OpenSourcebookTheme.Colors.background)
            .navigationTitle("Archive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Delete this item for good?",
                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { output in
                Button("Delete", role: .destructive) { store.delete(output.id) }
            } message: { output in
                Text("\(output.title) can't be recovered.")
            }
        }
    }
}

#Preview {
    let store = OutputStore()
    let output = Output(title: "Attention is all you need", subtitle: "arxiv.org")
    store.upsert(output)
    store.archive(output.id)
    return ArchiveSheet().environmentObject(store)
}
