import CryptoKit
import Foundation
import P256K

public struct TaskifyWatchNostrEvent: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let publicKey: String
    public let createdAt: Int
    public let kind: Int
    public let tags: [[String]]
    public let content: String
    public let signature: String

    enum CodingKeys: String, CodingKey {
        case id
        case publicKey = "pubkey"
        case createdAt = "created_at"
        case kind
        case tags
        case content
        case signature = "sig"
    }

    public init(
        id: String,
        publicKey: String,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String,
        signature: String
    ) {
        self.id = id
        self.publicKey = publicKey
        self.createdAt = createdAt
        self.kind = kind
        self.tags = tags
        self.content = content
        self.signature = signature
    }

    public func firstTagValue(named name: String) -> String? {
        tags.first { $0.count >= 2 && $0[0] == name }?[1]
    }
}

public struct TaskifyWatchRequestAuthentication: Equatable, Sendable {
    public let publicKeyHex: String
    public let timestamp: String
    public let signature: String

    public var headers: [String: String] {
        [
            "X-Taskify-Npub": publicKeyHex,
            "X-Taskify-Timestamp": timestamp,
            "X-Taskify-Sig": signature,
        ]
    }
}

public enum TaskifyWatchNostrCryptoError: LocalizedError {
    case invalidPrivateKey
    case invalidPayload
    case invalidEvent

    public var errorDescription: String? {
        switch self {
        case .invalidPrivateKey: "The Watch Nostr key is invalid."
        case .invalidPayload: "The Watch task payload is invalid."
        case .invalidEvent: "The Watch Nostr event is invalid."
        }
    }
}

/// The small, watchOS-safe subset of Taskify's Nostr codec. Board events deliberately use keys
/// derived from the board sync identifier, so task writes never expose the account private key.
/// The account key is used only to authenticate HTTPS requests to Taskify's opaque relay bridge.
public enum TaskifyWatchNostrCrypto {
    public static let boardEventKind = 30_300
    public static let taskEventKind = 30_301
    public static let taskCacheAccessKind = 27_236

    public static func publicKeyHex(for privateKey: Data) throws -> String {
        Data(try schnorrPrivateKey(privateKey).xonly.bytes).taskifyHexString
    }

    public static func randomPrivateKey() throws -> Data {
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<64 {
            let candidate = Data((0..<32).map {
                _ in UInt8.random(in: .min ... .max, using: &generator)
            })
            if (try? schnorrPrivateKey(candidate)) != nil { return candidate }
        }
        throw TaskifyWatchNostrCryptoError.invalidPrivateKey
    }

    public static func boardTag(for boardID: String) -> String {
        CryptoKit.SHA256.hash(data: Data(boardID.utf8)).taskifyHexString
    }

    public static func boardPublicKeyHex(for boardID: String) throws -> String {
        let key = try schnorrPrivateKey(boardPrivateKey(for: boardID))
        return Data(key.xonly.bytes).taskifyHexString
    }

