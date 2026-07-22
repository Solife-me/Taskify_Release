import EventKit
import Foundation
import UIKit

struct DeviceCalendarEvent: Identifiable {
    let id: String
    let title: String
    let calendarTitle: String
    let startDate: Date
    let endDate: Date
    let isAllDay: Bool
    let location: String?
    let color: UIColor

    init(event: EKEvent) {
        let occurrence = Int(event.startDate.timeIntervalSince1970)
        id = "\(event.eventIdentifier ?? event.calendarItemIdentifier)-\(occurrence)"
        let trimmedTitle = event.title.trimmingCharacters(in: .whitespacesAndNewlines)
        title = trimmedTitle.isEmpty ? "Untitled event" : trimmedTitle
        calendarTitle = event.calendar.title
        startDate = event.startDate
        endDate = event.endDate
        isAllDay = event.isAllDay
        location = event.location?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        color = event.calendar.cgColor.map(UIColor.init(cgColor:)) ?? .systemOrange
    }
}

struct DeviceReminder: Identifiable {
    let id: String
    let title: String
    let calendarTitle: String
    let dueDate: Date
    let isAllDay: Bool
    let notes: String?
    let priority: Int
    let color: UIColor

    init?(reminder: EKReminder) {
        guard let components = reminder.dueDateComponents,
              let dueDate = Self.date(from: components) else { return nil }
        id = reminder.calendarItemIdentifier
        let trimmedTitle = reminder.title.trimmingCharacters(in: .whitespacesAndNewlines)
        title = trimmedTitle.isEmpty ? "Untitled reminder" : trimmedTitle
        calendarTitle = reminder.calendar.title
        self.dueDate = dueDate
        isAllDay = components.hour == nil
        notes = reminder.notes?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        priority = reminder.priority
        color = reminder.calendar.cgColor.map(UIColor.init(cgColor:)) ?? .systemPurple
    }

    private static func date(from components: DateComponents) -> Date? {
        var calendar = components.calendar ?? Calendar.current
        if let timeZone = components.timeZone {
            calendar.timeZone = timeZone
        }
        return calendar.date(from: components)
    }
}

@MainActor
final class DeviceCalendarStore: ObservableObject {
    @Published private(set) var authorizationStatus: EKAuthorizationStatus
    @Published private(set) var reminderAuthorizationStatus: EKAuthorizationStatus
    @Published private(set) var events: [DeviceCalendarEvent] = []
    @Published private(set) var reminders: [DeviceReminder] = []
    @Published private(set) var isRequestingAccess = false
    @Published private(set) var isRequestingReminderAccess = false
    @Published private(set) var completingReminderIDs = Set<String>()
    @Published private(set) var calendarErrorMessage: String?
    @Published private(set) var reminderErrorMessage: String?

    private let eventStore: EKEventStore
    private var fetchScope = FetchScope.month(Date())
    private var storeChangeObserver: NSObjectProtocol?
    private var reminderFetchGeneration = UUID()

    private enum FetchScope {
        case month(Date)
        case upcoming(Date, monthsAhead: Int)
    }

