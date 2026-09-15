import EventKit
import Foundation
import TaskifyCore
import UserNotifications
#if canImport(UIKit)
import UIKit
typealias TaskifyCalendarColor = UIColor
#else
import AppKit
typealias TaskifyCalendarColor = NSColor
#endif

struct DeviceCalendarEvent: Identifiable {
    let id: String
    let title: String
    let calendarTitle: String
    let startDate: Date
    let endDate: Date
    let isAllDay: Bool
    let location: String?
    let color: TaskifyCalendarColor

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
        color = event.calendar.cgColor.flatMap(TaskifyCalendarColor.init(cgColor:)) ?? .systemOrange
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
    let color: TaskifyCalendarColor

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
        color = reminder.calendar.cgColor.flatMap(TaskifyCalendarColor.init(cgColor:)) ?? .systemPurple
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
    @Published private(set) var notificationSelection: [String: Int]

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
        notificationSelection = DeviceNotificationSelection.loadMinutes()
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

    // MARK: - Per-item notification reminders

    func eventNotificationMinutes(_ event: DeviceCalendarEvent) -> Int? {
        notificationSelection[DeviceNotificationSelection.eventKey(event.id)]
    }

    func reminderNotificationMinutes(_ reminder: DeviceReminder) -> Int? {
        notificationSelection[DeviceNotificationSelection.reminderKey(reminder.id)]
    }

    /// `reminder` uses Taskify's standard reminder presets (`TaskReminder.timedPresets`).
    /// Passing `nil` removes the notification for the item.
    func setEventNotification(_ event: DeviceCalendarEvent, reminder: TaskReminder?) {
        setNotificationSelection(DeviceNotificationSelection.eventKey(event.id), reminder: reminder)
    }

    func setReminderNotification(_ reminder: DeviceReminder, lead: TaskReminder?) {
        setNotificationSelection(DeviceNotificationSelection.reminderKey(reminder.id), reminder: lead)
    }

    private func setNotificationSelection(_ key: String, reminder: TaskReminder?) {
        let wasEnabled = notificationSelection[key] != nil
        if let minutes = reminder?.minutesBefore {
            notificationSelection[key] = minutes
        } else {
            notificationSelection.removeValue(forKey: key)
        }
        DeviceNotificationSelection.saveMinutes(notificationSelection)
        scheduleSelectedNotifications(requestPermission: !wasEnabled)
    }

    /// Resolve selected items directly from EventKit, independently of the visible month.
    private func scheduleSelectedNotifications(requestPermission: Bool = false) {
        let selected = DeviceNotificationSelection.resolve(
            notificationSelection,
            event: { (id, occurrence) -> DeviceCalendarEvent? in
                guard self.hasFullAccess else { return nil }
                let predicate = self.eventStore.predicateForEvents(
                    withStart: occurrence,
                    end: occurrence.addingTimeInterval(1),
                    calendars: nil
                )
                return self.eventStore.events(matching: predicate)
                    .map(DeviceCalendarEvent.init(event:))
                    .first { $0.id == id }
            },
            reminder: { id -> DeviceReminder? in
                guard self.hasReminderFullAccess,
                      let item = self.eventStore.calendarItem(withIdentifier: id) as? EKReminder,
                      !item.isCompleted else { return nil }
                return DeviceReminder(reminder: item)
            }
        )
        DeviceNotificationScheduler.shared.reschedule(
            events: selected.events,
            reminders: selected.reminders,
            selection: notificationSelection,
            requestPermission: requestPermission
        )
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
        scheduleSelectedNotifications()
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
                scheduleSelectedNotifications()
            }
        }
    }
}


/// Schedules local notifications for Apple Calendar events and Apple Reminders that the
/// user picked in the Upcoming view. Each notification fires at the event start or the
/// reminder due time. The caller resolves all selected items independently of the UI's
/// date range; missing events and completed reminders no longer produce requests.
@MainActor
private final class DeviceNotificationScheduler {
    static let shared = DeviceNotificationScheduler()

    private static let eventIdentifierPrefix = "taskify.apple.event."
    private static let reminderIdentifierPrefix = "taskify.apple.reminder."
    private static let maxScheduledNotifications = 60

