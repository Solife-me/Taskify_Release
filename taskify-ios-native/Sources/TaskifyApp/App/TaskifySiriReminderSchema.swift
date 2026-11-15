import AppIntents
import Foundation
import GeoToolbox
import TaskifyCore

// App Shortcut phrases remain the compatibility path for iOS 17–26 and macOS 14–26. Starting in
// iOS 27 and macOS 27, Siri's conversational task routing uses the reminders App Schema to
// determine which installed apps can actually create a task. These schema-backed shadow entities
// describe Taskify's boards and tasks without coupling the intent process to AppModel or opening
// relay connections. A reminder created here keeps its time and reminds at it, like one created
// with `TaskifyRemindMeIntent`.
//
// Not in the Mac UITest build: these queries read the account's real store, which that build
// keeps isolated.
#if os(iOS) || (TASKIFY_MAC_SHORTCUTS && !TASKIFY_MAC_UI_TEST)

@available(iOS 27.0, macOS 27.0, *)
@AppEnum(schema: .reminders.listType)
enum TaskifySiriListType: String {
    case standard

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .standard: "Standard"
    ]
}

@available(iOS 27.0, macOS 27.0, *)
@AppEnum(schema: .reminders.locationTriggerEvent)
enum TaskifySiriLocationTriggerEvent: String {
    case arrive
    case depart

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .arrive: "Arrive",
        .depart: "Depart"
    ]
}

@available(iOS 27.0, macOS 27.0, *)
@AppEntity(schema: .reminders.list)
struct TaskifySiriBoardEntity {
    static let defaultQuery = BoardQuery()

    let id: String
    var name: String
    var type: TaskifySiriListType

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(id: String, name: String, type: TaskifySiriListType = .standard) {
        self.id = id
        self.name = name
        self.type = type
    }

    init(board: Board) {
        self.init(id: board.id, name: board.name)
    }

