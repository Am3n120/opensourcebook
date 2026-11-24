import SwiftUI

/// Interactive drag-to-reorder exercise. Rows are reordered live with a
/// DragGesture; "Check order" validates against `correctOrder` (indices into
/// the ORIGINAL `items` array, in the correct sequence) and colors each row.
struct OrderExerciseBlockView: View {
    let prompt: String
    let items: [String]
    let correctOrder: [Int]

    /// Current arrangement as indices into `items`.
    @State private var order: [Int]
    @State private var draggingPosition: Int?
    @State private var appliedSteps = 0
    @State private var dragRemainder: CGFloat = 0
    @State private var checked = false

    private let rowHeight: CGFloat = 52

    init(prompt: String, items: [String], correctOrder: [Int]) {
        self.prompt = prompt
        self.items = items
        self.correctOrder = correctOrder
        _order = State(initialValue: Array(items.indices))
    }

    private var isSolved: Bool { order == correctOrder }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Image(systemName: "arrow.up.arrow.down.circle.fill")
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                Text("Put in order")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .tracking(1.2)
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
            }

            Text(prompt)
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                ForEach(Array(order.enumerated()), id: \.offset) { position, originalIndex in
                    row(position: position, originalIndex: originalIndex)
                        .offset(y: draggingPosition == position ? dragRemainder : 0)
                        .zIndex(draggingPosition == position ? 1 : 0)
                        .gesture(dragGesture(for: position))
                }
            }
            .animation(OpenSourcebookTheme.Motion.quick, value: order)

            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Button {
                    withAnimation(OpenSourcebookTheme.Motion.quick) { checked = true }
                    OpenSourcebookHaptics.lightImpact()
                } label: {
                    Text("Check order")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(.white)
                        .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
                        .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
                        .background(OpenSourcebookTheme.Colors.primary)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)

                Button {
                    withAnimation(OpenSourcebookTheme.Motion.quick) {
                        order = Array(items.indices)
                        checked = false
                    }
                } label: {
                    Text("Reset")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }
                .buttonStyle(.plain)

                Spacer()

                if checked {
                    Text(isSolved ? "Correct" : "Not quite")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(isSolved ? OpenSourcebookTheme.Colors.success : Color(hex: 0xEF4444))
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }

    // MARK: Row

    private func row(position: Int, originalIndex: Int) -> some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

            Text(items[originalIndex])
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if checked {
                Image(systemName: isCorrectPosition(position) ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(isCorrectPosition(position) ? OpenSourcebookTheme.Colors.success : Color(hex: 0xEF4444))
            }
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
        .frame(height: rowHeight)
        .background(draggingPosition == position ? OpenSourcebookTheme.Colors.primaryGhost : rowBackground(position))
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                .stroke(rowBorder(position), lineWidth: 1)
        )
        .shadow(color: .black.opacity(draggingPosition == position ? 0.12 : 0), radius: 6, x: 0, y: 3)
        .contentShape(Rectangle())
    }

    private func isCorrectPosition(_ position: Int) -> Bool {
        position < correctOrder.count && order[position] == correctOrder[position]
    }

    private func rowBackground(_ position: Int) -> Color {
        guard checked else { return OpenSourcebookTheme.Colors.surface }
        return isCorrectPosition(position) ? OpenSourcebookTheme.Colors.successSoft : Color(hex: 0xFEE2E2)
    }

    private func rowBorder(_ position: Int) -> Color {
        guard checked else { return OpenSourcebookTheme.Colors.border }
        return isCorrectPosition(position) ? OpenSourcebookTheme.Colors.success : Color(hex: 0xEF4444)
    }

    // MARK: Drag reordering

    private func dragGesture(for position: Int) -> some Gesture {
        DragGesture()
            .onChanged { value in
                if checked { checked = false }
                if draggingPosition == nil {
                    draggingPosition = position
                    appliedSteps = 0
                }
                guard let current = draggingPosition else { return }
                let targetSteps = Int((value.translation.height / rowHeight).rounded())
                var from = current
                while targetSteps > appliedSteps, from < order.count - 1 {
                    order.swapAt(from, from + 1)
                    from += 1
                    appliedSteps += 1
                }
                while targetSteps < appliedSteps, from > 0 {
                    order.swapAt(from, from - 1)
                    from -= 1
                    appliedSteps -= 1
                }
                draggingPosition = from
                dragRemainder = value.translation.height - CGFloat(appliedSteps) * rowHeight
            }
            .onEnded { _ in
                draggingPosition = nil
                appliedSteps = 0
                dragRemainder = 0
            }
    }
}
