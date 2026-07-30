import Foundation

public enum TaskEventCodecError: LocalizedError {
    case wrongKind
    case wrongBoard
    case invalidAuthor
    case missingTaskID
    case invalidPayload

    public var errorDescription: String? {
        switch self {
        case .wrongKind: "The event is not a Taskify task event."
        case .wrongBoard: "The event belongs to a different board."
        case .invalidAuthor: "The event was not signed by the board key."
        case .missingTaskID: "The event has no task identifier."
        case .invalidPayload: "The encrypted task payload is invalid."
        }
    }
}

public struct TaskRelayRecord: Equatable, Sendable {
    public let task: TaskItem
    public let eventCreatedAt: Int

    public init(task: TaskItem, eventCreatedAt: Int) {
        self.task = task
        self.eventCreatedAt = eventCreatedAt
    }
}

public struct BoardRelayRecord: Equatable, Sendable {
    public let board: Board
    public let eventCreatedAt: Int

    public init(board: Board, eventCreatedAt: Int) {
        self.board = board
        self.eventCreatedAt = eventCreatedAt
    }
}

public struct TaskifyCalendarRelayRecord: Equatable, Sendable {
    public let event: TaskifyEvent
    public let eventCreatedAt: Int

    public init(event: TaskifyEvent, eventCreatedAt: Int) {
        self.event = event
        self.eventCreatedAt = eventCreatedAt
    }
}

public struct TaskifyCalendarEventPair: Equatable, Sendable {
    public let canonical: NostrEvent
    public let view: NostrEvent
    public let normalizedEvent: TaskifyEvent

    public init(canonical: NostrEvent, view: NostrEvent, normalizedEvent: TaskifyEvent) {
        self.canonical = canonical
        self.view = view
        self.normalizedEvent = normalizedEvent
    }
}

public struct TaskSyncPayload: Codable, Equatable, Sendable {
    public var title: String
    public var priority: Int?
    public var note: String?
    public var images: [String]?
    public var documents: [TaskDocument]?
    public var dueISO: String?
    public var completedAt: String?
    public var completedBy: String?
    public var hiddenUntilISO: String?
    public var createdBy: String?
    public var lastEditedBy: String?
    public var createdAt: Int64?
    public var seriesId: String?
    public var subtasks: [TaskSubtask]?
    public var recurrence: TaskRecurrence?
    public var reminders: [TaskReminder]?
    public var reminderTime: String?
    public var dueDateEnabled: Bool?
    public var dueTimeEnabled: Bool?
    public var dueTimeZone: String?
    public var preservedFields: [String: TaskPayloadValue]

    private static let nativeFieldNames: Set<String> = [
        "title",
        "priority",
        "note",
        "images",
        "documents",
        "dueISO",
        "completedAt",
        "completedBy",
        "hiddenUntilISO",
        "createdBy",
        "lastEditedBy",
        "createdAt",
        "seriesId",
        "subtasks",
        "recurrence",
        "reminders",
        "reminderTime",
        "dueDateEnabled",
        "dueTimeEnabled",
        "dueTimeZone",
    ]

