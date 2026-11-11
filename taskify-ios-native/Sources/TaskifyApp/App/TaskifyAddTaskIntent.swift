import AppIntents
import CoreSpotlight
import Foundation
import TaskifyCore
import UniformTypeIdentifiers

#if os(iOS) || TASKIFY_MAC_SHORTCUTS
/// Must live in the app target, not the TaskifyCore package. App Intents defined outside the app
/// target extract into `Metadata.appintents` looking completely healthy -- correct parameters,
/// `isDiscoverable: true`, NLU phrase assets and all -- while the system still fails to load the
/// type at runtime, so Siri, Spotlight and Shortcuts behave as though the app publishes no intents
/// whatsoever. The extracted metadata gives no hint anything is wrong; the only visible symptom is
/// that nothing works. Keeping every App Intents type (this intent and `TaskifyShortcuts`) in the
/// app module sidesteps that cross-module resolution entirely.
///
/// Only the intent itself lives here. The board/column resolution logic stays in TaskifyCore as
/// `TaskifyAddTaskDestination`, where it is unit tested -- this type is a thin shell around it.
///
/// Mirrors the PWA's headless Agent Mode `createTask` command (see `window.__taskifyAgent`): a
/// no-UI way to add a task, this time surfaced through Siri, Spotlight, and the Shortcuts app
/// instead of a JS console. `perform()` intentionally never constructs `AppModel` — that type
/// eagerly opens Nostr relay connections, touches the Keychain and notification permissions, and
/// starts several long-lived background tasks on `init`, all wasted work (and a risk of being
/// killed mid-flight) for a one-shot "add a task" action that iOS may run and then immediately
/// suspend. Instead this talks to the same `JSONTaskStore`/`TaskifySnapshot` the app itself
/// persists through, doing only the minimal load → mutate → save round trip. The new task is then
/// sent to its board's relays (`TaskifyExternalActions.commit`); if they can't be reached in a few
/// seconds, the app publishes it the next time it runs.
struct TaskifyAddTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Task"
    static var description = IntentDescription(
        "Adds a task to Taskify without opening the app.",
        categoryName: "Tasks",
        searchKeywords: ["Taskify", "task", "to-do", "reminder"]
    )
    static var openAppWhenRun = false

    @Parameter(
        title: "Task Name",
        description: "The task you want to add.",
        requestValueDialog: "What task would you like to add?"
    )
    var taskTitle: String

    @Parameter(
        title: "Board",
        description: "The Taskify board to add the task to. Leave blank to use the default board."
    )
    var boardName: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$taskTitle) to Taskify") {
            \.$boardName
        }
    }

    init() {}

    init(taskTitle: String, boardName: String? = nil) {
        self.taskTitle = taskTitle
        self.boardName = boardName
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let created = try await TaskifyIntentTaskWriter.addTask(
            title: taskTitle,
            requestedBoardName: boardName,
            interpretNaturalLanguageTitle: boardName == nil
        )
        return .result(dialog: "Added \"\(created.task.title)\" to \(created.displayBoard.name).")
    }
}

/// Direct one-sentence Siri route. The entity captures the complete free-form request after the
/// literal “add” portion of the phrase; the same natural-language parser used by the prompt flow
/// then separates an optional board name from the task title.
struct TaskifyNaturalAddTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick Add Task"
    static var description = IntentDescription("Adds a named task to the current Taskify board.")
    static var openAppWhenRun = false

    @Parameter(title: "Task Name", requestValueDialog: "What task would you like to add?")
    var task: TaskifyShortcutTaskNameEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$task) to Taskify")
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let created = try await TaskifyIntentTaskWriter.addTask(
            title: "Add \(task.name)",
            requestedBoardName: nil,
            interpretNaturalLanguageTitle: true
        )
        return .result(dialog: "Added \"\(created.task.title)\" to \(created.displayBoard.name).")
    }
}

