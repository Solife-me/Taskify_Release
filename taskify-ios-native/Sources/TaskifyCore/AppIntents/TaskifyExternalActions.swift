import Foundation

/// The user's task settings, as the app last saw them, for processes that edit tasks without the
/// app: the widget, Siri and Shortcuts. The app writes them to the App Group whenever they change
/// (C10-1), so an edit made outside the app counts streaks, starts weeks and places new tasks the
/// way the same edit in the app would.
public struct TaskifyDeviceTaskSettings: Codable, Equatable, Sendable {
    public var streaksEnabled: Bool
    public var weekStart: WeekdayColumn
    public var newTaskPosition: NewTaskPosition
    /// The signed-in account, recorded as the task's last editor.
    public var editorPublicKey: String?

    /// The app's defaults: streaks on, weeks starting on Sunday, new tasks at the top.
    public init(
        streaksEnabled: Bool = true,
        weekStart: WeekdayColumn = .sunday,
        newTaskPosition: NewTaskPosition = .top,
        editorPublicKey: String? = nil
    ) {
        self.streaksEnabled = streaksEnabled
        self.weekStart = weekStart
        self.newTaskPosition = newTaskPosition
        self.editorPublicKey = editorPublicKey
    }

    private static let key = "taskify.deviceTaskSettings.v1"

    /// Nil where the App Group isn't in effect (an unentitled Mac): there is nothing to share with.
    public static var sharedDefaults: UserDefaults? {
        guard TaskifySharedContainer.isAvailable() else { return nil }
        return UserDefaults(suiteName: TaskifySharedContainer.appGroupID)
    }

    public static func load(from defaults: UserDefaults? = sharedDefaults) -> TaskifyDeviceTaskSettings {
        guard let data = defaults?.data(forKey: key),
              let settings = try? JSONDecoder().decode(TaskifyDeviceTaskSettings.self, from: data) else {
            return TaskifyDeviceTaskSettings()
        }
        return settings
    }

    public static func update(
        in defaults: UserDefaults? = sharedDefaults,
        _ change: (inout TaskifyDeviceTaskSettings) -> Void
    ) {
        guard let defaults else { return }
        var settings = load(from: defaults)
        let before = settings
        change(&settings)
        guard settings != before, let data = try? JSONEncoder().encode(settings) else { return }
        defaults.set(data, forKey: key)
    }
}

/// Task edits made outside the app (C10-1). They go through the same snapshot operations as the
/// app, with the user's settings, so the result matches the app's. The app reads them in from
/// the store later and publishes them.
public enum TaskifyExternalActions {
    /// Marks a task complete or incomplete. Does nothing when it already is: a widget drawn
    /// before the task was completed elsewhere must not reopen it. Returns whether it changed.
    @discardableResult
    public static func setCompleted(
        _ completed: Bool,
        taskID: String,
        in snapshot: inout TaskifySnapshot,
        settings: TaskifyDeviceTaskSettings,
        now: Date = Date()
    ) -> Bool {
        guard let task = snapshot.tasks.first(where: { $0.id == taskID && !$0.isDeleted }),
              task.completed != completed else { return false }
        return snapshot.toggleCompletion(
            taskID: taskID,
            editorPublicKey: settings.editorPublicKey,
            streaksEnabled: settings.streaksEnabled,
            weekStartsOn: settings.weekStart,
            now: now
        )
    }

    /// Loads the tasks, completes one and saves. Returns whether anything changed.
    @discardableResult
    public static func completeTask(
        _ taskID: String,
        store: JSONTaskStore = JSONTaskStore(),
        settings: TaskifyDeviceTaskSettings = .load(),
        now: Date = Date()
    ) async throws -> Bool {
        var snapshot = try await store.load(areas: [.tasks])
        guard setCompleted(true, taskID: taskID, in: &snapshot, settings: settings, now: now) else {
            return false
        }
        try await store.save(snapshot)
        return true
    }
}
