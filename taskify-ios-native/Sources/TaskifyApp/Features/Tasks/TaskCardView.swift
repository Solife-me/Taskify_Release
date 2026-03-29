import SwiftUI
import TaskifyCore

struct TaskCardView: View {
    let task: BoardTaskItem
    var metaLabel: String? = nil
    var priority: Int? = nil
    var subtasksJSON: String? = nil
    var dueTimeEnabled: Bool = false
    var streak: Int? = nil
    var hasRecurrence: Bool = false
    var hideCompletedSubtasks: Bool = false
    var onToggleComplete: (() -> Void)? = nil
    var onTap: (() -> Void)? = nil
    var onToggleSubtask: ((String) -> Void)? = nil

    @Environment(\.appAccent) private var accentChoice

    private var accentColor: Color { ThemeColors.accent(for: accentChoice) }

    private var parsedSubtasks: [Subtask] {
        guard let json = subtasksJSON, let data = json.data(using: .utf8),
              let arr = try? JSONDecoder().decode([Subtask].self, from: data) else { return [] }
        return arr
    }

    private var visibleSubtasks: [Subtask] {
        let subs = parsedSubtasks
        if hideCompletedSubtasks {
            return subs.filter { !$0.completed }
        }
        return subs
    }

    private var priorityLevel: TaskPriority {
        TaskPriority(rawValue: priority ?? 0) ?? .none
    }

    private var formattedDueDate: String? {
        guard let iso = task.dueISO, !iso.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }

        let cal = Calendar.current
        if cal.isDateInToday(date) { return dueTimeEnabled ? "Today \(timeString(date))" : "Today" }
        if cal.isDateInTomorrow(date) { return dueTimeEnabled ? "Tomorrow \(timeString(date))" : "Tomorrow" }
        if cal.isDateInYesterday(date) { return dueTimeEnabled ? "Yesterday \(timeString(date))" : "Yesterday" }

        let df = DateFormatter()
        df.dateFormat = dueTimeEnabled ? "EEE, MMM d 'at' h:mm a" : "EEE, MMM d"
        return df.string(from: date)
    }

    private func timeString(_ date: Date) -> String {
        let df = DateFormatter()
        df.dateFormat = "h:mm a"
        return df.string(from: date)
    }

    private var isOverdue: Bool {
        guard let iso = task.dueISO, !iso.isEmpty, !task.completed else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return false }
        return date < Date()
    }

    private var subtaskSummary: String? {
        let subs = parsedSubtasks
        guard !subs.isEmpty else { return nil }
        let done = subs.filter(\.completed).count
        return "\(done)/\(subs.count)"
    }

    var body: some View {
        Button(action: { onTap?() }) {
            HStack(alignment: .top, spacing: 12) {
                // Completion button
                Button(action: {
                    PlatformServices.impactLight()
                    onToggleComplete?()
                }) {
                    Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(task.completed ? accentColor : .secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 4) {
                    // Title row with priority
                    HStack(spacing: 4) {
                        if priorityLevel != .none {
                            Text(priorityLevel.marks)
                                .font(.subheadline.bold())
                                .foregroundStyle(priorityColor)
                        }
                        Text(task.title)
                            .font(.subheadline)
                            .strikethrough(task.completed, color: .secondary)
                            .foregroundStyle(task.completed ? .secondary : .primary)
                            .lineLimit(3)
                    }

                    // Note preview (1 line, matches PWA card rendering)
                    if let note = task.note, !note.isEmpty, !task.completed {
                        Text(note)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }

                    if let metaLabel, !metaLabel.isEmpty {
                        Text(metaLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    // Meta row: due date, streak, recurrence, subtask count
                    let hasMeta = formattedDueDate != nil || hasRecurrence || subtaskSummary != nil
                    if hasMeta {
                        HStack(spacing: 8) {
                            if let due = formattedDueDate {
                                Label(due, systemImage: "calendar")
                                    .font(.caption)
                                    .foregroundStyle(isOverdue ? .red : .secondary)
                            }

                            if hasRecurrence {
                                Image(systemName: "repeat")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            if let s = streak, s > 0, hasRecurrence {
                                HStack(spacing: 2) {
                                    Image(systemName: "flame.fill")
                                        .foregroundStyle(.orange)
                                    Text("\(s)")
                                }
                                .font(.caption)
                            }

                            if let summary = subtaskSummary {
                                Label(summary, systemImage: "checklist")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    // Inline subtasks (collapsed to first 3)
                    let subs = visibleSubtasks
                    if !subs.isEmpty && !task.completed {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(subs.prefix(3)) { sub in
                                HStack(spacing: 6) {
                                    Button(action: {
                                        PlatformServices.impactLight()
                                        onToggleSubtask?(sub.id)
                                    }) {
                                        Image(systemName: sub.completed ? "checkmark.square.fill" : "square")
                                            .font(.caption)
                                            .foregroundStyle(sub.completed ? accentColor : .secondary)
                                    }
                                    .buttonStyle(.plain)

                                    Text(sub.title)
                                        .font(.caption)
                                        .strikethrough(sub.completed)
                                        .foregroundStyle(sub.completed ? .secondary : .primary)
                                        .lineLimit(1)
                                }
                            }
                            if parsedSubtasks.count > 3 {
                                let remaining = parsedSubtasks.count - 3
                                Text("+\(remaining) more")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.top, 2)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 14)
            .background(ThemeColors.surfaceBase)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var priorityColor: Color {
        ThemeColors.priorityColor(priority)
    }
}
