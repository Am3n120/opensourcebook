import SwiftUI

/// What kind of thing an output was made from. Secondary to the output's format on
/// badges (DECISIONS.md #4); still drives the card placeholder art and the
/// source line. Raw values match the engine's `type` field.
enum SourceKind: String, Codable, Sendable, CaseIterable, Identifiable {
    case quote, video, paper, recipe, spreadsheet, thread, podcast
    case travel, meeting, note, article, image, link, other

    var id: String { rawValue }

    /// The visual identity (icon, colors, label) for this source kind.
    var style: SourceKindStyle { SourceKindStyle.style(for: self) }
}


/// SF Symbol, colors, gradient and display label for a `SourceKind`.
struct SourceKindStyle: Sendable {
    let icon: String
    let label: String
    let color: Color
    /// Tinted fill behind icons/badges.
    let softColor: Color
    /// Media-placeholder gradient (top → bottom).
    let gradient: [Color]

    static func style(for type: SourceKind) -> SourceKindStyle {
        switch type {
        case .quote:
            return SourceKindStyle(icon: "text.quote", label: "Quote",
                                 color: OpenSourcebookTheme.Colors.primary, softColor: OpenSourcebookTheme.Colors.primarySoft,
                                 gradient: [Color(hex: 0x8B5CF6), Color(hex: 0x6C5CE7)])
        case .video:
            return SourceKindStyle(icon: "play.rectangle.fill", label: "Video",
                                 color: OpenSourcebookTheme.Colors.danger, softColor: OpenSourcebookTheme.Colors.dangerSoft,
                                 gradient: [Color(hex: 0x1E293B), Color(hex: 0x0F172A)])
        case .paper:
            return SourceKindStyle(icon: "doc.richtext", label: "Paper",
                                 color: OpenSourcebookTheme.Colors.muted, softColor: OpenSourcebookTheme.Colors.fill,
                                 gradient: [Color(hex: 0x94A3B8), Color(hex: 0x64748B)])
        case .recipe:
            return SourceKindStyle(icon: "fork.knife", label: "Recipe",
                                 color: OpenSourcebookTheme.Colors.accent, softColor: OpenSourcebookTheme.Colors.accentSoft,
                                 gradient: [Color(hex: 0xF6C453), Color(hex: 0xB4671F)])
        case .spreadsheet:
            return SourceKindStyle(icon: "tablecells", label: "Spreadsheet",
                                 color: OpenSourcebookTheme.Colors.success, softColor: OpenSourcebookTheme.Colors.successSoft,
                                 gradient: [Color(hex: 0x34D399), Color(hex: 0x059669)])
        case .thread:
            return SourceKindStyle(icon: "bubble.left.and.bubble.right", label: "Thread",
                                 color: OpenSourcebookTheme.Colors.info, softColor: OpenSourcebookTheme.Colors.infoSoft,
                                 gradient: [Color(hex: 0x60A5FA), Color(hex: 0x2563EB)])
        case .podcast:
            return SourceKindStyle(icon: "waveform", label: "Podcast",
                                 color: Color(hex: 0x8B5CF6), softColor: OpenSourcebookTheme.Colors.primarySoft,
                                 gradient: [Color(hex: 0x8B5CF6), Color(hex: 0x6C5CE7)])
        case .travel:
            return SourceKindStyle(icon: "airplane", label: "Travel",
                                 color: Color(hex: 0x0EA5E9), softColor: Color(hex: 0xE0F2FE),
                                 gradient: [Color(hex: 0x7DD3FC), Color(hex: 0x059669)])
        case .meeting:
            return SourceKindStyle(icon: "person.2", label: "Meeting",
                                 color: OpenSourcebookTheme.Colors.primary, softColor: OpenSourcebookTheme.Colors.primarySoft,
                                 gradient: [Color(hex: 0xA78BFA), Color(hex: 0x6C5CE7)])
        case .note:
            return SourceKindStyle(icon: "note.text", label: "Note",
                                 color: OpenSourcebookTheme.Colors.accentText, softColor: OpenSourcebookTheme.Colors.accentSoft,
                                 gradient: [Color(hex: 0xFDE68A), Color(hex: 0xF59E0B)])
        case .article:
            return SourceKindStyle(icon: "doc.text", label: "Article",
                                 color: OpenSourcebookTheme.Colors.info, softColor: OpenSourcebookTheme.Colors.infoSoft,
                                 gradient: [Color(hex: 0x0F172A), Color(hex: 0x312E81)])
        case .image:
            return SourceKindStyle(icon: "photo", label: "Image",
                                 color: Color(hex: 0xEC4899), softColor: Color(hex: 0xFCE7F3),
                                 gradient: [Color(hex: 0xBAE6FD), Color(hex: 0x166534)])
        case .link:
            return SourceKindStyle(icon: "link", label: "Link",
                                 color: Color(hex: 0x14B8A6), softColor: Color(hex: 0xCCFBF1),
                                 gradient: [Color(hex: 0x2DD4BF), Color(hex: 0x0F766E)])
        case .other:
            return SourceKindStyle(icon: "square.grid.2x2", label: "Other",
                                 color: OpenSourcebookTheme.Colors.muted, softColor: OpenSourcebookTheme.Colors.fill,
                                 gradient: [Color(hex: 0xCBD5E1), Color(hex: 0x94A3B8)])
        }
    }
}

