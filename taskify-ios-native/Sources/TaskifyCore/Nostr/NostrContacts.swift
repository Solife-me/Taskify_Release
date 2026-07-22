import Foundation

public struct NostrContactProfile: Codable, Equatable, Sendable {
    public var name: String?
    public var displayName: String?
    public var username: String?
    public var about: String?
    public var picture: String?
    public var lud16: String?
    public var nip05: String?
    public var eventCreatedAt: Int

    public init(
        name: String? = nil,
        displayName: String? = nil,
        username: String? = nil,
        about: String? = nil,
        picture: String? = nil,
        lud16: String? = nil,
        nip05: String? = nil,
        eventCreatedAt: Int
    ) {
        self.name = name?.trimmedNilIfEmpty
        self.displayName = displayName?.trimmedNilIfEmpty
        self.username = username?.trimmedNilIfEmpty
        self.about = about?.trimmedNilIfEmpty
        self.picture = picture?.trimmedNilIfEmpty
        self.lud16 = lud16?.trimmedNilIfEmpty
        self.nip05 = nip05?.trimmedNilIfEmpty
        self.eventCreatedAt = eventCreatedAt
    }

    public static func decode(event: NostrEvent) -> NostrContactProfile? {
        guard event.kind == 0, event.verify(),
              let data = event.content.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        func string(_ keys: String...) -> String? {
            for key in keys {
                if let value = object[key] as? String,
                   let trimmed = value.trimmedNilIfEmpty {
                    return trimmed
                }
            }
            return nil
        }
        return NostrContactProfile(
            name: string("name"),
            displayName: string("display_name", "displayName"),
            username: string("username"),
            about: string("about"),
            picture: string("picture"),
            lud16: string("lud16"),
            nip05: string("nip05"),
            eventCreatedAt: event.createdAt
        )
    }
}

public struct NostrContact: Identifiable, Codable, Equatable, Sendable {
    public var id: String { publicKey }
    public var publicKey: String
    public var npub: String
    public var relayURLs: [String]
    public var petname: String?
    public var profile: NostrContactProfile?

    public init?(
        publicKeyValue: String,
        relayURLs: [String] = [],
        petname: String? = nil,
        profile: NostrContactProfile? = nil
    ) {
        guard let key = NostrPublicKey.parse(publicKeyValue),
              let encoded = NostrPublicKey.npub(from: key) else { return nil }
        publicKey = key.hexString
        npub = encoded
        self.relayURLs = TaskifyRelayURL.normalizedList(relayURLs)
        self.petname = petname?.trimmedNilIfEmpty
        self.profile = profile
    }

    public var displayName: String {
        petname?.trimmedNilIfEmpty
            ?? profile?.displayName?.trimmedNilIfEmpty
            ?? profile?.name?.trimmedNilIfEmpty
            ?? profile?.username?.trimmedNilIfEmpty.map { "@\($0.trimmingCharacters(in: CharacterSet(charactersIn: "@")))" }
            ?? shortNpub
    }

    public var subtitle: String {
        profile?.nip05?.trimmedNilIfEmpty
            ?? profile?.lud16?.trimmedNilIfEmpty
            ?? shortNpub
    }

    public var shortNpub: String {
        npub.count > 22 ? "\(npub.prefix(12))…\(npub.suffix(6))" : npub
    }

    public var pictureURL: URL? {
        guard let value = profile?.picture?.trimmedNilIfEmpty,
              let url = URL(string: value),
              url.scheme == "https" || url.scheme == "http" else { return nil }
        return url
    }

    public var initials: String {
        let words = displayName
            .split(whereSeparator: { $0.isWhitespace })
            .prefix(2)
        let value = words.compactMap(\.first).map(String.init).joined().uppercased()
        return value.isEmpty ? "?" : value
    }
}

public struct NIP51ContactList: Equatable, Sendable {
    public let contacts: [NostrContact]
    public let eventCreatedAt: Int
    public let extraTags: [[String]]

