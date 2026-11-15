import Foundation

/// The user's task settings, as the app last saw them, for processes that edit tasks without the
/// app: the widget, Siri and Shortcuts. The app writes them to the App Group whenever they change
/// (C10-1), so an edit made outside the app counts streaks, starts weeks and places new tasks the
/// way the same edit in the app would.
public struct TaskifyDeviceTaskSettings: Codable, Equatable, Sendable {
    public var streaksEnabled: Bool
    public var weekStart: WeekdayColumn
    public var newTaskPosition: NewTaskPosition
    /// The signed-in account, recorded as the task's last editor.
    public var editorPublicKey: String?

    /// The app's defaults: streaks on, weeks starting on Sunday, new tasks at the top.
    public init(
        streaksEnabled: Bool = true,
        weekStart: WeekdayColumn = .sunday,
        newTaskPosition: NewTaskPosition = .top,
        editorPublicKey: String? = nil
    ) {
        self.streaksEnabled = streaksEnabled
        self.weekStart = weekStart
        self.newTaskPosition = newTaskPosition
        self.editorPublicKey = editorPublicKey
    }

    private static let key = "taskify.deviceTaskSettings.v1"

    /// Nil where the App Group isn't in effect (an unentitled Mac): there is nothing to share with.
    public static var sharedDefaults: UserDefaults? {
        guard TaskifySharedContainer.isAvailable() else { return nil }
        return UserDefaults(suiteName: TaskifySharedContainer.appGroupID)
    }

    public static func load(from defaults: UserDefaults? = sharedDefaults) -> TaskifyDeviceTaskSettings {
        guard let data = defaults?.data(forKey: key),
              let settings = try? JSONDecoder().decode(TaskifyDeviceTaskSettings.self, from: data) else {
            return TaskifyDeviceTaskSettings()
        }
        return settings
    }

    public static func update(
        in defaults: UserDefaults? = sharedDefaults,
        _ change: (inout TaskifyDeviceTaskSettings) -> Void
    ) {
        guard let defaults else { return }
        var settings = load(from: defaults)
        let before = settings
        change(&settings)
        guard settings != before, let data = try? JSONEncoder().encode(settings) else { return }
        defaults.set(data, forKey: key)
    }
}

public enum TaskifyExternalAddTaskError: LocalizedError, Equatable, Sendable {
    case emptyTitle
    case noAddableBoard
    case taskNotCreated
    case tooManyTasks

    public var errorDescription: String? {
        switch self {
        case .emptyTitle: "Enter a task title."
        case .noAddableBoard: "Add a board in Taskify first."
        case .taskNotCreated: "Taskify couldn't add that task."
        case .tooManyTasks:
            "You can add up to \(TaskifySpokenTaskBatchParser.maximumTaskCount) tasks at once. No tasks were added."
        }
    }
}

public struct TaskifyExternalCreatedTask: Sendable {
    public let task: TaskItem
    public let board: Board
    public let displayBoard: Board

    public init(task: TaskItem, board: Board, displayBoard: Board) {
        self.task = task
        self.board = board
        self.displayBoard = displayBoard
    }
}

/// Board changes made by an intent are persisted before the app runtime exists. Their IDs stay in
/// the App Group until `AppModel` imports and queues the corresponding board events for sync.
public enum TaskifyExternalBoardMutationStore {
    private static let key = "taskify.externalBoardMutations.v1"

    public static func markPending(_ boardID: String, defaults: UserDefaults? = sharedDefaults) {
        guard let defaults else { return }
        var ids = Set(defaults.stringArray(forKey: key) ?? [])
        ids.insert(boardID)
        defaults.set(ids.sorted(), forKey: key)
    }

    public static func pendingIDs(defaults: UserDefaults? = sharedDefaults) -> Set<String> {
        Set(defaults?.stringArray(forKey: key) ?? [])
    }

