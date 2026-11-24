import Foundation

/// A format's id: "byte", "quiz" or "video" (DECISIONS.md #33). Stored rows
/// may carry older ids ("bits", "read", "check"), which the catalog resolves,
/// and an id this build has never heard of still decodes (DECISIONS.md #24). Stored as the bare string, so outputs and plan
/// items saved before formats were open read back unchanged.
struct FormatID: RawRepresentable, Hashable, Codable, Sendable, Identifiable,
                 ExpressibleByStringLiteral, CustomStringConvertible {
    let rawValue: String

    init(rawValue: String) { self.rawValue = rawValue }
    init(_ rawValue: String) { self.rawValue = rawValue }
    init(stringLiteral value: String) { self.rawValue = value }

    var id: String { rawValue }
    var description: String { rawValue }
}

/// What a format says about itself: one entry of the engine's
/// `GET /v1/formats`. The phone never lists formats of its own; it shows
/// whatever this says (label, colour slot, icon) and skips what it can't.
struct FormatDescriptor: Equatable, Sendable, Identifiable {
    let id: FormatID
    /// The word on screen, lower case as in docs/GLOSSARY.md.
    let label: String
    /// Which neutral format colour slot the badge uses, 1 to 8. Nil when the
    /// engine sent a slot outside that range; the badge is then neutral.
    let colorSlot: Int?
    /// A name from Open Sourcebook's shared icon set ("feed", "book", ...), mapped to a
    /// glyph in one place on the phone.
    let icon: String
    /// Older ids stored rows may carry; they resolve to this format.
    let aliases: [FormatID]
    /// Settings fields of kinds this build knows, in the engine's order.
    let settings: [FormatSettingField]
    let defaults: [String: JSONValue]
    /// True when an engine can make this format now.
    let isReady: Bool

    static let colorSlots = 1...8

    /// Fields a form shows: Open Sourcebook sets hidden ones itself.
    var visibleSettings: [FormatSettingField] { settings.filter { !$0.isHidden } }
}

extension FormatDescriptor: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, label, colorSlot, icon, aliases, settings, defaults, ready
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(FormatID.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? id.rawValue
        let slot = try? c.decodeIfPresent(Int.self, forKey: .colorSlot)
        colorSlot = slot.flatMap { Self.colorSlots.contains($0) ? $0 : nil }
        icon = (try? c.decodeIfPresent(String.self, forKey: .icon)) ?? ""
        aliases = (try? c.decodeIfPresent([FormatID].self, forKey: .aliases)) ?? []
        settings = (try? c.decodeIfPresent(LossyList<FormatSettingField>.self, forKey: .settings))?.elements ?? []
        defaults = (try? c.decodeIfPresent([String: JSONValue].self, forKey: .defaults)) ?? [:]
        isReady = (try? c.decodeIfPresent(Bool.self, forKey: .ready)) ?? false
    }
}

/// One setting a format declares. Kinds this build doesn't know fail to
/// decode and are left out of the descriptor; the engine checks values.
struct FormatSettingField: Equatable, Sendable, Decodable {
    struct Option: Equatable, Sendable, Decodable {
        let value: String
        let label: String
    }

    enum Kind: Equatable, Sendable {
        case choice(options: [Option])
        case number(min: Double?, max: Double?, step: Double?, unit: String?)
        case toggle
        case text(maxLength: Int?)
        case textList(maxItems: Int?, maxLength: Int?)
    }

    let key: String
    let label: String
    let help: String?
    /// Set by Open Sourcebook itself (quick mode, the planner); forms don't show it.
    let isHidden: Bool
    let kind: Kind

    private enum CodingKeys: String, CodingKey {
        case key, label, help, hidden, kind, options, min, max, step, unit, maxLength, maxItems
    }

    struct UnknownKind: Error {
        let kind: String
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        help = try c.decodeIfPresent(String.self, forKey: .help)
        isHidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
        let kindName = try c.decode(String.self, forKey: .kind)
        switch kindName {
        case "choice":
            kind = .choice(options: try c.decode([Option].self, forKey: .options))
        case "number":
            kind = .number(
                min: try c.decodeIfPresent(Double.self, forKey: .min),
                max: try c.decodeIfPresent(Double.self, forKey: .max),
                step: try c.decodeIfPresent(Double.self, forKey: .step),
                unit: try c.decodeIfPresent(String.self, forKey: .unit)
            )
        case "toggle":
            kind = .toggle
        case "text":
            kind = .text(maxLength: try c.decodeIfPresent(Int.self, forKey: .maxLength))
        case "textList":
            kind = .textList(
                maxItems: try c.decodeIfPresent(Int.self, forKey: .maxItems),
                maxLength: try c.decodeIfPresent(Int.self, forKey: .maxLength)
            )
        default:
            throw UnknownKind(kind: kindName)
        }
    }
}

/// A JSON array decoded element by element: entries that don't decode are
/// skipped instead of failing the whole list.
struct LossyList<Element: Decodable>: Decodable {
    let elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var elements: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                elements.append(element)
            } else {
                _ = try container.decode(JSONValue.self)
            }
        }
        self.elements = elements
    }
}
