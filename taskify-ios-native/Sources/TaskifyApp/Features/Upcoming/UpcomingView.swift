import EventKit
import SwiftUI
import TaskifyCore
import UIKit

private struct UpcomingFilterOption: Identifiable, Equatable {
    let id: String
    let label: String
    let boardID: String
    let columnID: String?
}

private struct UpcomingFilterGroup: Identifiable {
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
        let snapshotRevision: Int
        let minute: Int
        let searchText: String
        let boardFilterRaw: String
        let sortModeRaw: String
        let sortDirectionRaw: String
        let usHolidaysEnabled: Bool
        let holidayCount: Int
        let visibleBoardRevision: Int
    }

    private var key: Key?
    fileprivate var storedFilterGroups: [UpcomingFilterGroup]?
    private var storedSelectedOptionIDs: Set<String>?
    private var storedFilteredTasks: [TaskItem]?
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
            snapshotRevision: model.snapshotRevision,
            minute: Int(Date().timeIntervalSince1970 / 60),
            searchText: searchText,
            boardFilterRaw: boardFilterRaw,
            sortModeRaw: sortModeRaw,
            sortDirectionRaw: sortDirectionRaw,
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
        let tasksByDate = Dictionary(grouping: filteredTasks) { task in
            Calendar.current.startOfDay(for: task.dueDate ?? Date())
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
                tasks: sorted(tasksByDate[date] ?? []),
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
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .padding(.top, 4)

                        if !group.reminders.isEmpty {
                            VStack(spacing: 10) {
                                ForEach(group.reminders) { reminder in
                                    DeviceReminderCard(
                                        reminder: reminder,
                                        isCompleting: deviceCalendar.completingReminderIDs.contains(reminder.id)
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
                                    DeviceCalendarEventCard(event: event)
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
                .padding(.horizontal, 18)
                .padding(.bottom, 14)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var listView: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
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
                                    isCompleting: deviceCalendar.completingReminderIDs.contains(reminder.id)
                                ) {
                                    completeReminder(reminder)
                                }
                            }
                        }
                    }

                    if !selectedDayCalendarEvents.isEmpty {
                        VStack(spacing: 10) {
                            ForEach(selectedDayCalendarEvents) { event in
                                DeviceCalendarEventCard(event: event)
                            }
                        }
                    }

                    if !selectedDayTasks.isEmpty {
                        UpcomingTaskList(tasks: selectedDayTasks, boardGrouping: boardGrouping)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 14)
        }
        .scrollIndicators(.hidden)
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
                    .font(.system(size: 16, weight: .semibold))
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
                    .font(.system(size: 16, weight: .semibold))
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
                .font(.system(size: 14, weight: .semibold))
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
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(TaskifyTheme.primaryText)

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

