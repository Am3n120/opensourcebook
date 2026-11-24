import SwiftUI

/// Styled search bar matching the sketch: neutral fill, 12pt radius, clear button.
struct SearchField: View {
    @Binding var text: String
    var placeholder: String

    init(text: Binding<String>, placeholder: String = "Search…") {
        _text = text
        self.placeholder = placeholder
    }

    var body: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

            TextField(placeholder, text: $text)
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(OpenSourcebookTheme.Colors.fill)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
    }
}

#Preview {
    SearchField(text: .constant("transformers"))
        .padding()
}
