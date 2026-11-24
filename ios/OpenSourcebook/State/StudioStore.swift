import Foundation
import OSLog

/// Everything read from the engine's Studio routes, as last fetched. Kept on
/// disk so what was fetched stays readable offline.
struct StudioSnapshot: Codable, Equatable, Sendable {
    /// The engine it came from (its origin), so another engine's answers are never shown.
    var engine: String?
    var projects: [StudioProject] = []
    var plans: [String: [StudioPlan]] = [:]
    var planViews: [String: StudioPlanView] = [:]
    var madeThings: [String: [StudioOutputSummary]] = [:]
    var sources: [String: [StudioSource]] = [:]
    /// When each part was last fetched: `projects`, `project:<id>`, `plan:<id>`.
    var fetchedAt: [String: Date] = [:]
}

/// The phone's view of the web Studio: projects, their plans, made things
/// and sources, read from the engine and never edited here (DECISIONS.md
/// #10). Reads are explicit: a screen asks once when it first appears in a
/// launch, and pull to refresh asks again. Made things a plan needs are
/// fetched once and kept in `OutputStore`, so the players, done ticks and the
/// Library treat them like anything else on the phone.
@MainActor
final class StudioStore: ObservableObject {
    /// Whether the engine can answer Studio reads at all.
    enum Reach: Equatable, Sendable {
        case unknown
        case available
        /// No engine endpoint or token on this phone.
        case notConfigured
        /// The engine answers but has no Studio routes (an engine older than Nov 12, 2026).
        case noStudio
    }

    @Published private(set) var snapshot: StudioSnapshot
    @Published private(set) var reach: Reach = .unknown
    /// Why the last read of a part failed, by the part's key.
    @Published private(set) var failures: [String: String] = [:]
    /// Parts being read now.
    @Published private(set) var reading: Set<String> = []

    let client: any StudioClient
    private let outputs: OutputStore
    private let doneTicks: DoneTickStore?
    private let cacheURL: URL?
    private let engineKey: String?
    private var readThisLaunch: Set<String> = []
    private var sourceDetails: [String: StudioSourceDetail] = [:]
    private let logger = Logger(subsystem: "app.opensourcebook", category: "Studio")

    /// `cacheURL` nil keeps everything in memory (tests, previews).
    init(client: any StudioClient, outputs: OutputStore, doneTicks: DoneTickStore? = nil,
         cacheURL: URL? = nil, engineKey: String? = nil) {
        self.client = client
        self.outputs = outputs
        self.doneTicks = doneTicks
        self.cacheURL = cacheURL
        self.engineKey = engineKey
        var loaded = StudioSnapshot(engine: engineKey)
        if let cacheURL, let data = try? Data(contentsOf: cacheURL),
           let saved = try? StudioJSON.decoder.decode(StudioSnapshot.self, from: data),
           saved.engine == engineKey {
            loaded = saved
        }
        snapshot = loaded
        if !client.isConfigured { reach = .notConfigured }
    }

