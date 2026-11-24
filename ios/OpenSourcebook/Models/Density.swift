import Foundation

/// How much content a byte carries. Decided by the plan (or quick
/// mode), never picked by the user at capture (DECISIONS.md #3). Raw values
/// match the engine's `byteDepth`.
enum Density: String, Codable, CaseIterable, Hashable, Sendable {
    case saveOnly, tiny, light, medium, deep, veryDeep

    var label: String {
        switch self {
        case .saveOnly: return "Saved only"
        case .tiny: return "Tiny"
        case .light: return "Light"
        case .medium: return "Medium"
        case .deep: return "Deep"
        case .veryDeep: return "Very deep"
        }
    }
}
