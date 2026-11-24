import SwiftUI

/// Interactive blocks with simple local state: checklist + reveal.
/// (Quiz, servings scaler, timer, order exercise, audio and video live
/// in their own files.)

// MARK: - Checklist

struct ChecklistBlockView: View {
    let items: [String]

    @State private var checked: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                Button {
                    withAnimation(OpenSourcebookTheme.Motion.quick) {
                        if checked.contains(index) { checked.remove(index) } else { checked.insert(index) }
                    }
                    OpenSourcebookHaptics.lightImpact()
                } label: {
                    HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
                        ZStack {
                            Circle()
                                .stroke(checked.contains(index) ? OpenSourcebookTheme.Colors.success : OpenSourcebookTheme.Colors.border,
                                        lineWidth: 2)
                                .frame(width: 24, height: 24)
                            if checked.contains(index) {
                                Circle()
                                    .fill(OpenSourcebookTheme.Colors.success)
                                    .frame(width: 24, height: 24)
                                Image(systemName: "checkmark")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(.white)
                            }
                        }

                        Text(InlineMarkdown.parse(item))
                            .font(OpenSourcebookTheme.Fonts.body)
                            .strikethrough(checked.contains(index))
                            .foregroundStyle(checked.contains(index) ? OpenSourcebookTheme.Colors.muted : OpenSourcebookTheme.Colors.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}

/// Identity for blocks nested inside a reveal. Deliberately a NON-Int type:
/// the top-level canvas enumerates blocks with Int offset identities, which
/// Focus tracks via `scrollPosition(id:)`; if nested blocks also used Int
/// offsets, the scroll position could latch onto a nested block. `BlockView`
/// reuse for nested content is unchanged.
private struct NestedRevealBlock: Identifiable {
    struct NestedID: Hashable { let offset: Int }

    let offset: Int
    let block: Block

    var id: NestedID { NestedID(offset: offset) }
}

// MARK: - Reveal (expandable section)

struct RevealBlockView: View {
    let title: String
    let blocks: [Block]

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.md) {
            Button {
                withAnimation(OpenSourcebookTheme.Motion.standard) { isExpanded.toggle() }
                OpenSourcebookHaptics.lightImpact()
            } label: {
                HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(OpenSourcebookTheme.Spacing.md)
                .background(OpenSourcebookTheme.Colors.primaryGhost)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.lg) {
                    ForEach(blocks.enumerated().map { NestedRevealBlock(offset: $0.offset, block: $0.element) }) { nested in
                        BlockView(block: nested.block)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}
