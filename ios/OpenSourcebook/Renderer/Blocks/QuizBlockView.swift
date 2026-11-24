import SwiftUI

/// Interactive quiz: tap an option → correct turns success-green, wrong turns
/// red and reveals the correct answer; explanation appears. Re-tap to retry.
struct QuizBlockView: View {
    let question: String
    let options: [String]
    let correctIndex: Int
    let explanation: String?

    @State private var selectedIndex: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Image(systemName: "questionmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                Text("Check yourself")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .fontWeight(.bold)
                    .tracking(1.2)
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
            }

            Text(question)
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    Button {
                        withAnimation(OpenSourcebookTheme.Motion.quick) { selectedIndex = index }
                        OpenSourcebookHaptics.lightImpact()
                    } label: {
                        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                            Image(systemName: iconName(for: index))
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(iconColor(for: index))
                            Text(option)
                                .font(OpenSourcebookTheme.Fonts.caption)
                                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(OpenSourcebookTheme.Spacing.sm)
                        .background(backgroundColor(for: index))
                        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                                .stroke(borderColor(for: index), lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }

            if selectedIndex != nil, let explanation {
                Text(explanation)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(OpenSourcebookTheme.Spacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(OpenSourcebookTheme.Colors.fill)
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                    .transition(.opacity)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }

    // MARK: Styling helpers

    private func isCorrect(_ index: Int) -> Bool { index == correctIndex }

    private func backgroundColor(for index: Int) -> Color {
        guard let selectedIndex else { return OpenSourcebookTheme.Colors.surface }
        if isCorrect(index) && (selectedIndex == index || !isCorrect(selectedIndex)) {
            return OpenSourcebookTheme.Colors.successSoft
        }
        if selectedIndex == index { return Color(hex: 0xFEE2E2) }
        return OpenSourcebookTheme.Colors.surface
    }

    private func borderColor(for index: Int) -> Color {
        guard let selectedIndex else { return OpenSourcebookTheme.Colors.border }
        if isCorrect(index) && (selectedIndex == index || !isCorrect(selectedIndex)) {
            return OpenSourcebookTheme.Colors.success
        }
        if selectedIndex == index { return Color(hex: 0xEF4444) }
        return OpenSourcebookTheme.Colors.border
    }

    private func iconName(for index: Int) -> String {
        guard let selectedIndex else { return "circle" }
        if isCorrect(index) && (selectedIndex == index || !isCorrect(selectedIndex)) {
            return "checkmark.circle.fill"
        }
        if selectedIndex == index { return "xmark.circle.fill" }
        return "circle"
    }

    private func iconColor(for index: Int) -> Color {
        guard let selectedIndex else { return OpenSourcebookTheme.Colors.border }
        if isCorrect(index) && (selectedIndex == index || !isCorrect(selectedIndex)) {
            return OpenSourcebookTheme.Colors.success
        }
        if selectedIndex == index { return Color(hex: 0xEF4444) }
        return OpenSourcebookTheme.Colors.border
    }
}
