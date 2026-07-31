import AppIntents
import Foundation

/// Lives in TaskifyCore (not the TaskifyApp Xcode target) purely for build-system reasons: this
/// package's files are picked up automatically by both `swift test` and the Xcode app build via
/// SwiftPM's directory-based target globbing, whereas the app target's own sources are listed
/// explicitly in `project.pbxproj` and require manual project-file edits to add. App Intents don't
/// need SwiftUI or any app-target-only type, so there's no functional reason they couldn't live
/// here.
///
/// `AppShortcutsProvider` (`TaskifyShortcuts`), however, does *not* work this way and lives in
/// `TaskifyNativeApp.swift` instead: inspecting the built `Metadata.appintents/extract.actionsdata`
/// confirmed that Xcode's App Intents metadata extraction picks up `TaskifyAddTaskIntent` fine from
/// this package target (it appears with `isDiscoverable: true`), but silently omits an
/// `AppShortcutsProvider` defined here entirely -- no trace of it in the extracted metadata at all,
/// which is why Siri/Spotlight/Shortcuts never showed Taskify. The provider must live in the app's
/// own target.
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
public struct TaskifyAddTaskIntent: AppIntent {
    public static var title: LocalizedStringResource = "Add Task"
    public static var description = IntentDescription("Adds a task to Taskify without opening the app.")

    @Parameter(title: "Task")
    public var taskTitle: String

    @Parameter(title: "Board")
    public var boardName: String?

    public static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$taskTitle) to Taskify") {
            \.$boardName
        }
    }

    public init() {}

    public init(taskTitle: String, boardName: String? = nil) {
        self.taskTitle = taskTitle
        self.boardName = boardName
    }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
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
    /// default) — kept here rather than shared, since that type lives in the TaskifyApp target and
    /// is a two-line UserDefaults read not worth a cross-module dependency for.
    private static var newTaskPosition: NewTaskPosition {
        UserDefaults.standard.string(forKey: "taskify.newTaskPosition").flatMap(NewTaskPosition.init(rawValue:)) ?? .top
    }
}

public enum TaskifyAddTaskIntentError: Swift.Error, CustomLocalizedStringResourceConvertible {
    case emptyTitle
    case noAddableBoard
    case taskNotCreated

    public var localizedStringResource: LocalizedStringResource {
        switch self {
        case .emptyTitle: "Enter a task title."
        case .noAddableBoard: "Add a board in Taskify first."
        case .taskNotCreated: "Taskify couldn't add that task."
        }
    }
}

/// Resolves where a headless "add task" request should land, mirroring the priority order the
/// quick-add bar in `BoardsView` uses when nothing is focused: an explicitly named board (falling
/// through to a compound board's first child list, the same way quick-add does), else the app's
/// currently selected board, else the first addable board at all. Week boards land on today's
/// weekday column; list boards land in the first column by display order. Compound and Bible
/// boards are never a final destination — compound resolves to its first child, and Bible has no
/// quick-add equivalent at all, so it's skipped in favor of any other addable board.
struct TaskifyAddTaskDestination {
    let boardID: String
    let boardName: String
    let columnID: String?
    let dueDate: Date?

    static func resolve(
        in snapshot: TaskifySnapshot,
        requestedBoardName: String?,
        now: Date = Date()
    ) -> TaskifyAddTaskDestination? {
        let addable = snapshot.visibleBoards.filter { $0.kind == .week || $0.kind == .list }

        func destination(for board: Board) -> TaskifyAddTaskDestination? {
            switch board.kind {
            case .week:
                let weekday = WeekdayColumn.containing(now)
                return TaskifyAddTaskDestination(
                    boardID: board.id,
                    boardName: board.name,
                    columnID: weekday.rawValue,
                    dueDate: WeekDateResolver.date(for: weekday, inWeekContaining: now)
                )
            case .list:
                let orderedColumns = board.columns.sorted {
                    if $0.order != $1.order { return $0.order < $1.order }
                    return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                }
                guard let column = orderedColumns.first else { return nil }
                return TaskifyAddTaskDestination(
                    boardID: board.id,
                    boardName: board.name,
                    columnID: column.id,
                    dueDate: nil
                )
            case .compound, .bible:
                return nil
            }
        }

        func resolvedDestination(for board: Board) -> TaskifyAddTaskDestination? {
            if let direct = destination(for: board) { return direct }
            guard board.kind == .compound,
                  let child = snapshot.compoundChildBoards(for: board.id).first else { return nil }
            return destination(for: child)
        }

        if let requestedBoardName {
            let needle = requestedBoardName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !needle.isEmpty {
                let matched = snapshot.visibleBoards.first { $0.name.lowercased() == needle }
                    ?? snapshot.visibleBoards.first { $0.name.lowercased().contains(needle) }
                if let matched, let resolved = resolvedDestination(for: matched) {
                    return resolved
                }
            }
        }

        if let selected = snapshot.selectedBoard, let resolved = resolvedDestination(for: selected) {
            return resolved
        }

        return addable.compactMap(destination(for:)).first
    }
}
