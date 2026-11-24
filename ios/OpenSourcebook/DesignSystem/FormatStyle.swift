import SwiftUI

/// How a format's badge looks: glyph, word and colours, all taken from its
/// descriptor. A format the catalog doesn't know gets the neutral style with
/// its raw id as the word, so it still lists instead of disappearing.
/// The word is shown as the descriptor writes it (lower case, like the web
/// badges); the phone does not change its case.
struct FormatStyle: Equatable, Sendable {
    let icon: String
    let label: String
    let color: Color
    let softColor: Color
    /// False for a format the catalog doesn't know.
    let isKnown: Bool

    init(descriptor: FormatDescriptor) {
        let slot = FormatPalette.colors(forSlot: descriptor.colorSlot)
        icon = FormatGlyphs.symbol(for: descriptor.icon)
        label = descriptor.label
        color = slot.color
        softColor = slot.soft
        isKnown = true
    }

    /// The neutral badge for an id no descriptor covers.
    init(unknown id: FormatID) {
        let neutral = FormatPalette.neutral
        icon = FormatGlyphs.neutral
        label = id.rawValue
        color = neutral.color
        softColor = neutral.soft
        isKnown = false
    }
}

extension FormatCatalog {
    func style(for id: FormatID) -> FormatStyle {
        descriptor(for: id).map(FormatStyle.init(descriptor:)) ?? FormatStyle(unknown: id)
    }
}

extension FormatID {
    /// The badge style from the live catalog.
    var style: FormatStyle { FormatRegistry.shared.catalog.style(for: self) }
}

/// Open Sourcebook's shared format icon names (engine `FormatDescriptor.icon`)
/// to SF Symbols. The one place the phone maps them.
enum FormatGlyphs {
    static let neutral = "square.dashed"

    private static let symbols: [String: String] = [
        "feed": "rectangle.stack.fill",
        "book": "doc.text",
        "play": "play.rectangle.fill",
        "check": "checkmark.circle.fill",
        "flip": "rectangle.on.rectangle.angled",
        "bulb": "lightbulb",
    ]

    static func symbol(for name: String) -> String {
        symbols[name] ?? neutral
    }
}

/// Resolves a descriptor's colour slot to colours; the slots live in
/// `OpenSourcebookTheme.FormatSlots`.
enum FormatPalette {
    typealias Pair = OpenSourcebookTheme.FormatSlots.Pair

    static var neutral: Pair { OpenSourcebookTheme.FormatSlots.neutral }

    /// The pair for `slot`; neutral for nil or a slot out of range.
    static func colors(forSlot slot: Int?) -> Pair {
        guard let slot, FormatDescriptor.colorSlots.contains(slot) else { return neutral }
        return OpenSourcebookTheme.FormatSlots.pair(forSlot: slot)
    }
}
