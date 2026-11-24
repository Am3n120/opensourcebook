import SwiftUI

/// The sources in a project, as the engine lists them. Sources are added
/// and filed in the web Studio; the phone lists them.
struct ProjectSourcesSection: View {
    @EnvironmentObject private var studio: StudioStore
    let projectID: String

    var body: some View {
        let key = StudioStore.projectKey(projectID)
        if studio.project(projectID) == nil {
            EmptyStateView(icon: "link", title: "No sources here",
                           message: "This project is only on this phone. Sources live in projects made in the web Studio.")
        } else if let sources = studio.sources(inProject: projectID) {
            if sources.isEmpty {
                EmptyStateView(icon: "link", title: "No sources yet",
                               message: "Sources you add in the web Studio will appear here.")
            } else {
                VStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    ForEach(sources) { StudioSourceRow(source: $0) }
                }
            }
        } else if let failure = studio.failure(key) {
            ProjectContentStatusView(message: failure) { Task { await studio.refreshProject(projectID) } }
        } else {
            ProjectContentStatusView(message: nil, retry: nil)
        }
    }
}

private struct StudioSourceRow: View {
    let source: StudioSource

    var body: some View {
        let style = source.sourceKind.style
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            Image(systemName: style.icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(style.color)
                .frame(width: 36, height: 36)
                .background(style.softColor)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(source.displayTitle)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .lineLimit(2)
                if !source.detail.isEmpty {
                    Text(source.detail)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .background(OpenSourcebookTheme.Colors.surface)
        .openSourcebookCardStyle()
        .accessibilityElement(children: .combine)
    }
}
