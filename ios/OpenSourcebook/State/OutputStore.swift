import Foundation
import OSLog
import SwiftData

/// Per-output state the user attaches to an output (not part of the output
/// itself): filing, favorites, archive, reading position.
struct OutputMeta: Equatable, Sendable {
    var isFiled = false
    var isFavorite = false
    var isArchived = false
    var readPosition = 0
    var lastOpenedAt: Date?
}

/// Source of truth for outputs, projects and capture jobs, backed by SwiftData.
/// Injected as an `.environmentObject` at the app root. The no-context
/// initializer keeps previews and tests in memory. UI state (tabs, sheets,
/// player) lives in `AppState`, not here.
@MainActor
final class OutputStore: ObservableObject {

    /// Outputs that are not archived, newest first.
    @Published private(set) var outputs: [Output] = []
    /// Archived outputs, newest first.
    @Published private(set) var archivedOutputs: [Output] = []
    /// Per-output user state, keyed by output id. Covers archived outputs too.
    @Published private(set) var meta: [UUID: OutputMeta] = [:]
    /// Projects, alphabetical.
    @Published private(set) var projects: [Project] = []
    /// Capture jobs, most recently updated first.
    @Published private(set) var jobs: [PersistedCaptureJob] = []

    private let modelContext: ModelContext?
    private let logger = Logger(subsystem: "app.opensourcebook", category: "OutputStore")
    private var outputRecords: [UUID: PersistedOutputRecord] = [:]
    private var projectRecords: [String: PersistedProjectRecord] = [:]
    /// Every output, archived or not.
    private var outputIndex: [UUID: Output] = [:]

    /// In-memory store for previews and tests.
    init() {
        self.modelContext = nil
    }

    /// Store backed by SwiftData.
    init(modelContext: ModelContext) {
        self.modelContext = modelContext
        loadPersistedState()
    }

    // MARK: - Reading

    func output(forID id: UUID) -> Output? {
        outputIndex[id]
    }

    func meta(for id: UUID) -> OutputMeta {
        meta[id] ?? OutputMeta()
    }

    func isFavorite(_ id: UUID) -> Bool { meta(for: id).isFavorite }

    /// Active outputs in a project, newest first.
    func outputs(inProject projectID: String) -> [Output] {
        outputs.filter { $0.projectID == projectID }
    }

    /// Confirmed singles: no project and filed out of the Inbox, newest first.
    var singles: [Output] {
        outputs.filter { $0.projectID == nil && meta(for: $0.id).isFiled }
    }

    /// Unfiled outputs: the Inbox (DECISIONS.md #8).
    var inbox: [Output] {
        outputs.filter { !meta(for: $0.id).isFiled }
    }

    /// Outputs opened before, most recent first, for Home's "Recently opened" row.
    var recentlyOpened: [Output] {
        outputs
            .filter { meta(for: $0.id).lastOpenedAt != nil }
            .sorted { (meta(for: $0.id).lastOpenedAt ?? .distantPast) > (meta(for: $1.id).lastOpenedAt ?? .distantPast) }
    }

    func project(forID id: String?) -> Project? {
        guard let id else { return nil }
        return projects.first { $0.id == id }
    }

    func outputCount(inProject projectID: String) -> Int {
        outputs.reduce(0) { $0 + ($1.projectID == projectID ? 1 : 0) }
    }

    /// Jobs that have not finished, most recently updated first.
    var activeJobs: [PersistedCaptureJob] {
        jobs.filter { !$0.stage.isFinished }
    }

    func jobs(inProject projectID: String?) -> [PersistedCaptureJob] {
        jobs.filter { $0.projectID == projectID }
    }

    // MARK: - Outputs

    /// Inserts or replaces an output. New outputs land unfiled unless they
    /// belong to a project.
    func upsert(_ output: Output) {
        let isNew = outputIndex[output.id] == nil
        outputIndex[output.id] = output
        if let modelContext {
            if let record = outputRecords[output.id] {
                do { try record.update(output: output) } catch {
                    logger.error("Failed to encode output \(output.id): \(error.localizedDescription)")
                }
            } else {
                let record = PersistedOutputRecord(output: output, isFiled: output.projectID != nil, createdAt: output.createdAt)
                modelContext.insert(record)
                outputRecords[output.id] = record
            }
        }
        if isNew {
            var state = meta[output.id] ?? OutputMeta()
            state.isFiled = state.isFiled || output.projectID != nil
            meta[output.id] = state
        }
        rebuildOutputLists()
        saveContext()
    }

