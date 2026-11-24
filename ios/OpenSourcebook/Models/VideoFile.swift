import Foundation

/// The file a video output plays (engine/docs/video.md, "Render"). A video's
/// scenes stay on the engine; the phone plays the file and says when it is
/// a storyboard, so a storyboard is never taken for the finished video.
struct VideoFile: Codable, Sendable, Equatable, Hashable {
    /// Engine-relative (`/v1/assets/<id>`) or absolute; `AssetURLResolver` resolves it.
    let url: String
    /// True when the file shows each scene's plan in words, not its finished
    /// picture and sound. Only an explicit `false` from the engine is a
    /// finished video.
    let storyboard: Bool
    /// Which provider set made it (`storyboard` today).
    let by: String?

    /// The file in a video payload's `render`, or nil when there is none.
    static func from(payload: JSONValue?) -> VideoFile? {
        guard let render = payload?["render"], let url = render["url"]?.stringValue, !url.isEmpty else { return nil }
        var storyboard = true
        if case .bool(let flag) = render["storyboard"] { storyboard = flag }
        return VideoFile(url: url, storyboard: storyboard, by: render["by"]?.stringValue)
    }
}
