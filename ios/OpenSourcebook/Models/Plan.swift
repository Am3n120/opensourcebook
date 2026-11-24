import Foundation

/// Where an output sits in the plan that produced it. Nil on singles and on
/// anything captured before plans existed. Mirrors the engine's `plan_nodes`
/// columns (`engine/migrations/0004_studio.sql`).
struct PlanPosition: Codable, Sendable, Equatable, Hashable {
    var planID: String
    var nodeID: String
    /// Stage in the plan. Outputs on one level don't assume each other.
    var level: Int
    /// Position within the level.
    var ord: Int
}

/// Generation state of one plan item (`Item.status` in engine/docs/api.md).
/// Unknown values from a newer engine decode as `.unknown` instead of
/// failing the whole plan.
enum PlanNodeStatus: String, Codable, Sendable {
    case pending, queued, running, done, failed, skipped, cancelled, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlanNodeStatus(rawValue: raw) ?? .unknown
    }

    var isActive: Bool { self == .queued || self == .running }
}