    struct BoardQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifySiriBoardEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            let boards = TaskifyAddTaskDestination.namedBoards(in: snapshot)
            return identifiers.compactMap { identifier in
                boards.first(where: { $0.id == identifier }).map(TaskifySiriBoardEntity.init)
            }
        }

        func entities(matching string: String) async throws -> [TaskifySiriBoardEntity] {
            let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return try await addableBoards().filter {
                needle.isEmpty ||
                    $0.name.localizedCaseInsensitiveContains(needle) ||
                    needle.localizedCaseInsensitiveContains($0.name)
            }
        }

        func suggestedEntities() async throws -> [TaskifySiriBoardEntity] {
            try await addableBoards()
        }

        private func addableBoards() async throws -> [TaskifySiriBoardEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return TaskifyAddTaskDestination.namedBoards(in: snapshot)
                .map(TaskifySiriBoardEntity.init)
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppEntity(schema: .reminders.section)
struct TaskifySiriSectionEntity {
    static let defaultQuery = SectionQuery()

    let id: String
    var name: String
    var list: TaskifySiriBoardEntity

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(list.name)")
    }

    init(id: String, name: String, list: TaskifySiriBoardEntity) {
        self.id = id
        self.name = name
        self.list = list
    }

    struct SectionQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifySiriSectionEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return identifiers.compactMap { identifier in
                guard let (boardID, columnID) = Self.components(from: identifier) else { return nil }
                guard let board = snapshot.boards.first(where: { $0.id == boardID }),
                      let column = board.columns.first(where: { $0.id == columnID }) else { return nil }
                return TaskifySiriSectionEntity(
                    id: identifier,
                    name: column.name,
                    list: TaskifySiriBoardEntity(board: board)
                )
            }
        }

        func entities(matching string: String) async throws -> [TaskifySiriSectionEntity] {
            let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return try await suggestedEntities().filter {
                needle.isEmpty || $0.name.localizedCaseInsensitiveContains(needle)
            }
        }

        func suggestedEntities() async throws -> [TaskifySiriSectionEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return TaskifyAddTaskDestination.namedBoards(in: snapshot).flatMap { board in
                let list = TaskifySiriBoardEntity(board: board)
                return board.columns.map { column in
                    TaskifySiriSectionEntity(
                        id: Self.identifier(boardID: board.id, columnID: column.id),
                        name: column.name,
                        list: list
                    )
                }
            }
        }

        private static let separator = "::taskify-section::"

        static func identifier(boardID: String, columnID: String) -> String {
            boardID + separator + columnID
        }

        static func components(from identifier: String) -> (boardID: String, columnID: String)? {
            guard let separator = identifier.range(of: Self.separator) else { return nil }
            return (
                String(identifier[..<separator.lowerBound]),
                String(identifier[separator.upperBound...])
            )
        }

        static func columnID(from identifier: String) -> String? {
            components(from: identifier)?.columnID
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppEntity(schema: .reminders.locationTrigger)
struct TaskifySiriLocationTriggerEntity {
    static let defaultQuery = LocationQuery()

    let id: String
    var place: GeoToolbox.PlaceDescriptor
    var event: TaskifySiriLocationTriggerEvent

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Task location")
    }

    struct LocationQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifySiriLocationTriggerEntity] {
            // Taskify doesn't currently store location triggers. The type is present because the
            // system create-reminder schema permits one, but it intentionally resolves no values.
            []
        }

        func entities(matching string: String) async throws -> [TaskifySiriLocationTriggerEntity] {
            []
        }

        func suggestedEntities() async throws -> [TaskifySiriLocationTriggerEntity] {
            []
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppEntity(schema: .reminders.reminder)
struct TaskifySiriTaskEntity {
    static let defaultQuery = SiriTaskQuery()

    let id: String
    var title: String
    var note: AttributedString?
    var images: [IntentFile]
    var subtasks: [TaskifySiriTaskEntity]
    var tags: Set<String>
    var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var isCompleted: Bool
    var isFlagged: Bool?
    var creationDate: Date?
    var completionDate: Date?
    var list: TaskifySiriBoardEntity
    var section: TaskifySiriSectionEntity?
    var locationTrigger: TaskifySiriLocationTriggerEntity?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(list.name)")
    }

    init(task: TaskItem, board: Board, displayBoard: Board? = nil) {
        let taskID = task.id
        let taskTitle = task.title
        let taskNote = task.note
        let taskDueDate = task.dueDate
        let taskHasDueTime = task.dueTimeEnabled
        let taskCompleted = task.completed
        let taskPriority = task.priority
        let taskCreatedAt = task.createdAt
        let taskCompletedAt = task.completedAt
        let representedBoard = displayBoard ?? board
        let boardEntity = TaskifySiriBoardEntity(board: representedBoard)
        let sectionEntity: TaskifySiriSectionEntity?
        if representedBoard.id == board.id,
           let columnID = task.columnID,
           let column = board.columns.first(where: { $0.id == columnID }) {
            sectionEntity = TaskifySiriSectionEntity(
                id: TaskifySiriSectionEntity.SectionQuery.identifier(
                    boardID: board.id,
                    columnID: column.id
                ),
                name: column.name,
                list: boardEntity
            )
        } else {
            sectionEntity = nil
        }

        id = taskID
        images = []
        subtasks = []
        title = taskTitle
        note = taskNote.isEmpty ? nil : AttributedString(taskNote)
        tags = []
        urls = []
        dueDate = taskDueDate.map {
            Self.dateComponents(from: $0, includesTime: taskHasDueTime)
        }
        recurrence = TaskifySiriRecurrence.calendarRule(
            from: task.recurrence,
            startDate: taskDueDate
        )
        isCompleted = taskCompleted
        isFlagged = taskPriority == .high
        creationDate = taskCreatedAt
        completionDate = taskCompletedAt
        list = boardEntity
        section = sectionEntity
        locationTrigger = nil
    }

    private static func dateComponents(from date: Date, includesTime: Bool) -> DateComponents {
        let components: Set<Calendar.Component> = includesTime
            ? [.calendar, .timeZone, .year, .month, .day, .hour, .minute, .second]
            : [.calendar, .timeZone, .year, .month, .day]
        return Calendar.current.dateComponents(components, from: date)
    }

    struct SiriTaskQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifySiriTaskEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return identifiers.compactMap { identifier in
                guard let task = snapshot.tasks.first(where: {
                    $0.id == identifier && $0.deleted != true
                }), let board = snapshot.boards.first(where: { $0.id == task.boardID }) else {
                    return nil
                }
                let displayBoard = TaskifyIntentBoardPresentation.board(
                    for: board,
                    requestedBoardName: nil,
                    in: snapshot
                )
                return TaskifySiriTaskEntity(
                    task: task,
                    board: board,
                    displayBoard: displayBoard
                )
            }
        }

        func entities(matching string: String) async throws -> [TaskifySiriTaskEntity] {
            let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return Self.entities(in: snapshot, matching: needle)
        }

        func suggestedEntities() async throws -> [TaskifySiriTaskEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return Self.entities(in: snapshot, matching: "")
        }

        private static func entities(
            in snapshot: TaskifySnapshot,
            matching needle: String
        ) -> [TaskifySiriTaskEntity] {
            return snapshot.tasks
                .filter {
                    !$0.isDeleted && !$0.completed && (
                        needle.isEmpty || $0.title.localizedCaseInsensitiveContains(needle)
                    )
                }
                .sorted { $0.createdAt > $1.createdAt }
                .prefix(100)
                .compactMap { task in
                    guard let board = snapshot.boards.first(where: { $0.id == task.boardID }) else {
                        return nil
                    }
                    let displayBoard = TaskifyIntentBoardPresentation.board(
                        for: board,
                        requestedBoardName: nil,
                        in: snapshot
                    )
                    return TaskifySiriTaskEntity(
                        task: task,
                        board: board,
                        displayBoard: displayBoard
                    )
                }
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppIntent(schema: .reminders.createReminder)
struct TaskifyCreateReminderIntent {
    var title: String
    var list: TaskifySiriBoardEntity?
    var note: AttributedString?
    var isFlagged: Bool?
    var images: [IntentFile]
    var tags: Set<String>
    var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var locationTrigger: TaskifySiriLocationTriggerEntity?
    var section: TaskifySiriSectionEntity?

    func perform() async throws -> some ReturnsValue<TaskifySiriTaskEntity> & ProvidesDialog {
        // A reminder's due date is when it goes off, as in Apple's Reminders: a time reminds at
        // that time, a day alone reminds on the day at the task's reminder time.
        let due = dueDate.flatMap(TaskifySiriDueDate.init)
        let requestedList = section?.list ?? list
        let taskRecurrence: TaskRecurrence?
        if let recurrence {
            guard due != nil else { throw TaskifySiriSchemaError.recurrenceNeedsDueDate }
            guard let converted = TaskifySiriRecurrence.taskRecurrence(
                from: recurrence,
                startDate: due?.date
            ) else {
                throw TaskifySiriSchemaError.unsupportedRecurrence
            }
            taskRecurrence = converted
        } else {
            taskRecurrence = nil
        }
        let created = try await TaskifyIntentTaskWriter.addTask(
            title: title,
            requestedBoardName: requestedList?.name,
            requestedBoardID: requestedList?.id,
            requestedColumnID: section.flatMap {
                TaskifySiriSectionEntity.SectionQuery.columnID(from: $0.id)
            },
            note: note.map { String($0.characters) } ?? "",
            dueDate: due?.date,
            dueTimeEnabled: due?.hasTime ?? false,
            reminders: due.map { [$0.reminder] } ?? [],
            recurrence: taskRecurrence,
            priority: isFlagged == true ? .high : nil
        )
        let canNotify = await TaskifyIntentTaskWriter.scheduleReminders(for: created.task)
        return .result(
            value: TaskifySiriTaskEntity(
                task: created.task,
                board: created.board,
                displayBoard: created.displayBoard
            ),
            dialog: TaskifyIntentReminderWriter.dialog(for: created, canNotify: canNotify, now: Date())
        )
    }
}

/// A due date as the reminders schema gives it: date components, with or without a time.
@available(iOS 27.0, macOS 27.0, *)
struct TaskifySiriDueDate {
    let date: Date
    let hasTime: Bool

    init?(_ components: DateComponents) {
        var calendar = components.calendar ?? Calendar.current
        if let timeZone = components.timeZone {
            calendar.timeZone = timeZone
        }
        guard let date = calendar.date(from: components) else { return nil }
        self.date = date
        hasTime = components.hour != nil || components.minute != nil || components.second != nil
    }

    var reminder: TaskReminder {
        TaskReminder(minutesBefore: 0, dateOnly: !hasTime)
    }
}

@available(iOS 27.0, macOS 27.0, *)
enum TaskifySiriRecurrence {
    static func taskRecurrence(
        from rule: Calendar.RecurrenceRule,
        startDate: Date?
    ) -> TaskRecurrence? {
        let interval = max(1, rule.interval)
        let until = rule.end.date
        switch rule.frequency {
        case .hourly:
            return .every(interval, .hour, until: until)
        case .daily:
            return interval == 1 ? .daily(until: until) : .every(interval, .day, until: until)
        case .weekly:
            let days = rule.weekdays.compactMap(taskifyWeekday)
            if interval == 1, !days.isEmpty {
                return .weekly(days: Array(Set(days)).sorted(), until: until)
            }
            // An interval anchored to the task's due date preserves one selected weekday. The
            // Taskify model cannot faithfully represent multiple weekdays every N weeks.
            guard days.count <= 1 else { return nil }
            return .every(interval, .week, until: until)
        case .monthly:
            let fallbackDay = startDate.map { rule.calendar.component(.day, from: $0) }
            guard let day = rule.daysOfTheMonth.first ?? fallbackDay else { return nil }
            return .monthlyDay(day: min(max(day, 1), 28), interval: interval, until: until)
        case .minutely, .yearly:
            return nil
        @unknown default:
            return nil
        }
    }

    static func calendarRule(
        from recurrence: TaskRecurrence?,
        startDate: Date?
    ) -> Calendar.RecurrenceRule? {
        guard let recurrence, recurrence.isActive else { return nil }
        let calendar = Calendar.current
        let end = recurrence.untilDate.map(Calendar.RecurrenceRule.End.afterDate) ?? .never
        switch recurrence {
        case .none:
            return nil
        case .daily:
            return .daily(calendar: calendar, end: end)
        case .weekly(let days, _):
            return .weekly(
                calendar: calendar,
                end: end,
                weekdays: days.compactMap(calendarWeekday).map(Calendar.RecurrenceRule.Weekday.every)
            )
        case .every(let rawInterval, let unit, _):
            let interval = max(1, rawInterval)
            switch unit {
            case .hour:
                return .hourly(calendar: calendar, interval: interval, end: end)
            case .day:
                return .daily(calendar: calendar, interval: interval, end: end)
            case .week:
                let weekday = startDate
                    .map { calendar.component(.weekday, from: $0) - 1 }
                    .flatMap(calendarWeekday)
                return .weekly(
                    calendar: calendar,
                    interval: interval,
                    end: end,
                    weekdays: weekday.map { [.every($0)] } ?? []
                )
            }
        case .monthlyDay(let rawDay, let rawInterval, _):
            return .monthly(
                calendar: calendar,
                interval: max(1, rawInterval ?? 1),
                end: end,
                daysOfTheMonth: [min(max(rawDay, 1), 28)]
            )
        }
    }

    private static func taskifyWeekday(_ weekday: Calendar.RecurrenceRule.Weekday) -> Int? {
        guard case .every(let day) = weekday else { return nil }
        return switch day {
        case .sunday: 0
        case .monday: 1
        case .tuesday: 2
        case .wednesday: 3
        case .thursday: 4
        case .friday: 5
        case .saturday: 6
        @unknown default: nil
        }
    }

    private static func calendarWeekday(_ day: Int) -> Locale.Weekday? {
        switch day {
        case 0: .sunday
        case 1: .monday
        case 2: .tuesday
        case 3: .wednesday
        case 4: .thursday
        case 5: .friday
        case 6: .saturday
        default: nil
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
enum TaskifySiriSchemaError: LocalizedError {
    case recurrenceNeedsDueDate
    case unsupportedRecurrence

    var errorDescription: String? {
        switch self {
        case .recurrenceNeedsDueDate:
            "Choose a due date before making the Taskify task repeat."
        case .unsupportedRecurrence:
            "Taskify supports hourly, daily, weekly, and monthly task repetition."
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppIntent(schema: .reminders.updateReminder)
struct TaskifyUpdateReminderIntent {
    var target: TaskifySiriTaskEntity
    var title: String?
    var list: TaskifySiriBoardEntity?
    var note: AttributedString?
    var isCompleted: Bool?
    var isFlagged: Bool?
    var tags: Set<String>?
    var urls: [URL]?
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var locationTrigger: TaskifySiriLocationTriggerEntity?

    func perform() async throws -> some ReturnsValue<TaskifySiriTaskEntity> & ProvidesDialog {
        let store = JSONTaskStore()
        // Preserve attachment file references while changing metadata. Publishing is deferred to
        // the app below, where a normal load can materialize those files safely.
        var snapshot = try await store.loadPreservingAttachmentReferences(areas: [.tasks])
        let existingIDs = Set(snapshot.tasks.lazy.filter { !$0.isDeleted }.map(\.id))
        guard var task = snapshot.tasks.first(where: {
            $0.id == target.id && !$0.isDeleted
        }) else {
            throw TaskifyAddTaskIntentError.taskNotCreated
        }

        var requestedListForPresentation: TaskifySiriBoardEntity?
        if case .set(let requestedList) = $list.valueState, let requestedList {
            requestedListForPresentation = requestedList
            guard let destination = TaskifyAddTaskDestination.resolve(
                in: snapshot,
                requestedBoardID: requestedList.id
            ) else {
                throw TaskifyAddTaskIntentError.noAddableBoard
            }
            if destination.boardID != task.boardID || destination.columnID != task.columnID {
                guard let columnID = destination.columnID,
                      snapshot.moveTask(
                          taskID: task.id,
                          toBoardID: destination.boardID,
                          columnID: columnID
                      ) != nil,
                      let movedTask = snapshot.tasks.first(where: { $0.id == task.id }) else {
                    throw TaskifyAddTaskIntentError.taskNotCreated
                }
                task = movedTask
            }
        }

        var updatedTitle = task.title
        if case .set(let requestedTitle) = $title.valueState {
            guard let requestedTitle,
                  !requestedTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw TaskifyAddTaskIntentError.emptyTitle
            }
            updatedTitle = requestedTitle
        }

        var updatedNote = task.note
        if case .set(let requestedNote) = $note.valueState {
            updatedNote = requestedNote.map { String($0.characters) } ?? ""
        }

        var updatedDueDate = task.dueDate
        var updatedDueDateEnabled = task.dueDateEnabled
        var updatedDueTimeEnabled = task.dueTimeEnabled
        var updatedDueTimeZone = task.dueTimeZone
        var updatedReminders = task.reminders ?? []
        var updatedReminderTime = task.reminderTime
        if case .set(let requestedComponents) = $dueDate.valueState {
            if let requestedComponents, let requestedDue = TaskifySiriDueDate(requestedComponents) {
                updatedDueDate = requestedDue.date
                updatedDueDateEnabled = true
                updatedDueTimeEnabled = requestedDue.hasTime
                updatedDueTimeZone = requestedDue.hasTime
                    ? (requestedComponents.timeZone?.identifier ?? TimeZone.current.identifier)
                    : nil
                // Setting a Reminders-style due date also asks for a notification at that date.
                updatedReminders = [requestedDue.reminder]
                updatedReminderTime = nil
            } else {
                // An explicit nil means “clear the due date”; an unset parameter preserves it.
                updatedDueDate = nil
                updatedDueDateEnabled = false
                updatedDueTimeEnabled = false
                updatedDueTimeZone = nil
                updatedReminders = []
                updatedReminderTime = nil
            }
        }

        var updatedPriority = task.priority
        if case .set(let requestedFlag) = $isFlagged.valueState {
            updatedPriority = requestedFlag == true ? .high : nil
        }

        var updatedRecurrence = task.recurrence
        if case .set(let requestedRecurrence) = $recurrence.valueState {
            if let requestedRecurrence {
                guard updatedDueDateEnabled, updatedDueDate != nil else {
                    throw TaskifySiriSchemaError.recurrenceNeedsDueDate
                }
                guard let converted = TaskifySiriRecurrence.taskRecurrence(
                    from: requestedRecurrence,
                    startDate: updatedDueDate
                ) else {
                    throw TaskifySiriSchemaError.unsupportedRecurrence
                }
                updatedRecurrence = converted
            } else {
                updatedRecurrence = nil
            }
        }

        let updated = snapshot.updateTask(
            taskID: task.id,
            title: updatedTitle,
            note: updatedNote,
            dueDate: updatedDueDate,
            dueDateEnabled: updatedDueDateEnabled,
            dueTimeEnabled: updatedDueTimeEnabled,
            dueTimeZone: updatedDueTimeZone,
            priority: updatedPriority,
            columnID: task.columnID,
            subtasks: task.subtasks ?? [],
            recurrence: updatedRecurrence,
            reminders: updatedReminders,
            reminderTime: updatedReminderTime
        )
        guard updated else { throw TaskifyAddTaskIntentError.taskNotCreated }

        if case .set(let requestedCompletion) = $isCompleted.valueState,
           let requestedCompletion,
           let current = snapshot.tasks.first(where: { $0.id == task.id }),
           current.completed != requestedCompletion {
            guard TaskifyExternalActions.setCompleted(
                requestedCompletion, taskID: task.id, in: &snapshot, settings: .load()
            ) else {
                throw TaskifyAddTaskIntentError.taskNotCreated
            }
        }

        guard let savedTask = snapshot.tasks.first(where: { $0.id == task.id }),
              let storageBoard = snapshot.boards.first(where: { $0.id == savedTask.boardID }) else {
            throw TaskifyAddTaskIntentError.taskNotCreated
        }
        let displayBoard = TaskifyAddTaskDestination.displayBoard(
            for: storageBoard,
            requestedBoardID: requestedListForPresentation?.id,
            in: snapshot
        )
        // Stamp and save now, but leave network encoding to the app. Existing attachment values
        // are file references in this lightweight snapshot and must not be published directly.
        let createdIDs = snapshot.tasks.filter { !$0.isDeleted && !existingIDs.contains($0.id) }.map(\.id)
        try await TaskifyExternalActions.commit(
            snapshot,
            changedTaskIDs: [task.id] + createdIDs,
            store: store,
            publisher: .disabled
        )
        await TaskifyIntentTaskWriter.scheduleReminders(for: savedTask)

        return .result(
            value: TaskifySiriTaskEntity(
                task: savedTask,
                board: storageBoard,
                displayBoard: displayBoard
            ),
            dialog: "Updated \"\(savedTask.title)\" in \(displayBoard.name)."
        )
    }

}

@available(iOS 27.0, macOS 27.0, *)
@AppIntent(schema: .reminders.createList)
struct TaskifyCreateReminderListIntent {
    var type: TaskifySiriListType
    var name: String

    func perform() async throws -> some ReturnsValue<TaskifySiriBoardEntity> & ProvidesDialog {
        let board = try await TaskifyExternalActions.createListBoard(name: name)
        return .result(
            value: TaskifySiriBoardEntity(board: board),
            dialog: "Created the \(board.name) board in Taskify."
        )
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppIntent(schema: .reminders.createSection)
struct TaskifyCreateReminderSectionIntent {
    var name: String
    var list: TaskifySiriBoardEntity

    func perform() async throws -> some ReturnsValue<TaskifySiriSectionEntity> & ProvidesDialog {
        let created = try await TaskifyExternalActions.createListSection(
            name: name,
            boardID: list.id
        )
        let section = TaskifySiriSectionEntity(
            id: TaskifySiriSectionEntity.SectionQuery.identifier(
                boardID: created.board.id,
                columnID: created.column.id
            ),
            name: created.column.name,
            list: TaskifySiriBoardEntity(board: created.board)
        )
        return .result(
            value: section,
            dialog: "Created the \(created.column.name) section in \(created.board.name)."
        )
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppIntent(schema: .reminders.deleteReminders)
struct TaskifyDeleteRemindersIntent: DeleteIntent {
    var entities: [TaskifySiriTaskEntity]

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let count = try await TaskifyExternalActions.deleteTasks(
            entities.map(\.id),
            publisher: .disabled,
            preserveAttachmentReferences: true
        )
        guard count > 0 else {
            return .result(dialog: "Those Taskify tasks were already removed.")
        }
        return .result(dialog: count == 1
            ? "Deleted the Taskify task."
            : "Deleted \(count) Taskify tasks.")
    }
}

#endif
