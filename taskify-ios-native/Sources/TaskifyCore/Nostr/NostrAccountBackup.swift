import Foundation

public struct NostrAppBackupColumn: Codable, Equatable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct NostrAppBackupBoard: Codable, Equatable, Sendable {
    public var id: String
    public var nostrID: String?
    public var relayURLs: [String]?
    public var name: String?
    public var kind: BoardKind?
    public var archived: Bool?
    public var hidden: Bool?
    public var order: Double?
    public var columns: [NostrAppBackupColumn]?
    public var children: [String]?
    public var clearCompletedDisabled: Bool?
    public var indexCardEnabled: Bool?
    public var hideChildBoardNames: Bool?
    public var preservedFields: [String: TaskPayloadValue]

    public var isSupportedByNative: Bool {
        kind != .bible && !(kind == nil && preservedFields["kind"] != nil)
    }

    public init(
        id: String,
        nostrID: String?,
        relayURLs: [String]? = nil,
        name: String? = nil,
        kind: BoardKind? = nil,
        archived: Bool? = nil,
        hidden: Bool? = nil,
        order: Double? = nil,
        columns: [NostrAppBackupColumn]? = nil,
        children: [String]? = nil,
        clearCompletedDisabled: Bool? = nil,
        indexCardEnabled: Bool? = nil,
        hideChildBoardNames: Bool? = nil,
        preservedFields: [String: TaskPayloadValue] = [:]
    ) {
        self.id = id
        self.nostrID = nostrID
        self.relayURLs = relayURLs
        self.name = name
        self.kind = kind
        self.archived = archived
        self.hidden = hidden
        self.order = order
        self.columns = columns
        self.children = children
        self.clearCompletedDisabled = clearCompletedDisabled
        self.indexCardEnabled = indexCardEnabled
        self.hideChildBoardNames = hideChildBoardNames
        self.preservedFields = preservedFields
    }

    private enum CodingKeys: String, CodingKey {
        case id, nostrID = "nostrId", relayURLs = "relays", name, kind
        case archived, hidden, order, columns, children, clearCompletedDisabled
        case indexCardEnabled, hideChildBoardNames, nostr
    }

    private struct LegacyNostrReference: Codable {
        var boardID: String?
        var relays: [String]?

        private enum CodingKeys: String, CodingKey {
            case boardID = "boardId"
            case relays
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        let legacy = try container.decodeIfPresent(LegacyNostrReference.self, forKey: .nostr)
        nostrID = try container.decodeIfPresent(String.self, forKey: .nostrID) ?? legacy?.boardID
        relayURLs = try container.decodeIfPresent([String].self, forKey: .relayURLs) ?? legacy?.relays
        name = try container.decodeIfPresent(String.self, forKey: .name)
        let rawKind = try? container.decode(String.self, forKey: .kind)
        kind = rawKind.flatMap(BoardKind.init(rawValue:))
        archived = try container.decodeIfPresent(Bool.self, forKey: .archived)
        hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden)
        order = try container.decodeIfPresent(Double.self, forKey: .order)
        columns = try container.decodeIfPresent([NostrAppBackupColumn].self, forKey: .columns)
        children = try container.decodeIfPresent([String].self, forKey: .children)
        clearCompletedDisabled = try container.decodeIfPresent(Bool.self, forKey: .clearCompletedDisabled)
        indexCardEnabled = try container.decodeIfPresent(Bool.self, forKey: .indexCardEnabled)
        hideChildBoardNames = try container.decodeIfPresent(Bool.self, forKey: .hideChildBoardNames)

