import Foundation

/// What the task editor edits, and how a save combines it with the task as it is now (C8-2).
///
/// The editor records these fields when it opens. On Save, a field the user changed takes the
/// edited value; a field the user left alone takes the task's current value, which may have
/// changed meanwhile on another device, from the widget or through Siri. Fields that only make
/// sense together (the schedule, the reminders, the attachments) move as one group. Subtasks
/// merge item by item.
public struct TaskEditorFields: Equatable, Sendable {
    public struct Schedule: Equatable, Sendable {
        public var dueDate: Date?
        public var dueDateEnabled: Bool
        public var dueTimeEnabled: Bool
        public var dueTimeZone: String?
        public var recurrence: TaskRecurrence?

        public init(
            dueDate: Date?,
            dueDateEnabled: Bool,
            dueTimeEnabled: Bool,
            dueTimeZone: String?,
            recurrence: TaskRecurrence?
        ) {
            self.dueDate = dueDate
            self.dueDateEnabled = dueDateEnabled
            self.dueTimeEnabled = dueTimeEnabled
            self.dueTimeZone = dueTimeZone
            self.recurrence = recurrence
        }
    }

    public struct Reminders: Equatable, Sendable {
        public var reminders: [TaskReminder]
        public var reminderTime: String?

        public init(reminders: [TaskReminder], reminderTime: String?) {
            self.reminders = reminders
            self.reminderTime = reminderTime
        }
    }

    public struct Attachments: Equatable, Sendable {
        public var images: [String]
        public var documents: [TaskDocument]

        public init(images: [String], documents: [TaskDocument]) {
            self.images = images
            self.documents = documents
        }
    }

    public var title: String
    public var note: String
    public var schedule: Schedule
    public var priority: TaskPriority?
    public var columnID: String?
    public var subtasks: [TaskSubtask]
    public var reminders: Reminders
    public var attachments: Attachments

    public init(
        title: String,
        note: String,
        schedule: Schedule,
        priority: TaskPriority?,
        columnID: String?,
        subtasks: [TaskSubtask],
        reminders: Reminders,
        attachments: Attachments
    ) {
        self.title = title
        self.note = note
        self.schedule = schedule
        self.priority = priority
        self.columnID = columnID
        self.subtasks = subtasks
        self.reminders = reminders
        self.attachments = attachments
    }

    /// The fields as the task holds them.
    public init(task: TaskItem) {
        self.init(
            title: task.title,
            note: task.note,
            schedule: Schedule(
                dueDate: task.dueDate,
                dueDateEnabled: task.dueDateEnabled,
                dueTimeEnabled: task.dueTimeEnabled,
                dueTimeZone: task.dueTimeZone,
                recurrence: task.recurrence
            ),
            priority: task.priority,
            columnID: task.columnID,
            subtasks: task.subtasks ?? [],
            reminders: Reminders(reminders: task.reminders ?? [], reminderTime: task.reminderTime),
            attachments: Attachments(images: task.images ?? [], documents: task.documents ?? [])
        )
    }

    /// The fields to save: `edited` where the user changed something since `opened`, `current`
    /// everywhere else.
    public static func merging(
        opened: TaskEditorFields,
        edited: TaskEditorFields,
        current: TaskEditorFields
    ) -> TaskEditorFields {
        func pick<Value: Equatable>(_ field: KeyPath<TaskEditorFields, Value>) -> Value {
            edited[keyPath: field] != opened[keyPath: field] ? edited[keyPath: field] : current[keyPath: field]
        }
        return TaskEditorFields(
            title: pick(\.title),
            note: pick(\.note),
            schedule: pick(\.schedule),
            priority: pick(\.priority),
            columnID: pick(\.columnID),
            subtasks: mergedSubtasks(opened: opened.subtasks, edited: edited.subtasks, current: current.subtasks),
            reminders: pick(\.reminders),
            attachments: pick(\.attachments)
        )
    }

    /// The edited list in its order, with each subtask the user left alone taken as it is now
    /// (or dropped, if it was removed meanwhile), followed by subtasks added elsewhere.
    static func mergedSubtasks(
        opened: [TaskSubtask],
        edited: [TaskSubtask],
        current: [TaskSubtask]
    ) -> [TaskSubtask] {
        let openedByID = Dictionary(opened.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let currentByID = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var merged: [TaskSubtask] = []
        for subtask in edited {
            guard let before = openedByID[subtask.id] else {
                merged.append(subtask) // added here
                continue
            }
            if subtask != before {
                merged.append(subtask) // changed here
            } else if let now = currentByID[subtask.id] {
                merged.append(now) // untouched here: as it is now
            }
        }
        let known = Set(opened.map(\.id)).union(edited.map(\.id))
        merged.append(contentsOf: current.filter { !known.contains($0.id) })
        return merged
    }
}
