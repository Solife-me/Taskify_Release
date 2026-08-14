import CryptoKit
import Foundation

public enum BlossomError: LocalizedError, Equatable {
    case invalidServer
    case invalidResponse
    case requestFailed(status: Int, message: String?)

    public var errorDescription: String? {
        switch self {
        case .invalidServer: "The Blossom server address is not configured correctly."
        case .invalidResponse: "The Blossom server returned an invalid response."
        case .requestFailed(let status, let message):
            if let message, !message.isEmpty {
                "The Blossom server rejected the upload (\(status)): \(message)"
            } else {
                "The Blossom server rejected the upload (\(status))."
            }
        }
    }
}

/// A minimal client for the Blossom blob storage protocol (BUD-01/BUD-02:
/// https://github.com/hzrd149/blossom/tree/master/buds). Only `PUT /upload` is implemented —
/// Taskify reads blobs back with a plain unauthenticated `GET` of the returned URL, matching the
/// PWA (`taskify-pwa/src/nostr/Nip96Client.ts`), so no BUD-02 list/BUD-04 delete/mirror support is
/// needed.
///
/// Uploads authenticate as the *uploader*, via a kind-24242 event signed with the caller's own
/// Nostr identity key, never a per-board key — a Blossom server has no notion of "boards" and only
/// needs to know which app-level identity is allowed to write. Confidentiality of the blob's
/// contents is a separate concern, handled entirely by the caller encrypting the bytes with the
/// board's shared key (`TaskAttachmentCrypto`) before they ever reach this client.
public enum BlossomClient {
    public static let authEventKind = 24_242

    /// Builds the BUD-01 upload-authorization header: a kind-24242 event with `content:"Upload
    /// Blob"` and tags `t=upload`, `x=<sha256 of the bytes being uploaded>`, `expiration=<unix
    /// seconds>`, base64url-encoded (no padding) per the spec — note this is *not* standard
    /// base64, unlike the NIP-98 header used for NIP-96 servers elsewhere in this app.
    public static func authHeader(
        privateKey: Data,
        sha256Hex: String,
        now: Date = Date()
    ) throws -> String {
        let createdAt = Int(now.timeIntervalSince1970)
        let event = try NostrEvent.signed(
            privateKey: privateKey,
            createdAt: createdAt,
            kind: authEventKind,
            tags: [
                ["t", "upload"],
                ["x", sha256Hex],
                ["expiration", String(createdAt + 3_600)],
            ],
            content: "Upload Blob"
        )
        let base64url = try JSONEncoder().encode(event)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "Nostr \(base64url)"
    }

    /// Uploads already-encrypted bytes and returns the resulting blob's URL. `data` is hashed and
    /// signed for as-is — callers must encrypt before calling this, since Blossom servers see
    /// exactly what they're given.
    public static func upload(
        _ data: Data,
        privateKey: Data,
        server: URL,
        session: URLSession = .shared
    ) async throws -> String {
        let sha256Hex = Data(SHA256.hash(data: data)).hexString
        let auth = try authHeader(privateKey: privateKey, sha256Hex: sha256Hex)

        var request = URLRequest(url: server.appendingPathComponent("upload", isDirectory: false))
        request.httpMethod = "PUT"
        request.timeoutInterval = 120
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(auth, forHTTPHeaderField: "Authorization")
        request.httpBody = data

        let (responseData, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BlossomError.invalidResponse }
        let payload = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any]
        guard (200..<300).contains(http.statusCode) else {
            throw BlossomError.requestFailed(
                status: http.statusCode,
                message: payload?["message"] as? String
            )
        }
        guard let urlString = payload?["url"] as? String,
              let url = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            throw BlossomError.invalidResponse
        }
        return url.absoluteString
    }
}

/// The three encrypted file-server transports supported by both Taskify clients. Originless uses
/// its unauthenticated IPFS upload endpoint, Blossom uses a BUD-01 authenticated `PUT`, and NIP-96
/// uses discovery plus a NIP-98 authenticated multipart upload through `Nip96Client`.
public enum TaskifyFileServerType: String, Codable, CaseIterable, Equatable, Sendable {
    case nip96
    case blossom
    case originless

