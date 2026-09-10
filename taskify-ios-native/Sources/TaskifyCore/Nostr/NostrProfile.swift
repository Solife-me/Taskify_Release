import Foundation

/// A draft of the signed Nostr profile (NIP-01 kind:0) edited in the contacts "My Card" editor.
/// Mirrors the PWA's `profileForm` in `taskify-pwa/src/hooks/wallet/useContactsState.ts` — the
/// username field maps to the Nostr `name` attribute.
public struct NostrProfileDraft: Equatable, Sendable {
    public var username: String?
    public var displayName: String?
    public var about: String?
    public var picture: String?
    public var lud16: String?
    public var nip05: String?

    public init(
        username: String? = nil,
        displayName: String? = nil,
        about: String? = nil,
        picture: String? = nil,
        lud16: String? = nil,
        nip05: String? = nil
    ) {
        self.username = username?.trimmedNilIfEmpty
        self.displayName = displayName?.trimmedNilIfEmpty
        self.about = about?.trimmedNilIfEmpty
        self.picture = picture?.trimmedNilIfEmpty
        self.lud16 = lud16?.trimmedNilIfEmpty
        self.nip05 = nip05?.trimmedNilIfEmpty
    }

    /// Pre-fills the editor from the last known profile. The Nostr `name` attribute is the
    /// username, so it feeds the editor's username field even when no separate `username`
    /// key was published — otherwise re-publishing would silently drop it.
    public init(profile: NostrContactProfile?) {
        self.init(
            username: profile?.username ?? profile?.name,
            displayName: profile?.displayName,
            about: profile?.about,
            picture: profile?.picture,
            lud16: profile?.lud16,
            nip05: profile?.nip05
        )
    }
}

/// Builds and reads the NIP-01 profile event. Content keys match the PWA's `buildProfileContent`
/// (`taskify-pwa/src/nostr/ProfilePublisher.ts`) so both clients publish and read the same shape:
/// `name`, `display_name`, `about`, `picture`, `lud16` + `lightning_address`, `nip05`.
public enum NostrProfileContract {
    public static let eventKind = 0
    public static let deletionEventKind = 5

    /// Content JSON for a profile event. Unknown keys from the previous event (e.g. `banner`,
    /// `website` written by other clients) are preserved; keys the draft cleared are removed —
    /// including alternate spellings other clients use (`image`/`avatar` for `picture`,
    /// `lightning_address` for `lud16`) so stale values don't resurface.
    public static func contentJSON(
        previousContent: String?,
        draft: NostrProfileDraft
    ) throws -> String {
        var object: [String: Any] = [:]
        if let previousContent,
           let data = previousContent.data(using: .utf8),
           let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            object = decoded
        }
        // A cleared editor field removes the key and its alternate spellings.
        func assign(_ key: String, _ value: String?, alternateKeys: [String] = []) {
            for alternate in alternateKeys { object.removeValue(forKey: alternate) }
            if let value = value?.trimmedNilIfEmpty {
                object[key] = value
            } else {
                object.removeValue(forKey: key)
            }
        }
        assign("name", draft.username, alternateKeys: ["username"])
        assign("display_name", draft.displayName, alternateKeys: ["displayName"])
        assign("about", draft.about, alternateKeys: [])
        assign("picture", draft.picture, alternateKeys: ["image", "avatar"])
        assign("lud16", draft.lud16, alternateKeys: ["lightning_address"])
        assign("nip05", draft.nip05, alternateKeys: [])
        if let lud16 = draft.lud16 {
            object["lightning_address"] = lud16
        }
        guard JSONSerialization.isValidJSONObject(object) else {
            throw NostrProfileError.invalidContent
        }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
        return String(data: data, encoding: .utf8) ?? ""
    }

    public static func event(
        draft: NostrProfileDraft,
        previousContent: String?,
        identity: NostrIdentity,
        createdAt: Int
    ) throws -> NostrEvent {
        try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: eventKind,
            tags: [],
            content: try contentJSON(previousContent: previousContent, draft: draft)
        )
    }

    /// NIP-01 deletion (kind:5) of the superseded profile event, matching the PWA's
    /// `publishProfileMetadata`, which deletes the previous profile after publishing a new one.
    public static func deletionEvent(
        previousEventID: String,
        identity: NostrIdentity,
        createdAt: Int
    ) throws -> NostrEvent {
        try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: deletionEventKind,
            tags: [["e", previousEventID.lowercased()], ["k", String(eventKind)]],
            content: ""
        )
    }
}

