import CryptoKit
import Foundation

public let taskifyNip51ContactsKind = 30000
public let taskifyNip51ContactsDTag = "Chat-Friends"

public struct Nip51PrivateContact: Equatable, Sendable {
    public var pubkey: String
    public var relayHint: String?
    public var petname: String?

    public init(pubkey: String, relayHint: String? = nil, petname: String? = nil) {
        self.pubkey = pubkey
        self.relayHint = relayHint
        self.petname = petname
    }
}

public struct ContactSyncMetadata: Codable, Equatable, Sendable {
    public var lastEventId: String?
    public var lastUpdatedAt: Int?
    public var fingerprint: String?

    public init(lastEventId: String? = nil, lastUpdatedAt: Int? = nil, fingerprint: String? = nil) {
        self.lastEventId = lastEventId
        self.lastUpdatedAt = lastUpdatedAt
        self.fingerprint = fingerprint
    }
}

public enum ContactSyncStatus: String, Codable, Equatable, Sendable {
    case idle
    case loading
    case success
    case error
}

public struct ContactSyncState: Equatable, Sendable {
    public var status: ContactSyncStatus
    public var message: String?
    public var updatedAt: Int?

    public init(status: ContactSyncStatus = .idle, message: String? = nil, updatedAt: Int? = nil) {
        self.status = status
        self.message = message
        self.updatedAt = updatedAt
    }
}

