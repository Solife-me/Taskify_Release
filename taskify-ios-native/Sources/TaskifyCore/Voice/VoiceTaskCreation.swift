import Foundation
import TaskifyWatchShared

public extension TaskifySnapshot {
    /// Used on a snapshot copy for approval and on the live snapshot for saving.
    mutating func addVoiceTasks(
        _ voiceTasks: [VoiceFinalTask], defaultBoardID: String?, taskIDPrefix: String? = nil,
        authorPublicKey: String? = nil, newTaskPosition: NewTaskPosition = .top,
        weekStart: WeekdayColumn = .sunday, calendar: Calendar = .current, now: Date = Date()
    ) -> [TaskItem] {
        guard let requestedBoard = defaultBoardID.flatMap({ id in boards.first { $0.id == id } }) else { return [] }
        let defaultBoard: Board
        switch requestedBoard.kind {
        case .week, .list:
            defaultBoard = requestedBoard
        case .compound:
            guard let child = compoundChildBoards(for: requestedBoard.id).first else { return [] }
            defaultBoard = child
        case .bible:
            return []
        }

        var createdTaskIDs: [String] = []
        for (taskIndex, voiceTask) in voiceTasks.enumerated() {
            let title = voiceTask.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }

            let stableTaskID = taskIDPrefix.map { "\($0)-\(taskIndex)" }
            if let stableTaskID, self.tasks.contains(where: { $0.id == stableTaskID }) {
                createdTaskIDs.append(stableTaskID)
                continue
            }

            let dueDate = voiceTask.dueISO.flatMap { VoiceTaskDate.parse($0, timeZone: calendar.timeZone) }
            let hasExplicitTime = VoiceTaskDate.hasExplicitTime(voiceTask.dueISO)
            let effectiveDate = dueDate ?? now

            // Model-routed placement wins when it resolves to a usable board;
            // otherwise the task lands on the session's default board.
            let routedBoard = voiceTask.boardId.flatMap { id in boards.first { $0.id == id } }
            let board: Board
            if let routed = routedBoard {
                switch routed.kind {
                case .week, .list:
                    board = routed
                case .compound:
                    board = compoundChildBoards(for: routed.id).first ?? defaultBoard
                case .bible:
                    board = defaultBoard
                }
            } else {
                board = defaultBoard
            }

            let columnID: String?
            switch board.kind {
            case .week:
                columnID = WeekdayColumn.containing(effectiveDate, calendar: calendar).rawValue
            case .list:
                let orderedColumns = board.columns.sorted { $0.order < $1.order }
                if let requestedColumn = voiceTask.columnId,
                   orderedColumns.contains(where: { $0.id == requestedColumn }) {
                    columnID = requestedColumn
                } else {
                    columnID = orderedColumns.first?.id
                }
            case .compound, .bible:
                columnID = nil
            }

            guard let task = addTask(
                id: stableTaskID ?? UUID().uuidString,
                title: title,
                boardID: board.id,
                columnID: columnID,
                dueDate: board.kind == .week ? effectiveDate : dueDate,
                note: voiceTask.notes ?? "",
                priority: voiceTask.priority.flatMap(TaskPriority.init(rawValue:)),
                authorPublicKey: authorPublicKey,
                newTaskPosition: newTaskPosition,
                now: now,
                weekStartsOn: weekStart,
                calendar: calendar
            ) else { continue }

            let subtasks = (voiceTask.subtasks ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            let reminders = Self.voiceReminders(
                minutes: voiceTask.reminderMinutesBeforeDue,
                dateOnly: !hasExplicitTime
            )
            let recurrence = voiceTask.recurrence?.taskRecurrence
            updateTask(
                taskID: task.id,
                title: task.title,
                note: task.note,
                dueDate: task.dueDate,
                dueDateEnabled: task.dueDate != nil,
                dueTimeEnabled: hasExplicitTime,
                dueTimeZone: hasExplicitTime ? calendar.timeZone.identifier : nil,
                priority: task.priority,
                columnID: task.columnID,
                subtasks: subtasks.map { TaskSubtask(title: $0) },
                recurrence: recurrence,
                reminders: reminders,
                reminderTime: hasExplicitTime ? nil : voiceTask.reminderTime,
                editorPublicKey: authorPublicKey,
                calendar: calendar,
                weekStartsOn: weekStart,
                now: now
            )

            createdTaskIDs.append(task.id)
        }
        return createdTaskIDs.compactMap { id in self.tasks.first { $0.id == id } }
    }

    static func voiceReminders(minutes: [Int]?, dateOnly: Bool) -> [TaskReminder] {
        guard let minutes, !minutes.isEmpty else { return [] }
        var seen = Set<String>()
        var reminders: [TaskReminder] = []
        for value in minutes where value >= 0 {
            let reminder = TaskReminder(minutesBefore: value, dateOnly: dateOnly)
            if seen.insert(reminder.rawValue).inserted {
                reminders.append(reminder)
            }
        }
        return reminders
    }

}
