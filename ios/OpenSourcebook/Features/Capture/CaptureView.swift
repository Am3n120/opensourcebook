import OSLog
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The + sheet: type or paste text or a link, or attach a file or photo, pick
/// where it goes, and send. Sending queues a capture job in `OutputStore`;
/// `GenerationService` does the rest, the same path the share extension uses.
struct CaptureView: View {
    @EnvironmentObject private var store: OutputStore
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var attachment: CaptureAttachment?
    @State private var choice: ProjectPickerChoice
    @State private var errorMessage: String?
    @State private var isImportingFile = false
    @State private var isPickingPhoto = false
    @State private var photoItem: PhotosPickerItem?
    @State private var isLoadingPhoto = false
    @State private var isCreatingProject = false

    private let logger = Logger(subsystem: "app.opensourcebook", category: "Capture")

    init(initialDestination: CaptureDestination) {
        let choice: ProjectPickerChoice
        switch initialDestination {
        case .auto: choice = .auto
        case .project(let id): choice = .project(id: id)
        case .inbox: choice = .inbox
        }
        _choice = State(initialValue: choice)
    }

    private var textFields: CaptureSourceFields? {
        CaptureSourceParsing.fields(fromText: text)
    }

    private var canSend: Bool {
        !isLoadingPhoto && (attachment != nil || textFields != nil)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xl) {
                    sourceSection
                    destinationSection
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(OpenSourcebookTheme.Colors.accentText)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("capture-error")
                    }
                }
                .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
                .padding(.top, OpenSourcebookTheme.Spacing.xs)
                .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(OpenSourcebookTheme.Colors.background.ignoresSafeArea())
            .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
            .navigationTitle("Capture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("capture-cancel")
                }
            }
        }
        .fileImporter(
            isPresented: $isImportingFile,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false,
            onCompletion: handleFileImport
        )
        .photosPicker(isPresented: $isPickingPhoto, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            importPhoto(item)
        }
        .sheet(isPresented: $isCreatingProject) {
            ProjectEditorSheet(project: nil) { project in
                choice = .project(id: project.id)
            }
        }
    }

    // MARK: - Source

    private var sourceSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Text("What to capture")
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(attachment == nil ? "Paste a link or type a note" : "Add a note (optional)")
                        .font(OpenSourcebookTheme.Fonts.body)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
                        .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $text)
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, OpenSourcebookTheme.Spacing.xs)
                    .padding(.vertical, OpenSourcebookTheme.Spacing.xxs)
                    .frame(minHeight: 110)
                    .accessibilityIdentifier("capture-text")
            }
            .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)

            if let fields = textFields, let link = fields.sourceURL, attachment == nil {
                Label(URL(string: link)?.host ?? link, systemImage: "link")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                    .lineLimit(1)
            }

            if let attachment {
                attachmentCard(attachment)
            } else {
                HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    // The system paste button reads the clipboard only when
                    // tapped, so there is no paste-permission prompt.
                    PasteButton(payloadType: String.self) { strings in
                        Task { @MainActor in paste(strings.joined(separator: "\n")) }
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                    .tint(OpenSourcebookTheme.Colors.text)
                    sourceButton("File", icon: "doc") {
                        errorMessage = nil
                        isImportingFile = true
                    }
                    sourceButton(isLoadingPhoto ? "Loading…" : "Photo", icon: "photo") {
                        errorMessage = nil
                        photoItem = nil
                        isPickingPhoto = true
                    }
                    .disabled(isLoadingPhoto)
                }
            }
        }
    }

    private func sourceButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
                .background(OpenSourcebookTheme.Colors.fill)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func attachmentCard(_ attachment: CaptureAttachment) -> some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            Image(systemName: attachment.iconName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .frame(width: 36, height: 36)
                .background(OpenSourcebookTheme.Colors.primarySoft)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.filename)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file))
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            Spacer(minLength: 0)
            Button {
                self.attachment = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .frame(width: 28, height: 28)
                    .background(OpenSourcebookTheme.Colors.fill)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove attachment")
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
        .accessibilityIdentifier("capture-attachment")
    }

    // MARK: - Destination

    private var destinationSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Text("Where it goes")
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            ProjectPicker(
                selection: $choice,
                projects: store.projects.map {
                    ProjectPickerItem(id: $0.id, title: $0.title, icon: $0.icon, colorHex: $0.colorHex)
                },
                onNewProject: { isCreatingProject = true }
            )
        }
    }

    // MARK: - Send

    private var sendBar: some View {
        Button(action: send) {
            Label("Send", systemImage: "arrow.up.circle.fill")
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(OpenSourcebookTheme.Colors.surface)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(canSend ? OpenSourcebookTheme.Colors.text : OpenSourcebookTheme.Colors.muted)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
        .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
        .background(OpenSourcebookTheme.Colors.background)
        .accessibilityIdentifier("capture-send")
    }

    private var destination: CaptureDestination {
        switch choice {
        case .auto: return .auto
        case .project(let id): return store.project(forID: id) == nil ? .inbox : .project(id: id)
        // The sheet creates the project before selecting it, so this is only
        // reachable if creation was cancelled mid-way.
        case .newProject, .inbox: return .inbox
        }
    }

    private func send() {
        guard canSend else { return }
        errorMessage = nil
        let note = text.trimmingCharacters(in: .whitespacesAndNewlines)

        if let attachment {
            do {
                let fileURL = try CaptureAttachmentStore.store(attachment.data, filename: attachment.filename)
                store.enqueueJob(
                    sourceText: note.isEmpty
                        ? CaptureSourceParsing.fileSourceText(filename: attachment.filename, sourceKind: attachment.sourceKind)
                        : note,
                    sourceURL: fileURL.absoluteString,
                    sourceKind: attachment.sourceKind,
                    destination: destination
                )
            } catch {
                logger.error("Storing a capture attachment failed: \(error.localizedDescription, privacy: .public)")
                errorMessage = "Open Sourcebook could not keep a copy of that file: \(error.localizedDescription)"
                return
            }
        } else if let fields = textFields {
            store.enqueueJob(
                sourceText: fields.sourceText,
                sourceURL: fields.sourceURL,
                sourceKind: fields.sourceKind,
                destination: destination
            )
        }

        OpenSourcebookHaptics.mediumImpact()
        dismiss()
    }

    // MARK: - Input

    private func paste(_ pasted: String) {
        guard !pasted.isEmpty else { return }
        text = text.isEmpty ? pasted : text + "\n" + pasted
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            if (error as NSError).code == NSUserCancelledError { return }
            errorMessage = "Couldn’t open that file: \(error.localizedDescription)"
        case .success(let urls):
            guard let url = urls.first else { return }
            let isScoped = url.startAccessingSecurityScopedResource()
            defer { if isScoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= UploadService.maximumUploadBytes else {
                    throw UploadServiceError.tooLarge
                }
                let data = try Data(contentsOf: url)
                guard !data.isEmpty else {
                    errorMessage = "That file is empty."
                    return
                }
                let filename = url.lastPathComponent.isEmpty ? "File" : url.lastPathComponent
                attachment = CaptureAttachment(
                    filename: filename,
                    data: data,
                    sourceKind: CaptureSourceParsing.sourceKind(forFileType: UTType(filenameExtension: url.pathExtension))
                )
            } catch {
                errorMessage = "Couldn’t read that file: \(error.localizedDescription)"
            }
        }
    }

    private func importPhoto(_ item: PhotosPickerItem) {
        isLoadingPhoto = true
        Task { @MainActor in
            defer {
                isLoadingPhoto = false
                photoItem = nil
            }
            do {
                guard let data = try await item.loadTransferable(type: Data.self), !data.isEmpty else {
                    errorMessage = "The selected photo could not be read."
                    return
                }
                guard data.count <= UploadService.maximumUploadBytes else {
                    errorMessage = UploadServiceError.tooLarge.localizedDescription
                    return
                }
                let fileExtension = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                attachment = CaptureAttachment(filename: "Photo.\(fileExtension)", data: data, sourceKind: "image")
            } catch {
                errorMessage = "Couldn’t load that photo: \(error.localizedDescription)"
            }
        }
    }
}

/// A file or photo held in memory until the capture is sent.
private struct CaptureAttachment {
    let filename: String
    let data: Data
    let sourceKind: String

    var iconName: String {
        switch sourceKind {
        case "pdf": return "doc.richtext"
        case "image": return "photo"
        case "audio": return "waveform"
        default: return "doc"
        }
    }
}

/// Where in-app capture files live until they are uploaded: the App Group
/// attachments folder the share extension also uses, or the app's own
/// Application Support when the App Group is unavailable. The job then
/// carries the `file:` URL and `GenerationService` uploads the bytes.
private enum CaptureAttachmentStore {
    static func store(_ data: Data, filename: String) throws -> URL {
        if let relativePath = try? OpenSourcebookShareInbox.storeAttachment(data, filename: filename) {
            return try OpenSourcebookShareInbox.attachmentURL(for: relativePath)
        }
        let directory = try FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Captures", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory.appendingPathComponent(OpenSourcebookShareInbox.attachmentName(for: filename))
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        return fileURL
    }
}

#Preview {
    CaptureView(initialDestination: .auto)
        .environmentObject(OutputStore())
}
