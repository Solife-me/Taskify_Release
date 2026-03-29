import Foundation

public struct ContactShareEnvelopePayload: Equatable, Sendable {
    public var npub: String
    public var name: String?
    public var displayName: String?
    public var username: String?
    public var nip05: String?
    public var lud16: String?
    public var about: String?
    public var picture: String?
    public var relays: [String]
    public var senderNpub: String?
    public var senderName: String?

    public init(
        npub: String,
        name: String? = nil,
        displayName: String? = nil,
        username: String? = nil,
        nip05: String? = nil,
        lud16: String? = nil,
        about: String? = nil,
        picture: String? = nil,
        relays: [String] = [],
        senderNpub: String? = nil,
        senderName: String? = nil
    ) {
        self.npub = npub
        self.name = name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.username = sanitizeUsername(username ?? "").nilIfEmpty
        self.nip05 = normalizeNip05(nip05)
        self.lud16 = lud16?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.about = about?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.picture = picture?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.relays = normalizeRelayList(relays)
        self.senderNpub = senderNpub?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.senderName = senderName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
}

public struct ContactQRPayload: Codable, Equatable, Sendable {
    public var v: Int = 1
    public var kind: TaskifyContactKind
    public var npub: String?
    public var relays: [String]?
    public var name: String?
    public var displayName: String?
    public var username: String?
    public var lud16: String?
    public var nip05: String?
    public var picture: String?
}

public enum ContactShareContract {
    public static func buildEnvelopeString(
        contact: TaskifyContactRecord,
        sender: (npub: String?, name: String?)? = nil
    ) -> String? {
        let npub = formatContactNpub(contact.npub)
        guard npub.lowercased().hasPrefix("npub") else { return nil }
        let envelope = ShareEnvelope(
            item: ShareContactItem(
                npub: npub,
                relays: contact.relays.isEmpty ? nil : normalizeRelayList(contact.relays),
                name: contact.name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                displayName: contact.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                username: sanitizeUsername(contact.username ?? "").nilIfEmpty,
                nip05: normalizeNip05(contact.nip05),
                lud16: contact.address.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ),
            sender: sanitizeSender(sender)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(envelope) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func parseEnvelope(_ raw: String) -> ContactShareEnvelopePayload? {
        guard let data = raw.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(ShareEnvelope.self, from: data),
              envelope.v == 1,
              envelope.kind == "taskify-share",
              envelope.item.type == "contact" else {
            return nil
        }
        let npub = formatContactNpub(envelope.item.npub)
        guard npub.lowercased().hasPrefix("npub") else { return nil }
        return ContactShareEnvelopePayload(
            npub: npub,
            name: envelope.item.name,
            displayName: envelope.item.displayName,
            username: envelope.item.username,
            nip05: envelope.item.nip05,
            lud16: envelope.item.lud16,
            about: envelope.item.about,
            picture: envelope.item.picture,
            relays: envelope.item.relays ?? [],
            senderNpub: envelope.sender?.npub,
            senderName: envelope.sender?.name
        )
    }

    public static func buildQRValue(contact: TaskifyContactRecord) -> String? {
        let npub = formatContactNpub(contact.npub)
        if contact.kind == .nostr, npub.lowercased().hasPrefix("npub") {
            return npub
        }

        let payload = ContactQRPayload(
            kind: contact.kind,
            npub: npub.lowercased().hasPrefix("npub") ? npub : nil,
            relays: contact.relays.isEmpty ? nil : normalizeRelayList(contact.relays),
            name: contact.name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            displayName: contact.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            username: sanitizeUsername(contact.username ?? "").nilIfEmpty,
            lud16: contact.address.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            nip05: normalizeNip05(contact.nip05),
            picture: contact.picture?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(payload) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func parseQRValue(_ raw: String) -> TaskifyContactDraft? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let normalized = try? NostrIdentityService.normalizePublicKeyInput(trimmed),
           let npub = try? NostrIdentityService.encodeNpub(fromPublicKeyHex: normalized) {
            return TaskifyContactDraft(kind: .nostr, npub: npub)
        }

        guard let data = trimmed.data(using: .utf8),
              let payload = try? JSONDecoder().decode(ContactQRPayload.self, from: data),
              payload.v == 1 else {
            return nil
        }

        return TaskifyContactDraft(
            kind: payload.kind,
            name: payload.name ?? "",
            address: payload.lud16 ?? "",
            npub: payload.npub ?? "",
            username: payload.username ?? "",
            displayName: payload.displayName ?? "",
            nip05: payload.nip05 ?? "",
            picture: payload.picture ?? "",
            relays: payload.relays ?? []
        )
    }

    private static func sanitizeSender(_ sender: (npub: String?, name: String?)?) -> ShareSender? {
        guard let sender else { return nil }
        let npub = sender.npub?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let name = sender.name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if npub == nil, name == nil { return nil }
        return ShareSender(npub: npub, name: name)
    }
}

private struct ShareEnvelope: Codable {
    var v: Int = 1
    var kind: String = "taskify-share"
    var item: ShareContactItem
    var sender: ShareSender?
}

private struct ShareContactItem: Codable {
    var type: String = "contact"
    var npub: String
    var relays: [String]?
    var name: String?
    var displayName: String?
    var username: String?
    var nip05: String?
    var lud16: String?
    var about: String?
    var picture: String?
}

private struct ShareSender: Codable {
    var npub: String?
    var name: String?
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
