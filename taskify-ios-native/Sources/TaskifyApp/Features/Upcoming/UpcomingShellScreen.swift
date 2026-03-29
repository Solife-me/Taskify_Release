import SwiftUI
import TaskifyCore

private enum UpcomingPresentationStyle: String, CaseIterable, Identifiable {
    case details
    case list

    var id: String { rawValue }

    var label: String {
        switch self {
        case .details: return "Details"
        case .list: return "List"
        }
    }
}

struct UpcomingShellScreen: View {
    let profile: TaskifyProfile

    @EnvironmentObject private var dataController: DataController
    @EnvironmentObject private var settingsManager: SettingsManager

    @StateObject private var viewModel: UpcomingViewModel

    @State private var editingTask: BoardTaskItem? = nil
    @State private var selectedEvent: UpcomingCalendarEventItem? = nil
    @State private var showCreateTask = false
    @State private var showSortSheet = false
    @State private var showFilterSheet = false
    @State private var viewStyle: UpcomingPresentationStyle
    @State private var listDateKey = upcomingDateKey(for: Date())
    @State private var listMonthAnchor = startOfMonth(for: Date())
    @State private var pendingDetailScrollDateKey: String? = nil
    @State private var upcomingBoards: [UpcomingBoardDefinition] = []

    private let preferencesStore: UpcomingPreferencesStore

    init(profile: TaskifyProfile) {
        self.profile = profile
        let store = UpcomingPreferencesStore()
        let preferences = store.load()
        self.preferencesStore = store
        _viewModel = StateObject(wrappedValue: UpcomingViewModel(preferences: preferences))
        _viewStyle = State(initialValue: UpcomingPresentationStyle(rawValue: preferences.viewStyle) ?? .details)
    }

    private var canCreateTask: Bool {
        creatableBoards.isEmpty == false
    }

    private var creatableBoards: [UpcomingBoardDefinition] {
        upcomingBoards.filter { $0.kind != "bible" && $0.kind != "compound" }
    }

    private var selectedDayTasks: [BoardTaskItem] {
        viewModel.tasks(for: listDateKey)
    }

    private var selectedDayEvents: [UpcomingCalendarEventItem] {
        viewModel.events(for: listDateKey)
    }

    private var selectedDayItemCount: Int {
        selectedDayTasks.count + selectedDayEvents.count
    }

    private var filteredIsEmpty: Bool {
        viewModel.itemCount == 0
    }

