import Foundation

/// Copying and pasting tasks as JSON, interchangeable with the PWA: its "Copy Task" writes the
/// task as JSON and pasting that into a board's New Task field creates it there. The payload is
/// the shared-task shape (`SharedTaskDelivery`), whose keys the PWA's paste import reads.
public enum TaskClipboard {
    /// The task as clipboard JSON. Relays, assignment state and the source id stay behind; a
    /// pasted task is a new, unassigned copy.
    public static func string(for task: TaskItem) -> String? {
        var delivery = SharedTaskDelivery(task: task, relayURLs: [])
        delivery.relayURLs = nil
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(delivery) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The tasks in pasted text: a JSON object, or an array of them, each with a title. Nil when
    /// the text isn't that, so it can be added as an ordinary title. Fields that don't decode
    /// (a client's extra or differently shaped keys) are dropped rather than losing the task.
    public static func tasks(in text: String) -> [SharedTaskDelivery]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first, first == "{" || first == "[",
              let data = trimmed.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) else { return nil }
        let objects: [[String: Any]]
        if let object = root as? [String: Any] {
            objects = [object]
        } else if let array = root as? [[String: Any]], !array.isEmpty {
            objects = array
        } else {
            return nil
        }
        let deliveries = objects.compactMap(delivery(from:))
        return deliveries.count == objects.count ? deliveries : nil
    }

    private static let copiedKeys = [
        "note", "priority", "dueISO", "dueDateEnabled", "dueTimeEnabled", "dueTimeZone",
        "reminders", "subtasks", "recurrence", "documents",
    ]

    private static func delivery(from object: [String: Any]) -> SharedTaskDelivery? {
        guard let title = (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty else { return nil }
        var kept: [String: Any] = ["title": title]
        for key in copiedKeys {
            guard let value = object[key], !(value is NSNull) else { continue }
            if decode(["title": title, key: value]) != nil { kept[key] = value }
        }
        return decode(kept)
    }

    private static func decode(_ object: [String: Any]) -> SharedTaskDelivery? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(SharedTaskDelivery.self, from: data)
    }
}

extension TaskifySnapshot {
    /// Adds a pasted task to a column. On a week board it takes that column's day this week,
    /// keeping its time of day; on a list it keeps its own date, if it had one.
    @discardableResult
    public mutating func addPastedTask(
        _ delivery: SharedTaskDelivery,
        boardID: String,
        columnID: String,
        authorPublicKey: String? = nil,
        newTaskPosition: NewTaskPosition = .top,
        now: Date = Date(),
        weekStartsOn: WeekdayColumn = .sunday,
        calendar: Calendar = .current
    ) -> TaskItem? {
        guard let board = boards.first(where: { $0.id == boardID }) else { return nil }
        var taskCalendar = calendar
        let timeZone = delivery.dueTimeEnabled == true
            ? delivery.dueTimeZone.flatMap(TimeZone.init(identifier:))
            : nil
        if let timeZone { taskCalendar.timeZone = timeZone }

        var dueDate = delivery.dueDateEnabled == false ? nil : delivery.dueDate
        switch board.kind {
        case .week:
            guard let weekday = WeekdayColumn(rawValue: columnID) else { return nil }
            let day = WeekDateResolver.date(
                for: weekday, inWeekContaining: now, weekStartsOn: weekStartsOn, calendar: taskCalendar
            )
            if delivery.dueTimeEnabled == true, let source = dueDate {
                let time = taskCalendar.dateComponents([.hour, .minute], from: source)
                dueDate = taskCalendar.date(
                    bySettingHour: time.hour ?? 0, minute: time.minute ?? 0, second: 0, of: day
                ) ?? day
            } else {
                dueDate = day
            }
        case .list:
            break
        case .compound, .bible:
            return nil
        }

        guard let added = addTask(
            title: delivery.title,
            boardID: boardID,
            columnID: columnID,
            dueDate: dueDate,
            note: delivery.note ?? "",
            priority: delivery.priority.flatMap(TaskPriority.init(rawValue:)),
            authorPublicKey: authorPublicKey,
            newTaskPosition: newTaskPosition,
            now: now,
            weekStartsOn: weekStartsOn,
            calendar: calendar
        ), let index = tasks.firstIndex(where: { $0.id == added.id }) else { return nil }

        let hasDate = tasks[index].dueDateEnabled
        let timed = hasDate && delivery.dueTimeEnabled == true
        tasks[index].dueTimeEnabled = timed
        tasks[index].dueTimeZone = timed ? timeZone?.identifier : nil
        // Fresh subtask ids: the copy is a new task, not the source's twin.
        let subtasks = (delivery.subtasks ?? []).map { TaskSubtask(title: $0.title, completed: $0.completed) }
        tasks[index].subtasks = subtasks.isEmpty ? nil : subtasks
        tasks[index].documents = delivery.documents?.isEmpty == false ? delivery.documents : nil
        if hasDate {
            tasks[index].reminders = delivery.reminders?.isEmpty == false ? delivery.reminders : nil
            if let recurrence = delivery.recurrence, recurrence.isActive {
                tasks[index].recurrence = recurrence
                tasks[index].seriesID = added.id
            }
        }
        return tasks[index]
    }
}
