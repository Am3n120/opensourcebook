import Foundation

extension StudioOutput {
    /// The made thing as the phone stores and plays it. A byte's payload
    /// (`engine/docs/byte.md`) gives its bits, a quiz's its questions, a
    /// video's (`engine/docs/video.md`) the file it plays; a format this build
    /// doesn't know keeps its title, and its player says what it can't show. `position` is where it sits in its plan, so moving past it ticks
    /// that item. Nil when the engine's id is not a UUID, which is how the
    /// phone keys everything it holds.
    func playable(at position: PlanPosition?) -> Output? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        var output: Output
        switch ItemShape(type) {
        case .byte:
            output = Self.byte(from: payload, id: id) ?? Output(id: uuid, title: title, subtitle: summary ?? "")
        case .quiz:
            let quiz = payload.flatMap { value -> QuizPayload? in
                guard let data = try? JSONEncoder().encode(value) else { return nil }
                return try? JSONDecoder().decode(QuizPayload.self, from: data)
            }
            output = Output(id: uuid, title: title, subtitle: summary ?? "", quiz: quiz)
        case .video:
            output = Output(id: uuid, title: title, subtitle: summary ?? "", video: VideoFile.from(payload: payload))
        case nil:
            output = Output(id: uuid, title: title, subtitle: summary ?? "")
        }
        output.type = type
        if !title.isEmpty { output.title = title }
        if output.excerpt == nil { output.excerpt = summary }
        output.projectID = projectId
        output.plan = position ?? planId.flatMap { plan in itemId.map { PlanPosition(planID: plan, nodeID: $0, level: 0, ord: 0) } }
        if let createdAt { output.createdAt = createdAt }
        return output
    }

    /// Reads a byte payload with the phone's own byte decoding, keyed by the
    /// output's id. A source kind this build doesn't list reads as `other`
    /// (byte.md says so).
    private static func byte(from payload: JSONValue?, id: String) -> Output? {
        guard case .object(var fields) = payload else { return nil }
        fields["id"] = .string(id)
        if let kind = fields["sourceKind"]?.stringValue, SourceKind(rawValue: kind) == nil {
            fields["sourceKind"] = .string(SourceKind.other.rawValue)
        }
        // A version 2 byte has no `type`; anything there would be read as the old page's source kind.
        fields["type"] = nil
        fields["createdAt"] = nil
        guard let data = try? JSONEncoder().encode(JSONValue.object(fields)) else { return nil }
        return try? JSONDecoder().decode(Output.self, from: data)
    }
}
