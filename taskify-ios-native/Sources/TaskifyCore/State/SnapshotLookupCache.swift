import Foundation

/// Snapshot-derived indexes. Confine each instance to one executor and invalidate on snapshot writes.
public final class SnapshotLookupCache {
    public init() {}

    // Deterministic work counters let regression tests detect cache misses without timing noise.
    private(set) var taskIndexBuildCount = 0
    private(set) var upcomingBuildCount = 0
    private(set) var completedBuildCount = 0
    private(set) var eventSliceBuildCount = 0
    private(set) var taskSortBuildCount = 0

    /// Compare value-type source collections once per write, not once per view read. Unchanged
    /// snapshot copies share array storage, so unrelated writes retain the expensive indexes.
    public func invalidate(from old: TaskifySnapshot, to new: TaskifySnapshot) {
        let tasksChanged = old.tasks != new.tasks
        let boardsChanged = old.boards != new.boards
        let eventsChanged = old.taskifyEvents != new.taskifyEvents
        let messagesChanged = old.directMessages != new.directMessages
        let groupsChanged = old.nostrGroupConversations != new.nostrGroupConversations
        if tasksChanged { taskIndex = nil }
        if boardsChanged {
            boardsByID = nil
            cachedVisibleBoards = nil
        }
        if tasksChanged || boardsChanged {
            groupedTasks.removeAll(keepingCapacity: true)
            sortedTasks.removeAll(keepingCapacity: true)
            completedTasks.removeAll(keepingCapacity: true)
        }
        if eventsChanged {
            cachedAcceptedTaskifyEvents = nil
            cachedTaskifyEventIDs = nil
            eventsByBoardID = nil
            eventSlices.removeAll(keepingCapacity: true)
        }
        if tasksChanged || boardsChanged || eventsChanged {
            upcomingGroups.removeAll(keepingCapacity: true)
            upcomingRows.removeAll(keepingCapacity: true)
        }
        if old.contacts != new.contacts { contactsByPublicKey = nil }
        if groupsChanged { groupsByID = nil }
        if messagesChanged {
            messagesByPeer.removeAll(keepingCapacity: true)
        }
        if messagesChanged
            || old.directMessageReadAt != new.directMessageReadAt
            || groupsChanged
            || old.directMessageArchivedAt != new.directMessageArchivedAt
            || old.directMessageMutedGroups != new.directMessageMutedGroups
            || old.sharedInboxItems != new.sharedInboxItems
            || old.sharedContactInboxItems != new.sharedContactInboxItems
            || old.sharedCalendarInviteItems != new.sharedCalendarInviteItems
            || old.sharedBoardInboxItems != new.sharedBoardInboxItems
        {
            cachedDirectMessageThreads = nil
        }
    }