private struct UpcomingCompactCalendar: View {
    @Binding var selection: Date
    let taskCountsByDate: [Date: Int]
    let taskifyEventDates: Set<Date>
    let eventDates: Set<Date>
    let reminderDates: Set<Date>
    let holidayDates: Set<Date>
    let todayRequest: Int
    let onVisibleMonthChange: (Date) -> Void
    private let calendar: Calendar
    @State private var visibleMonth: Date
    @State private var showingMonthPicker = false

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 0),
        count: 7
    )

    init(
        selection: Binding<Date>,
        taskCountsByDate: [Date: Int],
        taskifyEventDates: Set<Date>,
        eventDates: Set<Date>,
        reminderDates: Set<Date>,
        holidayDates: Set<Date>,
        todayRequest: Int,
        calendar: Calendar = .current,
        onVisibleMonthChange: @escaping (Date) -> Void
    ) {
        _selection = selection
        self.taskCountsByDate = taskCountsByDate
        self.taskifyEventDates = taskifyEventDates
        self.eventDates = eventDates
        self.reminderDates = reminderDates
        self.holidayDates = holidayDates
        self.todayRequest = todayRequest
        self.calendar = calendar
        self.onVisibleMonthChange = onVisibleMonthChange
        _visibleMonth = State(initialValue: Self.startOfMonth(
            containing: selection.wrappedValue,
            calendar: calendar
        ))
    }

    var body: some View {
        VStack(spacing: 6) {
            monthHeader

            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                    Text(symbol.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .frame(maxWidth: .infinity)
                        .frame(height: 22)
                        .accessibilityHidden(true)
                }

                ForEach(Array(monthDays.enumerated()), id: \.offset) { _, date in
                    if let date {
                        dayButton(date)
                    } else {
                        Color.clear
                            .frame(height: 44)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .onChange(of: selection) { _, newSelection in
            let selectedMonth = Self.startOfMonth(
                containing: newSelection,
                calendar: calendar
            )
            guard !calendar.isDate(
                selectedMonth,
                equalTo: visibleMonth,
                toGranularity: .month
            ) else { return }
            withAnimation(.snappy) {
                visibleMonth = selectedMonth
            }
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height),
                          abs(value.translation.width) > 44 else { return }
                    changeMonth(by: value.translation.width < 0 ? 1 : -1)
                }
        )
        .sensoryFeedback(.selection, trigger: selection)
        .onAppear {
            onVisibleMonthChange(visibleMonth)
        }
        .onChange(of: visibleMonth) { _, newMonth in
            onVisibleMonthChange(newMonth)
        }
        .onChange(of: todayRequest) { _, _ in
            showMonth(containing: Date())
        }
    }

    private var monthHeader: some View {
        ZStack {
            HStack {
                monthButton(systemName: "chevron.left", offset: -1)

                Spacer()

                monthButton(systemName: "chevron.right", offset: 1)
            }

            Button {
                showingMonthPicker = true
            } label: {
                HStack(spacing: 6) {
                    Text(visibleMonth.formatted(.dateTime.month(.wide).year()))
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(
                            showingMonthPicker
                                ? TaskifyTheme.accent
                                : TaskifyTheme.primaryText
                        )
                        .lineLimit(1)
                        .contentTransition(.numericText())

                    Image(systemName: showingMonthPicker ? "chevron.down" : "chevron.right")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.accent)
                        .contentTransition(.symbolEffect(.replace))
                }
                .frame(height: 38)
                .contentShape(Rectangle())
                .animation(.snappy, value: showingMonthPicker)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Choose month and year")
            .popover(
                isPresented: $showingMonthPicker,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .top
            ) {
                MonthYearWheelPicker(
                    initialDate: visibleMonth,
                    calendar: calendar
                ) { month, year in
                    showMonth(month: month, year: year)
                }
                .frame(width: 320, height: 232)
                .presentationCompactAdaptation(.popover)
            }
        }
    }

    private var weekdaySymbols: [String] {
        let symbols = calendar.shortStandaloneWeekdaySymbols
        let firstIndex = max(0, calendar.firstWeekday - 1)
        return (0..<7).map { symbols[(firstIndex + $0) % symbols.count] }
    }

    private var monthDays: [Date?] {
        guard let dayRange = calendar.range(of: .day, in: .month, for: visibleMonth) else {
            return []
        }

        let firstWeekday = calendar.component(.weekday, from: visibleMonth)
        let leadingSpaces = (firstWeekday - calendar.firstWeekday + 7) % 7
        let leading: [Date?] = Array(repeating: nil, count: leadingSpaces)
        let days: [Date?] = dayRange.map { day in
            calendar.date(byAdding: .day, value: day - 1, to: visibleMonth)
        }
        return leading + days
    }

    private func dayButton(_ date: Date) -> some View {
        let isSelected = calendar.isDate(date, inSameDayAs: selection)
        let isToday = calendar.isDateInToday(date)
        let day = calendar.startOfDay(for: date)
        let taskCount = taskCountsByDate[day, default: 0]
        let hasTaskifyEvent = taskifyEventDates.contains(day)
        let hasCalendarEvent = eventDates.contains(day)
        let hasReminder = reminderDates.contains(day)
        let hasHoliday = holidayDates.contains(day)

        return Button {
            withAnimation(.snappy) {
                selection = calendar.startOfDay(for: date)
            }
        } label: {
            VStack(spacing: 1) {
                Text("\(calendar.component(.day, from: date))")
                    .font(.system(
                        size: 16,
                        weight: isSelected ? .bold : .medium,
                        design: .rounded
                    ))
                    .foregroundStyle(
                        isSelected
                            ? Color.white
                            : (isToday ? TaskifyTheme.accent : TaskifyTheme.primaryText)
                    )
                    .frame(width: 34, height: 34)
                    .background {
                        if isSelected {
                            Circle().fill(TaskifyTheme.accent)
                        } else if isToday {
                            Circle().stroke(TaskifyTheme.accent.opacity(0.72), lineWidth: 1)
                        }
                    }

                HStack(spacing: 2) {
                    Circle()
                        .fill(taskCount > 0
                            ? (isSelected ? Color.white.opacity(0.9) : TaskifyTheme.accent)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasTaskifyEvent
                            ? (isSelected ? Color.white.opacity(0.9) : Color.green)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasCalendarEvent
                            ? (isSelected ? Color.white.opacity(0.9) : Color.orange)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasReminder
                            ? (isSelected ? Color.white.opacity(0.9) : Color.purple)
                            : Color.clear)
                        .frame(width: 4, height: 4)

                    Circle()
                        .fill(hasHoliday
                            ? (isSelected ? Color.white.opacity(0.9) : Color.pink)
                            : Color.clear)
                        .frame(width: 4, height: 4)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(date.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
        .accessibilityValue(dayAccessibilityValue(
            taskCount: taskCount,
            hasTaskifyEvent: hasTaskifyEvent,
            hasCalendarEvent: hasCalendarEvent,
            hasReminder: hasReminder,
            hasHoliday: hasHoliday
        ))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func dayAccessibilityValue(
        taskCount: Int,
        hasTaskifyEvent: Bool,
        hasCalendarEvent: Bool,
        hasReminder: Bool,
        hasHoliday: Bool
    ) -> String {
        var parts: [String] = []
        if taskCount > 0 {
            parts.append("\(taskCount) \(taskCount == 1 ? "task" : "tasks")")
        }
        if hasTaskifyEvent {
            parts.append("Taskify event")
        }
        if hasCalendarEvent {
            parts.append("Apple Calendar event")
        }
        if hasReminder {
            parts.append("Apple Reminder")
        }
        if hasHoliday {
            parts.append("US holiday")
        }
        return parts.isEmpty ? "Nothing scheduled" : parts.joined(separator: ", ")
    }

    private func monthButton(systemName: String, offset: Int) -> some View {
        Button {
            changeMonth(by: offset)
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 38, height: 38)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(offset < 0 ? "Previous month" : "Next month")
    }

    private func changeMonth(by offset: Int) {
        guard let nextMonth = calendar.date(
            byAdding: .month,
            value: offset,
            to: visibleMonth
        ) else { return }
        withAnimation(.snappy) {
            visibleMonth = Self.startOfMonth(containing: nextMonth, calendar: calendar)
        }
    }

    private func showMonth(containing date: Date) {
        withAnimation(.snappy) {
            visibleMonth = Self.startOfMonth(containing: date, calendar: calendar)
        }
    }

    private func showMonth(month: Int, year: Int) {
        var components = calendar.dateComponents([.era], from: visibleMonth)
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        components.year = year
        components.month = month
        components.day = 1
        guard let date = calendar.date(from: components) else { return }
        showMonth(containing: date)
    }

    private static func startOfMonth(containing date: Date, calendar: Calendar) -> Date {
        calendar.date(
            from: calendar.dateComponents([.year, .month], from: date)
        ) ?? calendar.startOfDay(for: date)
    }
}

private struct MonthYearWheelPicker: View {
    let calendar: Calendar
    let onApply: (Int, Int) -> Void

    @State private var month: Int
    @State private var year: Int

    private var yearRange: ClosedRange<Int> {
        let currentYear = calendar.component(.year, from: Date())
        return (currentYear - 100)...(currentYear + 100)
    }

    init(
        initialDate: Date,
        calendar: Calendar,
        onApply: @escaping (Int, Int) -> Void
    ) {
        self.calendar = calendar
        self.onApply = onApply
        _month = State(initialValue: calendar.component(.month, from: initialDate))
        _year = State(initialValue: calendar.component(.year, from: initialDate))
    }

    var body: some View {
        CombinedMonthYearWheelPicker(
            month: $month,
            year: $year,
            monthNames: calendar.monthSymbols,
            years: Array(yearRange)
        )
        .padding(.horizontal, 12)
        .preferredColorScheme(.dark)
        .onChange(of: month) { _, newMonth in
            onApply(newMonth, year)
        }
        .onChange(of: year) { _, newYear in
            onApply(month, newYear)
        }
    }
}

private struct CombinedMonthYearWheelPicker: UIViewRepresentable {
    @Binding var month: Int
    @Binding var year: Int
    let monthNames: [String]
    let years: [Int]

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UIPickerView {
        let picker = UIPickerView()
        picker.dataSource = context.coordinator
        picker.delegate = context.coordinator
        picker.backgroundColor = .clear
        picker.overrideUserInterfaceStyle = .dark
        selectCurrentValues(in: picker, animated: false)
        return picker
    }

    func updateUIView(_ picker: UIPickerView, context: Context) {
        context.coordinator.parent = self
        selectCurrentValues(in: picker, animated: false)
    }

    private func selectCurrentValues(in picker: UIPickerView, animated: Bool) {
        let monthRow = min(max(month - 1, 0), max(monthNames.count - 1, 0))
        if picker.selectedRow(inComponent: 0) != monthRow {
            picker.selectRow(monthRow, inComponent: 0, animated: animated)
        }
        if let yearRow = years.firstIndex(of: year) {
            if picker.selectedRow(inComponent: 1) != yearRow {
                picker.selectRow(yearRow, inComponent: 1, animated: animated)
            }
        }
    }

    final class Coordinator: NSObject, UIPickerViewDataSource, UIPickerViewDelegate {
        var parent: CombinedMonthYearWheelPicker
        private let selectionFeedback = UISelectionFeedbackGenerator()

        init(parent: CombinedMonthYearWheelPicker) {
            self.parent = parent
            super.init()
            selectionFeedback.prepare()
        }

        func numberOfComponents(in pickerView: UIPickerView) -> Int {
            2
        }

        func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
            component == 0 ? parent.monthNames.count : parent.years.count
        }

        func pickerView(
            _ pickerView: UIPickerView,
            widthForComponent component: Int
        ) -> CGFloat {
            pickerView.bounds.width * (component == 0 ? 0.57 : 0.43)
        }

        func pickerView(
            _ pickerView: UIPickerView,
            titleForRow row: Int,
            forComponent component: Int
        ) -> String? {
            if component == 0 {
                guard parent.monthNames.indices.contains(row) else { return nil }
                return parent.monthNames[row]
            }
            guard parent.years.indices.contains(row) else { return nil }
            return String(parent.years[row])
        }

        func pickerView(
            _ pickerView: UIPickerView,
            didSelectRow row: Int,
            inComponent component: Int
        ) {
            selectionFeedback.selectionChanged()
            selectionFeedback.prepare()

            if component == 0, parent.monthNames.indices.contains(row) {
                parent.month = row + 1
            } else if component == 1, parent.years.indices.contains(row) {
                parent.year = parent.years[row]
            }
        }
    }
}

private struct UpcomingGroup: Identifiable {
    let date: Date
    let tasks: [TaskItem]
    let taskifyEvents: [TaskifyEvent]
    let appleEvents: [DeviceCalendarEvent]
    let reminders: [DeviceReminder]
    let holidays: [UsHoliday]
    var id: Date { date }
}

private struct DeviceReminderCard: View {
    let reminder: DeviceReminder
    let isCompleting: Bool
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
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)

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
    }

    private var dueText: String {
        reminder.isAllDay
            ? "Apple Reminder"
            : "Due \(reminder.dueDate.formatted(.dateTime.hour().minute()))"
    }
}

private struct TaskifyEventCard: View {
    @Environment(AppModel.self) private var model
    @State private var showingEditor = false
    let event: TaskifyEvent

    var body: some View {
        Group {
            if event.isReadOnly {
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
            Image(systemName: "calendar.badge.clock")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.green)
                .frame(width: 38, height: 38)
                .background(Color.green.opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(event.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

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
        .accessibilityHint(event.isReadOnly
            ? "A read-only Taskify event shared through Nostr"
            : "Opens the Taskify event editor")
    }

    private var timeText: String {
        guard let start = event.startDate else { return "Date unavailable" }
        if event.isAllDay {
            guard let end = event.endDate,
                  !Calendar.current.isDate(start, inSameDayAs: end) else {
                return "All-day"
            }
            return "All-day · \(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))"
        }
        guard let end = event.endDate else {
            return formattedTime(start)
        }
        let timeZoneSuffix = event.startTimeZoneID
            .flatMap(TimeZone.init(identifier:))
            .flatMap { $0.abbreviation(for: start) }
            .map { " · \($0)" } ?? ""
        return "\(formattedTime(start)) – \(formattedTime(end))\(timeZoneSuffix)"
    }

    private func formattedTime(_ date: Date) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = event.startTimeZoneID.flatMap(TimeZone.init(identifier:)) ?? .current
        return date.formatted(style)
    }
}

private struct DeviceCalendarEventCard: View {
    let event: DeviceCalendarEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "calendar")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color(uiColor: event.color))
                .frame(width: 38, height: 38)
                .background(Color(uiColor: event.color).opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(event.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

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
    }

    private var timeText: String {
        if event.isAllDay { return "All-day" }
        let start = event.startDate.formatted(.dateTime.hour().minute())
        let end = event.endDate.formatted(.dateTime.hour().minute())
        return "\(start) – \(end)"
    }
}

private struct UsHolidayCard: View {
    let holiday: UsHoliday

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "star.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.pink)
                .frame(width: 38, height: 38)
                .background(Color.pink.opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(holiday.title)
                    .font(.system(size: 16, weight: .semibold))
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

private struct UpcomingTaskList: View {
    @Environment(AppModel.self) private var model
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
                    .padding(.top, 2)

                ForEach(section.tasks) { task in
                    TaskCardView(task: task)
                }
            }
        } else {
            ForEach(tasks) { task in
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.board(withID: task.boardID)?.name ?? "Board")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .padding(.leading, 10)
                    TaskCardView(task: task)
                }
            }
        }
    }
}

