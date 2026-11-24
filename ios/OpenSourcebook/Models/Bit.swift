import Foundation

/// One screen of a byte (DECISIONS.md #34). A byte is an ordered list of
/// bits, swiped sideways; a bit never exists alone. Shape from
/// `engine/docs/byte.md` (schema version 2).
struct Bit: Codable, Identifiable, Sendable, Equatable, Hashable {
    /// Unique within the byte; opaque to the phone.
    let id: String
    /// What sort of screen it is ("plain", "chart", "flip", ...). Open: a kind
    /// this build doesn't know is drawn as its blocks.
    var kind: String
    /// The part of the byte the bit belongs to, when the engine names one.
    var section: String?
    var blocks: [Block]
    /// Where the bit's content came from, kept as sent so nothing is lost
    /// before the phone draws citations.
    var cites: [JSONValue]

    init(id: String, kind: String = "plain", section: String? = nil, blocks: [Block], cites: [JSONValue] = []) {
        self.id = id
        self.kind = kind
        self.section = section
        self.blocks = blocks
        self.cites = cites
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, section, blocks, cites
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "plain"
        section = try c.decodeIfPresent(String.self, forKey: .section)
        blocks = try c.decodeIfPresent([Block].self, forKey: .blocks) ?? []
        cites = (try? c.decodeIfPresent([JSONValue].self, forKey: .cites)) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(section, forKey: .section)
        try c.encode(blocks, forKey: .blocks)
        try c.encode(cites, forKey: .cites)
    }

    /// False when none of its blocks can be drawn by this build; the player
    /// then says so instead of showing an empty screen.
    var isDrawable: Bool {
        blocks.contains { if case .unsupported = $0 { return false } else { return true } }
    }
}
