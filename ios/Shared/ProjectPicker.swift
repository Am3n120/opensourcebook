import SwiftUI

/// What the project picker can be set to (DECISIONS.md #3: it replaces the
/// depth picker in capture and in the share sheet).
enum ProjectPickerChoice: Hashable, Sendable {
    case auto
    case project(id: String)
    /// The extension's inline "new project"; the app's capture sheet creates
    /// the project right away and selects it as `.project`.
    case newProject
    case inbox
}

/// A project as the picker shows it.
struct ProjectPickerItem: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let icon: String
    let colorHex: UInt32
}

/// Auto · each project · New project · Inbox, as one card of radio rows.
/// Used by the capture sheet and the share extension.
struct ProjectPicker: View {
    @Binding var selection: ProjectPickerChoice
    let projects: [ProjectPickerItem]
    /// Called when "New project" is tapped. The caller decides what that does.
    let onNewProject: () -> Void

    /// Auto has no engine support yet (see `CaptureDestination.auto`), so say
    /// where such a capture really goes today.
    static let autoDetail = "Open Sourcebook will choose the project. Until it can, this lands in the Inbox."

    var body: some View {
        VStack(spacing: 0) {
            row(
                choice: .auto,
                icon: "sparkles",
                tint: OpenSourcebookTheme.Colors.primary,
                title: "Auto",
                detail: Self.autoDetail
            )
            ForEach(projects) { project in
                divider
                row(
                    choice: .project(id: project.id),
                    icon: project.icon,
                    tint: Color(hex: project.colorHex),
                    title: project.title,
                    detail: nil
                )
            }
            divider
            row(
                choice: .newProject,
                icon: "folder.badge.plus",
                tint: OpenSourcebookTheme.Colors.primary,
                title: "New project",
                detail: nil,
                action: onNewProject
            )
            divider
            row(
                choice: .inbox,
                icon: "tray",
                tint: OpenSourcebookTheme.Colors.muted,
                title: "Inbox",
                detail: "Keep it unfiled and decide later."
            )
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
        .padding(.vertical, OpenSourcebookTheme.Spacing.xxs)
        .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
    }

    private var divider: some View {
        Divider().padding(.leading, 44)
    }

    private func row(
        choice: ProjectPickerChoice,
        icon: String,
        tint: Color,
        title: String,
        detail: String?,
        action: (() -> Void)? = nil
    ) -> some View {
        let isSelected = selection == choice
        return Button {
            if let action {
                action()
            } else {
                selection = choice
            }
        } label: {
            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 32, height: 32)
                    .background(OpenSourcebookTheme.Colors.fill)
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(1)
                    if let detail {
                        Text(detail)
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 0)

                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(isSelected ? OpenSourcebookTheme.Colors.primary : OpenSourcebookTheme.Colors.border)
            }
            .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

#Preview {
    ProjectPicker(
        selection: .constant(.auto),
        projects: [ProjectPickerItem(id: "p", title: "Linear algebra", icon: "function", colorHex: 0x2563EB)],
        onNewProject: {}
    )
    .padding()
    .background(OpenSourcebookTheme.Colors.background)
}
