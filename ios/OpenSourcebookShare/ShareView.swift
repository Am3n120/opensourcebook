import Combine
import SwiftUI

/// What the extension read from the share sheet.
struct OpenSourcebookSharePayload {
    let sourceText: String
    let sourceURL: String?
    let sourceKind: String
    let filename: String?
    let data: Data?

    var displayTitle: String {
        if let filename, !filename.isEmpty { return filename }
        if sourceKind == "text" { return "Selected text" }
        return sourceURL ?? sourceText
    }

    var previewText: String {
        if let sourceURL { return sourceURL }
        return sourceText
    }

    var iconName: String {
        switch sourceKind {
        case "youtube", "vimeo": return "play.rectangle.fill"
        case "x": return "bubble.left.and.bubble.right.fill"
        case "instagram", "tiktok": return "camera.fill"
        case "reddit": return "text.bubble.fill"
        case "pdf": return "doc.richtext.fill"
        case "image": return "photo.fill"
        case "audio": return "waveform"
        case "file": return "doc.fill"
        case "text": return "text.quote"
        default: return "link"
        }
    }
}

@MainActor
final class OpenSourcebookShareViewModel: ObservableObject {
    @Published var payload: OpenSourcebookSharePayload?
    @Published var isLoading = true
    @Published var isSaving = false
    @Published var errorMessage: String?
    /// Projects the app last published to the App Group.
    @Published var projects: [ProjectPickerItem] = []
    @Published var choice: ProjectPickerChoice = .auto
    @Published var newProjectTitle = ""

    var trimmedNewProjectTitle: String {
        newProjectTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Nil while "New project" is chosen without a name.
    var destination: OpenSourcebookShareDestination? {
        switch choice {
        case .auto: return .auto
        case .project(let id): return .project(id: id)
        case .inbox: return .inbox
        case .newProject:
            let title = trimmedNewProjectTitle
            return title.isEmpty ? nil : .newProject(title: title)
        }
    }
}

struct OpenSourcebookShareView: View {
    @ObservedObject var model: OpenSourcebookShareViewModel
    let onSave: () -> Void
    let onCancel: () -> Void

    private var canSave: Bool {
        !model.isLoading && model.payload != nil && !model.isSaving && model.destination != nil
    }

    var body: some View {
        shareContent
            // OpenSourcebookTheme is light-only; pin it so system text colors stay dark.
            .preferredColorScheme(.light)
    }

    private var shareContent: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.lg) {
                    content
                    if let errorMessage = model.errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(OpenSourcebookTheme.Colors.accentText)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("share-error")
                    }
                }
                .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
                .padding(.top, OpenSourcebookTheme.Spacing.xs)
                .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
            }
            .background(OpenSourcebookTheme.Colors.background.ignoresSafeArea())
            .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
            .navigationTitle("Save to Open Sourcebook")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(model.isSaving)
                        .accessibilityIdentifier("share-cancel")
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading {
            VStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                ProgressView().tint(OpenSourcebookTheme.Colors.primary)
                Text("Reading shared content…")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 170)
        } else if let payload = model.payload {
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.lg) {
                sourceCard(payload)
                destinationSection
            }
        } else {
            VStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Image(systemName: "doc.questionmark")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                Text("No shareable content was found.")
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 170)
        }
    }

    private func sourceCard(_ payload: OpenSourcebookSharePayload) -> some View {
        HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
            Image(systemName: payload.iconName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .frame(width: 36, height: 36)
                .background(OpenSourcebookTheme.Colors.primarySoft)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))

            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                Text(payload.displayTitle)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .lineLimit(2)
                Text(payload.previewText)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .lineLimit(4)
            }
            Spacer(minLength: 0)
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
        .accessibilityIdentifier("share-source-preview")
    }

    private var destinationSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Text("Where it goes")
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

            ProjectPicker(
                selection: $model.choice,
                projects: model.projects,
                onNewProject: { model.choice = .newProject }
            )

            if model.choice == .newProject {
                TextField("Project name", text: $model.newProjectTitle)
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .padding(OpenSourcebookTheme.Spacing.sm)
                    .background(OpenSourcebookTheme.Colors.fill)
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                    .accessibilityIdentifier("share-new-project-title")
            }
        }
    }

    private var actionBar: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            Button(action: onSave) {
                HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    if model.isSaving {
                        ProgressView().tint(OpenSourcebookTheme.Colors.surface)
                    } else {
                        Image(systemName: "tray.and.arrow.down.fill")
                    }
                    Text("Save")
                }
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(OpenSourcebookTheme.Colors.surface)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(canSave ? OpenSourcebookTheme.Colors.text : OpenSourcebookTheme.Colors.muted)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!canSave)
            .accessibilityIdentifier("share-save")

            Text("Open Sourcebook starts on it the next time you open the app.")
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
        .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
        .background(OpenSourcebookTheme.Colors.background)
    }
}
