import AppIntents

#if os(iOS) || TASKIFY_MAC_SHORTCUTS
/// Like `TaskifyAddTaskIntent`, this must live in an app target rather than the TaskifyCore
/// package: an `AppShortcutsProvider` defined in the package is dropped from the extracted
/// `Metadata.appintents` entirely, so the system never learns Taskify has any Siri phrases.
struct TaskifyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TaskifyAddTaskIntent(),
            phrases: [
                "Add a \(.applicationName) task",
                "Create a \(.applicationName) task",
                "Add something to \(.applicationName)",
                "Put a task in \(.applicationName)",
                "New task in \(.applicationName)",
                "Add a task to \(.applicationName)",
                "Add a task in \(.applicationName)",
                "Create a task in \(.applicationName)",
                "Make a new task in \(.applicationName)",
                "Use \(.applicationName) to add a task",
            ],
            shortTitle: "Add Task",
            systemImageName: "checklist"
        )
        AppShortcut(
            intent: TaskifyNaturalAddTaskIntent(),
            phrases: [
                "Add \(\.$task) in \(.applicationName)",
                "Create \(\.$task) in \(.applicationName)",
                "Add \(\.$task) to \(.applicationName)",
                "\(.applicationName) add \(\.$task)",
                "In \(.applicationName) add \(\.$task)",
            ],
            shortTitle: "Quick Add Task",
            systemImageName: "plus.circle"
        )
    }
}
#endif
