import Foundation
import OSLog

/// Keeps `FormatRegistry` current from the engine's `GET /v1/formats`: the
/// engine says how each of the three shapes looks and what it takes
/// (DECISIONS.md #24, #33); which shapes exist is fixed (#37). The
/// last good answer is cached, so a launch without the network shows what
/// the engine said last; with neither, the bundled catalog stands.
struct FormatService: Sendable {
    let configuration: EngineConfiguration
    let registry: FormatRegistry
    let cache: FormatCache
    let session: URLSession

    init(
        configuration: EngineConfiguration,
        registry: FormatRegistry = .shared,
        cache: FormatCache = FormatCache(),
        session: URLSession = .shared
    ) {
        self.configuration = configuration
        self.registry = registry
        self.cache = cache
        self.session = session
    }

    private static let logger = Logger(subsystem: "app.opensourcebook", category: "Formats")

    /// Puts the cached catalog, if any, into the registry.
    func loadCached() {
        if let cached = cache.load() { registry.catalog = FormatCatalog.bundled.shaped(by: cached) }
    }

    /// Asks the engine for its formats. On a good answer the registry and the
    /// cache take it; on anything else both stay as they are. Returns whether
    /// the registry was refreshed.
    @discardableResult
    func refresh() async -> Bool {
        guard let url = configuration.formatsURL, let token = configuration.clientToken else { return false }
        var request = URLRequest(url: url, timeoutInterval: configuration.requestTimeout)
        request.setValue(token, forHTTPHeaderField: "X-Client-Token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                Self.logger.notice("Formats request failed with HTTP \(status, privacy: .public)")
                return false
            }
            let catalog = try FormatCatalog.decode(data)
            registry.catalog = FormatCatalog.bundled.shaped(by: catalog)
            cache.save(data)
            return true
        } catch {
            Self.logger.notice("Formats not refreshed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}

/// The last `GET /v1/formats` body that decoded, kept in UserDefaults.
struct FormatCache: @unchecked Sendable {
    static let key = "formats.catalog"

    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> FormatCatalog? {
        guard let data = defaults.data(forKey: Self.key) else { return nil }
        return try? FormatCatalog.decode(data)
    }

    func save(_ data: Data) {
        defaults.set(data, forKey: Self.key)
    }
}