private struct UpcomingBoardSection: Identifiable {
    let boardID: String
    let tasks: [TaskItem]
    var id: String { boardID }
}

private struct UpcomingSortOptionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    let boardGrouping: UpcomingBoardGrouping
    let filterGroups: [UpcomingFilterGroup]
    let selectedOptionIDs: Set<String>
    let deviceCalendarEnabled: Bool
    let deviceRemindersEnabled: Bool
    let usHolidaysEnabled: Bool
    let filterPresets: [UpcomingFilterPreset]
    let onSelectSort: (UpcomingSortMode) -> Void
    let onSelectGrouping: (UpcomingBoardGrouping) -> Void
    let onToggleOption: (String) -> Void
    let onSelectAllBoards: () -> Void
    let onToggleDeviceCalendar: () -> Void
    let onToggleDeviceReminders: () -> Void
    let onToggleUsHolidays: () -> Void
    let onApplyPreset: (UpcomingFilterPreset) -> Void
    let onSavePreset: (String) -> Void
    let onDeletePreset: (UpcomingFilterPreset) -> Void

    @State private var showingSavePresetAlert = false
    @State private var newPresetName = ""
    @State private var presetPendingDeletion: UpcomingFilterPreset?

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    sectionTitle("Sort tasks by")
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(UpcomingSortMode.allCases, id: \.rawValue) { mode in
                            Button {
                                onSelectSort(mode)
                            } label: {
                                HStack(spacing: 7) {
                                    Text(mode.label)
                                    if sortMode == mode, mode.supportsDirection {
                                        Image(systemName: sortDirection == .ascending ? "arrow.up" : "arrow.down")
                                    }
                                }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(sortMode == mode ? .white : TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .background(
                                    sortMode == mode ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                    in: Capsule()
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    sectionTitle("Boards")
                    Picker(
                        "Board grouping",
                        selection: Binding(
                            get: { boardGrouping },
                            set: onSelectGrouping
                        )
                    ) {
                        ForEach(UpcomingBoardGrouping.allCases, id: \.rawValue) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)

                    sectionTitle("Apple")

                    Button(action: onToggleDeviceCalendar) {
                        HStack(spacing: 12) {
                            Image(systemName: deviceCalendarEnabled
                                ? "checkmark.circle.fill"
                                : "circle")
                                .foregroundStyle(deviceCalendarEnabled
                                    ? TaskifyTheme.accent
                                    : TaskifyTheme.tertiaryText)
                            Image(systemName: "calendar")
                                .foregroundStyle(Color.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Apple Calendar")
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Show device calendar events")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 56)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)

                    Button(action: onToggleDeviceReminders) {
                        HStack(spacing: 12) {
                            Image(systemName: deviceRemindersEnabled
                                ? "checkmark.circle.fill"
                                : "circle")
                                .foregroundStyle(deviceRemindersEnabled
                                    ? TaskifyTheme.accent
                                    : TaskifyTheme.tertiaryText)
                            Image(systemName: "checklist")
                                .foregroundStyle(Color.purple)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Apple Reminders")
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Show and complete due reminders")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 56)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)

                    Button(action: onToggleUsHolidays) {
                        HStack(spacing: 12) {
                            Image(systemName: usHolidaysEnabled
                                ? "checkmark.circle.fill"
                                : "circle")
                                .foregroundStyle(usHolidaysEnabled
                                    ? TaskifyTheme.accent
                                    : TaskifyTheme.tertiaryText)
                            Image(systemName: "star.fill")
                                .foregroundStyle(Color.pink)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("US Holidays")
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Show federal holidays and DST changes")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 56)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)

                    HStack {
                        sectionTitle("Filter presets")
                        Spacer()
                        Button {
                            newPresetName = ""
                            showingSavePresetAlert = true
                        } label: {
                            Label("Save current", systemImage: "plus.circle")
                        }
                        .font(.caption.weight(.semibold))
                    }

                    if filterPresets.isEmpty {
                        Text("Select boards below, then save the combination as a reusable preset.")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    } else {
                        ScrollView(.horizontal) {
                            HStack(spacing: 8) {
                                ForEach(filterPresets) { preset in
                                    Button {
                                        onApplyPreset(preset)
                                    } label: {
                                        Text(preset.name)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(TaskifyTheme.primaryText)
                                            .padding(.horizontal, 14)
                                            .frame(height: 36)
                                            .background(TaskifyTheme.raisedFill, in: Capsule())
                                    }
                                    .buttonStyle(.plain)
                                    .onLongPressGesture(minimumDuration: 0.5) {
                                        presetPendingDeletion = preset
                                    }
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                        Text("Touch and hold a preset to delete it.")
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    }

                    HStack {
                        sectionTitle("Taskify boards")
                        Spacer()
                        Button("Select all", action: onSelectAllBoards)
                            .font(.caption.weight(.semibold))
                    }

                    VStack(spacing: 0) {
                        ForEach(filterGroups) { group in
                            filterOptionRow(group.boardOption, subtitle: group.board.kind == .list ? "List" : "Week")
                            if group.board.id != filterGroups.last?.board.id || !group.listOptions.isEmpty {
                                Divider().overlay(TaskifyTheme.border)
                            }
                            ForEach(group.listOptions) { listOption in
                                filterOptionRow(listOption, indented: true)
                                if listOption.id != group.listOptions.last?.id || group.board.id != filterGroups.last?.board.id {
                                    Divider().overlay(TaskifyTheme.border)
                                }
                            }
                        }
                    }
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18))
                }
                .padding(18)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Sort & Filter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Save preset", isPresented: $showingSavePresetAlert) {
                TextField("Preset name", text: $newPresetName)
                Button("Cancel", role: .cancel) { newPresetName = "" }
                Button("Save") {
                    onSavePreset(newPresetName)
                    newPresetName = ""
                }
                .disabled(newPresetName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text("Saves the boards currently selected below as a reusable filter.")
            }
            .confirmationDialog(
                "Delete \(presetPendingDeletion?.name ?? "preset")?",
                isPresented: Binding(
                    get: { presetPendingDeletion != nil },
                    set: { isPresented in
                        if !isPresented { presetPendingDeletion = nil }
                    }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let preset = presetPendingDeletion {
                        onDeletePreset(preset)
                    }
                    presetPendingDeletion = nil
                }
                Button("Cancel", role: .cancel) { presetPendingDeletion = nil }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption.weight(.bold))
            .tracking(0.8)
            .foregroundStyle(TaskifyTheme.secondaryText)
    }

    private func filterOptionRow(_ option: UpcomingFilterOption, subtitle: String? = nil, indented: Bool = false) -> some View {
        let isSelected = selectedOptionIDs.contains(option.id)
        return Button {
            onToggleOption(option.id)
        } label: {
            HStack(spacing: 12) {
                if indented {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? TaskifyTheme.accent : TaskifyTheme.tertiaryText)
                Text(option.label)
                    .font(indented ? .subheadline : .body)
                    .foregroundStyle(indented ? TaskifyTheme.secondaryText : TaskifyTheme.primaryText)
                Spacer()
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }
            .padding(.horizontal, 14)
            .padding(.leading, indented ? 14 : 0)
            .frame(height: indented ? 42 : 50)
        }
        .buttonStyle(.plain)
    }
}

private enum NewUpcomingItemType: String, CaseIterable {
    case task = "Task"
    case event = "Event"
}

private struct NewUpcomingItemSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var itemType = NewUpcomingItemType.task
    @State private var title = ""
    @State private var dueDate = Date()
    @State private var endDate = Date().addingTimeInterval(60 * 60)
    @State private var allDay = true
    @State private var details = ""
    @State private var location = ""
    @State private var boardID = ""
    @State private var columnID = ""
    @State private var timeZoneID = TimeZone.current.identifier
    @State private var reminders: [TaskReminder] = []
    @State private var reminderTime = Self.reminderClock(from: nil)
    @State private var showingTimeZonePicker = false
    @State private var repeatChoice = TaskifyEventRepeatChoice.never
    @State private var repeatHasEnd = false
    @State private var repeatEndDate = Date().addingTimeInterval(180 * 24 * 60 * 60)

    private var eventBoards: [Board] {
        model.visibleBoards.filter { $0.kind == .week || $0.kind == .list }
    }

    private var selectedEventBoard: Board? {
        eventBoards.first { $0.id == boardID }
    }

    private var selectedBoardColumns: [BoardColumn] {
        guard selectedEventBoard?.kind == .list else { return [] }
        return selectedEventBoard?.columns.sorted { $0.order < $1.order } ?? []
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Type", selection: $itemType) {
                        ForEach(NewUpcomingItemType.allCases, id: \.rawValue) { type in
                            Text(type.rawValue).tag(type)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section(itemType.rawValue) {
                    TextField("Title", text: $title)
                    if itemType == .task {
                        DatePicker("Due date", selection: $dueDate, displayedComponents: .date)
                    } else {
                        Picker("Board", selection: $boardID) {
                            ForEach(eventBoards) { board in
                                Text(board.name).tag(board.id)
                            }
                        }
                        if selectedEventBoard?.kind == .list {
                            Picker("List", selection: $columnID) {
                                ForEach(selectedBoardColumns) { column in
                                    Text(column.name).tag(column.id)
                                }
                            }
                        }
                        Toggle("All-day", isOn: $allDay)
                        DatePicker(
                            "Starts",
                            selection: $dueDate,
                            displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                        )
                        .environment(\.timeZone, selectedTimeZone)
                        DatePicker(
                            "Ends",
                            selection: $endDate,
                            in: dueDate...,
                            displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                        )
                        .environment(\.timeZone, selectedTimeZone)
                        if !allDay {
                            Button {
                                showingTimeZonePicker = true
                            } label: {
                                LabeledContent("Time Zone", value: timeZoneID)
                            }
                            .foregroundStyle(TaskifyTheme.primaryText)
                        }
                        TextField("Location (optional)", text: $location)
                    }
                }

                if itemType == .event {
                    TaskifyEventRemindersSection(
                        isAllDay: allDay,
                        reminders: $reminders,
                        reminderTime: $reminderTime
                    )
                    TaskifyEventRepeatSection(
                        choice: $repeatChoice,
                        hasEnd: $repeatHasEnd,
                        endDate: $repeatEndDate,
                        minimumEndDate: dueDate,
                        preservesCustomRule: false
                    )
                    Section("Notes") {
                        TextEditor(text: $details)
                            .frame(minHeight: 100)
                    }
                }
            }
            .navigationTitle("New \(itemType.rawValue)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        if itemType == .task {
                            model.addTask(title: title, dueDate: dueDate)
                        } else {
                            _ = model.addTaskifyEvent(
                                title: title,
                                details: details,
                                location: location,
                                startDate: dueDate,
                                endDate: endDate,
                                isAllDay: allDay,
                                boardID: boardID,
                                columnID: columnID.isEmpty ? nil : columnID,
                                startTimeZoneID: timeZoneID,
                                reminders: reminders,
                                reminderTime: formattedReminderTime,
                                recurrence: recurrence
                            )
                        }
                        dismiss()
                    }
                    .disabled(
                        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                            (itemType == .event && !eventPlacementIsValid)
                    )
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showingTimeZonePicker) {
            TimeZonePickerSheet(selection: $timeZoneID, referenceDate: dueDate)
                .preferredColorScheme(.dark)
        }
        .onAppear {
            guard boardID.isEmpty else { return }
            if let selected = model.selectedBoard,
               eventBoards.contains(where: { $0.id == selected.id }) {
                boardID = selected.id
            } else {
                boardID = eventBoards.first?.id ?? ""
            }
            resolveSelectedColumn()
        }
        .onChange(of: boardID) { _, _ in resolveSelectedColumn() }
        .onChange(of: dueDate) { _, newStart in
            if endDate < newStart {
                endDate = allDay
                    ? newStart
                    : newStart.addingTimeInterval(60 * 60)
            }
            if repeatEndDate < newStart {
                repeatEndDate = newStart
            }
        }
        .onChange(of: timeZoneID) { oldZoneID, newZoneID in
            guard oldZoneID != newZoneID else { return }
            dueDate = taskifyRebasedWallClock(dueDate, from: oldZoneID, to: newZoneID)
            endDate = taskifyRebasedWallClock(endDate, from: oldZoneID, to: newZoneID)
        }
    }

    private var selectedTimeZone: TimeZone {
        TimeZone(identifier: timeZoneID) ?? .current
    }

    private var eventPlacementIsValid: Bool {
        guard let board = selectedEventBoard else { return false }
        return board.kind == .week || selectedBoardColumns.contains(where: { $0.id == columnID })
    }

    private func resolveSelectedColumn() {
        guard selectedEventBoard?.kind == .list else {
            columnID = ""
            return
        }
        if !selectedBoardColumns.contains(where: { $0.id == columnID }) {
            columnID = selectedBoardColumns.first?.id ?? ""
        }
    }

    private var formattedReminderTime: String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: reminderTime)
        return String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0)
    }

    private var recurrence: TaskRecurrence? {
        TaskifyEventRepeatChoice.recurrence(
            for: repeatChoice,
            startDate: dueDate,
            timeZoneID: allDay ? "UTC" : timeZoneID,
            until: repeatHasEnd ? repeatEndDate : nil,
            preserving: nil
        )
    }

    private static func reminderClock(from value: String?) -> Date {
        let parts = (value ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) } ?? 0
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }
}

private struct TaskifyEventEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var details: String
    @State private var location: String
    @State private var boardID: String
    @State private var columnID: String
    @State private var startDate: Date
    @State private var endDate: Date
    @State private var allDay: Bool
    @State private var timeZoneID: String
    @State private var reminders: [TaskReminder]
    @State private var reminderTime: Date
    @State private var showingTimeZonePicker = false
    @State private var repeatChoice: TaskifyEventRepeatChoice
    @State private var repeatHasEnd: Bool
    @State private var repeatEndDate: Date
    @State private var confirmingDeletion = false
    let event: TaskifyEvent

    init(event: TaskifyEvent) {
        self.event = event
        let start = event.startDate ?? Date()
        _title = State(initialValue: event.title)
        _details = State(initialValue: event.details ?? "")
        _location = State(initialValue: event.locations?.first ?? "")
        _boardID = State(initialValue: event.boardID ?? "")
        _columnID = State(initialValue: event.columnID ?? "")
        _startDate = State(initialValue: start)
        _endDate = State(initialValue: event.endDate ?? start.addingTimeInterval(60 * 60))
        _allDay = State(initialValue: event.isAllDay)
        _timeZoneID = State(initialValue: event.startTimeZoneID ?? TimeZone.current.identifier)
        _reminders = State(initialValue: event.reminders ?? [])
        _reminderTime = State(initialValue: Self.reminderClock(from: event.reminderTime))
        _repeatChoice = State(initialValue: TaskifyEventRepeatChoice(event.recurrence))
        _repeatHasEnd = State(initialValue: event.recurrence?.untilDate != nil)
        _repeatEndDate = State(
            initialValue: event.recurrence?.untilDate
                ?? Calendar.current.date(byAdding: .month, value: 6, to: start)
                ?? start
        )
    }

    private var eventBoards: [Board] {
        model.visibleBoards.filter { $0.kind == .week || $0.kind == .list }
    }

    private var selectedEventBoard: Board? {
        eventBoards.first { $0.id == boardID }
    }

    private var selectedBoardColumns: [BoardColumn] {
        guard selectedEventBoard?.kind == .list else { return [] }
        return selectedEventBoard?.columns.sorted { $0.order < $1.order } ?? []
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Event") {
                    TextField("Title", text: $title)
                    Picker("Board", selection: $boardID) {
                        ForEach(eventBoards) { board in
                            Text(board.name).tag(board.id)
                        }
                    }
                    if selectedEventBoard?.kind == .list {
                        Picker("List", selection: $columnID) {
                            ForEach(selectedBoardColumns) { column in
                                Text(column.name).tag(column.id)
                            }
                        }
                    }
                    Toggle("All-day", isOn: $allDay)
                    DatePicker(
                        "Starts",
                        selection: $startDate,
                        displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                    )
                    .environment(\.timeZone, selectedTimeZone)
                    DatePicker(
                        "Ends",
                        selection: $endDate,
                        in: startDate...,
                        displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                    )
                    .environment(\.timeZone, selectedTimeZone)
                    if !allDay {
                        Button {
                            showingTimeZonePicker = true
                        } label: {
                            LabeledContent("Time Zone", value: timeZoneID)
                        }
                        .foregroundStyle(TaskifyTheme.primaryText)
                    }
                    TextField("Location (optional)", text: $location)
                }

                TaskifyEventRemindersSection(
                    isAllDay: allDay,
                    reminders: $reminders,
                    reminderTime: $reminderTime
                )

                if canEditSeriesRecurrence {
                    TaskifyEventRepeatSection(
                        choice: $repeatChoice,
                        hasEnd: $repeatHasEnd,
                        endDate: $repeatEndDate,
                        minimumEndDate: startDate,
                        preservesCustomRule: repeatChoice == .custom
                    )
                } else if event.recurrence?.isActive == true {
                    Section("Repeat") {
                        Label(TaskifyEventRepeatChoice(event.recurrence).label, systemImage: "repeat")
                        Text("Edit the first event in this series to change its repeat schedule.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Notes") {
                    TextEditor(text: $details)
                        .frame(minHeight: 100)
                }

                Section {
                    Button("Delete Event", role: .destructive) {
                        confirmingDeletion = true
                    }
                }
            }
            .navigationTitle("Edit Event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if model.updateTaskifyEvent(
                            eventID: event.id,
                            title: title,
                            details: details,
                            location: location,
                            startDate: startDate,
                            endDate: endDate,
                            isAllDay: allDay,
                            boardID: boardID,
                            columnID: columnID.isEmpty ? nil : columnID,
                            startTimeZoneID: timeZoneID,
                            reminders: reminders,
                            reminderTime: formattedReminderTime,
                            recurrence: recurrence
                        ) {
                            dismiss()
                        }
                    }
                    .disabled(
                        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || !eventPlacementIsValid
                    )
                }
            }
            .confirmationDialog(
                "Delete this Taskify event?",
                isPresented: $confirmingDeletion,
                titleVisibility: .visible
            ) {
                Button(
                    event.recurrence?.isActive == true ? "Delete This Event" : "Delete Event",
                    role: .destructive
                ) {
                    model.deleteTaskifyEvent(event.id, scope: .single)
                    dismiss()
                }
                if event.recurrence?.isActive == true {
                    Button("Delete This and Future Events", role: .destructive) {
                        model.deleteTaskifyEvent(event.id, scope: .thisAndFuture)
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The deletion will sync to the PWA and other clients.")
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showingTimeZonePicker) {
            TimeZonePickerSheet(selection: $timeZoneID, referenceDate: startDate)
                .preferredColorScheme(.dark)
        }
        .onAppear {
            if !eventBoards.contains(where: { $0.id == boardID }) {
                boardID = eventBoards.first?.id ?? ""
            }
            resolveSelectedColumn()
        }
        .onChange(of: boardID) { _, _ in resolveSelectedColumn() }
        .onChange(of: startDate) { _, newStart in
            if endDate < newStart {
                endDate = allDay
                    ? newStart
                    : newStart.addingTimeInterval(60 * 60)
            }
            if repeatEndDate < newStart {
                repeatEndDate = newStart
            }
        }
        .onChange(of: timeZoneID) { oldZoneID, newZoneID in
            guard oldZoneID != newZoneID else { return }
            startDate = taskifyRebasedWallClock(startDate, from: oldZoneID, to: newZoneID)
            endDate = taskifyRebasedWallClock(endDate, from: oldZoneID, to: newZoneID)
        }
    }

    private var selectedTimeZone: TimeZone {
        TimeZone(identifier: timeZoneID) ?? .current
    }

    private var eventPlacementIsValid: Bool {
        guard let board = selectedEventBoard else { return false }
        return board.kind == .week || selectedBoardColumns.contains(where: { $0.id == columnID })
    }

    private func resolveSelectedColumn() {
        guard selectedEventBoard?.kind == .list else {
            columnID = ""
            return
        }
        if !selectedBoardColumns.contains(where: { $0.id == columnID }) {
            columnID = selectedBoardColumns.first?.id ?? ""
        }
    }

    private var formattedReminderTime: String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: reminderTime)
        return String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0)
    }

    private var canEditSeriesRecurrence: Bool {
        event.seriesID == nil || event.seriesID == event.id
    }

    private var recurrence: TaskRecurrence? {
        guard canEditSeriesRecurrence else { return event.recurrence }
        return TaskifyEventRepeatChoice.recurrence(
            for: repeatChoice,
            startDate: startDate,
            timeZoneID: allDay ? "UTC" : timeZoneID,
            until: repeatHasEnd ? repeatEndDate : nil,
            preserving: event.recurrence
        )
    }

    private static func reminderClock(from value: String?) -> Date {
        let parts = (value ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) } ?? 0
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }
}