    public static func taskEvent(
        taskID: String,
        boardID: String,
        columnTag: String,
        status: String,
        payload: Data,
        createdAt: Int
    ) throws -> TaskifyWatchNostrEvent {
        guard !taskID.isEmpty,
              !boardID.isEmpty,
              JSONSerialization.isValidJSONObject(try JSONSerialization.jsonObject(with: payload)) else {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
        let encrypted = try encrypt(payload, boardID: boardID)
        return try signedEvent(
            privateKey: boardPrivateKey(for: boardID),
            createdAt: createdAt,
            kind: taskEventKind,
            tags: [
                ["d", taskID],
                ["b", boardTag(for: boardID)],
                ["col", columnTag],
                ["status", status],
            ],
            content: encrypted
        )
    }

    public static func decryptTaskPayload(
        _ event: TaskifyWatchNostrEvent,
        boardID: String
    ) throws -> Data {
        guard event.kind == taskEventKind,
              event.firstTagValue(named: "b") == boardTag(for: boardID),
              event.publicKey.lowercased() == (try boardPublicKeyHex(for: boardID)),
              verify(event) else {
            throw TaskifyWatchNostrCryptoError.invalidEvent
        }
        guard let combined = Data(base64Encoded: event.content) else {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
        do {
            let box = try AES.GCM.SealedBox(combined: combined)
            return try AES.GCM.open(box, using: encryptionKey(for: boardID))
        } catch {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
    }

    public static func decryptBoardPayload(
        _ event: TaskifyWatchNostrEvent,
        boardID: String
    ) throws -> Data {
        guard event.kind == boardEventKind,
              event.firstTagValue(named: "b") == boardTag(for: boardID),
              event.publicKey.lowercased() == (try boardPublicKeyHex(for: boardID)),
              verify(event) else {
            throw TaskifyWatchNostrCryptoError.invalidEvent
        }
        guard let combined = Data(base64Encoded: event.content) else {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
        do {
            let box = try AES.GCM.SealedBox(combined: combined)
            return try AES.GCM.open(box, using: encryptionKey(for: boardID))
        } catch {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
    }

    public static func requestAuthentication(
        privateKey: Data,
        publicKeyHex: String,
        body: Data,
        timestamp: Int = Int(Date().timeIntervalSince1970)
    ) throws -> TaskifyWatchRequestAuthentication {
        let normalizedPublicKey = publicKeyHex.lowercased()
        guard normalizedPublicKey.count == 64 else {
            throw TaskifyWatchNostrCryptoError.invalidPrivateKey
        }
        let hash = CryptoKit.SHA256.hash(
            data: Data("\(timestamp).".utf8) + body
        )
        let key = try schnorrPrivateKey(privateKey)
        guard Data(key.xonly.bytes).taskifyHexString == normalizedPublicKey else {
            throw TaskifyWatchNostrCryptoError.invalidPrivateKey
        }
        var message = Array(hash)
        let signature = try key.signature(message: &message, auxiliaryRand: nil, strict: false)
        return TaskifyWatchRequestAuthentication(
            publicKeyHex: normalizedPublicKey,
            timestamp: String(timestamp),
            signature: signature.dataRepresentation.taskifyHexString
        )
    }

    public static func nip98AuthorizationHeader(
        privateKey: Data,
        url: URL,
        method: String,
        body: Data,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> String {
        let event = try signedEvent(
            privateKey: privateKey,
            createdAt: createdAt,
            kind: 27_235,
            tags: [
                ["u", url.absoluteString],
                ["method", method.uppercased()],
                ["payload", CryptoKit.SHA256.hash(data: body).taskifyHexString],
                // Prevent a legitimate same-body retry within Nostr's one-second timestamp
                // resolution from producing an identical event ID rejected by the replay guard.
                ["nonce", UUID().uuidString.lowercased()],
            ],
            content: ""
        )
        return "Nostr \(try JSONEncoder().encode(event).base64EncodedString())"
    }

    public static func nip42AuthorizationEvent(
        privateKey: Data,
        relayURL: String,
        challenge: String,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> TaskifyWatchNostrEvent {
        try signedEvent(
            privateKey: privateKey,
            createdAt: createdAt,
            kind: 22_242,
            tags: [
                ["relay", relayURL],
                ["challenge", challenge],
            ],
            content: ""
        )
    }

    public static func nip42BoardAuthorizationEvent(
        boardID: String,
        relayURL: String,
        challenge: String,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> TaskifyWatchNostrEvent {
        try signedEvent(
            privateKey: boardPrivateKey(for: boardID),
            createdAt: createdAt,
            kind: 22_242,
            tags: [
                ["relay", relayURL],
                ["challenge", challenge],
            ],
            content: ""
        )
    }

    /// Fresh, endpoint-bound proof that this Watch possesses the secret for exactly one board
    /// subscription. The gateway never receives the board ID or key; it sees only the same
    /// derived public author and board tag already visible to the configured Nostr relays.
    public static func taskCacheAccessProof(
        boardID: String,
        accountPublicKey: String,
        url: URL,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> TaskifyWatchNostrEvent {
        let account = accountPublicKey.lowercased()
        guard account.count == 64,
              account.allSatisfy(\.isHexDigit),
              url.scheme?.lowercased() == "https" else {
            throw TaskifyWatchNostrCryptoError.invalidEvent
        }
        return try signedEvent(
            privateKey: boardPrivateKey(for: boardID),
            createdAt: createdAt,
            kind: taskCacheAccessKind,
            tags: [
                ["u", url.absoluteString],
                ["method", "POST"],
                ["account", account],
                ["b", boardTag(for: boardID)],
                ["purpose", "taskify-watch-cache"],
            ],
            content: ""
        )
    }

    public static func inboxPreferenceEvent(
        privateKey: Data,
        relayURLs: [String],
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> TaskifyWatchNostrEvent {
        let relays = TaskifyWatchRelayRouting.normalizedRelayURLs(relayURLs)
        guard !relays.isEmpty else { throw TaskifyWatchNostrCryptoError.invalidEvent }
        return try signedEvent(
            privateKey: privateKey,
            createdAt: createdAt,
            kind: 10_050,
            tags: relays.map { ["relay", $0] },
            content: ""
        )
    }

    public static func verify(_ event: TaskifyWatchNostrEvent) -> Bool {
        func isHex(_ value: String, length: Int) -> Bool {
            value.utf8.count == length && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
        guard (0...65_535).contains(event.kind), event.createdAt >= 0,
              isHex(event.id, length: 64), isHex(event.publicKey, length: 64),
              isHex(event.signature, length: 128), event.tags.allSatisfy({ !$0.isEmpty }) else { return false }

        guard let calculated = try? eventID(
            publicKey: event.publicKey,
            createdAt: event.createdAt,
            kind: event.kind,
            tags: event.tags,
            content: event.content
        ),
        calculated == event.id.lowercased(),
        let idData = Data(taskifyHex: event.id),
        let publicKeyData = Data(taskifyHex: event.publicKey),
        let signatureData = Data(taskifyHex: event.signature),
        let signature = try? P256K.Schnorr.SchnorrSignature(dataRepresentation: signatureData),
        let publicKey = Optional(P256K.Schnorr.XonlyKey(dataRepresentation: publicKeyData)) else {
            return false
        }
        var message = [UInt8](idData)
        return publicKey.isValid(signature, for: &message)
    }

    private static func boardPrivateKey(for boardID: String) -> Data {
        CryptoKit.SHA256.hash(
            data: Data("taskify-board-nostr-key-v1".utf8) + Data(boardID.utf8)
        ).withUnsafeBytes { Data($0) }
    }

    private static func encryptionKey(for boardID: String) -> SymmetricKey {
        SymmetricKey(data: CryptoKit.SHA256.hash(
            data: Data("taskify-board-aes-v1".utf8) + Data(boardID.utf8)
        ))
    }

    private static func encrypt(_ payload: Data, boardID: String) throws -> String {
        let sealed = try AES.GCM.seal(payload, using: encryptionKey(for: boardID))
        guard let combined = sealed.combined else {
            throw TaskifyWatchNostrCryptoError.invalidPayload
        }
        return combined.base64EncodedString()
    }

    public static func signedEvent(
        privateKey: Data,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String
    ) throws -> TaskifyWatchNostrEvent {
        let key = try schnorrPrivateKey(privateKey)
        let publicKey = Data(key.xonly.bytes).taskifyHexString
        let id = try eventID(
            publicKey: publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )
        guard let idData = Data(taskifyHex: id) else {
            throw TaskifyWatchNostrCryptoError.invalidEvent
        }
        var message = [UInt8](idData)
        let signature = try key.signature(message: &message, auxiliaryRand: nil, strict: false)
        return TaskifyWatchNostrEvent(
            id: id,
            publicKey: publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content,
            signature: signature.dataRepresentation.taskifyHexString
        )
    }

    public static func eventID(
        publicKey: String,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String
    ) throws -> String {
        let canonical: [Any] = [0, publicKey.lowercased(), createdAt, kind, tags, content]
        guard JSONSerialization.isValidJSONObject(canonical) else {
            throw TaskifyWatchNostrCryptoError.invalidEvent
        }
        let data = try JSONSerialization.data(
            withJSONObject: canonical,
            options: [.withoutEscapingSlashes]
        )
        return CryptoKit.SHA256.hash(data: data).taskifyHexString
    }

    private static func schnorrPrivateKey(_ data: Data) throws -> P256K.Schnorr.PrivateKey {
        guard data.count == 32,
              let key = try? P256K.Schnorr.PrivateKey(dataRepresentation: data) else {
            throw TaskifyWatchNostrCryptoError.invalidPrivateKey
        }
        return key
    }
}

private extension CryptoKit.SHA256.Digest {
    var taskifyHexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}

private extension Data {
    init?(taskifyHex value: String) {
        guard value.count.isMultiple(of: 2) else { return nil }
        var result = Data(capacity: value.count / 2)
        var index = value.startIndex
        while index < value.endIndex {
            let next = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        self = result
    }

    var taskifyHexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