        let arbitrary = try decoder.container(keyedBy: BackupPayloadCodingKey.self)
        var fields: [String: TaskPayloadValue] = [:]
        for key in arbitrary.allKeys {
            if let value = try? arbitrary.decode(TaskPayloadValue.self, forKey: key) {
                fields[key.stringValue] = value
            }
        }
        let recognized = [
            "id", "nostrId", "relays", "name", "archived", "hidden", "order",
            "columns", "children", "clearCompletedDisabled", "indexCardEnabled",
            "hideChildBoardNames", "nostr",
        ]
        recognized.forEach { fields.removeValue(forKey: $0) }
        if kind != nil { fields.removeValue(forKey: "kind") }
        preservedFields = fields
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(nostrID, forKey: .nostrID)
        try container.encodeIfPresent(relayURLs, forKey: .relayURLs)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(kind, forKey: .kind)
        try container.encodeIfPresent(archived, forKey: .archived)
        try container.encodeIfPresent(hidden, forKey: .hidden)
        try container.encodeIfPresent(order, forKey: .order)
        try container.encodeIfPresent(columns, forKey: .columns)
        try container.encodeIfPresent(children, forKey: .children)
        try container.encodeIfPresent(clearCompletedDisabled, forKey: .clearCompletedDisabled)
        try container.encodeIfPresent(indexCardEnabled, forKey: .indexCardEnabled)
        try container.encodeIfPresent(hideChildBoardNames, forKey: .hideChildBoardNames)
        var arbitrary = encoder.container(keyedBy: BackupPayloadCodingKey.self)
        for (name, value) in preservedFields {
            try arbitrary.encode(value, forKey: BackupPayloadCodingKey(name))
        }
    }
}

public struct NostrAppBackupPayload: Codable, Equatable, Sendable, Identifiable {
    public var version: Int
    public var timestamp: Int
    public var boards: [NostrAppBackupBoard]
    public var settings: [String: TaskPayloadValue]
    public var walletSeed: TaskPayloadValue?
    public var defaultRelayURLs: [String]
    public var preservedFields: [String: TaskPayloadValue]

    public var id: String { "\(timestamp)-\(boards.count)" }

    public var nativeManagedNostrBoardIDs: Set<String> {
        Set(boards.compactMap { board in
            guard board.isSupportedByNative,
                  let nostrID = board.nostrID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !nostrID.isEmpty else { return nil }
            return nostrID
        })
    }

    public init(
        version: Int = 1,
        timestamp: Int,
        boards: [NostrAppBackupBoard],
        settings: [String: TaskPayloadValue] = [:],
        walletSeed: TaskPayloadValue? = nil,
        defaultRelayURLs: [String] = [],
        preservedFields: [String: TaskPayloadValue] = [:]
    ) {
        self.version = version
        self.timestamp = timestamp
        self.boards = boards
        self.settings = settings
        self.walletSeed = walletSeed
        self.defaultRelayURLs = TaskifyRelayURL.normalizedList(defaultRelayURLs)
        self.preservedFields = preservedFields
    }

    private enum CodingKeys: String, CodingKey {
        case version, timestamp, boards, settings, walletSeed
        case defaultRelayURLs = "defaultRelays"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 1
        timestamp = try container.decodeIfPresent(Int.self, forKey: .timestamp) ?? 0
        boards = try container.decodeIfPresent([NostrAppBackupBoard].self, forKey: .boards) ?? []
        settings = try container.decodeIfPresent([String: TaskPayloadValue].self, forKey: .settings) ?? [:]
        walletSeed = try container.decodeIfPresent(TaskPayloadValue.self, forKey: .walletSeed)
        defaultRelayURLs = TaskifyRelayURL.normalizedList(
            try container.decodeIfPresent([String].self, forKey: .defaultRelayURLs) ?? []
        )
        let arbitrary = try decoder.container(keyedBy: BackupPayloadCodingKey.self)
        var fields: [String: TaskPayloadValue] = [:]
        for key in arbitrary.allKeys {
            if let value = try? arbitrary.decode(TaskPayloadValue.self, forKey: key) {
                fields[key.stringValue] = value
            }
        }
        ["version", "timestamp", "boards", "settings", "walletSeed", "defaultRelays"]
            .forEach { fields.removeValue(forKey: $0) }
        preservedFields = fields
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(boards, forKey: .boards)
        try container.encode(settings, forKey: .settings)
        try container.encodeIfPresent(walletSeed, forKey: .walletSeed)
        if !defaultRelayURLs.isEmpty {
            try container.encode(defaultRelayURLs, forKey: .defaultRelayURLs)
        }
        var arbitrary = encoder.container(keyedBy: BackupPayloadCodingKey.self)
        for (name, value) in preservedFields {
            try arbitrary.encode(value, forKey: BackupPayloadCodingKey(name))
        }
    }