    public init(task: TaskItem) {
        title = task.title
        priority = task.priority?.rawValue
        note = task.note.isEmpty ? nil : task.note
        images = task.images
        documents = task.documents
        dueISO = task.dueDate.map(Self.format)
        completedAt = task.completedAt.map(Self.format)
        completedBy = task.completed ? task.lastEditedBy : nil
        hiddenUntilISO = task.hiddenUntilDate.map(Self.format)
        createdBy = task.createdBy
        lastEditedBy = task.lastEditedBy
        createdAt = Int64(task.createdAt.timeIntervalSince1970 * 1_000)
        seriesId = task.seriesID
        subtasks = task.subtasks
        recurrence = task.recurrence
        reminders = task.reminders
        reminderTime = task.reminderTime
        dueDateEnabled = task.dueDateEnabled
        dueTimeEnabled = task.dueTimeEnabled
        dueTimeZone = task.dueTimeZone
        preservedFields = task.preservedSyncFields ?? [:]
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: TaskPayloadCodingKey.self)
        title = try container.decode(String.self, forKey: TaskPayloadCodingKey("title"))
        priority = try container.decodeIfPresent(Int.self, forKey: TaskPayloadCodingKey("priority"))
        note = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("note"))
        images = try container.decodeIfPresent([String].self, forKey: TaskPayloadCodingKey("images"))
        documents = try container.decodeIfPresent([TaskDocument].self, forKey: TaskPayloadCodingKey("documents"))
        dueISO = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("dueISO"))
        completedAt = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("completedAt"))
        completedBy = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("completedBy"))
        hiddenUntilISO = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("hiddenUntilISO"))
        createdBy = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("createdBy"))
        lastEditedBy = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("lastEditedBy"))
        createdAt = try container.decodeIfPresent(Int64.self, forKey: TaskPayloadCodingKey("createdAt"))
        seriesId = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("seriesId"))
        subtasks = try container.decodeIfPresent([TaskSubtask].self, forKey: TaskPayloadCodingKey("subtasks"))
        recurrence = try container.decodeIfPresent(TaskRecurrence.self, forKey: TaskPayloadCodingKey("recurrence"))
        reminders = try container.decodeIfPresent([TaskReminder].self, forKey: TaskPayloadCodingKey("reminders"))
        reminderTime = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("reminderTime"))
        dueDateEnabled = try container.decodeIfPresent(Bool.self, forKey: TaskPayloadCodingKey("dueDateEnabled"))
        dueTimeEnabled = try container.decodeIfPresent(Bool.self, forKey: TaskPayloadCodingKey("dueTimeEnabled"))
        dueTimeZone = try container.decodeIfPresent(String.self, forKey: TaskPayloadCodingKey("dueTimeZone"))

        preservedFields = [:]
        for key in container.allKeys where !Self.nativeFieldNames.contains(key.stringValue) {
            preservedFields[key.stringValue] = try container.decode(TaskPayloadValue.self, forKey: key)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: TaskPayloadCodingKey.self)
        for (name, value) in preservedFields where !Self.nativeFieldNames.contains(name) {
            try container.encode(value, forKey: TaskPayloadCodingKey(name))
        }

        try container.encode(title, forKey: TaskPayloadCodingKey("title"))
        try container.encodeIfPresent(priority, forKey: TaskPayloadCodingKey("priority"))
        try container.encodeIfPresent(note, forKey: TaskPayloadCodingKey("note"))
        try container.encodeIfPresent(images, forKey: TaskPayloadCodingKey("images"))
        try container.encodeIfPresent(documents, forKey: TaskPayloadCodingKey("documents"))
        try container.encodeIfPresent(dueISO, forKey: TaskPayloadCodingKey("dueISO"))
        try container.encodeIfPresent(completedAt, forKey: TaskPayloadCodingKey("completedAt"))
        try container.encodeIfPresent(completedBy, forKey: TaskPayloadCodingKey("completedBy"))
        try container.encodeIfPresent(hiddenUntilISO, forKey: TaskPayloadCodingKey("hiddenUntilISO"))
        try container.encodeIfPresent(createdBy, forKey: TaskPayloadCodingKey("createdBy"))
        try container.encodeIfPresent(lastEditedBy, forKey: TaskPayloadCodingKey("lastEditedBy"))
        try container.encodeIfPresent(createdAt, forKey: TaskPayloadCodingKey("createdAt"))
        try container.encodeIfPresent(seriesId, forKey: TaskPayloadCodingKey("seriesId"))
        try container.encodeIfPresent(subtasks, forKey: TaskPayloadCodingKey("subtasks"))
        try container.encodeIfPresent(recurrence, forKey: TaskPayloadCodingKey("recurrence"))
        try container.encodeIfPresent(reminders, forKey: TaskPayloadCodingKey("reminders"))
        try container.encodeIfPresent(reminderTime, forKey: TaskPayloadCodingKey("reminderTime"))
        try container.encodeIfPresent(dueDateEnabled, forKey: TaskPayloadCodingKey("dueDateEnabled"))
        try container.encodeIfPresent(dueTimeEnabled, forKey: TaskPayloadCodingKey("dueTimeEnabled"))
        try container.encodeIfPresent(dueTimeZone, forKey: TaskPayloadCodingKey("dueTimeZone"))
    }

    static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }
}

private struct TaskPayloadCodingKey: CodingKey {
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

public struct BoardSyncPayload: Codable, Equatable, Sendable {
    public var name: String?
    public var kind: BoardKind?
    public var columns: [BoardColumn]?
    public var children: [String]?
    public var clearCompletedDisabled: Bool?
    public var listIndex: Bool?
    public var hideBoardNames: Bool?
}

public enum TaskEventCodec {
    public static let boardEventKind = 30_300
    public static let taskEventKind = 30_301