    public static func removePending(_ boardIDs: some Sequence<String>, defaults: UserDefaults? = sharedDefaults) {
        guard let defaults else { return }
        var ids = pendingIDs(defaults: defaults)
        ids.subtract(boardIDs)
        defaults.set(ids.sorted(), forKey: key)
    }

    public static var sharedDefaults: UserDefaults? {
        guard TaskifySharedContainer.isAvailable() else { return UserDefaults.standard }
        return UserDefaults(suiteName: TaskifySharedContainer.appGroupID)
    }
}

/// Calendar events written by Siri are already durable, but their Nostr event pairs can only be
/// prepared by the full app runtime. Keeping the event IDs in the App Group prevents an intent
/// process termination (or an already-running app with an older in-memory snapshot) from losing
/// the publish handoff.
public enum TaskifyExternalCalendarMutationStore {
    private static let key = "taskify.externalCalendarMutations.v1"

    public static func markPending(_ eventIDs: some Sequence<String>, defaults: UserDefaults? = sharedDefaults) {
        guard let defaults else { return }
        var ids = pendingIDs(defaults: defaults)
        ids.formUnion(eventIDs)
        defaults.set(ids.sorted(), forKey: key)
    }

    public static func pendingIDs(defaults: UserDefaults? = sharedDefaults) -> Set<String> {
        Set(defaults?.stringArray(forKey: key) ?? [])
    }

    public static func removePending(_ eventIDs: some Sequence<String>, defaults: UserDefaults? = sharedDefaults) {
        guard let defaults else { return }
        var ids = pendingIDs(defaults: defaults)
        ids.subtract(eventIDs)
        defaults.set(ids.sorted(), forKey: key)
    }

    public static var sharedDefaults: UserDefaults? {
        guard TaskifySharedContainer.isAvailable() else { return UserDefaults.standard }
        return UserDefaults(suiteName: TaskifySharedContainer.appGroupID)
    }
}

public struct TaskifyExternalCreatedEvent: Sendable {
    public let event: TaskifyEvent
    public let board: Board

    public init(event: TaskifyEvent, board: Board) {
        self.event = event
        self.board = board
    }
}

