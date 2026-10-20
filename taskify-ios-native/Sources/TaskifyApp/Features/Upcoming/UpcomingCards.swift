import EventKit
import SwiftUI
import TaskifyCore
import UIKit

struct UpcomingGroup: Identifiable {
    let date: Date
    let tasks: [TaskItem]
    let taskifyEvents: [TaskifyEvent]
    let appleEvents: [DeviceCalendarEvent]
    let reminders: [DeviceReminder]
    let holidays: [UsHoliday]
    var id: Date { date }
}

struct DeviceReminderCard: View {
    let reminder: DeviceReminder
    let isCompleting: Bool
    var notificationMinutes: Int? = nil
    var onSetNotification: ((TaskReminder?) -> Void)? = nil
    let onComplete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onComplete) {
                ZStack {
                    Circle()
                        .stroke(Color(uiColor: reminder.color), lineWidth: 2)
                        .frame(width: 30, height: 30)

                    if isCompleting {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(Color(uiColor: reminder.color))
                    }
                }
                .frame(width: 42, height: 42)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isCompleting)
            .accessibilityLabel("Complete \(reminder.title)")
            .accessibilityHint("Marks this reminder complete in Apple Reminders")

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(reminder.title)
                        .scaledFont(size: 16, weight: .semibold)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if notificationMinutes != nil {
                        Image(systemName: "bell.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .accessibilityLabel("Notification reminder scheduled")
                    }

                    if reminder.priority > 0, reminder.priority <= 4 {
                        Image(systemName: "exclamationmark")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color.red)
                            .accessibilityLabel("High priority")
                    }
                }

                Text(dueText)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let notes = reminder.notes {
                    Text(notes)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(3)
                }

                Text(reminder.calendarTitle)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(uiColor: reminder.color))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 20)
        .notificationReminderContextMenu(
            currentMinutes: notificationMinutes,
            onSet: onSetNotification
        )
    }

    private var dueText: String {
        reminder.isAllDay
            ? "Apple Reminder"
            : "Due \(reminder.dueDate.formatted(.dateTime.hour().minute()))"
    }
}

struct TaskifyEventCard: View {
    @Environment(AppModel.self) private var model
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    @State private var showingEditor = false
    let event: TaskifyEvent
    let showDate: Bool
    let allowsSelection: Bool

    init(event: TaskifyEvent, showDate: Bool = false, allowsSelection: Bool = false) {
        self.event = event
        self.showDate = showDate
        self.allowsSelection = allowsSelection
    }

    private var isSelecting: Bool {
        allowsSelection && selection?.isActive == true
    }

    private var isSelected: Bool {
        selection?.selectedEventIDs.contains(event.id) == true
    }

    var body: some View {
        Group {
            if isSelecting {
                Button {
                    selection?.toggleEvent(event.id)
                } label: {
                    cardContent
                }
                .buttonStyle(.plain)
            } else if event.isReadOnly {
                cardContent
            } else {
                Button {
                    showingEditor = true
                } label: {
                    cardContent
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showingEditor) {
            TaskifyEventEditorSheet(event: event)
                .environment(model)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    private var cardContent: some View {
        HStack(alignment: .top, spacing: 12) {
            if isSelecting {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .scaledFont(size: 22, weight: .semibold)
                    .foregroundStyle(isSelected ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                    .frame(width: 24, height: 38)
            }

            Image(systemName: "calendar.badge.clock")
                .scaledFont(size: 16, weight: .semibold)
                .foregroundStyle(Color.green)
                .frame(width: 38, height: 38)
                .background(Color.green.opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(event.title)
                        .scaledFont(size: 16, weight: .semibold)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Text(timeText)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let summary = event.summary {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(2)
                }

                if let location = event.locations?.first {
                    Label(location, systemImage: "mappin.and.ellipse")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(2)
                }

                if event.reminders?.isEmpty == false || event.recurrence?.isActive == true {
                    HStack(spacing: 10) {
                        if let reminders = event.reminders, !reminders.isEmpty {
                            Label(
                                reminders.count == 1 ? reminders[0].eventLabel : "\(reminders.count) reminders",
                                systemImage: "bell.fill"
                            )
                        }
                        if event.recurrence?.isActive == true {
                            Label("Repeats", systemImage: "repeat")
                        }
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                }

                HStack(spacing: 5) {
                    Text("Taskify event")
                    if let boardID = event.boardID,
                       let board = model.board(withID: boardID) {
                        Text("· \(board.name)")
                    }
                    if event.rsvpStatus == .tentative {
                        Text("· Maybe")
                    }
                    if !event.isReadOnly {
                        Image(systemName: "pencil")
                    }
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.green)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 20)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isSelecting
            ? "\(event.title), \(isSelected ? "selected" : "not selected")"
            : event.title)
        .accessibilityHint(isSelecting
            ? "Toggles this event in the current selection"
            : (event.isReadOnly
                ? "A read-only Taskify event shared through Nostr"
                : "Opens the Taskify event editor"))
    }

    private var timeText: String {
        guard let start = event.startDate else { return "Date unavailable" }
        if event.isAllDay {
            guard let end = event.endDate,
                  !Calendar.current.isDate(start, inSameDayAs: end) else {
                if showDate {
                    return "All-day · \(start.formatted(date: .abbreviated, time: .omitted))"
                }
                return "All-day"
            }
            return "All-day · \(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))"
        }
        guard let end = event.endDate else {
            let time = formattedTime(start)
            guard showDate else { return time }
            return "\(start.formatted(date: .abbreviated, time: .omitted)) · \(time)"
        }
        let timeZoneSuffix = event.startTimeZoneID
            .flatMap(TimeZone.init(identifier:))
            .flatMap { $0.abbreviation(for: start) }
            .map { " · \($0)" } ?? ""
        let timeRange = "\(formattedTime(start)) – \(formattedTime(end))\(timeZoneSuffix)"
        guard showDate else { return timeRange }
        return "\(start.formatted(date: .abbreviated, time: .omitted)) · \(timeRange)"
    }

    private func formattedTime(_ date: Date) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = event.startTimeZoneID.flatMap(TimeZone.init(identifier:)) ?? .current
        return date.formatted(style)
    }
}

struct DeviceCalendarEventCard: View {
    let event: DeviceCalendarEvent
    var notificationMinutes: Int? = nil
    var onSetNotification: ((TaskReminder?) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "calendar")
                .scaledFont(size: 16, weight: .semibold)
                .foregroundStyle(Color(uiColor: event.color))
                .frame(width: 38, height: 38)
                .background(Color(uiColor: event.color).opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(event.title)
                        .scaledFont(size: 16, weight: .semibold)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if notificationMinutes != nil {
                        Image(systemName: "bell.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .accessibilityLabel("Notification reminder scheduled")
                    }
                }

                Text(timeText)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let location = event.location {
                    Label(location, systemImage: "mappin.and.ellipse")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(2)
                }

                Text(event.calendarTitle)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(uiColor: event.color))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 20)
        .accessibilityElement(children: .combine)
        .notificationReminderContextMenu(
            currentMinutes: notificationMinutes,
            onSet: onSetNotification
        )
    }

    private var timeText: String {
        if event.isAllDay { return "All-day" }
        let start = event.startDate.formatted(.dateTime.hour().minute())
        let end = event.endDate.formatted(.dateTime.hour().minute())
        return "\(start) – \(end)"
    }
}

struct UsHolidayCard: View {
    let holiday: UsHoliday

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "star.fill")
                .scaledFont(size: 16, weight: .semibold)
                .foregroundStyle(Color.pink)
                .frame(width: 38, height: 38)
                .background(Color.pink.opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(holiday.title)
                    .scaledFont(size: 16, weight: .semibold)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(holiday.summary)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.pink)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 20)
        .accessibilityElement(children: .combine)
    }
}

