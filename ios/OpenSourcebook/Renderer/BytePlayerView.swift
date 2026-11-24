import SwiftUI

/// Plays a byte: its bits side by side, one per screen, swiped sideways
/// (DECISIONS.md #34, #36), with the position shown under them. Old pages
/// arrive already cut into bits (`Output.screens`). Remembers which bit was
/// on screen.
struct BytePlayerView: View {
    @EnvironmentObject private var store: OutputStore
    let output: Output

    @State private var bitIndex: Int?

    var body: some View {
        let bits = output.screens
        if bits.isEmpty {
            EmptyStateView(icon: "square.dashed", title: output.title,
                           message: "This byte has no bits to show.")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        ForEach(Array(bits.enumerated()), id: \.offset) { index, bit in
                            BitView(bit: bit)
                                .containerRelativeFrame([.horizontal, .vertical])
                                .id(index)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
                .scrollPosition(id: $bitIndex)
                .accessibilityIdentifier("byte-bits-\(output.id.uuidString)")

                BitPositionView(count: bits.count, current: bitIndex ?? 0)
                    .accessibilityIdentifier("bit-position-\(output.id.uuidString)")
                    .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
            }
            .onAppear {
                let saved = PlayerPaging.clamped(store.meta(for: output.id).readPosition, count: bits.count)
                if bitIndex == nil { bitIndex = saved }
            }
            .onChange(of: bitIndex) { _, index in
                if let index { store.saveReadPosition(index, for: output.id) }
            }
        }
    }
}

/// One bit on one screen, with where its claims come from under it. A bit
/// is cut to fit (engine/docs/byte.md's budget); if a large text size still
/// makes it overflow, it scrolls inside itself, and only then.
struct BitView: View {
    let bit: Bit

    var body: some View {
        if bit.isDrawable {
            ViewThatFits(in: .vertical) {
                canvas
                ScrollView(.vertical) { canvas }
                    .scrollIndicators(.hidden)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            EmptyStateView(icon: "square.dashed", title: "Can't show this bit",
                           message: "It needs a newer version of Open Sourcebook.")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var canvas: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.lg) {
            if let section = bit.section {
                Text(section)
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            ForEach(Array(bit.blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
            CiteChips(cites: bit.cites)
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
        .padding(.vertical, OpenSourcebookTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "2 of 5" under a byte: dots for a short byte, a count for a long one.
struct BitPositionView: View {
    let count: Int
    let current: Int

    private static let maxDots = 12

    var body: some View {
        Group {
            if count <= 1 {
                EmptyView()
            } else if count <= Self.maxDots {
                HStack(spacing: 6) {
                    ForEach(0..<count, id: \.self) { index in
                        Capsule()
                            .fill(index == current ? OpenSourcebookTheme.Colors.accent : OpenSourcebookTheme.Colors.border)
                            .frame(width: index == current ? 16 : 6, height: 6)
                    }
                }
                .animation(OpenSourcebookTheme.Motion.standard, value: current)
            } else {
                Text("\(current + 1) of \(count)")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
        .frame(height: count > 1 ? 16 : 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Bit \(current + 1) of \(count)")
    }
}