private enum TaskifyEventRepeatChoice: String, CaseIterable, Identifiable {
    case never
    case hourly
    case daily
    case weekdays
    case weekends
    case weekly
    case biweekly
    case monthly
    case quarterly
    case yearly
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .never: "Never"
        case .hourly: "Hourly"
        case .daily: "Daily"
        case .weekdays: "Every Weekday"
        case .weekends: "Every Weekend"
        case .weekly: "Weekly"
        case .biweekly: "Every 2 Weeks"
        case .monthly: "Monthly"
        case .quarterly: "Every 3 Months"
        case .yearly: "Yearly"
        case .custom: "Custom"
        }
    }

    init(_ recurrence: TaskRecurrence?) {
        guard let recurrence, recurrence.isActive else {
            self = .never
            return
        }
        switch recurrence {
        case .daily:
            self = .daily
        case .weekly(let days, _):
            let normalized = Set(days)
            if normalized == Set([1, 2, 3, 4, 5]) {
                self = .weekdays
            } else if normalized == Set([0, 6]) {
                self = .weekends
            } else if normalized.count == 1 {
                self = .weekly
            } else {
                self = .custom
            }
        case .every(let count, .hour, _):
            self = count == 1 ? .hourly : .custom
        case .every(let count, .week, _):
            self = count == 2 ? .biweekly : .custom
        case .every:
            self = .custom
        case .monthlyDay(_, let interval, _):
            switch max(1, interval ?? 1) {
            case 1: self = .monthly
            case 3: self = .quarterly
            case 12: self = .yearly
            default: self = .custom
            }
        case .none:
            self = .never
        }
    }

    static func recurrence(
        for choice: TaskifyEventRepeatChoice,
        startDate: Date,
        timeZoneID: String,
        until: Date?,
        preserving existing: TaskRecurrence?
    ) -> TaskRecurrence? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeZoneID) ?? .current
        let normalizedUntil = until.flatMap {
            calendar.date(bySettingHour: 12, minute: 0, second: 0, of: $0)
        }
        let weekday = calendar.component(.weekday, from: startDate) - 1
        let monthDay = min(max(calendar.component(.day, from: startDate), 1), 28)
        switch choice {
        case .never:
            return nil
        case .hourly:
            return .every(1, .hour, until: normalizedUntil)
        case .daily:
            return .daily(until: normalizedUntil)
        case .weekdays:
            return .weekly(days: [1, 2, 3, 4, 5], until: normalizedUntil)
        case .weekends:
            return .weekly(days: [0, 6], until: normalizedUntil)
        case .weekly:
            return .weekly(days: [weekday], until: normalizedUntil)
        case .biweekly:
            return .every(2, .week, until: normalizedUntil)
        case .monthly:
            return .monthlyDay(day: monthDay, until: normalizedUntil)
        case .quarterly:
            return .monthlyDay(day: monthDay, interval: 3, until: normalizedUntil)
        case .yearly:
            return .monthlyDay(day: monthDay, interval: 12, until: normalizedUntil)
        case .custom:
            return existing?.isActive == true ? existing?.withUntilDate(normalizedUntil) : nil
        }
    }
}

