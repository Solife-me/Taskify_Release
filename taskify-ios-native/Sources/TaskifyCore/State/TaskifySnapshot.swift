import Foundation

public struct TaskifySnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 2

    public var schemaVersion: Int
    public var boards: [Board]
    public var tasks: [TaskItem]
    public var selectedBoardID: String

    public init(
        schemaVersion: Int = TaskifySnapshot.currentSchemaVersion,
        boards: [Board],
        tasks: [TaskItem],
        selectedBoardID: String
    ) {
        self.schemaVersion = schemaVersion
        self.boards = boards
        self.tasks = tasks
        self.selectedBoardID = selectedBoardID
        repairSelection()
    }

    public static var empty: TaskifySnapshot {
        let week = Board.week()
        return TaskifySnapshot(boards: [week], tasks: [], selectedBoardID: week.id)
    }

    public var visibleBoards: [Board] {
        boards.filter(\.isVisible)
    }

    public var selectedBoard: Board? {
        visibleBoards.first { $0.id == selectedBoardID } ?? visibleBoards.first
    }

    public mutating func selectBoard(_ boardID: String) {
        guard visibleBoards.contains(where: { $0.id == boardID }) else { return }
        selectedBoardID = boardID
    }

    @discardableResult
    public mutating func createWeekBoard(name: String, now: Date = Date()) -> Board? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return nil }

        let board = Board(
            id: UUID().uuidString,
            name: trimmedName,
            kind: .week,
            columns: WeekdayColumn.allCases.map {
                BoardColumn(id: $0.rawValue, name: $0.shortName, order: $0.calendarWeekday)
            },
            createdAt: now
        )
        boards.append(board)
        selectedBoardID = board.id
        return board
    }

    @discardableResult
    public mutating func joinWeekBoard(
        nostrBoardID: String,
        name: String = "Shared Week",
        relayURLs: [String] = TaskifyRelayDefaults.urls,
        now: Date = Date()
    ) -> Board? {
        let trimmedID = nostrBoardID.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return nil }

        if let existing = boards.first(where: { $0.effectiveNostrBoardID == trimmedID }) {
            selectedBoardID = existing.id
            return existing
        }

        let board = Board(
            name: trimmedName.isEmpty ? "Shared Week" : trimmedName,
            kind: .week,
            columns: WeekdayColumn.allCases.map {
                BoardColumn(id: $0.rawValue, name: $0.shortName, order: $0.calendarWeekday)
            },
            createdAt: now,
            nostrBoardID: trimmedID,
            relayURLs: relayURLs
        )
        boards.append(board)
        selectedBoardID = board.id
        return board
    }

    @discardableResult
    public mutating func addTask(
        title: String,
        boardID: String,
        columnID: String?,
        dueDate: Date?,
        note: String = "",
        priority: TaskPriority? = nil,
        authorPublicKey: String? = nil,
        now: Date = Date()
    ) -> TaskItem? {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { return nil }
        guard boards.contains(where: { $0.id == boardID && $0.isVisible }) else { return nil }

        let nextOrder = (tasks.filter { $0.boardID == boardID && $0.columnID == columnID }.map(\.order).max() ?? -1) + 1
        let task = TaskItem(
            boardID: boardID,
            title: trimmedTitle,
            note: note,
            dueDate: dueDate,
            dueDateEnabled: dueDate != nil,
            dueTimeEnabled: false,
            priority: priority,
            createdAt: now,
            order: nextOrder,
            columnID: columnID,
            createdBy: authorPublicKey,
            lastEditedBy: authorPublicKey
        )
        tasks.append(task)
        return task
    }

    @discardableResult
    public mutating func toggleCompletion(
        taskID: String,
        editorPublicKey: String? = nil,
        now: Date = Date()
    ) -> Bool {
        guard let index = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }) else { return false }
        tasks[index].completed.toggle()
        tasks[index].completedAt = tasks[index].completed ? now : nil
        tasks[index].lastEditedBy = editorPublicKey ?? tasks[index].lastEditedBy
        return true
    }

    @discardableResult
    public mutating func deleteTask(taskID: String, editorPublicKey: String? = nil) -> Bool {
        guard let index = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }) else { return false }
        tasks[index].deleted = true
        tasks[index].lastEditedBy = editorPublicKey ?? tasks[index].lastEditedBy
        return true
    }

    @discardableResult
    public mutating func mergeRemoteTask(_ remoteTask: TaskItem, eventCreatedAt: Int) -> Bool {
        if let index = tasks.firstIndex(where: { $0.id == remoteTask.id }) {
            let localClock = tasks[index].nostrUpdatedAt ?? 0
            guard eventCreatedAt > localClock else { return false }
            tasks[index] = remoteTask
            tasks[index].nostrUpdatedAt = eventCreatedAt
            return true
        }

        var inserted = remoteTask
        inserted.nostrUpdatedAt = eventCreatedAt
        tasks.append(inserted)
        return true
    }

    public func tasks(
        boardID: String,
        columnID: String,
        includeCompleted: Bool
    ) -> [TaskItem] {
        tasks
            .filter {
                $0.boardID == boardID &&
                $0.columnID == columnID &&
                !$0.isDeleted &&
                (includeCompleted || !$0.completed)
            }
            .sorted {
                if $0.completed != $1.completed { return !$0.completed }
                if $0.order != $1.order { return $0.order < $1.order }
                return $0.createdAt < $1.createdAt
            }
    }

    public func upcomingTasks(from startDate: Date, calendar: Calendar = .current) -> [TaskItem] {
        let startOfDay = calendar.startOfDay(for: startDate)
        return tasks
            .filter { task in
                guard !task.isDeleted, !task.completed, task.dueDateEnabled, let dueDate = task.dueDate else { return false }
                return dueDate >= startOfDay
            }
            .sorted {
                guard let lhs = $0.dueDate, let rhs = $1.dueDate else { return $0.createdAt < $1.createdAt }
                if lhs != rhs { return lhs < rhs }
                return $0.createdAt < $1.createdAt
            }
    }

    public mutating func repairSelection() {
        for index in boards.indices {
            if boards[index].nostrBoardID?.isEmpty != false {
                boards[index].nostrBoardID = UUID().uuidString
            }
            if boards[index].relayURLs?.isEmpty != false {
                boards[index].relayURLs = TaskifyRelayDefaults.urls
            }
        }
        schemaVersion = Self.currentSchemaVersion

        guard !visibleBoards.isEmpty else {
            let week = Board.week()
            boards.append(week)
            selectedBoardID = week.id
            return
        }
        guard visibleBoards.contains(where: { $0.id == selectedBoardID }) else {
            selectedBoardID = visibleBoards[0].id
            return
        }
    }
}
