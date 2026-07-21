import Foundation

public enum ListColumnRemovalStrategy: Equatable, Sendable {
    case moveTasks(toColumnID: String)
    case deleteTasks
}

public struct TaskMoveResult: Equatable, Sendable {
    public let taskID: String
    public let sourceBoardID: String
    public let sourceColumnID: String?
    public let targetBoardID: String
    public let targetColumnID: String

    public init(
        taskID: String,
        sourceBoardID: String,
        sourceColumnID: String?,
        targetBoardID: String,
        targetColumnID: String
    ) {
        self.taskID = taskID
        self.sourceBoardID = sourceBoardID
        self.sourceColumnID = sourceColumnID
        self.targetBoardID = targetBoardID
        self.targetColumnID = targetColumnID
    }

    public var crossedBoards: Bool { sourceBoardID != targetBoardID }
}

public struct ListColumnRemovalResult: Equatable, Sendable {
    public var removedColumnID: String
    public var movedTaskIDs: [String]
    public var deletedTaskIDs: [String]

    public init(removedColumnID: String, movedTaskIDs: [String] = [], deletedTaskIDs: [String] = []) {
        self.removedColumnID = removedColumnID
        self.movedTaskIDs = movedTaskIDs
        self.deletedTaskIDs = deletedTaskIDs
    }
}