    public func updatingNativeBoards(
        _ nativeBoards: [Board],
        managedNostrBoardIDs: Set<String>,
        timestamp: Int
    ) -> NostrAppBackupPayload {
        let eligibleNativeBoards = nativeBoards.filter { $0.kind != .bible }
        let nativeByNostrID = eligibleNativeBoards.reduce(into: [String: Board]()) {
            $0[$1.effectiveNostrBoardID] = $1
        }
        let existingByNostrID = boards.reduce(into: [String: NostrAppBackupBoard]()) { result, board in
                guard let nostrID = board.nostrID?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !nostrID.isEmpty else { return }
                result[nostrID] = board
            }
        var backupIDByNativeReference: [String: String] = [:]
        for board in eligibleNativeBoards {
            let backupID = existingByNostrID[board.effectiveNostrBoardID]?.id ?? board.id
            backupIDByNativeReference[board.id] = backupID
            backupIDByNativeReference[board.effectiveNostrBoardID] = backupID
        }

        var nextBoards = boards.filter { entry in
            guard entry.isSupportedByNative,
                  let nostrID = entry.nostrID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !nostrID.isEmpty else {
                return true
            }
            if nativeByNostrID[nostrID] != nil { return false }
            return !managedNostrBoardIDs.contains(nostrID)
        }

        for (index, board) in eligibleNativeBoards.enumerated() {
            let isLinkedPlaceholder = board.hidden && board.archived && board.name == "Linked board"
            if isLinkedPlaceholder {
                if let existing = existingByNostrID[board.effectiveNostrBoardID] {
                    nextBoards.append(existing)
                }
                continue
            }

            let existing = existingByNostrID[board.effectiveNostrBoardID]
            let children = board.kind == .compound
                ? board.children.map { backupIDByNativeReference[$0] ?? $0 }
                : nil
            let columns = board.kind == .list
                ? board.columns.sorted { $0.order < $1.order }.map {
                    NostrAppBackupColumn(id: $0.id, name: $0.name)
                }
                : nil
            nextBoards.append(NostrAppBackupBoard(
                id: existing?.id ?? board.id,
                nostrID: board.effectiveNostrBoardID,
                relayURLs: board.effectiveRelayURLs,
                name: board.name,
                kind: board.kind,
                archived: board.archived,
                hidden: board.hidden,
                order: Double(index),
                columns: columns,
                children: children,
                clearCompletedDisabled: board.clearCompletedDisabled,
                indexCardEnabled: board.kind == .list || board.kind == .compound
                    ? board.indexCardEnabled
                    : nil,
                hideChildBoardNames: board.kind == .compound
                    ? board.hideChildBoardNames
                    : nil,
                preservedFields: existing?.preservedFields ?? [:]
            ))
        }

        var updated = self
        updated.timestamp = timestamp
        updated.boards = nextBoards.sorted {
            if ($0.order ?? 0) != ($1.order ?? 0) { return ($0.order ?? 0) < ($1.order ?? 0) }
            return $0.id < $1.id
        }
        return updated
    }
}

private struct BackupPayloadCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        return nil
    }
}

public struct NostrAppBackupReview: Equatable, Sendable {
    public let importableBoardCount: Int
    public let alreadyConnectedBoardCount: Int
    public let unsupportedBoardCount: Int
    public let relayCount: Int
    public let containsWalletSeed: Bool
    public let containsPWASettings: Bool

    public init(payload: NostrAppBackupPayload, currentBoards: [Board]) {
        let valid = payload.boards.filter {
            $0.isSupportedByNative && $0.nostrID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        }
        alreadyConnectedBoardCount = valid.filter { entry in
            currentBoards.contains { $0.effectiveNostrBoardID == entry.nostrID }
        }.count
        importableBoardCount = valid.count - alreadyConnectedBoardCount
        unsupportedBoardCount = payload.boards.count - valid.count
        relayCount = Set(
            payload.defaultRelayURLs + payload.boards.flatMap { $0.relayURLs ?? [] }
        ).count
        containsWalletSeed = payload.walletSeed != nil && payload.walletSeed != .null
        containsPWASettings = !payload.settings.isEmpty
    }
}

public struct NostrAppBackupImportResult: Equatable, Sendable {
    public let importedBoardCount: Int
    public let updatedBoardCount: Int
    public let skippedBoardCount: Int
}

