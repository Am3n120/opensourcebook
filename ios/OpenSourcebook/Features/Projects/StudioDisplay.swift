import SwiftUI
import UIKit

extension StudioProject {
    /// The project as Home and the project screen draw it. An icon name that
    /// is not an SF Symbol on this phone shows the folder; a project with no
    /// colour gets one from the palette, the same one every time.
    var asProject: Project {
        Project(
            id: id,
            title: title,
            icon: icon.flatMap { UIImage(systemName: $0) == nil ? nil : $0 } ?? "folder",
            colorHex: colorHex ?? Project.paletteHex[Self.paletteIndex(for: id)],
            category: category,
            createdAt: createdAt ?? .distantPast,
            updatedAt: updatedAt
        )
    }

    static func paletteIndex(for id: String) -> Int {
        id.unicodeScalars.reduce(0) { ($0 &+ Int($1.value)) % Project.paletteHex.count }
    }
}

extension StudioSource {
    /// The engine's source kinds (`pdf`, `web`, `youtube`, …) mapped onto the
    /// phone's source styles; anything else is drawn as `other`.
    var sourceKind: SourceKind {
        switch kind?.lowercased() {
        case "pdf", "paper": .paper
        case "youtube", "video": .video
        case "audio", "podcast": .podcast
        case "image": .image
        case "web", "url", "article": .article
        case "text", "note": .note
        case "spreadsheet", "csv", "xlsx": .spreadsheet
        case let other?: SourceKind(rawValue: other) ?? .other
        case nil: .other
        }
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let url, let host = URL(string: url)?.host() { return host }
        return "Untitled source"
    }

    /// The domain and, unless it is ready, how its reading went.
    var detail: String {
        let domain = url.flatMap { URL(string: $0)?.host() }
        let state: String? = switch status {
        case "pending", "extracting": "Being read"
        case "failed": "Couldn't be read"
        default: nil
        }
        return [domain, state].compactMap { $0 }.joined(separator: " · ")
    }
}
