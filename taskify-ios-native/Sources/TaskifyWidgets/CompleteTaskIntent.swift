import AppIntents
import TaskifyCore
import WidgetKit

/// Ticks a task off from the widget itself.
///
/// Goes through the same `JSONTaskStore` and `toggleCompletion` the app uses rather than editing
/// the file directly, so a completion made here is indistinguishable from one made in the app --
/// including streak bookkeeping. The app picks it up when it next reads the store, and syncs it to
/// Nostr then; the widget deliberately doesn't try to publish, since it can be killed the moment
/// the intent returns.
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
        let store = JSONTaskStore()
        var snapshot = try await store.load()
        guard snapshot.toggleCompletion(taskID: taskID) else { return .result() }
        try await store.save(snapshot)
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
