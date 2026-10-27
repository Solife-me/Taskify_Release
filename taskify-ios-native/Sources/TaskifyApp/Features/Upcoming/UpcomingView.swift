import EventKit
import SwiftUI
import TaskifyCore
import UIKit

struct UpcomingFilterOption: Identifiable, Equatable {
    let id: String
    let label: String
    let boardID: String
    let columnID: String?
}

struct UpcomingFilterGroup: Identifiable {
    let board: Board
    let boardOption: UpcomingFilterOption
    let listOptions: [UpcomingFilterOption]

    var id: String { board.id }
}

private struct UpcomingTaskFilterScope {
    let columnIDs: Set<String>?
}


/// Memoizes the parts of the Upcoming screen that do not vary with the selected day.
///
/// Tapping a date re-evaluates `UpcomingView.body`, and each evaluation used to redo all of
/// this from scratch: the full task filter three times, the board/column filter options nine
/// times, and a JSON parse of the stored filter selection three times. None of it depends on
/// the selected date, so it is computed once per (data, filters, minute) and reused.
///
/// The minute in the key mirrors `AppSnapshotLookupCache`: "upcoming" is relative to now, so
/// the cache must not outlive the minute it was built in.
@MainActor
final class UpcomingDataCache {
    struct Key: Equatable {
        let tasksRevision: Int
        let minute: Int
        let searchText: String
        let boardFilterRaw: String
        let sortModeRaw: String
        let sortDirectionRaw: String
        let boardGroupingRaw: String
        let usHolidaysEnabled: Bool
        let holidayCount: Int
        let visibleBoardRevision: Int
    }

    private var key: Key?
    fileprivate var storedFilterGroups: [UpcomingFilterGroup]?
    private var storedSelectedOptionIDs: Set<String>?
    private var storedFilteredTasks: [TaskItem]?
    private var storedTasksByDay: [Date: [TaskItem]]?
    private var storedTaskCountsByDate: [Date: Int]?
    private var storedFilteredTaskifyEvents: [TaskifyEvent]?
    private var storedTaskifyEventDates: Set<Date>?
    private var storedUpcomingUsHolidays: [UsHoliday]?
    private var storedUsHolidayDates: Set<Date>?

    func prepare(for newKey: Key) {
        guard key != newKey else { return }
        key = newKey
        storedFilterGroups = nil
        storedSelectedOptionIDs = nil
        storedFilteredTasks = nil
        storedTasksByDay = nil
        storedTaskCountsByDate = nil
        storedFilteredTaskifyEvents = nil
        storedTaskifyEventDates = nil
        storedUpcomingUsHolidays = nil
        storedUsHolidayDates = nil
    }

    fileprivate func filterGroups(_ build: () -> [UpcomingFilterGroup]) -> [UpcomingFilterGroup] {
        if let storedFilterGroups { return storedFilterGroups }
        let value = build()
        storedFilterGroups = value
        return value
    }

    func selectedOptionIDs(_ build: () -> Set<String>) -> Set<String> {
        if let storedSelectedOptionIDs { return storedSelectedOptionIDs }
        let value = build()
        storedSelectedOptionIDs = value
        return value
    }

    func filteredTasks(_ build: () -> [TaskItem]) -> [TaskItem] {
        if let storedFilteredTasks { return storedFilteredTasks }
        let value = build()
        storedFilteredTasks = value
        return value
    }

    func tasksByDay(_ build: () -> [Date: [TaskItem]]) -> [Date: [TaskItem]] {
        if let storedTasksByDay { return storedTasksByDay }
        let value = build()
        storedTasksByDay = value
        return value
    }

    func taskCountsByDate(_ build: () -> [Date: Int]) -> [Date: Int] {
        if let storedTaskCountsByDate { return storedTaskCountsByDate }
        let value = build()
        storedTaskCountsByDate = value
        return value
    }

    func filteredTaskifyEvents(_ build: () -> [TaskifyEvent]) -> [TaskifyEvent] {
        if let storedFilteredTaskifyEvents { return storedFilteredTaskifyEvents }
        let value = build()
        storedFilteredTaskifyEvents = value
        return value
    }

    func taskifyEventDates(_ build: () -> Set<Date>) -> Set<Date> {
        if let storedTaskifyEventDates { return storedTaskifyEventDates }
        let value = build()
        storedTaskifyEventDates = value
        return value
    }

    func upcomingUsHolidays(_ build: () -> [UsHoliday]) -> [UsHoliday] {
        if let storedUpcomingUsHolidays { return storedUpcomingUsHolidays }
        let value = build()
        storedUpcomingUsHolidays = value
        return value
    }

    func usHolidayDates(_ build: () -> Set<Date>) -> Set<Date> {
        if let storedUsHolidayDates { return storedUsHolidayDates }
        let value = build()
        storedUsHolidayDates = value
        return value
    }
}

