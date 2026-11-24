import SwiftUI
import UniformTypeIdentifiers

/// The JSON file the user exports from Profile: every output (archived ones
/// included), every project, and the per-output state the user set.
struct OpenSourcebookExportPayload: Codable {
    struct OutputState: Codable {
        var isFiled: Bool
        var isFavorite: Bool
        var isArchived: Bool
        var lastOpenedAt: Date?
    }

    struct Entry: Codable {
        var output: Output
        var state: OutputState
    }

    var exportedAt: Date
    var appVersion: String
    var projects: [Project]
    var outputs: [Entry]

    /// Builds the payload from the store's current contents.
    @MainActor
    init(store: OutputStore, appVersion: String, exportedAt: Date = .now) {
        self.exportedAt = exportedAt
        self.appVersion = appVersion
        self.projects = store.projects
        self.outputs = (store.outputs + store.archivedOutputs).map { output in
            let meta = store.meta(for: output.id)
            return Entry(
                output: output,
                state: OutputState(
                    isFiled: meta.isFiled,
                    isFavorite: meta.isFavorite,
                    isArchived: meta.isArchived,
                    lastOpenedAt: meta.lastOpenedAt
                )
            )
        }
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(self)
    }
}

/// Document handed to `fileExporter`.
struct OpenSourcebookExportDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.data = contents
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
