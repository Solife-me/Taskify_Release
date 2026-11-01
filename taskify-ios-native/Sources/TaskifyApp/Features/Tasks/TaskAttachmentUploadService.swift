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

    static var servers: [TaskifyFileServerEntry] { servers(defaults: .standard) }

    static func servers(defaults: UserDefaults) -> [TaskifyFileServerEntry] {
        if let stored = defaults.string(forKey: serverListKey), !stored.isEmpty {
            return TaskifyFileServerList.parse(stored)
        }
        // Migrates a custom server saved before this list existed (a single free-text field), so
        // upgrading users don't silently lose a self-hosted server they'd already configured.
        if let legacy = defaults.string(forKey: selectedServerKey),
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

    static var configuredServer: String { configuredServer(defaults: .standard) }

    static func configuredServer(defaults: UserDefaults) -> String {
        let currentServers = servers(defaults: defaults)
        if let stored = defaults.string(forKey: selectedServerKey),
           let normalized = TaskifyFileServerList.normalizedURL(stored),
           currentServers.contains(where: { $0.url == normalized }) {
            return normalized
        }
        return currentServers.first?.url ?? defaultServer
    }

    static var configuredEntry: TaskifyFileServerEntry { configuredEntry(defaults: .standard) }

    static func configuredEntry(defaults: UserDefaults) -> TaskifyFileServerEntry {
        let currentServers = servers(defaults: defaults)
        return TaskifyFileServerList.find(currentServers, url: configuredServer(defaults: defaults))
            ?? currentServers.first
            ?? TaskifyFileServerEntry(url: defaultServer, type: .originless)
    }

    @discardableResult
    static func selectServer(_ url: String, defaults: UserDefaults = .standard) -> String? {
        guard let normalized = TaskifyFileServerList.normalizedURL(url),
              servers(defaults: defaults).contains(where: { $0.url == normalized }) else { return nil }
        defaults.set(normalized, forKey: selectedServerKey)
        return normalized
    }

    enum AddResult: Equatable {
        case added(TaskifyFileServerEntry)
        case invalidURL
        case notHTTPS
        case duplicate
    }

    @discardableResult
    static func addServer(
        url: String,
        type: TaskifyFileServerType,
        defaults: UserDefaults = .standard
    ) -> AddResult {
        guard let normalized = TaskifyFileServerList.normalizedURL(url) else { return .invalidURL }
        guard normalized.lowercased().hasPrefix("https://") else { return .notHTTPS }
        var current = servers(defaults: defaults)
        guard !current.contains(where: { $0.url == normalized }) else { return .duplicate }
        let entry = TaskifyFileServerEntry(url: normalized, type: type, label: URL(string: normalized)?.host)
        current.append(entry)
        defaults.set(TaskifyFileServerList.serialize(current), forKey: serverListKey)
        defaults.set(normalized, forKey: selectedServerKey)
        return .added(entry)
    }

    /// Removing the currently-selected server falls back to the first remaining one, matching the
    /// PWA's `FileServersSection.handleDelete`. Refuses to remove the last server.
    @discardableResult
    static func removeServer(_ url: String, defaults: UserDefaults = .standard) -> Bool {
        guard let normalized = TaskifyFileServerList.normalizedURL(url) else { return false }
        var current = servers(defaults: defaults)
        guard current.count > 1, let index = current.firstIndex(where: { $0.url == normalized }) else {
            return false
        }
        current.remove(at: index)
        defaults.set(TaskifyFileServerList.serialize(current), forKey: serverListKey)
        if defaults.string(forKey: selectedServerKey).flatMap(TaskifyFileServerList.normalizedURL) == normalized {
            defaults.set(current[0].url, forKey: selectedServerKey)
        }
        return true
    }

    static func resetToDefaults(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: serverListKey)
        defaults.removeObject(forKey: selectedServerKey)
    }

    /// Used by inbound account-backup application, which hands over the PWA's own raw settings
    /// values directly rather than going through the add/remove mutators above.
    @discardableResult
    static func applyServerList(
        _ raw: String,
        defaults: UserDefaults = .standard
    ) -> [TaskifyFileServerEntry] {
        let parsed = TaskifyFileServerList.parse(raw)
        defaults.set(TaskifyFileServerList.serialize(parsed), forKey: serverListKey)
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
            "Attachments must be 500 MB or smaller."
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

    init(session: URLSession? = nil, serverURL: URL? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 3_600
        self.session = session ?? URLSession(configuration: configuration)
        self.serverURLOverride = serverURL
    }

    func uploadDocument(
        data: Data,
        name: String,
        mimeType: String,
        boardID: String,
        identity: NostrIdentity?,
        settingsDefaults: UserDefaults
    ) async throws -> TaskDocument {
        let source = try AttachmentFiles.write(data)
        defer { try? FileManager.default.removeItem(at: source) }
        return try await uploadDocument(
            fileURL: source,
            name: name,
            mimeType: mimeType,
            boardID: boardID,
            identity: identity,
            settingsDefaults: settingsDefaults
        )
    }

    func uploadDocument(
        fileURL: URL,
        boardID: String,
        identity: NostrIdentity?,
        settingsDefaults: UserDefaults
    ) async throws -> TaskDocument {
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        let values = try fileURL.resourceValues(forKeys: [.contentTypeKey, .nameKey])
        return try await uploadDocument(
            fileURL: fileURL,
            name: values.name ?? fileURL.lastPathComponent,
            mimeType: values.contentType?.preferredMIMEType ?? "application/octet-stream",
            boardID: boardID,
            identity: identity,
            settingsDefaults: settingsDefaults
        )
    }

    func uploadDocument(
        fileURL: URL,
        name: String,
        mimeType: String,
        boardID: String,
        identity: NostrIdentity?,
        settingsDefaults: UserDefaults
    ) async throws -> TaskDocument {
        let size = try AttachmentFiles.size(fileURL)
        guard TaskDocumentContract.inferKind(name: name, mimeType: mimeType) != nil else {
            throw TaskAttachmentUploadError.unsupportedFile
        }
        let encrypted = try AttachmentFileCrypto.encryptTask(fileURL, boardID: boardID)
        defer { try? FileManager.default.removeItem(at: encrypted) }
        let remote = try await upload(
            encrypted,
            filename: try EncryptedFileUpload.opaqueFilename(for: encrypted),
            identity: identity,
            settingsDefaults: settingsDefaults
        )
        guard let document = TaskDocumentContract.remoteDocument(name: name, mimeType: mimeType,
            size: size, remoteURL: remote, boardID: boardID) else { throw TaskAttachmentUploadError.unsupportedFile }
        return document
    }

    func uploadChatAttachment(
        data: Data,
        name: String,
        mimeType: String,
        width: Int? = nil,
        height: Int? = nil,
        identity: NostrIdentity?,
        settingsDefaults: UserDefaults
    ) async throws -> NostrDirectMessageAttachment {
        let source = try AttachmentFiles.write(data)
        defer { try? FileManager.default.removeItem(at: source) }
        return try await uploadChatAttachment(
            fileURL: source,
            name: name,
            mimeType: mimeType,
            width: width,
            height: height,
            identity: identity,
            settingsDefaults: settingsDefaults
        )
    }

    func uploadChatAttachment(
        fileURL: URL,
        name: String,
        mimeType: String,
        width: Int? = nil,
        height: Int? = nil,
        identity: NostrIdentity?,
        settingsDefaults: UserDefaults,
        progress: AttachmentProgressHandler? = nil
    ) async throws -> NostrDirectMessageAttachment {
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        let encrypted = try AttachmentFileCrypto.encryptChat(fileURL, progress: progress)
        defer { try? FileManager.default.removeItem(at: encrypted.url) }
        try Task.checkCancellation()
        let uploadFilename = try EncryptedFileUpload.opaqueFilename(ciphertextSHA256: encrypted.sha256)
        let remote = try await upload(
            encrypted.url,
            filename: uploadFilename,
            identity: identity,
            settingsDefaults: settingsDefaults,
            progress: progress
        )
        guard let attachment = NostrDirectMessageAttachment(url: remote, mimeType: mimeType, filename: name,
            size: encrypted.plaintextSize, width: width, height: height,
            keyHex: encrypted.keyHex, nonceHex: encrypted.nonceHex, sha256: encrypted.sha256) else {
            throw TaskAttachmentUploadError.invalidResponse
        }
        return attachment
    }

    private func upload(
        _ file: URL,
        filename: String,
        identity: NostrIdentity?,
        settingsDefaults: UserDefaults,
        progress: AttachmentProgressHandler? = nil
    ) async throws -> String {
        let entry = serverURLOverride.map {
            TaskifyFileServerEntry(url: $0.absoluteString, type: .inferred(for: $0.absoluteString))
        } ?? TaskifyMediaServerSettings.configuredEntry(defaults: settingsDefaults)
        return try await EncryptedFileUpload.upload(file: file, filename: filename, server: entry,
            privateKey: identity?.privateKey, session: session, progress: progress)
    }
}
