import SwiftUI

/// Section title with an optional trailing "See all"-style action.
struct SectionHeader: View {
    let title: String
    let actionTitle: String?
    let action: (() -> Void)?

    init(_ title: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(OpenSourcebookTheme.Fonts.heading)
                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)

            Spacer()

            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityAddTraits(.isHeader)
    }
}

#Preview {
    SectionHeader("Recently opened", actionTitle: "See all") {}
        .padding()
}
