import Foundation
import TaskifyCore
import UniformTypeIdentifiers

enum TaskAttachmentUploadError: LocalizedError {
    case invalidServer
    case fileTooLarge
    case unsupportedFile
    case invalidResponse
    case server(status: Int, message: String?)

    var errorDescription: String? {
        switch self {
        case .invalidServer:
            "The encrypted file server is not configured correctly."
        case .fileTooLarge:
            "Attachments must be 50 MB or smaller."
        case .unsupportedFile:
            "That file type is not supported yet."
        case .invalidResponse:
            "The encrypted file server returned an invalid response."
        case .server(let status, let message):
            if let message, !message.isEmpty {
                "The encrypted file server rejected the upload (\(status)): \(message)"
            } else {
                "The encrypted file server rejected the upload (\(status))."
            }
        }
    }
}

actor TaskAttachmentUploadService {
    static let shared = TaskAttachmentUploadService()
    static let pwaDefaultServer = "https://originless.solife.me"

    private let session: URLSession
    private let serverURL: URL?

    init(
        session: URLSession = .shared,
        serverURL: URL? = URL(string: pwaDefaultServer)
    ) {
        self.session = session
        self.serverURL = serverURL
    }

    func uploadDocument(
        data: Data,
        name: String,
        mimeType: String,
        boardID: String
    ) async throws -> TaskDocument {
        guard data.count <= TaskDocumentContract.maximumUploadBytes else {
            throw TaskAttachmentUploadError.fileTooLarge
        }
        guard TaskDocumentContract.inferKind(name: name, mimeType: mimeType) != nil else {
            throw TaskAttachmentUploadError.unsupportedFile
        }

        let encryptedData = try TaskAttachmentCrypto.encrypt(data, boardID: boardID)
        let remoteURL = try await upload(
            encryptedData,
            filename: name
        )
        guard let document = TaskDocumentContract.remoteDocument(
            name: name,
            mimeType: mimeType,
            size: data.count,
            remoteURL: remoteURL,
            boardID: boardID
        ) else {
            throw TaskAttachmentUploadError.unsupportedFile
        }
        return document
    }

    func uploadDocument(fileURL: URL, boardID: String) async throws -> TaskDocument {
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer {
            if accessing { fileURL.stopAccessingSecurityScopedResource() }
        }

        let values = try fileURL.resourceValues(forKeys: [
            .contentTypeKey,
            .fileSizeKey,
            .nameKey,
        ])
        if let fileSize = values.fileSize,
           fileSize > TaskDocumentContract.maximumUploadBytes {
            throw TaskAttachmentUploadError.fileTooLarge
        }
        let name = values.name ?? fileURL.lastPathComponent
        let mimeType = values.contentType?.preferredMIMEType ?? "application/octet-stream"
        guard TaskDocumentContract.inferKind(name: name, mimeType: mimeType) != nil else {
            throw TaskAttachmentUploadError.unsupportedFile
        }
        let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        return try await uploadDocument(
            data: data,
            name: name,
            mimeType: mimeType,
            boardID: boardID
        )
    }

    private func upload(_ data: Data, filename: String) async throws -> String {
        guard let serverURL,
              let scheme = serverURL.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            throw TaskAttachmentUploadError.invalidServer
        }
        let uploadURL = serverURL.appendingPathComponent("upload", isDirectory: false)
        let boundary = "TaskifyNative-\(UUID().uuidString)"
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = multipartBody(
            data: data,
            filename: filename,
            boundary: boundary
        )

        do {
            return try await perform(request, serverURL: serverURL)
        } catch is URLError {
            var rawRequest = URLRequest(url: uploadURL)
            rawRequest.httpMethod = "POST"
            rawRequest.timeoutInterval = 120
            rawRequest.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            rawRequest.httpBody = data
            return try await perform(rawRequest, serverURL: serverURL)
        }
    }

    private func perform(_ request: URLRequest, serverURL: URL) async throws -> String {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw TaskAttachmentUploadError.invalidResponse
        }
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (200..<300).contains(response.statusCode) else {
            throw TaskAttachmentUploadError.server(
                status: response.statusCode,
                message: payload?["message"] as? String
            )
        }
        guard let remoteURL = resolveRemoteURL(serverURL: serverURL, payload: payload) else {
            throw TaskAttachmentUploadError.invalidResponse
        }
        return remoteURL
    }

    private func multipartBody(data: Data, filename: String, boundary: String) -> Data {
        let safeFilename = filename
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        var body = Data()
        body.appendUTF8("--\(boundary)\r\n")
        body.appendUTF8("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeFilename)\"\r\n")
        body.appendUTF8("Content-Type: application/octet-stream\r\n\r\n")
        body.append(data)
        body.appendUTF8("\r\n--\(boundary)--\r\n")
        return body
    }

    private func resolveRemoteURL(serverURL: URL, payload: [String: Any]?) -> String? {
        for key in ["url", "cidUrl", "gatewayUrl", "fileUrl", "ipfs"] {
            if let value = payload?[key] as? String,
               let normalized = normalizedRemoteURL(value) {
                return normalized
            }
        }

        if let cid = (payload?["cid"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !cid.isEmpty {
            return serverURL
                .appendingPathComponent("ipfs", isDirectory: true)
                .appendingPathComponent(cid, isDirectory: false)
                .absoluteString
        }

        if let path = (payload?["path"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty {
            if let absolute = normalizedRemoteURL(path) { return absolute }
            return serverURL.appendingPathComponent(path, isDirectory: false).absoluteString
        }
        return nil
    }

    private func normalizedRemoteURL(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            return nil
        }
        return url.absoluteString
    }
}

private extension Data {
    mutating func appendUTF8(_ value: String) {
        append(Data(value.utf8))
    }
}