public enum NostrProfileError: LocalizedError, Equatable {
    case invalidContent
    case invalidPayload

    public var errorDescription: String? {
        switch self {
        case .invalidContent: "The profile content could not be encoded."
        case .invalidPayload: "The scanned contact payload is malformed."
        }
    }
}

/// A `taskify:contact:<base64 JSON>` share payload, matching the PWA's `ContactSharePayload`
/// (`taskify-pwa/src/wallet/walletModalHelpers.tsx`). Scanned or otherwise imported to pre-fill
/// the contact editor.
public struct ContactSharePayload: Equatable, Sendable {
    public var npub: String?
    public var relays: [String]
    public var name: String?
    public var displayName: String?
    public var lud16: String?
    public var nip05: String?
    public var picture: String?

    public init(
        npub: String? = nil,
        relays: [String] = [],
        name: String? = nil,
        displayName: String? = nil,
        lud16: String? = nil,
        nip05: String? = nil,
        picture: String? = nil
    ) {
        self.npub = npub?.trimmedNilIfEmpty
        self.relays = TaskifyRelayURL.normalizedList(relays)
        self.name = name?.trimmedNilIfEmpty
        self.displayName = displayName?.trimmedNilIfEmpty
        self.lud16 = lud16?.trimmedNilIfEmpty
        self.nip05 = nip05?.trimmedNilIfEmpty
        self.picture = picture?.trimmedNilIfEmpty
    }

    public static let uriPrefix = "taskify:contact:"

    /// Accepts `taskify:contact:<base64 JSON>` (standard or URL-safe base64, padding optional).
    public static func decode(_ value: String) -> ContactSharePayload? {
        guard value.lowercased().hasPrefix(uriPrefix) else { return nil }
        let encoded = String(value.dropFirst(uriPrefix.count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        guard let data = Data(base64Encoded: padded),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        func string(_ key: String) -> String? { object[key] as? String }
        let relays = (object["relays"] as? [Any])?.compactMap { $0 as? String } ?? []
        let npub = string("npub")
        // A nostr-kind payload must carry a usable key; lightning-only custom cards are not
        // valid here because the native contact list is Nostr-keyed.
        guard NostrPublicKey.parse(npub ?? "") != nil else { return nil }
        return ContactSharePayload(
            npub: npub,
            relays: relays,
            name: string("name"),
            displayName: string("displayName"),
            lud16: object["lud16"] as? String,
            nip05: object["nip05"] as? String,
            picture: object["picture"] as? String
        )
    }
}

public enum NostrProfilePayload {
    /// Decodes an `nprofile` bech32 value into its public key and relay hints (NIP-19 TLV).
    public static func decodeNprofile(_ value: String) -> (publicKey: Data, relayURLs: [String])? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("nprofile1"),
              let data = try? Bech32.decode(trimmed, expectedPrefix: "nprofile") else {
            return nil
        }
        var publicKey: Data?
        var relays: [String] = []
        var index = 0
        while index + 2 <= data.count {
            let type = data[index]
            let length = Int(data[index + 1])
            let start = index + 2
            guard start + length <= data.count else { break }
            let chunk = data.subdata(in: start..<start + length)
            switch type {
            case 0 where publicKey == nil && length == 32:
                publicKey = chunk
            case 1 where length > 0:
                if let relay = String(data: data.subdata(in: start..<start + length), encoding: .utf8) {
                    relays.append(relay)
                }
            default:
                break
            }
            index = start + length
        }
        guard let publicKey else { return nil }
        return (publicKey, TaskifyRelayURL.normalizedList(relays))
    }
}

private extension String {
    var trimmedNilIfEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}