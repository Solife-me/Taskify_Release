import Foundation
import Testing
@testable import TaskifyCore

@Suite("BotCommands")
struct BotCommandsTests {
    private let identity: NostrIdentity

    init() throws {
        // Deterministic test key (mirrors the fixture-key style in AccountBackupTests).
        identity = try NostrIdentity(privateKey: Data(hex: String(repeating: "01", count: 32)))
    }

    private func commandsEvent(
        _ commands: [(name: String, description: String)],
        kind: Int = BotCommandsContract.eventKind,
        dTag: String = BotCommandsContract.eventDTag,
        author: NostrIdentity? = nil,
        createdAt: Int = 1_700_000_000
    ) throws -> NostrEvent {
        try NostrEvent.signed(
            privateKey: (author ?? identity).privateKey,
            createdAt: createdAt,
            kind: kind,
            tags: [
                ["d", dTag],
                ["alt", "Taskify bot commands (\(commands.count))"],
                ["client", "test"],
            ] + commands.map { ["command", $0.name, $0.description] },
            content: ""
        )
    }

    private func decode(_ event: NostrEvent, author: NostrIdentity? = nil) -> [BotCommand]? {
        BotCommandsContract.decode(event: event, publicKey: (author ?? identity).publicKeyHex)
    }

    // MARK: - Strict recognition

    @Test("decode accepts a valid signed commands event")
    func decodeAcceptsValidEvent() throws {
        let event = try commandsEvent([
            ("start", "Begin setup"),
            ("today_tasks", "List today's tasks"),
        ])
        let commands = try #require(decode(event))
        #expect(commands.map(\.name) == ["start", "today_tasks"])
        #expect(commands.map(\.description) == ["Begin setup", "List today's tasks"])
    }

    @Test("decode rejects the wrong kind, d-tag, author, or signature")
    func decodeRejectsNonCommandEvents() throws {
        // Wrong kind: the Chat-Friends contacts list kind must never register.
        let wrongKind = try commandsEvent([("start", "Begin setup")], kind: 30_000)
        #expect(decode(wrongKind) == nil)

        // Wrong d-tag: generic 30078 app data (e.g. taskify-app-backup) must never register.
        let wrongDTag = try commandsEvent([("start", "Begin setup")], dTag: "taskify-app-backup")
        #expect(decode(wrongDTag) == nil)

        // Wrong author: a list signed by someone else for this peer.
        let otherIdentity = try NostrIdentity(privateKey: Data(hex: String(repeating: "02", count: 32)))
        let foreignAuthor = try commandsEvent([("start", "Begin setup")], author: otherIdentity)
        #expect(decode(foreignAuthor) == nil)

        // Tampered: a valid event whose signature no longer matches its content.
        let valid = try commandsEvent([("start", "Begin setup")])
        let tampered = NostrEvent(
            id: valid.id,
            publicKey: valid.publicKey,
            createdAt: valid.createdAt,
            kind: valid.kind,
            tags: valid.tags + [["command", "extra", "injected"]],
            content: valid.content,
            signature: valid.signature
        )
        #expect(decode(tampered) == nil)
    }

    @Test("decode rejects the right kind and d-tag with no valid commands")
    func decodeRejectsEmptyCommandList() throws {
        let event = try commandsEvent([])
        #expect(decode(event) == nil)

        let onlyInvalid = try commandsEvent([("Bad Name!", "x"), ("/slash", "y")])
        #expect(decode(onlyInvalid) == nil)
    }

    // MARK: - Parser caps

    @Test("parser enforces name charset, description cap, dedupe, and count cap")
    func parserEnforcesCaps() throws {
        var many: [(String, String)] = []
        for index in 0..<150 {
            many.append(("cmd_\(index)", "Description \(index)"))
        }
        let event = try commandsEvent(many)
        let commands = try #require(decode(event))
        #expect(commands.count == BotCommandsContract.maxCommandCount)

        let mixed = try commandsEvent([
            ("good_one", "fine"),
            ("UPPER", "normalized to lowercase"),
            ("has space", "rejected"),
            ("toolongname\(String(repeating: "a", count: 40))", "rejected"),
            ("good_one", "duplicate dropped"),
            ("desc", String(repeating: "x", count: 250)),
            ("multiline", "line one\nline two"),
        ])
        let parsed = try #require(decode(mixed))
        #expect(parsed.map(\.name) == ["good_one", "upper", "desc", "multiline"])
        #expect(parsed[0].description == "fine")
        #expect(parsed[2].description.count == BotCommandsContract.maxDescriptionLength)
        #expect(parsed[3].description == "line one line two")
    }

    // MARK: - Builder round-trip

    @Test("builder round-trips through decode")
    func builderRoundTrips() throws {
        let commands = [
            BotCommand(name: "Start", description: "Begin setup"),
            BotCommand(name: "start", description: "duplicate dropped"),
            BotCommand(name: "help", description: "Show what I can do"),
        ]
        let event = try BotCommandsContract.event(
            commands: commands,
            identity: identity,
            createdAt: 1_700_000_000
        )
        #expect(event.kind == BotCommandsContract.eventKind)
        #expect(event.content == "")
        #expect(event.firstTagValue(named: "d") == BotCommandsContract.eventDTag)

        let decoded = try #require(decode(event))
        #expect(decoded.map(\.name) == ["start", "help"])
        #expect(decoded.map(\.description) == ["Begin setup", "Show what I can do"])
    }

    @Test("builder throws when no valid commands remain")
    func builderThrowsOnEmpty() throws {
        #expect(throws: (any Error).self) {
            _ = try BotCommandsContract.event(
                commands: [BotCommand(name: "bad name", description: "x")],
                identity: identity,
                createdAt: 1
            )
        }
    }

    // MARK: - Cache

    @Test("opening a chat revalidates persisted commands without clearing the offline list")
    func visibleChatRefreshesPersistedCommands() throws {
        let suiteName = "BotCommandsTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let original = [BotCommand(name: "start", description: "Begin setup")]
        BotCommandsCache(defaults: defaults).save(original, for: identity.publicKeyHex)

        let reopenedCache = BotCommandsCache(defaults: defaults)
        #expect(!reopenedCache.shouldRefresh(publicKey: identity.publicKeyHex))
        #expect(reopenedCache.shouldRefresh(publicKey: identity.publicKeyHex, force: true))
        #expect(reopenedCache.commands(for: identity.publicKeyHex) == original)

        let updated = [BotCommand(name: "help", description: "Show commands")]
        reopenedCache.save(updated, for: identity.publicKeyHex)
        #expect(BotCommandsCache(defaults: defaults).commands(for: identity.publicKeyHex) == updated)
    }

    @Test("cache persists commands per peer and keys are case-insensitive")
    func cachePersistsCommands() throws {
        let suiteName = "BotCommandsTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let cache = BotCommandsCache(defaults: defaults)

        #expect(cache.shouldRefresh(publicKey: identity.publicKeyHex))
        #expect(cache.commands(for: identity.publicKeyHex) == nil)

        let commands = [BotCommand(name: "start", description: "Begin setup")]
        cache.save(commands, for: identity.publicKeyHex)
        #expect(cache.commands(for: identity.publicKeyHex) == commands)
        // Upper-case lookup hits the same entry.
        #expect(cache.commands(for: identity.publicKeyHex.uppercased()) == commands)
        #expect(!cache.shouldRefresh(publicKey: identity.publicKeyHex))
        // A fresh cache over the same defaults re-reads the persisted entry.
        #expect(BotCommandsCache(defaults: defaults).commands(for: identity.publicKeyHex) == commands)
    }
}
