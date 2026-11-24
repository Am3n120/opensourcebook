import Foundation

/// Runtime configuration for the iOS client and the Open Sourcebook engine worker.
///
/// The app deliberately ships disabled. A deployed app should provision only the
/// worker endpoint and its separate client token through UserDefaults (or the
/// Info.plist values filled from ios/Config/Local.xcconfig), never a provider key.
struct EngineConfiguration: Equatable, Sendable {
    /// The only UserDefaults-backed client settings. Values are runtime
    /// configuration, never provider credentials.
    static let engineBaseURLKey = "engineBaseURL"
    static let engineClientTokenKey = "engineClientToken"

    /// Optional host-provided Info.plist keys. No values are added to the app
    /// target by default, so a fresh build remains explicitly disabled.
    static let infoBaseURLKey = "EngineBaseURL"
    static let infoClientTokenKey = "EngineClientToken"

    /// A visible, non-production placeholder. It is rejected by `isConfigured`.
    static let defaultBaseURLString = "https://disabled.invalid"

    let baseURL: URL?
    let clientToken: String?
    let pollInterval: TimeInterval
    let requestTimeout: TimeInterval

    init(
        baseURL: URL? = URL(string: EngineConfiguration.defaultBaseURLString),
        clientToken: String? = nil,
        pollInterval: TimeInterval = 5,
        requestTimeout: TimeInterval = 30
    ) {
        self.baseURL = Self.normalizedBaseURL(baseURL)
        self.clientToken = clientToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.pollInterval = max(1, pollInterval)
        self.requestTimeout = max(1, requestTimeout)
    }

    /// Reads the current process configuration without embedding any secret.
    static var current: EngineConfiguration {
        from(
            userDefaults: .standard,
            infoDictionary: Bundle.main.infoDictionary ?? [:]
        )
    }

    /// Injectable loader used by tests and previews to avoid mutating defaults.
    static func from(
        userDefaults: UserDefaults,
        infoDictionary: [String: Any] = [:]
    ) -> EngineConfiguration {
        let endpointString = firstNonEmpty([
            userDefaults.string(forKey: engineBaseURLKey),
            infoDictionary[infoBaseURLKey] as? String
        ])
        let token = firstNonEmpty([
            userDefaults.string(forKey: engineClientTokenKey),
            infoDictionary[infoClientTokenKey] as? String
        ])

        return EngineConfiguration(
            baseURL: URL(string: endpointString ?? defaultBaseURLString),
            clientToken: token
        )
    }

    /// True when the service can do useful work.
    var isConfigured: Bool {
        guard let baseURL,
              Self.isAllowedEndpoint(baseURL),
              !Self.isDisabledEndpoint(baseURL),
              let clientToken,
              Self.isValidClientToken(clientToken) else {
            return false
        }
        return true
    }

    /// A safe validation message for the settings UI. It never includes the
    /// client token contents.
    var validationErrorMessage: String? {
        guard let baseURL else {
            return "Enter an engine endpoint."
        }
        if Self.isDisabledEndpoint(baseURL) {
            return "Use a deployed HTTPS engine endpoint."
        }
        if !Self.isAllowedEndpoint(baseURL) {
            return "The engine endpoint must use HTTPS."
        }
        guard let clientToken, Self.isValidClientToken(clientToken) else {
            return "The client token is missing or invalid."
        }
        return nil
    }

    /// A safe status string suitable for diagnostics and the Profile screen.
    /// It never includes the client token.
    var statusMessage: String {
        guard let baseURL else {
            return "Generation disabled — set engineBaseURL and engineClientToken."
        }
        if Self.isDisabledEndpoint(baseURL) {
            return "Generation disabled — configure a deployed HTTPS engine endpoint."
        }
        if !Self.isAllowedEndpoint(baseURL) {
            return "Generation disabled — engineBaseURL must use HTTPS; localhost HTTP is simulator-only."
        }
        guard let clientToken, Self.isValidClientToken(clientToken) else {
            return "Generation disabled — engineClientToken is missing or invalid."
        }
        return "Cloud engine configured."
    }

    /// The worker health check lives at `<origin>/health` and does not create a job.
    /// It is available for endpoint diagnostics even when the client token still
    /// needs fixing, because the health route does not require provider access.
    var healthURL: URL? {
        guard let baseURL,
              !Self.isDisabledEndpoint(baseURL),
              Self.isAllowedEndpoint(baseURL) else {
            return nil
        }
        return baseURL.appendingPathComponent("health", isDirectory: false)
    }

    /// The worker expects its API at `<origin>/v1/jobs`.
    var jobsURL: URL? {
        guard isConfigured, let baseURL else { return nil }
        return baseURL
            .appendingPathComponent("v1", isDirectory: true)
            .appendingPathComponent("jobs", isDirectory: false)
    }

    /// The format registry: `<origin>/v1/formats` (client token).
    var formatsURL: URL? {
        guard isConfigured, let baseURL else { return nil }
        return baseURL
            .appendingPathComponent("v1", isDirectory: true)
            .appendingPathComponent("formats", isDirectory: false)
    }

    /// `<origin>/v1/plans/<plan>/items/<item>/done` (client token).
    func doneURL(planID: String, itemID: String) -> URL? {
        planURL(planID, "items", itemID, "done")
    }

    /// `<origin>/v1/plans/<plan>/progress` (client token).
    func progressURL(planID: String) -> URL? {
        planURL(planID, "progress")
    }

    private func planURL(_ planID: String, _ rest: String...) -> URL? {
        apiURL(["plans", planID] + rest)
    }

    /// `<origin>/v1/<segments…>` with an optional query (client token).
    /// Each segment is one path segment: an id never adds segments of its own.
    func apiURL(_ segments: [String], query: [URLQueryItem] = []) -> URL? {
        guard isConfigured, let baseURL,
              var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        var encoded: [String] = []
        for part in segments {
            guard let segment = part.addingPercentEncoding(withAllowedCharacters: allowed), !segment.isEmpty else { return nil }
            encoded.append(segment)
        }
        components.percentEncodedPath += "/v1/" + encoded.joined(separator: "/")
        if !query.isEmpty { components.queryItems = query }
        return components.url
    }

    /// A harvested picture or clip: `<origin>/v1/assets/<id>` (public).
    func assetURL(_ assetID: String) -> URL? {
        apiURL(["assets", assetID])
    }

    private static func firstNonEmpty(_ values: [String?]) -> String? {
        values.lazy
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }

    private static func normalizedBaseURL(_ url: URL?) -> URL? {
        guard let url,
              let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              url.host != nil else {
            return nil
        }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        while components?.path.hasSuffix("/") == true {
            components?.path.removeLast()
        }
        return components?.url
    }

    private static func isDisabledEndpoint(_ url: URL) -> Bool {
        url.host?.lowercased() == "disabled.invalid"
    }

    private static func isAllowedEndpoint(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "https" { return true }

        #if targetEnvironment(simulator)
        if scheme == "http", let host = url.host?.lowercased() {
            return ["localhost", "127.0.0.1", "::1"].contains(host)
        }
        #endif

        return false
    }

    /// Mirrors the worker's safe client-token shape without knowing its value.
    private static func isValidClientToken(_ token: String) -> Bool {
        guard (16...256).contains(token.unicodeScalars.count) else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._~:-"))
        return token.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

extension EngineConfiguration {
    /// Exposed for focused configuration checks without exposing token contents.
    var hasValidClientToken: Bool {
        guard let clientToken else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._~:-"))
        guard (16...256).contains(clientToken.unicodeScalars.count) else { return false }
        return clientToken.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}
