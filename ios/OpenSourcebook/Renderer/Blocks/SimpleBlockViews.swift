import SwiftUI

/// Non-interactive block views. All internal to the module; dispatched by `BlockView`.

// MARK: - Text & structure

struct KickerBlockView: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(OpenSourcebookTheme.Fonts.label)
            .tracking(1.4)
            .foregroundStyle(OpenSourcebookTheme.Colors.primary)
    }
}

struct HeadingBlockView: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 24, weight: .bold))
            .tracking(OpenSourcebookTheme.Fonts.tightTracking)
            .foregroundStyle(OpenSourcebookTheme.Colors.text)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct SubheadingBlockView: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(OpenSourcebookTheme.Colors.text)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct TextBlockView: View {
    let text: String

    var body: some View {
        Text(InlineMarkdown.parse(text))
            .font(OpenSourcebookTheme.Fonts.body)
            .lineSpacing(5)
            .foregroundStyle(OpenSourcebookTheme.Colors.text)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct QuoteBlockView: View {
    let text: String
    let author: String?
    let source: String?

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Text("\u{201C}")
                .font(.system(size: 40, weight: .heavy))
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .frame(height: 28, alignment: .top)

            Text(InlineMarkdown.parse(text))
                .font(.system(size: 19, weight: .semibold, design: .serif))
                .lineSpacing(4)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .fixedSize(horizontal: false, vertical: true)

            if author != nil || source != nil {
                Text("— " + [author, source].compactMap { $0 }.joined(separator: ", "))
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OpenSourcebookTheme.Colors.primaryGhost)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))
    }
}

struct DividerBlockView: View {
    var body: some View {
        Rectangle()
            .fill(OpenSourcebookTheme.Colors.border)
            .frame(height: 1)
    }
}

struct ContinuationBlockView: View {
    var body: some View {
        Text("···")
            .font(OpenSourcebookTheme.Fonts.heading)
            .tracking(4)
            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            .frame(maxWidth: .infinity)
    }
}

struct SpacerBlockView: View {
    var body: some View {
        Color.clear.frame(height: OpenSourcebookTheme.Spacing.sm)
    }
}

// MARK: - Media & references

struct ImageBlockView: View {
    let url: String?
    let caption: String?
    let systemIcon: String

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Group {
                if let url, let imageURL = URL(string: url) {
                    AsyncImage(url: imageURL) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        default:
                            fallback
                        }
                    }
                } else {
                    fallback
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 200)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))

            if let caption {
                Text(caption)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
    }

    private var fallback: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0xBAE6FD), Color(hex: 0x6C5CE7)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: systemIcon)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
        }
    }
}

struct LinkCardBlockView: View {
    let url: String
    let title: String
    let domain: String

    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let target = URL(string: url) { openURL(target) }
        } label: {
            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Image(systemName: "link")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                    .frame(width: 40, height: 40)
                    .background(OpenSourcebookTheme.Colors.primarySoft)
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(2)
                    Text(domain)
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }

                Spacer(minLength: OpenSourcebookTheme.Spacing.xs)

                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            .padding(OpenSourcebookTheme.Spacing.md)
            .openSourcebookCardStyle()
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Data & structured content

struct CalloutBlockView: View {
    let style: CalloutStyle
    let title: String?
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
            Image(systemName: style.icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(style.color)

            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                if let title {
                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                }
                Text(InlineMarkdown.parse(text))
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .lineSpacing(3)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(style.softColor)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))
    }
}

