import SwiftUI

/// Captures that have not finished: generating, or failed with Retry. Lives
/// on Home until project albums show generation status (DECISIONS.md #8);
/// hidden when there is nothing in flight.
struct CaptureJobsSection: View {
    @EnvironmentObject private var store: OutputStore
    @EnvironmentObject private var generation: GenerationService

    private var unfinished: [PersistedCaptureJob] {
        store.jobs.filter { $0.stage != .done }
    }

    var body: some View {
        if !unfinished.isEmpty {
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
                SectionHeader("Capturing")
                ForEach(unfinished) { job in
                    CaptureJobRow(
                        job: job,
                        destinationTitle: store.project(forID: job.projectID)?.title ?? "Inbox",
                        isEngineConfigured: generation.isConfigured,
                        onRetry: { store.retryJob(job.id) },
                        onRemove: { Task { await generation.cancelGeneration(for: job.id) } }
                    )
                }
            }
        }
    }
}

private struct CaptureJobRow: View {
    let job: PersistedCaptureJob
    let destinationTitle: String
    let isEngineConfigured: Bool
    let onRetry: () -> Void
    let onRemove: () -> Void

    private var isFailed: Bool { job.stage == .failed }

    /// The link's host, the file's name, or the first line of the text.
    private var title: String {
        if let sourceURL = job.sourceURL, let url = URL(string: sourceURL) {
            if url.isFileURL {
                return CaptureSourceParsing.fileSourceText(
                    filename: Self.displayFilename(url.lastPathComponent),
                    sourceKind: job.sourceKind
                )
            }
            if let host = url.host { return host }
        }
        let firstLine = job.sourceText.split(whereSeparator: \.isNewline).first.map(String.init)
        return firstLine ?? job.sourceText
    }

    private var status: String {
        if isFailed { return job.errorMessage ?? "Generation failed." }
        if !isEngineConfigured { return "Waiting for an engine. Set one up in Profile." }
        if job.stage == .queued {
            return "Waiting to start. It will appear in \(destinationTitle) when it is ready."
        }
        return "\(job.stage.label) · for \(destinationTitle)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Image(systemName: isFailed ? "exclamationmark.triangle.fill" : "sparkles")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(isFailed ? OpenSourcebookTheme.Colors.accentText : OpenSourcebookTheme.Colors.primary)
                    .frame(width: 32, height: 32)
                    .background(isFailed ? OpenSourcebookTheme.Colors.accentSoft : OpenSourcebookTheme.Colors.primarySoft)
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(1)
                    Text(status)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(isFailed ? OpenSourcebookTheme.Colors.accentText : OpenSourcebookTheme.Colors.muted)
                        .lineLimit(isFailed ? 3 : 1)
                }
                Spacer(minLength: 0)
            }

            if isFailed {
                HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    Button("Retry", action: onRetry)
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(OpenSourcebookTheme.Colors.primarySoft)
                        .clipShape(Capsule())
                        .accessibilityIdentifier("capture-job-retry")
                    Button("Remove", action: onRemove)
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(OpenSourcebookTheme.Colors.fill)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            } else if isEngineConfigured {
                ProgressView(value: job.progress)
                    .tint(OpenSourcebookTheme.Colors.primary)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
        .contextMenu {
            Button("Remove", role: .destructive, action: onRemove)
        }
    }

    /// Stored attachments are named `<UUID>-<name>`; show the name.
    private static func displayFilename(_ stored: String) -> String {
        guard stored.count > 37,
              UUID(uuidString: String(stored.prefix(36))) != nil,
              stored[stored.index(stored.startIndex, offsetBy: 36)] == "-" else {
            return stored
        }
        return String(stored.dropFirst(37))
    }
}

#Preview {
    let store = OutputStore()
    store.enqueueJob(sourceText: "https://arxiv.org/abs/1706.03762", sourceURL: "https://arxiv.org/abs/1706.03762",
                     sourceKind: "web", destination: .auto)
    return CaptureJobsSection()
        .padding()
        .environmentObject(store)
        .environmentObject(GenerationService(store: store))
}
