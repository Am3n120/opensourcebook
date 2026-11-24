import Foundation
import OSLog

/// Why a Studio read did not work.
enum StudioError: Error, Equatable, LocalizedError {
    /// No engine endpoint or client token on this phone.
    case notConfigured
    /// `404`: not there, not ours, or (for a list route) an engine that does
    /// not have the route yet.
    case notFound
    /// Any other HTTP answer, with the engine's error code when it sent one.
    case http(status: Int, code: String?)
    /// No answer at all (offline, timeout).
    case unreachable
    /// An answer this build could not read.
    case unreadable

    var errorDescription: String? {
        switch self {
        case .notConfigured: "No engine is set up on this phone."
        case .notFound: "The engine doesn't have this."
        case .http(let status, let code): "The engine answered \(code ?? "HTTP \(status)")."
        case .unreachable: "Couldn't reach the engine."
        case .unreadable: "The engine's answer couldn't be read."
        }
    }
}

/// The engine's Studio routes the phone reads (`engine/docs/api.md`), behind
/// a protocol so screens and stores can be tried with a fake.
protocol StudioClient: Sendable {
    var isConfigured: Bool { get }
    /// The person's projects, most recently updated first.
    func projects() async throws -> [StudioProject]
    /// A project's plans, oldest first, each with its counts.
    func plans(inProject projectID: String) async throws -> [StudioPlan]
    /// One plan with its stages and items in run order.
    func plan(_ planID: String) async throws -> StudioPlanView
    /// What was made in a project, newest first, without payloads.
    func outputs(inProject projectID: String) async throws -> [StudioOutputSummary]
    /// One made thing with its payload.
    func output(_ outputID: String) async throws -> StudioOutput
    func sources(inProject projectID: String) async throws -> [StudioSource]
    /// A source and its extracted text.
    func source(_ sourceID: String) async throws -> StudioSourceDetail
    /// Answers an "ask me" branch: true runs it, false skips it.
    func answer(planID: String, itemID: String, answer: Bool) async throws
    /// Where a harvested picture is served.
    func assetURL(_ assetID: String) -> URL?
}

/// The engine over HTTP, client token in `x-client-token`.
struct StudioService: StudioClient {
    let configuration: EngineConfiguration
    let session: URLSession

    init(configuration: EngineConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    private static let logger = Logger(subsystem: "app.opensourcebook", category: "Studio")
    /// List routes are read whole, a page of the largest size at a time, up
    /// to this many pages.
    static let maxPages = 10

    var isConfigured: Bool { configuration.isConfigured }

    func projects() async throws -> [StudioProject] {
        try await paged(["projects"], key: "projects")
    }

    func plans(inProject projectID: String) async throws -> [StudioPlan] {
        try await get(["projects", projectID, "plans"], as: Lists<StudioPlan>.self).plans?.elements ?? []
    }

    func plan(_ planID: String) async throws -> StudioPlanView {
        try await get(["plans", planID], as: StudioPlanView.self)
    }

    func outputs(inProject projectID: String) async throws -> [StudioOutputSummary] {
        try await paged(["projects", projectID, "outputs"], key: "outputs")
    }

    func output(_ outputID: String) async throws -> StudioOutput {
        struct Body: Decodable { let output: StudioOutput }
        return try await get(["outputs", outputID], as: Body.self).output
    }

    func sources(inProject projectID: String) async throws -> [StudioSource] {
        try await paged(["projects", projectID, "sources"], key: "sources")
    }

    func source(_ sourceID: String) async throws -> StudioSourceDetail {
        try await get(["sources", sourceID], as: StudioSourceDetail.self)
    }

    func answer(planID: String, itemID: String, answer: Bool) async throws {
        let body = try JSONEncoder().encode(["answer": answer])
        _ = try await send(["plans", planID, "items", itemID, "answer"], method: "POST", body: body)
    }

    func assetURL(_ assetID: String) -> URL? {
        configuration.assetURL(assetID)
    }

    // MARK: - HTTP

    /// Every list a route can answer with, keyed as api.md names them. Bad
    /// rows are skipped, not fatal.
    private struct Lists<Element: Decodable>: Decodable {
        var projects: LossyList<Element>?
        var plans: LossyList<Element>?
        var outputs: LossyList<Element>?
        var sources: LossyList<Element>?
        var nextCursor: String?

        func list(_ key: String) -> [Element] {
            switch key {
            case "projects": projects?.elements ?? []
            case "plans": plans?.elements ?? []
            case "outputs": outputs?.elements ?? []
            default: sources?.elements ?? []
            }
        }
    }

    private func paged<Element: Decodable>(_ path: [String], key: String) async throws -> [Element] {
        var all: [Element] = []
        var cursor: String?
        for _ in 0..<Self.maxPages {
            var query = [URLQueryItem(name: "limit", value: "200")]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            let page = try await get(path, query: query, as: Lists<Element>.self)
            all += page.list(key)
            guard let next = page.nextCursor, !next.isEmpty else { break }
            cursor = next
        }
        return all
    }

    private func get<Value: Decodable>(_ path: [String], query: [URLQueryItem] = [], as type: Value.Type) async throws -> Value {
        let data = try await send(path, query: query)
        do {
            return try StudioJSON.decoder.decode(Value.self, from: data)
        } catch {
            Self.logger.error("Studio answer not readable for /\(path.first ?? "", privacy: .public): \(String(describing: error), privacy: .public)")
            throw StudioError.unreadable
        }
    }

    private func send(_ path: [String], query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) async throws -> Data {
        guard let url = configuration.apiURL(path, query: query), let token = configuration.clientToken else {
            throw StudioError.notConfigured
        }
        var request = URLRequest(url: url, timeoutInterval: configuration.requestTimeout)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "x-client-token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            Self.logger.notice("Studio request failed: \(error.localizedDescription, privacy: .public)")
            throw StudioError.unreachable
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.error(status: status, body: data) }
        return data
    }

