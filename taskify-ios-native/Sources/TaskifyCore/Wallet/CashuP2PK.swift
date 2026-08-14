import Foundation

public enum CashuP2PKError: LocalizedError, Equatable {
    case invalidKey
    case duplicateKey
    case keyNotFound

    public var errorDescription: String? {
        switch self {
        case .invalidKey: "Enter a valid compressed P2PK public key, npub, nsec, or 64-character key."
        case .duplicateKey: "That P2PK recipient key is already saved."
        case .keyNotFound: "The selected P2PK recipient key is no longer available."
        }
    }
}

public struct CashuP2PKKey: Identifiable, Codable, Equatable, Sendable {
    public let id: UUID
    public var label: String?
    public let publicKey: String
    public let privateKey: String
    public let createdAt: Date
    public var usedCount: Int
    public var lastUsedAt: Date?

    public init(
        id: UUID = UUID(),
        label: String? = nil,
        publicKey: String,
        privateKey: String,
        createdAt: Date = Date(),
        usedCount: Int = 0,
        lastUsedAt: Date? = nil
    ) throws {
        let identity = try NostrIdentity(importedValue: privateKey)
        let derived = "02\(identity.publicKeyHex)"
        guard Self.normalizePublicKey(publicKey) == derived else { throw CashuP2PKError.invalidKey }
        self.id = id
        self.label = label?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.publicKey = derived
        self.privateKey = identity.privateKeyHex
        self.createdAt = createdAt
        self.usedCount = max(0, usedCount)
        self.lastUsedAt = lastUsedAt
    }

    public static func generate(label: String? = nil) throws -> CashuP2PKKey {
        let identity = try NostrIdentity.generate()
        return try CashuP2PKKey(
            label: label,
            publicKey: "02\(identity.publicKeyHex)",
            privateKey: identity.privateKeyHex
        )
    }

    public static func importSecret(_ value: String, label: String? = nil) throws -> CashuP2PKKey {
        let identity = try NostrIdentity(importedValue: value)
        return try CashuP2PKKey(
            label: label,
            publicKey: "02\(identity.publicKeyHex)",
            privateKey: identity.privateKeyHex
        )
    }

    public static func normalizePublicKey(_ value: String?) -> String? {
        guard var normalized = value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(), !normalized.isEmpty else { return nil }
        if normalized.hasPrefix("p2pk:") { normalized.removeFirst("p2pk:".count) }
        if normalized.hasPrefix("nostr:") { normalized.removeFirst("nostr:".count) }
        if normalized.hasPrefix("0x") { normalized.removeFirst(2) }
        if normalized.count == 66,
           (normalized.hasPrefix("02") || normalized.hasPrefix("03")),
           (try? Data(hex: normalized))?.count == 33 {
            return normalized
        }
        if let key = NostrPublicKey.parse(normalized) {
            return "02\(key.hexString)"
        }
        return nil
    }
}

public struct CashuP2PKKeyRing: Codable, Equatable, Sendable {
    public var keys: [CashuP2PKKey]
    public var primaryKeyID: UUID?

    public init(keys: [CashuP2PKKey] = [], primaryKeyID: UUID? = nil) {
        self.keys = keys
        self.primaryKeyID = primaryKeyID
    }

    public var primaryKey: CashuP2PKKey? {
        primaryKeyID.flatMap { id in keys.first { $0.id == id } } ?? keys.last
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
