import XCTest
@testable import OpenSourcebook

/// The Studio client over HTTP: routes, the token, paging, errors.
final class StudioServiceTests: XCTestCase {
    private let token = "abcd1234efgh5678.ijkl"

    override func setUp() {
        super.setUp()
        StubStudioProtocol.reset()
    }

    override func tearDown() {
        StubStudioProtocol.reset()
        super.tearDown()
    }

    private func service(configured: Bool = true) -> StudioService {
        let configuration = configured
            ? EngineConfiguration(baseURL: URL(string: "https://engine.example.com/"), clientToken: token)
            : EngineConfiguration()
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.protocolClasses = [StubStudioProtocol.self]
        return StudioService(configuration: configuration, session: URLSession(configuration: sessionConfig))
    }

    func testProjectsAreReadPageByPageWithTheToken() async throws {
        StubStudioProtocol.route("/v1/projects", query: "limit=200", body: #"{ "projects": [{ "id": "p1", "title": "A" }], "nextCursor": "c/2" }"#)
        StubStudioProtocol.route("/v1/projects", query: "limit=200&cursor=c/2", body: #"{ "projects": [{ "id": "p2", "title": "B" }, { "broken": true }] }"#)

        let projects = try await service().projects()

        XCTAssertEqual(projects.map(\.id), ["p1", "p2"], "a row that can't be read is skipped")
        let requests = StubStudioProtocol.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "x-client-token"), token)
        XCTAssertEqual(requests.last?.url?.query, "limit=200&cursor=c/2")
    }

    func testPlansPlanOutputsAndSourcesUseTheirRoutes() async throws {
        StubStudioProtocol.route("/v1/projects/p%201/plans", body: #"{ "plans": [{ "id": "pl", "projectId": "p 1", "title": "Unit 1", "status": "running", "counts": { "total": 3, "done": 1 } }] }"#)
        StubStudioProtocol.route("/v1/plans/pl", body: #"{ "plan": { "id": "pl", "projectId": "p 1", "title": "Unit 1", "status": "running" }, "stages": [], "items": [], "counts": { "total": 0, "done": 0 } }"#)
        StubStudioProtocol.route("/v1/projects/p%201/outputs", query: "limit=200", body: #"{ "outputs": [{ "id": "o", "type": "quiz", "title": "Q" }] }"#)
        StubStudioProtocol.route("/v1/outputs/o", body: #"{ "output": { "id": "o", "type": "quiz", "title": "Q", "payload": { "questions": [] } } }"#)
        StubStudioProtocol.route("/v1/projects/p%201/sources", query: "limit=200", body: #"{ "sources": [{ "id": "s", "kind": "pdf", "title": "Notes" }] }"#)
        StubStudioProtocol.route("/v1/sources/s", body: #"{ "source": { "id": "s", "title": "Notes" }, "extraction": { "status": "ready", "text": "Hello" }, "chunkCount": 1 }"#)
        let service = service()

        let plans = try await service.plans(inProject: "p 1")
        XCTAssertEqual(plans.first?.counts, StudioCounts(total: 3, done: 1))
        let plan = try await service.plan("pl")
        XCTAssertEqual(plan.plan.status, .running)
        let made = try await service.outputs(inProject: "p 1")
        XCTAssertEqual(made.map(\.type), ["quiz"])
        let output = try await service.output("o")
        XCTAssertEqual(output.payload?["questions"], .array([]))
        let sources = try await service.sources(inProject: "p 1")
        XCTAssertEqual(sources.first?.title, "Notes")
        let source = try await service.source("s")
        XCTAssertEqual(source.extraction?.text, "Hello")
    }

    func testAnIdNeverAddsPathSegments() {
        let url = EngineConfiguration(baseURL: URL(string: "https://engine.example.com"), clientToken: token)
            .apiURL(["plans", "a/b", "items", "c?d", "answer"])
        XCTAssertEqual(url?.absoluteString, "https://engine.example.com/v1/plans/a%2Fb/items/c%3Fd/answer")
    }

    func testAnAnswerIsPostedAsABoolean() async throws {
        StubStudioProtocol.route("/v1/plans/pl/items/i/answer", body: #"{ "item": {}, "counts": { "total": 1, "done": 0 } }"#)
        try await service().answer(planID: "pl", itemID: "i", answer: false)
        let request = try XCTUnwrap(StubStudioProtocol.requests.last)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(StubStudioProtocol.bodies.last)) as? [String: Bool]
        XCTAssertEqual(body, ["answer": false])
    }

    func testErrorsSayWhatHappened() async {
        // The Nov 10 engine has no Studio routes: it answers 404 "Route not found".
        StubStudioProtocol.route("/v1/projects", query: "limit=200", status: 404, body: #"{ "error": "not_found", "message": "Route not found" }"#)
        StubStudioProtocol.route("/v1/plans/pl/items/i/answer", status: 409, body: #"{ "error": "not_asking", "message": "…" }"#)
        StubStudioProtocol.route("/v1/plans/bad", body: "not json")

        await XCTAssertThrowsStudioError(try await self.service().projects(), .notFound)
        await XCTAssertThrowsStudioError(try await self.service().answer(planID: "pl", itemID: "i", answer: true),
                                         .http(status: 409, code: "not_asking"))
        await XCTAssertThrowsStudioError(try await self.service().plan("bad"), .unreadable)
        await XCTAssertThrowsStudioError(try await self.service(configured: false).projects(), .notConfigured)
        XCTAssertNil(service(configured: false).assetURL("a1"))
        XCTAssertEqual(service().assetURL("a1")?.absoluteString, "https://engine.example.com/v1/assets/a1")
    }

    private func XCTAssertThrowsStudioError<T>(_ expression: @autoclosure () async throws -> T, _ expected: StudioError,
                                               file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await expression()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? StudioError, expected, file: file, line: line)
        }
    }
}

/// Answers by path and query; records every request and its body.
private final class StubStudioProtocol: URLProtocol {
    private struct Answer { let status: Int; let body: Data }
    private static let lock = NSLock()
    private static var answers: [String: Answer] = [:]
    private static var recorded: [URLRequest] = []
    private static var recordedBodies: [Data] = []

    static var requests: [URLRequest] { lock.withLock { recorded } }
    static var bodies: [Data] { lock.withLock { recordedBodies } }

    static func route(_ path: String, query: String? = nil, status: Int = 200, body: String) {
        lock.withLock { answers[key(path, query)] = Answer(status: status, body: Data(body.utf8)) }
    }

    static func reset() {
        lock.withLock {
            answers = [:]
            recorded = []
            recordedBodies = []
        }
    }

    private static func key(_ path: String, _ query: String?) -> String { query.map { "\(path)?\($0)" } ?? path }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let path = components?.percentEncodedPath ?? url.path
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        } else if let data = request.httpBody {
            body = data
        }
        let answer = Self.lock.withLock { () -> Answer in
            Self.recorded.append(request)
            Self.recordedBodies.append(body)
            return Self.answers[Self.key(path, components?.query)]
                ?? Answer(status: 404, body: Data(#"{ "error": "not_found" }"#.utf8))
        }
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
