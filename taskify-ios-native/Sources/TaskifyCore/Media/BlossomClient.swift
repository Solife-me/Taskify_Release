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

/// The subset of Blossom-vs-everything-else server types Taskify needs to distinguish at upload
/// time. The native app only speaks two upload transports today: a plain unauthenticated POST
/// (used for the "originless" IPFS-gateway-style servers that are the default for encrypted
/// attachments) and Blossom's authenticated `PUT`. A NIP-96 transport isn't implemented natively,
/// matching the fact that none of the app's default/suggested servers are NIP-96.
public enum TaskifyFileServerType: Equatable, Sendable {
    case blossom
    case other

    /// Mirrors the PWA's `inferFileServerType` (`taskify-pwa/src/lib/fileStorage.ts`): guess the
    /// server's protocol from its hostname since Taskify doesn't otherwise track a per-server type.
    public static func inferred(for serverURL: String) -> TaskifyFileServerType {
        let host = URL(string: serverURL)?.host?.lowercased() ?? serverURL.lowercased()
        return host.contains("blossom") ? .blossom : .other
    }
}
