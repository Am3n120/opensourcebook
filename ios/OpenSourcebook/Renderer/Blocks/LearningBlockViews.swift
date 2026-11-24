import SwiftUI

/// Interactive learning renderers: flashcards (flip deck), fill-in-the-blank
/// (tap-to-answer / tap-to-reveal) and matching (pair the columns). All state
/// is local to each view, following `QuizBlockView` / `OrderExerciseBlockView`.

// MARK: - Flashcards

/// Flip deck: one card at a time, tap flips it with a 3D rotation plus a
/// subtle scale bounce; chevrons page through the deck with an "n / total"
/// progress label.
struct FlashcardsBlockView: View {
    let cards: [Flashcard]

    /// Drives the animated 3D rotation.
    @State private var isFlipped = false
    /// Which face is visible — swapped halfway through the flip, when the card
    /// is edge-on, so the incoming face never appears mirrored.
    @State private var showBack = false
    @State private var index = 0
    @State private var bounceScale: CGFloat = 1

    private var safeIndex: Int {
        cards.isEmpty ? 0 : min(max(index, 0), cards.count - 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Image(systemName: "rectangle.stack.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                Text("Flashcards")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .fontWeight(.bold)
                    .tracking(1.2)
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
            }

            if !cards.isEmpty {
                Button {
                    flip()
                } label: {
                    ZStack {
                        face(text: cards[safeIndex].front, label: "Front",
                             background: OpenSourcebookTheme.Colors.primaryGhost)
                            .opacity(showBack ? 0 : 1)
                        face(text: cards[safeIndex].back, label: "Back",
                             background: OpenSourcebookTheme.Colors.primarySoft)
                            .opacity(showBack ? 1 : 0)
                            .rotation3DEffect(.degrees(180), axis: (x: 0, y: 1, z: 0))
                    }
                    .rotation3DEffect(.degrees(isFlipped ? 180 : 0), axis: (x: 0, y: 1, z: 0), perspective: 0.55)
                    .scaleEffect(bounceScale)
                }
                .buttonStyle(.plain)

                HStack {
                    navButton(systemName: "chevron.left", enabled: safeIndex > 0) {
                        go(to: safeIndex - 1)
                    }
                    Spacer()
                    Text("\(safeIndex + 1) / \(cards.count)")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    Spacer()
                    navButton(systemName: "chevron.right", enabled: safeIndex < cards.count - 1) {
                        go(to: safeIndex + 1)
                    }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }

    // MARK: Card face & nav

    private func face(text: String, label: String, background: Color) -> some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            Text(label.uppercased())
                .font(OpenSourcebookTheme.Fonts.label)
                .tracking(1.2)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            Text(text)
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .frame(maxWidth: .infinity, minHeight: 160)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                .stroke(OpenSourcebookTheme.Colors.border, lineWidth: 1)
        )
    }

    private func navButton(systemName: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(enabled ? OpenSourcebookTheme.Colors.primary : OpenSourcebookTheme.Colors.border)
                .frame(width: 34, height: 34)
                .background(OpenSourcebookTheme.Colors.fill)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    // MARK: Flip & navigation

    private func flip() {
        let cardAtFlip = safeIndex
        withAnimation(OpenSourcebookTheme.Motion.standard) { isFlipped.toggle() }
        // Swap faces when the card is edge-on, halfway through the rotation.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.17) {
            guard safeIndex == cardAtFlip else { return }
            showBack.toggle()
        }
        withAnimation(.spring(response: 0.3, dampingFraction: 0.45)) { bounceScale = 1.04 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) { bounceScale = 1 }
        }
        OpenSourcebookHaptics.lightImpact()
    }

    private func go(to newIndex: Int) {
        // Reset instantly (no animation) so the incoming card starts face-up.
        isFlipped = false
        showBack = false
        bounceScale = 1
        withAnimation(OpenSourcebookTheme.Motion.quick) { index = newIndex }
        OpenSourcebookHaptics.lightImpact()
    }
}

// MARK: - Fill in the blank

/// Complete-the-sentence exercise. Each `___` gap in `prompt` renders as a
/// highlighted blank; with `options` it behaves like `QuizBlockView` (tap →
/// correct turns green, wrong turns red and reveals the answer), without
/// options the prompt itself is tap-to-reveal. `explanation` fades in once
/// answered.
struct FillInBlankBlockView: View {
    let prompt: String
    let answer: String
    let options: [String]?
    let explanation: String?

    @State private var selectedIndex: Int?
    @State private var revealed = false