    private let center = UNUserNotificationCenter.current()
    private var rescheduleTask: Task<Void, Never>?

    func reschedule(
        events: [DeviceCalendarEvent],
        reminders: [DeviceReminder],
        selection: [String: Int],
        requestPermission: Bool
    ) {
        rescheduleTask?.cancel()
        let eventSnapshot = events
        let reminderSnapshot = reminders
        rescheduleTask = Task { [center] in
            let settings = await center.notificationSettings()
            var authorizationStatus = settings.authorizationStatus
            if requestPermission, authorizationStatus == .notDetermined {
                let granted = (try? await center.requestAuthorization(
                    options: [.alert, .badge, .sound]
                )) ?? false
                authorizationStatus = granted ? .authorized : .denied
            }
            guard authorizationStatus == .authorized || authorizationStatus == .provisional,
                  !Task.isCancelled else { return }

            let pending = await center.pendingNotificationRequests()
            guard !Task.isCancelled else { return }
            let existingIDs = pending
                .map(\.identifier)
                .filter {
                    $0.hasPrefix(Self.eventIdentifierPrefix)
                        || $0.hasPrefix(Self.reminderIdentifierPrefix)
                }
            if !existingIDs.isEmpty {
                center.removePendingNotificationRequests(withIdentifiers: existingIDs)
            }

            let now = Date()
            var requests: [UNNotificationRequest] = []
            for event in eventSnapshot {
                guard let minutes = selection[DeviceNotificationSelection.eventKey(event.id)] else { continue }
                if let request = Self.notificationRequest(
                    identifier: Self.eventIdentifierPrefix + event.id,
                    title: event.title,
                    body: event.isAllDay
                        ? "All-day event \u{2022} \(event.calendarTitle)"
                        : event.calendarTitle,
                    fireDate: Self.eventFireDate(for: event, minutesBefore: minutes),
                    now: now
                ) {
                    requests.append(request)
                }
            }
            for reminder in reminderSnapshot {
                guard let minutes = selection[DeviceNotificationSelection.reminderKey(reminder.id)] else { continue }
                if let request = Self.notificationRequest(
                    identifier: Self.reminderIdentifierPrefix + reminder.id,
                    title: reminder.title,
                    body: "Apple Reminder",
                    fireDate: reminder.dueDate.addingTimeInterval(-Double(minutes) * 60),
                    now: now
                ) {
                    requests.append(request)
                }
            }

            // Prefer the earliest alerts across events and reminders, not fetch order.
            let availableSlots = max(0, Self.maxScheduledNotifications - (pending.count - existingIDs.count))
            requests.sort {
                let lhs = ($0.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() ?? .distantFuture
                let rhs = ($1.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() ?? .distantFuture
                return lhs == rhs ? $0.identifier < $1.identifier : lhs < rhs
            }
            for request in requests.prefix(availableSlots) {
                guard !Task.isCancelled else { return }
                try? await center.add(request)
            }
        }
    }

    /// All-day events start at local midnight, which makes naive lead times land in the
    /// previous evening. For the "1 day before" preset, anchor instead to 9:00 AM local
    /// time on the day before the event. Other presets keep the standard offset.
    private static func eventFireDate(
        for event: DeviceCalendarEvent,
        minutesBefore minutes: Int
    ) -> Date {
        guard event.isAllDay, minutes == 1_440 else {
            return event.startDate.addingTimeInterval(-Double(minutes) * 60)
        }
        var calendar = Calendar.current
        calendar.timeZone = .current
        guard let dayBefore = calendar.date(byAdding: .day, value: -1, to: event.startDate),
              let anchor = calendar.date(
                bySettingHour: 9,
                minute: 0,
                second: 0,
                of: dayBefore
              ) else {
            return event.startDate.addingTimeInterval(-Double(minutes) * 60)
        }
        return anchor
    }

    private static func notificationRequest(
        identifier: String,
        title: String,
        body: String,
        fireDate: Date,
        now: Date
    ) -> UNNotificationRequest? {
        guard fireDate > now.addingTimeInterval(1) else { return nil }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        var components = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: fireDate
        )
        components.timeZone = Calendar.current.timeZone
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        return UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