struct BulletsBlockView: View {
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            ForEach(items, id: \.self) { item in
                HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
                    Circle()
                        .fill(OpenSourcebookTheme.Colors.primary)
                        .frame(width: 5, height: 5)
                        .padding(.top, 7)
                    Text(InlineMarkdown.parse(item))
                        .font(OpenSourcebookTheme.Fonts.body)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

struct NumberedBlockView: View {
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
                    Text("\(index + 1)")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(OpenSourcebookTheme.Colors.primary)
                        .clipShape(Circle())
                    Text(InlineMarkdown.parse(item))
                        .font(OpenSourcebookTheme.Fonts.body)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

struct MetricsBlockView: View {
    let stats: [StatItem]

    private let columns = [GridItem(.flexible(), spacing: OpenSourcebookTheme.Spacing.sm),
                           GridItem(.flexible(), spacing: OpenSourcebookTheme.Spacing.sm)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: OpenSourcebookTheme.Spacing.sm) {
            ForEach(stats) { stat in
                VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                    Text(stat.value)
                        .font(.system(size: 22, weight: .bold))
                        .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    Text(stat.label)
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    if let delta = stat.delta {
                        Text(delta)
                            .font(OpenSourcebookTheme.Fonts.label)
                            .foregroundStyle(deltaColor(for: delta))
                    }
                }
                .padding(OpenSourcebookTheme.Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .openSourcebookCardStyle()
            }
        }
    }

    private func deltaColor(for delta: String) -> Color {
        if delta.hasPrefix("+") || delta.hasPrefix("↑") { return OpenSourcebookTheme.Colors.success }
        if delta.hasPrefix("-") || delta.hasPrefix("↓") { return Color(hex: 0xEF4444) }
        return OpenSourcebookTheme.Colors.muted
    }
}

struct TableBlockView: View {
    let headers: [String]
    let rows: [[String]]

    @State private var viewportWidth: CGFloat = 0
    @State private var contentWidth: CGFloat = 0

    /// True when the content is wider than the card — drives the trailing
    /// fade that hints the table scrolls horizontally (CodeBlockView idiom).
    private var overflows: Bool { contentWidth > viewportWidth + 1 }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            tableContent
                // The min-width floor fills the card when the content is
                // narrow; wider content keeps its natural width and scrolls
                // instead of clipping the trailing columns.
                .frame(minWidth: viewportWidth > 0 ? viewportWidth : nil, alignment: .leading)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { contentWidth = $0 }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { viewportWidth = $0 }
        .overlay(alignment: .trailing) {
            if overflows {
                LinearGradient(colors: [OpenSourcebookTheme.Colors.surface.opacity(0), OpenSourcebookTheme.Colors.surface],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(width: 28)
                    .allowsHitTesting(false)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                .stroke(OpenSourcebookTheme.Colors.border, lineWidth: 1)
        )
    }

    private var tableContent: some View {
        VStack(spacing: 0) {
            row(cells: headers, isHeader: true, isZebra: false)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                row(cells: cells, isHeader: false, isZebra: index % 2 == 1)
            }
        }
    }

    private func row(cells: [String], isHeader: Bool, isZebra: Bool) -> some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                Text(cell)
                    .font(isHeader ? OpenSourcebookTheme.Fonts.label : OpenSourcebookTheme.Fonts.caption)
                    .fontWeight(isHeader ? .semibold : .regular)
                    .foregroundStyle(isHeader ? OpenSourcebookTheme.Colors.text : (index == 0 ? OpenSourcebookTheme.Colors.text : OpenSourcebookTheme.Colors.muted))
                    .frame(maxWidth: .infinity,
                           alignment: index == 0 ? .leading : .trailing)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
        .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
        .background(isHeader ? OpenSourcebookTheme.Colors.fill : (isZebra ? OpenSourcebookTheme.Colors.background : OpenSourcebookTheme.Colors.surface))
    }
}

struct TimelineBlockView: View {
    let items: [TimelineItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
                    VStack(spacing: 0) {
                        Circle()
                            .fill(OpenSourcebookTheme.Colors.primary)
                            .frame(width: 10, height: 10)
                            .padding(.top, 4)
                        if index < items.count - 1 {
                            Rectangle()
                                .fill(OpenSourcebookTheme.Colors.border)
                                .frame(width: 2)
                                .frame(maxHeight: .infinity)
                        }
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.label.uppercased())
                            .font(OpenSourcebookTheme.Fonts.label)
                            .tracking(1)
                            .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                        Text(item.title)
                            .font(OpenSourcebookTheme.Fonts.bodySemibold)
                            .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        if let detail = item.detail {
                            Text(detail)
                                .font(OpenSourcebookTheme.Fonts.caption)
                                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.bottom, OpenSourcebookTheme.Spacing.lg)
                }
            }
        }
    }
}

struct CodeBlockView: View {
    let code: String
    let language: String

    @State private var contentWidth: CGFloat = 0
    @State private var viewportWidth: CGFloat = 0

    /// True when the longest line exceeds the visible width — drives the
    /// trailing fade that hints the block scrolls horizontally.
    private var overflows: Bool { contentWidth > viewportWidth + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            HStack {
                Text(language.uppercased())
                    .font(OpenSourcebookTheme.Fonts.label)
                    .tracking(1)
                    .foregroundStyle(.white.opacity(0.6))
                Spacer()
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Color(hex: 0xE2E8F0))
                    // Never wrap: long lines scroll instead of truncating.
                    .fixedSize(horizontal: true, vertical: true)
                    // Keep the tail of the longest line clear of the fade.
                    .padding(.trailing, overflows ? 28 : 0)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { contentWidth = $0 }
            }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { viewportWidth = $0 }
            .overlay(alignment: .trailing) {
                if overflows {
                    LinearGradient(colors: [Color(hex: 0x0F172A).opacity(0), Color(hex: 0x0F172A)],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: 28)
                        .allowsHitTesting(false)
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: 0x0F172A))
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
    }
}

struct BigStatBlockView: View {
    let value: String
    let label: String
    let delta: String?

    var body: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
            Text(value)
                .font(.system(size: 44, weight: .heavy))
                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
            Text(label)
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            if let delta {
                Text(delta)
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(delta.hasPrefix("+") ? OpenSourcebookTheme.Colors.success : OpenSourcebookTheme.Colors.muted)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, OpenSourcebookTheme.Spacing.lg)
    }
}