    init(eventStore: EKEventStore = EKEventStore()) {
        self.eventStore = eventStore
        authorizationStatus = EKEventStore.authorizationStatus(for: .event)
        reminderAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
        storeChangeObserver = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged,
            object: eventStore,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshActiveRange()
            }
        }
    }

    deinit {
        if let storeChangeObserver {
            NotificationCenter.default.removeObserver(storeChangeObserver)
        }
    }

    var hasFullAccess: Bool {
        authorizationStatus == .fullAccess
    }

    var accessWasDenied: Bool {
        authorizationStatus == .denied || authorizationStatus == .restricted
    }

    var hasReminderFullAccess: Bool {
        reminderAuthorizationStatus == .fullAccess
    }

    var reminderAccessWasDenied: Bool {
        reminderAuthorizationStatus == .denied || reminderAuthorizationStatus == .restricted
    }

    func refresh(monthContaining date: Date) {
        fetchScope = .month(date)
        refreshActiveRange()
    }

    func refreshUpcoming(from date: Date = Date(), monthsAhead: Int = 12) {
        fetchScope = .upcoming(date, monthsAhead: max(1, monthsAhead))
        refreshActiveRange()
    }

    func requestAccess(monthContaining date: Date) {
        fetchScope = .month(date)
        requestCalendarAccess()
    }

    func requestAccessForUpcoming(from date: Date = Date(), monthsAhead: Int = 12) {
        fetchScope = .upcoming(date, monthsAhead: max(1, monthsAhead))
        requestCalendarAccess()
    }

    private func requestCalendarAccess() {
        guard !isRequestingAccess else { return }

        authorizationStatus = EKEventStore.authorizationStatus(for: .event)
        if hasFullAccess {
            refreshCalendarEvents()
            return
        }
        guard authorizationStatus == .notDetermined else {
            events = []
            return
        }

        isRequestingAccess = true
        calendarErrorMessage = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await eventStore.requestFullAccessToEvents()
                authorizationStatus = EKEventStore.authorizationStatus(for: .event)
                isRequestingAccess = false
                refreshCalendarEvents()
            } catch {
                authorizationStatus = EKEventStore.authorizationStatus(for: .event)
                isRequestingAccess = false
                events = []
                calendarErrorMessage = error.localizedDescription
            }
        }
    }

    func requestReminderAccess(monthContaining date: Date) {
        fetchScope = .month(date)
        requestRemindersAccess()
    }

    func requestReminderAccessForUpcoming(from date: Date = Date(), monthsAhead: Int = 12) {
        fetchScope = .upcoming(date, monthsAhead: max(1, monthsAhead))
        requestRemindersAccess()
    }

    private func requestRemindersAccess() {
        guard !isRequestingReminderAccess else { return }

        reminderAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
        if hasReminderFullAccess {
            refreshReminders()
            return
        }
        guard reminderAuthorizationStatus == .notDetermined else {
            reminders = []
            return
        }

        isRequestingReminderAccess = true
        reminderErrorMessage = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await eventStore.requestFullAccessToReminders()
                reminderAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
                isRequestingReminderAccess = false
                refreshReminders()
            } catch {
                reminderAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
                isRequestingReminderAccess = false
                reminders = []
                reminderErrorMessage = error.localizedDescription
            }
        }
    }

    func events(on date: Date, calendar: Calendar = .current) -> [DeviceCalendarEvent] {
        let start = calendar.startOfDay(for: date)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return events.filter { event in
            event.startDate < end && event.endDate > start
        }
    }

    func reminders(on date: Date, calendar: Calendar = .current) -> [DeviceReminder] {
        reminders.filter { calendar.isDate($0.dueDate, inSameDayAs: date) }
    }

    func eventDates(calendar: Calendar = .current) -> Set<Date> {
        var result = Set<Date>()
        for event in events {
            var date = calendar.startOfDay(for: event.startDate)
            let inclusiveEnd = event.endDate.addingTimeInterval(-1)
            let finalDate = calendar.startOfDay(for: max(inclusiveEnd, event.startDate))
            while date <= finalDate {
                result.insert(date)
                guard let next = calendar.date(byAdding: .day, value: 1, to: date) else { break }
                date = next
            }
        }
        return result
    }

    func reminderDates(calendar: Calendar = .current) -> Set<Date> {
        Set(reminders.map { calendar.startOfDay(for: $0.dueDate) })
    }

    @discardableResult
    func completeReminder(_ reminder: DeviceReminder) -> Bool {
        guard hasReminderFullAccess,
              !completingReminderIDs.contains(reminder.id),
              let storedReminder = eventStore.calendarItem(
                withIdentifier: reminder.id
              ) as? EKReminder else { return false }

        completingReminderIDs.insert(reminder.id)
        defer { completingReminderIDs.remove(reminder.id) }
        do {
            storedReminder.isCompleted = true
            try eventStore.save(storedReminder, commit: true)
            reminders.removeAll { $0.id == reminder.id }
            reminderErrorMessage = nil
            refreshReminders()
            return true
        } catch {
            reminderErrorMessage = error.localizedDescription
            return false
        }
    }

    private func refreshActiveRange() {
        authorizationStatus = EKEventStore.authorizationStatus(for: .event)
        reminderAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
        refreshCalendarEvents()
        refreshReminders()
    }

    private func activeInterval() -> (start: Date, end: Date)? {
        let calendar = Calendar.current
        switch fetchScope {
        case let .month(date):
            guard let monthStart = calendar.date(
                from: calendar.dateComponents([.year, .month], from: date)
            ), let monthEnd = calendar.date(byAdding: .month, value: 1, to: monthStart) else {
                return nil
            }
            return (monthStart, monthEnd)
        case let .upcoming(date, monthsAhead):
            let start = calendar.startOfDay(for: date)
            guard let end = calendar.date(byAdding: .month, value: monthsAhead, to: start) else {
                return nil
            }
            return (start, end)
        }
    }

    private func refreshCalendarEvents() {
        authorizationStatus = EKEventStore.authorizationStatus(for: .event)
        guard hasFullAccess, let interval = activeInterval() else {
            events = []
            return
        }

        let predicate = eventStore.predicateForEvents(
            withStart: interval.start,
            end: interval.end,
            calendars: nil
        )
        events = eventStore.events(matching: predicate)
            .map(DeviceCalendarEvent.init(event:))
            .sorted { lhs, rhs in
                if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
                if lhs.startDate != rhs.startDate { return lhs.startDate < rhs.startDate }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
        calendarErrorMessage = nil
    }

    private func refreshReminders() {
        reminderAuthorizationStatus = EKEventStore.authorizationStatus(for: .reminder)
        guard hasReminderFullAccess, let interval = activeInterval() else {
            reminders = []
            return
        }

        let generation = UUID()
        reminderFetchGeneration = generation
        let predicate = eventStore.predicateForIncompleteReminders(
            withDueDateStarting: interval.start,
            ending: interval.end,
            calendars: nil
        )
        eventStore.fetchReminders(matching: predicate) { [weak self] fetchedReminders in
            Task { @MainActor [weak self] in
                guard let self, reminderFetchGeneration == generation else { return }
                reminders = (fetchedReminders ?? [])
                    .compactMap(DeviceReminder.init(reminder:))
                    .sorted { lhs, rhs in
                        if lhs.dueDate != rhs.dueDate { return lhs.dueDate < rhs.dueDate }
                        return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
                    }
                reminderErrorMessage = nil
            }
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
