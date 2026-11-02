import AppIntents
import Foundation
import TaskifyCore
import TaskifyWatchShared

#if os(iOS) || TASKIFY_MAC_SHORTCUTS
/// “Siri, in Taskify remind me to take out the trash tomorrow at 1pm.” Adds a task due at that
/// time with a reminder at it, without opening the app. Like `TaskifyAddTaskIntent` it must live in
/// the app target, and it shares that intent's storage path (`TaskifyIntentTaskWriter`).
///
/// The text is split by `TaskifyReminderPhraseParser`, which the Watch's Remind Me uses too. A
/// date with no time reminds on the day, at the task's reminder time (9:00 AM unless changed).
/// Siri asks again when there is nothing to remind about, or no time to do it.
struct TaskifyRemindMeIntent: AppIntent {
    static var title: LocalizedStringResource = "Remind Me"
    static var description = IntentDescription(
        "Adds a Taskify task with a reminder, from a request like “take out the trash tomorrow at 1 PM”.",
        categoryName: "Tasks",
        searchKeywords: ["Taskify", "reminder", "remind", "task", "alert", "notification"]
    )
    static var openAppWhenRun = false

    @Parameter(
        title: "Reminder",
        description: "What to be reminded of, and when — for example “take out the trash tomorrow at 1 PM”.",
        requestValueDialog: "What should I remind you about?"
    )
    var reminder: String

    @Parameter(
        title: "When",
        description: "When to remind you. Leave blank to use the time in the reminder text.",
        requestValueDialog: "When should I remind you?"
    )
    var when: Date?

    @Parameter(
        title: "Board",
        description: "The Taskify board to add the task to. Leave blank to use the default board."
    )
    var boardName: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Remind me to \(\.$reminder)") {
            \.$when
            \.$boardName
        }
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let phrase = TaskifyReminderPhraseParser.parse(reminder).applying(explicitDate: when)
        guard !phrase.title.isEmpty else {
            throw $reminder.needsValueError("What should I remind you about?")
        }
        guard phrase.dueDate != nil else {
            throw $when.needsValueError("When should I remind you?")
        }
        return .result(dialog: try await TaskifyIntentReminderWriter.add(phrase, boardName: boardName))
    }
}

/// The one-sentence form: the whole request is captured as an entity, because an App Shortcut
/// phrase can only interpolate one (see `TaskifyShortcutTaskNameEntity`).
struct TaskifyNaturalRemindMeIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick Reminder"
    static var description = IntentDescription("Adds a Taskify task with a reminder from one sentence.")
    static var openAppWhenRun = false

    @Parameter(title: "Reminder", requestValueDialog: "What should I remind you about?")
    var reminder: TaskifyShortcutTaskNameEntity

    @Parameter(title: "When", requestValueDialog: "When should I remind you?")
    var when: Date?

    static var parameterSummary: some ParameterSummary {
        Summary("Remind me to \(\.$reminder)") {
            \.$when
        }
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let phrase = TaskifyReminderPhraseParser.parse(reminder.name).applying(explicitDate: when)
        guard !phrase.title.isEmpty else {
            throw $reminder.needsValueError("What should I remind you about?")
        }
        guard phrase.dueDate != nil else {
            throw $when.needsValueError("When should I remind you?")
        }
        return .result(dialog: try await TaskifyIntentReminderWriter.add(phrase, boardName: nil))
    }
}

enum TaskifyIntentReminderError: LocalizedError, Equatable {
    case timeHasPassed

    var errorDescription: String? {
        switch self {
        case .timeHasPassed: "That time has already passed. Try again with a later time."
        }
    }
}

enum TaskifyIntentReminderWriter {
    /// Adds the task, schedules its reminder, and says what was done.
    static func add(_ phrase: TaskifyReminderPhrase, boardName: String?) async throws -> IntentDialog {
        guard let dueDate = phrase.dueDate else { throw TaskifyExternalAddTaskError.taskNotCreated }
        let reminders = phrase.reminderRawValues.map(TaskReminder.init(rawValue:))
        // A reminder that would never go off is refused before anything is saved.
        let now = Date()
        guard let fireDate = phrase.fireDate(), fireDate > now else {
            throw TaskifyIntentReminderError.timeHasPassed
        }

        let created = try await TaskifyIntentTaskWriter.addTask(
            title: phrase.title,
            requestedBoardName: boardName,
            dueDate: dueDate,
            dueTimeEnabled: phrase.hasTime,
            reminders: reminders
        )
        let canNotify = await TaskifyIntentTaskWriter.scheduleReminders(for: created.task)
        return dialog(for: created, canNotify: canNotify, now: now)
    }

    static func dialog(for created: TaskifyIntentCreatedTask, canNotify: Bool, now: Date) -> IntentDialog {
        let title = created.task.title
        let board = created.displayBoard.name
        guard let fireDate = created.task.reminderFireDates().map(\.1).filter({ $0 > now }).min() else {
            return "Added “\(title)” to \(board)."
        }
        guard canNotify else {
            let when = TaskifyReminderPhrase.spokenTime(of: fireDate, now: now)
            return "Added “\(title)” to \(board) with a reminder \(when). Turn on Taskify notifications to be alerted."
        }
        let text = TaskifyReminderPhrase.confirmation(title: title, fireDate: fireDate, boardName: board, now: now)
        return "\(text)"
    }
}
#endif
