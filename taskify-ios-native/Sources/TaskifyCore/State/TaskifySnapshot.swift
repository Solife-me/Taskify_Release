import Foundation

/// Where a quick-added task lands within its column, matching the PWA's `newTaskPosition`
/// setting (which defaults to `top`).
public enum NewTaskPosition: String, Codable, CaseIterable, Sendable {
    case top
    case bottom
}

public enum ListColumnRemovalStrategy: Equatable, Sendable {
    case moveTasks(toColumnID: String)
    case deleteTasks
}

public enum TaskDeletionScope: Equatable, Sendable {
    case single
    case thisAndFuture
}

public struct TaskSeriesChanges: Equatable, Sendable {
    public var updatedTaskIDs: [String]
    public var deletedTaskIDs: [String]

    public init(updatedTaskIDs: [String] = [], deletedTaskIDs: [String] = []) {
        self.updatedTaskIDs = updatedTaskIDs
        self.deletedTaskIDs = deletedTaskIDs
    }

    public var allTaskIDs: [String] {
        Array(Set(updatedTaskIDs + deletedTaskIDs)).sorted()
    }
}

public struct TaskMoveResult: Equatable, Sendable {
    public let taskID: String
    public let sourceBoardID: String
    public let sourceColumnID: String?
    public let targetBoardID: String
    public let targetColumnID: String
    public let updatedTaskIDs: [String]

    public init(
        taskID: String,
        sourceBoardID: String,
        sourceColumnID: String?,
        targetBoardID: String,
        targetColumnID: String,
        updatedTaskIDs: [String]
    ) {
        self.taskID = taskID
        self.sourceBoardID = sourceBoardID
        self.sourceColumnID = sourceColumnID
        self.targetBoardID = targetBoardID
        self.targetColumnID = targetColumnID
        self.updatedTaskIDs = updatedTaskIDs
    }

    public var crossedBoards: Bool { sourceBoardID != targetBoardID }
}

public struct ListColumnRemovalResult: Equatable, Sendable {
    public var removedColumnID: String
    public var movedTaskIDs: [String]
    public var deletedTaskIDs: [String]
    public var movedEventIDs: [String]
    public var deletedEventIDs: [String]

    public init(
        removedColumnID: String,
        movedTaskIDs: [String] = [],
        deletedTaskIDs: [String] = [],
        movedEventIDs: [String] = [],
        deletedEventIDs: [String] = []
    ) {
        self.removedColumnID = removedColumnID
        self.movedTaskIDs = movedTaskIDs
        self.deletedTaskIDs = deletedTaskIDs
        self.movedEventIDs = movedEventIDs
        self.deletedEventIDs = deletedEventIDs
    }
}

public struct BoardDeletionResult: Equatable, Sendable {
    public let deletedBoardID: String
    public let deletedTaskIDs: [String]
    public let deletedEventIDs: [String]
    public let updatedCompoundBoardIDs: [String]

    public init(
        deletedBoardID: String,
        deletedTaskIDs: [String],
        deletedEventIDs: [String] = [],
        updatedCompoundBoardIDs: [String]
    ) {
        self.deletedBoardID = deletedBoardID
        self.deletedTaskIDs = deletedTaskIDs
        self.deletedEventIDs = deletedEventIDs
        self.updatedCompoundBoardIDs = updatedCompoundBoardIDs
    }
}

