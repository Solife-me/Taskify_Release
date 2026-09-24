import TaskifyWatchShared
import CryptoKit
import Foundation
import P256K

public enum NostrEventError: LocalizedError {
    case invalidEvent
    case invalidSignature

    public var errorDescription: String? {
        switch self {
        case .invalidEvent: "The relay event is malformed."
        case .invalidSignature: "The relay event signature is invalid."
        }
    }
}

public struct NostrEvent: Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var publicKey: String
    public var createdAt: Int
    public var kind: Int
    public var tags: [[String]]
    public var content: String
    public var signature: String

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

    /// Different replaceable records can share wall time. Only successive versions of
    /// the same record need a strictly increasing clock.
    public static func nextTimestamp(after previous: Int?, now: Int = Int(Date().timeIntervalSince1970)) -> Int {
        max(now, min(previous ?? 0, Int.max - 1) + 1)
    }

    public static func signed(
        privateKey: Data,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String
    ) throws -> NostrEvent {
        let key = try P256K.Schnorr.PrivateKey(dataRepresentation: privateKey)
        let publicKey = Data(key.xonly.bytes).hexString
        let tags = try kind == 13 || kind == NIP42AuthContract.eventKind ? tags : TaskifyRelayProofOfWork.mineTags(tags) {
            try calculateID(publicKey: publicKey, createdAt: createdAt, kind: kind, tags: $0, content: content)
        }
        let eventID = try calculateID(
            publicKey: publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )
        let idData = try Data(hex: eventID)
        var message = [UInt8](idData)
        let signature = try key.signature(message: &message, auxiliaryRand: nil, strict: false)
        return NostrEvent(
            id: eventID,
            publicKey: publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content,
            signature: signature.dataRepresentation.hexString
        )
    }

    public func verifyID() -> Bool {
        (try? Self.calculateID(publicKey: publicKey, createdAt: createdAt, kind: kind, tags: tags, content: content)) == id
    }

    public func verify() -> Bool {
        func isHex(_ value: String, length: Int) -> Bool {
            value.utf8.count == length && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
        guard (0...65_535).contains(kind), createdAt >= 0,
              isHex(id, length: 64), isHex(publicKey, length: 64),
              isHex(signature, length: 128), tags.allSatisfy({ !$0.isEmpty }) else { return false }
        guard let calculatedID = try? Self.calculateID(
            publicKey: publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        ), calculatedID == id.lowercased(),
        let idData = try? Data(hex: id),
        let publicKeyData = try? Data(hex: publicKey),
        let signatureData = try? Data(hex: signature),
        let schnorrSignature = try? P256K.Schnorr.SchnorrSignature(dataRepresentation: signatureData),
        let xonlyKey = Optional(P256K.Schnorr.XonlyKey(dataRepresentation: publicKeyData)) else {
            return false
        }
        var message = [UInt8](idData)
        return xonlyKey.isValid(schnorrSignature, for: &message)
    }

    public func firstTagValue(named name: String) -> String? {
        tags.first { $0.count >= 2 && $0[0] == name }?[1]
    }

    public static func calculateID(
        publicKey: String,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String
    ) throws -> String {
        let canonical: [Any] = [0, publicKey.lowercased(), createdAt, kind, tags, content]
        guard JSONSerialization.isValidJSONObject(canonical) else { throw NostrEventError.invalidEvent }
        let data = try JSONSerialization.data(
            withJSONObject: canonical,
            options: [.withoutEscapingSlashes]
        )
        return Data(SHA256.hash(data: data)).hexString
    }
}