public func buildNip51PrivateItems(_ contacts: [TaskifyContactRecord]) -> [[String]] {
    var seen = Set<String>()
    var items: [[String]] = []

    for contact in contacts {
        guard let pubkey = try? NostrIdentityService.normalizePublicKeyInput(contact.npub),
              seen.insert(pubkey).inserted else {
            continue
        }
        let relayHint = contact.relays.first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        let petname = contact.name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? contact.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? sanitizeUsername(contact.username ?? "").nilIfEmpty
        var tag = ["p", pubkey]
        if relayHint != nil || petname != nil {
            tag.append(relayHint?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        }
        if let petname {
            if relayHint == nil {
                tag.append("")
            }
            tag.append(petname)
        }
        items.append(tag)
    }

    return items
}

public func encryptNip51PrivateItems(_ items: [[String]], privateKeyHex: String, publicKeyHex: String) throws -> String {
    let jsonData = try JSONEncoder().encode(items)
    guard let json = String(data: jsonData, encoding: .utf8),
          let privateKeyBytes = Data(hexString: privateKeyHex) else {
        throw ContactSyncError.invalidKey
    }
    let conversationKey = try Secp256k1Helpers.nip44ConversationKey(
        privateKeyBytes: privateKeyBytes,
        publicKeyHex: publicKeyHex
    )
    return try NIP44.encrypt(plaintext: json, conversationKey: conversationKey)
}

public func decryptNip51PrivateItems(_ payload: String, privateKeyHex: String, publicKeyHex: String) throws -> [[String]] {
    guard let privateKeyBytes = Data(hexString: privateKeyHex) else {
        throw ContactSyncError.invalidKey
    }
    let conversationKey = try Secp256k1Helpers.nip44ConversationKey(
        privateKeyBytes: privateKeyBytes,
        publicKeyHex: publicKeyHex
    )
    let plaintext = try NIP44.decrypt(payload: payload, conversationKey: conversationKey)
    guard let data = plaintext.data(using: .utf8) else { return [] }
    let decoded = try JSONDecoder().decode([[String]].self, from: data)
    return decoded
}

public func extractNip51PrivateContacts(_ items: [[String]]) -> [Nip51PrivateContact] {
    var seen = Set<String>()
    var contacts: [Nip51PrivateContact] = []

    for tag in items where tag.first == "p" && tag.count >= 2 {
        guard let pubkey = try? NostrIdentityService.normalizePublicKeyInput(tag[1]),
              seen.insert(pubkey).inserted else {
            continue
        }
        let relayHint = tag.count > 2 ? tag[2].trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty : nil
        let petname = tag.count > 3 ? tag[3].trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty : nil
        contacts.append(Nip51PrivateContact(pubkey: pubkey, relayHint: relayHint, petname: petname))
    }

    return contacts
}

public func mergeContactsByPubkey(base: [TaskifyContactRecord], incoming: [TaskifyContactRecord]) -> [TaskifyContactRecord] {
    var merged = base
    var seen = Set(base.compactMap { try? NostrIdentityService.normalizePublicKeyInput($0.npub) })
    for contact in incoming {
        guard let normalized = try? NostrIdentityService.normalizePublicKeyInput(contact.npub),
              !seen.contains(normalized) else {
            continue
        }
        seen.insert(normalized)
        merged.append(contact)
    }
    return merged
}

public func computeContactsFingerprint(_ contacts: [TaskifyContactRecord]) -> String {
    let normalized = contacts
        .map { contact in
            NormalizedFingerprintContact(
                id: contact.id,
                kind: contact.kind.rawValue,
                name: contact.name.trimmingCharacters(in: .whitespacesAndNewlines),
                address: contact.address.trimmingCharacters(in: .whitespacesAndNewlines),
                paymentRequest: contact.paymentRequest.trimmingCharacters(in: .whitespacesAndNewlines),
                npub: formatContactNpub(contact.npub),
                username: sanitizeUsername(contact.username ?? ""),
                displayName: contact.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                nip05: normalizeNip05(contact.nip05) ?? "",
                about: contact.about?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                picture: contact.picture?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                relays: normalizeRelayList(contact.relays).sorted()
            )
        }
        .sorted { $0.id < $1.id }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = (try? encoder.encode(normalized)) ?? Data()
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}

public func parseProfileMetadata(content: String) -> TaskifyProfileMetadata {
    guard let data = content.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return TaskifyProfileMetadata()
    }

    let username = (parsed["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let displayName =
        (parsed["display_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        ?? (parsed["displayName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        ?? ""
    let lud16 =
        (parsed["lud16"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        ?? (parsed["lightning_address"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        ?? ""
    let nip05 = (parsed["nip05"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let about = (parsed["about"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let picture = (parsed["picture"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    return TaskifyProfileMetadata(
        username: sanitizeUsername(username),
        displayName: displayName,
        lud16: lud16,
        nip05: nip05,
        about: about,
        picture: picture
    )
}

public func buildProfileMetadataContent(_ metadata: TaskifyProfileMetadata) -> String {
    var content: [String: String] = [:]
    let username = sanitizeUsername(metadata.username)
    if !username.isEmpty {
        content["name"] = username
    }
    let displayName = metadata.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    if !displayName.isEmpty {
        content["display_name"] = displayName
    }
    let about = metadata.about.trimmingCharacters(in: .whitespacesAndNewlines)
    if !about.isEmpty {
        content["about"] = about
    }
    let picture = metadata.picture.trimmingCharacters(in: .whitespacesAndNewlines)
    if !picture.isEmpty {
        content["picture"] = picture
    }
    let lightning = metadata.lud16.trimmingCharacters(in: .whitespacesAndNewlines)
    if !lightning.isEmpty {
        content["lud16"] = lightning
        content["lightning_address"] = lightning
    }
    if let nip05 = normalizeNip05(metadata.nip05) {
        content["nip05"] = nip05
    }
    let data = (try? JSONSerialization.data(withJSONObject: content, options: [.sortedKeys])) ?? Data("{}".utf8)
    return String(data: data, encoding: .utf8) ?? "{}"
}

public func extractPublicFollows(from tags: [[String]]) -> [TaskifyPublicFollowRecord] {
    var seen = Set<String>()
    var follows: [TaskifyPublicFollowRecord] = []
    for tag in tags where tag.first == "p" && tag.count >= 2 {
        guard let pubkey = try? NostrIdentityService.normalizePublicKeyInput(tag[1]),
              seen.insert(pubkey).inserted else {
            continue
        }
        follows.append(TaskifyPublicFollowRecord(
            pubkey: pubkey,
            relay: tag.count > 2 ? tag[2].trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty : nil,
            petname: tag.count > 3 ? tag[3].trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty : nil
        ))
    }
    return follows
}

public func buildPublicFollowTags(_ follows: [TaskifyPublicFollowRecord]) -> [[String]] {
    follows.compactMap { follow in
        let pubkey = follow.pubkey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pubkey.isEmpty else { return nil }
        var tag = ["p", pubkey]
        let relay = follow.relay?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let petname = follow.petname?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if relay != nil || petname != nil {
            tag.append(relay ?? "")
        }
        if let petname {
            if relay == nil {
                tag.append("")
            }
            tag.append(petname)
        }
        return tag
    }
}

public enum ContactSyncError: Error, LocalizedError {
    case invalidKey

    public var errorDescription: String? {
        switch self {
        case .invalidKey:
            return "Invalid Nostr key material."
        }
    }
}

private struct NormalizedFingerprintContact: Codable {
    var id: String
    var kind: String
    var name: String
    var address: String
    var paymentRequest: String
    var npub: String
    var username: String
    var displayName: String
    var nip05: String
    var about: String
    var picture: String
    var relays: [String]
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
