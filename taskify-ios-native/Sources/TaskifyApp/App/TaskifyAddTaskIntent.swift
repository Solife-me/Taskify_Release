import AppIntents
import Foundation
import TaskifyCore

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

/// A free-form task name represented as an App Entity. App Shortcut invocation phrases cannot
/// interpolate a plain String parameter, but they can interpolate an App Entity. The query turns
/// whatever Siri heard into a single task-name entity, allowing natural one-sentence requests
/// such as “Add buy milk in Taskify” without an extra question.
struct TaskifyShortcutTaskNameEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task Name")
    static var defaultQuery = TaskNameQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.id = trimmed
        self.name = trimmed
    }

    struct TaskNameQuery: EntityStringQuery {
        init() {}

        func entities(for identifiers: [String]) async throws -> [TaskifyShortcutTaskNameEntity] {
            identifiers.compactMap { identifier in
                let entity = TaskifyShortcutTaskNameEntity(name: identifier)
                return entity.name.isEmpty ? nil : entity
            }
        }

        func entities(matching string: String) async throws -> [TaskifyShortcutTaskNameEntity] {
            let entity = TaskifyShortcutTaskNameEntity(name: string)
            return entity.name.isEmpty ? [] : [entity]
        }

        func suggestedEntities() async throws -> [TaskifyShortcutTaskNameEntity] {
            []
        }
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
    static func addTask(
        title: String,
        requestedBoardName: String?,
        note: String = "",
        dueDate: Date? = nil,
        priority: TaskPriority? = nil,
        interpretNaturalLanguageTitle: Bool = false
    ) async throws -> TaskifyIntentCreatedTask {
#if os(macOS) && TASKIFY_MAC_UI_TEST
        let test = MacUITestExternalActionConfiguration.resolve()
        return try await TaskifyExternalActions.addTask(
            title: title,
            requestedBoardName: requestedBoardName,
            note: note,
            dueDate: dueDate,
            priority: priority,
            interpretNaturalLanguageTitle: interpretNaturalLanguageTitle,
            store: JSONTaskStore(fileURL: test.storeURL),
            publisher: .disabled
        )
#else
        try await TaskifyExternalActions.addTask(
            title: title,
            requestedBoardName: requestedBoardName,
            note: note,
            dueDate: dueDate,
            priority: priority,
            interpretNaturalLanguageTitle: interpretNaturalLanguageTitle
        )
#endif
    }
}

typealias TaskifyAddTaskIntentError = TaskifyExternalAddTaskError
#endif
