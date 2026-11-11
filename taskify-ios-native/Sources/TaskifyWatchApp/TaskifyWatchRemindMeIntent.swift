import AppIntents
import Foundation
import TaskifyWatchShared
import UserNotifications

/// “Siri, in Taskify remind me to take out the trash tomorrow at 1pm,” said to the Watch. The
/// text is read by the same `TaskifyReminderPhraseParser` as on the iPhone and Mac; the task then
/// goes the way a dictated one does (`TaskifyWatchAppModel.addReminderFromShortcut`). A reachable
/// iPhone schedules the normal Taskify notification; an untethered Watch schedules its own local
/// fallback until the phone acknowledges the durable command.
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
        return .result(dialog: try await TaskifyWatchReminderWriter.add(phrase))
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
        return .result(dialog: try await TaskifyWatchReminderWriter.add(phrase))
    }
}

enum TaskifyWatchReminderWriter {
    @MainActor
    static func add(_ phrase: TaskifyReminderPhrase) async throws -> IntentDialog {
        let now = Date()
        guard let fireDate = phrase.fireDate(), fireDate > now else {
            throw TaskifyWatchReminderError.timeHasPassed
        }
        let submission = try await TaskifyWatchAppModel.shared.addReminderFromShortcut(phrase)
        let watchWillNotify: Bool
        if submission.syncState == .syncingThroughPhone {
            watchWillNotify = true
        } else {
            watchWillNotify = await TaskifyWatchReminderNotification.schedule(
                title: phrase.title,
                fireDate: fireDate,
                commandID: submission.commandID
            )
        }
        var text = TaskifyReminderPhrase.confirmation(
            title: phrase.title,
            fireDate: fireDate,
            boardName: submission.boardName,
            now: now
        )
        if !watchWillNotify {
            text += " The task is saved, but Watch notifications are disabled."
        }
        return "\(text)"
    }
}

enum TaskifyWatchReminderNotification {
    static func identifier(commandID: String) -> String {
        "taskify.watch.siri-reminder.\(commandID)"
    }

    static func schedule(title: String, fireDate: Date, commandID: String) async -> Bool {
        let center = UNUserNotificationCenter.current()
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            settings = await center.notificationSettings()
        }
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else {
            return false
        }
        let content = UNMutableNotificationContent()
        content.title = "Taskify Reminder"
        content.body = title
        content.sound = .default
        content.threadIdentifier = "taskify-reminders"
        let components = Calendar.current.dateComponents(
            [.calendar, .timeZone, .year, .month, .day, .hour, .minute, .second],
            from: fireDate
        )
        let request = UNNotificationRequest(
            identifier: identifier(commandID: commandID),
            content: content,
            trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        )
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }
}

enum TaskifyWatchReminderError: LocalizedError {
    case timeHasPassed

    var errorDescription: String? {
        "That time has already passed. Try again with a later time."
    }
}

// MARK: - General Siri task control

struct TaskifyWatchBoardEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Board"
    static var defaultQuery = TaskifyWatchBoardQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    init(_ board: TaskifyWatchBoard) {
        self.init(id: board.id, name: board.name)
    }
}

struct TaskifyWatchBoardQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskifyWatchBoardEntity] {
        await MainActor.run {
            let boards = TaskifyWatchAppModel.shared.snapshot.boards
            return identifiers.compactMap { identifier in
                boards.first(where: { $0.id == identifier }).map(TaskifyWatchBoardEntity.init)
            }
        }
    }

    func entities(matching string: String) async throws -> [TaskifyWatchBoardEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return await MainActor.run {
            TaskifyWatchAppModel.shared.snapshot.boards
                .filter {
                    needle.isEmpty
                        || $0.name.localizedCaseInsensitiveContains(needle)
                        || needle.localizedCaseInsensitiveContains($0.name)
                }
                .map(TaskifyWatchBoardEntity.init)
        }
    }

    func suggestedEntities() async throws -> [TaskifyWatchBoardEntity] {
        await MainActor.run {
            TaskifyWatchAppModel.shared.snapshot.boards.map(TaskifyWatchBoardEntity.init)
        }
    }
}

struct TaskifyWatchTaskEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Task"
    static var defaultQuery = TaskifyWatchTaskQuery()

    let id: String
    let title: String
    let boardName: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(boardName)")
    }

    init(_ task: TaskifyWatchWidgetTask) {
        id = task.id
        title = task.title
        boardName = task.boardName
    }
}

struct TaskifyWatchTaskQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskifyWatchTaskEntity] {
        let tasks = TaskifyWatchWidgetCache.load().tasks
        return identifiers.compactMap { identifier in
            tasks.first(where: { $0.id == identifier }).map(TaskifyWatchTaskEntity.init)
        }
    }

    func entities(matching string: String) async throws -> [TaskifyWatchTaskEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return TaskifyWatchWidgetCache.load().tasks
            .filter {
                needle.isEmpty
                    || $0.title.localizedCaseInsensitiveContains(needle)
                    || needle.localizedCaseInsensitiveContains($0.title)
            }
            .prefix(50)
            .map(TaskifyWatchTaskEntity.init)
    }

    func suggestedEntities() async throws -> [TaskifyWatchTaskEntity] {
        TaskifyWatchWidgetCache.load().tasks.prefix(50).map(TaskifyWatchTaskEntity.init)
    }
}

