import Foundation

/// One command advertised by a bot in its NIP-51 commands list.
/// Contract: docs/bot-command-lists.md (mirrors taskify-pwa/src/lib/botCommands.ts).
public struct BotCommand: Codable, Equatable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let description: String

    public init(name: String, description: String) {
        self.name = name
        self.description = description
    }
}

/// NIP-51 bot commands list: parameterized replaceable kind 30078 with the
/// exact d-tag "taskify-bot-commands". The presence of this list is the
/// signal that the peer is a bot; the client shows a Telegram-style "/"
/// command menu in the composer.
public enum BotCommandsContract {
    public static let eventKind = 30_078
    public static let eventDTag = "taskify-bot-commands"
    public static let maxCommandCount = 100
    public static let maxDescriptionLength = 100

    private static let allowedNameCharacters = CharacterSet(
        charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_"
    )

    private static func isNameValid(_ raw: String) -> Bool {
        let name = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        return (1...32).contains(name.count) &&
            name.unicodeScalars.allSatisfy { allowedNameCharacters.contains($0) }
    }

    private static func normalizeDescription(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Strict recognition: the event is a bot commands list only when it is
    /// kind 30078, signed by the peer, with the exact d-tag and at least one
    /// valid `command` tag. Any other NIP-51 list (Chat-Friends, app backups,
    /// future d-tags) is ignored — returns nil.
    public static func decode(event: NostrEvent, publicKey: String) -> [BotCommand]? {
        guard event.kind == eventKind,
              event.publicKey.lowercased() == publicKey.lowercased(),
              event.firstTagValue(named: "d") == eventDTag,
              event.verify(),
              let commands = parseCommands(from: event) else { return nil }
        return commands
    }

    /// Parses `command` tags after the kind/d-tag checks have passed.
    /// Same caps as the PWA parser: name charset, single-line description
    /// capped at 100 chars, dedupe by name (first wins), max 100 commands.
    public static func parseCommands(from event: NostrEvent) -> [BotCommand]? {
        var commands: [BotCommand] = []
        var seen = Set<String>()
        for tag in event.tags {
            guard tag.count >= 2, tag[0] == "command", isNameValid(tag[1]) else { continue }
            let name = tag[1].lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if seen.contains(name) { continue }
            seen.insert(name)
            let description = tag.count > 2
                ? String(normalizeDescription(tag[2]).prefix(maxDescriptionLength))
                : ""
            commands.append(BotCommand(name: name, description: description))
            if commands.count >= maxCommandCount { break }
        }
        return commands.isEmpty ? nil : commands
    }

    /// Builds a signed kind-30078 commands event (parity with the PWA/CLI
    /// publishers; used by tests and any future in-app publisher). Applies
    /// the same normalization the readers apply.
    public static func event(
        commands: [BotCommand],
        identity: NostrIdentity,
        createdAt: Int
    ) throws -> NostrEvent {
        var seen = Set<String>()
        var commandTags: [[String]] = []
        for command in commands.prefix(maxCommandCount) {
            guard isNameValid(command.name) else { continue }
            let name = command.name.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            guard seen.insert(name).inserted else { continue }
            commandTags.append([
                "command",
                name,
                String(normalizeDescription(command.description).prefix(maxDescriptionLength))
            ])
        }
        guard !commandTags.isEmpty else {
            throw NostrEventError.invalidEvent
        }
        return try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: eventKind,
            tags: [["d", eventDTag]] + commandTags,
            content: ""
        )
    }
}

/// Fetches a peer's bot commands from its relays. Modeled on
/// `NostrContactFinder.profiles`: one connection per relay in a task group,
/// collecting until EOSE/timeout; the newest event by `createdAt` wins.
public enum BotCommandFinder {
    public static func commands(
        publicKey: String,
        relayURLs: [String],
        timeout: Duration = .seconds(3)
    ) async -> [BotCommand]? {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        guard NostrPublicKey.parse(publicKey) != nil, !relays.isEmpty else { return nil }
        let events = await withTaskGroup(of: [NostrEvent].self) { group in
            for relayURL in relays {
                group.addTask {
                    await fetchEvents(publicKey: publicKey, relayURL: relayURL, timeout: timeout)
                }
            }
            var collected: [NostrEvent] = []
            for await relayEvents in group { collected.append(contentsOf: relayEvents) }
            return collected
        }
        let latest = events.max { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }
        guard let latest else { return nil }
        return BotCommandsContract.decode(event: latest, publicKey: publicKey)
    }

    private static func fetchEvents(
        publicKey: String,
        relayURL: String,
        timeout: Duration
    ) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let id = "taskify-bot-commands-\(UUID().uuidString)"
        let stream = connection.messages()
        do {
            try await connection.connect()
            try await connection.subscribeToBotCommands(id: id, authorPublicKey: publicKey)
        } catch {
            await connection.disconnect()
            return []
        }
        let events = await collect(
            stream: stream,
            subscriptionID: id,
            timeout: timeout
        ) { event in
            BotCommandsContract.decode(event: event, publicKey: publicKey) != nil
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

/// Persisted cache of parsed commands per peer so the "/" menu is available
/// instantly at startup, with refreshes reconciling in the background.
/// Stored in UserDefaults like AppModel's other small caches; contains only
/// public bot-command strings (no user data). Used from the main actor only.
public struct BotCommandsCache {
    private struct Entry: Codable {
        let commands: [BotCommand]
        let fetchedAt: Date
    }

    public static let refreshInterval: TimeInterval = 24 * 60 * 60
    private let storageKey: String
    private let defaults: UserDefaults

    public init(storageKey: String = "taskify_bot_commands_cache_v1", defaults: UserDefaults = .standard) {
        self.storageKey = storageKey
        self.defaults = defaults
    }

    public func commands(for publicKey: String) -> [BotCommand]? {
        entries()[publicKey.lowercased()]?.commands
    }

    /// True when the peer has no cached entry or the entry is older than the refresh interval.
    public func shouldRefresh(publicKey: String) -> Bool {
        guard let entry = entries()[publicKey.lowercased()] else { return true }
        return Date().timeIntervalSince(entry.fetchedAt) > Self.refreshInterval
    }

    public func save(_ commands: [BotCommand], for publicKey: String) {
        var all = entries()
        all[publicKey.lowercased()] = Entry(commands: commands, fetchedAt: Date())
        guard let data = try? JSONEncoder().encode(all) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private func entries() -> [String: Entry] {
        guard let data = defaults.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([String: Entry].self, from: data) else {
            return [:]
        }
        return decoded
    }
}