public struct TaskifySnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 5

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

    public var boardsForSync: [Board] {
        let visible = visibleBoards
        var includedIDs = Set(visible.map(\.id))
        for compound in visible where compound.kind == .compound {
            for child in compoundChildBoards(for: compound.id) {
                includedIDs.insert(child.id)
            }
        }
        return boards.filter { includedIDs.contains($0.id) }
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
    public mutating func createListBoard(
        name: String,
        initialColumnName: String = "Items",
        now: Date = Date()
    ) -> Board? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedColumnName = initialColumnName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedColumnName.isEmpty else { return nil }

        let board = Board(
            name: trimmedName,
            kind: .list,
            columns: [
                BoardColumn(id: UUID().uuidString, name: trimmedColumnName, order: 0),
            ],
            createdAt: now
        )
        boards.append(board)
        selectedBoardID = board.id
        return board
    }

    @discardableResult
    public mutating func createCompoundBoard(
        name: String,
        childBoardIDs: [String] = [],
        now: Date = Date()
    ) -> Board? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return nil }

        let children = normalizedCompoundChildReferences(childBoardIDs)
        let board = Board(
            name: trimmedName,
            kind: .compound,
            children: children,
            createdAt: now
        )
        boards.append(board)
        selectedBoardID = board.id
        return board
    }

    public func compoundChildBoards(for boardID: String) -> [Board] {
        guard let compound = boards.first(where: { $0.id == boardID && $0.kind == .compound }) else {
            return []
        }
        var seen = Set<String>()
        return compound.children.compactMap { reference in
            guard let child = boards.first(where: { $0.matchesReference(reference) && $0.kind == .list }),
                  seen.insert(child.id).inserted else { return nil }
            return child
        }
    }

    @discardableResult
    public mutating func setCompoundChild(
        boardID: String,
        childBoardID: String,
        included: Bool
    ) -> Bool {
        guard let parentIndex = boards.firstIndex(where: { $0.id == boardID && $0.kind == .compound && $0.isVisible }),
              let child = boards.first(where: { $0.matchesReference(childBoardID) && $0.kind == .list }) else {
            return false
        }
        let existingIndex = boards[parentIndex].children.firstIndex(where: { child.matchesReference($0) })
        if included {
            guard existingIndex == nil else { return true }
            boards[parentIndex].children.append(child.effectiveNostrBoardID)
        } else {
            guard existingIndex != nil else { return true }
            boards[parentIndex].children.removeAll { child.matchesReference($0) }
        }
        return true
    }

    @discardableResult
    public mutating func moveCompoundChild(
        boardID: String,
        childBoardID: String,
        direction: Int
    ) -> Bool {
        guard let parentIndex = boards.firstIndex(where: { $0.id == boardID && $0.kind == .compound && $0.isVisible }),
              let child = boards.first(where: { $0.matchesReference(childBoardID) && $0.kind == .list }),
              let currentIndex = boards[parentIndex].children.firstIndex(where: { child.matchesReference($0) }) else {
            return false
        }
        let destinationIndex = currentIndex + direction
        guard boards[parentIndex].children.indices.contains(destinationIndex) else { return false }
        boards[parentIndex].children.swapAt(currentIndex, destinationIndex)
        return true
    }

    @discardableResult
    public mutating func setCompoundHideChildBoardNames(
        boardID: String,
        hidden: Bool
    ) -> Bool {
        guard let index = boards.firstIndex(where: { $0.id == boardID && $0.kind == .compound && $0.isVisible }) else {
            return false
        }
        boards[index].hideChildBoardNames = hidden
        return true
    }

    @discardableResult
    public mutating func ensureCompoundChildBoards(parentBoardID: String) -> Bool {
        guard let parent = boards.first(where: { $0.id == parentBoardID && $0.kind == .compound }) else {
            return false
        }
        var addedStub = false
        for rawReference in parent.children {
            let reference = rawReference.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !reference.isEmpty,
                  !parent.matchesReference(reference),
                  !boards.contains(where: { $0.matchesReference(reference) }) else { continue }
            boards.append(Board(
                id: reference,
                name: "Linked board",
                kind: .list,
                columns: [BoardColumn(id: UUID().uuidString, name: "Items", order: 0)],
                archived: true,
                hidden: true,
                indexCardEnabled: false,
                createdAt: parent.createdAt,
                nostrBoardID: reference,
                relayURLs: parent.effectiveRelayURLs
            ))
            addedStub = true
        }
        return addedStub
    }

    @discardableResult
    public mutating func addListColumn(boardID: String, name: String) -> BoardColumn? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty,
              let boardIndex = boards.firstIndex(where: { $0.id == boardID && $0.kind == .list && $0.isVisible }) else {
            return nil
        }

        let nextOrder = (boards[boardIndex].columns.map(\.order).max() ?? -1) + 1
        let column = BoardColumn(id: UUID().uuidString, name: trimmedName, order: nextOrder)
        boards[boardIndex].columns.append(column)
        return column
    }

    @discardableResult
    public mutating func renameListColumn(boardID: String, columnID: String, name: String) -> Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty,
              let boardIndex = boards.firstIndex(where: { $0.id == boardID && $0.kind == .list && $0.isVisible }),
              let columnIndex = boards[boardIndex].columns.firstIndex(where: { $0.id == columnID }) else {
            return false
        }
        boards[boardIndex].columns[columnIndex].name = trimmedName
        return true
    }

    @discardableResult
    public mutating func reorderListColumns(boardID: String, orderedColumnIDs: [String]) -> Bool {
        guard let boardIndex = boards.firstIndex(where: { $0.id == boardID && $0.kind == .list && $0.isVisible }) else {
            return false
        }
        let currentColumns = boards[boardIndex].columns
        guard orderedColumnIDs.count == currentColumns.count,
              Set(orderedColumnIDs).count == orderedColumnIDs.count,
              Set(orderedColumnIDs) == Set(currentColumns.map(\.id)) else {
            return false
        }
        let columnsByID = Dictionary(uniqueKeysWithValues: currentColumns.map { ($0.id, $0) })
        boards[boardIndex].columns = orderedColumnIDs.enumerated().compactMap { order, columnID in
            guard var column = columnsByID[columnID] else { return nil }
            column.order = order
            return column
        }
        return true
    }

    @discardableResult
    public mutating func removeListColumn(
        boardID: String,
        columnID: String,
        strategy: ListColumnRemovalStrategy,
        editorPublicKey: String? = nil
    ) -> ListColumnRemovalResult? {
        guard let boardIndex = boards.firstIndex(where: { $0.id == boardID && $0.kind == .list && $0.isVisible }),
              boards[boardIndex].columns.count > 1,
              boards[boardIndex].columns.contains(where: { $0.id == columnID }) else {
            return nil
        }

        let affectedIndices = tasks.indices.filter {
            tasks[$0].boardID == boardID && tasks[$0].columnID == columnID && !tasks[$0].isDeleted
        }
        var result = ListColumnRemovalResult(removedColumnID: columnID)

        switch strategy {
        case .moveTasks(let destinationColumnID):
            guard destinationColumnID != columnID,
                  boards[boardIndex].columns.contains(where: { $0.id == destinationColumnID }) else {
                return nil
            }
            var nextOrder = (tasks
                .filter { $0.boardID == boardID && $0.columnID == destinationColumnID && !$0.isDeleted }
                .map(\.order)
                .max() ?? -1) + 1
            for taskIndex in affectedIndices.sorted(by: { tasks[$0].order < tasks[$1].order }) {
                tasks[taskIndex].columnID = destinationColumnID
                tasks[taskIndex].order = nextOrder
                tasks[taskIndex].lastEditedBy = editorPublicKey ?? tasks[taskIndex].lastEditedBy
                nextOrder += 1
                result.movedTaskIDs.append(tasks[taskIndex].id)
            }
        case .deleteTasks:
            for taskIndex in affectedIndices {
                tasks[taskIndex].deleted = true
                tasks[taskIndex].lastEditedBy = editorPublicKey ?? tasks[taskIndex].lastEditedBy
                result.deletedTaskIDs.append(tasks[taskIndex].id)
            }
        }

        boards[boardIndex].columns.removeAll { $0.id == columnID }
        boards[boardIndex].columns = boards[boardIndex].columns
            .sorted {
                if $0.order != $1.order { return $0.order < $1.order }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            .enumerated()
            .map { order, column in
                var normalized = column
                normalized.order = order
                return normalized
            }
        return result
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
        guard let board = boards.first(where: { $0.id == boardID }),
              board.isVisible || isLinkedCompoundChild(board) else { return nil }
        if board.kind == .list {
            guard let columnID, board.columns.contains(where: { $0.id == columnID }) else { return nil }
        }

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
    public mutating func updateTask(
        taskID: String,
        title: String,
        note: String,
        dueDate: Date?,
        dueDateEnabled: Bool,
        dueTimeEnabled: Bool,
        dueTimeZone: String?,
        priority: TaskPriority?,
        columnID: String?,
        subtasks: [TaskSubtask],
        recurrence: TaskRecurrence? = nil,
        reminders: [TaskReminder] = [],
        reminderTime: String? = nil,
        editorPublicKey: String? = nil,
        calendar: Calendar = .current
    ) -> Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty,
              let taskIndex = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }),
              let board = boards.first(where: { $0.id == tasks[taskIndex].boardID }),
              board.isVisible || isLinkedCompoundChild(board) else {
            return false
        }
        guard !dueDateEnabled || dueDate != nil else { return false }

        let resolvedColumnID: String?
        switch board.kind {
        case .week:
            if dueDateEnabled, let dueDate {
                resolvedColumnID = WeekdayColumn.containing(dueDate, calendar: calendar).rawValue
            } else {
                resolvedColumnID = tasks[taskIndex].columnID
            }
        case .list:
            guard let columnID, board.columns.contains(where: { $0.id == columnID }) else { return false }
            resolvedColumnID = columnID
        case .compound, .bible:
            resolvedColumnID = columnID ?? tasks[taskIndex].columnID
        }

        if resolvedColumnID != tasks[taskIndex].columnID {
            tasks[taskIndex].order = (
                tasks
                    .filter { $0.id != taskID && $0.boardID == board.id && $0.columnID == resolvedColumnID }
                    .map(\.order)
                    .max() ?? -1
            ) + 1
        }

        let normalizedSubtasks = subtasks.compactMap { subtask -> TaskSubtask? in
            let trimmed = subtask.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return TaskSubtask(
                id: subtask.id.isEmpty ? UUID().uuidString : subtask.id,
                title: trimmed,
                completed: subtask.completed
            )
        }
        let normalizedRecurrence = recurrence?.isActive == true ? recurrence : nil
        let normalizedReminders = Self.normalizeReminders(reminders, dueTimeEnabled: dueTimeEnabled)

        tasks[taskIndex].title = trimmedTitle
        tasks[taskIndex].note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        tasks[taskIndex].dueDate = dueDateEnabled ? dueDate : nil
        tasks[taskIndex].dueDateEnabled = dueDateEnabled
        tasks[taskIndex].dueTimeEnabled = dueDateEnabled && dueTimeEnabled
        tasks[taskIndex].dueTimeZone = dueDateEnabled && dueTimeEnabled ? dueTimeZone : nil
        tasks[taskIndex].priority = priority
        tasks[taskIndex].columnID = resolvedColumnID
        tasks[taskIndex].subtasks = normalizedSubtasks.isEmpty ? nil : normalizedSubtasks
        tasks[taskIndex].recurrence = dueDateEnabled ? normalizedRecurrence : nil
        tasks[taskIndex].seriesID = tasks[taskIndex].recurrence == nil
            ? nil
            : (tasks[taskIndex].seriesID ?? tasks[taskIndex].id)
        tasks[taskIndex].reminders = dueDateEnabled && !normalizedReminders.isEmpty ? normalizedReminders : nil
        tasks[taskIndex].reminderTime = dueDateEnabled && !dueTimeEnabled
            ? Self.normalizeReminderTime(reminderTime)
            : nil
        tasks[taskIndex].lastEditedBy = editorPublicKey ?? tasks[taskIndex].lastEditedBy
        return true
    }

    @discardableResult
    public mutating func moveTask(
        taskID: String,
        toBoardID targetBoardID: String,
        columnID targetColumnID: String,
        beforeTaskID: String? = nil,
        editorPublicKey: String? = nil
    ) -> TaskMoveResult? {
        guard let taskIndex = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }),
              let targetBoard = boards.first(where: { $0.id == targetBoardID && $0.kind == .list }),
              targetBoard.isVisible || isLinkedCompoundChild(targetBoard),
              targetBoard.columns.contains(where: { $0.id == targetColumnID }) else {
            return nil
        }

        if let beforeTaskID, beforeTaskID == taskID { return nil }

        let sourceBoardID = tasks[taskIndex].boardID
        let sourceColumnID = tasks[taskIndex].columnID
        let sourceKey = "\(sourceBoardID)::\(sourceColumnID ?? "")"
        let targetKey = "\(targetBoardID)::\(targetColumnID)"

        var movedTask = tasks.remove(at: taskIndex)
        movedTask.boardID = targetBoardID
        movedTask.columnID = targetColumnID
        movedTask.hiddenUntilDate = nil
        movedTask.completed = false
        movedTask.completedAt = nil
        movedTask.lastEditedBy = editorPublicKey ?? movedTask.lastEditedBy

        if sourceKey != targetKey {
            normalizeTaskOrder(boardID: sourceBoardID, columnID: sourceColumnID)
        }

        let targetIndices = orderedTaskIndices(boardID: targetBoardID, columnID: targetColumnID)
        let insertionIndex = beforeTaskID.flatMap { beforeID in
            targetIndices.firstIndex(where: { tasks[$0].id == beforeID })
        } ?? targetIndices.count

        var targetTasks = targetIndices.map { tasks[$0] }
        targetTasks.insert(movedTask, at: insertionIndex)
        let targetIDs = Set(targetTasks.map(\.id))
        tasks.removeAll { targetIDs.contains($0.id) }
        tasks.append(contentsOf: targetTasks.enumerated().map { order, task in
            var normalized = task
            normalized.order = order
            return normalized
        })

        return TaskMoveResult(
            taskID: taskID,
            sourceBoardID: sourceBoardID,
            sourceColumnID: sourceColumnID,
            targetBoardID: targetBoardID,
            targetColumnID: targetColumnID
        )
    }

    @discardableResult
    public mutating func replaceTaskAttachments(
        taskID: String,
        images: [String],
        documents: [TaskDocument],
        editorPublicKey: String? = nil
    ) -> Bool {
        guard let taskIndex = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }) else {
            return false
        }
        let normalizedImages = images.filter {
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        tasks[taskIndex].images = normalizedImages.isEmpty ? nil : normalizedImages
        tasks[taskIndex].documents = documents.isEmpty ? nil : documents
        tasks[taskIndex].lastEditedBy = editorPublicKey ?? tasks[taskIndex].lastEditedBy
        return true
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
        if tasks[index].completed {
            appendNextRecurrence(afterCompletingAt: index, now: now)
        }
        return true
    }

    private mutating func appendNextRecurrence(afterCompletingAt index: Int, now: Date) {
        let completedTask = tasks[index]
        guard let recurrence = completedTask.recurrence,
              let dueDate = completedTask.dueDate,
              let nextDueDate = recurrence.nextOccurrence(
                  after: dueDate,
                  dueTimeEnabled: completedTask.dueTimeEnabled,
                  timeZoneIdentifier: completedTask.dueTimeZone
              ) else { return }

        let seriesID = completedTask.seriesID ?? completedTask.id
        tasks[index].seriesID = seriesID
        let nextID = Self.recurringInstanceID(
            seriesID: seriesID,
            dueDate: nextDueDate,
            recurrence: recurrence,
            timeZoneIdentifier: completedTask.dueTimeZone
        )
        guard !tasks.contains(where: { $0.id == nextID && !$0.isDeleted }) else { return }

        let nextColumnID: String?
        if let board = boards.first(where: { $0.id == completedTask.boardID }), board.kind == .week {
            nextColumnID = WeekdayColumn.containing(nextDueDate).rawValue
        } else {
            nextColumnID = completedTask.columnID
        }
        let nextOrder = (
            tasks
                .filter { $0.boardID == completedTask.boardID && $0.columnID == nextColumnID && !$0.isDeleted }
                .map(\.order)
                .max() ?? -1
        ) + 1
        let resetSubtasks = completedTask.subtasks?.map {
            TaskSubtask(id: $0.id, title: $0.title, completed: false)
        }
        tasks.append(TaskItem(
            id: nextID,
            boardID: completedTask.boardID,
            title: completedTask.title,
            note: completedTask.note,
            dueDate: nextDueDate,
            dueDateEnabled: true,
            dueTimeEnabled: completedTask.dueTimeEnabled,
            dueTimeZone: completedTask.dueTimeZone,
            priority: completedTask.priority,
            images: completedTask.images,
            documents: completedTask.documents,
            subtasks: resetSubtasks,
            recurrence: recurrence,
            seriesID: seriesID,
            reminders: completedTask.reminders,
            reminderTime: completedTask.reminderTime,
            hiddenUntilDate: Self.hiddenUntilForNext(
                nextDueDate,
                recurrence: recurrence,
                timeZoneIdentifier: completedTask.dueTimeZone
            ),
            createdAt: now,
            order: nextOrder,
            columnID: nextColumnID,
            createdBy: completedTask.createdBy,
            lastEditedBy: editorPublicKeyOrFallback(completedTask)
        ))
    }

    private func editorPublicKeyOrFallback(_ task: TaskItem) -> String? {
        task.lastEditedBy ?? task.createdBy
    }

    private static func recurringInstanceID(
        seriesID: String,
        dueDate: Date,
        recurrence: TaskRecurrence,
        timeZoneIdentifier: String?
    ) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZoneIdentifier.flatMap(TimeZone.init(identifier:)) ?? .current
        let components = calendar.dateComponents([.year, .month, .day], from: dueDate)
        let date = String(
            format: "%04d-%02d-%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0
        )
        if case .every(_, .hour, _) = recurrence {
            var utc = Calendar(identifier: .gregorian)
            utc.timeZone = TimeZone(secondsFromGMT: 0)!
            let time = utc.dateComponents([.hour, .minute], from: dueDate)
            return String(
                format: "recurrence:%@:%@T%02d:%02d",
                seriesID,
                date,
                time.hour ?? 0,
                time.minute ?? 0
            )
        }
        return "recurrence:\(seriesID):\(date)"
    }

    private static func hiddenUntilForNext(
        _ dueDate: Date,
        recurrence: TaskRecurrence,
        timeZoneIdentifier: String?
    ) -> Date {
        var calendar = Calendar.current
        calendar.timeZone = timeZoneIdentifier.flatMap(TimeZone.init(identifier:)) ?? calendar.timeZone
        if recurrence.revealsOnDueDate {
            return calendar.startOfDay(for: dueDate)
        }
        return calendar.dateInterval(of: .weekOfYear, for: dueDate)?.start
            ?? calendar.startOfDay(for: dueDate)
    }

    private static func normalizeReminders(
        _ reminders: [TaskReminder],
        dueTimeEnabled: Bool
    ) -> [TaskReminder] {
        var seenMinutes = Set<Int>()
        return reminders.compactMap { reminder in
            guard let minutes = reminder.minutesBefore, seenMinutes.insert(minutes).inserted else { return nil }
            return TaskReminder(minutesBefore: minutes, dateOnly: !dueTimeEnabled)
        }.sorted { ($0.minutesBefore ?? 0) < ($1.minutesBefore ?? 0) }
    }

    private static func normalizeReminderTime(_ value: String?) -> String {
        let parts = (value ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) }.map { min(max($0, 0), 23) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) }.map { min(max($0, 0), 59) } ?? 0
        return String(format: "%02d:%02d", hour, minute)
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

    @discardableResult
    public mutating func mergeRemoteBoard(_ remoteBoard: Board, eventCreatedAt: Int) -> Bool {
        guard let index = boards.firstIndex(where: { $0.id == remoteBoard.id }) else { return false }
        let localClock = boards[index].nostrUpdatedAt ?? 0
        guard eventCreatedAt > localClock else { return false }

        var merged = remoteBoard
        merged.nostrBoardID = boards[index].nostrBoardID
        merged.relayURLs = boards[index].relayURLs
        merged.nostrUpdatedAt = eventCreatedAt
        boards[index] = merged
        repairSelection()
        return true
    }

    public func tasks(
        boardID: String,
        columnID: String,
        includeCompleted: Bool,
        now: Date = Date()
    ) -> [TaskItem] {
        tasks
            .filter {
                $0.boardID == boardID &&
                $0.columnID == columnID &&
                !$0.isDeleted &&
                ($0.hiddenUntilDate == nil || $0.hiddenUntilDate! <= now) &&
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
        for index in boards.indices where boards[index].kind == .compound {
            let compound = boards[index]
            var seen = Set<String>()
            boards[index].children = compound.children.compactMap { rawReference in
                let reference = rawReference.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !reference.isEmpty,
                      !compound.matchesReference(reference),
                      seen.insert(reference).inserted else { return nil }
                return reference
            }
        }
        let compoundIDs = boards
            .filter { $0.kind == .compound && $0.isVisible }
            .map(\.id)
        compoundIDs.forEach { _ = ensureCompoundChildBoards(parentBoardID: $0) }
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

    private func normalizedCompoundChildReferences(_ references: [String]) -> [String] {
        var seen = Set<String>()
        return references.compactMap { reference in
            guard let child = boards.first(where: { $0.matchesReference(reference) && $0.kind == .list && $0.isVisible }),
                  seen.insert(child.id).inserted else { return nil }
            return child.effectiveNostrBoardID
        }
    }

    private func isLinkedCompoundChild(_ board: Board) -> Bool {
        boards.contains { parent in
            parent.kind == .compound &&
                parent.isVisible &&
                parent.children.contains(where: { board.matchesReference($0) })
        }
    }

    private func orderedTaskIndices(boardID: String, columnID: String?) -> [Int] {
        tasks.indices
            .filter {
                tasks[$0].boardID == boardID &&
                    tasks[$0].columnID == columnID &&
                    !tasks[$0].isDeleted
            }
            .sorted {
                let lhs = tasks[$0]
                let rhs = tasks[$1]
                if lhs.order != rhs.order { return lhs.order < rhs.order }
                return lhs.createdAt < rhs.createdAt
            }
    }

    private mutating func normalizeTaskOrder(boardID: String, columnID: String?) {
        for (order, index) in orderedTaskIndices(boardID: boardID, columnID: columnID).enumerated() {
            tasks[index].order = order
        }
    }
}
