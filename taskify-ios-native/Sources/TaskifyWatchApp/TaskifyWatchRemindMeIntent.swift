import AppIntents
import Foundation
import TaskifyWatchShared

/// “Siri, in Taskify remind me to take out the trash tomorrow at 1pm,” said to the Watch. The
/// text is read by the same `TaskifyReminderPhraseParser` as on the iPhone and Mac; the task then
/// goes the way a dictated one does (`TaskifyWatchAppModel.addReminderFromShortcut`), and the
/// iPhone, which schedules Taskify's notifications, alerts on both devices.
struct TaskifyWatchRemindMeIntent: AppIntent {
    static var title: LocalizedStringResource = "Remind Me"
    static var description = IntentDescription(
        "Adds a Taskify task with a reminder, from a request like “take out the trash tomorrow at 1 PM”."
    )
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Reminder", requestValueDialog: "What should I remind you about?")
    var reminder: String

    @Parameter(title: "When", requestValueDialog: "When should I remind you?")
    var when: Date?

    static var parameterSummary: some ParameterSummary {
        Summary("Remind me to \(\.$reminder)") {
            \.$when
        }
    }

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let phrase = TaskifyReminderPhraseParser.parse(reminder).applying(explicitDate: when)
        guard !phrase.title.isEmpty else {
            throw $reminder.needsValueError("What should I remind you about?")
        }
        guard phrase.dueDate != nil else {
            throw $when.needsValueError("When should I remind you?")
        }
        return .result(dialog: try TaskifyWatchReminderWriter.add(phrase))
    }
}

/// The one-sentence form, as on the iPhone (`TaskifyNaturalRemindMeIntent`).
struct TaskifyWatchNaturalRemindMeIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick Reminder"
    static var description = IntentDescription("Adds a Taskify task with a reminder from one sentence.")
    static var openAppWhenRun: Bool = false

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

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let phrase = TaskifyReminderPhraseParser.parse(reminder.name).applying(explicitDate: when)
        guard !phrase.title.isEmpty else {
            throw $reminder.needsValueError("What should I remind you about?")
        }
        guard phrase.dueDate != nil else {
            throw $when.needsValueError("When should I remind you?")
        }
        return .result(dialog: try TaskifyWatchReminderWriter.add(phrase))
    }
}

enum TaskifyWatchReminderWriter {
    @MainActor
    static func add(_ phrase: TaskifyReminderPhrase) throws -> IntentDialog {
        let now = Date()
        guard let fireDate = phrase.fireDate(), fireDate > now else {
            throw TaskifyWatchReminderError.timeHasPassed
        }
        let board = try TaskifyWatchAppModel.shared.addReminderFromShortcut(phrase)
        let text = TaskifyReminderPhrase.confirmation(title: phrase.title, fireDate: fireDate, boardName: board, now: now)
        return "\(text)"
    }
}

enum TaskifyWatchReminderError: LocalizedError {
    case timeHasPassed

    var errorDescription: String? {
        "That time has already passed. Try again with a later time."
    }
}
