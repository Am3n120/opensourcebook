import Foundation

/// Resolves block media URLs against the configured engine base URL.
///
/// The engine harvests media (PDF figures, video frames, article images) into
/// object storage and references it with worker-relative paths
/// (`/v1/assets/<id>`); those resolve against the configured engine endpoint.
/// Absolute URLs pass through untouched.
enum AssetURLResolver {
    /// Returns a loadable URL for a block's `url` string, or nil when the value
    /// is empty, malformed, or engine-relative with no usable base URL.
    static func resolve(_ raw: String?, configuration: EngineConfiguration = .current) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.hasPrefix("/") {
            guard let baseURL = configuration.baseURL else { return nil }
            return URL(string: raw, relativeTo: baseURL)?.absoluteURL
        }
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return url
    }
}