    /// Files an output into a project (or confirms it as a single when
    /// `projectID` is nil). Either way it leaves the Inbox.
    func file(_ id: UUID, into projectID: String?) {
        guard var output = outputIndex[id] else { return }
        if let projectID, project(forID: projectID) == nil { return }
        output.projectID = projectID
        outputIndex[id] = output
        if let record = outputRecords[id] {
            do { try record.update(output: output) } catch {
                logger.error("Failed to encode output \(id): \(error.localizedDescription)")
            }
            record.isFiled = true
        }
        meta[id, default: OutputMeta()].isFiled = true
        rebuildOutputLists()
        saveContext()
    }

    func setFavorite(_ isFavorite: Bool, for id: UUID) {
        guard outputIndex[id] != nil else { return }
        outputRecords[id]?.isFavorite = isFavorite
        outputRecords[id]?.updatedAt = .now
        meta[id, default: OutputMeta()].isFavorite = isFavorite
        saveContext()
    }

    func archive(_ id: UUID) {
        setArchived(true, for: id)
    }

    func unarchive(_ id: UUID) {
        setArchived(false, for: id)
    }

    private func setArchived(_ isArchived: Bool, for id: UUID) {
        guard outputIndex[id] != nil else { return }
        outputRecords[id]?.isArchived = isArchived
        outputRecords[id]?.updatedAt = .now
        meta[id, default: OutputMeta()].isArchived = isArchived
        rebuildOutputLists()
        saveContext()
    }

    func delete(_ id: UUID) {
        guard outputIndex[id] != nil else { return }
        if let record = outputRecords.removeValue(forKey: id) {
            modelContext?.delete(record)
        }
        outputIndex.removeValue(forKey: id)
        meta.removeValue(forKey: id)
        rebuildOutputLists()
        saveContext()
    }

    /// Records that the user opened an output, for "continue".
    func markOpened(_ id: UUID) {
        guard outputIndex[id] != nil else { return }
        let now = Date.now
        outputRecords[id]?.lastOpenedAt = now
        meta[id, default: OutputMeta()].lastOpenedAt = now
        saveContext()
    }

    func saveReadPosition(_ index: Int, for id: UUID) {
        guard outputIndex[id] != nil else { return }
        outputRecords[id]?.readPosition = index
        meta[id, default: OutputMeta()].readPosition = index
        saveContext()
    }

    // MARK: - Projects

    @discardableResult
    func createProject(title: String, icon: String = "folder", colorHex: UInt32 = Project.paletteHex[0]) -> Project {
        let project = Project(title: title, icon: icon, colorHex: colorHex)
        if let modelContext {
            let record = PersistedProjectRecord(project: project)
            modelContext.insert(record)
            projectRecords[project.id] = record
        }
        projects.append(project)
        sortProjects()
        saveContext()
        return project
    }

    func updateProject(_ project: Project) {
        guard let index = projects.firstIndex(where: { $0.id == project.id }) else { return }
        var updated = project
        updated.updatedAt = .now
        projects[index] = updated
        projectRecords[project.id]?.apply(updated)
        sortProjects()
        saveContext()
    }

    /// Deletes a project. Its outputs stay and go back to the Inbox.
    func deleteProject(_ id: String) {
        guard projects.contains(where: { $0.id == id }) else { return }
        if let record = projectRecords.removeValue(forKey: id) {
            modelContext?.delete(record)
        }
        projects.removeAll { $0.id == id }
        for (outputID, output) in outputIndex where output.projectID == id {
            var moved = output
            moved.projectID = nil
            outputIndex[outputID] = moved
            if let record = outputRecords[outputID] {
                try? record.update(output: moved)
                record.isFiled = false
            }
            meta[outputID, default: OutputMeta()].isFiled = false
        }
        for job in jobs where job.projectID == id {
            job.destination = .inbox
            job.updatedAt = .now
        }
        rebuildOutputLists()
        saveContext()
    }

    // MARK: - Capture jobs