public enum NostrAppBackupError: LocalizedError {
    case invalidEvent
    case invalidPayload
    case unsupportedVersion

    public var errorDescription: String? {
        switch self {
        case .invalidEvent: "The account backup event could not be verified."
        case .invalidPayload: "The account backup contents are invalid."
        case .unsupportedVersion: "This account backup was created by a newer Taskify version."
        }
    }
}

public enum NostrAppBackupContract {
    public static let eventKind = 30_078
    public static let eventDTag = "taskify-app-backup"

    public static func decode(
        event: NostrEvent,
        identity: NostrIdentity
    ) throws -> NostrAppBackupPayload {
        guard event.kind == eventKind,
              event.publicKey.lowercased() == identity.publicKeyHex,
              event.firstTagValue(named: "d") == eventDTag,
              event.verify() else {
            throw NostrAppBackupError.invalidEvent
        }
        let plaintext = try NIP44V2.decrypt(
            event.content,
            privateKey: identity.privateKey,
            publicKey: identity.publicKey
        )
        guard let payload = try? JSONDecoder().decode(NostrAppBackupPayload.self, from: plaintext) else {
            throw NostrAppBackupError.invalidPayload
        }
        guard payload.version == 1 else { throw NostrAppBackupError.unsupportedVersion }
        return payload
    }

    public static func event(
        payload: NostrAppBackupPayload,
        identity: NostrIdentity,
        createdAt: Int,
        nonce: Data? = nil
    ) throws -> NostrEvent {
        var stampedPayload = payload
        stampedPayload.timestamp = createdAt
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let content = try NIP44V2.encrypt(
            encoder.encode(stampedPayload),
            privateKey: identity.privateKey,
            publicKey: identity.publicKey,
            nonce: nonce
        )
        return try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: eventKind,
            tags: [
                ["d", eventDTag],
                ["client", "taskify.app"],
            ],
            content: content
        )
    }
}

public enum NostrAccountBackupFinder {
    /// Searches each relay independently and returns verified candidate events,
    /// newest first. A silent/offline relay is bounded by `timeout` and cannot
    /// prevent healthy relays from completing the lookup.
    public static func findCandidates(
        publicKey: String,
        relayURLs: [String],
        timeout: TimeInterval = 4
    ) async -> [NostrEvent] {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        guard !publicKey.isEmpty, !relays.isEmpty else { return [] }

        return await withTaskGroup(of: [NostrEvent].self) { group in
            for relayURL in relays {
                group.addTask {
                    await fetch(
                        publicKey: publicKey,
                        relayURL: relayURL,
                        timeout: timeout
                    )
                }
            }

            var candidatesByID: [String: NostrEvent] = [:]
            for await events in group {
                for event in events {
                    candidatesByID[event.id] = event
                }
            }
            return candidatesByID.values.sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
                return $0.id > $1.id
            }
        }
    }

    private static func fetch(
        publicKey: String,
        relayURL: String,
        timeout: TimeInterval
    ) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let stream = connection.messages()
        let subscriptionID = "account-backup-\(UUID().uuidString)"
        do {
            try await connection.connect()
            try await connection.subscribeToAccountBackup(
                id: subscriptionID,
                authorPublicKey: publicKey
            )
        } catch {
            await connection.disconnect()
            return []
        }

        let events = await withTaskGroup(of: [NostrEvent]?.self) { group in
            group.addTask {
                var matches: [NostrEvent] = []
                for await message in stream {
                    guard !Task.isCancelled else { return matches }
                    switch message {
                    case .event(let receivedSubscriptionID, let event)
                        where receivedSubscriptionID == subscriptionID:
                        guard event.kind == NostrAppBackupContract.eventKind,
                              event.publicKey.lowercased() == publicKey.lowercased(),
                              event.firstTagValue(named: "d") == NostrAppBackupContract.eventDTag,
                              event.verify() else { continue }
                        matches.append(event)
                    case .endOfStoredEvents(let receivedSubscriptionID)
                        where receivedSubscriptionID == subscriptionID:
                        return matches
                    case .closed(let receivedSubscriptionID, _)
                        where receivedSubscriptionID == subscriptionID:
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
                let nanoseconds = UInt64(max(0.25, timeout) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanoseconds)
                return nil
            }

            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? []
        }
        try? await connection.closeSubscription(id: subscriptionID)
        await connection.disconnect()
        return events
    }
}

