import Foundation
import UniformTypeIdentifiers

/// Durable receipt returned by the worker when it accepts a file upload.
struct UploadReceipt: Codable, Equatable, Sendable {
    let id: String
    let contentType: String
    let filename: String?
    let byteLength: Int
    let uploadedAt: String
}

/// Client for the worker's `POST /v1/uploads` raw-bytes endpoint.
///
/// An upload is a one-shot side effect that precedes job creation; callers
/// decide how to degrade when it cannot complete. File contents are never
/// logged or included in error messages.
enum UploadService {
    /// The worker rejects bodies above 25 MB; checked locally to fail fast.
    static let maximumUploadBytes = 25 * 1024 * 1024

    /// Sends raw bytes to the configured worker and returns its receipt.
    static func upload(
        data: Data,
        contentType: String,
        filename: String?,
        configuration: EngineConfiguration,
        session: URLSession = .shared
    ) async throws -> UploadReceipt {
        guard !data.isEmpty else {
            throw UploadServiceError.invalidResponse("The shared file was empty.")
        }
        guard data.count <= maximumUploadBytes else {
            throw UploadServiceError.tooLarge
        }
        guard configuration.isConfigured,
              let baseURL = configuration.baseURL,
              let token = configuration.clientToken else {
            throw UploadServiceError.disabled
        }

        let url = baseURL
            .appendingPathComponent("v1", isDirectory: true)
            .appendingPathComponent("uploads", isDirectory: false)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue(token, forHTTPHeaderField: "X-Client-Token")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if let filename, !filename.isEmpty {
            // Header values must stay ASCII-safe; the stored attachment names
            // are already sanitized, so this is a defensive normalization only.
            request.setValue(Self.headerSafeFilename(filename), forHTTPHeaderField: "X-Upload-Filename")
        }
        request.timeoutInterval = configuration.requestTimeout

        let body: Data
        let response: URLResponse
        do {
            (body, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let urlError as URLError where urlError.code == .cancelled {
            throw CancellationError()
        } catch {
            throw UploadServiceError.network(error.localizedDescription)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw UploadServiceError.invalidResponse("The engine returned an invalid HTTP response.")
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw UploadServiceError(statusCode: httpResponse.statusCode, body: body)
        }

        do {
            return try JSONDecoder().decode(UploadReceiptEnvelope.self, from: body).upload
        } catch {
            throw UploadServiceError.invalidResponse("The engine returned an unreadable upload response.")
        }
    }

    /// Best-effort MIME type for a stored attachment, derived from the filename
    /// extension so the worker receives an accurate `Content-Type`.
    static func contentType(forFilename filename: String?) -> String {
        guard let filename else { return "application/octet-stream" }
        let pathExtension = URL(fileURLWithPath: filename).pathExtension
        guard !pathExtension.isEmpty,
              let type = UTType(filenameExtension: pathExtension),
              let mimeType = type.preferredMIMEType else {
            return "application/octet-stream"
        }
        return mimeType
    }

    private static func headerSafeFilename(_ filename: String) -> String {
        let basename = URL(fileURLWithPath: filename).lastPathComponent
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let sanitized = basename.unicodeScalars.map { scalar in
            allowed.contains(scalar) ? String(scalar) : "_"
        }.joined()
        return sanitized.isEmpty ? "attachment" : sanitized
    }
}

/// Upload failures are typed so callers can decide how to degrade. Every case
/// carries a user-safe message that never includes file contents.
enum UploadServiceError: LocalizedError {
    case unauthorized
    case tooLarge
    case unsupported(String?)
    case disabled
    case network(String)
    case invalidResponse(String)

    init(statusCode: Int, body: Data) {
        let message = (try? JSONDecoder().decode(UploadErrorEnvelope.self, from: body))?.message
        switch statusCode {
        case 401:
            self = .unauthorized
        case 413:
            self = .tooLarge
        case 415:
            self = .unsupported(message)
        case 503:
            self = .disabled
        default:
            self = .invalidResponse(message ?? "The engine upload failed with HTTP \(statusCode).")
        }
    }

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "The engine rejected the client token. Check the engine configuration."
        case .tooLarge:
            return "The file is larger than the 25 MB upload limit."
        case let .unsupported(message):
            return message ?? "This file type is not supported by the engine."
        case .disabled:
            return "The engine could not accept the upload right now. Try again later."
        case let .network(message), let .invalidResponse(message):
            return message
        }
    }
}

private struct UploadReceiptEnvelope: Decodable {
    let upload: UploadReceipt
}

private struct UploadErrorEnvelope: Decodable {
    let error: String?
    let message: String?
}