    private var selectedDateLabel: String {
        if let date = dateFromUpcomingKey(listDateKey) {
            return upcomingSelectedDateFormatter.string(from: date)
        }
        return listDateKey
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                controlsBar

                Divider()

                Group {
                    if viewStyle == .list {
                        listView
                    } else {
                        detailsView
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(ThemeColors.surfaceGrouped.ignoresSafeArea())
            .navigationTitle("Upcoming")
            .searchable(text: $viewModel.searchText, prompt: "Search title, notes, or event details")
            .toolbar {
                ToolbarItemGroup(placement: PlatformToolbarPlacement.trailing) {
                    Button {
                        viewStyle = viewStyle == .list ? .details : .list
                    } label: {
                        Image(systemName: viewStyle == .list ? "calendar" : "list.bullet")
                    }
                    .accessibilityLabel("Change upcoming view")

                    Button {
                        showSortSheet = true
                    } label: {
                        Image(systemName: "arrow.up.arrow.down.circle")
                    }
                    .accessibilityLabel("Sort upcoming tasks")

                    Button {
                        showCreateTask = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(!canCreateTask)
                    .accessibilityLabel("Add task")
                }
            }
            .onAppear { loadUpcoming() }
            .task {
                await refreshUpcoming()
            }
            .onChange(of: dataController.boardDefinitionsVersion) { _, _ in
                loadUpcoming()
                Task {
                    await refreshUpcoming()
                }
            }
            .onChange(of: dataController.calendarEventsVersion) { _, _ in
                loadUpcoming()
            }
            .onChange(of: viewStyle) { _, nextStyle in
                if nextStyle == .details {
                    pendingDetailScrollDateKey = viewModel.resolvedDateKey(preferred: listDateKey)
                } else if let selected = dateFromUpcomingKey(listDateKey) {
                    listMonthAnchor = startOfMonth(for: selected)
                }
                persistPreferences()
            }
            .onChange(of: viewModel.selectedFilterIDs) { _, _ in persistPreferences() }
            .onChange(of: viewModel.sortMode) { _, _ in persistPreferences() }
            .onChange(of: viewModel.sortAscending) { _, _ in persistPreferences() }
            .onChange(of: viewModel.boardGrouping) { _, _ in persistPreferences() }
            .onChange(of: viewModel.filterPresets) { _, _ in persistPreferences() }
            .sheet(item: $editingTask) { task in
                UpcomingTaskEditWrapper(task: task, dataController: dataController, onDone: {
                    loadUpcoming()
                    editingTask = nil
                })
            }
            .sheet(item: $selectedEvent) { event in
                UpcomingEventDetailSheet(
                    event: event,
                    timeLabel: viewModel.eventTimeLabel(for: event, showDate: true),
                    locationLabel: viewModel.locationLabel(for: event)
                )
                .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $showCreateTask) {
                UpcomingTaskCreateWrapper(
                    dateKey: listDateKey,
                    boards: creatableBoards,
                    dataController: dataController,
                    onDone: {
                        loadUpcoming()
                        showCreateTask = false
                    }
                )
                .presentationDetents([.large])
            }
            .sheet(isPresented: $showSortSheet) {
                UpcomingSortSheet(
                    sortMode: viewModel.sortMode,
                    sortAscending: viewModel.sortAscending,
                    boardGrouping: viewModel.boardGrouping,
                    onSelectSortMode: { mode in
                        viewModel.selectSortMode(mode)
                    },
                    onSelectGrouping: { grouping in
                        viewModel.setBoardGrouping(grouping)
                    }
                )
                .presentationDetents([.medium])
            }
            .sheet(isPresented: $showFilterSheet) {
                UpcomingFilterSheet(
                    filterGroups: viewModel.filterGroups,
                    selectedFilterIDs: viewModel.selectedFilterIDs,
                    filterPresets: viewModel.filterPresets,
                    onToggle: { optionID in
                        viewModel.toggleFilterOption(optionID)
                    },
                    onSelectAll: {
                        viewModel.selectAllFilters()
                    },
                    onClearAll: {
                        viewModel.clearAllFilters()
                    },
                    onApplyPreset: { preset in
                        viewModel.applyFilterPreset(preset)
                    },
                    onSavePreset: { name in
                        viewModel.saveFilterPreset(named: name)
                    },
                    onDeletePreset: { preset in
                        viewModel.deleteFilterPreset(preset)
                    }
                )
                .presentationDetents([.medium, .large])
            }
        }
    }

    private var controlsBar: some View {
        HStack(spacing: 10) {
            Button(action: jumpToToday) {
                Text("Today")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(ThemeColors.surfaceRaised)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(viewStyle == .details && filteredIsEmpty)

            Button(action: { showFilterSheet = true }) {
                HStack(spacing: 6) {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .font(.subheadline)
                    Text(viewModel.filterLabel)
                        .font(.subheadline)
                        .lineLimit(1)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(ThemeColors.surfaceRaised)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)

            if viewModel.itemCount > 0 {
                Text("\(viewModel.itemCount)")
                    .font(.caption.bold())
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.14))
                    .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .background(ThemeColors.surfaceGrouped)
    }

    private var detailsView: some View {
        ScrollViewReader { proxy in
            Group {
                if filteredIsEmpty {
                    emptyState(message: emptyMessage)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(viewModel.groups) { group in
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack(alignment: .center, spacing: 8) {
                                        Text(group.label)
                                            .font(.headline)
                                        Text("\(group.tasks.count + group.events.count)")
                                            .font(.caption.bold())
                                            .foregroundStyle(.secondary)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(Color.secondary.opacity(0.12))
                                            .clipShape(Capsule())
                                    }

                                    VStack(spacing: 10) {
                                        ForEach(group.events) { event in
                                            upcomingEventCard(for: event)
                                        }
                                        ForEach(group.tasks) { task in
                                            upcomingTaskCard(for: task)
                                        }
                                    }
                                }
                                .id(group.dateKey)
                            }
                        }
                        .padding(16)
                    }
                    .refreshable {
                        await refreshUpcoming()
                    }
                    .onAppear {
                        scrollDetailsIfNeeded(using: proxy)
                    }
                    .onChange(of: pendingDetailScrollDateKey) { _, _ in
                        scrollDetailsIfNeeded(using: proxy)
                    }
                    .onChange(of: viewModel.groups) { _, _ in
                        scrollDetailsIfNeeded(using: proxy)
                    }
                }
            }
        }
    }

    private var listView: some View {
        ScrollView {
            VStack(spacing: 16) {
                UpcomingCalendarCard(
                    monthAnchor: listMonthAnchor,
                    selectedDateKey: listDateKey,
                    daysWithItems: viewModel.dayNumbersWithItems(inMonth: listMonthAnchor),
                    todayDateKey: upcomingDateKey(for: Date()),
                    weekStart: settingsManager.settings.weekStart,
                    onPreviousMonth: { moveListMonth(-1) },
                    onNextMonth: { moveListMonth(1) },
                    onSelectDay: { day in
                        selectListDay(day)
                    }
                )

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(selectedDateLabel)
                            .font(.headline)
                        Spacer()
                        if selectedDayItemCount > 0 {
                            Text("\(selectedDayItemCount)")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.secondary.opacity(0.12))
                                .clipShape(Capsule())
                        }
                    }

                    if selectedDayItemCount == 0 {
                        emptyInlineState(
                            filteredIsEmpty
                                ? "No upcoming items."
                                : "No items scheduled for this day."
                        )
                    } else {
                        VStack(spacing: 10) {
                            ForEach(selectedDayEvents) { event in
                                upcomingEventCard(for: event)
                            }
                            ForEach(selectedDayTasks) { task in
                                upcomingTaskCard(for: task)
                            }
                        }
                    }
                }
                .padding(16)
                .background(ThemeColors.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Color.primary.opacity(0.05), lineWidth: 1)
                )
            }
            .padding(16)
        }
        .refreshable {
            await refreshUpcoming()
        }
    }

    @ViewBuilder
    private func upcomingTaskCard(for task: BoardTaskItem) -> some View {
        TaskCardView(
            task: task,
            metaLabel: viewModel.locationLabel(for: task),
            priority: task.priority,
            subtasksJSON: task.subtasksJSON,
            dueTimeEnabled: task.dueTimeEnabled ?? false,
            streak: settingsManager.settings.streaksEnabled ? task.streak : nil,
            hasRecurrence: task.recurrenceJSON != nil,
            hideCompletedSubtasks: settingsManager.settings.hideCompletedSubtasks,
            onToggleComplete: {
                Task {
                    let _ = await dataController.toggleComplete(taskId: task.id)
                    loadUpcoming()
                }
            },
            onTap: {
                editingTask = task
            },
            onToggleSubtask: { subtaskID in
                Task {
                    let _ = await dataController.toggleSubtask(taskId: task.id, subtaskId: subtaskID)
                    loadUpcoming()
                }
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.05), lineWidth: 1)
        )
        .swipeActions(edge: .trailing) {
            Button {
                Task {
                    let _ = await dataController.toggleComplete(taskId: task.id)
                    loadUpcoming()
                }
            } label: {
                Label("Complete", systemImage: "checkmark")
            }
            .tint(.green)
        }
    }

    @ViewBuilder
    private func upcomingEventCard(for event: UpcomingCalendarEventItem) -> some View {
        Button {
            selectedEvent = event
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "calendar")
                    .font(.title3)
                    .foregroundStyle(ThemeColors.accentBlue)
                    .frame(width: 24, height: 24)

                VStack(alignment: .leading, spacing: 4) {
                    Text(event.title.isEmpty ? "Untitled" : event.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(3)

                    let timeLabel = viewModel.eventTimeLabel(for: event)
                    if !timeLabel.isEmpty {
                        Text(timeLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Text(viewModel.locationLabel(for: event))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    if let description = event.description,
                       !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(ThemeColors.surfaceBase)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.05), lineWidth: 1)
        )
    }

    private func emptyState(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "calendar.badge.checkmark")
                .font(.system(size: 46))
                .foregroundStyle(.secondary)
            Text("All caught up")
                .font(.title3.bold())
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    private func emptyInlineState(_ message: String) -> some View {
        Text(message)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyMessage: String {
        if !viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "No items match your search."
        }
        if viewModel.selectedFilterIDs != nil {
            return "No items match the current filters."
        }
        return "Tasks and events with dates will appear here."
    }

    private func loadUpcoming() {
        let currentProfile = dataController.currentProfile ?? profile
        let boardIDs = currentProfile.boards.map(\.id)
        let boards = dataController.upcomingBoardDefinitions(boardIds: boardIDs)
        let tasks = dataController.fetchUpcomingTasks(boardIds: boardIDs)
        let events = dataController.fetchUpcomingCalendarEvents(boardIds: boardIDs)

        upcomingBoards = boards
        viewModel.setBoards(boards)
        viewModel.setTasks(tasks)
        viewModel.setEvents(events)

        if viewStyle == .details {
            pendingDetailScrollDateKey = viewModel.resolvedDateKey(preferred: listDateKey)
        } else if let selected = dateFromUpcomingKey(listDateKey) {
            listMonthAnchor = startOfMonth(for: selected)
        }
    }

    private func refreshUpcoming() async {
        loadUpcoming()
        let currentProfile = dataController.currentProfile ?? profile
        let boardIDs = currentProfile.boards.map(\.id)
        await dataController.refreshUpcomingCalendarEvents(boardIds: boardIDs)
        loadUpcoming()
    }

    private func jumpToToday() {
        let todayKey = upcomingDateKey(for: Date())

        if viewStyle == .list {
            listDateKey = todayKey
            listMonthAnchor = startOfMonth(for: Date())
            return
        }

        pendingDetailScrollDateKey = viewModel.resolvedDateKey(preferred: todayKey)
    }

    private func scrollDetailsIfNeeded(using proxy: ScrollViewProxy) {
        guard let target = pendingDetailScrollDateKey else { return }
        guard viewModel.resolvedDateKey(preferred: target) != nil else { return }

        withAnimation(.easeInOut(duration: 0.24)) {
            proxy.scrollTo(target, anchor: .top)
        }
        pendingDetailScrollDateKey = nil
    }

    private func moveListMonth(_ delta: Int) {
        let calendar = Calendar.current
        guard let shifted = calendar.date(byAdding: .month, value: delta, to: listMonthAnchor) else { return }
        let nextAnchor = startOfMonth(for: shifted)
        listMonthAnchor = nextAnchor

        let selectedDate = dateFromUpcomingKey(listDateKey) ?? Date()
        let desiredDay = calendar.component(.day, from: selectedDate)
        let dayRange = calendar.range(of: .day, in: .month, for: nextAnchor) ?? 1..<29
        let clampedDay = min(desiredDay, dayRange.count)

        var components = calendar.dateComponents([.year, .month], from: nextAnchor)
        components.day = clampedDay
        if let nextDate = calendar.date(from: components) {
            listDateKey = upcomingDateKey(for: nextDate)
        }
    }

    private func selectListDay(_ day: Int) {
        let calendar = Calendar.current
        var components = calendar.dateComponents([.year, .month], from: listMonthAnchor)
        components.day = day

        guard let date = calendar.date(from: components) else { return }
        listDateKey = upcomingDateKey(for: date)
    }

    private func persistPreferences() {
        preferencesStore.save(viewModel.currentPreferences(viewStyle: viewStyle.rawValue))
    }
}

