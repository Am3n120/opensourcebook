import Foundation

/// Where a share should land, as the extension records it. The app maps this
/// onto `CaptureDestination` when it drains the inbox; `newProject` becomes a
/// real project at that point, because only the app can write projects.
enum OpenSourcebookShareDestination: Codable, Equatable, Hashable, Sendable {
    case auto
    case project(id: String)
    case newProject(title: String)
    case inbox
}

/// A single share-extension handoff waiting for the main Open Sourcebook app.
struct OpenSourcebookShareInboxItem: Codable, Identifiable, Sendable {
    let id: UUID
    let sourceText: String
    let sourceURL: String?
    let sourceKind: String
    let destination: OpenSourcebookShareDestination
    let createdAt: Date
    let filename: String?
    /// Relative to the shared App Group container, when the share contains file data.
    let dataPath: String?

    init(
        id: UUID = UUID(),
        sourceText: String,
        sourceURL: String? = nil,
        sourceKind: String,
        destination: OpenSourcebookShareDestination,
        createdAt: Date = .now,
        filename: String? = nil,
        dataPath: String? = nil
    ) {
        self.id = id
        self.sourceText = sourceText
        self.sourceURL = sourceURL
        self.sourceKind = sourceKind
        self.destination = destination
        self.createdAt = createdAt
        self.filename = filename
        self.dataPath = dataPath
    }
}

/// The few project fields the share extension needs to offer a project. The
/// app writes this list whenever its projects change; the extension only reads it.
struct OpenSourcebookShareProject: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let icon: String
    let colorHex: UInt32
}

enum OpenSourcebookShareInboxError: LocalizedError {
    case appGroupUnavailable(String)
    case directoryCreationFailed(String)
    case readFailed(String)
    case writeFailed(String)
    case attachmentWriteFailed(String)
    case emptyAttachment

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable(let identifier):
            return "Open Sourcebook could not access its shared App Group (\(identifier)). Check the App Group entitlement and try again."
        case .directoryCreationFailed(let message):
            return "Open Sourcebook could not prepare shared storage: \(message)"
        case .readFailed(let message):
            return "Open Sourcebook could not read the share inbox: \(message)"
        case .writeFailed(let message):
            return "Open Sourcebook could not write the share inbox: \(message)"
        case .attachmentWriteFailed(let message):
            return "Open Sourcebook could not copy the shared file into its inbox: \(message)"
        case .emptyAttachment:
            return "The shared file was empty and could not be saved."
        }
    }
}

/// Foundation-only persistence shared by the Open Sourcebook app and its share extension.
enum OpenSourcebookShareInbox {
    /// Read from the `OpenSourcebookAppGroup` Info.plist key, which both targets fill from
    /// `OPENSOURCEBOOK_APP_GROUP` in `Config/Base.xcconfig` (the entitlements use the same
    /// setting). Empty means a misconfigured build; the container lookup then
    /// fails with `appGroupUnavailable`.
    static let appGroupIdentifier: String =
        Bundle.main.object(forInfoDictionaryKey: "OpenSourcebookAppGroup") as? String ?? ""
    static let inboxFilename = "re-share-inbox.json"
    static let projectsFilename = "re-share-projects.json"
    static let attachmentsDirectoryName = "re-share-attachments"

    /// Tests point this at a temporary directory so they never touch the real
    /// App Group container. Nil in the app and the extension.
    static var containerOverride: URL?

    private static let lock = NSLock()
    private static let fileManager = FileManager.default

