import AppIntents
import TaskifyCore
import WidgetKit

/// Ticks a task off from the widget itself.
///
/// Goes through `TaskifyExternalActions`, the app's own completion with the user's settings, so a
/// completion made here matches one made in the app, streaks and next occurrence included. It
/// never reopens a task: the row may have been drawn before the task was completed elsewhere. The
/// app picks the change up when it next reads the store, and syncs it to Nostr then; the widget
/// doesn't publish, since it can be killed the moment the intent returns.
struct CompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Task"
    /// Keeps the widget in place instead of launching the app -- the whole point of ticking a box
    /// from the Home Screen.
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Task")
    var taskID: String

    init() {}

    init(taskID: String) {
        self.taskID = taskID
    }

    func perform() async throws -> some IntentResult {
        try await TaskifyExternalActions.completeTask(taskID)
        // Reloads even when nothing changed, so a row completed elsewhere leaves the widget.
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