    public static func taskEvent(
        task: TaskItem,
        board: Board,
        createdAt: Int
    ) throws -> NostrEvent {
        let boardID = board.effectiveNostrBoardID
        let payload = TaskSyncPayload(task: task)
        let plaintext = try JSONEncoder().encode(payload)
        let encryptedContent = try BoardCrypto.encrypt(plaintext, boardID: boardID)
        let status = task.isDeleted ? "deleted" : (task.completed ? "done" : "open")
        let columnTag = board.kind == .week ? "day" : (task.columnID ?? "")
        return try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: boardID),
            createdAt: createdAt,
            kind: taskEventKind,
            tags: [
                ["d", task.id],
                ["b", BoardCrypto.boardTag(for: boardID)],
                ["col", columnTag],
                ["status", status],
            ],
            content: encryptedContent
        )
    }

    public static func boardEvent(board: Board, createdAt: Int) throws -> NostrEvent {
        let boardID = board.effectiveNostrBoardID
        let boardTag = BoardCrypto.boardTag(for: boardID)
        let payload = BoardSyncPayload(
            name: nil,
            kind: nil,
            columns: board.kind == .list ? board.columns : nil,
            children: board.kind == .compound ? board.children : nil,
            clearCompletedDisabled: board.clearCompletedDisabled,
            listIndex: board.kind == .list || board.kind == .compound
                ? board.indexCardEnabled
                : nil,
            hideBoardNames: board.kind == .compound
                ? board.hideChildBoardNames
                : nil
        )
        let encryptedContent = try BoardCrypto.encrypt(
            JSONEncoder().encode(payload),
            boardID: boardID
        )
        return try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: boardID),
            createdAt: createdAt,
            kind: boardEventKind,
            tags: [
                ["d", boardTag],
                ["b", boardTag],
                ["k", board.kind.rawValue],
                ["name", board.name],
            ],
            content: encryptedContent
        )
    }

    public static func deletionEvent(
        taskID: String,
        board: Board,
        createdAt: Int
    ) throws -> NostrEvent {
        let boardID = board.effectiveNostrBoardID
        let boardPublicKey = try BoardCrypto.signingPublicKey(for: boardID).hexString
        return try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: boardID),
            createdAt: createdAt,
            kind: 5,
            tags: [
                ["a", "\(taskEventKind):\(boardPublicKey):\(taskID)"],
                ["k", String(taskEventKind)],
            ],
            content: "Task deleted"
        )
    }

    public static func decodeBoardEvent(
        _ event: NostrEvent,
        board: Board
    ) throws -> BoardRelayRecord {
        guard event.kind == boardEventKind else { throw TaskEventCodecError.wrongKind }
        let boardID = board.effectiveNostrBoardID
        let boardTag = BoardCrypto.boardTag(for: boardID)
        guard event.firstTagValue(named: "b") == boardTag else { throw TaskEventCodecError.wrongBoard }
        let expectedPublicKey = try BoardCrypto.signingPublicKey(for: boardID).hexString
        guard event.publicKey.lowercased() == expectedPublicKey, event.verify() else {
            throw TaskEventCodecError.invalidAuthor
        }

        let plaintext = try BoardCrypto.decrypt(event.content, boardID: boardID)
        guard let payload = try? JSONDecoder().decode(BoardSyncPayload.self, from: plaintext) else {
            throw TaskEventCodecError.invalidPayload
        }

        let taggedName = event.firstTagValue(named: "name")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let payloadName = payload.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = payloadName?.isEmpty == false
            ? payloadName!
            : (taggedName?.isEmpty == false ? taggedName! : board.name)
        let taggedKind = event.firstTagValue(named: "k").flatMap(BoardKind.init(rawValue:))
        let resolvedKind = payload.kind ?? taggedKind ?? board.kind
        let incomingColumns = payload.columns ?? board.columns
        let normalizedColumns = incomingColumns.enumerated().map { index, column in
            BoardColumn(
                id: column.id,
                name: column.name,
                order: column.order >= 0 ? column.order : index
            )
        }
        let incomingChildren = payload.children ?? board.children
        var seenChildren = Set<String>()
        let normalizedChildren = incomingChildren.compactMap { rawChild -> String? in
            let child = rawChild.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !child.isEmpty,
                  !board.matchesReference(child),
                  seenChildren.insert(child).inserted else { return nil }
            return child
        }

        var updated = board
        updated.name = resolvedName
        updated.kind = resolvedKind
        switch resolvedKind {
        case .list:
            updated.columns = normalizedColumns
        case .week:
            updated.columns = board.kind == .week ? board.columns : Board.week().columns
        case .compound, .bible:
            updated.columns = []
        }
        updated.children = resolvedKind == .compound ? normalizedChildren : []
        updated.clearCompletedDisabled = payload.clearCompletedDisabled ?? board.clearCompletedDisabled
        if resolvedKind == .list || resolvedKind == .compound {
            updated.indexCardEnabled = payload.listIndex ?? board.indexCardEnabled
        }
        updated.hideChildBoardNames = resolvedKind == .compound
            ? (payload.hideBoardNames ?? board.hideChildBoardNames)
            : false
        updated.nostrUpdatedAt = event.createdAt
        return BoardRelayRecord(board: updated, eventCreatedAt: event.createdAt)
    }

    public static func decodeTaskEvent(
        _ event: NostrEvent,
        board: Board,
        calendar: Calendar = .current
    ) throws -> TaskRelayRecord {
        guard event.kind == taskEventKind else { throw TaskEventCodecError.wrongKind }
        let boardID = board.effectiveNostrBoardID
        let boardTag = BoardCrypto.boardTag(for: boardID)
        guard event.firstTagValue(named: "b") == boardTag else { throw TaskEventCodecError.wrongBoard }
        let expectedPublicKey = try BoardCrypto.signingPublicKey(for: boardID).hexString
        guard event.publicKey.lowercased() == expectedPublicKey, event.verify() else {
            throw TaskEventCodecError.invalidAuthor
        }
        guard let taskID = event.firstTagValue(named: "d"), !taskID.isEmpty else {
            throw TaskEventCodecError.missingTaskID
        }

        let plaintext = try BoardCrypto.decrypt(event.content, boardID: boardID)
        guard let payload = try? JSONDecoder().decode(TaskSyncPayload.self, from: plaintext),
              !payload.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TaskEventCodecError.invalidPayload
        }
        let dueDate = TaskSyncPayload.parse(payload.dueISO)
        let completedAt = TaskSyncPayload.parse(payload.completedAt)
        let hiddenUntilDate = TaskSyncPayload.parse(payload.hiddenUntilISO)
        let status = event.firstTagValue(named: "status") ?? "open"
        let createdAt = payload.createdAt.map {
            Date(timeIntervalSince1970: TimeInterval($0) / 1_000)
        } ?? Date(timeIntervalSince1970: TimeInterval(event.createdAt))
        let columnID: String?
        let taggedColumnID = event.firstTagValue(named: "col")
        if let taggedColumnID, !taggedColumnID.isEmpty, taggedColumnID != "day" {
            columnID = taggedColumnID
        } else if board.kind == .week, let dueDate {
            columnID = WeekdayColumn.containing(dueDate, calendar: calendar).rawValue
        } else {
            columnID = taggedColumnID
        }

        let task = TaskItem(
            id: taskID,
            boardID: board.id,
            title: payload.title,
            note: payload.note ?? "",
            dueDate: dueDate,
            dueDateEnabled: payload.dueDateEnabled ?? (dueDate != nil),
            dueTimeEnabled: payload.dueTimeEnabled ?? false,
            dueTimeZone: payload.dueTimeZone,
            priority: payload.priority.flatMap(TaskPriority.init(rawValue:)),
            images: payload.images,
            documents: payload.documents,
            subtasks: payload.subtasks,
            recurrence: payload.recurrence?.isActive == true ? payload.recurrence : nil,
            seriesID: payload.seriesId,
            reminders: payload.reminders?.filter { $0.minutesBefore != nil && !$0.rawValue.isEmpty },
            reminderTime: payload.reminderTime,
            hiddenUntilDate: hiddenUntilDate,
            createdAt: createdAt,
            order: 0,
            columnID: columnID,
            completed: status == "done",
            completedAt: status == "done" ? completedAt : nil,
            createdBy: payload.createdBy,
            lastEditedBy: payload.lastEditedBy,
            nostrUpdatedAt: event.createdAt,
            deleted: status == "deleted",
            preservedSyncFields: payload.preservedFields.isEmpty ? nil : payload.preservedFields
        )
        return TaskRelayRecord(task: task, eventCreatedAt: event.createdAt)
    }
}

