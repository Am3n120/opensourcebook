import Foundation
import OSLog

/// The app's side of the share extension: turns share-inbox items into
/// capture jobs, and publishes the project list the extension's picker shows.
@MainActor
enum ShareInboxBridge {
    private static let logger = Logger(subsystem: "app.opensourcebook", category: "ShareInbox")

    /// Moves every waiting share into `OutputStore` as a capture job. Items
    /// keep their id as the job id, so a drain that is interrupted after
    /// queueing cannot queue the same share twice. Safe to call often.
    static func drain(into store: OutputStore) {
        do {
            let items = try OpenSourcebookShareInbox.drain { items in
                for item in items where store.job(item.id) == nil {
                    store.enqueueJob(
                        id: item.id,
                        sourceText: item.sourceText,
                        sourceURL: sourceURL(for: item),
                        sourceKind: item.sourceKind,
                        destination: destination(for: item.destination, store: store)
                    )
                }
            }
            if !items.isEmpty {
                logger.info("Queued \(items.count, privacy: .public) shared item(s)")
            }
        } catch {
            logger.error("Draining the share inbox failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Writes the projects the extension can offer. Called whenever they change.
    static func publishProjects(_ projects: [Project]) {
        do {
            try OpenSourcebookShareInbox.writeProjects(projects.map {
                OpenSourcebookShareProject(id: $0.id, title: $0.title, icon: $0.icon, colorHex: $0.colorHex)
            })
        } catch {
            logger.error("Publishing projects to the share extension failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// A stored file is handed to the job as a `file:` URL, which
    /// `GenerationService` uploads before it creates the remote job.
    private static func sourceURL(for item: OpenSourcebookShareInboxItem) -> String? {
        if let dataPath = item.dataPath {
            do {
                return try OpenSourcebookShareInbox.attachmentURL(for: dataPath).absoluteString
            } catch {
                logger.error("Shared attachment path rejected: \(error.localizedDescription, privacy: .public)")
            }
        }
        return item.sourceURL
    }

    private static func destination(for destination: OpenSourcebookShareDestination, store: OutputStore) -> CaptureDestination {
        switch destination {
        case .auto:
            return .auto
        case .inbox:
            return .inbox
        case .project(let id):
            // The project may have been deleted since the extension read the list.
            return store.project(forID: id) == nil ? .inbox : .project(id: id)
        case .newProject(let title):
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return .inbox }
            return .project(id: store.createProject(title: trimmed).id)
        }
    }
}
