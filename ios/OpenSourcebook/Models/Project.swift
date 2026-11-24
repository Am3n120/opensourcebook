import SwiftUI

/// A project: the unit sources and outputs live in (VISION.md "Projects,
/// singles, categories"). Replaces the August app's Collection. The color is
/// stored as a hex value, not a `Color`, so it persists and round-trips.
struct Project: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var title: String
    /// SF Symbol name.
    var icon: String
    var colorHex: UInt32
    /// Automatic category (VISION.md). Empty slot in Phase 1: nothing fills
    /// it yet, but Home already groups by it when present.
    var category: String?
    var createdAt: Date
    var updatedAt: Date

    init(
        id: String = UUID().uuidString,
        title: String,
        icon: String = "folder",
        colorHex: UInt32 = 0x6C5CE7,
        category: String? = nil,
        createdAt: Date = .now,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.icon = icon
        self.colorHex = colorHex
        self.category = category
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    var color: Color { Color(hex: colorHex) }

    /// The palette offered when creating a project.
    static let paletteHex: [UInt32] = [
        0x6C5CE7, 0x2563EB, 0x0EA5E9, 0x14B8A6, 0x22C55E,
        0xFFB020, 0xEF4444, 0xEC4899, 0x8B5CF6, 0x64748B
    ]
}