    /// Returns the shared container or throws a clear error instead of silently
    /// writing to a private container that the other target cannot read.
    static func appGroupContainerURL() throws -> URL {
        if let containerOverride { return containerOverride }
        guard let url = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
            throw OpenSourcebookShareInboxError.appGroupUnavailable(appGroupIdentifier)
        }
        return url
    }

    static func read() throws -> [OpenSourcebookShareInboxItem] {
        try withLock {
            try readUnlocked()
        }
    }

    /// Appends one item while retaining any items written by the other target.
    static func append(_ item: OpenSourcebookShareInboxItem) throws {
        try withLock {
            var items = try readUnlocked()
            guard !items.contains(where: { $0.id == item.id }) else { return }
            items.append(item)
            try writeUnlocked(items)
        }
    }

    /// Processes the current inbox and clears only the items successfully
    /// processed by `consume`. If processing throws, the inbox is retained.
    @discardableResult
    static func drain(
        _ consume: ([OpenSourcebookShareInboxItem]) throws -> Void
    ) throws -> [OpenSourcebookShareInboxItem] {
        try withLock {
            let items = try readUnlocked()
            guard !items.isEmpty else { return [] }

            try consume(items)

            // Read again before clearing so an extension append that happened
            // during processing is retained for the next launch.
            let drainedIDs = Set(items.map(\.id))
            let remaining = try readUnlocked().filter { !drainedIDs.contains($0.id) }
            try writeUnlocked(remaining)
            return items
        }
    }

    // MARK: - Projects

    /// Written by the app so the extension can offer the same projects.
    static func writeProjects(_ projects: [OpenSourcebookShareProject]) throws {
        try withLock {
            let url = try appGroupContainerURL().appendingPathComponent(projectsFilename)
            do {
                let data = try encoder().encode(projects)
                try data.write(to: url, options: [.atomic])
            } catch {
                throw OpenSourcebookShareInboxError.writeFailed(error.localizedDescription)
            }
        }
    }

    /// Read by the extension. Missing file means the app has not written one yet.
    static func readProjects() throws -> [OpenSourcebookShareProject] {
        try withLock {
            let url = try appGroupContainerURL().appendingPathComponent(projectsFilename)
            guard fileManager.fileExists(atPath: url.path) else { return [] }
            do {
                return try decoder().decode([OpenSourcebookShareProject].self, from: Data(contentsOf: url))
            } catch {
                throw OpenSourcebookShareInboxError.readFailed(error.localizedDescription)
            }
        }
    }

    // MARK: - Attachments

    /// Resolves a stored attachment path relative to the shared container.
    static func attachmentURL(for relativePath: String) throws -> URL {
        let container = try appGroupContainerURL()
        let baseURL = container.standardizedFileURL
        let attachmentURL = container.appendingPathComponent(relativePath).standardizedFileURL
        guard attachmentURL.path.hasPrefix(baseURL.path + "/") else {
            throw OpenSourcebookShareInboxError.readFailed("The stored attachment path is invalid.")
        }
        return attachmentURL
    }

    /// Copies attachment bytes into the shared container and returns a relative
    /// path suitable for `OpenSourcebookShareInboxItem.dataPath`.
    static func storeAttachment(_ data: Data, filename: String?) throws -> String {
        guard !data.isEmpty else { throw OpenSourcebookShareInboxError.emptyAttachment }

        return try withLock {
            let container = try appGroupContainerURL()
            let directory = container.appendingPathComponent(
                attachmentsDirectoryName,
                isDirectory: true
            )
            do {
                try fileManager.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
            } catch {
                throw OpenSourcebookShareInboxError.directoryCreationFailed(error.localizedDescription)
            }

            let relativePath = "\(attachmentsDirectoryName)/\(attachmentName(for: filename))"
            let destination = container.appendingPathComponent(relativePath)
            do {
                try data.write(to: destination, options: [.atomic])
            } catch {
                throw OpenSourcebookShareInboxError.attachmentWriteFailed(error.localizedDescription)
            }
            return relativePath
        }
    }

    /// `<UUID>-<sanitized name>`: the form `GenerationService` reads the
    /// original filename back from when it uploads the bytes.
    static func attachmentName(for filename: String?) -> String {
        "\(UUID().uuidString)-\(safeFilename(filename ?? "attachment"))"
    }

    // MARK: - Private

    private static func readUnlocked() throws -> [OpenSourcebookShareInboxItem] {
        let url = try inboxURL()
        guard fileManager.fileExists(atPath: url.path) else { return [] }

        do {
            let data = try Data(contentsOf: url)
            guard !data.isEmpty else { return [] }
            return try decoder().decode([OpenSourcebookShareInboxItem].self, from: data)
        } catch {
            throw OpenSourcebookShareInboxError.readFailed(error.localizedDescription)
        }
    }

    private static func writeUnlocked(_ items: [OpenSourcebookShareInboxItem]) throws {
        let url = try inboxURL()
        do {
            // Data's atomic write creates and replaces the inbox as one file
            // operation, so a reader never observes a partially encoded array.
            let data = try encoder().encode(items)
            try data.write(to: url, options: [.atomic])
        } catch {
            throw OpenSourcebookShareInboxError.writeFailed(error.localizedDescription)
        }
    }

    private static func inboxURL() throws -> URL {
        try appGroupContainerURL().appendingPathComponent(inboxFilename)
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private static func withLock<Value>(_ body: () throws -> Value) rethrows -> Value {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private static func safeFilename(_ filename: String) -> String {
        // An empty name would otherwise resolve to the working directory's name.
        guard !filename.isEmpty else { return "attachment" }
        let basename = URL(fileURLWithPath: filename).lastPathComponent
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let sanitized = basename.unicodeScalars.map { scalar in
            allowed.contains(scalar) ? String(scalar) : "_"
        }.joined()
        return sanitized.isEmpty ? "attachment" : sanitized
    }
}
