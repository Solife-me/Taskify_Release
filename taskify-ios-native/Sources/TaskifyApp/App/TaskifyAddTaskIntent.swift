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
    static var description = IntentDescription("Adds a task to Taskify without opening the app.")

    @Parameter(title: "Task")
    var taskTitle: String

    @Parameter(title: "Board")
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
        let trimmedTitle = taskTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            throw TaskifyAddTaskIntentError.emptyTitle
        }

        let store = JSONTaskStore()
        var snapshot = try await store.load()

        guard let destination = TaskifyAddTaskDestination.resolve(
            in: snapshot,
            requestedBoardName: boardName
        ) else {
            throw TaskifyAddTaskIntentError.noAddableBoard
        }

        guard let task = snapshot.addTask(
            title: trimmedTitle,
            boardID: destination.boardID,
            columnID: destination.columnID,
            dueDate: destination.dueDate,
            newTaskPosition: TaskifyAddTaskIntent.newTaskPosition
        ) else {
            throw TaskifyAddTaskIntentError.taskNotCreated
        }

        try await store.save(snapshot)

        return .result(dialog: "Added \"\(task.title)\" to \(destination.boardName).")
    }

    /// A local copy of the app's `TaskOrderingSettings.position` read (same UserDefaults key and
    /// default), kept separate because the intent must not touch app state types that pull in
    /// `AppModel`.
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
