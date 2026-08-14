import AppIntents
import Foundation
import TaskifyCore

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
/// persists through, doing only the minimal load → mutate → save round trip. The new task is
/// picked up and published to Nostr normally the next time the full app launches and its sync
/// engine runs.
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
struct TaskifyIntentCreatedTask: Sendable {
    let task: TaskItem
    let board: Board
    let displayBoard: Board
}

enum TaskifyIntentBoardPresentation {
    static func board(
        for storageBoard: Board,
        requestedBoardName: String?,
        in snapshot: TaskifySnapshot
    ) -> Board {
        if let requested = requestedBoardName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !requested.isEmpty,
           let requestedBoard = matchingNamedBoard(named: requested, in: snapshot),
           represents(storageBoard: storageBoard, visibleBoard: requestedBoard, in: snapshot) {
            return requestedBoard
        }

        if !storageBoard.isVisible,
           let parent = snapshot.visibleBoards.first(where: {
               $0.kind == .compound && represents(
                   storageBoard: storageBoard,
                   visibleBoard: $0,
                   in: snapshot
               )
           }) {
            return parent
        }

        return storageBoard
    }

    private static func matchingNamedBoard(
        named name: String,
        in snapshot: TaskifySnapshot
    ) -> Board? {
        let boards = TaskifyAddTaskDestination.namedBoards(in: snapshot)
        return boards.first {
            $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame
        } ?? boards.first {
            $0.name.localizedCaseInsensitiveContains(name)
        } ?? boards.first {
            name.localizedCaseInsensitiveContains($0.name)
        }
    }

    private static func represents(
        storageBoard: Board,
        visibleBoard: Board,
        in snapshot: TaskifySnapshot
    ) -> Bool {
        storageBoard.id == visibleBoard.id || (
            visibleBoard.kind == .compound &&
                snapshot.compoundChildBoards(for: visibleBoard.id).contains {
                    $0.id == storageBoard.id
                }
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
        let store = JSONTaskStore()
        var snapshot = try await store.load()

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
        let trimmedTitle = spokenRequest.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            throw TaskifyAddTaskIntentError.emptyTitle
        }

        guard let destination = TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: spokenRequest.requestedBoardName
        ) else {
            throw TaskifyAddTaskIntentError.noAddableBoard
        }

        guard let task = snapshot.addTask(
            title: trimmedTitle,
            boardID: destination.boardID,
            columnID: destination.columnID,
            dueDate: dueDate ?? destination.dueDate,
            note: note,
            priority: priority,
            newTaskPosition: newTaskPosition
        ), let board = snapshot.boards.first(where: { $0.id == task.boardID }) else {
            throw TaskifyAddTaskIntentError.taskNotCreated
        }

        let displayBoard = TaskifyIntentBoardPresentation.board(
            for: board,
            requestedBoardName: spokenRequest.requestedBoardName,
            in: snapshot
        )
        try await store.save(snapshot)
        return TaskifyIntentCreatedTask(task: task, board: board, displayBoard: displayBoard)
    }

    /// A local copy of the app's `TaskOrderingSettings.position` read (same UserDefaults key and
    /// default), kept separate because an intent must not construct the heavyweight `AppModel`.
    private static var newTaskPosition: NewTaskPosition {
        UserDefaults.standard.string(forKey: "taskify.newTaskPosition").flatMap(NewTaskPosition.init(rawValue:)) ?? .top
    }
}

enum TaskifyAddTaskIntentError: Swift.Error, CustomLocalizedStringResourceConvertible {
    case emptyTitle
    case noAddableBoard
    case taskNotCreated

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .emptyTitle: "Enter a task title."
        case .noAddableBoard: "Add a board in Taskify first."
        case .taskNotCreated: "Taskify couldn't add that task."
        }
    }
}
