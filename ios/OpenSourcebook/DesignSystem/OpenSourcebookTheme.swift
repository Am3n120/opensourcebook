import SwiftUI

/// Central design tokens for Open Sourcebook.
/// Light palette only for now; a dark palette is a later token set, not a flag.
enum OpenSourcebookTheme {

    // MARK: - Colors

    enum Colors {
        /// Brand purple `#6C5CE7`.
        static let primary = Color(hex: 0x6C5CE7)
        /// Soft purple fill `#EFEDFC`.
        static let primarySoft = Color(hex: 0xEFEDFC)
        /// Faintest purple wash `#F7F6FE` (quote cards).
        static let primaryGhost = Color(hex: 0xF7F6FE)

        /// Green `#22C55E`.
        static let success = Color(hex: 0x22C55E)
        /// Soft green fill `#E9F9F0`.
        static let successSoft = Color(hex: 0xE9F9F0)
        /// Darker green for text on soft fills `#15803D`.
        static let successText = Color(hex: 0x15803D)

        /// Amber `#FFB020`.
        static let accent = Color(hex: 0xFFB020)
        /// Soft amber fill `#FFF6E6`.
        static let accentSoft = Color(hex: 0xFFF6E6)
        /// Darker amber for text on soft fills `#B45309`.
        static let accentText = Color(hex: 0xB45309)

        /// Blue `#2563EB`.
        static let info = Color(hex: 0x2563EB)
        /// Soft blue fill `#EBF1FE`.
        static let infoSoft = Color(hex: 0xEBF1FE)

        /// App background `#F7F7FA`.
        static let background = Color(hex: 0xF7F7FA)
        /// Card / sheet surface `#FFFFFF`.
        static let surface = Color.white
        /// Hairline border `#E5E7EB`.
        static let border = Color(hex: 0xE5E7EB)
        /// Neutral control fill (chips, search field) `#F1F2F6`.
        static let fill = Color(hex: 0xF1F2F6)
        /// Primary text `#0F172A`.
        static let text = Color(hex: 0x0F172A)
        /// Secondary text `#64748B`.
        static let muted = Color(hex: 0x64748B)

        /// Darker purple for text on soft purple fills `#5B4BD6`.
        static let primaryText = Color(hex: 0x5B4BD6)

        /// Red for errors and destructive text `#B42318`.
        static let danger = Color(hex: 0xB42318)
        /// Soft red fill `#FDE8E8`.
        static let dangerSoft = Color(hex: 0xFDE8E8)

        /// Teal `#0F766E`.
        static let teal = Color(hex: 0x0F766E)
        /// Soft teal fill `#E6F6F4`.
        static let tealSoft = Color(hex: 0xE6F6F4)

        /// Secondary text that passes contrast on fills `#556277`.
        static let mutedText = Color(hex: 0x556277)
    }

    // MARK: - Format colour slots

    /// The eight colour slots a format descriptor can name (`colorSlot` 1 to 8),
    /// indexed by slot and never by format. Mirrors `web/src/design/tokens.css`
    /// `--fmt-N-fg` / `--fmt-N-bg`. Slots 5 and 8 are neutral.
    enum FormatSlots {
        struct Pair: Equatable, Sendable {
            let color: Color
            let soft: Color
        }

        /// For a format without a slot, or an id nothing knows.
        static let neutral = Pair(color: Colors.mutedText, soft: Colors.fill)

        static let all: [Pair] = [
            Pair(color: Colors.danger, soft: Colors.dangerSoft),
            Pair(color: Colors.successText, soft: Colors.successSoft),
            Pair(color: Colors.accentText, soft: Colors.accentSoft),
            Pair(color: Colors.primaryText, soft: Colors.primarySoft),
            neutral,
            Pair(color: Colors.teal, soft: Colors.tealSoft),
            Pair(color: Colors.info, soft: Colors.infoSoft),
            neutral,
        ]