    static func error(status: Int, body: Data) -> StudioError {
        if status == 404 { return .notFound }
        struct Failure: Decodable { let error: String? }
        return .http(status: status, code: (try? JSONDecoder().decode(Failure.self, from: body))?.error)
    }
}

/// Where no engine is set up: every read says so.
struct NoStudio: StudioClient {
    var isConfigured: Bool { false }
    func projects() async throws -> [StudioProject] { throw StudioError.notConfigured }
    func plans(inProject projectID: String) async throws -> [StudioPlan] { throw StudioError.notConfigured }
    func plan(_ planID: String) async throws -> StudioPlanView { throw StudioError.notConfigured }
    func outputs(inProject projectID: String) async throws -> [StudioOutputSummary] { throw StudioError.notConfigured }
    func output(_ outputID: String) async throws -> StudioOutput { throw StudioError.notConfigured }
    func sources(inProject projectID: String) async throws -> [StudioSource] { throw StudioError.notConfigured }
    func source(_ sourceID: String) async throws -> StudioSourceDetail { throw StudioError.notConfigured }
    func answer(planID: String, itemID: String, answer: Bool) async throws { throw StudioError.notConfigured }
    func assetURL(_ assetID: String) -> URL? { nil }
}

/// A client that answers from a fixed set of engine answers. Tests use it;
/// a UI test hands one over through the launch environment
/// (`LaunchEnvironment.testStudioKey`). The app ships no answers of its own.
struct RecordedStudio: StudioClient, Codable, Equatable {
    var projectList: [StudioProject] = []
    /// Plans by project id.
    var plansByProject: [String: [StudioPlan]] = [:]
    /// Plan views by plan id.
    var planViews: [String: StudioPlanView] = [:]
    /// Full outputs by output id.
    var outputsByID: [String: StudioOutput] = [:]
    /// Sources by project id.
    var sourcesByProject: [String: [StudioSource]] = [:]
    /// Source details by source id.
    var sourceDetails: [String: StudioSourceDetail] = [:]

    var isConfigured: Bool { true }

    func projects() async throws -> [StudioProject] { projectList }

    func plans(inProject projectID: String) async throws -> [StudioPlan] {
        guard projectList.contains(where: { $0.id == projectID }) else { throw StudioError.notFound }
        return plansByProject[projectID] ?? []
    }

    func plan(_ planID: String) async throws -> StudioPlanView {
        guard let view = planViews[planID] else { throw StudioError.notFound }
        return view
    }

    func outputs(inProject projectID: String) async throws -> [StudioOutputSummary] {
        outputsByID.values
            .filter { $0.projectId == projectID }
            .sorted { ($0.createdAt ?? .distantPast, $0.id) > ($1.createdAt ?? .distantPast, $1.id) }
            .map { StudioOutputSummary(id: $0.id, type: $0.type, title: $0.title, summary: $0.summary,
                                       projectId: $0.projectId, planId: $0.planId, itemId: $0.itemId,
                                       schemaVersion: $0.schemaVersion, createdAt: $0.createdAt) }
    }

    func output(_ outputID: String) async throws -> StudioOutput {
        guard let output = outputsByID[outputID] else { throw StudioError.notFound }
        return output
    }

    func sources(inProject projectID: String) async throws -> [StudioSource] { sourcesByProject[projectID] ?? [] }

    func source(_ sourceID: String) async throws -> StudioSourceDetail {
        guard let detail = sourceDetails[sourceID] else { throw StudioError.notFound }
        return detail
    }

    func answer(planID: String, itemID: String, answer: Bool) async throws {
        guard planViews[planID]?.items.contains(where: { $0.id == itemID && $0.asking != nil }) == true else {
            throw StudioError.http(status: 409, code: "not_asking")
        }
    }

    func assetURL(_ assetID: String) -> URL? { nil }

    static func decode(_ data: Data) throws -> RecordedStudio {
        try StudioJSON.decoder.decode(RecordedStudio.self, from: data)
    }
}
