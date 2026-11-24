import Combine
import Foundation
import OSLog

/// Main-actor coordinator between durable local capture jobs and the Open Sourcebook engine.
///
/// The service owns no data: `OutputStore` remains the source of truth, so
/// stopping the service or relaunching the app cannot lose a queued job. A POST
/// always uses the local job UUID as its idempotency key. After a relaunch, the
/// client can submit that same key again and recover the existing remote job.
@MainActor
final class GenerationService: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var lastError: String?
    @Published private(set) var statusMessage: String
    @Published private(set) var configuration: EngineConfiguration

    private let store: OutputStore
    private let logger = Logger(subsystem: "app.opensourcebook", category: "GenerationService")
    private let session: URLSession
    private var processingTask: Task<Void, Never>?
    private var isProcessingPass = false
    private var processingPassGeneration: Int?
    private var configurationGeneration = 0

    enum ConnectionResult: Equatable {
        case connected
        case failed(String)

        var message: String {
            switch self {
            case .connected:
                return "Connected to the Open Sourcebook engine."
            case let .failed(message):
                return message
            }
        }
    }

    /// Remote IDs are intentionally ephemeral. If the app is relaunched, the
    /// idempotent POST reconstructs this map from the worker's durable store.
    private var remoteJobIDs: [UUID: String] = [:]
    private var lastRemoteRetryCounts: [UUID: Int] = [:]
    /// Failed jobs already given their one automatic recovery pass this session.
    private var failedRecoveryAttempted: Set<UUID> = []

    init(
        store: OutputStore,
        configuration: EngineConfiguration = .current,
        session: URLSession = .shared
    ) {
        self.store = store
        self.configuration = configuration
        self.session = session
        self.statusMessage = configuration.statusMessage
    }

    /// Whether the service can submit work. False means no network call is made.
    var isConfigured: Bool { configuration.isConfigured }

    /// Starts a lightweight foreground loop. Networking never blocks app launch.
    func start() {
        guard processingTask == nil else { return }
        isRunning = true
        statusMessage = configuration.statusMessage
        let loopGeneration = configurationGeneration

        processingTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard self.configurationGeneration == loopGeneration else { break }
                await self.processPendingJobs()
                if Task.isCancelled { break }
                do {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                } catch {
                    break
                }
            }
            self.finishProcessingLoop(for: loopGeneration)
        }
    }

    /// Stops polling and leaves durable jobs in their latest honest state.
    func stop() {
        processingTask?.cancel()
        processingTask = nil
        isRunning = false
    }

    /// Cancels a capture job end-to-end: best-effort server cancellation (so the
    /// worker stops spending tokens on it), then removal of the local record.
    /// Safe when the remote ID is unknown or the engine is unconfigured — the
    /// local job is still removed, and a cancelled remote job can never deliver.
    func cancelGeneration(for jobID: UUID) async {
        if let remoteID = remoteJobIDs[jobID],
           let baseURL = configuration.baseURL,
           let token = configuration.clientToken,
           configuration.isConfigured {
            var request = URLRequest(url: baseURL
                .appendingPathComponent("v1", isDirectory: true)
                .appendingPathComponent("jobs", isDirectory: true)
                .appendingPathComponent(remoteID, isDirectory: false)
                .appendingPathComponent("cancel", isDirectory: false))
            request.httpMethod = "POST"
            request.setValue(token, forHTTPHeaderField: "X-Client-Token")
            request.timeoutInterval = configuration.requestTimeout
            // Best-effort: local removal must not depend on network success.
            _ = try? await session.data(for: request)
        }
        remoteJobIDs.removeValue(forKey: jobID)
        lastRemoteRetryCounts.removeValue(forKey: jobID)
        failedRecoveryAttempted.remove(jobID)
        store.deleteJob(jobID)
    }

    /// Re-reads UserDefaults, then restarts the foreground loop if it was active.
    /// The old task is cancelled before any work can use the new configuration.
    func reloadConfiguration() {
        let shouldRestart = isRunning
        stop()
        configurationGeneration += 1
        remoteJobIDs.removeAll()
        lastRemoteRetryCounts.removeAll()
        failedRecoveryAttempted.removeAll()
        configuration = .current
        statusMessage = configuration.statusMessage
        lastError = nil
        if shouldRestart {
            start()
        }
    }

    /// Checks the configured worker's `/health` route without creating a job.
    func testConnection() async -> ConnectionResult {
        guard let url = configuration.healthURL else {
            return .failed("Enter a valid HTTPS engine endpoint before testing.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = configuration.requestTimeout

        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .failed("The engine returned an invalid HTTP response.")
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let detail = (try? JSONDecoder().decode(EngineErrorEnvelope.self, from: data))?.message
                return .failed(detail ?? "The engine health check failed with HTTP \(httpResponse.statusCode).")
            }
            guard let health = try? JSONDecoder().decode(EngineHealthEnvelope.self, from: data), health.ok else {
                return .failed("The engine health check returned an unexpected response.")
            }
            return .connected
        } catch is CancellationError {
            return .failed("The engine health check was cancelled.")
        } catch {
            let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            return .failed(message.isEmpty ? "The engine health check could not be completed." : message)
        }
    }

    /// Processes every queued or in-flight local job once.
    ///
    /// The app calls this repeatedly while active. The method is public so a
    /// single pass can be driven without starting the foreground loop.
    func processPendingJobs() async {
        guard !isProcessingPass || processingPassGeneration != configurationGeneration else { return }
        isProcessingPass = true
        let processingConfiguration = configuration
        let processingGeneration = configurationGeneration
        processingPassGeneration = processingGeneration
        defer {
            if processingPassGeneration == processingGeneration {
                isProcessingPass = false
                processingPassGeneration = nil
            }
        }
        guard processingConfiguration.isConfigured else {
            statusMessage = processingConfiguration.statusMessage
            lastError = nil
            return
        }

        guard configurationGeneration == processingGeneration else { return }
        statusMessage = processingConfiguration.statusMessage
        let jobs = store.jobs
            .filter { job in
                guard job.resultOutputID == nil else { return false }
                switch job.stage {
                case .queued, .extracting, .researching, .structuring, .writing, .verifying:
                    return true
                case .done:
                    return false
                case .failed:
                    // A job can be latched failed locally while the remote job
                    // later succeeds (e.g. engine redeploy mid-poll). Give each
                    // failed job one automatic recovery pass per session: the
                    // idempotent re-POST either delivers the finished output or
                    // confirms the failure, without looping forever.
                    return !failedRecoveryAttempted.contains(job.id)
                }
            }
            .map(PendingCaptureJob.init)

        for job in jobs {
            guard !Task.isCancelled, configurationGeneration == processingGeneration else { return }
            await process(
                job,
                configuration: processingConfiguration,
                generation: processingGeneration
            )
        }
    }

    private func finishProcessingLoop(for loopGeneration: Int) {
        guard configurationGeneration == loopGeneration else { return }
        processingTask = nil
        isRunning = false
    }

    private func process(
        _ job: PendingCaptureJob,
        configuration: EngineConfiguration,
        generation: Int
    ) async {
        do {
            guard configurationGeneration == generation else { return }
            if job.stage == .failed {
                // One-shot recovery per session; marked before processing so a
                // crash can't loop it.
                failedRecoveryAttempted.insert(job.id)
            }
            try await processRemote(job, configuration: configuration, generation: generation)
        } catch {
            // Cancellation is expected when the scene backgrounds. It must not
            // turn an in-flight job into a false failure or show a Retry prompt.
            if Task.isCancelled || configurationGeneration != generation { return }
            let message = errorMessage(for: error)
            lastError = message
            store.updateJob(
                job.id,
                stage: .failed,
                progress: store.job(job.id)?.progress ?? job.progress,
                errorMessage: message
            )
        }
    }

    // MARK: - Worker integration

    private func processRemote(
        _ job: PendingCaptureJob,
        configuration: EngineConfiguration,
        generation: Int
    ) async throws {
        var remote: RemoteJob

        if let remoteID = remoteJobIDs[job.id] {
            if job.retryCount > lastRemoteRetryCounts[job.id, default: 0] {
                remote = try await retryRemoteJob(
                    remoteID,
                    localJobID: job.id,
                    retryCount: job.retryCount,
                    configuration: configuration
                )
            } else {
                remote = try await fetchRemoteJob(remoteID, configuration: configuration)
            }
        } else {
            remote = try await createRemoteJob(for: job, configuration: configuration)
            guard configurationGeneration == generation else { return }
            remoteJobIDs[job.id] = remote.id

            // A relaunch loses the in-memory remote ID. A repeated idempotent
            // POST can therefore return a previously failed job; honor a local
            // Retry tap by using the worker's retry endpoint exactly once.
            if remote.isFailed, job.retryCount > lastRemoteRetryCounts[job.id, default: 0] {
                remote = try await retryRemoteJob(
                    remote.id,
                    localJobID: job.id,
                    retryCount: job.retryCount,
                    configuration: configuration
                )
            }
        }

        guard configurationGeneration == generation else { return }
        if try accept(remote, for: job) { return }

        var delay: TimeInterval = configuration.pollInterval
        let pollStart = Date()
        while !Task.isCancelled {
            try await sleep(seconds: delay)
            guard configurationGeneration == generation else { return }
            let remoteID = remoteJobIDs[job.id] ?? remote.id
            remote = try await fetchRemoteJob(remoteID, configuration: configuration)
            guard configurationGeneration == generation else { return }
            if try accept(remote, for: job) { return }
            // Never block a pass forever on one job: after 10 minutes, hand
            // back so other jobs get polled; the next pass resumes checking.
            if Date().timeIntervalSince(pollStart) > 600 { return }
            delay = min(delay * 2, 15)
        }
        try Task.checkCancellation()
    }

    /// Applies a remote snapshot to the local durable job. Returns true for a
    /// terminal result, including a failed remote job.
    private func accept(_ remote: RemoteJob, for job: PendingCaptureJob) throws -> Bool {
        if remote.isDone {
            guard let output = remote.byte ?? remote.result else {
                throw GenerationServiceError.invalidResponse("The engine marked the job done without a result.")
            }
            if let resultID = remote.resultByteID, resultID != output.id {
                throw GenerationServiceError.invalidResponse("The engine returned a mismatched result ID.")
            }
            store.completeJob(job.id, with: output)
            lastError = nil
            return true
        }

        if remote.isFailed {
            let message = remote.errorMessage ?? "The engine reported that generation failed."
            store.updateJob(
                job.id,
                stage: .failed,
                progress: remote.progress,
                errorMessage: message
            )
            lastError = message
            return true
        }

        guard let stage = CaptureJobStage(rawValue: remote.stage) else {
            throw GenerationServiceError.invalidResponse("The engine returned an unknown job stage.")
        }
        store.updateJob(
            job.id,
            stage: stage,
            progress: remote.progress,
            errorMessage: nil
        )
        return false
    }

    private func createRemoteJob(
        for job: PendingCaptureJob,
        configuration: EngineConfiguration
    ) async throws -> RemoteJob {
        guard let url = configuration.jobsURL,
              let token = configuration.clientToken else {
            throw GenerationServiceError.notConfigured
        }

        let uploadID = try await uploadAttachmentIfPresent(for: job, configuration: configuration)

        let body = CreateJobRequest(
            sourceText: job.sourceText,
            sourceURL: Self.engineSourceURL(for: job.sourceURL),
            sourceKind: Self.engineSourceKind(for: job.sourceKind),
            projectId: job.projectID,
            uploadId: uploadID
        )
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Client-Token")
        request.setValue(job.id.uuidString, forHTTPHeaderField: "Idempotency-Key")
        return try await send(request)
    }

    /// Share-extension file captures keep their bytes in the shared App Group
    /// container; the durable job then carries a `file:` source URL. Upload
    /// those bytes before creating the remote job so the worker can read the
    /// original file. An upload failure degrades to the old text-only request
    /// with the failure noted rather than failing the capture. File bytes are
    /// never logged.
    private func uploadAttachmentIfPresent(
        for job: PendingCaptureJob,
        configuration: EngineConfiguration
    ) async throws -> String? {
        guard let sourceURL = job.sourceURL,
              let fileURL = URL(string: sourceURL),
              fileURL.isFileURL else {
            return nil
        }
        do {
            let data = try Data(contentsOf: fileURL)
            guard !data.isEmpty else { return nil }
            let filename = Self.attachmentFilename(for: fileURL)
            let receipt = try await UploadService.upload(
                data: data,
                contentType: UploadService.contentType(forFilename: filename),
                filename: filename,
                configuration: configuration,
                session: session
            )
            return receipt.id
        } catch is CancellationError {
            // Preserve cancellation so a backgrounded scene aborts the pass.
            throw CancellationError()
        } catch let urlError as URLError where urlError.code == .cancelled {
            throw CancellationError()
        } catch {
            logger.error("Attachment upload failed for job \(job.id); falling back to text-only: \(error.localizedDescription)")
            return nil
        }
    }

    /// Attachments are stored as `<UUID>-<name>`; recover the shared filename.
    private static func attachmentFilename(for fileURL: URL) -> String? {
        let last = fileURL.lastPathComponent
        guard last.count > 37 else { return last.isEmpty ? nil : last }
        let dashIndex = last.index(last.startIndex, offsetBy: 36)
        guard UUID(uuidString: String(last[..<dashIndex])) != nil,
              last[dashIndex] == "-" else {
            return last
        }
        return String(last[last.index(after: dashIndex)...])
    }

    private func fetchRemoteJob(
        _ remoteID: String,
        configuration: EngineConfiguration
    ) async throws -> RemoteJob {
        guard let baseURL = configuration.baseURL,
              let token = configuration.clientToken else {
            throw GenerationServiceError.notConfigured
        }
        let url = baseURL
            .appendingPathComponent("v1", isDirectory: true)
            .appendingPathComponent("jobs", isDirectory: true)
            .appendingPathComponent(remoteID, isDirectory: false)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(token, forHTTPHeaderField: "X-Client-Token")
        return try await send(request)
    }

    private func retryRemoteJob(
        _ remoteID: String,
        localJobID: UUID,
        retryCount: Int,
        configuration: EngineConfiguration
    ) async throws -> RemoteJob {
        guard let baseURL = configuration.baseURL,
              let token = configuration.clientToken else {
            throw GenerationServiceError.notConfigured
        }
        let url = baseURL
            .appendingPathComponent("v1", isDirectory: true)
            .appendingPathComponent("jobs", isDirectory: true)
            .appendingPathComponent(remoteID, isDirectory: true)
            .appendingPathComponent("retry", isDirectory: false)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "X-Client-Token")
        let remote = try await send(request)
        lastRemoteRetryCounts[localJobID] = retryCount
        return remote
    }

    private func send(_ request: URLRequest) async throws -> RemoteJob {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw GenerationServiceError.invalidResponse("The engine returned an invalid HTTP response.")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = (try? JSONDecoder().decode(EngineErrorEnvelope.self, from: data))?.message
                ?? "The engine request failed with HTTP \(httpResponse.statusCode)."
            throw GenerationServiceError.http(statusCode: httpResponse.statusCode, message: message)
        }
        do {
            return try JSONDecoder().decode(RemoteJobEnvelope.self, from: data).job
        } catch {
            throw GenerationServiceError.invalidResponse("The engine returned an unreadable job response.")
        }
    }

    private func sleep(seconds: TimeInterval) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }

    private func errorMessage(for error: Error) -> String {
        if let serviceError = error as? GenerationServiceError {
            return serviceError.localizedDescription
        }
        return error.localizedDescription.isEmpty
            ? "The engine request could not be completed."
            : error.localizedDescription
    }

    /// The capture UI may retain a presentation-only value such as `web:host`.
    /// The worker contract accepts the canonical source-kind set, so normalize
    /// those values at the transport boundary without changing persisted jobs.
    private static func engineSourceURL(for sourceURL: String?) -> String? {
        guard let sourceURL,
              let url = URL(string: sourceURL),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url.absoluteString
    }

    private static func engineSourceKind(for sourceKind: String) -> String {
        let canonical: Set<String> = [
            "quote", "video", "paper", "recipe", "spreadsheet", "thread", "podcast",
            "travel", "meeting", "note", "article", "image", "link", "other",
            "text", "pdf", "web", "youtube", "social", "unknown"
        ]
        if canonical.contains(sourceKind) { return sourceKind }
        if sourceKind.hasPrefix("web:") { return "web" }
        if ["vimeo", "x", "instagram", "tiktok", "reddit"].contains(sourceKind) { return "social" }
        return "unknown"
    }
}