private struct UpcomingCalendarCard: View {
    let monthAnchor: Date
    let selectedDateKey: String
    let daysWithItems: Set<Int>
    let todayDateKey: String
    let weekStart: Int
    let onPreviousMonth: () -> Void
    let onNextMonth: () -> Void
    let onSelectDay: (Int) -> Void

    private var monthLabel: String {
        upcomingMonthFormatter.string(from: monthAnchor)
    }

    private var weekdayLabels: [String] {
        let formatter = DateFormatter()
        let symbols = formatter.shortWeekdaySymbols ?? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        let offset = max(0, min(symbols.count - 1, weekStart))
        let ordered = Array(symbols[offset...]) + Array(symbols[..<offset])
        return ordered.map { String($0.prefix(3)) }
    }

    private var cells: [Int?] {
        let calendar = configuredCalendar(weekStart: weekStart)
        let firstOfMonth = startOfMonth(for: monthAnchor)
        let weekdayIndex = (calendar.component(.weekday, from: firstOfMonth) - calendar.firstWeekday + 7) % 7
        let dayRange = calendar.range(of: .day, in: .month, for: firstOfMonth) ?? (1..<31)

        var values = Array(repeating: Optional<Int>.none, count: weekdayIndex)
        values.append(contentsOf: dayRange.map(Optional.some))
        while values.count % 7 != 0 {
            values.append(nil)
        }
        return values
    }