        /// The pair for `slot` (1 to 8); neutral for nil or out of range.
        static func pair(forSlot slot: Int?) -> Pair {
            guard let slot, all.indices.contains(slot - 1) else { return neutral }
            return all[slot - 1]
        }
    }

    // MARK: - Typography

    /// Inter-like scale from the board. Headings use tight tracking (-0.02em)
    /// — apply via the `tracking` values below or `.tracking()` on Text.
    enum Fonts {
        /// 40/44 heavy — marketing-scale headlines.
        static let display = Font.system(size: 40, weight: .heavy)
        /// 28/34 bold — screen titles.
        static let title = Font.system(size: 28, weight: .bold)
        /// 20/28 bold — section headings.
        static let heading = Font.system(size: 20, weight: .bold)
        /// 16/24 regular — body copy.
        static let body = Font.system(size: 16, weight: .regular)
        /// 16/24 semibold — emphasized body.
        static let bodySemibold = Font.system(size: 16, weight: .semibold)
        /// 13/18 medium — meta lines.
        static let caption = Font.system(size: 13, weight: .medium)
        /// 12/16 semibold — chips, pills, badges.
        static let label = Font.system(size: 12, weight: .semibold)

        /// Tracking for display/title/heading (-0.02em of a 28pt title ≈ -0.6).
        static let tightTracking: CGFloat = -0.5
    }

    // MARK: - Spacing

    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
        static let xxxl: CGFloat = 40
        static let huge: CGFloat = 64
    }

    // MARK: - Radius

    enum Radius {
        static let r4: CGFloat = 4
        static let r8: CGFloat = 8
        static let r12: CGFloat = 12
        static let r20: CGFloat = 20
        static let r24: CGFloat = 24
        static let pill: CGFloat = 999
    }

    // MARK: - Motion

    /// Board motion principles: 300–500ms ease, purposeful, 60fps.
    enum Motion {
        /// Standard transition, 350ms.
        static let standard = Animation.easeInOut(duration: 0.35)
        /// Quick feedback, 200ms (tab changes, chip selection).
        static let quick = Animation.easeOut(duration: 0.2)
        /// Gentle entrance, 500ms.
        static let gentle = Animation.easeInOut(duration: 0.5)
    }

    // MARK: - Shadows

    /// Card shadow: `0 1px 2 rgba(15,23,42,.05), 0 4px 14 rgba(15,23,42,.06)`.
    struct CardShadow: ViewModifier {
        func body(content: Content) -> some View {
            content
                .shadow(color: Color(hex: 0x0F172A).opacity(0.05), radius: 1, x: 0, y: 1)
                .shadow(color: Color(hex: 0x0F172A).opacity(0.06), radius: 7, x: 0, y: 4)
        }
    }

    /// Raised shadow for floating elements (FAB): `0 6px 16 rgba(0,0,0,.25)`.
    struct ElevatedShadow: ViewModifier {
        func body(content: Content) -> some View {
            content.shadow(color: .black.opacity(0.25), radius: 8, x: 0, y: 6)
        }
    }
}

// MARK: - View helpers

extension View {
    /// Applies the standard Open Sourcebook card shadow.
    func openSourcebookCardShadow() -> some View {
        modifier(OpenSourcebookTheme.CardShadow())
    }

    /// Applies the raised shadow used by floating elements (e.g. the + button).
    func openSourcebookElevatedShadow() -> some View {
        modifier(OpenSourcebookTheme.ElevatedShadow())
    }

    /// Standard card chrome: surface background, 20pt radius, hairline border, card shadow.
    func openSourcebookCardStyle(cornerRadius: CGFloat = OpenSourcebookTheme.Radius.r20) -> some View {
        background(OpenSourcebookTheme.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(OpenSourcebookTheme.Colors.border, lineWidth: 1)
            )
            .openSourcebookCardShadow()
    }
}

// MARK: - Color(hex:)

extension Color {
    /// Creates a color from a 0xRRGGBB value.
    init(hex: UInt32, opacity: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