    /// Where the snapshot is kept between launches.
    static var defaultCacheURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Studio", isDirectory: true)
            .appendingPathComponent("snapshot.json", isDirectory: false)
    }

    // MARK: - Reading what was fetched

    var projects: [StudioProject] { snapshot.projects }

    func project(_ id: String) -> StudioProject? { snapshot.projects.first { $0.id == id } }

    /// Nil until the project's plans were fetched once.
    func plans(inProject id: String) -> [StudioPlan]? { snapshot.plans[id] }

    func planView(_ id: String) -> StudioPlanView? { snapshot.planViews[id] }

    func madeThings(inProject id: String) -> [StudioOutputSummary]? { snapshot.madeThings[id] }

    func sources(inProject id: String) -> [StudioSource]? { snapshot.sources[id] }

    /// A source's name, from any project's source list or a source read for a citation.
    func sourceName(_ sourceID: String) -> String? {
        if let detail = sourceDetails[sourceID], let title = detail.displayTitle { return title }
        for list in snapshot.sources.values {
            if let source = list.first(where: { $0.id == sourceID }), let title = source.title, !title.isEmpty { return title }
        }
        return nil
    }

    func isReading(_ key: String) -> Bool { reading.contains(key) }

    func failure(_ key: String) -> String? { failures[key] }

    func fetchedAt(_ key: String) -> Date? { snapshot.fetchedAt[key] }

    static func projectKey(_ id: String) -> String { "project:\(id)" }
    static func planKey(_ id: String) -> String { "plan:\(id)" }
    static let projectsKey = "projects"

    // MARK: - Fetching

    /// Reads a part the first time a screen shows it in this launch; later
    /// reads are the person's pull to refresh.
    func readOnce(_ key: String, _ read: () async -> Void) async {
        guard readThisLaunch.insert(key).inserted else { return }
        await read()
    }

    func refreshProjects() async {
        await read(Self.projectsKey) {
            let projects = try await client.projects()
            snapshot.projects = projects
        }
    }

    /// A project's plans, made things and sources, read side by side.
    func refreshProject(_ id: String) async {
        await read(Self.projectKey(id)) {
            async let plans = client.plans(inProject: id)
            async let made = client.outputs(inProject: id)
            async let sources = client.sources(inProject: id)
            let (p, m, s) = try await (plans, made, sources)
            snapshot.plans[id] = p
            snapshot.madeThings[id] = m
            snapshot.sources[id] = s
        }
    }

    /// One plan, then the made things it names that the phone does not hold yet.
    func refreshPlan(_ id: String) async {
        await read(Self.planKey(id)) {
            let view = try await client.plan(id)
            snapshot.planViews[id] = view
            if var list = snapshot.plans[view.plan.projectId], let index = list.firstIndex(where: { $0.id == id }) {
                list[index] = view.plan.with(counts: view.counts ?? list[index].counts)
                snapshot.plans[view.plan.projectId] = list
            }
            doneTicks?.takeRemote(planID: id, doneItemIDs: Set(view.items.filter(\.done).map(\.id)))
            await fetchMissingOutputs(of: view)
        }
    }

    /// Fetches every made thing of the plan the phone does not hold, a few at
    /// a time. One that fails stays missing; the plan shows it as not here yet.
    private func fetchMissingOutputs(of view: StudioPlanView) async {
        let wanted: [(String, PlanPosition)] = view.items.compactMap { item in
            guard let outputID = item.outputId, let uuid = item.outputUUID else { return nil }
            let position = PlanPosition(planID: view.plan.id, nodeID: item.id, level: item.level, ord: item.ord)
            if let held = outputs.output(forID: uuid), held.plan == position { return nil }
            return (outputID, position)
        }
        guard !wanted.isEmpty else { return }
        let client = client
        await withTaskGroup(of: (StudioOutput, PlanPosition)?.self) { group in
            var next = wanted.makeIterator()
            func add() {
                guard let (outputID, position) = next.next() else { return }
                group.addTask { (try? await client.output(outputID)).map { ($0, position) } }
            }
            for _ in 0..<4 { add() }
            while let finished = await group.next() {
                if let (made, position) = finished, let output = made.playable(at: position) {
                    outputs.upsert(output)
                }
                add()
            }
        }
    }

    /// A made thing listed in a project, fetched once and kept. Nil when it
    /// can't be fetched or played.
    func output(for summary: StudioOutputSummary) async -> Output? {
        if let uuid = summary.uuid, let held = outputs.output(forID: uuid) { return held }
        do {
            let made = try await client.output(summary.id)
            var position: PlanPosition?
            if let planID = made.planId, let itemID = made.itemId,
               let item = snapshot.planViews[planID]?.items.first(where: { $0.id == itemID }) {
                position = PlanPosition(planID: planID, nodeID: itemID, level: item.level, ord: item.ord)
            }
            guard let output = made.playable(at: position) else { return nil }
            outputs.upsert(output)
            return output
        } catch {
            logger.notice("Made thing not fetched: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Answers an "ask me" branch, then reads the plan again so the branch
    /// shows what the answer did. False when the engine did not take it.
    func answer(planID: String, itemID: String, answer: Bool) async -> Bool {
        do {
            try await client.answer(planID: planID, itemID: itemID, answer: answer)
            failures[Self.planKey(planID)] = nil
            await refreshPlan(planID)
            return true
        } catch {
            failures[Self.planKey(planID)] = Self.message(for: error)
            return false
        }
    }

    /// A source with its text, read once per launch, for showing a cited spot.
    func sourceDetail(_ sourceID: String) async -> StudioSourceDetail? {
        if let held = sourceDetails[sourceID] { return held }
        guard let detail = try? await client.source(sourceID) else { return nil }
        sourceDetails[sourceID] = detail
        return detail
    }

    // MARK: - Plumbing

    private func read(_ key: String, _ work: () async throws -> Void) async {
        guard client.isConfigured else {
            reach = .notConfigured
            return
        }
        reading.insert(key)
        defer { reading.remove(key) }
        do {
            try await work()
            reach = .available
            failures[key] = nil
            snapshot.fetchedAt[key] = .now
            save()
        } catch is CancellationError {
            return
        } catch StudioError.notFound where key == Self.projectsKey {
            // The project list is always there on an engine with the Studio
            // routes; a 404 means this engine predates them.
            reach = .noStudio
            failures[key] = nil
        } catch {
            logger.notice("Studio read \(key, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            failures[key] = Self.message(for: error)
        }
    }

    static func message(for error: Error) -> String {
        switch error as? StudioError {
        case .notFound: "The engine doesn't have this any more."
        case .unreachable: "Couldn't reach the engine. Showing what was fetched before."
        case .notConfigured: "No engine is set up on this phone."
        case .some(let other): other.localizedDescription
        case nil: error.localizedDescription
        }
    }

    private func save() {
        guard let cacheURL else { return }
        do {
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try StudioJSON.encoder.encode(snapshot).write(to: cacheURL, options: .atomic)
        } catch {
            logger.error("Studio snapshot not saved: \(error.localizedDescription, privacy: .public)")
        }
    }
}

extension StudioPlan {
    func with(counts: StudioCounts?) -> StudioPlan {
        var copy = self
        copy.counts = counts
        return copy
    }
}
