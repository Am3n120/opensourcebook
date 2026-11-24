import Foundation

/// One generated thing: a node of a plan, or the single result of a quick
/// capture. A byte carries its bits (DECISIONS.md #34), a quiz its questions
/// (#35), a video the file it plays (engine/docs/video.md).
///
/// Decoding accepts this shape, the engine's byte (schema version 2, with
/// `bits` and `depth`) and the old job result page (the August wire format:
/// `type` = source kind, `byteDepth` = density, no output type, no
/// `createdAt`). Encoding always writes this shape.
struct Output: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: UUID
    /// The format it was made in. Kept as stored, including old ids; the
    /// format catalog resolves aliases when it shows or plays it.
    var type: FormatID
    var title: String
    /// Display source line, e.g. "youtube.com" or "Vaswani et al. (2017)".
    var subtitle: String
    var sourceKind: SourceKind
    /// Domain the source came from, if any (e.g. "youtube.com").
    var sourceDomain: String?
    var author: String?
    var createdAt: Date
    var tags: [String]
    /// Media duration or reading time, e.g. "1:12:06" or "12 min read".
    var durationText: String?
    var excerpt: String?
    /// Project this output belongs to; nil for singles and Inbox items.
    var projectID: String?
    /// Position in the plan that produced this output; nil for singles.
    var plan: PlanPosition?
    /// True when nothing was generated: the capture was kept as a link only.
    var isSaveOnly: Bool

    // Byte payload. A byte made today carries its bits; an old stored page
    // (schema version 1) carries one list of blocks and no bits, and is cut
    // into bits on the phone (`ByteCutter`).
    var blocks: [Block]
    var bits: [Bit]
    var density: Density
    /// Quiz payload; nil for anything that isn't a quiz.
    var quiz: QuizPayload?
    /// The file a video plays; nil for anything that isn't a video, or a video with no file.
    var video: VideoFile?

    init(
        id: UUID = UUID(),
        type: FormatID = Output.unlabelledFormat,
        title: String,
        subtitle: String,
        sourceKind: SourceKind = .other,
        sourceDomain: String? = nil,
        author: String? = nil,
        createdAt: Date = .now,
        tags: [String] = [],
        durationText: String? = nil,
        excerpt: String? = nil,
        projectID: String? = nil,
        plan: PlanPosition? = nil,
        isSaveOnly: Bool = false,
        blocks: [Block] = [],
        bits: [Bit] = [],
        density: Density = .medium,
        quiz: QuizPayload? = nil,
        video: VideoFile? = nil
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.subtitle = subtitle
        self.sourceKind = sourceKind
        self.sourceDomain = sourceDomain
        self.author = author
        self.createdAt = createdAt
        self.tags = tags
        self.durationText = durationText
        self.excerpt = excerpt
        self.projectID = projectID
        self.plan = plan
        self.isSaveOnly = isSaveOnly
        self.blocks = blocks
        self.bits = bits
        self.density = density
        self.quiz = quiz
        self.video = video
    }

    /// The byte's screens, in swipe order: its own bits, or an old page cut
    /// into bits.
    var screens: [Bit] {
        bits.isEmpty ? ByteCutter.bits(from: blocks) : bits
    }

    /// Every block the output shows, in order, whichever shape it was stored in.
    var allBlocks: [Block] {
        bits.isEmpty ? blocks : bits.flatMap(\.blocks)
    }

    /// What an output with no format on the wire was made as: the August
    /// engine only wrote long pages of blocks, which are bytes now
    /// (DECISIONS.md #34).
    static let unlabelledFormat: FormatID = "byte"

    /// The YouTube ID of the first `.video` block, if any. Cards use it for a
    /// real thumbnail.
    var firstYouTubeID: String? {
        for block in allBlocks {
            if case .video(let youtubeID, _) = block { return youtubeID }
        }
        return nil
    }

    // MARK: Codable

    private enum CodingKeys: String, CodingKey {
        case id, title, subtitle, sourceKind, sourceDomain, author, createdAt, tags
        case durationText, excerpt, projectID, plan, isSaveOnly, blocks, bits, density, quiz, video
        case outputType
        /// The engine output's payload (`GET /v1/outputs/:id`).
        case payload
        // Engine byte, schema version 2 (engine/docs/byte.md).
        case depth
        // Engine wire format (August byte).
        case legacyType = "type"
        case legacyDepth = "byteDepth"
        case legacyStatus = "status"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        type = try c.decodeIfPresent(FormatID.self, forKey: .outputType) ?? Self.unlabelledFormat
        title = try c.decode(String.self, forKey: .title)
        subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
        sourceKind = try c.decodeIfPresent(SourceKind.self, forKey: .sourceKind)
            ?? c.decodeIfPresent(SourceKind.self, forKey: .legacyType)
            ?? .other
        sourceDomain = try c.decodeIfPresent(String.self, forKey: .sourceDomain)
        author = try c.decodeIfPresent(String.self, forKey: .author)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? .now
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        durationText = try c.decodeIfPresent(String.self, forKey: .durationText)
        excerpt = try c.decodeIfPresent(String.self, forKey: .excerpt)
        projectID = try c.decodeIfPresent(String.self, forKey: .projectID)
        plan = try c.decodeIfPresent(PlanPosition.self, forKey: .plan)
        blocks = try c.decodeIfPresent([Block].self, forKey: .blocks) ?? []
        bits = try c.decodeIfPresent([Bit].self, forKey: .bits) ?? []
        quiz = (try? c.decodeIfPresent(QuizPayload.self, forKey: .quiz))
            ?? (try? c.decodeIfPresent(QuizPayload.self, forKey: .payload))
        video = try? c.decodeIfPresent(VideoFile.self, forKey: .video)
        density = try c.decodeIfPresent(Density.self, forKey: .density)
            ?? c.decodeIfPresent(Density.self, forKey: .legacyDepth)
            ?? (try? c.decodeIfPresent(Density.self, forKey: .depth))
            ?? .medium

        if let flag = try c.decodeIfPresent(Bool.self, forKey: .isSaveOnly) {
            isSaveOnly = flag
        } else if let status = try? c.decodeIfPresent(LegacyStatus.self, forKey: .legacyStatus) {
            isSaveOnly = status.type == "saveOnly"
        } else {
            isSaveOnly = density == .saveOnly
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(type, forKey: .outputType)
        try c.encode(title, forKey: .title)
        try c.encode(subtitle, forKey: .subtitle)
        try c.encode(sourceKind, forKey: .sourceKind)
        try c.encodeIfPresent(sourceDomain, forKey: .sourceDomain)
        try c.encodeIfPresent(author, forKey: .author)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(tags, forKey: .tags)
        try c.encodeIfPresent(durationText, forKey: .durationText)
        try c.encodeIfPresent(excerpt, forKey: .excerpt)
        try c.encodeIfPresent(projectID, forKey: .projectID)
        try c.encodeIfPresent(plan, forKey: .plan)
        try c.encode(isSaveOnly, forKey: .isSaveOnly)
        try c.encode(blocks, forKey: .blocks)
        if !bits.isEmpty { try c.encode(bits, forKey: .bits) }
        try c.encodeIfPresent(quiz, forKey: .quiz)
        try c.encodeIfPresent(video, forKey: .video)
        try c.encode(density, forKey: .density)
    }

    /// The August engine's `status` object (`{ "type": "ready" | "saveOnly" | … }`).
    private struct LegacyStatus: Decodable {
        let type: String
    }
}