/// Task edits made outside the app (C10-1). They go through the same snapshot operations as the
/// app, with the user's settings, so the result matches the app's. The app reads them in from
/// the store later and publishes them.
public enum TaskifyExternalActions {
    /// Creates a Taskify calendar event without constructing `AppModel`. The event and any local
    /// recurrence instances are saved atomically; the app later imports their exact IDs and
    /// publishes the non-generated records.
    public static func createCalendarEvent(
        title: String,
        startDate: Date,
        endDate: Date?,
        isAllDay: Bool,
        boardID: String,
        details: String = "",
        location: String? = nil,
        recurrence: TaskRecurrence? = nil,
        store: JSONTaskStore = JSONTaskStore(),
        settings: TaskifyDeviceTaskSettings = .load()
    ) async throws -> TaskifyExternalCreatedEvent {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { throw TaskifyExternalAddTaskError.emptyTitle }
        var snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        guard let board = snapshot.boards.first(where: {
            $0.id == boardID && $0.isVisible && ($0.kind == .week || $0.kind == .list)
        }) else {
            throw TaskifyExternalAddTaskError.noAddableBoard
        }
        let columnID: String?
        switch board.kind {
        case .week:
            columnID = nil
        case .list:
            guard let firstColumn = board.columns.sorted(by: { $0.order < $1.order }).first else {
                throw TaskifyExternalAddTaskError.noAddableBoard
            }
            columnID = firstColumn.id
        case .compound, .bible:
            throw TaskifyExternalAddTaskError.noAddableBoard
        }

        let eventID = UUID().uuidString
        let resolvedEnd = isAllDay
            ? max(startDate, endDate ?? startDate)
            : ((endDate ?? startDate.addingTimeInterval(60 * 60)) > startDate
                ? (endDate ?? startDate.addingTimeInterval(60 * 60))
                : startDate.addingTimeInterval(60 * 60))
        let normalizedRecurrence = recurrence?.isActive == true ? recurrence : nil
        let editor = settings.editorPublicKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedLocation = location?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let event = TaskifyEvent(
            id: eventID,
            boardID: board.id,
            columnID: columnID,
            order: (snapshot.taskifyEvents ?? [])
                .filter { $0.boardID == board.id }
                .compactMap(\.order)
                .max()
                .map { $0 + 1 } ?? 0,
            title: trimmedTitle,
            details: trimmedDetails.isEmpty ? nil : trimmedDetails,
            locations: trimmedLocation.isEmpty ? nil : [trimmedLocation],
            schedule: isAllDay ? .date : .time,
            startDateValue: isAllDay ? calendarDateValue(startDate) : nil,
            endDateValue: isAllDay ? calendarDateValue(resolvedEnd) : nil,
            startISO: isAllDay ? nil : calendarISOValue(startDate),
            endISO: isAllDay ? nil : calendarISOValue(resolvedEnd),
            startTimeZoneID: isAllDay ? nil : TimeZone.current.identifier,
            endTimeZoneID: isAllDay ? nil : TimeZone.current.identifier,
            recurrence: normalizedRecurrence,
            seriesID: normalizedRecurrence == nil ? nil : eventID,
            createdBy: editor?.isEmpty == false ? editor : nil,
            lastEditedBy: editor?.isEmpty == false ? editor : nil,
            canonicalAddress: "",
            viewAddress: "",
            eventKey: TaskifyCalendarEventCodec.generateEventKey(),
            inviteToken: "",
            relayURLs: board.syncRelayURLs,
            rsvpStatus: .accepted,
            readOnly: false,
            deleted: false
        )
        _ = snapshot.upsertTaskifyEvent(event)
        let seriesChanges = snapshot.rebuildTaskifyEventSeries(
            seedID: eventID,
            editorPublicKey: editor?.isEmpty == false ? editor : nil
        )
        let changedIDs = Array(Set([eventID] + seriesChanges.allEventIDs))
        try await store.save(snapshot)
        TaskifyExternalCalendarMutationStore.markPending(changedIDs)
        guard let saved = snapshot.taskifyEvents?.first(where: { $0.id == eventID }) else {
            throw TaskifyExternalAddTaskError.taskNotCreated
        }
        return TaskifyExternalCreatedEvent(event: saved, board: board)
    }