    public init(contacts: [NostrContact], eventCreatedAt: Int, extraTags: [[String]] = []) {
        self.contacts = contacts
        self.eventCreatedAt = eventCreatedAt
        self.extraTags = extraTags
    }
}

public enum NIP51ContactListError: LocalizedError, Equatable {
    case invalidEvent
    case invalidPayload

    public var errorDescription: String? {
        switch self {
        case .invalidEvent: "The private contact-list event could not be verified."
        case .invalidPayload: "The encrypted private contact list is malformed."
        }
    }
}

public enum NIP51ContactListContract {
    public static let eventKind = 30_000
    public static let eventDTag = "Chat-Friends"

    public static func decode(
        event: NostrEvent,
        identity: NostrIdentity
    ) throws -> NIP51ContactList {
        guard event.kind == eventKind,
              event.publicKey.lowercased() == identity.publicKeyHex,
              event.firstTagValue(named: "d") == eventDTag,
              event.verify() else {
            throw NIP51ContactListError.invalidEvent
        }
        let plaintext = try NIP44V2.decrypt(
            event.content,
            privateKey: identity.privateKey,
            publicKey: identity.publicKey
        )
        guard let raw = try? JSONSerialization.jsonObject(with: plaintext) as? [[Any]] else {
            throw NIP51ContactListError.invalidPayload
        }
        var seen = Set<String>()
        var contacts: [NostrContact] = []
        for tag in raw {
            guard tag.count >= 2,
                  tag[0] as? String == "p",
                  let key = tag[1] as? String,
                  let parsedKey = NostrPublicKey.parse(key),
                  seen.insert(parsedKey.hexString).inserted else { continue }
            let relay = tag.count > 2 ? tag[2] as? String : nil
            let standardPetname = tag.count > 3 ? tag[3] as? String : nil
            let fallbackPetname = tag.dropFirst(3)
                .compactMap { ($0 as? String)?.trimmedNilIfEmpty }
                .last
            guard let contact = NostrContact(
                publicKeyValue: parsedKey.hexString,
                relayURLs: relay.map { [$0] } ?? [],
                petname: standardPetname?.trimmedNilIfEmpty ?? fallbackPetname
            ) else { continue }
            contacts.append(contact)
        }
        return NIP51ContactList(
            contacts: contacts,
            eventCreatedAt: event.createdAt,
            extraTags: event.tags.filter { $0.first != "d" && $0.first != "client" }
        )
    }

    public static func event(
        contacts: [NostrContact],
        identity: NostrIdentity,
        createdAt: Int,
        extraTags: [[String]] = [],
        nonce: Data? = nil
    ) throws -> NostrEvent {
        var seen = Set<String>()
        let privateItems: [[String]] = contacts.compactMap { contact in
            guard seen.insert(contact.publicKey).inserted else { return nil }
            var tag = ["p", contact.publicKey]
            if let relay = contact.relayURLs.first, !relay.isEmpty {
                tag.append(relay)
            } else if contact.petname != nil {
                tag.append("")
            }
            if let petname = contact.petname?.trimmedNilIfEmpty {
                tag.append(petname)
            }
            return tag
        }
        let plaintext = try JSONSerialization.data(
            withJSONObject: privateItems,
            options: [.withoutEscapingSlashes]
        )
        let content = try NIP44V2.encrypt(
            plaintext,
            privateKey: identity.privateKey,
            publicKey: identity.publicKey,
            nonce: nonce
        )
        var tags = extraTags.filter { $0.first != "d" && $0.first != "client" }
        tags.insert(["client", "taskify.app"], at: 0)
        tags.insert(["d", eventDTag], at: 0)
        return try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: eventKind,
            tags: tags,
            content: content
        )
    }
}

