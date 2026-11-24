import Foundation
import OSLog

/// Done ticks, kept on the phone. The local tick is the truth: it shows at
/// once, survives offline and a refusal, and is sent to the engine when it
/// can be. Unsent ticks are retried on launch and whenever the app comes to
/// the foreground; there is no separate queue, an unsettled tick is the queue.
@MainActor
final class DoneTickStore: ObservableObject {
    static let defaultsKey = "doneTicks.v1"

    @Published private(set) var ticks: [String: DoneTick] = [:]

    private let defaults: UserDefaults
    private let syncer: any DoneTickSyncing
    private let sendsAtOnce: Bool
    private var isFlushing = false
    private let logger = Logger(subsystem: "app.opensourcebook", category: "DoneTicks")

    init(defaults: UserDefaults = .standard, syncer: any DoneTickSyncing = NoDoneTickSync(), sendsAtOnce: Bool = true) {
        self.sendsAtOnce = sendsAtOnce
        self.defaults = defaults
        self.syncer = syncer
        if let data = defaults.data(forKey: Self.defaultsKey),
           let saved = try? JSONDecoder().decode([DoneTick].self, from: data) {
            ticks = Dictionary(saved.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        }
    }

    func isDone(planID: String, itemID: String) -> Bool {
        ticks[DoneTick.key(planID: planID, itemID: itemID)] != nil
    }

    /// Ticks done in this plan.
    func doneCount(planID: String) -> Int {
        ticks.values.filter { $0.planID == planID }.count
    }

    /// Ticks the engine has not taken or refused yet.
    var pendingCount: Int { ticks.values.filter { !$0.isSettled }.count }

    /// Marks the output's plan item done. Does nothing for an output that is
    /// not part of a plan, or one already ticked without a new result. A
    /// result (a finished quiz) is kept with the tick and sent, also when the
    /// item was already ticked by moving past it.
    func markDone(_ output: Output, result: JSONValue? = nil, at date: Date = .now) {
        guard let position = output.plan else { return }
        let tick = DoneTick(planID: position.planID, itemID: position.nodeID,
                            outputID: output.id, doneAt: date, isSettled: false, result: result)
        if let existing = ticks[tick.key] {
            guard let result, existing.result != result else { return }
            ticks[tick.key]?.result = result
            ticks[tick.key]?.isSettled = false
            persist()
            if sendsAtOnce { Task { await flush() } }
            return
        }
        ticks[tick.key] = tick
        persist()
        if sendsAtOnce { Task { await flush() } }
    }

    /// Sends every unsettled tick, one after another. Safe to call often.
    func flush() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }
        let pending = ticks.values.filter { !$0.isSettled }.sorted { $0.doneAt < $1.doneAt }
        for tick in pending {
            switch await syncer.send(tick) {
            case .synced, .refused:
                ticks[tick.key]?.isSettled = true
            case .retryLater:
                continue
            }
        }
        persist()
    }

    /// Takes in what the engine has as done for a plan (ticks made on the
    /// web), so the phone shows them too. Local ticks are never removed.
    func refresh(planID: String) async {
        guard let remote = await syncer.doneItemIDs(planID: planID) else { return }
        takeRemote(planID: planID, doneItemIDs: remote)
    }

    /// Takes in items the engine has as done, read with the plan itself, so
    /// no second request is needed. Local ticks are never removed.
    func takeRemote(planID: String, doneItemIDs remote: Set<String>) {
        var changed = false
        for itemID in remote {
            let key = DoneTick.key(planID: planID, itemID: itemID)
            if ticks[key] == nil {
                ticks[key] = DoneTick(planID: planID, itemID: itemID, outputID: nil,
                                      doneAt: .now, isSettled: true)
                changed = true
            }
        }
        if changed { persist() }
    }

    private func persist() {
        do {
            defaults.set(try JSONEncoder().encode(Array(ticks.values)), forKey: Self.defaultsKey)
        } catch {
            logger.error("Could not save done ticks: \(error.localizedDescription, privacy: .public)")
        }
    }
}
