import SwiftUI

/// Small colored pill used for tags on cards and detail screens.
struct TagPill: View {

    enum Tint {
        case primary, success, accent, info, neutral

        var foreground: Color {
            switch self {
            case .primary: return OpenSourcebookTheme.Colors.primary
            case .success: return OpenSourcebookTheme.Colors.successText
            case .accent: return OpenSourcebookTheme.Colors.accentText
            case .info: return OpenSourcebookTheme.Colors.info
            case .neutral: return OpenSourcebookTheme.Colors.muted
            }
        }

        var background: Color {
            switch self {
            case .primary: return OpenSourcebookTheme.Colors.primarySoft
            case .success: return OpenSourcebookTheme.Colors.successSoft
            case .accent: return OpenSourcebookTheme.Colors.accentSoft
            case .info: return OpenSourcebookTheme.Colors.infoSoft
            case .neutral: return OpenSourcebookTheme.Colors.fill
            }
        }
    }

    let text: String
    let tint: Tint

    init(_ text: String, tint: Tint = .primary) {
        self.text = text
        self.tint = tint
    }

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(tint.foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background(tint.background)
            .clipShape(Capsule())
    }
}

#Preview {
    HStack {
        TagPill("ML")
        TagPill("Done", tint: .success)
        TagPill("Draft", tint: .accent)
        TagPill("New", tint: .info)
        TagPill("Misc", tint: .neutral)
    }
    .padding()
}