/// Captures a whole spoken list in one value, then adds every item in one transaction. Using one
/// String is intentional: when an App Intent exposes an array, Siri commonly resolves it by
/// asking for one value at a time.
struct TaskifyAddTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Multiple Tasks"
    static var description = IntentDescription(
        "Adds several tasks to Taskify from one spoken list. Separate tasks with commas, “and”, or “and then”.",
        categoryName: "Tasks",
        searchKeywords: ["Taskify", "tasks", "batch", "list", "to-do"]
    )
    static var openAppWhenRun = false

    @Parameter(
        title: "Tasks",
        description: "All tasks in one sentence, separated with commas, “and”, or “and then”.",
        requestValueDialog: "Tell me all the tasks in one sentence. Separate them with “and then”."
    )
    var taskList: String

    @Parameter(
        title: "Board",
        description: "The Taskify board to add the tasks to. Leave blank to use the default board."
    )
    var boardName: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$taskList) to Taskify") {
            \.$boardName
        }
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let created = try await TaskifyIntentTaskWriter.addTasks(
            spokenRequest: taskList,
            requestedBoardName: boardName
        )
        return .result(dialog: TaskifyIntentTaskWriter.dialog(for: created))
    }
}

/// One-sentence form of `TaskifyAddTasksIntent`; the entity lets an App Shortcut phrase capture
/// the complete free-form list without Siri asking a follow-up question.
struct TaskifyNaturalAddTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick Add Multiple Tasks"
    static var description = IntentDescription("Adds several Taskify tasks from one sentence.")
    static var openAppWhenRun = false

    @Parameter(
        title: "Tasks",
        requestValueDialog: "Tell me all the tasks in one sentence. Separate them with “and then”."
    )
    var tasks: TaskifyShortcutTaskNameEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$tasks) as tasks to Taskify")
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let created = try await TaskifyIntentTaskWriter.addTasks(
            spokenRequest: tasks.name,
            requestedBoardName: nil
        )
        return .result(dialog: TaskifyIntentTaskWriter.dialog(for: created))
    }
}

/// A lightweight task entity shared by Siri actions, Shortcuts, and semantic Spotlight indexing.
/// Its query reads only task metadata and leaves externalized attachments on disk.
struct TaskifyShortcutTaskEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Taskify Task"
    static var defaultQuery = ShortcutTaskQuery()

    let id: String
    let title: String
    let boardID: String
    let boardName: String
    let dueDate: Date?
    let dueTimeEnabled: Bool

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(boardName)")
    }

    init(task: TaskItem, board: Board) {
        id = task.id
        title = task.title
        boardID = board.id
        boardName = board.name
        dueDate = task.dueDateEnabled ? task.dueDate : nil
        dueTimeEnabled = task.dueDateEnabled && task.dueTimeEnabled
    }

    init(spotlightItem item: TaskifySpotlightItem) {
        id = item.id
        title = item.title
        boardID = item.boardID
        boardName = item.boardName
        dueDate = item.dueDate
        dueTimeEnabled = item.dueTimeEnabled
    }

    struct ShortcutTaskQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifyShortcutTaskEntity] {
            let snapshot = try await TaskifyIntentTaskReader.snapshot()
            return identifiers.compactMap { identifier in
                Self.entity(id: identifier, in: snapshot)
            }
        }

        func entities(matching string: String) async throws -> [TaskifyShortcutTaskEntity] {
            let snapshot = try await TaskifyIntentTaskReader.snapshot()
            let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return Self.entities(in: snapshot, matching: needle)
        }

        func suggestedEntities() async throws -> [TaskifyShortcutTaskEntity] {
            Self.entities(in: try await TaskifyIntentTaskReader.snapshot(), matching: "")
        }

        private static func entity(
            id: String,
            in snapshot: TaskifySnapshot
        ) -> TaskifyShortcutTaskEntity? {
            guard let task = snapshot.tasks.first(where: {
                $0.id == id && !$0.isDeleted && !$0.completed
            }), let board = snapshot.boards.first(where: {
                $0.id == task.boardID && !$0.archived
            }) else { return nil }
            return TaskifyShortcutTaskEntity(task: task, board: board)
        }

        private static func entities(
            in snapshot: TaskifySnapshot,
            matching needle: String
        ) -> [TaskifyShortcutTaskEntity] {
            snapshot.tasks
                .filter {
                    !$0.isDeleted && !$0.completed && (
                        needle.isEmpty
                            || $0.title.localizedCaseInsensitiveContains(needle)
                            || needle.localizedCaseInsensitiveContains($0.title)
                    )
                }
                .sorted { $0.createdAt > $1.createdAt }
                .prefix(100)
                .compactMap { task in
                    guard let board = snapshot.boards.first(where: {
                        $0.id == task.boardID && !$0.archived
                    }) else { return nil }
                    return TaskifyShortcutTaskEntity(task: task, board: board)
                }
        }
    }
}