    private var answered: Bool { selectedIndex != nil || revealed }
    private var correctIndex: Int { options?.firstIndex(of: answer) ?? -1 }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                Text("Fill in the blank")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .fontWeight(.bold)
                    .tracking(1.2)
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
            }

            if options == nil {
                Button {
                    guard !revealed else { return }
                    withAnimation(OpenSourcebookTheme.Motion.quick) { revealed = true }
                    OpenSourcebookHaptics.lightImpact()
                } label: {
                    promptText
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                promptText
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let options {
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
            }

            if answered, let explanation {
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

    // MARK: Prompt

    /// Prompt with every `___` gap replaced by a highlighted blank — or the
    /// revealed answer once answered.
    private var promptText: Text {
        let parts = prompt.components(separatedBy: "___")
        var text = Text(parts.first ?? prompt)
        for part in parts.dropFirst() {
            text = text
                + Text(answered ? answer : "______")
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(answered ? OpenSourcebookTheme.Colors.success : OpenSourcebookTheme.Colors.primary)
                + Text(part)
        }
        return text
    }

    // MARK: Styling helpers (quiz idiom)

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

// MARK: - Matching

/// Pairing exercise: left column in `pairs` order, right column scrambled
/// deterministically (seeded shuffle, stable across re-renders). Tap a left
/// tile then a right tile: a correct pair locks with a success tint +
/// checkmark, a wrong pick flashes red and deselects. Matching every pair
/// shows the "All matched!" completion state.
struct MatchingBlockView: View {
    let prompt: String?
    let pairs: [MatchingPair]

    @State private var selectedLeft: Int?
    @State private var matched: Set<Int> = []
    @State private var wrongLeft: Int?
    @State private var wrongRight: Int?

    /// Display order of the right column: a permutation of `pairs.indices`.
    private let rightOrder: [Int]

    init(prompt: String?, pairs: [MatchingPair]) {
        self.prompt = prompt
        self.pairs = pairs
        // Seeded Fisher–Yates so the scramble is deterministic.
        var order = Array(pairs.indices)
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        if order.count > 1 {
            for i in stride(from: order.count - 1, through: 1, by: -1) {
                state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                let j = Int(state >> 33) % (i + 1)
                order.swapAt(i, j)
            }
            // Never leave the right column in the solved order.
            if order == Array(order.indices) {
                order.append(order.removeFirst())
            }
        }
        rightOrder = order
    }

    private var allMatched: Bool { !pairs.isEmpty && matched.count == pairs.count }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                Text("Match the pairs")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .fontWeight(.bold)
                    .tracking(1.2)
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
            }

            if let prompt {
                Text(prompt)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.xs) {
                VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    ForEach(Array(pairs.enumerated()), id: \.offset) { index, pair in
                        leftTile(index: index, text: pair.left)
                    }
                }
                VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    ForEach(Array(rightOrder.enumerated()), id: \.offset) { _, pairIndex in
                        rightTile(pairIndex: pairIndex, text: pairs[pairIndex].right)
                    }
                }
            }

            if allMatched {
                HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(OpenSourcebookTheme.Colors.success)
                    Text("All matched!")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .fontWeight(.bold)
                        .tracking(1.2)
                        .foregroundStyle(OpenSourcebookTheme.Colors.successText)
                }
                .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
                .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
                .background(OpenSourcebookTheme.Colors.successSoft)
                .clipShape(Capsule())
                .transition(.opacity)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }

    // MARK: Tiles

    private func tileLabel(text: String, checkmark: Bool) -> some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            Text(text)
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if checkmark {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.success)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
    }

    private func leftTile(index: Int, text: String) -> some View {
        Button {
            tapLeft(index)
        } label: {
            tileLabel(text: text, checkmark: matched.contains(index))
                .background(leftBackground(index))
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                        .stroke(leftBorder(index), lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(matched.contains(index))
    }

    private func rightTile(pairIndex: Int, text: String) -> some View {
        Button {
            tapRight(pairIndex)
        } label: {
            tileLabel(text: text, checkmark: matched.contains(pairIndex))
                .background(rightBackground(pairIndex))
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                        .stroke(rightBorder(pairIndex), lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(matched.contains(pairIndex))
    }

    // MARK: Matching logic

    private func tapLeft(_ index: Int) {
        guard !matched.contains(index) else { return }
        withAnimation(OpenSourcebookTheme.Motion.quick) {
            selectedLeft = selectedLeft == index ? nil : index
        }
        OpenSourcebookHaptics.lightImpact()
    }

    private func tapRight(_ pairIndex: Int) {
        guard !matched.contains(pairIndex), let left = selectedLeft else { return }
        OpenSourcebookHaptics.lightImpact()
        if pairIndex == left {
            withAnimation(OpenSourcebookTheme.Motion.quick) {
                matched.insert(left)
                selectedLeft = nil
            }
        } else {
            // Flash red briefly, then deselect both tiles.
            withAnimation(OpenSourcebookTheme.Motion.quick) {
                wrongLeft = left
                wrongRight = pairIndex
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                withAnimation(OpenSourcebookTheme.Motion.quick) {
                    wrongLeft = nil
                    wrongRight = nil
                    selectedLeft = nil
                }
            }
        }
    }

    // MARK: Styling helpers

    private func leftBackground(_ index: Int) -> Color {
        if matched.contains(index) { return OpenSourcebookTheme.Colors.successSoft }
        if wrongLeft == index { return Color(hex: 0xFEE2E2) }
        if selectedLeft == index { return OpenSourcebookTheme.Colors.primarySoft }
        return OpenSourcebookTheme.Colors.surface
    }

    private func leftBorder(_ index: Int) -> Color {
        if matched.contains(index) { return OpenSourcebookTheme.Colors.success }
        if wrongLeft == index { return Color(hex: 0xEF4444) }
        if selectedLeft == index { return OpenSourcebookTheme.Colors.primary }
        return OpenSourcebookTheme.Colors.border
    }

    private func rightBackground(_ pairIndex: Int) -> Color {
        if matched.contains(pairIndex) { return OpenSourcebookTheme.Colors.successSoft }
        if wrongRight == pairIndex { return Color(hex: 0xFEE2E2) }
        return OpenSourcebookTheme.Colors.surface
    }

    private func rightBorder(_ pairIndex: Int) -> Color {
        if matched.contains(pairIndex) { return OpenSourcebookTheme.Colors.success }
        if wrongRight == pairIndex { return Color(hex: 0xEF4444) }
        return OpenSourcebookTheme.Colors.border
    }
}