struct TaskifyWatchAddTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Task"
    static var description = IntentDescription(
        "Adds a task using the paired iPhone or the Apple Watch's independent connection."
    )
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Task", requestValueDialog: "What task should I add?")
    var task: TaskifyShortcutTaskNameEntity

    @Parameter(title: "Board", requestValueDialog: "Which board?")
    var board: TaskifyWatchBoardEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$task)") {
            \.$board
        }
    }

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let title = task.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            throw $task.needsValueError("What task should I add?")
        }
        let submission = try await TaskifyWatchAppModel.shared.addTasksFromShortcut(
            titles: [title],
            boardID: board?.id
        )
        return .result(dialog: TaskifyWatchShortcutDialog.added(
            titles: [title],
            submission: submission
        ))
    }
}

struct TaskifyWatchAddTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Multiple Tasks"
    static var description = IntentDescription("Adds several spoken tasks in one request.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Tasks", requestValueDialog: "Which tasks should I add?")
    var tasks: TaskifyShortcutTaskNameEntity

    @Parameter(title: "Board", requestValueDialog: "Which board?")
    var board: TaskifyWatchBoardEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$tasks)") {
            \.$board
        }
    }

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let batch = TaskifyWatchSpokenTaskBatchParser.parse(tasks.name)
        guard !batch.titles.isEmpty else {
            throw $tasks.needsValueError("Which tasks should I add?")
        }
        guard batch.omittedCount == 0 else {
            throw TaskifyWatchBatchIntentError.tooManyTasks
        }
        let submission = try await TaskifyWatchAppModel.shared.addTasksFromShortcut(
            titles: batch.titles,
            boardID: board?.id
        )
        return .result(dialog: TaskifyWatchShortcutDialog.added(
            titles: batch.titles,
            submission: submission
        ))
    }
}

struct TaskifyWatchCompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Task"
    static var description = IntentDescription("Completes a Taskify task from Apple Watch.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Task", requestValueDialog: "Which task should I complete?")
    var task: TaskifyWatchTaskEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Complete \(\.$task)")
    }

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let submission = try await TaskifyWatchAppModel.shared.completeTaskFromShortcut(task.id)
        return .result(dialog: TaskifyWatchShortcutDialog.completed(
            title: task.title,
            submission: submission
        ))
    }
}

struct TaskifyWatchDueTodayIntent: AppIntent {
    static var title: LocalizedStringResource = "Tasks Due Today"
    static var description = IntentDescription("Reads tasks due today from the Watch's saved task list.")
    static var openAppWhenRun: Bool = false

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let tasks = TaskifyWatchWidgetCache.load().todayTasks()
        guard !tasks.isEmpty else {
            return .result(dialog: "You have no Taskify tasks due today.")
        }
        let spoken = tasks.prefix(3).map(\.title).joined(separator: ", ")
        let remainder = tasks.count - min(tasks.count, 3)
        let suffix = remainder > 0 ? ", and \(remainder) more" : ""
        return .result(dialog: "You have \(tasks.count) due today: \(spoken)\(suffix).")
    }
}

enum TaskifyWatchBatchIntentError: LocalizedError {
    case tooManyTasks

    var errorDescription: String? {
        "You can add up to \(TaskifyWatchSpokenTaskBatchParser.maximumTaskCount) tasks at once. No tasks were added."
    }
}

enum TaskifyWatchShortcutDialog {
    static func added(
        titles: [String],
        submission: TaskifyWatchShortcutSubmission
    ) -> IntentDialog {
        let names = titles.prefix(3).map { "\"\($0)\"" }.joined(separator: ", ")
        let remainder = titles.count - min(titles.count, 3)
        let items = remainder > 0 ? "\(names), and \(remainder) more" : names
        let destination = submission.boardName
        switch submission.syncState {
        case .syncingThroughPhone:
            return "Saved \(items) to \(destination). It is syncing through your iPhone."
        case .syncedDirectly:
            return "Added \(items) to \(destination) directly from Apple Watch."
        case .savedForLater:
            return "Saved \(items) to \(destination). It will sync when your iPhone or Watch connection is available."
        }
    }

    static func completed(
        title: String,
        submission: TaskifyWatchShortcutSubmission
    ) -> IntentDialog {
        switch submission.syncState {
        case .syncingThroughPhone:
            return "Completed \(title). The change is syncing through your iPhone."
        case .syncedDirectly:
            return "Completed \(title) directly from Apple Watch."
        case .savedForLater:
            return "Marked \(title) complete. It will sync when your iPhone or Watch connection is available."
        }
    }
}