private struct TaskifyEventRepeatSection: View {
    @Binding var choice: TaskifyEventRepeatChoice
    @Binding var hasEnd: Bool
    @Binding var endDate: Date
    let minimumEndDate: Date
    let preservesCustomRule: Bool

    var body: some View {
        Section("Repeat") {
            Picker("Repeat", selection: $choice) {
                ForEach(availableChoices) { option in
                    Text(option.label).tag(option)
                }
            }
            if choice != .never {
                Toggle("End repeat", isOn: $hasEnd)
                if hasEnd {
                    DatePicker(
                        "End date",
                        selection: $endDate,
                        in: minimumEndDate...,
                        displayedComponents: .date
                    )
                }
            }
            if choice == .custom {
                Text("This custom PWA repeat rule will be preserved. Choose a preset to replace it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var availableChoices: [TaskifyEventRepeatChoice] {
        TaskifyEventRepeatChoice.allCases.filter { $0 != .custom || preservesCustomRule }
    }
}

private struct TaskifyEventRemindersSection: View {
    let isAllDay: Bool
    @Binding var reminders: [TaskReminder]
    @Binding var reminderTime: Date

    var body: some View {
        Section("Reminders") {
            ForEach(presets) { reminder in
                Toggle(reminder.eventLabel, isOn: binding(for: reminder))
            }
            if isAllDay {
                DatePicker("Reminder time", selection: $reminderTime, displayedComponents: .hourAndMinute)
                Text("All-day events use your current time zone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !reminders.isEmpty {
                Text("iOS will ask for notification permission when you save.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var presets: [TaskReminder] {
        isAllDay ? TaskReminder.datePresets : TaskReminder.timedPresets
    }

    private func binding(for reminder: TaskReminder) -> Binding<Bool> {
        Binding(
            get: { reminders.contains { $0.minutesBefore == reminder.minutesBefore } },
            set: { selected in
                reminders.removeAll { $0.minutesBefore == reminder.minutesBefore }
                if selected { reminders.append(reminder) }
            }
        )
    }
}

private func taskifyRebasedWallClock(_ date: Date, from oldZoneID: String, to newZoneID: String) -> Date {
    guard let oldZone = TimeZone(identifier: oldZoneID),
          let newZone = TimeZone(identifier: newZoneID) else { return date }
    var oldCalendar = Calendar(identifier: .gregorian)
    oldCalendar.timeZone = oldZone
    let components = oldCalendar.dateComponents(
        [.year, .month, .day, .hour, .minute, .second],
        from: date
    )
    var newCalendar = Calendar(identifier: .gregorian)
    newCalendar.timeZone = newZone
    return newCalendar.date(from: components) ?? date
}
