import Foundation
@testable import OpenSourcebook

/// Builders shared by the unit tests. Dates are whole seconds so they survive
/// the ISO 8601 round trip used for persistence.
enum Fixtures {
    static let base = Date(timeIntervalSince1970: 1_700_000_000)

    static func date(_ minutes: Int) -> Date {
        base.addingTimeInterval(TimeInterval(minutes * 60))
    }

    static func output(
        _ title: String,
        minutes: Int = 0,
        type: FormatID = "byte",
        tags: [String] = [],
        subtitle: String = "",
        domain: String? = nil,
        projectID: String? = nil,
        plan: PlanPosition? = nil,
        id: UUID = UUID()
    ) -> Output {
        Output(
            id: id,
            type: type,
            title: title,
            subtitle: subtitle,
            sourceDomain: domain,
            createdAt: date(minutes),
            tags: tags,
            projectID: projectID,
            plan: plan
        )
    }

    static func position(_ planID: String, level: Int, ord: Int) -> PlanPosition {
        PlanPosition(planID: planID, nodeID: "\(planID)-\(level)-\(ord)", level: level, ord: ord)
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder().decode(type, from: Data(json.utf8))
    }
}
