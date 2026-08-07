import AppIntents
import Foundation
import TaskifyCore

/// Opens the app ready to add a task. Used by the Control Center / Lock Screen / Action Button
/// control.
///
/// This file is compiled into **both** the app and the widget extension, deliberately. A control's
/// action intent with `openAppWhenRun` is performed in the app's process, while the control itself
/// is declared in the extension -- so the type has to exist in both binaries or iOS launches the
/// app, finds nothing to run, and the button silently does nothing. That's Xcode's own template
/// arrangement for shared intents, and it's the third time this codebase has been bitten by an
/// App Intent living somewhere it doesn't execute.
///
/// The request is left in shared defaults rather than passed as a URL: a custom scheme opened from
/// a control didn't reach the app, and defaults are readable by whichever process actually ends up
/// handling it.
struct TaskifyQuickAddIntent: AppIntent {
    static var title: LocalizedStringResource = "New Task"
    static var description = IntentDescription("Opens Taskify ready to add a task.")
    static var openAppWhenRun: Bool = true

    init() {}

    func perform() async throws -> some IntentResult {
        TaskifyQuickAddRequest.set()
        return .result()
    }
}

/// A one-shot "the user asked to add a task" flag, handed between processes.
public enum TaskifyQuickAddRequest {
    private static let key = "taskify.quickAdd.requestedAt"
    /// Older requests are ignored: tapping the control, abandoning it, and opening the app an hour
    /// later shouldn't pop the keyboard unprompted.
    private static let maximumAge: TimeInterval = 60

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: TaskifySharedContainer.appGroupID)
    }

    public static func set(now: Date = Date()) {
        defaults?.set(now.timeIntervalSince1970, forKey: key)
    }

    /// Returns whether a recent request is pending, clearing it either way so it fires once.
    public static func consume(now: Date = Date()) -> Bool {
        guard let defaults else { return false }
        let stamp = defaults.double(forKey: key)
        guard stamp > 0 else { return false }
        defaults.removeObject(forKey: key)
        return now.timeIntervalSince1970 - stamp <= maximumAge
    }
}