// MARK: - Codable transport DTOs

private struct PendingCaptureJob: Sendable {
    let id: UUID
    let sourceText: String
    let sourceURL: String?
    let sourceKind: String
    let projectID: String?
    let stage: CaptureJobStage
    let progress: Double
    let retryCount: Int

    init(_ job: PersistedCaptureJob) {
        id = job.id
        sourceText = job.sourceText
        sourceURL = job.sourceURL
        sourceKind = job.sourceKind
        projectID = job.projectID
        stage = job.stage
        progress = job.progress
        retryCount = job.retryCount
    }
}

/// Request body for `POST /v1/jobs`. Quick mode never asks for a depth
/// (DECISIONS.md #3); the engine decides, so `requestedDepth` stays "auto"
/// while that field exists in the contract.
private struct CreateJobRequest: Encodable {
    let sourceText: String
    let sourceURL: String?
    let sourceKind: String
    let requestedDepth = "auto"
    /// Project the output belongs to; the engine stores it when it can.
    let projectId: String?
    /// Set when the job's file attachment was uploaded first; omitted otherwise.
    let uploadId: String?
}

private struct RemoteJobEnvelope: Decodable {
    let job: RemoteJob
}

private struct RemoteJob: Decodable {
    let id: String
    let stage: String
    let status: String
    let progress: Double
    let errorMessage: String?
    /// Wire name kept from the August engine contract.
    let resultByteID: UUID?
    /// The old one-page shape, kept by the engine for builds that only know pages.
    let result: Output?
    /// The same output as a byte with its bits (engine/docs/byte.md), when
    /// the engine sends one.
    let byte: Output?
    let retryable: Bool?

    var isDone: Bool { status == "done" || stage == CaptureJobStage.done.rawValue }
    var isFailed: Bool { status == "failed" || stage == CaptureJobStage.failed.rawValue }
}

private struct EngineErrorEnvelope: Decodable {
    let error: String?
    let message: String?
}

private struct EngineHealthEnvelope: Decodable {
    let ok: Bool
    let service: String?
    let time: String?
}

private enum GenerationServiceError: LocalizedError {
    case notConfigured
    case http(statusCode: Int, message: String)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Generation is disabled. Configure an HTTPS engine endpoint and client token."
        case let .http(_, message), let .invalidResponse(message):
            return message
        }
    }
}
