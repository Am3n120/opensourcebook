import SwiftUI

/// Create (pass nil) or edit a project: title, icon and color.
struct ProjectEditorSheet: View {
    @EnvironmentObject private var store: OutputStore
    @Environment(\.dismiss) private var dismiss

    private let existing: Project?
    /// Called with the new project after Create, e.g. so capture can select it.
    private let onCreate: ((Project) -> Void)?
    @State private var title: String
    @State private var icon: String
    @State private var colorHex: UInt32

    /// SF Symbols offered as project icons.
    private static let icons = [
        "folder", "book", "graduationcap", "function", "flask", "briefcase",
        "hammer", "fork.knife", "figure.run", "paintbrush", "music.note", "globe"
    ]

    init(project: Project?, onCreate: ((Project) -> Void)? = nil) {
        existing = project
        self.onCreate = onCreate
        _title = State(initialValue: project?.title ?? "")
        _icon = State(initialValue: project?.icon ?? "folder")
        _colorHex = State(initialValue: project?.colorHex ?? Project.paletteHex[0])
    }

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.lg) {
                    VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                        Text("Title").font(OpenSourcebookTheme.Fonts.label).foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        TextField("Project name", text: $title)
                            .accessibilityIdentifier("project-title")
                            .font(OpenSourcebookTheme.Fonts.body)
                            .foregroundStyle(OpenSourcebookTheme.Colors.text)
                            .padding(OpenSourcebookTheme.Spacing.sm)
                            .background(OpenSourcebookTheme.Colors.fill)
                            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                    }

                    VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                        Text("Icon").font(OpenSourcebookTheme.Fonts.label).foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: OpenSourcebookTheme.Spacing.xs), count: 6),
                                  spacing: OpenSourcebookTheme.Spacing.xs) {
                            ForEach(Self.icons, id: \.self) { name in
                                Button { icon = name } label: {
                                    Image(systemName: name)
                                        .font(.system(size: 18, weight: .semibold))
                                        .foregroundStyle(icon == name ? Color.white : OpenSourcebookTheme.Colors.text)
                                        .frame(maxWidth: .infinity, minHeight: 44)
                                        .background(icon == name ? Color(hex: colorHex) : OpenSourcebookTheme.Colors.fill)
                                        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(name)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                        Text("Color").font(OpenSourcebookTheme.Fonts.label).foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: OpenSourcebookTheme.Spacing.xs), count: 5),
                                  spacing: OpenSourcebookTheme.Spacing.xs) {
                            ForEach(Project.paletteHex, id: \.self) { hex in
                                Button { colorHex = hex } label: {
                                    Circle()
                                        .fill(Color(hex: hex))
                                        .frame(width: 36, height: 36)
                                        .overlay {
                                            if colorHex == hex {
                                                Image(systemName: "checkmark")
                                                    .font(.system(size: 14, weight: .bold))
                                                    .foregroundStyle(.white)
                                            }
                                        }
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(OpenSourcebookTheme.Spacing.md)
            }
            .background(OpenSourcebookTheme.Colors.background)
            .navigationTitle(existing == nil ? "New project" : "Edit project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Create" : "Save") { save() }
                        .disabled(trimmedTitle.isEmpty)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func save() {
        if var project = existing {
            project.title = trimmedTitle
            project.icon = icon
            project.colorHex = colorHex
            store.updateProject(project)
        } else {
            let project = store.createProject(title: trimmedTitle, icon: icon, colorHex: colorHex)
            onCreate?(project)
        }
        dismiss()
    }
}

#Preview {
    ProjectEditorSheet(project: nil)
        .environmentObject(OutputStore())
}
