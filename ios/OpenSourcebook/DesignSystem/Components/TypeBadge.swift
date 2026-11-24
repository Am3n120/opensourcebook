import SwiftUI

/// Compact icon + label badge for an output's format. The format is what a
/// badge shows (DECISIONS.md #4); the source kind is secondary. Glyph, word
/// and colour come from the format's descriptor; a format the catalog doesn't
/// know gets the neutral badge with its raw id.
struct TypeBadge: View {
    let type: FormatID
    let showsLabel: Bool

    init(_ type: FormatID, showsLabel: Bool = true) {
        self.type = type
        self.showsLabel = showsLabel
    }

    var body: some View {
        let style = type.style
        HStack(spacing: 5) {
            Image(systemName: style.icon)
                .font(.system(size: 10, weight: .semibold))
            if showsLabel {
                Text(style.label)
                    .font(OpenSourcebookTheme.Fonts.label)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .foregroundStyle(style.color)
        .padding(.horizontal, showsLabel ? 10 : 7)
        .padding(.vertical, 4)
        .background(style.softColor)
        .clipShape(Capsule())
        .accessibilityLabel(style.label)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 8) {
        ForEach(FormatCatalog.bundled.formats) { TypeBadge($0.id) }
        TypeBadge("unknown-format")
        TypeBadge(FormatCatalog.bundled.formats[0].id, showsLabel: false)
    }
    .padding()
}