public enum TaskifyCalendarEventCodec {
    public static let canonicalEventKind = 30_310
    public static let viewEventKind = 30_311

    public static func generateEventKey() -> String {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
            .base64EncodedString()
    }

    public static func eventPair(
        event: TaskifyEvent,
        board: Board,
        createdAt: Int
    ) throws -> TaskifyCalendarEventPair {
        guard event.boardID == board.id, !event.isReadOnly else {
            throw TaskEventCodecError.wrongBoard
        }
        let boardID = board.effectiveNostrBoardID
        let boardPrivateKey = BoardCrypto.signingPrivateKey(for: boardID)
        let boardPublicKey = try BoardCrypto.signingPublicKey(for: boardID)
        let eventKey: String
        if let key = Data(base64Encoded: event.eventKey), key.count == 32 {
            eventKey = event.eventKey
        } else {
            eventKey = generateEventKey()
        }
        guard let rawEventKey = Data(base64Encoded: eventKey), rawEventKey.count == 32 else {
            throw TaskEventCodecError.invalidPayload
        }

        var normalized = event
        normalized.eventKey = eventKey
        normalized.canonicalAddress = "\(canonicalEventKind):\(boardPublicKey.hexString):\(event.id)"
        normalized.viewAddress = "\(viewEventKind):\(boardPublicKey.hexString):\(event.id)"
        normalized.relayURLs = board.effectiveRelayURLs
        normalized.readOnly = false
        normalized.nostrUpdatedAt = createdAt

        let canonicalPayload = CalendarPayload(event: normalized, includeSecrets: true)
        let viewPayload = CalendarPayload(event: normalized, includeSecrets: false)
        let canonicalContent = try NIP44V2.encrypt(
            JSONEncoder().encode(canonicalPayload),
            privateKey: boardPrivateKey,
            publicKey: boardPublicKey
        )
        let viewContent = try NIP44V2.encrypt(
            JSONEncoder().encode(viewPayload),
            conversationKey: rawEventKey
        )
        let boardTag = BoardCrypto.boardTag(for: boardID)
        var canonicalTags = [["d", normalized.id], ["b", boardTag]]
        let columnTag = board.kind == .week ? "day" : (normalized.columnID ?? "")
        if !columnTag.isEmpty { canonicalTags.append(["col", columnTag]) }
        if let order = normalized.order { canonicalTags.append(["order", String(order)]) }

        let canonical = try NostrEvent.signed(
            privateKey: boardPrivateKey,
            createdAt: createdAt,
            kind: canonicalEventKind,
            tags: canonicalTags,
            content: canonicalContent
        )
        let view = try NostrEvent.signed(
            privateKey: boardPrivateKey,
            createdAt: createdAt,
            kind: viewEventKind,
            tags: [["d", normalized.id], ["a", normalized.canonicalAddress]],
            content: viewContent
        )
        return TaskifyCalendarEventPair(
            canonical: canonical,
            view: view,
            normalizedEvent: normalized
        )
    }