public extension TaskifySnapshot {
    @discardableResult
    mutating func mergePWAAccountBackup(
        _ payload: NostrAppBackupPayload,
        now: Date = Date()
    ) -> NostrAppBackupImportResult {
        let fallbackRelays = payload.defaultRelayURLs.isEmpty
            ? TaskifyRelayDefaults.urls
            : payload.defaultRelayURLs
        let incoming = payload.boards
            .filter {
                $0.isSupportedByNative && $0.nostrID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            }
            .sorted {
                if ($0.order ?? 0) != ($1.order ?? 0) { return ($0.order ?? 0) < ($1.order ?? 0) }
                return $0.id < $1.id
            }

        var usedLocalIDs = Set(boards.map(\.id))
        var localIDByIncomingReference: [String: String] = [:]
        for entry in incoming {
            guard let nostrID = entry.nostrID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !nostrID.isEmpty else { continue }
            let localID: String
            if let existing = boards.first(where: { $0.effectiveNostrBoardID == nostrID }) {
                localID = existing.id
            } else {
                let requestedID = entry.id.trimmingCharacters(in: .whitespacesAndNewlines)
                if !requestedID.isEmpty, !usedLocalIDs.contains(requestedID) {
                    localID = requestedID
                } else {
                    localID = UUID().uuidString
                }
                usedLocalIDs.insert(localID)
            }
            if !entry.id.isEmpty { localIDByIncomingReference[entry.id] = localID }
            localIDByIncomingReference[nostrID] = localID
        }

        var imported = 0
        var updated = 0
        for entry in incoming {
            guard let nostrID = entry.nostrID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !nostrID.isEmpty,
                  let localID = localIDByIncomingReference[nostrID] else { continue }
            let relays = TaskifyRelayURL.normalizedList(entry.relayURLs ?? [])
            let effectiveRelays = relays.isEmpty ? fallbackRelays : relays
            if let index = boards.firstIndex(where: { $0.effectiveNostrBoardID == nostrID }) {
                boards[index].relayURLs = effectiveRelays
                if let archived = entry.archived { boards[index].archived = archived }
                if let hidden = entry.hidden { boards[index].hidden = hidden }
                if let disabled = entry.clearCompletedDisabled {
                    boards[index].clearCompletedDisabled = disabled
                }
                updated += 1
                continue
            }

            let kind = entry.kind ?? .list
            let cleanedName = entry.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            let name = cleanedName?.isEmpty == false ? cleanedName! : "Shared Board"
            let columns: [BoardColumn]
            switch kind {
            case .week:
                columns = WeekdayColumn.allCases.map {
                    BoardColumn(id: $0.rawValue, name: $0.shortName, order: $0.calendarWeekday)
                }
            case .list:
                let incomingColumns = (entry.columns ?? []).filter {
                    !$0.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }
                columns = incomingColumns.isEmpty
                    ? [BoardColumn(id: UUID().uuidString, name: "Items", order: 0)]
                    : incomingColumns.enumerated().map {
                        BoardColumn(id: $0.element.id, name: $0.element.name, order: $0.offset)
                    }
            case .compound, .bible:
                columns = []
            }
            let children = kind == .compound
                ? (entry.children ?? []).map { localIDByIncomingReference[$0] ?? $0 }
                : []
            boards.append(Board(
                id: localID,
                name: name,
                kind: kind,
                columns: columns,
                children: children,
                archived: entry.archived ?? false,
                hidden: entry.hidden ?? false,
                indexCardEnabled: entry.indexCardEnabled ?? false,
                hideChildBoardNames: entry.hideChildBoardNames ?? false,
                clearCompletedDisabled: entry.clearCompletedDisabled ?? false,
                createdAt: now,
                nostrBoardID: nostrID,
                relayURLs: effectiveRelays
            ))
            imported += 1
        }

        repairSelection()
        return NostrAppBackupImportResult(
            importedBoardCount: imported,
            updatedBoardCount: updated,
            skippedBoardCount: payload.boards.count - incoming.count
        )
    }
}
