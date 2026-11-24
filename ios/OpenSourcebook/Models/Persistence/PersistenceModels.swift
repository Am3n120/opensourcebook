import Foundation
import SwiftData

/// Shared JSON configuration for persisted model payloads.
enum PersistenceCoding {
    static func encode<Value: Encodable>(_ value: Value) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(value)
    }

    static func decode<Value: Decodable>(_ type: Value.Type, from data: Data) throws -> Value {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: data)
    }
}

/// SwiftData envelope for one `Output` plus the state the user attaches to it.
/// The output itself is a JSON blob so the block schema can grow without a
/// migration; everything the app filters or sorts on is a real column.
@Model
final class PersistedOutputRecord {
    @Attribute(.unique) var id: UUID
    var payload: Data
    var typeRawValue: String
    var projectID: String?
    var createdAt: Date
    var updatedAt: Date
    /// False until the user files the output into a project or confirms it as
    /// a single; unfiled outputs make up the Inbox (VISION.md).
    var isFiled: Bool
    var isFavorite: Bool
    var isArchived: Bool
    /// First visible block index when the output was last closed.
    var readPosition: Int
    var lastOpenedAt: Date?

    init(output: Output, isFiled: Bool, createdAt: Date = .now) {
        self.id = output.id
        self.payload = (try? PersistenceCoding.encode(output)) ?? Data()
        self.typeRawValue = output.type.rawValue
        self.projectID = output.projectID
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.isFiled = isFiled
        self.isFavorite = false
        self.isArchived = false
        self.readPosition = 0
        self.lastOpenedAt = nil
    }

    func decodeOutput() throws -> Output {
        try PersistenceCoding.decode(Output.self, from: payload)
    }

    func update(output: Output) throws {
        payload = try PersistenceCoding.encode(output)
        typeRawValue = output.type.rawValue
        projectID = output.projectID
        updatedAt = .now
    }
}

/// SwiftData record for a project.
@Model
final class PersistedProjectRecord {
    @Attribute(.unique) var id: String
    var title: String
    var icon: String
    var colorHex: Int64
    var category: String?
    var createdAt: Date
    var updatedAt: Date

    init(project: Project) {
        self.id = project.id
        self.title = project.title
        self.icon = project.icon
        self.colorHex = Int64(project.colorHex)
        self.category = project.category
        self.createdAt = project.createdAt
        self.updatedAt = project.updatedAt
    }

    var project: Project {
        Project(
            id: id,
            title: title,
            icon: icon,
            colorHex: UInt32(truncatingIfNeeded: colorHex),
            category: category,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    func apply(_ project: Project) {
        title = project.title
        icon = project.icon
        colorHex = Int64(project.colorHex)
        category = project.category
        updatedAt = .now
    }
}

/// Stages reported by the engine for one generation job.
enum CaptureJobStage: String, Codable, CaseIterable, Sendable, Identifiable {
    case queued
    case extracting
    case researching
    case structuring
    case writing
    case verifying
    case done
    case failed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .queued: return "Waiting to start"
        case .extracting: return "Reading the source"
        case .researching: return "Researching"
        case .structuring: return "Organizing"
        case .writing: return "Writing"
        case .verifying: return "Checking"
        case .done: return "Done"
        case .failed: return "Failed"
        }
    }

    var isFinished: Bool { self == .done || self == .failed }
}

/// Where a capture should land (DECISIONS.md #16: the project picker replaces
/// the depth picker). Stored on the job so a later engine can honor `auto`.
enum CaptureDestination: Equatable, Hashable, Sendable {
    /// Open Sourcebook decides the project. Not implemented by the engine yet; such
    /// captures land in the Inbox until then.
    case auto
    /// A project the user picked or just created.
    case project(id: String)
    /// Keep it unfiled on purpose.
    case inbox

    var projectID: String? {
        if case .project(let id) = self { return id }
        return nil
    }

    var rawValue: String {
        switch self {
        case .auto: return "auto"
        case .project: return "project"
        case .inbox: return "inbox"
        }
    }

    init(rawValue: String, projectID: String?) {
        switch rawValue {
        case "project":
            if let projectID { self = .project(id: projectID) } else { self = .inbox }
        case "auto": self = .auto
        default: self = .inbox
        }
    }
}

/// Durable record of one capture → generation job. The engine side is
/// identified by this id (used as the idempotency key), so a relaunch can
/// always pick the job back up.
@Model
final class PersistedCaptureJob {
    @Attribute(.unique) var id: UUID
    var sourceText: String
    var sourceURL: String?
    var sourceKind: String
    var destinationRawValue: String
    var projectID: String?
    var stageRawValue: String
    var progress: Double
    var errorMessage: String?
    var createdAt: Date
    var updatedAt: Date
    var retryCount: Int
    var resultOutputID: UUID?

    var stage: CaptureJobStage {
        get { CaptureJobStage(rawValue: stageRawValue) ?? .queued }
        set { stageRawValue = newValue.rawValue }
    }

    var destination: CaptureDestination {
        get { CaptureDestination(rawValue: destinationRawValue, projectID: projectID) }
        set {
            destinationRawValue = newValue.rawValue
            projectID = newValue.projectID
        }
    }

    init(
        id: UUID = UUID(),
        sourceText: String,
        sourceURL: String? = nil,
        sourceKind: String = "unknown",
        destination: CaptureDestination = .inbox,
        stage: CaptureJobStage = .queued,
        progress: Double = 0,
        errorMessage: String? = nil,
        createdAt: Date = .now,
        retryCount: Int = 0,
        resultOutputID: UUID? = nil
    ) {
        self.id = id
        self.sourceText = sourceText
        self.sourceURL = sourceURL
        self.sourceKind = sourceKind
        self.destinationRawValue = destination.rawValue
        self.projectID = destination.projectID
        self.stageRawValue = stage.rawValue
        self.progress = progress
        self.errorMessage = errorMessage
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.retryCount = retryCount
        self.resultOutputID = resultOutputID
    }
}

/// The model container schema.
enum OpenSourcebookModelSchema {
    static let models: [any PersistentModel.Type] = [
        PersistedOutputRecord.self,
        PersistedProjectRecord.self,
        PersistedCaptureJob.self
    ]
}
