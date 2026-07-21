import CryptoKit
import Foundation

public struct TaskDocumentContent: Codable, Hashable, Sendable {
    public var type: String
    public var data: String

    public init(type: String, data: String) {
        self.type = type
        self.data = data
    }
}

public struct TaskDocument: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var mimeType: String
    public var kind: String
    public var size: Int?
    public var dataURL: String?
    public var createdAt: String?
    public var preview: TaskDocumentContent?
    public var full: TaskDocumentContent?
    public var remoteURL: String?
    public var encrypted: Bool?
    public var encryptionBoardID: String?

    public init(
        id: String = UUID().uuidString,
        name: String,
        mimeType: String,
        kind: String,
        size: Int? = nil,
        dataURL: String? = nil,
        createdAt: String? = nil,
        preview: TaskDocumentContent? = nil,
        full: TaskDocumentContent? = nil,
        remoteURL: String? = nil,
        encrypted: Bool? = nil,
        encryptionBoardID: String? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.kind = kind
        self.size = size
        self.dataURL = dataURL
        self.createdAt = createdAt
        self.preview = preview
        self.full = full
        self.remoteURL = remoteURL
        self.encrypted = encrypted
        self.encryptionBoardID = encryptionBoardID
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case mimeType
        case kind
        case size
        case dataURL = "dataUrl"
        case createdAt
        case preview
        case full
        case remoteURL = "remoteUrl"
        case encrypted
        case encryptionBoardID = "encryptionBoardId"
    }
}

public enum TaskAttachmentCryptoError: LocalizedError {
    case invalidCiphertext
    case invalidDataURL

    public var errorDescription: String? {
        switch self {
        case .invalidCiphertext: "The attachment could not be decrypted."
        case .invalidDataURL: "The inline attachment is invalid."
        }
    }
}

public enum TaskAttachmentCrypto {
    private static let v2Magic = Data("TFA2".utf8)
    private static let v2KeyDomain = Data("taskify-board-attachment-v2".utf8)

    public static func encrypt(_ plaintext: Data, boardID: String) throws -> Data {
        let key = SymmetricKey(
            data: SHA256.hash(data: v2KeyDomain + Data(boardID.utf8))
        )
        let sealedBox = try AES.GCM.seal(plaintext, using: key)
        guard let combined = sealedBox.combined else {
            throw TaskAttachmentCryptoError.invalidCiphertext
        }
        return v2Magic + combined
    }

    public static func decrypt(_ encryptedData: Data, boardID: String) throws -> Data {
        let isV2 = encryptedData.starts(with: v2Magic)
        let sealedData = isV2 ? encryptedData.dropFirst(v2Magic.count) : encryptedData[...]
        guard sealedData.count >= 28 else { throw TaskAttachmentCryptoError.invalidCiphertext }

        let keyMaterial = isV2
            ? v2KeyDomain + Data(boardID.utf8)
            : Data(boardID.utf8)
        let key = SymmetricKey(data: SHA256.hash(data: keyMaterial))

        do {
            let sealedBox = try AES.GCM.SealedBox(combined: Data(sealedData))
            return try AES.GCM.open(sealedBox, using: key)
        } catch {
            throw TaskAttachmentCryptoError.invalidCiphertext
        }
    }

    public static func data(from dataURL: String) throws -> Data {
        guard dataURL.hasPrefix("data:"),
              let comma = dataURL.firstIndex(of: ",") else {
            throw TaskAttachmentCryptoError.invalidDataURL
        }
        let metadata = dataURL[dataURL.index(dataURL.startIndex, offsetBy: 5)..<comma]
        let payloadStart = dataURL.index(after: comma)
        let payload = String(dataURL[payloadStart...])

        if metadata.lowercased().contains(";base64") {
            guard let data = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else {
                throw TaskAttachmentCryptoError.invalidDataURL
            }
            return data
        }
        guard let decoded = payload.removingPercentEncoding else {
            throw TaskAttachmentCryptoError.invalidDataURL
        }
        return Data(decoded.utf8)
    }
}

public enum TaskDocumentContract {
    public static let maximumUploadBytes = 50 * 1_024 * 1_024

