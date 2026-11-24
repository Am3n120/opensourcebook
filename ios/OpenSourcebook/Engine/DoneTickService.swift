import Foundation
import OSLog

/// One finished item: the person finished it or swiped past it. Plans have
/// order and done ticks only (DECISIONS.md), so a tick, with a quiz's result
/// where there is one, is all there is to remember about progress.
struct DoneTick: Codable, Hashable, Sendable {
    var planID: String
    var itemID: String
    /// Nil for a tick that came from the engine (made on the web).
    var outputID: UUID?
    /// When it happened on this phone. The engine stamps its own time on arrival.
    var doneAt: Date
    /// False until the engine has taken it or refused it for good.
    var isSettled: Bool
    /// What the person got, for an item that has one (a finished quiz's
    /// score); the engine stores it and later items can branch on it.
    var result: JSONValue? = nil

    var key: String { DoneTick.key(planID: planID, itemID: itemID) }

    static func key(planID: String, itemID: String) -> String { "\(planID)/\(itemID)" }
}

enum DoneTickOutcome: Equatable, Sendable {
    /// The engine has it.
    case synced
    /// Not now (offline, server trouble, item not ready yet): try again later.
    case retryLater
    /// The engine will never take this one (not ours, mismatched output). The
    /// local tick stays; the request is dropped.
    case refused
}

/// Sends ticks to the engine and reads back which items it has as done.
protocol DoneTickSyncing: Sendable {
    func send(_ tick: DoneTick) async -> DoneTickOutcome
    /// Item ids the engine has done for the plan, or nil when it can't say.
    func doneItemIDs(planID: String) async -> Set<String>?
}

/// The engine's C3 routes: `POST /v1/plans/:id/items/:itemId/done` and
/// `GET /v1/plans/:id/progress`, client token in `x-client-token`.
struct DoneTickService: DoneTickSyncing {
    let configuration: EngineConfiguration
    let session: URLSession

    init(configuration: EngineConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    private static let logger = Logger(subsystem: "app.opensourcebook", category: "DoneTicks")

    func send(_ tick: DoneTick) async -> DoneTickOutcome {
        guard let url = configuration.doneURL(planID: tick.planID, itemID: tick.itemID),
              let token = configuration.clientToken else { return .retryLater }
        var request = URLRequest(url: url, timeoutInterval: configuration.requestTimeout)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "x-client-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try? JSONEncoder().encode(Self.body(for: tick))
        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let outcome = Self.outcome(forStatus: status)
            if outcome != .synced {
                Self.logger.notice("Done tick answered HTTP \(status, privacy: .public)")
            }
            return outcome
        } catch {
            Self.logger.notice("Done tick not sent: \(error.localizedDescription, privacy: .public)")
            return .retryLater
        }
    }

    struct Body: Encodable, Equatable {
        let done: Bool
        let outputId: String?
        let result: JSONValue?
    }

    static func body(for tick: DoneTick) -> Body {
        Body(done: true, outputId: tick.outputID?.uuidString.lowercased(), result: tick.result)
    }

    /// 2xx is taken. 400, 404 and 413 will not change by waiting. Everything
    /// else (409 plan_not_started or item_not_ready, auth, 429, 5xx) may.
    static func outcome(forStatus status: Int) -> DoneTickOutcome {
        switch status {
        case 200..<300: .synced
        case 400, 404, 413: .refused
        default: .retryLater
        }
    }

    func doneItemIDs(planID: String) async -> Set<String>? {
        guard let url = configuration.progressURL(planID: planID),
              let token = configuration.clientToken else { return nil }
        var request = URLRequest(url: url, timeoutInterval: configuration.requestTimeout)
        request.setValue(token, forHTTPHeaderField: "x-client-token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return try Self.doneItemIDs(fromProgress: data)
        } catch {
            Self.logger.notice("Progress not read: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    static func doneItemIDs(fromProgress data: Data) throws -> Set<String> {
        struct Progress: Decodable {
            struct Item: Decodable { let id: String; let done: Bool }
            let items: [Item]
        }
        let progress = try JSONDecoder().decode(Progress.self, from: data)
        return Set(progress.items.filter(\.done).map(\.id))
    }
}

/// Used where no engine is configured (tests, previews): every tick waits.
struct NoDoneTickSync: DoneTickSyncing {
    func send(_ tick: DoneTick) async -> DoneTickOutcome { .retryLater }
    func doneItemIDs(planID: String) async -> Set<String>? { nil }
}
