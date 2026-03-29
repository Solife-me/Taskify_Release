/// NostrEvent.swift
/// Core Nostr event types and serialization.
/// Matches the Nostr protocol spec (NIP-01).

import CryptoKit
import Foundation

// MARK: - Event kinds used by Taskify

public enum TaskifyEventKind: Int {
    case boardDefinition    = 30300
    case task               = 30301
    case calendarEvent      = 30310
    case calendarView       = 30311
    case profileMetadata    = 0
    case contacts           = 3
    case dm                 = 4
    case deletion           = 5
    case nip51List          = 30000
}

// MARK: - NostrEvent

/// An immutable, fully verified Nostr event.
public struct NostrEvent: Codable, Hashable, Identifiable {
    public let id: String          // 32-byte lowercase hex SHA-256 of serialised event
    public let pubkey: String      // 32-byte lowercase hex public key
    public let created_at: Int     // Unix timestamp (seconds)
    public let kind: Int
    public let tags: [[String]]
    public let content: String
    public var sig: String = ""    // 64-byte lowercase hex Schnorr signature

    public init(
        id: String,
        pubkey: String,
        created_at: Int,
        kind: Int,
        tags: [[String]],
        content: String,
        sig: String = ""
    ) {
        self.id = id
        self.pubkey = pubkey
        self.created_at = created_at
        self.kind = kind
        self.tags = tags
        self.content = content
        self.sig = sig
    }

    // MARK: Tag helpers

    public func tagValue(_ name: String) -> String? {
        tags.first(where: { $0.first == name })?[safe: 1]
    }

    public func tagValues(_ name: String) -> [String] {
        tags.filter { $0.first == name }.compactMap { $0[safe: 1] }
    }

    // MARK: Serialisation

    /// Returns the NIP-01 serialised JSON array used for id / signing.
    public func serialized() throws -> Data {
        let array: [Any] = [0, pubkey, created_at, kind, tags, content]
        return try JSONSerialization.data(withJSONObject: array, options: [.sortedKeys])
    }

    /// Computes the canonical event id.
    public func computedId() throws -> String {
        let serialized = try serialized()
        let digest = SHA256.hash(data: serialized)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Verifies the event id matches its contents.
    public func verifyId() throws -> Bool {
        try computedId() == id
    }
}

// MARK: - Unsigned event (for building + signing)

public struct UnsignedNostrEvent {
    public var pubkey: String
    public var created_at: Int
    public var kind: Int
    public var tags: [[String]]
    public var content: String

    public init(pubkey: String, kind: Int, tags: [[String]], content: String, created_at: Int = Int(Date().timeIntervalSince1970)) {
        self.pubkey = pubkey
        self.created_at = created_at
        self.kind = kind
        self.tags = tags
        self.content = content
    }

    /// Signs the event with the given private key bytes and returns a fully-formed NostrEvent.
    public func sign(privateKeyBytes: Data) throws -> NostrEvent {
        let partial = NostrEvent(id: "", pubkey: pubkey, created_at: created_at, kind: kind, tags: tags, content: content)
        let id = try partial.computedId()
        guard let idData = Data(hexString: id) else {
            throw NostrEventError.invalidId
        }
        let sigData = try Secp256k1Helpers.schnorrSign(message: idData, privateKeyBytes: privateKeyBytes)
        return NostrEvent(id: id, pubkey: pubkey, created_at: created_at, kind: kind, tags: tags, content: content, sig: sigData.hexString)
    }
}

// MARK: - Relay messages

public enum RelayMessage {
    case event(subscriptionId: String, event: NostrEvent)
    case eose(subscriptionId: String)
    case ok(eventId: String, accepted: Bool, message: String)
    case notice(message: String)
    case closed(subscriptionId: String, message: String)

    public static func parse(_ text: String) -> RelayMessage? {
        guard let data = text.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [Any],
              let type = arr.first as? String else { return nil }

        switch type {
        case "EVENT":
            guard arr.count >= 3,
                  let subId = arr[1] as? String,
                  let evtData = try? JSONSerialization.data(withJSONObject: arr[2]),
                  let evt = try? JSONDecoder().decode(NostrEvent.self, from: evtData) else { return nil }
            return .event(subscriptionId: subId, event: evt)

        case "EOSE":
            guard arr.count >= 2, let subId = arr[1] as? String else { return nil }
            return .eose(subscriptionId: subId)

        case "OK":
            guard arr.count >= 4,
                  let evtId = arr[1] as? String,
                  let accepted = arr[2] as? Bool,
                  let msg = arr[3] as? String else { return nil }
            return .ok(eventId: evtId, accepted: accepted, message: msg)

        case "NOTICE":
            guard arr.count >= 2, let msg = arr[1] as? String else { return nil }
            return .notice(message: msg)

        case "CLOSED":
            guard arr.count >= 3, let subId = arr[1] as? String, let msg = arr[2] as? String else { return nil }
            return .closed(subscriptionId: subId, message: msg)

        default: return nil
        }
    }
}

public enum NostrEventError: Error {
    case invalidId
    case signatureFailed
}

// MARK: - Helpers

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    init?(hexString: String) {
        let len = hexString.count
        guard len % 2 == 0 else { return nil }
        var data = Data(capacity: len / 2)
        var idx = hexString.startIndex
        while idx < hexString.endIndex {
            let next = hexString.index(idx, offsetBy: 2)
            guard let byte = UInt8(hexString[idx..<next], radix: 16) else { return nil }
            data.append(byte)
            idx = next
        }
        self = data
    }
}
