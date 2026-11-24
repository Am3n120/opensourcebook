import Foundation
import OSLog
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Save to Open Sourcebook" share extension. Reads one URL, text selection or file, lets
/// the user pick where it goes, and writes it to the App Group share inbox.
/// The app turns inbox items into capture jobs when it next becomes active.
@MainActor
final class ShareViewController: UIViewController {
    private let model = OpenSourcebookShareViewModel()
    private var hostingController: UIHostingController<OpenSourcebookShareView>?
    private var isCompleting = false
    private let logger = Logger(subsystem: "app.opensourcebook.share", category: "Share")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(OpenSourcebookTheme.Colors.background)
        preferredContentSize = CGSize(width: 390, height: 640)
        loadProjects()

        let rootView = OpenSourcebookShareView(
            model: model,
            onSave: { [weak self] in self?.saveToInbox() },
            onCancel: { [weak self] in self?.cancelShare() }
        )
        let hostingController = UIHostingController(rootView: rootView)
        addChild(hostingController)
        view.addSubview(hostingController.view)
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        hostingController.didMove(toParent: self)
        self.hostingController = hostingController

        Task { @MainActor [weak self] in
            await self?.loadSharedContent()
        }
    }

    /// Projects the app last published. Without them the picker still offers
    /// Auto, New project and Inbox.
    private func loadProjects() {
        do {
            model.projects = try OpenSourcebookShareInbox.readProjects().map {
                ProjectPickerItem(id: $0.id, title: $0.title, icon: $0.icon, colorHex: $0.colorHex)
            }
        } catch {
            logger.error("Could not read shared projects: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func loadSharedContent() async {
        guard !isCompleting else { return }

        let providers = extensionContext?.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] } ?? []

        guard !providers.isEmpty else {
            model.isLoading = false
            model.errorMessage = "Open Sourcebook could not find a URL, text selection, image, or file to save."
            return
        }

        var lastError: Error?
        for provider in providers {
            do {
                if let payload = try await resolve(provider: provider) {
                    guard !isCompleting else { return }
                    model.payload = payload
                    model.isLoading = false
                    return
                }
            } catch {
                lastError = error
            }
        }

        guard !isCompleting else { return }
        model.isLoading = false
        if let lastError {
            model.errorMessage = "Couldn’t read the shared content: \(lastError.localizedDescription)"
        } else {
            model.errorMessage = "Open Sourcebook can't read this kind of shared item."
        }
    }

    private func resolve(provider: NSItemProvider) async throws -> OpenSourcebookSharePayload? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            return try await resolveURL(provider: provider)
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            return try await resolveText(provider: provider, typeIdentifier: UTType.plainText.identifier)
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
            return try await resolveText(provider: provider, typeIdentifier: UTType.text.identifier)
        }

        return try await resolveFile(provider: provider)
    }

    private func resolveURL(provider: NSItemProvider) async throws -> OpenSourcebookSharePayload {
        let item = try await loadItem(from: provider, typeIdentifier: UTType.url.identifier)
        guard let value = stringValue(from: item),
              let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              url.host?.isEmpty == false else {
            throw OpenSourcebookShareLoadError.invalidURL
        }

        let absoluteString = url.absoluteString
        return OpenSourcebookSharePayload(
            sourceText: absoluteString,
            sourceURL: absoluteString,
            sourceKind: CaptureSourceParsing.sourceKind(for: url),
            filename: nil,
            data: nil
        )
    }

    private func resolveText(
        provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> OpenSourcebookSharePayload {
        let item = try await loadItem(from: provider, typeIdentifier: typeIdentifier)
        // Share sheets often hand links over as plain text (the YouTube app does
        // this); the parser promotes the first embedded URL into sourceURL so
        // the engine's extractors run, and any caption text stays as context.
        guard let text = stringValue(from: item),
              let fields = CaptureSourceParsing.fields(fromText: text) else {
            throw OpenSourcebookShareLoadError.emptyContent
        }
        return OpenSourcebookSharePayload(
            sourceText: fields.sourceText,
            sourceURL: fields.sourceURL,
            sourceKind: fields.sourceKind,
            filename: nil,
            data: nil
        )
    }

    private func resolveFile(provider: NSItemProvider) async throws -> OpenSourcebookSharePayload {
        let typeIdentifier: String
        let sourceKind: String
        if provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
            typeIdentifier = UTType.pdf.identifier
            sourceKind = "pdf"
        } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            typeIdentifier = UTType.image.identifier
            sourceKind = "image"
        } else if provider.hasItemConformingToTypeIdentifier(UTType.audio.identifier) {
            typeIdentifier = UTType.audio.identifier
            sourceKind = "audio"
        } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            typeIdentifier = UTType.fileURL.identifier
            sourceKind = "file"
        } else if provider.hasItemConformingToTypeIdentifier(UTType.item.identifier) {
            typeIdentifier = UTType.item.identifier
            sourceKind = "file"
        } else if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            typeIdentifier = UTType.data.identifier
            sourceKind = "file"
        } else {
            throw OpenSourcebookShareLoadError.unsupported
        }

        if typeIdentifier == UTType.fileURL.identifier {
            do {
                let result = try await loadFileURLData(
                    from: provider,
                    typeIdentifier: typeIdentifier
                )
                let filename = preferredFilename(
                    provider: provider,
                    fallback: result.filename ?? "Shared File"
                )
                return filePayload(
                    sourceKind: sourceKind,
                    filename: filename,
                    data: result.data,
                    typeIdentifier: typeIdentifier
                )
            } catch {
                // Some providers advertise public.file-url but only expose a
                // data/file representation, so continue with those forms.
            }
        }

        var errors: [Error] = []
        do {
            let result = try await loadFileData(
                from: provider,
                typeIdentifier: typeIdentifier
            )
            let filename = preferredFilename(
                provider: provider,
                fallback: result.filename ?? fallbackFilename(for: sourceKind)
            )
            return filePayload(
                sourceKind: sourceKind,
                filename: filename,
                data: result.data,
                typeIdentifier: typeIdentifier
            )
        } catch {
            errors.append(error)
        }

        do {
            // Abstract UTIs such as public.image have no preferred filename
            // extension; request a concrete image representation so the stored
            // attachment name gets an accurate extension.
            let dataTypeIdentifier: String
            if sourceKind == "image" {
                dataTypeIdentifier = provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                    ? UTType.png.identifier
                    : UTType.jpeg.identifier
            } else {
                dataTypeIdentifier = typeIdentifier
            }
            let data = try await loadData(
                from: provider,
                typeIdentifier: dataTypeIdentifier
            )
            let filename = preferredFilename(
                provider: provider,
                fallback: fallbackFilename(for: sourceKind)
            )
            return filePayload(
                sourceKind: sourceKind,
                filename: filename,
                data: data,
                typeIdentifier: dataTypeIdentifier
            )
        } catch {
            errors.append(error)
        }

        throw errors.last ?? OpenSourcebookShareLoadError.couldNotRead
    }

    private func filePayload(
        sourceKind: String,
        filename: String,
        data: Data,
        typeIdentifier: String
    ) -> OpenSourcebookSharePayload {
        let normalized = normalizedFilename(
            filename,
            typeIdentifier: typeIdentifier,
            sourceKind: sourceKind
        )
        return OpenSourcebookSharePayload(
            sourceText: CaptureSourceParsing.fileSourceText(filename: normalized, sourceKind: sourceKind),
            sourceURL: nil,
            sourceKind: sourceKind,
            filename: normalized,
            data: data
        )
    }

    /// The app infers the attachment content type from the filename extension,
    /// so make sure one is present: keep a real extension, derive one from the
    /// UTI the bytes were loaded with, or fall back to the category default.
    private func normalizedFilename(
        _ filename: String,
        typeIdentifier: String,
        sourceKind: String
    ) -> String {
        let trimmed = filename.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = trimmed.isEmpty ? fallbackFilename(for: sourceKind) : trimmed
        guard URL(fileURLWithPath: base).pathExtension.isEmpty else { return base }
        if let pathExtension = UTType(typeIdentifier)?.preferredFilenameExtension {
            return "\(base).\(pathExtension)"
        }
        switch sourceKind {
        case "image": return "\(base).jpg"
        case "audio": return "\(base).m4a"
        case "pdf": return "\(base).pdf"
        default: return base
        }
    }

    private func saveToInbox() {
        guard !isCompleting, let payload = model.payload, let destination = model.destination else { return }
        guard !model.isSaving else { return }

        model.isSaving = true
        model.errorMessage = nil

        do {
            let dataPath: String?
            if let data = payload.data {
                dataPath = try OpenSourcebookShareInbox.storeAttachment(data, filename: payload.filename)
            } else {
                dataPath = nil
            }

            let item = OpenSourcebookShareInboxItem(
                sourceText: payload.sourceText,
                sourceURL: payload.sourceURL,
                sourceKind: payload.sourceKind,
                destination: destination,
                filename: payload.filename,
                dataPath: dataPath
            )
            try OpenSourcebookShareInbox.append(item)
            model.isSaving = false
            completeRequest()
        } catch {
            logger.error("Saving the share failed: \(error.localizedDescription, privacy: .public)")
            model.isSaving = false
            model.errorMessage = error.localizedDescription
        }
    }

    private func cancelShare() {
        guard !isCompleting else { return }
        completeRequest()
    }

    private func completeRequest() {
        guard !isCompleting else { return }
        isCompleting = true
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func preferredFilename(provider: NSItemProvider, fallback: String) -> String {
        let suggested = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return suggested.isEmpty ? fallback : suggested
    }

    private func fallbackFilename(for sourceKind: String) -> String {
        switch sourceKind {
        case "image": return "Shared Image"
        case "pdf": return "Shared PDF.pdf"
        case "audio": return "Shared Audio.m4a"
        default: return "Shared File"
        }
    }

    private func stringValue(from item: NSSecureCoding) -> String? {
        if let value = item as? String { return value }
        if let value = item as? NSString { return value as String }
        if let value = item as? URL { return value.absoluteString }
        if let value = item as? NSURL { return value.absoluteString }
        if let value = item as? Data { return String(data: value, encoding: .utf8) }
        return nil
    }

    private func loadItem(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<NSSecureCoding, Error>) in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let item {
                    continuation.resume(returning: item)
                } else {
                    continuation.resume(throwing: OpenSourcebookShareLoadError.emptyContent)
                }
            }
        }
    }

    private func loadData(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> Data {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data, !data.isEmpty {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: OpenSourcebookShareLoadError.emptyContent)
                }
            }
        }
    }

    private func loadFileData(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> (data: Data, filename: String?) {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<(data: Data, filename: String?), Error>) in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let url else {
                    continuation.resume(throwing: OpenSourcebookShareLoadError.couldNotRead)
                    return
                }
                do {
                    let data = try Data(contentsOf: url)
                    guard !data.isEmpty else {
                        throw OpenSourcebookShareLoadError.emptyContent
                    }
                    continuation.resume(returning: (data, url.lastPathComponent))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func loadFileURLData(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> (data: Data, filename: String?) {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<(data: Data, filename: String?), Error>) in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let item,
                      let url = Self.fileURL(from: item) else {
                    continuation.resume(throwing: OpenSourcebookShareLoadError.couldNotRead)
                    return
                }
                do {
                    let data = try Data(contentsOf: url)
                    guard !data.isEmpty else {
                        throw OpenSourcebookShareLoadError.emptyContent
                    }
                    continuation.resume(returning: (data, url.lastPathComponent))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    nonisolated private static func fileURL(from item: NSSecureCoding) -> URL? {
        if let url = item as? URL { return url }
        if let url = item as? NSURL { return url as URL }
        if let string = item as? String { return URL(string: string) }
        if let string = item as? NSString { return URL(string: string as String) }
        return nil
    }
}

private enum OpenSourcebookShareLoadError: LocalizedError {
    case invalidURL
    case emptyContent
    case unsupported
    case couldNotRead

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "The shared URL was invalid."
        case .emptyContent: return "The shared item did not contain any readable content."
        case .unsupported: return "This shared item type is not supported."
        case .couldNotRead: return "The shared file could not be read."
        }
    }
}
