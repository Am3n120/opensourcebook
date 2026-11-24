import SwiftUI

/// Shortest-column-first masonry for the gallery layout. Column count follows
/// the proposed width, so it works on any phone size and in landscape.
struct MasonryLayout: Layout {
    var spacing: CGFloat = OpenSourcebookTheme.Spacing.sm
    var minColumnWidth: CGFloat = 160

    private func columnCount(for width: CGFloat) -> Int {
        guard width > 0 else { return 1 }
        return max(1, Int((width + spacing) / (minColumnWidth + spacing)))
    }

    /// Overall size and each subview's frame, in layout order.
    private func arrange(width: CGFloat, subviews: Subviews) -> (CGSize, [CGRect]) {
        let count = columnCount(for: width)
        let columnWidth = (width - spacing * CGFloat(count - 1)) / CGFloat(count)
        var columnHeights = [CGFloat](repeating: 0, count: count)
        var frames: [CGRect] = []
        frames.reserveCapacity(subviews.count)

        for subview in subviews {
            let shortest = columnHeights.firstIndex(of: columnHeights.min() ?? 0) ?? 0
            let size = subview.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil))
            let origin = CGPoint(x: CGFloat(shortest) * (columnWidth + spacing), y: columnHeights[shortest])
            frames.append(CGRect(origin: origin, size: CGSize(width: columnWidth, height: size.height)))
            columnHeights[shortest] += size.height + spacing
        }

        let totalHeight = max((columnHeights.max() ?? 0) - spacing, 0)
        return (CGSize(width: width, height: totalHeight), frames)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? 0, subviews: subviews).0
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (_, frames) = arrange(width: bounds.width, subviews: subviews)
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(x: bounds.minX + frames[index].minX, y: bounds.minY + frames[index].minY),
                proposal: ProposedViewSize(frames[index].size)
            )
        }
    }
}