    public static func decodeCanonicalEvent(
        _ event: NostrEvent,
        board: Board
    ) throws -> TaskifyCalendarRelayRecord {
        guard event.kind == canonicalEventKind else { throw TaskEventCodecError.wrongKind }
        let boardID = board.effectiveNostrBoardID
        guard event.firstTagValue(named: "b") == BoardCrypto.boardTag(for: boardID),
              let eventID = event.firstTagValue(named: "d"), !eventID.isEmpty else {
            throw TaskEventCodecError.wrongBoard
        }
        let boardPrivateKey = BoardCrypto.signingPrivateKey(for: boardID)
        let boardPublicKey = try BoardCrypto.signingPublicKey(for: boardID)
        guard event.publicKey.lowercased() == boardPublicKey.hexString, event.verify() else {
            throw TaskEventCodecError.invalidAuthor
        }
        let plaintext = try NIP44V2.decrypt(
            event.content,
            privateKey: boardPrivateKey,
            publicKey: boardPublicKey
        )
        guard let payload = try? JSONDecoder().decode(CalendarPayload.self, from: plaintext),
              payload.version == 1,
              payload.eventID == eventID,
              let eventKey = payload.eventKey,
              Data(base64Encoded: eventKey)?.count == 32 else {
            throw TaskEventCodecError.invalidPayload
        }

        let deleted = payload.deleted == true
        let schedule = payload.kind ?? .date
        if !deleted {
            guard payload.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
                throw TaskEventCodecError.invalidPayload
            }
            switch schedule {
            case .date:
                guard let start = payload.startDate, TaskifyEvent.dateOnly(start) != nil else {
                    throw TaskEventCodecError.invalidPayload
                }
            case .time:
                guard let start = payload.startISO, TaskifyEvent.isoDate(start) != nil else {
                    throw TaskEventCodecError.invalidPayload
                }
            }
        }

