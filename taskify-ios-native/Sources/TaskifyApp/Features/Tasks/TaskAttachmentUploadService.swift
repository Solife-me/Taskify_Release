import Foundation
import TaskifyCore
import UniformTypeIdentifiers

/// Manages the encrypted-context file server list task attachments and chat attachments upload
/// to, following the PWA's `encryptedFileServers`/`encryptedFileStorageServer` settings pair
/// (`taskify-pwa/src/ui/settings/FileServersSection.tsx`): a persisted list of servers plus which
/// one is currently selected.
enum TaskifyMediaServerSettings {
    static let selectedServerPWAKey = "encryptedFileStorageServer"
    static let serverListPWAKey = "encryptedFileServers"
    static let defaultServer = "https://originless.solife.me"

    private static let selectedServerKey = "taskify.encryptedMediaServerURL"
    private static let serverListKey = "taskify.encryptedFileServers"

    static var servers: [TaskifyFileServerEntry] {
        if let stored = UserDefaults.standard.string(forKey: serverListKey), !stored.isEmpty {
            return TaskifyFileServerList.parse(stored)
        }
        // Migrates a custom server saved before this list existed (a single free-text field), so
        // upgrading users don't silently lose a self-hosted server they'd already configured.
        if let legacy = UserDefaults.standard.string(forKey: selectedServerKey),
           let normalized = TaskifyFileServerList.normalizedURL(legacy),
           !TaskifyFileServerList.defaults.contains(where: { $0.url == normalized }) {
            let entry = TaskifyFileServerEntry(
                url: normalized,
                type: TaskifyFileServerType.inferred(for: normalized),
                label: URL(string: normalized)?.host
            )
            return TaskifyFileServerList.defaults + [entry]
        }
        return TaskifyFileServerList.defaults
    }

    static var configuredServer: String {
        let currentServers = servers
        if let stored = UserDefaults.standard.string(forKey: selectedServerKey),
           let normalized = TaskifyFileServerList.normalizedURL(stored),
           currentServers.contains(where: { $0.url == normalized }) {
            return normalized
        }
        return currentServers.first?.url ?? defaultServer
    }

    static var configuredEntry: TaskifyFileServerEntry {
        let currentServers = servers
        return TaskifyFileServerList.find(currentServers, url: configuredServer)
            ?? currentServers.first
            ?? TaskifyFileServerEntry(url: defaultServer, type: .originless)
    }

    @discardableResult
    static func selectServer(_ url: String) -> String? {
        guard let normalized = TaskifyFileServerList.normalizedURL(url),
              servers.contains(where: { $0.url == normalized }) else { return nil }
        UserDefaults.standard.set(normalized, forKey: selectedServerKey)
        return normalized
    }

    enum AddResult: Equatable {
        case added(TaskifyFileServerEntry)
        case invalidURL
        case notHTTPS
        case duplicate
    }

    @discardableResult
    static func addServer(url: String, type: TaskifyFileServerType) -> AddResult {
        guard let normalized = TaskifyFileServerList.normalizedURL(url) else { return .invalidURL }
        guard normalized.lowercased().hasPrefix("https://") else { return .notHTTPS }
        var current = servers
        guard !current.contains(where: { $0.url == normalized }) else { return .duplicate }
        let entry = TaskifyFileServerEntry(url: normalized, type: type, label: URL(string: normalized)?.host)
        current.append(entry)
        UserDefaults.standard.set(TaskifyFileServerList.serialize(current), forKey: serverListKey)
        UserDefaults.standard.set(normalized, forKey: selectedServerKey)
        return .added(entry)
    }

    /// Removing the currently-selected server falls back to the first remaining one, matching the
    /// PWA's `FileServersSection.handleDelete`. Refuses to remove the last server.
    @discardableResult
    static func removeServer(_ url: String) -> Bool {
        guard let normalized = TaskifyFileServerList.normalizedURL(url) else { return false }
        var current = servers
        guard current.count > 1, let index = current.firstIndex(where: { $0.url == normalized }) else {
            return false
        }
        current.remove(at: index)
        UserDefaults.standard.set(TaskifyFileServerList.serialize(current), forKey: serverListKey)
        if UserDefaults.standard.string(forKey: selectedServerKey).flatMap(TaskifyFileServerList.normalizedURL) == normalized {
            UserDefaults.standard.set(current[0].url, forKey: selectedServerKey)
        }
        return true
    }

    static func resetToDefaults() {
        UserDefaults.standard.removeObject(forKey: serverListKey)
        UserDefaults.standard.removeObject(forKey: selectedServerKey)
    }

    /// Used by inbound account-backup application, which hands over the PWA's own raw settings
    /// values directly rather than going through the add/remove mutators above.
    @discardableResult
    static func applyServerList(_ raw: String) -> [TaskifyFileServerEntry] {
        let parsed = TaskifyFileServerList.parse(raw)
        UserDefaults.standard.set(TaskifyFileServerList.serialize(parsed), forKey: serverListKey)
        return parsed
    }
}

