import EventKit
import Foundation
import TaskifyCore

/// Reads Apple Calendar events and Reminders for the Upcoming widget.
///
/// Read live rather than from a cache the app refreshes. A cache would go stale exactly when the
/// app hasn't been opened -- which is when a widget matters most -- and stale calendar data is the
/// same class of problem as the task count that used to disagree with the app.
///
/// Deliberately never requests access. A widget has nowhere to show a permission prompt, so if the
/// user hasn't already granted Calendar or Reminders access in the app, this returns nothing and
/// the widget simply shows tasks. Access granted to the app covers this extension: TCC is keyed to
/// the containing app.
enum DeviceItemsReader {
    static func upcomingItems(from start: Date, days: Int = 14, limit: Int = 12) async -> [TaskifyWidgetTask] {
        let store = EKEventStore()
        let end = Calendar.current.date(byAdding: .day, value: days, to: start) ?? start
        let events = calendarEvents(store: store, start: start, end: end)
        let reminders = await reminders(store: store, start: start, end: end)
        let merged = events + reminders
        return Array(merged
            .sorted { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }
            .prefix(limit))
    }

    private static func calendarEvents(store: EKEventStore, start: Date, end: Date) -> [TaskifyWidgetTask] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return [] }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate).map { event in
            TaskifyWidgetTask(
                id: "cal-\(event.eventIdentifier ?? UUID().uuidString)",
                title: event.title ?? "Event",
                boardID: "",
                boardName: event.calendar?.title ?? "",
                dueDate: event.startDate,
                endDate: event.endDate,
                isAllDay: event.isAllDay,
                kind: .calendar
            )
        }
    }

    private static func reminders(store: EKEventStore, start: Date, end: Date) async -> [TaskifyWidgetTask] {
        guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else { return [] }
        let predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: start,
            ending: end,
            calendars: nil
        )
        let fetched: [EKReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
        }
        return fetched.compactMap { reminder in
            guard let due = reminder.dueDateComponents?.date else { return nil }
            return TaskifyWidgetTask(
                id: "rem-\(reminder.calendarItemIdentifier)",
                title: reminder.title ?? "Reminder",
                boardID: "",
                boardName: reminder.calendar?.title ?? "",
                dueDate: due,
                isAllDay: reminder.dueDateComponents?.hour == nil,
                kind: .reminder
            )
        }
    }
}