@available(iOS 18.0, macOS 15.0, *)
extension TaskifyShortcutTaskEntity: IndexedEntity {
    var attributeSet: CSSearchableItemAttributeSet {
        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = title
        attributes.contentDescription = boardName
        attributes.contentURL = TaskifyWidgetLink.task(id: id, boardID: boardID).url
        if dueTimeEnabled { attributes.dueDate = dueDate }
        return attributes
    }
}

struct TaskifyCompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Task"
    static var description = IntentDescription(
        "Marks an open Taskify task complete without opening the app.",
        categoryName: "Tasks",
        searchKeywords: ["Taskify", "complete", "finish", "done"]
    )
    static var openAppWhenRun = false

    @Parameter(title: "Task", requestValueDialog: "Which Taskify task is complete?")
    var task: TaskifyShortcutTaskEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Complete \(\.$task)")
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard try await TaskifyIntentTaskWriter.completeTask(task.id) else {
            throw TaskifyAddTaskIntentError.taskNotCreated
        }
        return .result(dialog: "Completed “\(task.title)” in \(task.boardName).")
    }
}

struct TaskifyDueTodayIntent: AppIntent {
    static var title: LocalizedStringResource = "Tasks Due Today"
    static var description = IntentDescription("Reads your open Taskify tasks due today.")
    static var openAppWhenRun = false

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let snapshot = try await TaskifyIntentTaskReader.snapshot()
        let calendar = Calendar.current
        let tasks = snapshot.tasks.filter {
            !$0.isDeleted && !$0.completed && $0.dueDateEnabled
                && $0.dueDate.map(calendar.isDateInToday) == true
        }
        guard !tasks.isEmpty else {
            return .result(dialog: "You have no Taskify tasks due today.")
        }
        let names = tasks.prefix(3).map(\.title).joined(separator: ", ")
        let remaining = max(0, tasks.count - 3)
        let suffix = remaining > 0 ? ", and \(remaining) more" : ""
        return .result(dialog: "You have \(tasks.count) due today: \(names)\(suffix).")
    }
}

enum TaskifyIntentTaskReader {
    static func snapshot() async throws -> TaskifySnapshot {
#if os(macOS) && TASKIFY_MAC_UI_TEST
        let test = MacUITestExternalActionConfiguration.resolve()
        return try await JSONTaskStore(fileURL: test.storeURL).read(areas: [.tasks])
#else
        return try await JSONTaskStore().read(areas: [.tasks])
#endif
    }
}

/// The single storage path used by both the backwards-compatible App Shortcut and the newer
/// reminders-domain App Schema intent. Keeping the mutation here prevents Siri's conversational
/// route and its exact-phrase route from drifting into subtly different behavior.
typealias TaskifyIntentCreatedTask = TaskifyExternalCreatedTask

enum TaskifyIntentBoardPresentation {
    static func board(
        for storageBoard: Board,
        requestedBoardName: String?,
        in snapshot: TaskifySnapshot
    ) -> Board {
        TaskifyAddTaskDestination.displayBoard(
            for: storageBoard,
            requestedBoardName: requestedBoardName,
            in: snapshot
        )
    }
}

enum TaskifyIntentTaskWriter {
    /// App Intents have a short execution budget. The durable pending-publish mark is saved first,
    /// so one second is enough for a best-effort relay send without making Siri wait on the full
    /// six-second external-action window; the app sends anything left when it next runs.
    private static var intentPublisher: TaskifyExternalPublisher {
        TaskifyExternalPublisher(timeLimit: .seconds(1))
    }