enum TaskAttachmentUploadError: LocalizedError {
    case invalidServer
    case fileTooLarge
    case unsupportedFile
    case invalidResponse
    case missingIdentity
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
        case .missingIdentity:
            "Set up your Taskify identity before uploading to an authenticated file server."
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

    private let session: URLSession
    private let serverURLOverride: URL?

    init(
        session: URLSession = .shared,
        serverURL: URL? = nil
    ) {
        self.session = session
        self.serverURLOverride = serverURL
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

    func uploadChatAttachment(
        data: Data,
        name: String,
        mimeType: String,
        width: Int? = nil,
        height: Int? = nil
    ) async throws -> NostrDirectMessageAttachment {
        guard !data.isEmpty else { throw TaskAttachmentUploadError.unsupportedFile }
        guard data.count <= TaskDocumentContract.maximumUploadBytes else {
            throw TaskAttachmentUploadError.fileTooLarge
        }
        let encrypted = try NostrDirectMessageAttachmentCrypto.encrypt(data)
        let remoteURL = try await upload(
            encrypted.ciphertext,
            filename: "\(encrypted.sha256).bin"
        )
        guard let attachment = NostrDirectMessageAttachment(
            url: remoteURL,
            mimeType: mimeType,
            filename: name,
            size: data.count,
            width: width,
            height: height,
            keyHex: encrypted.keyHex,
            nonceHex: encrypted.nonceHex,
            sha256: encrypted.sha256
        ) else {
            throw TaskAttachmentUploadError.invalidResponse
        }
        return attachment
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
        let configuredEntry = TaskifyMediaServerSettings.configuredEntry
        let serverURL = serverURLOverride ?? URL(string: configuredEntry.url)
        guard let serverURL,
              let scheme = serverURL.scheme?.lowercased(),
              scheme == "https" else {
            throw TaskAttachmentUploadError.invalidServer
        }

        let serverType = serverURLOverride == nil
            ? configuredEntry.type
            : TaskifyFileServerType.inferred(for: serverURL.absoluteString)
        if serverType == .blossom {
            return try await uploadViaBlossom(data, server: serverURL)
        }
        if serverType == .nip96 {
            return try await uploadViaNip96(data, filename: filename, server: serverURL)
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

    /// Blossom (BUD-01/BUD-02) upload path. The `PUT` is authorized with a kind-24242 event signed
    /// by the device's own Nostr identity — never the board's key — since Blossom servers only
    /// need to know which app-level identity is writing; `data` has already been encrypted with
    /// the board's shared key by the caller, so anyone with board access can decrypt it regardless
    /// of who uploaded it.
    private func uploadViaBlossom(_ data: Data, server: URL) async throws -> String {
        guard let identity = try? KeychainIdentityStore().load() else {
            throw TaskAttachmentUploadError.missingIdentity
        }
        do {
            return try await BlossomClient.upload(
                data,
                privateKey: identity.privateKey,
                server: server,
                session: session
            )
        } catch let error as BlossomError {
            switch error {
            case .invalidServer: throw TaskAttachmentUploadError.invalidServer
            case .invalidResponse: throw TaskAttachmentUploadError.invalidResponse
            case .requestFailed(let status, let message):
                throw TaskAttachmentUploadError.server(status: status, message: message)
            }
        }
    }

    /// Standards-compliant NIP-96 path: discovers the server's advertised API endpoint, follows
    /// delegated discovery, signs the encrypted payload using NIP-98, and handles asynchronous
    /// processing responses. Multipart bytes are written to a temporary upload file so the
    /// encrypted attachment is not duplicated again in one large in-memory request body.
    private func uploadViaNip96(
        _ data: Data,
        filename: String,
        server: URL
    ) async throws -> String {
        guard let identity = try? KeychainIdentityStore().load() else {
            throw TaskAttachmentUploadError.missingIdentity
        }
        do {
            return try await Nip96Client.upload(
                data,
                filename: filename,
                privateKey: identity.privateKey,
                server: server,
                session: session
            )
        } catch let error as Nip96Error {
            switch error {
            case .invalidServer:
                throw TaskAttachmentUploadError.invalidServer
            case .invalidDiscoveryResponse, .missingAPIURL, .tooManyDelegations,
                 .invalidUploadResponse, .processingTimedOut:
                throw TaskAttachmentUploadError.server(status: 0, message: error.localizedDescription)
            case .requestFailed(let status, let message):
                throw TaskAttachmentUploadError.server(status: status, message: message)
            }
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

        // Content-addressed servers (Originless) return a CID and don't serve the blob themselves;
        // `{server}/ipfs/{cid}` 404s. Retrieval goes through a public gateway, as its README says.
        if let cid = payload?["cid"] as? String,
           let gatewayURL = TaskifyIPFSGateway.url(forCID: cid) {
            return gatewayURL
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
