import SwiftUI

/// Load state of one project-content list.
enum ProjectContentState<Value> {
    case loading
    case failed(String)
    case loaded(Value)
}

/// Shared frame for the loading and failed states of a project segment.
struct ProjectContentStatusView: View {
    let message: String?
    let retry: (() -> Void)?

    var body: some View {
        if let message {
            EmptyStateView(
                icon: "exclamationmark.triangle",
                title: "Couldn't load",
                message: message,
                actionTitle: retry == nil ? nil : "Try again",
                action: retry
            )
        } else {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(OpenSourcebookTheme.Spacing.xxl)
        }
    }
}