public struct TaskifySnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 15

    public var schemaVersion: Int
    public var boards: [Board]
    public var tasks: [TaskItem]
    public var selectedBoardID: String
    public var sharedInboxItems: [SharedInboxItem]?
    public var sharedContactInboxItems: [SharedContactInboxItem]?
    public var sharedCalendarInviteItems: [SharedCalendarInviteInboxItem]?
    public var sharedBoardInboxItems: [SharedBoardInboxItem]?
    public var taskifyEvents: [TaskifyEvent]?
    public var sharedTaskRecipients: [SharedTaskRecipient]?
    public var contacts: [NostrContact]?
    public var contactsListUpdatedAt: Int?
    public var contactsListExtraTags: [[String]]?
    public var directMessages: [NostrDirectMessage]?
    public var directMessageReadAt: [String: Int]?
    public var directMessageReactions: [NostrDirectMessageReaction]?
    public var nostrGroupConversations: [NostrGroupConversation]?
    public var directMessageArchivedAt: [String: Int]?
    public var directMessageDeletedEventIDs: [String: Int]?
    public var directMessageBlockedPeers: [String]?
    public var directMessageMutedGroups: [String: Int]?
    public var directMessageLeftGroups: [String]?
    /// Board id → stable recurring series id → last permitted occurrence.
    ///
    /// This is intentionally durable and monotonic. A later stale per-occurrence event may
    /// have a newer Nostr timestamp than a different occurrence's tombstone, so per-id clocks
    /// alone cannot prevent a terminated series from being resurrected.
    public var recurringTaskSeriesCutoffs: [String: [String: Date]]?
    public var recurringTaskifyEventSeriesCutoffs: [String: [String: Date]]?

    public init(
        schemaVersion: Int = TaskifySnapshot.currentSchemaVersion,
        boards: [Board],
        tasks: [TaskItem],
        selectedBoardID: String,
        sharedInboxItems: [SharedInboxItem]? = nil,
        sharedContactInboxItems: [SharedContactInboxItem]? = nil,
        sharedCalendarInviteItems: [SharedCalendarInviteInboxItem]? = nil,
        sharedBoardInboxItems: [SharedBoardInboxItem]? = nil,
        taskifyEvents: [TaskifyEvent]? = nil,
        sharedTaskRecipients: [SharedTaskRecipient]? = nil,
        contacts: [NostrContact]? = nil,
        contactsListUpdatedAt: Int? = nil,
        contactsListExtraTags: [[String]]? = nil,
        directMessages: [NostrDirectMessage]? = nil,
        directMessageReadAt: [String: Int]? = nil,
        directMessageReactions: [NostrDirectMessageReaction]? = nil,
        nostrGroupConversations: [NostrGroupConversation]? = nil,
        directMessageArchivedAt: [String: Int]? = nil,
        directMessageDeletedEventIDs: [String: Int]? = nil,
        directMessageBlockedPeers: [String]? = nil,
        directMessageMutedGroups: [String: Int]? = nil,
        directMessageLeftGroups: [String]? = nil,
        recurringTaskSeriesCutoffs: [String: [String: Date]]? = nil,
        recurringTaskifyEventSeriesCutoffs: [String: [String: Date]]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.boards = boards
        self.tasks = tasks
        self.selectedBoardID = selectedBoardID
        self.sharedInboxItems = sharedInboxItems
        self.sharedContactInboxItems = sharedContactInboxItems
        self.sharedCalendarInviteItems = sharedCalendarInviteItems
        self.sharedBoardInboxItems = sharedBoardInboxItems
        self.taskifyEvents = taskifyEvents
        self.sharedTaskRecipients = sharedTaskRecipients
        self.contacts = contacts
        self.contactsListUpdatedAt = contactsListUpdatedAt
        self.contactsListExtraTags = contactsListExtraTags
        self.directMessages = directMessages
        self.directMessageReadAt = directMessageReadAt
        self.directMessageReactions = directMessageReactions
        self.nostrGroupConversations = nostrGroupConversations
        self.directMessageArchivedAt = directMessageArchivedAt
        self.directMessageDeletedEventIDs = directMessageDeletedEventIDs
        self.directMessageBlockedPeers = directMessageBlockedPeers
        self.directMessageMutedGroups = directMessageMutedGroups
        self.directMessageLeftGroups = directMessageLeftGroups
        self.recurringTaskSeriesCutoffs = recurringTaskSeriesCutoffs
        self.recurringTaskifyEventSeriesCutoffs = recurringTaskifyEventSeriesCutoffs
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
    public mutating func createWeekBoard(
        name: String,
        relayURLs: [String] = TaskifyRelayDefaults.urls,
        now: Date = Date()
    ) -> Board? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return nil }

        let board = Board(
            id: UUID().uuidString,
            name: trimmedName,
            kind: .week,
            columns: WeekdayColumn.allCases.map {
                BoardColumn(id: $0.rawValue, name: $0.shortName, order: $0.calendarWeekday)
            },
            createdAt: now,
            relayURLs: relayURLs
        )
        boards.append(board)
        selectedBoardID = board.id
        return board
    }

    @discardableResult
    public mutating func createListBoard(
        name: String,
        initialColumnName: String = "Items",
        relayURLs: [String] = TaskifyRelayDefaults.urls,
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
            createdAt: now,
            relayURLs: relayURLs
        )
        boards.append(board)
        selectedBoardID = board.id
        return board
    }

    @discardableResult
    public mutating func createCompoundBoard(
        name: String,
        childBoardIDs: [String] = [],
        relayURLs: [String] = TaskifyRelayDefaults.urls,
        now: Date = Date()
    ) -> Board? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return nil }

        let children = normalizedCompoundChildReferences(childBoardIDs)
        let board = Board(
            name: trimmedName,
            kind: .compound,
            children: children,
            createdAt: now,
            relayURLs: relayURLs
        )
        boards.append(board)
        selectedBoardID = board.id
        return board
    }

    /// Fixed id for the single, settings-toggled Bible reading tracker board, matching the PWA's
    /// hardcoded `bibleBoardId`. There is at most one Bible board; it is local-only and never
    /// published to Nostr (its reading progress isn't part of the synced task/board graph either).
    public static let bibleBoardID = "bible-reading"

    /// Creates (or unhides) the singleton Bible board when `enabled` is true, or hides it when false.
    /// Mirrors the PWA settingsHook, which injects/removes a single "Bible" board based on a toggle.
    @discardableResult
    public mutating func setBibleTrackerEnabled(_ enabled: Bool, now: Date = Date()) -> Bool {
        if enabled {
            if let index = boards.firstIndex(where: { $0.id == Self.bibleBoardID }) {
                guard boards[index].hidden else { return false }
                boards[index].hidden = false
                repairSelection()
                return true
            }
            let board = Board(
                id: Self.bibleBoardID,
                name: "Bible",
                kind: .bible,
                createdAt: now
            )
            boards.append(board)
            repairSelection()
            return true
        }

        guard let index = boards.firstIndex(where: { $0.id == Self.bibleBoardID && !$0.hidden }) else {
            return false
        }
        boards[index].hidden = true
        repairSelection()
        return true
    }

    public static let fastingReminderSeriesID = "fasting-reminder-series"

    /// Reconciles auto-generated "Fasting" tasks on the default week board against the desired
    /// schedule, mirroring the PWA's fasting-reminders effect: within a rolling window of
    /// `monthsAhead` months, prune future/incomplete series tasks that no longer match the
    /// desired days and create the ones that are missing. Past and completed occurrences are
    /// left untouched. Returns newly created tasks and the ids of existing tasks that were
    /// deleted or reassigned, so the caller can push the right sync events.
    public mutating func reconcileFastingReminders(
        enabled: Bool,
        mode: FastingRemindersMode,
        weekday: Int,
        perMonth: Int,
        seed: String,
        monthsAhead: Int = 2,
        calendar: Calendar = .current,
        now: Date = Date()
    ) -> (created: [TaskItem], updatedIDs: [String]) {
        guard enabled else {
            var updatedIDs: [String] = []
            for index in tasks.indices where tasks[index].seriesID == Self.fastingReminderSeriesID
                && !tasks[index].completed && !tasks[index].isDeleted {
                tasks[index].deleted = true
                updatedIDs.append(tasks[index].id)
            }
            return ([], updatedIDs)
        }

        guard let targetBoard = boards.first(where: { $0.id == "week-default" && $0.kind == .week })
            ?? boards.first(where: { $0.kind == .week && $0.isVisible })
            ?? boards.first(where: { $0.kind == .week }) else {
            return ([], [])
        }

        let todayMidnight = calendar.startOfDay(for: now)
        var monthKeys = Set<String>()
        var desiredDates: [Date] = []
        for offset in 0..<max(1, monthsAhead) {
            guard let anchor = calendar.date(byAdding: .month, value: offset, to: now) else { continue }
            let year = calendar.component(.year, from: anchor)
            let month = calendar.component(.month, from: anchor)
            monthKeys.insert(String(format: "%04d-%02d", year, month))
            desiredDates.append(contentsOf: FastingReminders.dueDates(
                year: year,
                monthIndex: month - 1,
                mode: mode,
                weekday: weekday,
                perMonth: perMonth,
                seed: seed,
                calendar: calendar
            ))
        }
        let desiredDueDates = Set(desiredDates)

        var updatedIDs: [String] = []
        var satisfiedDueDates = Set<Date>()
        for index in tasks.indices {
            guard tasks[index].seriesID == Self.fastingReminderSeriesID,
                  !tasks[index].isDeleted,
                  !tasks[index].completed,
                  let dueDate = tasks[index].dueDate else { continue }
            let dueMidnight = calendar.startOfDay(for: dueDate)
            let monthKey = String(
                format: "%04d-%02d",
                calendar.component(.year, from: dueMidnight),
                calendar.component(.month, from: dueMidnight)
            )
            let isFuture = dueMidnight >= todayMidnight
            let isDesired = desiredDueDates.contains(dueMidnight)

            if monthKeys.contains(monthKey), isFuture, !isDesired {
                tasks[index].deleted = true
                updatedIDs.append(tasks[index].id)
                continue
            }
            if isFuture, isDesired {
                satisfiedDueDates.insert(dueMidnight)
            }

            let resolvedColumnID = WeekdayColumn.containing(dueMidnight, calendar: calendar).rawValue
            var changed = false
            if tasks[index].boardID != targetBoard.id {
                tasks[index].boardID = targetBoard.id
                changed = true
            }
            if tasks[index].columnID != resolvedColumnID {
                tasks[index].columnID = resolvedColumnID
                changed = true
            }
            if changed { updatedIDs.append(tasks[index].id) }
        }

        var created: [TaskItem] = []
        let nowWeekStart = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? now
        for dueDate in desiredDates.sorted() where dueDate >= todayMidnight && !satisfiedDueDates.contains(dueDate) {
            satisfiedDueDates.insert(dueDate)
            let columnID = WeekdayColumn.containing(dueDate, calendar: calendar).rawValue
            let dueWeekStart = calendar.dateInterval(of: .weekOfYear, for: dueDate)?.start ?? dueDate
            let hiddenUntil = dueWeekStart > nowWeekStart ? dueWeekStart : nil
            let nextOrder = (
                tasks
                    .filter { $0.boardID == targetBoard.id && $0.columnID == columnID }
                    .map(\.order)
                    .max() ?? -1
            ) + 1
            let task = TaskItem(
                boardID: targetBoard.id,
                title: "Fasting",
                note: "Fasting reminder",
                dueDate: dueDate,
                dueDateEnabled: true,
                seriesID: Self.fastingReminderSeriesID,
                hiddenUntilDate: hiddenUntil,
                createdAt: now,
                order: nextOrder,
                columnID: columnID
            )
            tasks.append(task)
            created.append(task)
        }

        return (created, updatedIDs)
    }

    /// Recomputes the PWA's `hiddenUntilISO` boundary after the user changes the first day of
    /// the week. This includes currently visible tasks because Saturday/Sunday/Monday can move
    /// a neighboring day into or out of the current week.
    public mutating func rebaseWeekVisibility(
        startingOn firstDay: WeekdayColumn,
        calendar: Calendar = .current,
        now: Date = Date()
    ) -> [String] {
        let weekBoardIDs = Set(boards.lazy.filter { $0.kind == .week }.map(\.id))
        let today = calendar.startOfDay(for: now)
        let currentWeekStart = WeekDateResolver.startOfWeek(
            containing: now,
            startingOn: firstDay,
            calendar: calendar
        )
        var updatedIDs: [String] = []

        for index in tasks.indices {
            guard !tasks[index].isDeleted,
                  !tasks[index].completed,
                  weekBoardIDs.contains(tasks[index].boardID),
                  tasks[index].dueDateEnabled,
                  let dueDate = tasks[index].dueDate else {
                continue
            }

            let nextHiddenUntil: Date?
            if tasks[index].recurrence?.revealsOnDueDate == true {
                let dueDay = calendar.startOfDay(for: dueDate)
                nextHiddenUntil = dueDay > today ? dueDay : nil
            } else {
                let dueWeekStart = WeekDateResolver.startOfWeek(
                    containing: dueDate,
                    startingOn: firstDay,
                    calendar: calendar
                )
                nextHiddenUntil = dueWeekStart > currentWeekStart ? dueWeekStart : nil
            }

            guard tasks[index].hiddenUntilDate != nextHiddenUntil else { continue }
            tasks[index].hiddenUntilDate = nextHiddenUntil
            updatedIDs.append(tasks[index].id)
        }

        return updatedIDs
    }

    @discardableResult
    public mutating func renameBoard(boardID: String, name: String) -> Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty,
              let index = boards.firstIndex(where: {
                  $0.id == boardID && !$0.hidden && $0.kind != .bible
              }) else { return false }
        guard boards[index].name != trimmedName else { return true }
        boards[index].name = trimmedName
        return true
    }

    /// Swaps a board with its neighbor among the visible, non-Bible boards (the set shown in the
    /// board switcher). Board order has no dedicated field — it's just array position in
    /// `boards` — and it's local-only: order isn't part of the synced board event, so this never
    /// needs to publish anything.
    @discardableResult
    public mutating func moveBoard(boardID: String, direction: Int) -> Bool {
        guard direction == -1 || direction == 1 else { return false }
        let orderedIndices = boards.indices.filter { boards[$0].isVisible && boards[$0].kind != .bible }
        guard let position = orderedIndices.firstIndex(where: { boards[$0].id == boardID }) else { return false }
        let targetPosition = position + direction
        guard orderedIndices.indices.contains(targetPosition) else { return false }
        boards.swapAt(orderedIndices[position], orderedIndices[targetPosition])
        return true
    }

    @discardableResult
    public mutating func updateBoardRelayURLs(
        boardID: String,
        relayURLs: [String]
    ) -> Bool {
        let normalized = TaskifyRelayURL.normalizedList(relayURLs)
        guard !normalized.isEmpty,
              let index = boards.firstIndex(where: {
                  $0.id == boardID && !$0.hidden && $0.kind != .bible
              }) else { return false }
        boards[index].relayURLs = normalized
        return true
    }

    @discardableResult
    public mutating func archiveBoard(boardID: String) -> Bool {
        guard let index = boards.firstIndex(where: {
            $0.id == boardID && $0.isVisible && $0.kind != .bible
        }), visibleBoards.contains(where: { $0.id != boardID }) else { return false }

        boards[index].archived = true
        repairSelection()
        return true
    }

    @discardableResult
    public mutating func unarchiveBoard(boardID: String) -> Bool {
        guard let index = boards.firstIndex(where: {
            $0.id == boardID && $0.archived && !$0.hidden && $0.kind != .bible
        }) else { return false }
        boards[index].archived = false
        repairSelection()
        return true
    }

    @discardableResult
    public mutating func deleteBoard(boardID: String) -> BoardDeletionResult? {
        guard let boardIndex = boards.firstIndex(where: {
            $0.id == boardID && !$0.hidden && $0.kind != .bible
        }) else { return nil }

        let deletedBoard = boards.remove(at: boardIndex)
        let deletedTaskIDs = tasks
            .filter { $0.boardID == deletedBoard.id }
            .map(\.id)
        tasks.removeAll { $0.boardID == deletedBoard.id }
        let deletedEventIDs = (taskifyEvents ?? [])
            .filter { $0.boardID == deletedBoard.id }
            .map(\.id)
        taskifyEvents?.removeAll { $0.boardID == deletedBoard.id }

        var updatedCompoundBoardIDs: [String] = []
        for index in boards.indices where boards[index].kind == .compound {
            let originalCount = boards[index].children.count
            boards[index].children.removeAll { deletedBoard.matchesReference($0) }
            if boards[index].children.count != originalCount {
                updatedCompoundBoardIDs.append(boards[index].id)
            }
        }

        repairSelection()
        return BoardDeletionResult(
            deletedBoardID: deletedBoard.id,
            deletedTaskIDs: deletedTaskIDs,
            deletedEventIDs: deletedEventIDs,
            updatedCompoundBoardIDs: updatedCompoundBoardIDs
        )
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
    public mutating func setBoardIndexCardEnabled(
        boardID: String,
        enabled: Bool
    ) -> Bool {
        guard let index = boards.firstIndex(where: {
            $0.id == boardID && ($0.kind == .list || $0.kind == .compound) && $0.isVisible
        }) else {
            return false
        }
        boards[index].indexCardEnabled = enabled
        return true
    }

    @discardableResult
    public mutating func setBoardClearCompletedEnabled(
        boardID: String,
        enabled: Bool
    ) -> Bool {
        guard let index = boards.firstIndex(where: {
            $0.id == boardID && $0.kind != .bible && $0.isVisible
        }) else {
            return false
        }
        boards[index].clearCompletedDisabled = !enabled
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
        var events = taskifyEvents ?? []
        let affectedEventIndices = events.indices.filter {
            events[$0].boardID == boardID && events[$0].columnID == columnID && !events[$0].isDeleted
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
            var nextEventOrder = (events
                .filter { $0.boardID == boardID && $0.columnID == destinationColumnID && !$0.isDeleted }
                .compactMap(\.order)
                .max() ?? -1) + 1
            for eventIndex in affectedEventIndices.sorted(by: {
                (events[$0].order ?? Int.max) < (events[$1].order ?? Int.max)
            }) {
                events[eventIndex].columnID = destinationColumnID
                events[eventIndex].order = nextEventOrder
                events[eventIndex].lastEditedBy = editorPublicKey ?? events[eventIndex].lastEditedBy
                events[eventIndex].canonicalAddress = ""
                events[eventIndex].viewAddress = ""
                events[eventIndex].nostrUpdatedAt = nil
                nextEventOrder += 1
                result.movedEventIDs.append(events[eventIndex].id)
            }
        case .deleteTasks:
            for taskIndex in affectedIndices {
                tasks[taskIndex].deleted = true
                tasks[taskIndex].lastEditedBy = editorPublicKey ?? tasks[taskIndex].lastEditedBy
                result.deletedTaskIDs.append(tasks[taskIndex].id)
            }
            for eventIndex in affectedEventIndices {
                events[eventIndex].deleted = true
                events[eventIndex].lastEditedBy = editorPublicKey ?? events[eventIndex].lastEditedBy
                result.deletedEventIDs.append(events[eventIndex].id)
            }
        }

        if !affectedEventIndices.isEmpty {
            taskifyEvents = events
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
        id: String = UUID().uuidString,
        title: String,
        boardID: String,
        columnID: String?,
        dueDate: Date?,
        note: String = "",
        priority: TaskPriority? = nil,
        authorPublicKey: String? = nil,
        newTaskPosition: NewTaskPosition = .top,
        now: Date = Date()
    ) -> TaskItem? {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { return nil }
        guard let board = boards.first(where: { $0.id == boardID }),
              board.isVisible || isLinkedCompoundChild(board) else { return nil }
        if board.kind == .list {
            guard let columnID, board.columns.contains(where: { $0.id == columnID }) else { return nil }
        }

        let columnOrders = tasks.filter { $0.boardID == boardID && $0.columnID == columnID }.map(\.order)
        let nextOrder: Int
        switch newTaskPosition {
        case .top:
            nextOrder = (columnOrders.min() ?? 0) - 1
        case .bottom:
            nextOrder = (columnOrders.max() ?? -1) + 1
        }
        let task = TaskItem(
            id: id,
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
                var dueCalendar = calendar
                if dueTimeEnabled,
                   let dueTimeZone,
                   let timeZone = TimeZone(identifier: dueTimeZone) {
                    dueCalendar.timeZone = timeZone
                }
                resolvedColumnID = WeekdayColumn.containing(dueDate, calendar: dueCalendar).rawValue
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
        editorPublicKey: String? = nil,
        calendar: Calendar = .current
    ) -> TaskMoveResult? {
        guard let taskIndex = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }),
              let targetBoard = boards.first(where: { $0.id == targetBoardID }),
              targetBoard.isVisible || isLinkedCompoundChild(targetBoard) else {
            return nil
        }

        let targetWeekday: WeekdayColumn?
        switch targetBoard.kind {
        case .week:
            targetWeekday = WeekdayColumn(rawValue: targetColumnID)
            guard targetWeekday != nil, tasks[taskIndex].boardID == targetBoardID else { return nil }
        case .list:
            targetWeekday = nil
            guard targetBoard.columns.contains(where: { $0.id == targetColumnID }) else { return nil }
        case .compound, .bible:
            return nil
        }

        if let beforeTaskID, beforeTaskID == taskID { return nil }

        let originalTasksByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })

        let sourceBoardID = tasks[taskIndex].boardID
        let sourceColumnID = tasks[taskIndex].columnID
        let sourceKey = "\(sourceBoardID)::\(sourceColumnID ?? "")"
        let targetKey = "\(targetBoardID)::\(targetColumnID)"

        var movedTask = tasks.remove(at: taskIndex)
        movedTask.boardID = targetBoardID
        movedTask.columnID = targetColumnID
        if let targetWeekday {
            var taskCalendar = calendar
            if movedTask.dueTimeEnabled,
               let timeZoneID = movedTask.dueTimeZone,
               let timeZone = TimeZone(identifier: timeZoneID) {
                taskCalendar.timeZone = timeZone
            }
            let originalDueDate = movedTask.dueDate
            let targetDate = WeekDateResolver.date(
                for: targetWeekday,
                inWeekContaining: originalDueDate ?? Date(),
                calendar: taskCalendar
            )
            if movedTask.dueTimeEnabled, let originalDueDate {
                let time = taskCalendar.dateComponents([.hour, .minute, .second], from: originalDueDate)
                movedTask.dueDate = taskCalendar.date(
                    bySettingHour: time.hour ?? 0,
                    minute: time.minute ?? 0,
                    second: time.second ?? 0,
                    of: targetDate
                ) ?? targetDate
            } else {
                movedTask.dueDate = targetDate
            }
            movedTask.dueDateEnabled = true
        }
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
        let updatedTaskIDs = tasks.compactMap { task in
            originalTasksByID[task.id] == task ? nil : task.id
        }

        return TaskMoveResult(
            taskID: taskID,
            sourceBoardID: sourceBoardID,
            sourceColumnID: sourceColumnID,
            targetBoardID: targetBoardID,
            targetColumnID: targetColumnID,
            updatedTaskIDs: updatedTaskIDs
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
        streaksEnabled: Bool = true,
        weekStartsOn: WeekdayColumn? = nil,
        now: Date = Date()
    ) -> Bool {
        guard let index = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }) else { return false }
        tasks[index].completed.toggle()
        tasks[index].completedAt = tasks[index].completed ? now : nil
        tasks[index].lastEditedBy = editorPublicKey ?? tasks[index].lastEditedBy

        // Streaks track completions of "frequent" recurring tasks (daily/weekly, or every N
        // days/weeks) — the same set of recurrences that reveal on their due date rather than
        // at the start of their window. Matches the PWA's `isFrequentRecurrence` check.
        if streaksEnabled, tasks[index].recurrence?.revealsOnDueDate == true {
            let currentStreak = tasks[index].streak ?? 0
            if tasks[index].completed {
                let newStreak = currentStreak + 1
                tasks[index].streak = newStreak
                tasks[index].longestStreak = max(tasks[index].longestStreak ?? currentStreak, newStreak)
            } else {
                tasks[index].streak = max(0, currentStreak - 1)
            }
        }

        if tasks[index].completed {
            appendNextRecurrence(
                afterCompletingAt: index,
                weekStartsOn: weekStartsOn,
                now: now
            )
        }
        return true
    }

    @discardableResult
    public mutating func toggleSubtaskCompletion(
        taskID: String,
        subtaskID: String,
        editorPublicKey: String? = nil
    ) -> Bool {
        guard let taskIndex = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }),
              var subtasks = tasks[taskIndex].subtasks,
              let subtaskIndex = subtasks.firstIndex(where: { $0.id == subtaskID }) else {
            return false
        }
        subtasks[subtaskIndex].completed.toggle()
        tasks[taskIndex].subtasks = subtasks
        tasks[taskIndex].lastEditedBy = editorPublicKey ?? tasks[taskIndex].lastEditedBy
        return true
    }

    private mutating func appendNextRecurrence(
        afterCompletingAt index: Int,
        weekStartsOn: WeekdayColumn?,
        now: Date
    ) {
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
            var dueCalendar = Calendar.current
            if completedTask.dueTimeEnabled,
               let dueTimeZone = completedTask.dueTimeZone,
               let timeZone = TimeZone(identifier: dueTimeZone) {
                dueCalendar.timeZone = timeZone
            }
            nextColumnID = WeekdayColumn.containing(nextDueDate, calendar: dueCalendar).rawValue
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
                timeZoneIdentifier: completedTask.dueTimeZone,
                weekStartsOn: weekStartsOn
            ),
            createdAt: now,
            order: nextOrder,
            columnID: nextColumnID,
            createdBy: completedTask.createdBy,
            lastEditedBy: editorPublicKeyOrFallback(completedTask),
            streak: completedTask.streak,
            longestStreak: completedTask.longestStreak
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
        timeZoneIdentifier: String?,
        weekStartsOn: WeekdayColumn?
    ) -> Date {
        var calendar = Calendar.current
        calendar.timeZone = timeZoneIdentifier.flatMap(TimeZone.init(identifier:)) ?? calendar.timeZone
        if recurrence.revealsOnDueDate {
            return calendar.startOfDay(for: dueDate)
        }
        if let weekStartsOn {
            return WeekDateResolver.startOfWeek(
                containing: dueDate,
                startingOn: weekStartsOn,
                calendar: calendar
            )
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
        !deleteTask(
            taskID: taskID,
            scope: .single,
            editorPublicKey: editorPublicKey
        ).allTaskIDs.isEmpty
    }

    @discardableResult
    public mutating func deleteTask(
        taskID: String,
        scope: TaskDeletionScope,
        editorPublicKey: String? = nil
    ) -> TaskSeriesChanges {
        guard let selectedIndex = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }) else {
            return TaskSeriesChanges()
        }

        guard scope == .thisAndFuture,
              tasks[selectedIndex].recurrence?.isActive == true,
              let selectedDueDate = tasks[selectedIndex].dueDate else {
            tasks[selectedIndex].deleted = true
            tasks[selectedIndex].lastEditedBy = editorPublicKey ?? tasks[selectedIndex].lastEditedBy
            return TaskSeriesChanges(deletedTaskIDs: [taskID])
        }

        let selected = tasks[selectedIndex]
        let seriesID = Self.stableRecurringSeriesID(for: selected)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = selected.dueTimeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        let selectedDay = calendar.startOfDay(for: selectedDueDate)
        guard let proposedCutoff = calendar.date(byAdding: .day, value: -1, to: selectedDay) else {
            return TaskSeriesChanges()
        }
        let cutoff = recordRecurringTaskSeriesCutoff(
            boardID: selected.boardID,
            seriesID: seriesID,
            proposedCutoff: proposedCutoff
        )

        var updatedIDs = Set<String>()
        var deletedIDs = Set<String>()
        for index in tasks.indices {
            guard tasks[index].boardID == selected.boardID,
                  tasks[index].recurrence?.isActive == true,
                  Self.stableRecurringSeriesID(for: tasks[index]) == seriesID,
                  let dueDate = tasks[index].dueDate else { continue }

            let original = tasks[index]
            tasks[index] = Self.task(
                tasks[index],
                applyingSeriesID: seriesID,
                cutoff: cutoff
            )
            if calendar.startOfDay(for: dueDate) > calendar.startOfDay(for: cutoff) {
                tasks[index].deleted = true
            }
            guard tasks[index] != original else { continue }
            tasks[index].lastEditedBy = editorPublicKey ?? tasks[index].lastEditedBy
            if tasks[index].isDeleted {
                deletedIDs.insert(tasks[index].id)
            } else {
                updatedIDs.insert(tasks[index].id)
            }
        }

        return TaskSeriesChanges(
            updatedTaskIDs: updatedIDs.sorted(),
            deletedTaskIDs: deletedIDs.sorted()
        )
    }

    /// Batched form of `mergeRemoteTask`. Building one id→index map up front makes a backlog
    /// merge O(records + tasks) instead of the O(records × tasks) that repeated
    /// `firstIndex(where:)` scans cost during initial sync.
    @discardableResult
    public mutating func mergeRemoteTasks(
        _ records: [(task: TaskItem, eventCreatedAt: Int)]
    ) -> Bool {
        guard !records.isEmpty else { return false }

        var changed = false
        for record in records {
            if record.task.isDeleted,
               let recurrence = record.task.recurrence,
               recurrence.isActive,
               let cutoff = recurrence.untilDate,
               let dueDate = record.task.dueDate,
               Self.isDay(cutoff, before: dueDate, for: record.task) {
                let seriesID = Self.stableRecurringSeriesID(for: record.task)
                let previous = recurringTaskSeriesCutoffs?[record.task.boardID]?[seriesID]
                let recorded = recordRecurringTaskSeriesCutoff(
                    boardID: record.task.boardID,
                    seriesID: seriesID,
                    proposedCutoff: cutoff
                )
                if previous != recorded {
                    changed = true
                }
            }
        }
        if applyRecurringTaskSeriesCutoffs() {
            changed = true
        }

        var indexByID = [String: Int](minimumCapacity: tasks.count)
        for (index, task) in tasks.enumerated() {
            indexByID[task.id] = index
        }

        for record in records {
            let remoteTask = taskApplyingRecurringSeriesCutoff(record.task)
            if let index = indexByID[remoteTask.id] {
                let localClock = tasks[index].nostrUpdatedAt ?? 0
                guard record.eventCreatedAt > localClock else { continue }
                var merged = remoteTask
                var preservedFields = tasks[index].preservedSyncFields ?? [:]
                for (name, value) in remoteTask.preservedSyncFields ?? [:] {
                    preservedFields[name] = value
                }
                merged.preservedSyncFields = preservedFields.isEmpty ? nil : preservedFields
                merged.nostrUpdatedAt = record.eventCreatedAt
                tasks[index] = merged
                changed = true
            } else {
                var inserted = remoteTask
                inserted.nostrUpdatedAt = record.eventCreatedAt
                indexByID[inserted.id] = tasks.count
                tasks.append(inserted)
                changed = true
            }
        }
        return changed
    }

    @discardableResult
    public mutating func mergeRemoteTask(_ remoteTask: TaskItem, eventCreatedAt: Int) -> Bool {
        mergeRemoteTasks([(task: remoteTask, eventCreatedAt: eventCreatedAt)])
    }

    private static func stableRecurringSeriesID(for task: TaskItem) -> String {
        func recoverRoot(_ rawValue: String) -> String {
            var current = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
            var seen = Set<String>()
            let pattern = #"^recurrence:(.+):(\d{4}-\d{2}-\d{2}(?:T.*)?)$"#
            let expression = try? NSRegularExpression(pattern: pattern)
            while !current.isEmpty, seen.insert(current).inserted {
                let range = NSRange(current.startIndex..., in: current)
                guard let match = expression?.firstMatch(in: current, range: range),
                      match.numberOfRanges > 1,
                      let parentRange = Range(match.range(at: 1), in: current) else { break }
                let parent = String(current[parentRange]).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !parent.isEmpty else { break }
                current = parent
            }
            return current
        }

        let explicit = task.seriesID.map(recoverRoot) ?? ""
        return explicit.isEmpty ? recoverRoot(task.id) : explicit
    }

    private static func recurrenceCalendar(for task: TaskItem) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = task.dueTimeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        return calendar
    }

    private static func isDay(_ lhs: Date, before rhs: Date, for task: TaskItem) -> Bool {
        let calendar = recurrenceCalendar(for: task)
        return calendar.startOfDay(for: lhs) < calendar.startOfDay(for: rhs)
    }

    @discardableResult
    private mutating func recordRecurringTaskSeriesCutoff(
        boardID: String,
        seriesID: String,
        proposedCutoff: Date
    ) -> Date {
        guard !boardID.isEmpty, !seriesID.isEmpty else { return proposedCutoff }
        let existing = recurringTaskSeriesCutoffs?[boardID]?[seriesID]
        let cutoff = existing.map { min($0, proposedCutoff) } ?? proposedCutoff
        if existing != cutoff {
            var boardCutoffs = recurringTaskSeriesCutoffs?[boardID] ?? [:]
            boardCutoffs[seriesID] = cutoff
            var allCutoffs = recurringTaskSeriesCutoffs ?? [:]
            allCutoffs[boardID] = boardCutoffs
            recurringTaskSeriesCutoffs = allCutoffs
        }
        return cutoff
    }

    private static func task(
        _ task: TaskItem,
        applyingSeriesID seriesID: String,
        cutoff: Date
    ) -> TaskItem {
        guard let recurrence = task.recurrence, recurrence.isActive else { return task }
        var updated = task
        let calendar = recurrenceCalendar(for: task)
        let existingUntil = recurrence.untilDate
        let effectiveCutoff: Date
        if let existingUntil,
           calendar.startOfDay(for: existingUntil) <= calendar.startOfDay(for: cutoff) {
            effectiveCutoff = existingUntil
        } else {
            effectiveCutoff = cutoff
        }
        updated.recurrence = recurrence.withUntilDate(effectiveCutoff)
        updated.seriesID = seriesID
        return updated
    }

    private func taskApplyingRecurringSeriesCutoff(_ task: TaskItem) -> TaskItem {
        let seriesID = Self.stableRecurringSeriesID(for: task)
        guard let cutoff = recurringTaskSeriesCutoffs?[task.boardID]?[seriesID],
              task.recurrence?.isActive == true else { return task }
        var updated = Self.task(task, applyingSeriesID: seriesID, cutoff: cutoff)
        if let dueDate = updated.dueDate,
           Self.isDay(cutoff, before: dueDate, for: updated) {
            updated.deleted = true
        }
        return updated
    }

    @discardableResult
    private mutating func applyRecurringTaskSeriesCutoffs() -> Bool {
        guard recurringTaskSeriesCutoffs?.isEmpty == false else { return false }
        var changed = false
        for index in tasks.indices {
            let updated = taskApplyingRecurringSeriesCutoff(tasks[index])
            guard updated != tasks[index] else { continue }
            tasks[index] = updated
            changed = true
        }
        return changed
    }

    @discardableResult
    mutating func recordRecurringTaskifyEventSeriesCutoff(from event: TaskifyEvent) -> Bool {
        guard event.isDeleted,
              let recurrence = event.recurrence,
              recurrence.isActive,
              let cutoff = recurrence.untilDate,
              let startDate = event.startDate else { return false }
        let calendar = Self.recurrenceCalendar(for: event)
        guard calendar.startOfDay(for: cutoff) < calendar.startOfDay(for: startDate) else {
            return false
        }
        let seriesID = event.seriesID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let boardID = event.boardID?.trimmingCharacters(in: .whitespacesAndNewlines),
              !boardID.isEmpty,
              !seriesID.isEmpty else { return false }
        let existing = recurringTaskifyEventSeriesCutoffs?[boardID]?[seriesID]
        let effective = existing.map { min($0, cutoff) } ?? cutoff
        guard existing != effective else { return false }
        var boardCutoffs = recurringTaskifyEventSeriesCutoffs?[boardID] ?? [:]
        boardCutoffs[seriesID] = effective
        var allCutoffs = recurringTaskifyEventSeriesCutoffs ?? [:]
        allCutoffs[boardID] = boardCutoffs
        recurringTaskifyEventSeriesCutoffs = allCutoffs
        return true
    }

    private static func recurrenceCalendar(for event: TaskifyEvent) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = event.isAllDay
            ? TimeZone(secondsFromGMT: 0)!
            : event.startTimeZoneID.flatMap(TimeZone.init(identifier:)) ?? .current
        return calendar
    }

    func taskifyEventApplyingRecurringSeriesCutoff(_ event: TaskifyEvent) -> TaskifyEvent {
        guard let recurrence = event.recurrence,
              recurrence.isActive,
              let seriesID = event.seriesID,
              let boardID = event.boardID,
              let cutoff = recurringTaskifyEventSeriesCutoffs?[boardID]?[seriesID] else {
            return event
        }
        let calendar = Self.recurrenceCalendar(for: event)
        let existingUntil = recurrence.untilDate
        let effective = existingUntil.map {
            calendar.startOfDay(for: $0) <= calendar.startOfDay(for: cutoff) ? $0 : cutoff
        } ?? cutoff
        var updated = event
        updated.recurrence = recurrence.withUntilDate(effective)
        if let startDate = event.startDate,
           calendar.startOfDay(for: startDate) > calendar.startOfDay(for: effective) {
            updated.deleted = true
        }
        return updated
    }

    @discardableResult
    mutating func applyRecurringTaskifyEventSeriesCutoffs() -> Bool {
        guard recurringTaskifyEventSeriesCutoffs?.isEmpty == false,
              var events = taskifyEvents else { return false }
        var changed = false
        for index in events.indices {
            let updated = taskifyEventApplyingRecurringSeriesCutoff(events[index])
            guard updated != events[index] else { continue }
            events[index] = updated
            changed = true
        }
        if changed {
            taskifyEvents = events
        }
        return changed
    }

    @discardableResult
    public mutating func mergeRemoteBoard(_ remoteBoard: Board, eventCreatedAt: Int) -> Bool {
        guard let index = boards.firstIndex(where: { $0.id == remoteBoard.id }) else { return false }
        let localClock = boards[index].nostrUpdatedAt ?? 0
        guard eventCreatedAt > localClock else { return false }

        var merged = remoteBoard
        merged.nostrBoardID = boards[index].nostrBoardID
        merged.relayURLs = boards[index].relayURLs
        merged.archived = boards[index].archived
        merged.hidden = boards[index].hidden
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
        if let events = taskifyEvents {
            var repaired: [TaskifyEvent] = []
            var indexByID: [String: Int] = [:]
            for event in events {
                guard let existingIndex = indexByID[event.id] else {
                    indexByID[event.id] = repaired.count
                    repaired.append(event)
                    continue
                }
                if Self.prefersTaskifyEvent(event, over: repaired[existingIndex]) {
                    repaired[existingIndex] = event
                }
            }
            taskifyEvents = repaired
        }
        for event in taskifyEvents ?? [] where event.isDeleted {
            _ = recordRecurringTaskifyEventSeriesCutoff(from: event)
        }
        _ = applyRecurringTaskifyEventSeriesCutoffs()
        for task in tasks where task.isDeleted {
            guard let recurrence = task.recurrence,
                  recurrence.isActive,
                  let cutoff = recurrence.untilDate,
                  let dueDate = task.dueDate,
                  Self.isDay(cutoff, before: dueDate, for: task) else { continue }
            _ = recordRecurringTaskSeriesCutoff(
                boardID: task.boardID,
                seriesID: Self.stableRecurringSeriesID(for: task),
                proposedCutoff: cutoff
            )
        }
        _ = applyRecurringTaskSeriesCutoffs()
        for index in boards.indices {
            if boards[index].nostrBoardID?.isEmpty != false {
                boards[index].nostrBoardID = UUID().uuidString
            }
            let normalizedRelays = TaskifyRelayURL.normalizedList(boards[index].relayURLs ?? [])
            boards[index].relayURLs = normalizedRelays.isEmpty
                ? TaskifyRelayDefaults.urls
                : normalizedRelays
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

    private static func prefersTaskifyEvent(
        _ candidate: TaskifyEvent,
        over existing: TaskifyEvent
    ) -> Bool {
        let candidateTimestamp = max(
            candidate.nostrUpdatedAt ?? 0,
            candidate.sourceUpdatedAt ?? 0
        )
        let existingTimestamp = max(
            existing.nostrUpdatedAt ?? 0,
            existing.sourceUpdatedAt ?? 0
        )
        if candidateTimestamp != existingTimestamp {
            return candidateTimestamp > existingTimestamp
        }

        let candidateAddressScore =
            (candidate.canonicalAddress.isEmpty ? 0 : 1)
            + (candidate.viewAddress.isEmpty ? 0 : 1)
        let existingAddressScore =
            (existing.canonicalAddress.isEmpty ? 0 : 1)
            + (existing.viewAddress.isEmpty ? 0 : 1)
        if candidateAddressScore != existingAddressScore {
            return candidateAddressScore > existingAddressScore
        }

        if candidate.isDeleted != existing.isDeleted {
            return candidate.isDeleted
        }
        return false
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