    /// Queues a capture. Pass `id` when the capture already has a stable id
    /// (a share-inbox item) so handing it over twice cannot queue it twice.
    @discardableResult
    func enqueueJob(
        id: UUID = UUID(),
        sourceText: String,
        sourceURL: String? = nil,
        sourceKind: String,
        destination: CaptureDestination
    ) -> PersistedCaptureJob {
        if let existing = job(id) { return existing }
        let job = PersistedCaptureJob(
            id: id,
            sourceText: sourceText,
            sourceURL: sourceURL,
            sourceKind: sourceKind,
            destination: destination
        )
        modelContext?.insert(job)
        jobs.append(job)
        sortJobs()
        saveContext()
        return job
    }

    func job(_ id: UUID) -> PersistedCaptureJob? {
        jobs.first { $0.id == id }
    }

    func updateJob(
        _ id: UUID,
        stage: CaptureJobStage,
        progress: Double? = nil,
        errorMessage: String? = nil,
        resultOutputID: UUID? = nil
    ) {
        guard let job = job(id) else { return }
        job.stage = stage
        if let progress {
            job.progress = min(max(progress, 0), 1)
        } else if stage == .done {
            job.progress = 1
        }
        job.errorMessage = errorMessage
        if let resultOutputID {
            job.resultOutputID = resultOutputID
        }
        job.updatedAt = .now
        sortJobs()
        saveContext()
    }

    /// Stores a finished engine result and closes its job. Idempotent: a
    /// repeated delivery replaces the same output and changes nothing else.
    func completeJob(_ id: UUID, with result: Output) {
        guard let job = job(id) else { return }
        var output = result
        output.projectID = job.projectID
        upsert(output)
        updateJob(id, stage: .done, progress: 1, errorMessage: nil, resultOutputID: output.id)
    }

    /// Returns a failed or stuck job to the queue.
    @discardableResult
    func retryJob(_ id: UUID) -> PersistedCaptureJob? {
        guard let job = job(id) else { return nil }
        job.stage = .queued
        job.progress = 0
        job.errorMessage = nil
        job.resultOutputID = nil
        job.retryCount += 1
        job.updatedAt = .now
        sortJobs()
        saveContext()
        return job
    }

    func deleteJob(_ id: UUID) {
        guard let job = job(id) else { return }
        modelContext?.delete(job)
        jobs.removeAll { $0.id == id }
        saveContext()
    }

    // MARK: - Loading

    private func loadPersistedState() {
        guard let modelContext else { return }

        do {
            let records = try modelContext.fetch(FetchDescriptor<PersistedOutputRecord>())
            load(records: records)
        } catch {
            logger.error("Failed to fetch outputs: \(error.localizedDescription)")
        }

        do {
            let records = try modelContext.fetch(FetchDescriptor<PersistedProjectRecord>())
            projectRecords = Dictionary(records.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            projects = records.map(\.project)
            sortProjects()
        } catch {
            logger.error("Failed to fetch projects: \(error.localizedDescription)")
        }

        do {
            jobs = try modelContext.fetch(FetchDescriptor<PersistedCaptureJob>())
            sortJobs()
        } catch {
            logger.error("Failed to fetch capture jobs: \(error.localizedDescription)")
        }
    }

    private func load(records: [PersistedOutputRecord]) {
        var seen = Set<UUID>()
        for record in records {
            do {
                let output = try record.decodeOutput()
                guard output.id == record.id else {
                    logger.error("Skipping output record \(record.id): payload id is \(output.id)")
                    continue
                }
                guard seen.insert(record.id).inserted else { continue }
                outputRecords[record.id] = record
                outputIndex[record.id] = output
                meta[record.id] = OutputMeta(
                    isFiled: record.isFiled,
                    isFavorite: record.isFavorite,
                    isArchived: record.isArchived,
                    readPosition: record.readPosition,
                    lastOpenedAt: record.lastOpenedAt
                )
            } catch {
                logger.error("Failed to decode output \(record.id): \(error.localizedDescription)")
            }
        }
        rebuildOutputLists()
    }

    private func rebuildOutputLists() {
        let all = outputIndex.values.sorted { lhs, rhs in
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
            return lhs.id.uuidString < rhs.id.uuidString
        }
        outputs = all.filter { !meta(for: $0.id).isArchived }
        archivedOutputs = all.filter { meta(for: $0.id).isArchived }
    }

    private func sortProjects() {
        projects.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    private func sortJobs() {
        jobs.sort { lhs, rhs in
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return lhs.id.uuidString < rhs.id.uuidString
        }
    }

    private func saveContext() {
        guard let modelContext else { return }
        do {
            try modelContext.save()
        } catch {
            logger.error("Failed to save: \(error.localizedDescription)")
        }
    }
}
