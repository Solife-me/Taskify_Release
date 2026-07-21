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
    public var streak: Int?
    public var longestStreak: Int?
    public var seriesId: String?
    public var subtasks: [TaskSubtask]?
    public var recurrence: TaskRecurrence?
    public var reminders: [TaskReminder]?
    public var reminderTime: String?
    public var dueDateEnabled: Bool?
    public var dueTimeEnabled: Bool?
    public var dueTimeZone: String?

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
        streak = nil
        longestStreak = nil
        seriesId = task.seriesID
        subtasks = task.subtasks
        recurrence = task.recurrence
        reminders = task.reminders
        reminderTime = task.reminderTime
        dueDateEnabled = task.dueDateEnabled
        dueTimeEnabled = task.dueTimeEnabled
        dueTimeZone = task.dueTimeZone
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
            tags: [["a", "\(taskEventKind):\(boardPublicKey):\(taskID)"]],
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
            deleted: status == "deleted"
        )
        return TaskRelayRecord(task: task, eventCreatedAt: event.createdAt)
    }
}