    private static func calendarDateValue(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    private static func calendarISOValue(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    /// Creates a standard Taskify list board and leaves a durable handoff for the app to publish.
    public static func createListBoard(
        name: String,
        store: JSONTaskStore = JSONTaskStore(),
        now: Date = Date()
    ) async throws -> Board {
        var snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        guard let board = snapshot.createListBoard(name: name, now: now) else {
            throw TaskifyExternalAddTaskError.taskNotCreated
        }
        try await store.save(snapshot)
        TaskifyExternalBoardMutationStore.markPending(board.id)
        return board
    }

    /// Adds a column to a list board and leaves the same durable board-sync handoff.
    public static func createListSection(
        name: String,
        boardID: String,
        store: JSONTaskStore = JSONTaskStore()
    ) async throws -> (board: Board, column: BoardColumn) {
        var snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        guard let column = snapshot.addListColumn(boardID: boardID, name: name),
              let board = snapshot.boards.first(where: { $0.id == boardID }) else {
            throw TaskifyExternalAddTaskError.noAddableBoard
        }
        try await store.save(snapshot)
        TaskifyExternalBoardMutationStore.markPending(board.id)
        return (board, column)
    }

    /// Adds a task without constructing the app runtime, then durably marks and publishes it.
    ///
    /// `dueTimeEnabled` keeps the time of `dueDate` (otherwise only its day counts), and
    /// `reminders` are stored as the task's own, so the app notifies for them like any other.
    public static func addTask(
        title: String,
        requestedBoardName: String?,
        requestedBoardID: String? = nil,
        requestedColumnID: String? = nil,
        note: String = "",
        dueDate: Date? = nil,
        dueTimeEnabled: Bool = false,
        reminders: [TaskReminder] = [],
        recurrence: TaskRecurrence? = nil,
        priority: TaskPriority? = nil,
        interpretNaturalLanguageTitle: Bool = false,
        store: JSONTaskStore = JSONTaskStore(),
        settings: TaskifyDeviceTaskSettings = .load(),
        publisher: TaskifyExternalPublisher = TaskifyExternalPublisher(),
        now: Date = Date()
    ) async throws -> TaskifyExternalCreatedTask {
        // Adding a title never needs to materialize existing photos or documents. Keeping their
        // file references avoids a large, unnecessary memory spike in Siri's process.
        var snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        let spokenRequest = interpretNaturalLanguageTitle
            ? TaskifySpokenTaskRequestParser.parse(
                title,
                explicitlyRequestedBoardName: requestedBoardName,
                visibleBoardNames: TaskifyAddTaskDestination.namedBoards(in: snapshot).map(\.name)
            )
            : TaskifySpokenTaskRequest(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                requestedBoardName: requestedBoardName
            )
        let created = try createTask(
            in: &snapshot,
            request: spokenRequest,
            requestedBoardID: requestedBoardID,
            requestedColumnID: requestedColumnID,
            note: note,
            dueDate: dueDate,
            dueTimeEnabled: dueTimeEnabled,
            reminders: reminders,
            recurrence: recurrence,
            priority: priority,
            settings: settings,
            now: now
        )
        try await commit(
            snapshot,
            changedTaskIDs: [created.task.id],
            store: store,
            publisher: publisher,
            now: Int(now.timeIntervalSince1970)
        )
        return created
    }

    /// Adds every title Siri captured in one request with one load, one durable save, and one
    /// bounded relay-publish attempt. This avoids the repeated intent launches Siri otherwise
    /// needs for a list of tasks and prevents one successful item from being lost if a later
    /// invocation is interrupted.
    public static func addTasks(
        spokenRequest: String,
        requestedBoardName: String?,
        store: JSONTaskStore = JSONTaskStore(),
        settings: TaskifyDeviceTaskSettings = .load(),
        publisher: TaskifyExternalPublisher = TaskifyExternalPublisher(),
        now: Date = Date()
    ) async throws -> [TaskifyExternalCreatedTask] {
        var snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        let batch = TaskifySpokenTaskBatchParser.parse(
            spokenRequest,
            explicitlyRequestedBoardName: requestedBoardName,
            visibleBoardNames: TaskifyAddTaskDestination.namedBoards(in: snapshot).map(\.name)
        )
        guard !batch.titles.isEmpty else { throw TaskifyExternalAddTaskError.emptyTitle }
        guard batch.omittedCount == 0 else { throw TaskifyExternalAddTaskError.tooManyTasks }

        // Inserting each item at the top would otherwise reverse the dictated list on the board.
        // Create top-positioned batches back-to-front, then restore the caller-facing order.
        let creationTitles = settings.newTaskPosition == .top
            ? Array(batch.titles.reversed())
            : batch.titles
        var created = try creationTitles.map { title in
            try createTask(
                in: &snapshot,
                request: TaskifySpokenTaskRequest(
                    title: title,
                    requestedBoardName: batch.requestedBoardName
                ),
                settings: settings,
                now: now
            )
        }
        if settings.newTaskPosition == .top {
            created.reverse()
        }
        try await commit(
            snapshot,
            changedTaskIDs: created.map(\.task.id),
            store: store,
            publisher: publisher,
            now: Int(now.timeIntervalSince1970)
        )
        return created
    }

    private static func createTask(
        in snapshot: inout TaskifySnapshot,
        request: TaskifySpokenTaskRequest,
        requestedBoardID: String? = nil,
        requestedColumnID: String? = nil,
        note: String = "",
        dueDate: Date? = nil,
        dueTimeEnabled: Bool = false,
        reminders: [TaskReminder] = [],
        recurrence: TaskRecurrence? = nil,
        priority: TaskPriority? = nil,
        settings: TaskifyDeviceTaskSettings,
        now: Date
    ) throws -> TaskifyExternalCreatedTask {
        let trimmedTitle = request.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { throw TaskifyExternalAddTaskError.emptyTitle }
        let destination = requestedBoardID.flatMap {
            TaskifyAddTaskDestination.resolve(
                in: snapshot,
                requestedBoardID: $0,
                requestedColumnID: requestedColumnID,
                now: now
            )
        } ?? (requestedBoardID == nil
            ? TaskifyAddTaskDestination.resolve(
                in: snapshot,
                requestedBoardName: request.requestedBoardName,
                now: now
            )
            : nil)
        guard let destination else {
            throw TaskifyExternalAddTaskError.noAddableBoard
        }
        // A week board files a dated task under its day, as the app's own editor does; the
        // destination's column is only today's.
        var columnID = destination.columnID
        if let dueDate,
           snapshot.boards.first(where: { $0.id == destination.boardID })?.kind == .week {
            columnID = WeekdayColumn.containing(dueDate).rawValue
        }
        guard var task = snapshot.addTask(
            title: trimmedTitle,
            boardID: destination.boardID,
            columnID: columnID,
            dueDate: dueDate ?? destination.dueDate,
            note: note,
            priority: priority,
            authorPublicKey: settings.editorPublicKey,
            newTaskPosition: settings.newTaskPosition,
            now: now,
            weekStartsOn: settings.weekStart
        ) else {
            throw TaskifyExternalAddTaskError.taskNotCreated
        }
        let timed = dueTimeEnabled && task.dueDate != nil
        if timed || recurrence != nil || (!reminders.isEmpty && task.dueDate != nil) {
            // The same two steps as a dictated task: add, then set the time and reminders.
            guard snapshot.updateTask(
                taskID: task.id,
                title: task.title,
                note: task.note,
                dueDate: task.dueDate,
                dueDateEnabled: true,
                dueTimeEnabled: timed,
                dueTimeZone: timed ? TimeZone.current.identifier : nil,
                priority: task.priority,
                columnID: task.columnID,
                subtasks: [],
                recurrence: recurrence,
                reminders: reminders,
                editorPublicKey: settings.editorPublicKey,
                weekStartsOn: settings.weekStart,
                now: now
            ), let updated = snapshot.tasks.first(where: { $0.id == task.id }) else {
                throw TaskifyExternalAddTaskError.taskNotCreated
            }
            task = updated
        }
        guard let board = snapshot.boards.first(where: { $0.id == task.boardID }) else {
            throw TaskifyExternalAddTaskError.taskNotCreated
        }
        let displayBoard = requestedBoardID == nil
            ? TaskifyAddTaskDestination.displayBoard(
                for: board,
                requestedBoardName: request.requestedBoardName,
                in: snapshot
            )
            : TaskifyAddTaskDestination.displayBoard(
                for: board,
                requestedBoardID: requestedBoardID,
                in: snapshot
            )
        return TaskifyExternalCreatedTask(task: task, board: board, displayBoard: displayBoard)
    }

    /// Marks a task complete or incomplete. Does nothing when it already is: a widget drawn
    /// before the task was completed elsewhere must not reopen it. Returns whether it changed.
    @discardableResult
    public static func setCompleted(
        _ completed: Bool,
        taskID: String,
        in snapshot: inout TaskifySnapshot,
        settings: TaskifyDeviceTaskSettings,
        now: Date = Date()
    ) -> Bool {
        guard let task = snapshot.tasks.first(where: { $0.id == taskID && !$0.isDeleted }),
              task.completed != completed else { return false }
        return snapshot.toggleCompletion(
            taskID: taskID,
            editorPublicKey: settings.editorPublicKey,
            streaksEnabled: settings.streaksEnabled,
            weekStartsOn: settings.weekStart,
            now: now
        )
    }

    /// Loads the tasks, completes one, saves and publishes (`commit`). Returns whether anything
    /// changed.
    @discardableResult
    public static func completeTask(
        _ taskID: String,
        store: JSONTaskStore = JSONTaskStore(),
        settings: TaskifyDeviceTaskSettings = .load(),
        publisher: TaskifyExternalPublisher = TaskifyExternalPublisher(),
        preserveAttachmentReferences: Bool = false,
        now: Date = Date()
    ) async throws -> Bool {
        // Immediate publishing needs materialized attachments. Memory-constrained intents can
        // preserve references and pass a disabled publisher; the durable pending mark lets the
        // app materialize and publish the task on its next normal load.
        var snapshot: TaskifySnapshot
        if preserveAttachmentReferences {
            snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        } else {
            snapshot = try await store.load(areas: [.tasks])
        }
        let before = Set(snapshot.tasks.lazy.filter { !$0.isDeleted }.map(\.id))
        guard setCompleted(true, taskID: taskID, in: &snapshot, settings: settings, now: now) else {
            return false
        }
        // The task, and the next occurrence its completion created.
        let changed = [taskID] + snapshot.tasks.filter { !$0.isDeleted && !before.contains($0.id) }.map(\.id)
        try await commit(snapshot, changedTaskIDs: changed, store: store, publisher: publisher)
        return true
    }

    /// Deletes a set of tasks in one durable transaction. Siri uses the reference-preserving
    /// path and a disabled publisher; the app later materializes any attachments and publishes
    /// the stamped tombstones without risking an intent-process memory spike.
    @discardableResult
    public static func deleteTasks(
        _ taskIDs: [String],
        store: JSONTaskStore = JSONTaskStore(),
        settings: TaskifyDeviceTaskSettings = .load(),
        publisher: TaskifyExternalPublisher = TaskifyExternalPublisher(),
        preserveAttachmentReferences: Bool = false,
        now: Date = Date()
    ) async throws -> Int {
        let uniqueIDs = Array(Set(taskIDs))
        guard !uniqueIDs.isEmpty else { return 0 }
        var snapshot: TaskifySnapshot
        if preserveAttachmentReferences {
            snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        } else {
            snapshot = try await store.load(areas: [.tasks])
        }
        let deletedIDs = uniqueIDs.filter {
            snapshot.deleteTask(taskID: $0, editorPublicKey: settings.editorPublicKey)
        }
        guard !deletedIDs.isEmpty else { return 0 }
        try await commit(
            snapshot,
            changedTaskIDs: deletedIDs,
            store: store,
            publisher: publisher,
            now: Int(now.timeIntervalSince1970)
        )
        return deletedIDs.count
    }

    /// Saves an edit made outside the app and sends it to the relays at once (C10-4).
    ///
    /// The changed tasks are stamped for publishing (`TaskPublishPlanner`) and saved with their
    /// pending marks before any network work, so the store is the durable record. The publisher
    /// then tries the boards' relays for a few seconds. A task whose event every relay accepted
    /// loses its mark; any other keeps it, and the app publishes it when it next runs, as it does
    /// for its own interrupted publishes. `snapshot` must come from `store.load` or
    /// `store.loadPreservingAttachmentReferences`.
    public static func commit(
        _ snapshot: TaskifySnapshot,
        changedTaskIDs: [String],
        store: JSONTaskStore,
        publisher: TaskifyExternalPublisher = TaskifyExternalPublisher(),
        now: Int = Int(Date().timeIntervalSince1970)
    ) async throws {
        var snapshot = snapshot
        let stamps = TaskPublishPlanner.stamp(&snapshot, taskIDs: changedTaskIDs, now: now)
        try await store.save(snapshot)
        guard !stamps.isEmpty else { return }

        let sent = await publisher.publish(stamps)
        guard !sent.isEmpty else { return }
        // Read again: the app may have saved while the relays answered. Only the stamped
        // versions are marked, so its newer edits are kept.
        var current = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        TaskPublishPlanner.markQueued(
            &current,
            stamps: stamps.filter { sent[$0.task.id] != nil },
            events: sent
        )
        try await store.save(current)
    }
}

/// Sends task events from outside the app (C10-4), within a short time limit.
public struct TaskifyExternalPublisher: Sendable {
    /// Sends `event` to `relay`; true when the relay accepted it.
    public typealias Send = @Sendable (_ event: NostrEvent, _ relay: String) async -> Bool
    /// Signs a stamped task's event, with any proof of work its relays ask for.
    public typealias Prepare = @Sendable (_ stamp: TaskPublishStamp) async throws -> NostrEvent

    private let send: Send
    private let prepare: Prepare
    private let timeLimit: Duration

    public init(timeLimit: Duration = .seconds(6), prepare: Prepare? = nil, send: Send? = nil) {
        self.timeLimit = timeLimit
        self.prepare = prepare ?? { stamp in
            try await TaskEventCodec.prepareTaskEvent(task: stamp.task, board: stamp.board, createdAt: stamp.timestamp)
        }
        self.send = send ?? Self.sendToRelay
    }

    /// Never sends: the edit waits in the store for the app.
    public static let disabled = TaskifyExternalPublisher(timeLimit: .zero, send: { _, _ in false })

    /// Task id -> the event every one of its board's relays accepted within the time limit.
    public func publish(_ stamps: [TaskPublishStamp]) async -> [String: NostrEvent] {
        guard timeLimit > .zero else { return [:] }
        let send = send, prepare = prepare
        let sent = SentEvents()
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await withTaskGroup(of: Void.self) { tasks in
                    for stamp in stamps {
                        tasks.addTask {
                            guard let event = try? await prepare(stamp) else { return }
                            let relays = stamp.board.syncRelayURLs
                            let accepted = await withTaskGroup(of: Bool.self) { sends in
                                for relay in relays { sends.addTask { await send(event, relay) } }
                                var all = !relays.isEmpty
                                for await ok in sends { all = all && ok }
                                return all
                            }
                            // An answer after the time limit is not trusted: the app sends it again.
                            if accepted, !Task.isCancelled { await sent.add(event, for: stamp.task.id) }
                        }
                    }
                }
            }
            let timeLimit = timeLimit
            group.addTask { try? await Task.sleep(for: timeLimit) }
            // Whichever finishes first: every send, or the time limit.
            await group.next()
            group.cancelAll()
        }
        return await sent.events
    }

    private actor SentEvents {
        private(set) var events: [String: NostrEvent] = [:]
        func add(_ event: NostrEvent, for taskID: String) { events[taskID] = event }
    }

    /// One connection per relay; a duplicate counts as accepted. A relay that asks for
    /// authentication is left to the app, which signs in with the account key.
    @Sendable
    static func sendToRelay(_ event: NostrEvent, relay: String) async -> Bool {
        let connection = NostrRelayConnection(relayURL: relay, automaticallyAuthenticate: false)
        defer { Task { await connection.disconnect() } }
        do {
            try await connection.connect()
            try await connection.publish(event)
            for await message in connection.messages() {
                if Task.isCancelled { return false }
                switch message {
                case .acknowledgement(let id, let accepted, let message) where id == event.id:
                    return accepted || message.lowercased().hasPrefix("duplicate:")
                case .disconnected:
                    return false
                default:
                    continue
                }
            }
        } catch {}
        return false
    }
}