    private static let extensionKinds: [String: String] = [
        "pdf": "pdf",
        "doc": "doc",
        "docx": "docx",
        "xlsx": "xlsx",
        "txt": "txt",
        "md": "md",
        "json": "json",
        "csv": "csv",
        "png": "png",
        "jpg": "jpg",
        "jpeg": "jpeg",
        "webp": "webp",
        "gif": "gif",
        "mp3": "mp3",
        "aac": "aac",
        "m4a": "m4a",
        "wav": "wav",
        "mp4": "mp4",
        "mov": "mov",
        "webm": "webm",
    ]

    private static let mimeKinds: [String: String] = [
        "application/pdf": "pdf",
        "application/msword": "doc",
        "application/vnd.ms-word": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "text/plain": "txt",
        "text/markdown": "md",
        "application/json": "json",
        "text/json": "json",
        "text/csv": "csv",
        "image/png": "png",
        "image/jpeg": "jpeg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/aac": "aac",
        "audio/x-aac": "aac",
        "audio/mp4": "m4a",
        "audio/x-m4a": "m4a",
        "audio/wav": "wav",
        "audio/wave": "wav",
        "audio/x-wav": "wav",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/webm": "webm",
    ]

    private static let fallbackMIMETypes: [String: String] = [
        "pdf": "application/pdf",
        "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "txt": "text/plain",
        "md": "text/markdown",
        "json": "application/json",
        "csv": "text/csv",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "mp3": "audio/mpeg",
        "aac": "audio/aac",
        "m4a": "audio/mp4",
        "wav": "audio/wav",
        "mp4": "video/mp4",
        "mov": "video/quicktime",
        "webm": "video/webm",
    ]

    public static func inferKind(name: String, mimeType: String) -> String? {
        let normalizedMIME = mimeType
            .split(separator: ";", maxSplits: 1)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        if let kind = mimeKinds[normalizedMIME] { return kind }

        let pathExtension = (name as NSString).pathExtension.lowercased()
        return extensionKinds[pathExtension]
    }

    public static func remoteDocument(
        id: String = UUID().uuidString,
        name: String,
        mimeType: String,
        size: Int?,
        remoteURL: String,
        boardID: String,
        createdAt: String? = nil
    ) -> TaskDocument? {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRemoteURL = remoteURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBoardID = boardID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty,
              !normalizedRemoteURL.isEmpty,
              !normalizedBoardID.isEmpty,
              let kind = inferKind(name: normalizedName, mimeType: mimeType) else {
            return nil
        }

        let normalizedMIME = mimeType.trimmingCharacters(in: .whitespacesAndNewlines)
        return TaskDocument(
            id: id,
            name: normalizedName,
            mimeType: normalizedMIME.isEmpty ? (fallbackMIMETypes[kind] ?? "application/octet-stream") : normalizedMIME,
            kind: kind,
            size: size,
            createdAt: createdAt ?? timestamp(),
            remoteURL: normalizedRemoteURL,
            encrypted: true,
            encryptionBoardID: normalizedBoardID
        )
    }

    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

public enum TaskContentLinks {
    private static let expression = try! NSRegularExpression(
        pattern: #"https?://[^\s)]+"#,
        options: [.caseInsensitive]
    )
    private static let onlyURLExpression = try! NSRegularExpression(
        pattern: #"^https?://[^\s)]+$"#,
        options: [.caseInsensitive]
    )

    public static func firstURL(title: String, note: String) -> URL? {
        let source = "\(title) \(note)"
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        guard let match = expression.firstMatch(in: source, range: range),
              let matchRange = Range(match.range, in: source) else {
            return nil
        }
        let raw = String(source[matchRange]).trimmingCharacters(
            in: CharacterSet(charactersIn: ".,;:!?]}")
        )
        guard let url = URL(string: raw),
              url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https" else {
            return nil
        }
        return url
    }

    public static func removingURLs(from text: String) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let withoutURLs = expression.stringByReplacingMatches(
            in: text,
            range: range,
            withTemplate: ""
        )
        return withoutURLs
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func isURLOnly(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        return onlyURLExpression.firstMatch(in: trimmed, range: range)?.range == range
    }

    public static func fallbackTitle(for url: URL) -> String {
        let host = (url.host(percentEncoded: false) ?? url.absoluteString)
            .replacingOccurrences(of: "www.", with: "", options: [.anchored, .caseInsensitive])
        let segments = url.pathComponents
            .filter { $0 != "/" && !$0.isEmpty }
            .prefix(2)
            .map { $0.removingPercentEncoding ?? $0 }
        guard !segments.isEmpty else { return host }
        return "\(host) / \(segments.joined(separator: " / "))"
    }
}
