import Foundation
import UniformTypeIdentifiers

/// One source as both capture paths hand it to the engine: what was shared,
/// the link if there is one, and the engine's source-kind string.
struct CaptureSourceFields: Equatable, Sendable {
    let sourceText: String
    let sourceURL: String?
    let sourceKind: String
}

/// Turns typed or shared text into source fields, and names source kinds.
/// Used by the capture sheet and the share extension so both read input the
/// same way.
enum CaptureSourceParsing {

    /// Text that is a link, or contains one, becomes a link source: the first
    /// http(s) URL goes to `sourceURL` so the engine's extractors run, and any
    /// other words stay as context. Plain text stays text. Nil when empty.
    static func fields(fromText text: String) -> CaptureSourceFields? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard let link = firstHTTPURL(in: trimmed), let url = URL(string: link) else {
            return CaptureSourceFields(sourceText: trimmed, sourceURL: nil, sourceKind: "text")
        }
        let remainder = trimmed
            .replacingOccurrences(of: link, with: " ")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return CaptureSourceFields(
            sourceText: remainder.isEmpty ? link : remainder,
            sourceURL: link,
            sourceKind: sourceKind(for: url)
        )
    }

    /// First http(s) URL with a host embedded in free text, if one exists.
    static func firstHTTPURL(in text: String) -> String? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: range) {
            guard let matchRange = Range(match.range, in: text) else { continue }
            let value = String(text[matchRange])
            if let url = URL(string: value),
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https",
               url.host?.isEmpty == false {
                return value
            }
        }
        return nil
    }

    /// Engine source kind for a link, from its host.
    static func sourceKind(for url: URL) -> String {
        let host = (url.host ?? "")
            .lowercased()
            .replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)

        if host == "youtu.be" || host.contains("youtube.com") { return "youtube" }
        if host == "x.com" || host.contains("twitter.com") { return "x" }
        if host.contains("instagram.com") { return "instagram" }
        if host.contains("tiktok.com") { return "tiktok" }
        if host.contains("reddit.com") || host == "redd.it" { return "reddit" }
        if host.contains("vimeo.com") { return "vimeo" }
        return "web"
    }

    /// Engine source kind for a file, from its type.
    static func sourceKind(forFileType type: UTType?) -> String {
        guard let type else { return "file" }
        if type.conforms(to: .pdf) { return "pdf" }
        if type.conforms(to: .image) { return "image" }
        if type.conforms(to: .audio) { return "audio" }
        return "file"
    }

    /// The line a file source sends as its text, e.g. "PDF: notes.pdf".
    static func fileSourceText(filename: String, sourceKind: String) -> String {
        let label: String
        switch sourceKind {
        case "image": label = "Image"
        case "pdf": label = "PDF"
        case "audio": label = "Audio"
        default: label = "File"
        }
        return "\(label): \(filename)"
    }
}