    static func addTask(
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
        interpretNaturalLanguageTitle: Bool = false
    ) async throws -> TaskifyIntentCreatedTask {
#if os(macOS) && TASKIFY_MAC_UI_TEST
        let test = MacUITestExternalActionConfiguration.resolve()
        return try await TaskifyExternalActions.addTask(
            title: title,
            requestedBoardName: requestedBoardName,
            requestedBoardID: requestedBoardID,
            requestedColumnID: requestedColumnID,
            note: note,
            dueDate: dueDate,
            dueTimeEnabled: dueTimeEnabled,
            reminders: reminders,
            recurrence: recurrence,
            priority: priority,
            interpretNaturalLanguageTitle: interpretNaturalLanguageTitle,
            store: JSONTaskStore(fileURL: test.storeURL),
            publisher: .disabled
        )
#else
        try await TaskifyExternalActions.addTask(
            title: title,
            requestedBoardName: requestedBoardName,
            requestedBoardID: requestedBoardID,
            requestedColumnID: requestedColumnID,
            note: note,
            dueDate: dueDate,
            dueTimeEnabled: dueTimeEnabled,
            reminders: reminders,
            recurrence: recurrence,
            priority: priority,
            interpretNaturalLanguageTitle: interpretNaturalLanguageTitle,
            publisher: intentPublisher
        )
#endif
    }

    static func addTasks(
        spokenRequest: String,
        requestedBoardName: String?
    ) async throws -> [TaskifyIntentCreatedTask] {
#if os(macOS) && TASKIFY_MAC_UI_TEST
        let test = MacUITestExternalActionConfiguration.resolve()
        return try await TaskifyExternalActions.addTasks(
            spokenRequest: spokenRequest,
            requestedBoardName: requestedBoardName,
            store: JSONTaskStore(fileURL: test.storeURL),
            publisher: .disabled
        )
#else
        return try await TaskifyExternalActions.addTasks(
            spokenRequest: spokenRequest,
            requestedBoardName: requestedBoardName,
            publisher: intentPublisher
        )
#endif
    }

    static func completeTask(_ taskID: String) async throws -> Bool {
#if os(macOS) && TASKIFY_MAC_UI_TEST
        let test = MacUITestExternalActionConfiguration.resolve()
        return try await TaskifyExternalActions.completeTask(
            taskID,
            store: JSONTaskStore(fileURL: test.storeURL),
            publisher: .disabled,
            preserveAttachmentReferences: true
        )
#else
        return try await TaskifyExternalActions.completeTask(
            taskID,
            publisher: .disabled,
            preserveAttachmentReferences: true
        )
#endif
    }

    static func dialog(for created: [TaskifyIntentCreatedTask]) -> IntentDialog {
        guard let first = created.first else { return "Taskify couldn't add those tasks." }
        if created.count == 1 {
            return "Added “\(first.task.title)” to \(first.displayBoard.name)."
        }
        let preview = created.prefix(3).map { "“\($0.task.title)”" }.joined(separator: ", ")
        let remainder = created.count > 3 ? ", and \(created.count - 3) more" : ""
        return "Added \(created.count) tasks to \(first.displayBoard.name): \(preview)\(remainder)."
    }

    /// Schedules a task's reminders now: the app only reschedules when it next runs, which could
    /// be after the reminder was due. Returns false when Taskify may not post notifications.
    @discardableResult
    static func scheduleReminders(for task: TaskItem) async -> Bool {
#if os(macOS) && TASKIFY_MAC_UI_TEST
        return true
#else
        guard !(task.reminders ?? []).isEmpty else { return true }
        guard let accountID = TaskifyDeviceTaskSettings.load().editorPublicKey else {
            return await TaskNotificationCoordinator.canNotify()
        }
        return await TaskNotificationCoordinator.scheduleReminders(for: task, accountID: accountID)
#endif
    }
}

typealias TaskifyAddTaskIntentError = TaskifyExternalAddTaskError
#endif