    var body: some View {
        VStack(spacing: 14) {
            HStack {
                Button(action: onPreviousMonth) {
                    Image(systemName: "chevron.left")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)

                Spacer()

                Text(monthLabel)
                    .font(.headline)

                Spacer()

                Button(action: onNextMonth) {
                    Image(systemName: "chevron.right")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
            }

            HStack {
                ForEach(weekdayLabels, id: \.self) { label in
                    Text(label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
                ForEach(Array(cells.enumerated()), id: \.offset) { entry in
                    let day = entry.element
                    if let day {
                        dayCell(day)
                    } else {
                        Color.clear
                            .frame(height: 42)
                    }
                }
            }
        }
        .padding(16)
        .background(ThemeColors.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.05), lineWidth: 1)
        )
    }

    private func dayCell(_ day: Int) -> some View {
        let currentDate = dateForDay(day)
        let dateKey = upcomingDateKey(for: currentDate)
        let isSelected = dateKey == selectedDateKey
        let isToday = dateKey == todayDateKey
        let hasItems = daysWithItems.contains(day)

        return Button(action: { onSelectDay(day) }) {
            VStack(spacing: 4) {
                Text("\(day)")
                    .font(.subheadline.weight(isSelected ? .bold : .medium))
                    .frame(maxWidth: .infinity)
                Circle()
                    .fill(hasItems ? ThemeColors.accentBlue : .clear)
                    .frame(width: 5, height: 5)
            }
            .foregroundStyle(isSelected ? Color.white : (isToday ? ThemeColors.accentBlue : Color.primary))
            .frame(height: 42)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isSelected ? ThemeColors.accentBlue : (isToday ? ThemeColors.accentBlue.opacity(0.12) : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(isToday && !isSelected ? ThemeColors.accentBlue.opacity(0.35) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func dateForDay(_ day: Int) -> Date {
        let calendar = Calendar.current
        var components = calendar.dateComponents([.year, .month], from: monthAnchor)
        components.day = day
        return calendar.date(from: components) ?? monthAnchor
    }
}

private struct UpcomingEventDetailSheet: View {
    let event: UpcomingCalendarEventItem
    let timeLabel: String
    let locationLabel: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(event.title.isEmpty ? "Untitled" : event.title)
                            .font(.title3.weight(.semibold))
                        if !timeLabel.isEmpty {
                            Label(timeLabel, systemImage: "clock")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Text(locationLabel)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    if let summary = event.summary,
                       !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        detailSection(title: "Summary", value: summary)
                    }

                    if let description = event.description,
                       !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        detailSection(title: "Notes", value: description)
                    }

                    if !event.locations.isEmpty {
                        detailSection(title: "Locations", value: event.locations.joined(separator: "\n"))
                    }

                    if !event.references.isEmpty {
                        detailSection(title: "References", value: event.references.joined(separator: "\n"))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .navigationTitle("Event")
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func detailSection(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(value)
                .font(.body)
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(ThemeColors.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.05), lineWidth: 1)
        )
    }
}

private struct UpcomingSortSheet: View {
    let sortMode: TaskSortMode
    let sortAscending: Bool
    let boardGrouping: UpcomingBoardGrouping
    let onSelectSortMode: (TaskSortMode) -> Void
    let onSelectGrouping: (UpcomingBoardGrouping) -> Void

    @Environment(\.dismiss) private var dismiss

    private let sortOptions: [(TaskSortMode, String)] = [
        (.manual, "Manual"),
        (.dueDate, "Due date"),
        (.priority, "Priority"),
        (.createdAt, "Creation date"),
        (.alphabetical, "A-Z"),
    ]

    var body: some View {
        NavigationStack {
            List {
                Section("Sort By") {
                    ForEach(sortOptions, id: \.0) { option, label in
                        Button {
                            onSelectSortMode(option)
                        } label: {
                            HStack {
                                Text(label)
                                Spacer()
                                if sortMode == option {
                                    HStack(spacing: 6) {
                                        Text(sortAscending ? "Asc" : "Desc")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.blue)
                                    }
                                }
                            }
                        }
                        .tint(.primary)
                    }
                }

                Section("Boards") {
                    ForEach(UpcomingBoardGrouping.allCases) { option in
                        Button {
                            onSelectGrouping(option)
                        } label: {
                            HStack {
                                Text(option.label)
                                Spacer()
                                if boardGrouping == option {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.blue)
                                }
                            }
                        }
                        .tint(.primary)
                    }
                }
            }
            .navigationTitle("Sort")
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct UpcomingFilterSheet: View {
    let filterGroups: [UpcomingFilterGroup]
    let selectedFilterIDs: Set<String>?
    let filterPresets: [UpcomingFilterPreset]
    let onToggle: (String) -> Void
    let onSelectAll: () -> Void
    let onClearAll: () -> Void
    let onApplyPreset: (UpcomingFilterPreset) -> Void
    let onSavePreset: (String) -> Void
    let onDeletePreset: (UpcomingFilterPreset) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showSavePresetAlert = false
    @State private var presetName = ""
    @State private var presetPendingDelete: UpcomingFilterPreset? = nil

    private var selectedIDs: Set<String> {
        selectedFilterIDs ?? Set(filterGroups.flatMap { [$0.boardOption.id] + $0.listOptions.map(\.id) })
    }

    private var suggestedPresetName: String {
        "Preset \(filterPresets.count + 1)"
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        Button("Select All", action: onSelectAll)
                        Button("Clear All", action: onClearAll)
                        Button("Save Preset") {
                            presetName = suggestedPresetName
                            showSavePresetAlert = true
                        }
                        .disabled(filterGroups.isEmpty)
                    }
                    .font(.subheadline.weight(.semibold))
                }

                if !filterPresets.isEmpty {
                    Section("Presets") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(filterPresets) { preset in
                                    HStack(spacing: 8) {
                                        Button {
                                            onApplyPreset(preset)
                                        } label: {
                                            Text(preset.name)
                                                .font(.subheadline.weight(.semibold))
                                        }
                                        .buttonStyle(.plain)

                                        Menu {
                                            Button(role: .destructive) {
                                                presetPendingDelete = preset
                                            } label: {
                                                Label("Delete Preset", systemImage: "trash")
                                            }
                                        } label: {
                                            Image(systemName: "ellipsis.circle")
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(.secondary)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .background(ThemeColors.surfaceRaised)
                                    .clipShape(Capsule())
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }
                }

                if filterGroups.isEmpty {
                    Section {
                        Text("No boards yet.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(filterGroups) { group in
                        Section(group.label) {
                            filterRow(
                                label: group.label,
                                isSelected: selectedIDs.contains(group.boardOption.id),
                                action: { onToggle(group.boardOption.id) }
                            )

                            ForEach(group.listOptions) { option in
                                filterRow(
                                    label: option.label,
                                    isSelected: selectedIDs.contains(option.id),
                                    isChild: true,
                                    action: { onToggle(option.id) }
                                )
                            }
                        }
                    }
                }
            }
            .navigationTitle("Calendars")
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Save Preset", isPresented: $showSavePresetAlert) {
                TextField("Preset name", text: $presetName)
                Button("Cancel", role: .cancel) {
                    presetName = ""
                }
                Button("Save") {
                    let name = presetName.trimmingCharacters(in: .whitespacesAndNewlines)
                    onSavePreset(name.isEmpty ? suggestedPresetName : name)
                    presetName = ""
                }
            } message: {
                Text("Save the current board filter selection.")
            }
            .confirmationDialog(
                "Delete preset?",
                isPresented: Binding(
                    get: { presetPendingDelete != nil },
                    set: { isPresented in
                        if !isPresented {
                            presetPendingDelete = nil
                        }
                    }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let presetPendingDelete {
                        onDeletePreset(presetPendingDelete)
                    }
                    presetPendingDelete = nil
                }
                Button("Cancel", role: .cancel) {
                    presetPendingDelete = nil
                }
            } message: {
                Text(presetPendingDelete?.name ?? "")
            }
        }
    }

    private func filterRow(label: String, isSelected: Bool, isChild: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? .blue : .secondary)
                Text(label)
                    .padding(.leading, isChild ? 8 : 0)
                Spacer()
            }
        }
        .tint(.primary)
    }
}