struct UpcomingTaskList: View {
    @Environment(AppModel.self) private var model
    @Environment(\.taskifyOverPhoto) private var overPhoto
    let tasks: [TaskItem]
    let boardGrouping: UpcomingBoardGrouping

    private var sections: [UpcomingBoardSection] {
        var seen = Set<String>()
        let boardIDs = tasks.compactMap { task in
            seen.insert(task.boardID).inserted ? task.boardID : nil
        }
        return boardIDs.map { boardID in
            UpcomingBoardSection(
                boardID: boardID,
                tasks: tasks.filter { $0.boardID == boardID }
            )
        }
    }

    var body: some View {
        // The checkbox lives in TaskCardView; without this its press feedback (and the
        // touch-down completion) waits out the enclosing scroll view's touch delay.
        ImmediateScrollTouchDelivery().frame(width: 0, height: 0)
        if boardGrouping == .grouped {
            ForEach(sections) { section in
                Text(model.board(withID: section.boardID)?.name ?? "Board")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.accent)
                    .textCase(.uppercase)
                    .tracking(0.7)
                    .taskifyLegibilityShadow(overPhoto)
                    .padding(.top, 2)

                ForEach(section.tasks) { task in
                    TaskCardView(task: task, context: model.cardContext(for: task)).equatable()
                }
            }
        } else {
            ForEach(tasks) { task in
                VStack(alignment: .leading, spacing: 4) {
                    // This label has no card under it at all — it sits on the wallpaper. Tertiary
                    // grey is legible on the standard gradient and invisible on a bright sky, so
                    // step it up one level rather than darkening what is behind it.
                    Text(model.board(withID: task.boardID)?.name ?? "Board")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(overPhoto ? TaskifyTheme.secondaryText : TaskifyTheme.tertiaryText)
                        .taskifyLegibilityShadow(overPhoto)
                        .padding(.leading, 10)
                    TaskCardView(task: task, context: model.cardContext(for: task)).equatable()
                }
            }
        }
    }
}

struct UpcomingBoardSection: Identifiable {
    let boardID: String
    let tasks: [TaskItem]
    var id: String { boardID }
}

struct NotificationReminderContextMenu: ViewModifier {
    let currentMinutes: Int?
    let onSet: ((TaskReminder?) -> Void)?

    func body(content: Content) -> some View {
        content.contextMenu {
            if let onSet {
                Menu {
                    ForEach(TaskReminder.timedPresets) { preset in
                        Button {
                            onSet(preset)
                        } label: {
                            if preset.minutesBefore == currentMinutes {
                                Label(preset.reminderMenuLabel, systemImage: "checkmark")
                            } else {
                                Text(preset.reminderMenuLabel)
                            }
                        }
                    }
                    if currentMinutes != nil {
                        Divider()
                        Button(role: .destructive) {
                            onSet(nil)
                        } label: {
                            Label("Remove reminder", systemImage: "bell.slash")
                        }
                    }
                } label: {
                    Label(currentMinutes == nil ? "Remind me" : "Remind me…", systemImage: "bell")
                }
            }
        }
    }
}

extension TaskReminder {
    /// Menu labels for Apple Calendar / Apple Reminder items: the item itself is the anchor,
    /// so use the event-style labels ("At start time") and rename the due-style fallback.
    var reminderMenuLabel: String {
        switch rawValue {
        case "0h": return "At start/due time"
        default: return eventLabel
        }
    }
}

extension View {
    func notificationReminderContextMenu(
        currentMinutes: Int?,
        onSet: ((TaskReminder?) -> Void)?
    ) -> some View {
        modifier(NotificationReminderContextMenu(currentMinutes: currentMinutes, onSet: onSet))
    }
}