struct UpcomingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.taskifyOverPhoto) private var overPhoto
    @AppStorage("taskify.upcoming.view") private var displayModeRaw = UpcomingDisplayMode.details.rawValue
    @AppStorage("taskify.upcoming.sort.mode") private var sortModeRaw = UpcomingSortMode.dueDate.rawValue
    @AppStorage("taskify.upcoming.sort.direction") private var sortDirectionRaw = UpcomingSortDirection.ascending.rawValue
    @AppStorage("taskify.upcoming.board.grouping") private var boardGroupingRaw = UpcomingBoardGrouping.mixed.rawValue
    @AppStorage("taskify.upcoming.board.filter") private var boardFilterRaw = ""
    @AppStorage("taskify.upcoming.filter.presets") private var filterPresetsRaw = "[]"
    @AppStorage("taskify.upcoming.apple-calendar") private var deviceCalendarEnabled = false
    @AppStorage("taskify.upcoming.apple-calendar-choice-made") private var deviceCalendarChoiceMade = false
    @AppStorage("taskify.upcoming.apple-reminders") private var deviceRemindersEnabled = false
    @AppStorage("taskify.upcoming.apple-reminders-choice-made") private var deviceRemindersChoiceMade = false
    @AppStorage("taskify.upcoming.us-holidays") private var usHolidaysEnabled = true
    @StateObject private var deviceCalendar = DeviceCalendarStore()
    @State private var searchText = ""
    @State private var showingSearch = false
    @State private var showingNewTask = false
    @State private var showingSortOptions = false
    @State private var showingSharedInbox = false
    @State private var selectedDate = Calendar.current.startOfDay(for: Date())
    @State private var dataCache = UpcomingDataCache()
    @State private var visibleCalendarMonth = Date()
    @State private var calendarTodayRequest = 0
    @State private var holidayReferenceYear = Calendar.current.component(.year, from: Date())
    @State private var allUsHolidays: [UsHoliday] = {
        let year = Calendar.current.component(.year, from: Date())
        return UsHolidays.holidays(fromYear: year - 1, toYear: year + 8)
    }()


    /// Everything the memoized values depend on. Deliberately excludes `selectedDate`: that is
    /// the whole point — switching days must not invalidate any of this.
    private var dataCacheKey: UpcomingDataCache.Key {
        UpcomingDataCache.Key(
            tasksRevision: model.tasksAreaRevision,
            minute: Int(Date().timeIntervalSince1970 / 60),
            searchText: searchText,
            boardFilterRaw: boardFilterRaw,
            sortModeRaw: sortModeRaw,
            sortDirectionRaw: sortDirectionRaw,
            boardGroupingRaw: boardGroupingRaw,
            usHolidaysEnabled: usHolidaysEnabled,
            holidayCount: allUsHolidays.count,
            visibleBoardRevision: model.visibleBoards.count
        )
    }

    private var cache: UpcomingDataCache {
        dataCache.prepare(for: dataCacheKey)
        return dataCache
    }

    private var displayMode: UpcomingDisplayMode {
        UpcomingDisplayMode(rawValue: displayModeRaw) ?? .details
    }

    private var sortMode: UpcomingSortMode {
        UpcomingSortMode(rawValue: sortModeRaw) ?? .dueDate
    }

    private var sortDirection: UpcomingSortDirection {
        UpcomingSortDirection(rawValue: sortDirectionRaw) ?? sortMode.defaultDirection
    }

    private var boardGrouping: UpcomingBoardGrouping {
        UpcomingBoardGrouping(rawValue: boardGroupingRaw) ?? .mixed
    }

    private var filterBoards: [Board] {
        model.visibleBoards.filter { $0.kind != .compound && $0.kind != .bible }
    }

    /// One filter group per board: a board-level option, plus a list-column option per column
    /// for list-kind boards (mirrors the PWA's per-board / per-list Upcoming filter).
    private var filterGroups: [UpcomingFilterGroup] {
        cache.filterGroups {
            filterBoards.map { board in
            let boardOption = UpcomingFilterOption(id: board.id, label: board.name, boardID: board.id, columnID: nil)
            let listOptions: [UpcomingFilterOption] = board.kind == .list
                ? board.columns
                    .sorted {
                        if $0.order != $1.order { return $0.order < $1.order }
                        return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                    }
                    .map {
                        UpcomingFilterOption(id: "\(board.id)::\($0.id)", label: $0.name, boardID: board.id, columnID: $0.id)
                    }
                : []
            return UpcomingFilterGroup(board: board, boardOption: boardOption, listOptions: listOptions)
        }
        }
    }

    private var filterOptions: [UpcomingFilterOption] {
        filterGroups.flatMap { [$0.boardOption] + $0.listOptions }
    }

    private var selectedOptionIDs: Set<String> {
        cache.selectedOptionIDs {
            guard !boardFilterRaw.isEmpty,
                  let data = boardFilterRaw.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode([String].self, from: data) else {
                return Set(filterOptions.map(\.id))
            }
            return Set(decoded)
        }
    }

    /// Boards with at least partial inclusion (the board itself, or any one of its lists, selected).
    /// Used for board-scoped concerns that don't have list granularity (Taskify calendar events, sort board order).
    private var selectedBoardIDs: Set<String> {
        guard !filterOptions.isEmpty else { return Set(filterBoards.map(\.id)) }
        let selected = selectedOptionIDs
        return Set(filterGroups.compactMap { group in
            let included = selected.contains(group.boardOption.id) || group.listOptions.contains { selected.contains($0.id) }
            return included ? group.board.id : nil
        })
    }

    private var filterPresets: [UpcomingFilterPreset] {
        guard let data = filterPresetsRaw.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([UpcomingFilterPreset].self, from: data) else {
            return []
        }
        return decoded
    }

    private func taskFilterSelection() -> [String: UpcomingTaskFilterScope] {
        let groups = filterGroups
        guard !groups.isEmpty else { return [:] }
        let selected = selectedOptionIDs
        var result: [String: UpcomingTaskFilterScope] = [:]
        result.reserveCapacity(groups.count)

        for group in groups {
            let selectedColumns = Set(
                group.listOptions
                    .filter { selected.contains($0.id) }
                    .compactMap(\.columnID)
            )
            if selected.contains(group.board.id) {
                result[group.board.id] = UpcomingTaskFilterScope(
                    columnIDs: selectedColumns.isEmpty ? nil : selectedColumns
                )
            } else if !selectedColumns.isEmpty {
                result[group.board.id] = UpcomingTaskFilterScope(
                    columnIDs: selectedColumns
                )
            }
        }
        return result
    }

    private var filteredTasks: [TaskItem] {
        cache.filteredTasks {
        let base = UpcomingTaskOrganizer.filter(
            model.upcomingTasks(),
            searchText: searchText,
            includedBoardIDs: nil,
            selectedDate: nil
        )
        guard !filterOptions.isEmpty else { return base }
        let selection = taskFilterSelection()
        return base.filter { task in
            guard let scope = selection[task.boardID] else { return false }
            guard let columns = scope.columnIDs else { return true }
            guard let columnID = task.columnID else { return false }
            return columns.contains(columnID)
        }
        }
    }

    private var groups: [UpcomingGroup] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let tasksByDate = cache.tasksByDay {
            UpcomingTaskOrganizer.tasksByDay(
                filteredTasks,
                mode: sortMode,
                direction: sortDirection,
                boardGrouping: boardGrouping,
                boardOrder: filterBoards.map(\.id),
                calendar: calendar
            )
        }
        let appleEventsByDate = Dictionary(grouping: upcomingCalendarEvents) { event in
            max(today, calendar.startOfDay(for: event.startDate))
        }
        let taskifyEventsByDate = Dictionary(grouping: upcomingTaskifyEvents) { event in
            max(today, calendar.startOfDay(for: event.startDate ?? today))
        }
        let remindersByDate = Dictionary(grouping: upcomingAppleReminders) { reminder in
            calendar.startOfDay(for: reminder.dueDate)
        }
        let holidaysByDate = Dictionary(grouping: upcomingUsHolidays) { holiday in
            calendar.startOfDay(for: holiday.date)
        }
        let dates = Set(tasksByDate.keys)
            .union(appleEventsByDate.keys)
            .union(taskifyEventsByDate.keys)
            .union(remindersByDate.keys)
            .union(holidaysByDate.keys)

        return dates.map { date in
            UpcomingGroup(
                date: date,
                tasks: tasksByDate[date] ?? [],
                taskifyEvents: taskifyEventsByDate[date] ?? [],
                appleEvents: appleEventsByDate[date] ?? [],
                reminders: remindersByDate[date] ?? [],
                holidays: holidaysByDate[date] ?? []
            )
        }
        .sorted { $0.date < $1.date }
    }

    private var upcomingUsHolidays: [UsHoliday] {
        cache.upcomingUsHolidays {
            guard usHolidaysEnabled else { return [] }
            let today = Calendar.current.startOfDay(for: Date())
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            return allUsHolidays.filter { holiday in
                holiday.date >= today && (query.isEmpty || holiday.title.localizedCaseInsensitiveContains(query))
            }
        }
    }

    private var selectedDayUsHolidays: [UsHoliday] {
        let calendar = Calendar.current
        return upcomingUsHolidays.filter { calendar.isDate($0.date, inSameDayAs: selectedDate) }
    }

    private var usHolidayDates: Set<Date> {
        cache.usHolidayDates {
            Set(upcomingUsHolidays.map { Calendar.current.startOfDay(for: $0.date) })
        }
    }

    private var upcomingCalendarEvents: [DeviceCalendarEvent] {
        guard deviceCalendarEnabled, deviceCalendar.hasFullAccess else { return [] }
        let today = Calendar.current.startOfDay(for: Date())
        return deviceCalendar.events.filter { event in
            event.endDate > today && matchesAppleSearch(
                title: event.title,
                source: event.calendarTitle,
                detail: event.location
            )
        }
    }

    private var filteredTaskifyEvents: [TaskifyEvent] {
        cache.filteredTaskifyEvents {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.taskifyEvents.filter { event in
            guard event.boardID.map(selectedBoardIDs.contains) ?? true else { return false }
            guard !query.isEmpty else { return true }
            return event.title.localizedCaseInsensitiveContains(query) ||
                event.summary?.localizedCaseInsensitiveContains(query) == true ||
                event.details?.localizedCaseInsensitiveContains(query) == true ||
                event.locations?.contains(where: { $0.localizedCaseInsensitiveContains(query) }) == true
        }
        }
    }

    private var upcomingTaskifyEvents: [TaskifyEvent] {
        let today = Calendar.current.startOfDay(for: Date())
        return filteredTaskifyEvents.filter { event in
            guard let start = event.startDate else { return false }
            let end = event.endDate ?? start
            return Calendar.current.startOfDay(for: end) >= today
        }
    }

    private var upcomingAppleReminders: [DeviceReminder] {
        guard deviceRemindersEnabled, deviceCalendar.hasReminderFullAccess else { return [] }
        let today = Calendar.current.startOfDay(for: Date())
        return deviceCalendar.reminders.filter { reminder in
            reminder.dueDate >= today && matchesAppleSearch(
                title: reminder.title,
                source: reminder.calendarTitle,
                detail: reminder.notes
            )
        }
    }

    private var selectedDayTasks: [TaskItem] {
        sorted(UpcomingTaskOrganizer.filter(
            filteredTasks,
            searchText: "",
            includedBoardIDs: nil,
            selectedDate: selectedDate
        ))
    }

    private var taskCountsByDate: [Date: Int] {
        cache.taskCountsByDate {
            UpcomingTaskOrganizer.taskCountsByDay(filteredTasks)
        }
    }

    private var selectedDayCalendarEvents: [DeviceCalendarEvent] {
        guard deviceCalendarEnabled, deviceCalendar.hasFullAccess else { return [] }
        return deviceCalendar.events(on: selectedDate)
    }

    private var selectedDayTaskifyEvents: [TaskifyEvent] {
        filteredTaskifyEvents.filter { $0.occurs(on: selectedDate) }
    }

    private var taskifyEventDates: Set<Date> {
        cache.taskifyEventDates {
        var dates = Set<Date>()
        let calendar = Calendar.current
        for event in filteredTaskifyEvents {
            guard let start = event.startDate else { continue }
            let first = calendar.startOfDay(for: start)
            let last = calendar.startOfDay(for: event.endDate ?? start)
            var cursor = first
            while cursor <= max(first, last) {
                dates.insert(cursor)
                guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
                cursor = next
            }
        }
        return dates
        }
    }

    private var calendarEventDates: Set<Date> {
        guard deviceCalendarEnabled, deviceCalendar.hasFullAccess else { return [] }
        return deviceCalendar.eventDates()
    }

    private var selectedDayReminders: [DeviceReminder] {
        guard deviceRemindersEnabled, deviceCalendar.hasReminderFullAccess else { return [] }
        return deviceCalendar.reminders(on: selectedDate)
    }

    private var appleReminderDates: Set<Date> {
        guard deviceRemindersEnabled, deviceCalendar.hasReminderFullAccess else { return [] }
        return deviceCalendar.reminderDates()
    }

    private var controlsAreCustomized: Bool {
        sortMode != .dueDate ||
            sortDirection != .ascending ||
            boardGrouping != .mixed ||
            !boardFilterRaw.isEmpty ||
            deviceCalendarEnabled ||
            deviceRemindersEnabled ||
            !usHolidaysEnabled
    }

    var body: some View {
        VStack(spacing: 10) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 6)

            if showingSearch {
                TextField("Search upcoming", text: $searchText)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .taskifyGlassControl(in: Capsule())
                    .padding(.horizontal, 18)
            }

            switch displayMode {
            case .details:
                detailsView
            case .list:
                listView
            }
        }
        .sheet(isPresented: $showingNewTask) {
            NewUpcomingItemSheet()
                .environment(model)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingSortOptions) {
            UpcomingSortOptionsSheet(
                sortMode: sortMode,
                sortDirection: sortDirection,
                boardGrouping: boardGrouping,
                filterGroups: filterGroups,
                selectedOptionIDs: selectedOptionIDs,
                deviceCalendarEnabled: deviceCalendarEnabled,
                deviceRemindersEnabled: deviceRemindersEnabled,
                usHolidaysEnabled: usHolidaysEnabled,
                filterPresets: filterPresets,
                onSelectSort: selectSortMode,
                onSelectGrouping: { boardGroupingRaw = $0.rawValue },
                onToggleOption: toggleFilterOption,
                onSelectAllBoards: { boardFilterRaw = "" },
                onToggleDeviceCalendar: toggleDeviceCalendar,
                onToggleDeviceReminders: toggleDeviceReminders,
                onToggleUsHolidays: { usHolidaysEnabled.toggle() },
                onApplyPreset: applyFilterPreset,
                onSavePreset: saveFilterPreset,
                onDeletePreset: deleteFilterPreset
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingSharedInbox) {
            SharedTaskInboxSheet()
                .environment(model)
        }
        .safeAreaInset(edge: .bottom, spacing: 8) {
            HStack {
                if displayMode == .list {
                    todayButton
                }
                Spacer()
                bottomRightControls
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 10)
        }
        .onAppear {
            refreshAppleSources()
        }
        .onNewDay { previousToday, today in
            let next = DayRollover.selectedDay(selectedDate, previousToday: previousToday, today: today)
            guard next != selectedDate else { return }
            selectedDate = next
            calendarTodayRequest += 1
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            let year = Calendar.current.component(.year, from: Date())
            if holidayReferenceYear != year {
                holidayReferenceYear = year
                allUsHolidays = UsHolidays.holidays(
                    fromYear: year - 1,
                    toYear: year + 8
                )
            }
            if deviceCalendarEnabled || deviceRemindersEnabled {
                refreshAppleSources()
            }
        }
        .onChange(of: displayModeRaw) { _, _ in
            refreshAppleSources()
        }
    }

    @ViewBuilder
    private var detailsView: some View {
        if groups.isEmpty {
            ContentUnavailableView(
                "Nothing upcoming",
                systemImage: "calendar",
                description: Text(emptyDescription)
            )
            .foregroundStyle(TaskifyTheme.secondaryText)
            .frame(maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(groups) { group in
                        Text(group.date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                            .scaledFont(size: 16, weight: .bold)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .taskifyLegibilityShadow(overPhoto)
                            .padding(.top, 4)

                        if !group.reminders.isEmpty {
                            VStack(spacing: 10) {
                                ForEach(group.reminders) { reminder in
                                    DeviceReminderCard(
                                        reminder: reminder,
                                        isCompleting: deviceCalendar.completingReminderIDs.contains(reminder.id),
                                        notificationMinutes: deviceCalendar.reminderNotificationMinutes(reminder),
                                        onSetNotification: { deviceCalendar.setReminderNotification(reminder, lead: $0) }
                                    ) {
                                        completeReminder(reminder)
                                    }
                                }
                            }
                        }

                        if !group.taskifyEvents.isEmpty {
                            VStack(spacing: 10) {
                                ForEach(group.taskifyEvents) { event in
                                    TaskifyEventCard(event: event)
                                }
                            }
                        }

                        if !group.appleEvents.isEmpty {
                            VStack(spacing: 10) {
                                ForEach(group.appleEvents) { event in
                                    DeviceCalendarEventCard(
                                        event: event,
                                        notificationMinutes: deviceCalendar.eventNotificationMinutes(event),
                                        onSetNotification: { deviceCalendar.setEventNotification(event, reminder: $0) }
                                    )
                                }
                            }
                        }

                        if !group.holidays.isEmpty {
                            VStack(spacing: 10) {
                                ForEach(group.holidays) { holiday in
                                    UsHolidayCard(holiday: holiday)
                                }
                            }
                        }

                        if !group.tasks.isEmpty {
                            UpcomingTaskList(tasks: group.tasks, boardGrouping: boardGrouping)
                        }
                    }
                }
                .frame(maxWidth: 900)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 18)
                .padding(.bottom, 14)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var listView: some View {
        GeometryReader { geometry in
            if geometry.size.width >= 760 {
                HStack(alignment: .top, spacing: 24) {
                    ScrollView {
                        calendarPicker
                    }
                    .frame(width: min(400, geometry.size.width * 0.4))
                    ScrollView {
                        selectedDayAgenda
                    }
                    .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 14)
                .scrollIndicators(.hidden)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        calendarPicker
                        selectedDayAgenda
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 14)
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    private var calendarPicker: some View {
        UpcomingCompactCalendar(
            selection: $selectedDate,
            taskCountsByDate: taskCountsByDate,
            taskifyEventDates: taskifyEventDates,
            eventDates: calendarEventDates,
            reminderDates: appleReminderDates,
            holidayDates: usHolidayDates,
            todayRequest: calendarTodayRequest
        ) { month in
            visibleCalendarMonth = month
            guard deviceCalendarEnabled || deviceRemindersEnabled else { return }
            deviceCalendar.refresh(monthContaining: month)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .taskifyGlass(cornerRadius: 22)
    }

    private var selectedDayAgenda: some View {
        LazyVStack(alignment: .leading, spacing: 14) {
            Text(selectedDate.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)
                .frame(maxWidth: .infinity, alignment: .leading)

            calendarAccessView
            reminderAccessView

            if selectedDayTasks.isEmpty,
               selectedDayTaskifyEvents.isEmpty,
               selectedDayCalendarEvents.isEmpty,
               selectedDayReminders.isEmpty,
               selectedDayUsHolidays.isEmpty {
                ContentUnavailableView(
                    "Nothing scheduled",
                    systemImage: "calendar.badge.checkmark",
                    description: Text(filteredTasks.isEmpty
                        ? "Tasks, Taskify events, Apple Calendar events, and reminders will appear here."
                        : "Choose another day or add something for this date.")
                )
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(minHeight: 150)
            } else {
                if !selectedDayUsHolidays.isEmpty {
                    VStack(spacing: 10) {
                        ForEach(selectedDayUsHolidays) { holiday in
                            UsHolidayCard(holiday: holiday)
                        }
                    }
                }

                if !selectedDayTaskifyEvents.isEmpty {
                    VStack(spacing: 10) {
                        ForEach(selectedDayTaskifyEvents) { event in
                            TaskifyEventCard(event: event)
                        }
                    }
                }

                if !selectedDayReminders.isEmpty {
                    VStack(spacing: 10) {
                        ForEach(selectedDayReminders) { reminder in
                            DeviceReminderCard(
                                reminder: reminder,
                                isCompleting: deviceCalendar.completingReminderIDs.contains(reminder.id),
                                notificationMinutes: deviceCalendar.reminderNotificationMinutes(reminder),
                                onSetNotification: { deviceCalendar.setReminderNotification(reminder, lead: $0) }
                            ) {
                                completeReminder(reminder)
                            }
                        }
                    }
                }

                if !selectedDayCalendarEvents.isEmpty {
                    VStack(spacing: 10) {
                        ForEach(selectedDayCalendarEvents) { event in
                            DeviceCalendarEventCard(
                                event: event,
                                notificationMinutes: deviceCalendar.eventNotificationMinutes(event),
                                onSetNotification: { deviceCalendar.setEventNotification(event, reminder: $0) }
                            )
                        }
                    }
                }

                if !selectedDayTasks.isEmpty {
                    UpcomingTaskList(tasks: selectedDayTasks, boardGrouping: boardGrouping)
                }
            }
        }
    }

    private var emptyDescription: String {
        if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "No tasks, Taskify events, Apple Calendar events, or Apple Reminders match your search."
        }
        if selectedBoardIDs.count != filterBoards.count {
            return deviceCalendarEnabled || deviceRemindersEnabled
                ? "No matching tasks or enabled Apple items are upcoming."
                : "No dated tasks match the selected boards."
        }
        return deviceCalendarEnabled || deviceRemindersEnabled
            ? "Upcoming tasks, Taskify events, and enabled Apple items will appear here."
            : "Tasks and Taskify events with dates will appear here."
    }

    @ViewBuilder
    private var calendarAccessView: some View {
        if !deviceCalendarEnabled {
            if !deviceCalendarChoiceMade,
               deviceCalendar.authorizationStatus == .notDetermined {
                Button {
                    deviceCalendarChoiceMade = true
                    deviceCalendarEnabled = true
                    deviceCalendar.requestAccess(monthContaining: visibleCalendarMonth)
                } label: {
                    Label("Show Apple Calendar events", systemImage: "calendar.badge.plus")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .frame(height: 48)
                        .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        } else if deviceCalendar.isRequestingAccess {
            appleAccessProgress("Requesting Apple Calendar access…")
        } else if deviceCalendar.accessWasDenied {
            appleAccessDeniedCard(
                title: "Apple Calendar access is off",
                message: "Allow calendar access in Settings to show events here."
            ) {
                deviceCalendarChoiceMade = true
                deviceCalendarEnabled = false
            }
        } else if let errorMessage = deviceCalendar.calendarErrorMessage {
            appleAccessError(errorMessage)
        }
    }

    @ViewBuilder
    private var reminderAccessView: some View {
        if !deviceRemindersEnabled {
            if !deviceRemindersChoiceMade,
               deviceCalendar.reminderAuthorizationStatus == .notDetermined {
                Button {
                    deviceRemindersChoiceMade = true
                    deviceRemindersEnabled = true
                    deviceCalendar.requestReminderAccess(monthContaining: visibleCalendarMonth)
                } label: {
                    Label("Show Apple Reminders", systemImage: "checklist")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .frame(height: 48)
                        .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        } else if deviceCalendar.isRequestingReminderAccess {
            appleAccessProgress("Requesting Apple Reminders access…")
        } else if deviceCalendar.reminderAccessWasDenied {
            appleAccessDeniedCard(
                title: "Apple Reminders access is off",
                message: "Allow reminders access in Settings to show and complete reminders here."
            ) {
                deviceRemindersChoiceMade = true
                deviceRemindersEnabled = false
            }
        } else if let errorMessage = deviceCalendar.reminderErrorMessage {
            appleAccessError(errorMessage)
        }
    }

    private func appleAccessProgress(_ title: String) -> some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(title)
                .font(.subheadline)
        }
        .foregroundStyle(TaskifyTheme.secondaryText)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .frame(height: 48)
        .taskifyGlass(cornerRadius: 18)
    }

    private func appleAccessDeniedCard(
        title: String,
        message: String,
        onHide: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: "exclamationmark.triangle")
                .font(.subheadline.weight(.semibold))
            Text(message)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
            HStack {
                Button("Open Settings") {
                    guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(settingsURL)
                }
                .buttonStyle(.bordered)

                Button("Hide", action: onHide)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .taskifyGlass(cornerRadius: 18)
    }

    private func appleAccessError(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .taskifyGlass(cornerRadius: 18)
    }

    private var bottomRightControls: some View {
        HStack(spacing: 0) {
            Button {
                showingSortOptions = true
            } label: {
                Image(systemName: "arrow.up.arrow.down")
                    .scaledFont(size: 16, weight: .semibold)
                    .foregroundStyle(controlsAreCustomized ? TaskifyTheme.accent : TaskifyTheme.primaryText)
                    .frame(width: 42, height: 42)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Sort and filter upcoming tasks")

            Rectangle()
                .fill(TaskifyTheme.border)
                .frame(width: 1, height: 23)

            Button {
                showingSharedInbox = true
            } label: {
                Image(systemName: model.pendingSharedInboxCount > 0 ? "tray.full.fill" : "tray")
                    .scaledFont(size: 16, weight: .semibold)
                    .foregroundStyle(model.pendingSharedInboxCount > 0 ? TaskifyTheme.accent : TaskifyTheme.primaryText)
                    .frame(width: 42, height: 42)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                model.pendingSharedInboxCount > 0
                    ? "Shared task inbox, \(model.pendingSharedInboxCount) pending"
                    : "Shared task inbox"
            )
        }
        .taskifyGlassControl(in: Capsule())
    }

    private var todayButton: some View {
        Button {
            withAnimation(.snappy) {
                selectedDate = Calendar.current.startOfDay(for: Date())
                calendarTodayRequest += 1
            }
        } label: {
            Text("Today")
                .scaledFont(size: 14, weight: .semibold)
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(.horizontal, 18)
                .frame(height: 42)
                .taskifyGlassControl(in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Returns the calendar to today")
    }

    private var header: some View {
        TaskifyGlassControlGroup(spacing: 10) {
            HStack(spacing: 10) {
                Text("Upcoming")
                    .taskifyScreenTitle()

                Spacer()

                HeaderIconButton(
                    systemName: displayMode == .details ? "calendar" : "list.bullet",
                    accent: displayMode == .list,
                    accessibilityLabel: displayMode == .details
                        ? "Show calendar view"
                        : "Show list view"
                ) {
                    toggleDisplayMode()
                }
                HeaderIconButton(
                    systemName: showingSearch ? "xmark" : "magnifyingglass",
                    accessibilityLabel: showingSearch ? "Close search" : "Search upcoming tasks"
                ) {
                    withAnimation(.snappy) {
                        showingSearch.toggle()
                        if !showingSearch { searchText = "" }
                    }
                }
                HeaderIconButton(systemName: "plus", accent: true, accessibilityLabel: "Add task") {
                    showingNewTask = true
                }
            }
        }
    }

    private func sorted(_ tasks: [TaskItem]) -> [TaskItem] {
        UpcomingTaskOrganizer.sort(
            tasks,
            mode: sortMode,
            direction: sortDirection,
            boardGrouping: boardGrouping,
            boardOrder: filterBoards.map(\.id)
        )
    }

    private func selectSortMode(_ mode: UpcomingSortMode) {
        if sortMode == mode, mode.supportsDirection {
            sortDirectionRaw = (sortDirection == .ascending
                ? UpcomingSortDirection.descending
                : UpcomingSortDirection.ascending).rawValue
            return
        }
        sortModeRaw = mode.rawValue
        sortDirectionRaw = mode.defaultDirection.rawValue
    }

    private func toggleDisplayMode() {
        let nextMode: UpcomingDisplayMode = displayMode == .details ? .list : .details
        if nextMode == .list, let firstDate = groups.first?.date {
            selectedDate = firstDate
        }
        withAnimation(.snappy) {
            displayModeRaw = nextMode.rawValue
        }
    }

    private func writeSelection(_ selection: Set<String>) {
        let allIDs = Set(filterOptions.map(\.id))
        if selection == allIDs {
            boardFilterRaw = ""
        } else if let data = try? JSONEncoder().encode(selection.sorted()),
                  let text = String(data: data, encoding: .utf8) {
            boardFilterRaw = text
        }
    }

    /// Toggles a board- or list-level filter option, keeping the two in sync the way the PWA does:
    /// selecting/deselecting a whole board cascades to all of its lists, and selecting/deselecting the
    /// last selected list for a board cascades back to the board-level option.
    private func toggleFilterOption(_ optionID: String) {
        guard !filterOptions.isEmpty,
              let option = filterOptions.first(where: { $0.id == optionID }),
              let group = filterGroups.first(where: { $0.board.id == option.boardID }) else { return }

        var next = selectedOptionIDs
        let listIDs = Set(group.listOptions.map(\.id))

        if option.columnID == nil {
            if next.contains(optionID) {
                next.remove(optionID)
                listIDs.forEach { next.remove($0) }
            } else {
                next.insert(optionID)
                listIDs.forEach { next.insert($0) }
            }
        } else {
            if next.contains(optionID) {
                next.remove(optionID)
            } else {
                next.insert(optionID)
                next.insert(option.boardID)
            }
            let hasAnyList = listIDs.contains { next.contains($0) }
            if !hasAnyList {
                next.remove(option.boardID)
            }
        }

        writeSelection(next)
    }

    private func persistFilterPresets(_ presets: [UpcomingFilterPreset]) {
        guard let data = try? JSONEncoder().encode(presets),
              let text = String(data: data, encoding: .utf8) else { return }
        filterPresetsRaw = text
    }

    private func applyFilterPreset(_ preset: UpcomingFilterPreset) {
        let validIDs = Set(filterOptions.map(\.id))
        let selection = Set(preset.selection.filter { validIDs.contains($0) })
        writeSelection(selection)
    }

    private func saveFilterPreset(name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let selection = filterOptions.map(\.id).filter { selectedOptionIDs.contains($0) }
        var presets = filterPresets
        if let index = presets.firstIndex(where: { $0.name.localizedCaseInsensitiveCompare(trimmed) == .orderedSame }) {
            let existing = presets.remove(at: index)
            presets.insert(UpcomingFilterPreset(id: existing.id, name: trimmed, selection: selection), at: 0)
        } else {
            presets.insert(UpcomingFilterPreset(name: trimmed, selection: selection), at: 0)
        }
        persistFilterPresets(presets)
    }

    private func deleteFilterPreset(_ preset: UpcomingFilterPreset) {
        persistFilterPresets(filterPresets.filter { $0.id != preset.id })
    }

    private func toggleDeviceCalendar() {
        deviceCalendarChoiceMade = true
        deviceCalendarEnabled.toggle()
        guard deviceCalendarEnabled else { return }
        if displayMode == .details {
            deviceCalendar.requestAccessForUpcoming()
        } else {
            deviceCalendar.requestAccess(monthContaining: visibleCalendarMonth)
        }
    }

    private func toggleDeviceReminders() {
        deviceRemindersChoiceMade = true
        deviceRemindersEnabled.toggle()
        guard deviceRemindersEnabled else { return }
        if displayMode == .details {
            deviceCalendar.requestReminderAccessForUpcoming()
        } else {
            deviceCalendar.requestReminderAccess(monthContaining: visibleCalendarMonth)
        }
    }

    private func refreshAppleSources() {
        guard deviceCalendarEnabled || deviceRemindersEnabled else { return }
        if displayMode == .details {
            deviceCalendar.refreshUpcoming()
        } else {
            deviceCalendar.refresh(monthContaining: visibleCalendarMonth)
        }
    }

    private func matchesAppleSearch(title: String, source: String, detail: String?) -> Bool {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        return title.localizedCaseInsensitiveContains(query) ||
            source.localizedCaseInsensitiveContains(query) ||
            (detail?.localizedCaseInsensitiveContains(query) ?? false)
    }

    private func completeReminder(_ reminder: DeviceReminder) {
        guard deviceCalendar.completeReminder(reminder) else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

private enum UpcomingDisplayMode: String {
    case details
    case list
}