private struct UpcomingTaskCreateWrapper: View {
    let dateKey: String
    let boards: [UpcomingBoardDefinition]
    let dataController: DataController
    let onDone: () -> Void

    @StateObject private var viewModel: TaskEditViewModel

    init(
        dateKey: String,
        boards: [UpcomingBoardDefinition],
        dataController: DataController,
        onDone: @escaping () -> Void
    ) {
        self.dateKey = dateKey
        self.boards = boards
        self.dataController = dataController
        self.onDone = onDone

        let defaultBoard = boards.first ?? UpcomingBoardDefinition(id: "", name: "Board", kind: "lists", columns: [])
        let defaultColumn = defaultBoard.columns.first
        let location = TaskLocation(
            boardId: defaultBoard.id,
            boardName: defaultBoard.name,
            columnId: defaultColumn?.id,
            columnName: defaultColumn?.name
        )
        _viewModel = StateObject(wrappedValue: TaskEditViewModel.forCreate(location: location))
    }

    var body: some View {
        Group {
            if boards.isEmpty {
                NavigationStack {
                    Text("Create a board first to add upcoming tasks.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(24)
                        .navigationTitle("New Task")
                }
            } else {
                TaskEditView(viewModel: viewModel)
                    .onAppear {
                        configureViewModel()
                    }
                    .onChange(of: viewModel.location.boardId) { _, newBoardID in
                        applyBoardSelection(boardID: newBoardID)
                    }
            }
        }
    }

    private func configureViewModel() {
        viewModel.availableBoards = boards.map { board in
            TaskLocation(boardId: board.id, boardName: board.name)
        }
        viewModel.dueDateEnabled = true
        if let selectedDate = dateFromUpcomingKey(dateKey) {
            viewModel.dueDate = selectedDate
            viewModel.dueTime = selectedDate
        }
        applyBoardSelection(boardID: viewModel.location.boardId)
        viewModel.onSave = { editVM in
            Task {
                let _ = await dataController.createTask(from: editVM)
                onDone()
            }
        }
    }

    private func applyBoardSelection(boardID: String) {
        guard let board = boards.first(where: { $0.id == boardID }) else { return }
        viewModel.location.boardId = board.id
        viewModel.location.boardName = board.name
        if board.kind == "lists" {
            viewModel.availableColumns = board.columns
            if let column = board.columns.first(where: { $0.id == viewModel.location.columnId }) ?? board.columns.first {
                viewModel.location.columnId = column.id
                viewModel.location.columnName = column.name
            } else {
                viewModel.location.columnId = nil
                viewModel.location.columnName = nil
            }
        } else {
            viewModel.availableColumns = []
            viewModel.location.columnId = nil
            viewModel.location.columnName = nil
        }
    }
}

private struct UpcomingTaskEditWrapper: View {
    let task: BoardTaskItem
    let dataController: DataController
    let onDone: () -> Void