public enum NostrContactFinder {
    public static func findPrivateListCandidates(
        publicKey: String,
        relayURLs: [String],
        timeout: Duration = .seconds(4)
    ) async -> [NostrEvent] {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        guard NostrPublicKey.parse(publicKey) != nil, !relays.isEmpty else { return [] }
        return await withTaskGroup(of: [NostrEvent].self) { group in
            for relayURL in relays {
                group.addTask {
                    await fetchPrivateLists(
                        publicKey: publicKey,
                        relayURL: relayURL,
                        timeout: timeout
                    )
                }
            }
            var eventsByID: [String: NostrEvent] = [:]
            for await events in group {
                for event in events { eventsByID[event.id] = event }
            }
            return eventsByID.values.sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
                return $0.id > $1.id
            }
        }
    }

    public static func profiles(
        publicKeys: [String],
        relayURLs: [String],
        timeout: Duration = .seconds(3)
    ) async -> [String: NostrContactProfile] {
        let authors = Array(Set(publicKeys.compactMap { NostrPublicKey.parse($0)?.hexString }))
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !authors.isEmpty, !relays.isEmpty else { return [:] }
        let events = await withTaskGroup(of: [NostrEvent].self) { group in
            for relayURL in relays {
                group.addTask {
                    await fetchProfiles(
                        publicKeys: authors,
                        relayURL: relayURL,
                        timeout: timeout
                    )
                }
            }
            var collected: [NostrEvent] = []
            for await relayEvents in group { collected.append(contentsOf: relayEvents) }
            return collected
        }
        var profiles: [String: NostrContactProfile] = [:]
        for event in events.sorted(by: { $0.createdAt < $1.createdAt }) {
            guard let profile = NostrContactProfile.decode(event: event) else { continue }
            profiles[event.publicKey.lowercased()] = profile
        }
        return profiles
    }

    private static func fetchPrivateLists(
        publicKey: String,
        relayURL: String,
        timeout: Duration
    ) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let id = "taskify-contacts-\(UUID().uuidString)"
        let stream = connection.messages()
        do {
            try await connection.connect()
            try await connection.subscribeToPrivateContacts(
                id: id,
                authorPublicKey: publicKey
            )
        } catch {
            await connection.disconnect()
            return []
        }
        let events = await collect(
            stream: stream,
            subscriptionID: id,
            timeout: timeout
        ) { event in
            event.kind == NIP51ContactListContract.eventKind &&
                event.publicKey.lowercased() == publicKey.lowercased() &&
                event.firstTagValue(named: "d") == NIP51ContactListContract.eventDTag &&
                event.verify()
        }
        try? await connection.closeSubscription(id: id)
        await connection.disconnect()
        return events
    }

    private static func fetchProfiles(
        publicKeys: [String],
        relayURL: String,
        timeout: Duration
    ) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let id = "taskify-profiles-\(UUID().uuidString)"
        let stream = connection.messages()
        do {
            try await connection.connect()
            try await connection.subscribeToProfiles(
                id: id,
                authorPublicKeys: publicKeys
            )
        } catch {
            await connection.disconnect()
            return []
        }
        let authors = Set(publicKeys)
        let events = await collect(
            stream: stream,
            subscriptionID: id,
            timeout: timeout
        ) { event in
            event.kind == 0 && authors.contains(event.publicKey.lowercased()) && event.verify()
        }
        try? await connection.closeSubscription(id: id)
        await connection.disconnect()
        return events
    }

    private static func collect(
        stream: AsyncStream<NostrRelayMessage>,
        subscriptionID: String,
        timeout: Duration,
        accepts: @escaping @Sendable (NostrEvent) -> Bool
    ) async -> [NostrEvent] {
        await withTaskGroup(of: [NostrEvent].self) { group in
            group.addTask {
                var matches: [NostrEvent] = []
                for await message in stream {
                    guard !Task.isCancelled else { return matches }
                    switch message {
                    case .event(let id, let event) where id == subscriptionID:
                        if accepts(event) { matches.append(event) }
                    case .endOfStoredEvents(let id) where id == subscriptionID:
                        return matches
                    case .closed(let id, _) where id == subscriptionID:
                        return matches
                    case .disconnected:
                        return matches
                    default:
                        continue
                    }
                }
                return matches
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return []
            }
            let first = await group.next() ?? []
            group.cancelAll()
            return first
        }
    }
}

private extension String {
    var trimmedNilIfEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