    /// Mirrors the PWA's `inferFileServerType` (`taskify-pwa/src/lib/fileStorage.ts`): guess the
    /// server's protocol from its hostname since Taskify doesn't otherwise track a per-server type.
    public static func inferred(for serverURL: String) -> TaskifyFileServerType {
        let host = URL(string: serverURL)?.host?.lowercased() ?? serverURL.lowercased()
        if host.contains("originless") { return .originless }
        if host.contains("blossom") { return .blossom }
        return .nip96
    }

    public var displayLabel: String {
        switch self {
        case .nip96: "NIP-96"
        case .blossom: "Blossom"
        case .originless: "Originless"
        }
    }
}

/// Mirrors the PWA's `FileServerEntry` (`taskify-pwa/src/lib/fileStorage.ts`) field-for-field, so
/// the JSON this encodes to/decodes from is wire-compatible with the PWA's own
/// `encryptedFileServers` setting value.
public struct TaskifyFileServerEntry: Codable, Equatable, Sendable, Identifiable {
    public var url: String
    public var type: TaskifyFileServerType
    public var label: String?

    public var id: String { url }

    public init(url: String, type: TaskifyFileServerType, label: String? = nil) {
        self.url = url
        self.type = type
        self.label = label
    }

    public var displayLabel: String {
        label ?? URL(string: url)?.host ?? url
    }
}

/// A ported subset of the PWA's `lib/fileStorage.ts`: URL normalization plus JSON parse/serialize
/// for a list of `TaskifyFileServerEntry`, matching the PWA's `normalizeFileServerUrl`/
/// `parseFileServers`/`serializeFileServers`/`findServerEntry` closely enough that the resulting
/// JSON round-trips through the encrypted PWA account backup unchanged.
public enum TaskifyFileServerList {
    /// Matches the PWA's default *encrypted*-context server list (`DEFAULT_FILE_SERVERS` filtered
    /// to `type === "originless"`): encrypted, opaque ciphertext trips up the content-sniffing many
    /// public Blossom/NIP-96 servers do, so only Originless servers are suggested by default.
    /// Blossom and NIP-96 remain fully addable by the user.
    /// `originless.besoeasy.com` was dropped in August 2026: the hostname stopped resolving, so
    /// picking it failed at DNS with nothing to explain why.
    public static let defaults: [TaskifyFileServerEntry] = [
        TaskifyFileServerEntry(url: "https://originless.solife.me", type: .originless, label: "originless.solife.me"),
    ]

    /// Scheme + host + path only, no query/fragment/credentials, no trailing slash -- mirrors the
    /// PWA's `normalizeFileServerUrl`. HTTPS is not enforced here (the PWA's normalizer doesn't
    /// either); native's own upload-time HTTPS requirement is checked separately by callers that
    /// need it (e.g. when a user adds a new server).
    public static func normalizedURL(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        func build(_ candidate: String) -> String? {
            guard var components = URLComponents(string: candidate),
                  let scheme = components.scheme, !scheme.isEmpty,
                  let host = components.host, !host.isEmpty else { return nil }
            var path = components.path
            while path.count > 1, path.hasSuffix("/") { path.removeLast() }
            components.path = path == "/" ? "" : path
            components.query = nil
            components.fragment = nil
            components.user = nil
            components.password = nil
            return components.url?.absoluteString
        }
        return build(trimmed) ?? build("https://\(trimmed)")
    }

    public static func parse(_ raw: String?) -> [TaskifyFileServerEntry] {
        guard let raw, let data = raw.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([TaskifyFileServerEntry].self, from: data) else {
            return defaults
        }
        let normalized = decoded.compactMap { entry -> TaskifyFileServerEntry? in
            guard let url = normalizedURL(entry.url) else { return nil }
            return TaskifyFileServerEntry(url: url, type: entry.type, label: entry.label)
        }
        return normalized.isEmpty ? defaults : normalized
    }

    public static func serialize(_ servers: [TaskifyFileServerEntry]) -> String {
        let normalized = servers.map { entry in
            TaskifyFileServerEntry(
                url: normalizedURL(entry.url) ?? entry.url,
                type: entry.type,
                label: entry.label
            )
        }
        guard let data = try? JSONEncoder().encode(normalized),
              let json = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return json
    }

    public static func find(_ servers: [TaskifyFileServerEntry], url: String) -> TaskifyFileServerEntry? {
        guard let normalized = normalizedURL(url) else { return nil }
        return servers.first { (normalizedURL($0.url) ?? $0.url) == normalized }
    }
}