    @StateObject private var vm: TaskEditViewModel

    init(task: BoardTaskItem, dataController: DataController, onDone: @escaping () -> Void) {
        self.task = task
        self.dataController = dataController
        self.onDone = onDone
        let loc = TaskLocation(boardId: task.boardId ?? "", boardName: task.boardName ?? "", columnId: task.columnId)
        _vm = StateObject(wrappedValue: TaskEditViewModel.forEdit(task: task, location: loc))
    }

    var body: some View {
        TaskEditView(viewModel: vm)
            .onAppear {
                vm.availableColumns = dataController.boardColumns(boardId: task.boardId ?? "")
                vm.onSave = { editVM in
                    Task {
                        let _ = await dataController.updateTask(taskId: task.id, from: editVM)
                        onDone()
                    }
                }
                vm.onDelete = { taskId in
                    Task {
                        let _ = await dataController.deleteTask(taskId: taskId)
                        onDone()
                    }
                }
            }
    }
}

private func configuredCalendar(weekStart: Int) -> Calendar {
    var calendar = Calendar.current
    let normalizedWeekStart = ((weekStart % 7) + 7) % 7
    calendar.firstWeekday = normalizedWeekStart + 1
    return calendar
}

private func startOfMonth(for date: Date) -> Date {
    let calendar = Calendar.current
    let components = calendar.dateComponents([.year, .month], from: date)
    return calendar.date(from: components) ?? date
}

private func upcomingDateKey(for date: Date) -> String {
    let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
    return String(
        format: "%04d-%02d-%02d",
        components.year ?? 0,
        components.month ?? 0,
        components.day ?? 0
    )
}

private func dateFromUpcomingKey(_ key: String) -> Date? {
    let parts = key.split(separator: "-")
    guard parts.count == 3,
          let year = Int(parts[0]),
          let month = Int(parts[1]),
          let day = Int(parts[2]) else {
        return nil
    }

    var components = DateComponents()
    components.year = year
    components.month = month
    components.day = day
    return Calendar.current.date(from: components)
}

private let upcomingMonthFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.setLocalizedDateFormatFromTemplate("MMMM yyyy")
    return formatter
}()

private let upcomingSelectedDateFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.setLocalizedDateFormatFromTemplate("EEEE MMM d")
    return formatter
}()