        let taggedColumn = event.firstTagValue(named: "col")
        let order = event.firstTagValue(named: "order").flatMap(Int.init)
        let taskifyEvent = TaskifyEvent(
            id: eventID,
            boardID: board.id,
            columnID: taggedColumn == "day" ? nil : taggedColumn,
            order: order,
            title: payload.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                ?? "Deleted event",
            summary: payload.summary,
            details: payload.details,
            imageURL: payload.image,
            documents: payload.documents,
            locations: payload.locations,
            geohash: payload.geohash,
            hashtags: payload.hashtags,
            references: payload.references,
            participants: payload.participants,
            schedule: schedule,
            startDateValue: payload.startDate,
            endDateValue: payload.endDate,
            startISO: payload.startISO,
            endISO: payload.endISO,
            startTimeZoneID: payload.startTimeZoneID,
            endTimeZoneID: payload.endTimeZoneID,
            reminders: payload.reminders?.filter { $0.minutesBefore != nil && !$0.rawValue.isEmpty },
            reminderTime: payload.reminderTime?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            recurrence: payload.recurrence?.isActive == true ? payload.recurrence : nil,
            seriesID: payload.seriesID?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            createdBy: payload.createdBy,
            lastEditedBy: payload.lastEditedBy,
            canonicalAddress: "\(canonicalEventKind):\(boardPublicKey.hexString):\(eventID)",
            viewAddress: "\(viewEventKind):\(boardPublicKey.hexString):\(eventID)",
            eventKey: eventKey,
            inviteToken: "",
            inviteTokens: payload.inviteTokens,
            relayURLs: board.effectiveRelayURLs,
            rsvpStatus: .accepted,
            sourceUpdatedAt: event.createdAt,
            readOnly: false,
            deleted: deleted,
            nostrUpdatedAt: event.createdAt
        )
        return TaskifyCalendarRelayRecord(event: taskifyEvent, eventCreatedAt: event.createdAt)
    }

    private struct CalendarPayload: Codable, Equatable {
        var version: Int
        var eventID: String
        var eventKey: String?
        var createdBy: String?
        var lastEditedBy: String?
        var kind: TaskifyEventSchedule?
        var title: String?
        var summary: String?
        var details: String?
        var image: String?
        var documents: [TaskDocument]?
        var locations: [String]?
        var geohash: String?
        var hashtags: [String]?
        var references: [String]?
        var participants: [TaskifyEventParticipant]?
        var startDate: String?
        var endDate: String?
        var startISO: String?
        var endISO: String?
        var startTimeZoneID: String?
        var endTimeZoneID: String?
        var reminders: [TaskReminder]?
        var reminderTime: String?
        var recurrence: TaskRecurrence?
        var seriesID: String?
        var inviteTokens: [String: String]?
        var deleted: Bool?

        enum CodingKeys: String, CodingKey {
            case version = "v"
            case eventID = "eventId"
            case eventKey, createdBy, lastEditedBy, kind, title, summary
            case details = "description"
            case image, documents, locations, geohash, hashtags, references, participants
            case startDate, endDate, startISO, endISO
            case startTimeZoneID = "startTzid"
            case endTimeZoneID = "endTzid"
            case reminders, reminderTime, recurrence
            case seriesID = "seriesId"
            case inviteTokens, deleted
        }

        init(event: TaskifyEvent, includeSecrets: Bool) {
            version = 1
            eventID = event.id
            eventKey = includeSecrets ? event.eventKey : nil
            createdBy = event.createdBy
            lastEditedBy = event.lastEditedBy
            inviteTokens = includeSecrets ? event.inviteTokens : nil
            deleted = event.isDeleted ? true : nil
            recurrence = event.recurrence?.isActive == true ? event.recurrence : nil
            seriesID = recurrence == nil ? nil : (event.seriesID ?? event.id)
            guard !event.isDeleted else { return }
            kind = event.schedule
            title = event.title
            summary = event.summary
            details = event.details
            image = event.imageURL
            documents = event.documents
            locations = event.locations
            geohash = event.geohash
            hashtags = event.hashtags
            references = event.references
            participants = includeSecrets ? event.participants : nil
            startDate = event.startDateValue
            endDate = event.endDateValue
            startISO = event.startISO
            endISO = event.endISO
            startTimeZoneID = event.startTimeZoneID
            endTimeZoneID = event.endTimeZoneID
            reminders = event.reminders
            reminderTime = event.reminderTime
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
