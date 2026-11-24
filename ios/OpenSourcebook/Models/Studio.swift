import Foundation

// The engine's Studio shapes, as `engine/docs/api.md` writes them: projects,
// plans with their items, made things (outputs) and sources. The phone reads
// them and never edits them (DECISIONS.md #10). Decoding is tolerant: unknown
// fields are ignored, optional fields may be missing, and a format id or a
// status this build has never heard of is kept as sent.

/// A project on the engine (`Project` in api.md). `category` is the screen
/// word *topic*.
struct StudioProject: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var title: String
    var icon: String?
    var colorHex: UInt32?
    var category: String?
    var createdAt: Date?
    var updatedAt: Date?
    var archivedAt: Date?
}

/// `{ total, done }` over the items of a plan that can still be done.
struct StudioCounts: Codable, Sendable, Equatable, Hashable {
    var total: Int
    var done: Int
}

/// What a plan is doing. Open: a status a newer engine adds is kept raw.
struct StudioPlanStatus: RawRepresentable, Codable, Sendable, Hashable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let draft = StudioPlanStatus(rawValue: "draft")
    static let approved = StudioPlanStatus(rawValue: "approved")
    static let running = StudioPlanStatus(rawValue: "running")
    static let done = StudioPlanStatus(rawValue: "done")
    static let failed = StudioPlanStatus(rawValue: "failed")
    static let cancelled = StudioPlanStatus(rawValue: "cancelled")

    /// True before Start: nothing is made yet.
    var isBeforeStart: Bool { self == .draft || self == .approved }

    /// The word on screen.
    var label: String {
        switch self {
        case .draft, .approved: "Not started"
        case .running: "Being made"
        case .done: "Made"
        case .failed: "Stopped with errors"
        case .cancelled: "Cancelled"
        default: rawValue.capitalized
        }
    }
}

/// A plan (`Plan` in api.md). In a project's list it also carries `counts`.
struct StudioPlan: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var projectId: String
    var title: String
    var version: Int?
    var status: StudioPlanStatus
    var budgetUsd: Double?
    var chatId: String?
    var createdAt: Date?
    var updatedAt: Date?
    var kickedOffAt: Date?
    var counts: StudioCounts?
}

/// A labelled stage.
struct StudioStage: Codable, Sendable, Equatable, Hashable {
    var level: Int
    var label: String?
}

/// An undecided "ask me" branch: what the plan asks the person.
struct StudioAsking: Codable, Sendable, Equatable, Hashable {
    var question: String?
}

/// One item of a plan (`Item` in api.md): a `plan_nodes` row with its
/// progress. `type` is the format id as the engine serves it.
struct StudioItem: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var parentId: String?
    var level: Int
    var ord: Int
    var type: FormatID
    var title: String
    var prompt: String?
    var condition: JSONValue?
    var enabled: Bool
    var estCostUsd: Double?
    var status: PlanNodeStatus
    var outputId: String?
    var done: Bool
    var doneAt: Date?
    var result: JSONValue?
    var asking: StudioAsking?

    init(id: String, parentId: String? = nil, level: Int = 0, ord: Int = 0, type: FormatID, title: String,
         prompt: String? = nil, condition: JSONValue? = nil, enabled: Bool = true, estCostUsd: Double? = nil,
         status: PlanNodeStatus = .pending, outputId: String? = nil, done: Bool = false, doneAt: Date? = nil,
         result: JSONValue? = nil, asking: StudioAsking? = nil) {
        self.id = id
        self.parentId = parentId
        self.level = level
        self.ord = ord
        self.type = type
        self.title = title
        self.prompt = prompt
        self.condition = condition
        self.enabled = enabled
        self.estCostUsd = estCostUsd
        self.status = status
        self.outputId = outputId
        self.done = done
        self.doneAt = doneAt
        self.result = result
        self.asking = asking
    }

    private enum CodingKeys: String, CodingKey {
        case id, parentId, level, ord, type, title, prompt, condition, enabled, estCostUsd
        case status, outputId, done, doneAt, result, asking
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        level = try c.decodeIfPresent(Int.self, forKey: .level) ?? 0
        ord = try c.decodeIfPresent(Int.self, forKey: .ord) ?? 0
        type = try c.decode(FormatID.self, forKey: .type)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
        condition = try c.decodeIfPresent(JSONValue.self, forKey: .condition)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        estCostUsd = try c.decodeIfPresent(Double.self, forKey: .estCostUsd)
        status = try c.decodeIfPresent(PlanNodeStatus.self, forKey: .status) ?? .unknown
        outputId = try c.decodeIfPresent(String.self, forKey: .outputId)
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        doneAt = try? c.decodeIfPresent(Date.self, forKey: .doneAt)
        result = try c.decodeIfPresent(JSONValue.self, forKey: .result)
        asking = try? c.decodeIfPresent(StudioAsking.self, forKey: .asking)
    }

    /// The output id as the phone keys outputs; nil when the engine's id is
    /// not a UUID.
    var outputUUID: UUID? { outputId.flatMap(UUID.init(uuidString:)) }
}

