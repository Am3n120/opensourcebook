import SwiftUI

/// Shared empty state: tinted icon disc, title, message, optional capsule action.
struct EmptyStateView: View {
    let icon: String
    let title: String
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.lg) {
            Image(systemName: icon)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .frame(width: 72, height: 72)
                .background(OpenSourcebookTheme.Colors.primarySoft)
                .clipShape(Circle())

            VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.title)
                    .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                Text(message)
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .multilineTextAlignment(.center)
            }

            if let actionTitle, let action {
                Button {
                    action()
                } label: {
                    Text(actionTitle)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
                        .padding(.vertical, OpenSourcebookTheme.Spacing.sm + 2)
                        .background(OpenSourcebookTheme.Colors.primary)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.xxl)
        .frame(maxWidth: .infinity)
    }
}


#Preview {
    EmptyStateView(
        icon: "square.and.arrow.up",
        title: "Nothing here yet",
        message: "Share something to Open Sourcebook and it will show up here.",
        actionTitle: "Capture"
    ) {}
}
