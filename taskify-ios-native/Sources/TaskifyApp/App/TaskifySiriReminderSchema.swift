import AppIntents
import Foundation
import GeoToolbox
import TaskifyCore

// App Shortcut phrases remain the compatibility path for iOS 17–26. Starting in iOS 27, Siri's
// conversational task routing uses the reminders App Schema to determine which installed apps
// can actually create a task. These schema-backed shadow entities describe Taskify's boards and
// tasks without coupling the intent process to AppModel or opening relay connections.

@available(iOS 27.0, *)
@AppEnum(schema: .reminders.listType)
enum TaskifySiriListType: String {
    case standard

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .standard: "Standard"
    ]
}

@available(iOS 27.0, *)
@AppEnum(schema: .reminders.locationTriggerEvent)
enum TaskifySiriLocationTriggerEvent: String {
    case arrive
    case depart

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .arrive: "Arrive",
        .depart: "Depart"
    ]
}

@available(iOS 27.0, *)
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
            let snapshot = try await JSONTaskStore().load()
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
            let snapshot = try await JSONTaskStore().load()
            return TaskifyAddTaskDestination.namedBoards(in: snapshot)
                .map(TaskifySiriBoardEntity.init)
        }
    }
}

@available(iOS 27.0, *)
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
            let snapshot = try await JSONTaskStore().load()
            return identifiers.compactMap { identifier in
                guard let separator = identifier.range(of: Self.separator) else { return nil }
                let boardID = String(identifier[..<separator.lowerBound])
                let columnID = String(identifier[separator.upperBound...])
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
            let snapshot = try await JSONTaskStore().load()
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
    }
}

@available(iOS 27.0, *)
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

@available(iOS 27.0, *)
@AppEntity(schema: .reminders.reminder)
struct TaskifySiriTaskEntity {
    static let defaultQuery = TaskQuery()

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
        recurrence = nil
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

    struct TaskQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifySiriTaskEntity] {
            let snapshot = try await JSONTaskStore().load()
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
            return try await suggestedEntities().filter {
                needle.isEmpty || $0.title.localizedCaseInsensitiveContains(needle)
            }
        }

        func suggestedEntities() async throws -> [TaskifySiriTaskEntity] {
            let snapshot = try await JSONTaskStore().load()
            return snapshot.tasks
                .filter { !$0.isDeleted && !$0.completed }
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

@available(iOS 27.0, *)
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
        let created = try await TaskifyIntentTaskWriter.addTask(
            title: title,
            requestedBoardName: list?.name ?? section?.list.name,
            note: note.map { String($0.characters) } ?? "",
            dueDate: dueDate.flatMap { Calendar.current.date(from: $0) },
            priority: isFlagged == true ? .high : nil
        )
        return .result(
            value: TaskifySiriTaskEntity(
                task: created.task,
                board: created.board,
                displayBoard: created.displayBoard
            ),
            dialog: "Added \"\(created.task.title)\" to \(created.displayBoard.name)."
        )
    }
}

@available(iOS 27.0, *)
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
        var snapshot = try await store.load()
        guard var task = snapshot.tasks.first(where: {
            $0.id == target.id && !$0.isDeleted
        }) else {
            throw TaskifyAddTaskIntentError.taskNotCreated
        }

        if let list {
            guard let destination = TaskifyAddTaskDestination.resolve(
                in: snapshot,
                requestedBoardName: list.name
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

        let requestedDate = dueDate.flatMap(Self.date)
        let requestedDueTime = dueDate.map(Self.includesTime)
        let updated = snapshot.updateTask(
            taskID: task.id,
            title: title ?? task.title,
            note: note.map { String($0.characters) } ?? task.note,
            dueDate: requestedDate ?? task.dueDate,
            dueDateEnabled: requestedDate != nil ? true : task.dueDateEnabled,
            dueTimeEnabled: requestedDueTime ?? task.dueTimeEnabled,
            dueTimeZone: requestedDueTime == true
                ? (dueDate?.timeZone?.identifier ?? task.dueTimeZone)
                : task.dueTimeZone,
            priority: isFlagged.map { $0 ? .high : nil } ?? task.priority,
            columnID: task.columnID,
            subtasks: task.subtasks ?? [],
            recurrence: task.recurrence,
            reminders: task.reminders ?? [],
            reminderTime: task.reminderTime
        )
        guard updated else { throw TaskifyAddTaskIntentError.taskNotCreated }

        if let isCompleted,
           let current = snapshot.tasks.first(where: { $0.id == task.id }),
           current.completed != isCompleted {
            guard snapshot.toggleCompletion(taskID: task.id) else {
                throw TaskifyAddTaskIntentError.taskNotCreated
            }
        }

        guard let savedTask = snapshot.tasks.first(where: { $0.id == task.id }),
              let storageBoard = snapshot.boards.first(where: { $0.id == savedTask.boardID }) else {
            throw TaskifyAddTaskIntentError.taskNotCreated
        }
        let displayBoard = TaskifyIntentBoardPresentation.board(
            for: storageBoard,
            requestedBoardName: list?.name,
            in: snapshot
        )
        try await store.save(snapshot)

        return .result(
            value: TaskifySiriTaskEntity(
                task: savedTask,
                board: storageBoard,
                displayBoard: displayBoard
            ),
            dialog: "Updated \"\(savedTask.title)\" in \(displayBoard.name)."
        )
    }

    private static func date(from components: DateComponents) -> Date? {
        var calendar = components.calendar ?? Calendar.current
        if let timeZone = components.timeZone {
            calendar.timeZone = timeZone
        }
        return calendar.date(from: components)
    }

    private static func includesTime(_ components: DateComponents) -> Bool {
        components.hour != nil || components.minute != nil || components.second != nil
    }
}
