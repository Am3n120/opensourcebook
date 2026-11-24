import Foundation
#if os(iOS)
import UIKit
#endif

/// Light haptics wrapper. Every call checks the user's "Haptics" setting, so
/// the toggle in Profile actually does something.
enum OpenSourcebookHaptics {
    /// UserDefaults key shared with the Profile settings screen.
    static let enabledKey = "hapticsEnabled"

    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    static func lightImpact() {
        impact(.light)
    }

    /// Commit-level feedback (finishing a check, swiping to the next output).
    static func mediumImpact() {
        impact(.medium)
    }

    private static func impact(_ style: FeedbackStyle) {
        guard isEnabled else { return }
        #if os(iOS)
        UIImpactFeedbackGenerator(style: style).impactOccurred()
        #endif
    }

    #if os(iOS)
    private typealias FeedbackStyle = UIImpactFeedbackGenerator.FeedbackStyle
    #else
    private enum FeedbackStyle { case light, medium }
    #endif
}