    public func boardUpcomingGroups(
        boardID: String,
        snapshot: TaskifySnapshot,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [BoardUpcomingGroup] {
        prepareDay(now: now, calendar: calendar)
        if let cached = upcomingGroups[boardID] { return cached }
        let scope = scopeIDs(boardID: boardID, snapshot: snapshot)
        ensureTaskIndex(snapshot: snapshot)
        ensureEventIndex(snapshot: snapshot)
        upcomingBuildCount += 1
        let groups = BoardUpcomingOrganizer.groups(
            tasks: scope.flatMap { taskIndex?.tasksByBoardID[$0] ?? [] },
            events: scope.flatMap { eventsByBoardID?[$0] ?? [] },
            includedBoardIDs: scope,
            now: now,
            calendar: calendar
        )
        upcomingGroups[boardID] = groups
        return groups
    }

    public func boardUpcomingRows(
        boardID: String,
        snapshot: TaskifySnapshot,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [BoardUpcomingRow] {
        prepareDay(now: now, calendar: calendar)
        if let cached = upcomingRows[boardID] { return cached }
        let rows = BoardUpcomingRow.rows(
            from: boardUpcomingGroups(
                boardID: boardID, snapshot: snapshot, now: now, calendar: calendar
            ))
        upcomingRows[boardID] = rows
        return rows
    }

    public func boardCompletedTasks(boardID: String, snapshot: TaskifySnapshot) -> [TaskItem] {
        if let cached = completedTasks[boardID] { return cached }
        let scope = scopeIDs(boardID: boardID, snapshot: snapshot)
        ensureTaskIndex(snapshot: snapshot)
        completedBuildCount += 1
        let tasks = BoardCompletedOrganizer.tasks(
            scope.flatMap { taskIndex?.tasksByBoardID[$0] ?? [] },
            includedBoardIDs: scope
        )
        completedTasks[boardID] = tasks
        return tasks
    }

    public func boardEvents(
        boardID: String,
        columnID: String,
        weekday: WeekdayColumn? = nil,
        snapshot: TaskifySnapshot,
        weekStartsOn: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskifyEvent] {
        prepareDay(now: now, calendar: calendar)
        if eventWeekStart != weekStartsOn {
            eventSlices.removeAll(keepingCapacity: true)
            eventWeekStart = weekStartsOn
        }
        let key = EventSliceKey(boardID: boardID, columnID: columnID, weekday: weekday)
        if let cached = eventSlices[key] { return cached }
        ensureEventIndex(snapshot: snapshot)
        let scopedEvents = eventsByBoardID?[boardID] ?? []
        eventSliceBuildCount += 1
        let events: [TaskifyEvent]
        if let weekday {
            events = TaskifyEventBoardOrganizer.events(
                scopedEvents, boardID: boardID, weekday: weekday,
                weekStartsOn: weekStartsOn, now: now, calendar: calendar
            )
        } else {
            events = TaskifyEventBoardOrganizer.events(
                scopedEvents, boardID: boardID, columnID: columnID,
                weekStartsOn: weekStartsOn, now: now, calendar: calendar
            )
        }
        eventSlices[key] = events
        return events
    }

    private func ensureEventIndex(snapshot: TaskifySnapshot) {
        guard eventsByBoardID == nil else { return }
        eventsByBoardID = Dictionary(
            grouping: acceptedTaskifyEvents(snapshot: snapshot), by: { $0.boardID ?? "" })
    }

    private func prepareDay(now: Date, calendar: Calendar) {
        let context = DayContext(day: calendar.startOfDay(for: now), calendar: calendar)
        guard dayContext != context else { return }
        dayContext = context
        upcomingGroups.removeAll(keepingCapacity: true)
        upcomingRows.removeAll(keepingCapacity: true)
        eventSlices.removeAll(keepingCapacity: true)
    }

    private func scopeIDs(boardID: String, snapshot: TaskifySnapshot) -> Set<String> {
        guard board(id: boardID, snapshot: snapshot)?.kind == .compound else { return [boardID] }
        return Set([boardID] + snapshot.compoundChildBoards(for: boardID).map(\.id))
    }

    private struct TaskGroupingKey: Hashable {
        let boardID: String
        let includeCompleted: Bool
    }

    private struct TaskSortKey: Hashable {
        let group: TaskGroupingKey
        let columnID: String
        let mode: UpcomingSortMode
        let direction: UpcomingSortDirection
    }

    private struct EventSliceKey: Hashable {
        let boardID: String
        let columnID: String
        let weekday: WeekdayColumn?
    }

    private struct DayContext: Equatable {
        let day: Date
        let calendar: Calendar
    }

    private struct TaskTimeContext: Equatable {
        let minute: Int
        let weekStartsOn: WeekdayColumn
        let calendar: Calendar
    }

    private var taskTimeContext: TaskTimeContext?
    private var dayContext: DayContext?
    private var eventWeekStart: WeekdayColumn?
    private var sortedTasks: [TaskSortKey: [TaskItem]] = [:]
    private var upcomingGroups: [String: [BoardUpcomingGroup]] = [:]
    private var upcomingRows: [String: [BoardUpcomingRow]] = [:]
    private var completedTasks: [String: [TaskItem]] = [:]
    private var eventsByBoardID: [String: [TaskifyEvent]]?
    private var eventSlices: [EventSliceKey: [TaskifyEvent]] = [:]

    private struct TaskIndex {
        var tasksByID: [String: TaskItem] = [:]
        var activeTaskIDs: Set<String> = []
        var tasksByBoardID: [String: [TaskItem]] = [:]
        var completedTaskCountsByBoardID: [String: Int] = [:]
        var taskCountsByBoardID: [String: Int] = [:]
    }

    private var boardsByID: [String: Board]?
    private var taskIndex: TaskIndex?
    private var groupedTasks: [TaskGroupingKey: [BoardTaskColumnKey: [TaskItem]]] = [:]
    private var contactsByPublicKey: [String: NostrContact]?
    private var groupsByID: [String: NostrGroupConversation]?
    private var cachedVisibleBoards: [Board]?
    private var cachedAcceptedTaskifyEvents: [TaskifyEvent]?
    private var cachedTaskifyEventIDs: Set<String>?
    private var cachedDirectMessageThreads: [NostrDirectMessageThread]?
    private var messagesByPeer: [String: [NostrDirectMessage]] = [:]

    public func invalidate() {
        boardsByID = nil
        taskIndex = nil
        groupedTasks.removeAll(keepingCapacity: true)
        taskTimeContext = nil
        dayContext = nil
        eventWeekStart = nil
        sortedTasks.removeAll(keepingCapacity: true)
        upcomingGroups.removeAll(keepingCapacity: true)
        upcomingRows.removeAll(keepingCapacity: true)
        completedTasks.removeAll(keepingCapacity: true)
        eventsByBoardID = nil
        eventSlices.removeAll(keepingCapacity: true)
        contactsByPublicKey = nil
        groupsByID = nil
        cachedVisibleBoards = nil
        cachedAcceptedTaskifyEvents = nil
        cachedTaskifyEventIDs = nil
        cachedDirectMessageThreads = nil
        messagesByPeer.removeAll(keepingCapacity: true)
    }

    public func directMessageThreads(snapshot: TaskifySnapshot) -> [NostrDirectMessageThread] {
        if let cachedDirectMessageThreads { return cachedDirectMessageThreads }
        let threads = snapshot.activeDirectMessageThreads()
        cachedDirectMessageThreads = threads
        return threads
    }

    public func directMessages(with peerPublicKey: String, snapshot: TaskifySnapshot) -> [NostrDirectMessage]
    {
        let peer = peerPublicKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let messages = messagesByPeer[peer] { return messages }
        let messages = snapshot.directMessages(with: peerPublicKey)
        messagesByPeer[peer] = messages
        return messages
    }

    /// `TaskifySnapshot.acceptedTaskifyEvents` filters and sorts the whole event array on every
    /// read, and each board column reads it while building its own day/column slice. Holding the
    /// result for the life of a snapshot keeps a horizontal swipe from re-sorting the same array
    /// once per column per render.
    public func acceptedTaskifyEvents(snapshot: TaskifySnapshot) -> [TaskifyEvent] {
        if let cachedAcceptedTaskifyEvents { return cachedAcceptedTaskifyEvents }
        let events = snapshot.acceptedTaskifyEvents
        cachedAcceptedTaskifyEvents = events
        return events
    }

    public func taskifyEventIDs(snapshot: TaskifySnapshot) -> Set<String> {
        if let cachedTaskifyEventIDs { return cachedTaskifyEventIDs }
        let ids = Set(acceptedTaskifyEvents(snapshot: snapshot).map(\.id))
        cachedTaskifyEventIDs = ids
        return ids
    }

    public func board(id: String, snapshot: TaskifySnapshot) -> Board? {
        if boardsByID == nil {
            boardsByID = Dictionary(
                snapshot.boards.map { ($0.id, $0) },
                uniquingKeysWith: { _, newest in newest }
            )
        }
        return boardsByID?[id]
    }

    public func task(id: String, snapshot: TaskifySnapshot) -> TaskItem? {
        ensureTaskIndex(snapshot: snapshot)
        return taskIndex?.tasksByID[id]
    }

    public func activeTaskIDs(snapshot: TaskifySnapshot) -> Set<String> {
        ensureTaskIndex(snapshot: snapshot)
        return taskIndex?.activeTaskIDs ?? []
    }

    public func tasks(
        boardID: String,
        columnID: String,
        includeCompleted: Bool,
        sortMode: UpcomingSortMode = .manual,
        sortDirection: UpcomingSortDirection = .ascending,
        snapshot: TaskifySnapshot,
        weekStartsOn: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskItem] {
        let context = TaskTimeContext(
            minute: Int(now.timeIntervalSince1970 / 60),
            weekStartsOn: weekStartsOn,
            calendar: calendar
        )
        if taskTimeContext != context {
            groupedTasks.removeAll(keepingCapacity: true)
            sortedTasks.removeAll(keepingCapacity: true)
            taskTimeContext = context
        }
        let groupingKey = TaskGroupingKey(boardID: boardID, includeCompleted: includeCompleted)
        if groupedTasks[groupingKey] == nil {
            ensureTaskIndex(snapshot: snapshot)
            groupedTasks[groupingKey] = BoardTaskOrganizer.groupedTasks(
                taskIndex?.tasksByBoardID[boardID] ?? [],
                boards: snapshot.boards,
                includedBoardIDs: [boardID],
                includeCompleted: includeCompleted,
                weekStartsOn: weekStartsOn,
                now: now,
                calendar: calendar
            )
        }
        let raw =
            groupedTasks[groupingKey]?[
                BoardTaskColumnKey(boardID: boardID, columnID: columnID)
            ] ?? []
        guard sortMode != .manual else { return raw }
        let key = TaskSortKey(
            group: groupingKey, columnID: columnID, mode: sortMode, direction: sortDirection)
        if let cached = sortedTasks[key] { return cached }
        taskSortBuildCount += 1
        let sorted = UpcomingTaskOrganizer.sortBoardTasks(raw, mode: sortMode, direction: sortDirection)
        sortedTasks[key] = sorted
        return sorted
    }

    public func completedTaskCount(boardIDs: Set<String>, snapshot: TaskifySnapshot) -> Int {
        ensureTaskIndex(snapshot: snapshot)
        return boardIDs.reduce(0) {
            $0 + (taskIndex?.completedTaskCountsByBoardID[$1] ?? 0)
        }
    }

    public func taskCount(boardID: String, snapshot: TaskifySnapshot) -> Int {
        ensureTaskIndex(snapshot: snapshot)
        return taskIndex?.taskCountsByBoardID[boardID] ?? 0
    }

    public func prewarmBoardTasks(
        boardIDs: [String],
        includeCompleted: Bool,
        snapshot: TaskifySnapshot,
        weekStartsOn: WeekdayColumn,
        now: Date = Date(),
        calendar: Calendar = .current
    ) {
        ensureTaskIndex(snapshot: snapshot)
        for boardID in boardIDs {
            guard let board = board(id: boardID, snapshot: snapshot) else { continue }
            let columnID =
                board.columns.first?.id
                ?? (board.kind == .week ? WeekdayColumn.containing(now, calendar: calendar).rawValue : "")
            _ = tasks(
                boardID: boardID,
                columnID: columnID,
                includeCompleted: includeCompleted,
                snapshot: snapshot,
                weekStartsOn: weekStartsOn,
                now: now,
                calendar: calendar
            )
        }
    }

    private func ensureTaskIndex(snapshot: TaskifySnapshot) {
        guard taskIndex == nil else { return }
        taskIndexBuildCount += 1
        var index = TaskIndex()
        index.tasksByID.reserveCapacity(snapshot.tasks.count)
        index.activeTaskIDs.reserveCapacity(snapshot.tasks.count)

        for task in snapshot.tasks where !task.isDeleted {
            index.tasksByID[task.id] = task
            index.activeTaskIDs.insert(task.id)
            index.tasksByBoardID[task.boardID, default: []].append(task)
            index.taskCountsByBoardID[task.boardID, default: 0] += 1
            if task.completed {
                index.completedTaskCountsByBoardID[task.boardID, default: 0] += 1
            }
        }
        taskIndex = index
    }

    public func contact(publicKey: String, snapshot: TaskifySnapshot) -> NostrContact? {
        if contactsByPublicKey == nil {
            contactsByPublicKey = Dictionary(
                (snapshot.contacts ?? []).map {
                    ($0.publicKey.lowercased(), $0)
                },
                uniquingKeysWith: { _, newest in newest }
            )
        }
        let normalized =
            publicKey.count == 64
            ? publicKey.lowercased()
            : NostrPublicKey.parse(publicKey)?.hexString
        guard let normalized else { return nil }
        return contactsByPublicKey?[normalized]
    }

    public func group(id: String, snapshot: TaskifySnapshot) -> NostrGroupConversation? {
        if groupsByID == nil {
            groupsByID = Dictionary(
                (snapshot.nostrGroupConversations ?? []).map {
                    ($0.groupID, $0)
                },
                uniquingKeysWith: { _, newest in newest }
            )
        }
        return groupsByID?[id.lowercased()]
    }

    public func visibleBoards(snapshot: TaskifySnapshot) -> [Board] {
        if let cachedVisibleBoards { return cachedVisibleBoards }
        let boards = snapshot.boards.filter(\.isVisible)
        cachedVisibleBoards = boards
        return boards
    }
}
