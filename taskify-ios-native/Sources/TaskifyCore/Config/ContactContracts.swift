import Foundation

public enum Nip05CheckStatus: String, Codable, Equatable, Sendable {
    case pending
    case valid
    case invalid
}

public struct Nip05CheckState: Codable, Equatable, Sendable {
    public var status: Nip05CheckStatus
    public var nip05: String
    public var npub: String
    public var checkedAt: Int
    public var contactUpdatedAt: Int?

    public init(
        status: Nip05CheckStatus,
        nip05: String,
        npub: String,
        checkedAt: Int,
        contactUpdatedAt: Int? = nil
    ) {
        self.status = status
        self.nip05 = nip05
        self.npub = npub
        self.checkedAt = checkedAt
        self.contactUpdatedAt = contactUpdatedAt
    }
}

public func makeContactId() -> String {
    UUID().uuidString.lowercased()
}

public func normalizeRelayList(_ relays: [String]) -> [String] {
    var seen = Set<String>()
    var ordered: [String] = []
    for relay in relays.compactMap(RelayBlocklistStore.normalize) where seen.insert(relay).inserted {
        ordered.append(relay)
    }
    return ordered
}

public func sanitizeUsername(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
        .replacingOccurrences(of: "^@+", with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

public func formatContactUsername(_ value: String?) -> String {
    let sanitized = sanitizeUsername(value ?? "")
    return sanitized.isEmpty ? "" : "@\(sanitized)"
}

public func normalizeNip05(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty else { return nil }
    let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let name = parts[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let domain = parts[1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !name.isEmpty, !domain.isEmpty else { return nil }
    return "\(name)@\(domain)"
}

public func contactInitials(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "?" }
    let parts = trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
    if parts.count == 1 {
        return String(parts[0].prefix(2)).uppercased()
    }
    guard let first = parts.first?.first, let last = parts.last?.first else { return "?" }
    return String(first).uppercased() + String(last).uppercased()
}

public func formatContactNpub(_ value: String?) -> String {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty else { return "" }
    if trimmed.lowercased().hasPrefix("npub") {
        return trimmed
    }
    guard let npub = try? NostrIdentityService.encodeNpub(fromPublicKeyHex: trimmed) else {
        return trimmed
    }
    return npub
}

public func normalizeNostrPubkeyHex(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty else { return nil }
    return try? NostrIdentityService.normalizePublicKeyInput(trimmed)
}

public func contactPrimaryName(_ contact: TaskifyContactRecord) -> String {
    let nickname = contact.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let displayName = (contact.displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let username = formatContactUsername(contact.username)
    let npub = formatContactNpub(contact.npub)
    return nickname.isEmpty ? (displayName.isEmpty ? (username.isEmpty ? (npub.isEmpty ? "Contact" : npub) : username) : displayName) : nickname
}

public func contactVerifiedNip05(
    contact: TaskifyContactRecord,
    cache: [String: Nip05CheckState]
) -> String? {
    let nip05 = contact.nip05?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !nip05.isEmpty,
          let normalizedNip05 = normalizeNip05(nip05),
          let contactHex = normalizeNostrPubkeyHex(contact.npub),
          let entry = cache[contact.id],
          entry.status == .valid,
          normalizeNip05(entry.nip05) == normalizedNip05,
          normalizeNostrPubkeyHex(entry.npub) == contactHex else {
        return nil
    }
    return nip05
}

public func contactSubtitle(_ contact: TaskifyContactRecord) -> String? {
    let lightning = contact.address.trimmingCharacters(in: .whitespacesAndNewlines)
    if !lightning.isEmpty { return lightning }
    let normalizedNip05 = normalizeNip05(contact.nip05)
    if let normalizedNip05, !normalizedNip05.isEmpty { return normalizedNip05 }
    let username = formatContactUsername(contact.username)
    if !username.isEmpty { return username }
    let npub = formatContactNpub(contact.npub)
    return npub.isEmpty ? nil : npub
}

public func contactHasNpub(_ contact: TaskifyContactRecord) -> Bool {
    !contact.npub.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

public func contactHasLightning(_ contact: TaskifyContactRecord) -> Bool {
    !contact.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

public extension TaskifyContact {
    var kind: TaskifyContactKind {
        get { TaskifyContactKind(rawValue: kindRaw) ?? .custom }
        set { kindRaw = newValue.rawValue }
    }

    var source: TaskifyContactSource? {
        get { sourceRaw.flatMap(TaskifyContactSource.init(rawValue:)) }
        set { sourceRaw = newValue?.rawValue }
    }

    var relays: [String] {
        get {
            guard let relaysJSON,
                  let data = relaysJSON.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode([String].self, from: data) else {
                return []
            }
            return decoded
        }
        set {
            let normalized = normalizeRelayList(newValue)
            guard !normalized.isEmpty,
                  let data = try? JSONEncoder().encode(normalized),
                  let json = String(data: data, encoding: .utf8) else {
                relaysJSON = nil
                return
            }
            relaysJSON = json
        }
    }

    func toRecord() -> TaskifyContactRecord {
        TaskifyContactRecord(
            id: id,
            kind: kind,
            name: name,
            address: address,
            paymentRequest: paymentRequest,
            npub: npub,
            username: username,
            displayName: displayName,
            nip05: nip05,
            about: about,
            picture: picture,
            relays: relays,
            createdAt: createdAt,
            updatedAt: updatedAt,
            source: source
        )
    }

    func apply(draft: TaskifyContactDraft, timestampMs: Int) {
        kind = draft.kind
        name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        address = draft.address.trimmingCharacters(in: .whitespacesAndNewlines)
        paymentRequest = draft.paymentRequest.trimmingCharacters(in: .whitespacesAndNewlines)
        npub = draft.npub.trimmingCharacters(in: .whitespacesAndNewlines)
        username = sanitizeUsername(draft.username).nilIfEmpty
        displayName = draft.displayName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        nip05 = normalizeNip05(draft.nip05)
        about = draft.about.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        picture = draft.picture.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        relays = draft.relays
        updatedAt = timestampMs
        if createdAt == 0 {
            createdAt = timestampMs
        }
        source = draft.source ?? source
    }
}

public extension TaskifyPublicFollow {
    func toRecord() -> TaskifyPublicFollowRecord {
        TaskifyPublicFollowRecord(
            pubkey: pubkey,
            relay: relay,
            petname: petname,
            username: username,
            nip05: nip05,
            updatedAt: updatedAt
        )
    }

    func apply(record: TaskifyPublicFollowRecord) {
        relay = record.relay?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        petname = record.petname?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        username = sanitizeUsername(record.username ?? "").nilIfEmpty
        nip05 = normalizeNip05(record.nip05)
        updatedAt = record.updatedAt
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