/// What every plan read returns (`Plan view` in api.md). Edges and issues
/// are for editing on the web; the phone does not read them.
struct StudioPlanView: Codable, Sendable, Equatable, Hashable {
    var plan: StudioPlan
    var stages: [StudioStage]
    var items: [StudioItem]
    var counts: StudioCounts?
    var estimateUsd: Double?

    init(plan: StudioPlan, stages: [StudioStage] = [], items: [StudioItem], counts: StudioCounts? = nil, estimateUsd: Double? = nil) {
        self.plan = plan
        self.stages = stages
        self.items = items
        self.counts = counts
        self.estimateUsd = estimateUsd
    }

    private enum CodingKeys: String, CodingKey { case plan, stages, items, counts, estimateUsd }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        plan = try c.decode(StudioPlan.self, forKey: .plan)
        stages = (try? c.decodeIfPresent(LossyList<StudioStage>.self, forKey: .stages)?.elements) ?? []
        items = try c.decodeIfPresent(LossyList<StudioItem>.self, forKey: .items)?.elements ?? []
        counts = try? c.decodeIfPresent(StudioCounts.self, forKey: .counts)
        estimateUsd = try c.decodeIfPresent(Double.self, forKey: .estimateUsd)
    }
}

/// A made thing in a list (`Output (in lists)` in api.md): no payload.
struct StudioOutputSummary: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var type: FormatID
    var title: String
    var summary: String?
    var projectId: String?
    var planId: String?
    var itemId: String?
    var schemaVersion: Int?
    var costUsd: Double?
    var createdAt: Date?
    var updatedAt: Date?

    var uuid: UUID? { UUID(uuidString: id) }
}

/// A source used by an item or an output, with the range it was limited to.
struct StudioSourceRef: Codable, Sendable, Equatable, Hashable {
    var sourceId: String
    var range: SourceLocator?
}

/// A made thing with everything stored when it was made (`Output (full)`).
/// `payload` is the format's own shape (a byte is `engine/docs/byte.md`).
struct StudioOutput: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var type: FormatID
    var title: String
    var summary: String?
    var projectId: String?
    var planId: String?
    var itemId: String?
    var schemaVersion: Int?
    var createdAt: Date?
    var payload: JSONValue?
    var sources: [StudioSourceRef]?
}

/// A source in a project (`Source (in lists)` in api.md).
struct StudioSource: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var projectId: String?
    var kind: String?
    var title: String?
    var url: String?
    var status: String?
    var createdAt: Date?
}

/// `GET /v1/sources/:id`: the source and its extracted text. The phone uses
/// the text to show a cited passage in its place.
struct StudioSourceDetail: Codable, Sendable, Equatable, Hashable {
    struct Extraction: Codable, Sendable, Equatable, Hashable {
        var status: String?
        var title: String?
        var text: String?
    }

    var source: StudioSource
    var extraction: Extraction?

    /// The name to show: the source's own title, else the extracted one.
    var displayTitle: String? {
        [source.title, extraction?.title].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }
}

/// Where in a source (`SourceLocator` in api.md). All fields optional; an
/// unknown field is ignored.
struct SourceLocator: Codable, Sendable, Equatable, Hashable {
    var page: Int?
    var endPage: Int?
    var slide: Int?
    var endSlide: Int?
    var startMs: Int?
    var endMs: Int?
    var charStart: Int?
    var charEnd: Int?
    var cell: String?

    init(page: Int? = nil, endPage: Int? = nil, slide: Int? = nil, endSlide: Int? = nil,
         startMs: Int? = nil, endMs: Int? = nil, charStart: Int? = nil, charEnd: Int? = nil, cell: String? = nil) {
        self.page = page
        self.endPage = endPage
        self.slide = slide
        self.endSlide = endSlide
        self.startMs = startMs
        self.endMs = endMs
        self.charStart = charStart
        self.charEnd = charEnd
        self.cell = cell
    }

    private enum CodingKeys: String, CodingKey {
        case page, endPage, slide, endSlide, startMs, endMs, charStart, charEnd, cell
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func int(_ key: CodingKeys) -> Int? {
            if let value = try? c.decodeIfPresent(Int.self, forKey: key) { return value }
            if let value = try? c.decodeIfPresent(Double.self, forKey: key) { return Int(value) }
            return nil
        }
        page = int(.page)
        endPage = int(.endPage)
        slide = int(.slide)
        endSlide = int(.endSlide)
        startMs = int(.startMs)
        endMs = int(.endMs)
        charStart = int(.charStart)
        charEnd = int(.charEnd)
        // A cell is a name like "B4"; a number is kept as its text.
        if let text = try? c.decodeIfPresent(String.self, forKey: .cell) {
            cell = text
        } else {
            cell = int(.cell).map(String.init)
        }
    }
}

/// The JSON coding the Studio routes use: ISO 8601 times, with or without
/// fractional seconds.
enum StudioJSON {
    static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = parse(text) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 time: \(text)")
        }
        return decoder
    }

    static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(date))
        }
        return encoder
    }

    static func parse(_ text: String) -> Date? {
        let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let plain = Date.ISO8601FormatStyle()
        return (try? withFraction.parse(text)) ?? (try? plain.parse(text))
    }
}
