import XCTest
@testable import OpenSourcebook

final class FormatServiceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private let token = "abcd1234efgh5678.ijkl"

    override func setUp() {
        super.setUp()
        suiteName = "FormatServiceTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        StubFormatsProtocol.reset()
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        StubFormatsProtocol.reset()
        super.tearDown()
    }

    private func service(configured: Bool = true) -> (FormatService, FormatRegistry) {
        let registry = FormatRegistry(catalog: .bundled)
        let configuration = configured
            ? EngineConfiguration(baseURL: URL(string: "https://engine.example.com"), clientToken: token)
            : EngineConfiguration()
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [StubFormatsProtocol.self]
        let service = FormatService(
            configuration: configuration,
            registry: registry,
            cache: FormatCache(defaults: defaults),
            session: URLSession(configuration: sessionConfig)
        )
        return (service, registry)
    }

    private let twoFormats = """
    { "formats": [
      { "id": "byte", "label": "byte", "colorSlot": 5, "icon": "book", "settings": [], "defaults": {}, "ready": true },
      { "id": "talk", "label": "talk", "colorSlot": 7, "icon": "mic", "settings": [], "defaults": {}, "ready": false }
    ] }
    """

    func testAGoodAnswerReplacesTheCatalogAndIsCached() async throws {
        StubFormatsProtocol.respond(status: 200, body: twoFormats)
        let (service, registry) = service()

        let refreshed = await service.refresh()

        XCTAssertTrue(refreshed)
        XCTAssertEqual(registry.catalog.formats.map(\.id.rawValue), ["byte", "quiz", "video"], "talk is not a shape")
        XCTAssertEqual(registry.catalog.descriptor(for: "byte")?.colorSlot, 5, "the engine's byte replaces the bundled one")
        let request = try XCTUnwrap(StubFormatsProtocol.lastRequest)
        XCTAssertEqual(request.url?.absoluteString, "https://engine.example.com/v1/formats")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Token"), token)

        let fresh = FormatRegistry(catalog: .bundled)
        FormatService(configuration: EngineConfiguration(), registry: fresh,
                      cache: FormatCache(defaults: defaults)).loadCached()
        XCTAssertEqual(fresh.catalog.descriptor(for: "byte")?.colorSlot, 5, "next launch starts from the cache")
    }

    func testAnErrorOrUnreadableAnswerKeepsTheCatalog() async {
        for (status, body) in [(401, #"{ "error": "unauthorized" }"#), (200, "not json"), (200, #"{ "formats": [] }"#)] {
            StubFormatsProtocol.respond(status: status, body: body)
            let (service, registry) = service()
            let refreshed = await service.refresh()
            XCTAssertFalse(refreshed)
            XCTAssertEqual(registry.catalog, .bundled)
        }
        XCTAssertNil(FormatCache(defaults: defaults).load())
    }

    func testAnUnconfiguredEngineIsNotAsked() async {
        StubFormatsProtocol.respond(status: 200, body: twoFormats)
        let (service, registry) = service(configured: false)
        let refreshed = await service.refresh()
        XCTAssertFalse(refreshed)
        XCTAssertNil(StubFormatsProtocol.lastRequest)
        XCTAssertEqual(registry.catalog, .bundled)
    }
}

/// Answers every request with one canned response and records the request.
private final class StubFormatsProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var status = 200
    private static var body = Data()
    private static var recorded: URLRequest?

    static var lastRequest: URLRequest? { lock.withLock { recorded } }

    static func respond(status: Int, body: String) {
        lock.withLock {
            self.status = status
            self.body = Data(body.utf8)
        }
    }

    static func reset() {
        lock.withLock {
            status = 200
            body = Data()
            recorded = nil
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, body) = Self.lock.withLock {
            Self.recorded = request
            return (Self.status, Self.body)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
