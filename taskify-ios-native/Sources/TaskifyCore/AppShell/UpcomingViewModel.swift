import Foundation

public enum UpcomingBoardGrouping: String, CaseIterable, Identifiable {
    case mixed
    case grouped

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .mixed: return "Across boards"
        case .grouped: return "Group by board"
        }
    }
}

public struct UpcomingBoardDefinition: Identifiable, Equatable {
    public let id: String
    public let name: String
    public let kind: String
    public let columns: [BoardColumn]

    public init(id: String, name: String, kind: String, columns: [BoardColumn] = []) {
        self.id = id
        self.name = name
        self.kind = kind
        self.columns = columns
    }
}

public struct UpcomingCalendarEventItem: Identifiable, Equatable {
    public let id: String
    public let boardId: String
    public let boardName: String?
    public let title: String
    public let kind: String
    public let startDate: String?
    public let endDate: String?
    public let startISO: String?
    public let endISO: String?
    public let startTzid: String?
    public let endTzid: String?
    public let columnId: String?
    public let summary: String?
    public let description: String?
    public let locations: [String]
    public let references: [String]
    public let order: Int?
    public let createdAt: Int?

    public init(
        id: String,
        boardId: String,
        boardName: String? = nil,
        title: String,
        kind: String,
        startDate: String? = nil,
        endDate: String? = nil,
        startISO: String? = nil,
        endISO: String? = nil,
        startTzid: String? = nil,
        endTzid: String? = nil,
        columnId: String? = nil,
        summary: String? = nil,
        description: String? = nil,
        locations: [String] = [],
        references: [String] = [],
        order: Int? = nil,
        createdAt: Int? = nil
    ) {
        self.id = id
        self.boardId = boardId
        self.boardName = boardName
        self.title = title
        self.kind = kind
        self.startDate = startDate
        self.endDate = endDate
        self.startISO = startISO
        self.endISO = endISO
        self.startTzid = startTzid
        self.endTzid = endTzid
        self.columnId = columnId
        self.summary = summary
        self.description = description
        self.locations = locations
        self.references = references
        self.order = order
        self.createdAt = createdAt
    }
}

public struct UpcomingFilterOption: Identifiable, Equatable {
    public let id: String
    public let label: String
    public let boardId: String
    public let columnId: String?

    public init(id: String, label: String, boardId: String, columnId: String? = nil) {
        self.id = id
        self.label = label
        self.boardId = boardId
        self.columnId = columnId
    }
}

public struct UpcomingFilterGroup: Identifiable, Equatable {
    public let id: String
    public let label: String
    public let boardId: String
    public let boardOption: UpcomingFilterOption
    public let listOptions: [UpcomingFilterOption]

    public init(
        id: String,
        label: String,
        boardId: String,
        boardOption: UpcomingFilterOption,
        listOptions: [UpcomingFilterOption]
    ) {
        self.id = id
        self.label = label
        self.boardId = boardId
        self.boardOption = boardOption
        self.listOptions = listOptions
    }
}

public struct UpcomingFilterPreset: Identifiable, Equatable, Codable {
    public let id: String
    public let name: String
    public let selection: [String]

    public init(id: String, name: String, selection: [String]) {
        self.id = id
        self.name = name
        self.selection = selection
    }
}

public struct UpcomingDateGroup: Identifiable, Equatable {
    public let dateKey: String
    public let label: String
    public let date: Date?
    public let tasks: [BoardTaskItem]
    public let events: [UpcomingCalendarEventItem]

    public var id: String { dateKey }

    public init(
        dateKey: String,
        label: String,
        date: Date?,
        tasks: [BoardTaskItem],
        events: [UpcomingCalendarEventItem] = []
    ) {
        self.dateKey = dateKey
        self.label = label
        self.date = date
        self.tasks = tasks
        self.events = events
    }
}

@MainActor
public final class UpcomingViewModel: ObservableObject {
    @Published public private(set) var groups: [UpcomingDateGroup] = []
    @Published public private(set) var filterGroups: [UpcomingFilterGroup] = []
    @Published public private(set) var dayTaskMap: [String: [BoardTaskItem]] = [:]
    @Published public private(set) var dayEventMap: [String: [UpcomingCalendarEventItem]] = [:]
    @Published public private(set) var filteredTasks: [BoardTaskItem] = []
    @Published public private(set) var filteredEvents: [UpcomingCalendarEventItem] = []
    @Published public private(set) var selectedFilterIDs: Set<String>? = nil
    @Published public private(set) var filterPresets: [UpcomingFilterPreset] = []
    @Published public private(set) var sortMode: TaskSortMode = .dueDate
    @Published public private(set) var sortAscending: Bool = true
    @Published public private(set) var boardGrouping: UpcomingBoardGrouping = .mixed
    @Published public private(set) var minimumDateKeyExclusive: String? = nil
    @Published public private(set) var filterLabel: String = "All boards"
    @Published public private(set) var itemCount: Int = 0
    @Published public var searchText: String = "" {
        didSet { recompute() }
    }

    private var allTasks: [BoardTaskItem] = []
    private var allEvents: [UpcomingCalendarEventItem] = []
    private var boardDefinitions: [UpcomingBoardDefinition] = []
    private var boardDefinitionsById: [String: UpcomingBoardDefinition] = [:]
    private var pendingSelectedFilterIDs: Set<String>? = nil
    private var hasPendingSelectedFilterIDs = false

    public init(preferences: UpcomingPreferences? = nil) {
        if let preferences {
            restore(preferences)
        }
    }

    public func setTasks(_ tasks: [BoardTaskItem]) {
        allTasks = tasks
        recompute()
    }

    public func setEvents(_ events: [UpcomingCalendarEventItem]) {
        allEvents = events
        recompute()
    }

    public func setBoards(_ boards: [UpcomingBoardDefinition]) {
        boardDefinitions = boards
        boardDefinitionsById = Dictionary(uniqueKeysWithValues: boards.map { ($0.id, $0) })
        rebuildFilterGroups()
        filterPresets = normalizedFilterPresets(filterPresets)
        applyPendingSelectedFilterIDsIfPossible()
        if !hasPendingSelectedFilterIDs {
            selectedFilterIDs = normalizedFilterSelection(selectedFilterIDs)
        }
        recompute()
    }

    public func selectSortMode(_ mode: TaskSortMode) {
        if sortMode == mode {
            guard mode != .manual else { return }
            sortAscending.toggle()
        } else {
            sortMode = mode
            sortAscending = Self.defaultAscending(for: mode)
        }
        recompute()
    }

    public func setBoardGrouping(_ grouping: UpcomingBoardGrouping) {
        guard boardGrouping != grouping else { return }
        boardGrouping = grouping
        recompute()
    }

    public func setMinimumDateKeyExclusive(_ dateKey: String?) {
        let normalized = normalizedDateKey(dateKey)
        guard minimumDateKeyExclusive != normalized else { return }
        minimumDateKeyExclusive = normalized
        recompute()
    }

    public func setSelectedFilterIDs(_ ids: Set<String>?) {
        hasPendingSelectedFilterIDs = false
        pendingSelectedFilterIDs = nil
        let normalized = normalizedFilterSelection(ids)
        guard normalized != selectedFilterIDs else { return }
        selectedFilterIDs = normalized
        recompute()
    }

    public func selectAllFilters() {
        setSelectedFilterIDs(nil)
    }

    public func clearAllFilters() {
        setSelectedFilterIDs([])
    }

    public func toggleFilterOption(_ optionId: String) {
        let allOptionIDs = Set(allFilterOptions.map(\.id))
        guard allOptionIDs.contains(optionId) else { return }

        let optionMap = Dictionary(uniqueKeysWithValues: allFilterOptions.map { ($0.id, $0) })
        guard let option = optionMap[optionId] else { return }

        var next = selectedFilterIDs ?? allOptionIDs
        let group = filterGroups.first(where: { $0.boardId == option.boardId })
        let boardOptionId = Self.boardOptionID(for: option.boardId)
        let listIDs = group?.listOptions.map(\.id) ?? []

        if option.columnId == nil {
            if next.contains(optionId) {
                next.remove(optionId)
                listIDs.forEach { next.remove($0) }
            } else {
                next.insert(optionId)
                listIDs.forEach { next.insert($0) }
            }
        } else {
            if next.contains(optionId) {
                next.remove(optionId)
            } else {
                next.insert(optionId)
                next.insert(boardOptionId)
            }
            let hasAnyList = listIDs.contains(where: next.contains)
            if !hasAnyList {
                next.remove(boardOptionId)
            }
        }

        setSelectedFilterIDs(next)
    }

    public func restore(_ preferences: UpcomingPreferences) {
        sortMode = preferences.sortMode
        sortAscending = preferences.sortAscending
        boardGrouping = preferences.boardGrouping
        filterPresets = preferences.filterPresets
        pendingSelectedFilterIDs = preferences.selectedFilterIDs.map(Set.init)
        hasPendingSelectedFilterIDs = true
        filterPresets = normalizedFilterPresets(filterPresets)
        applyPendingSelectedFilterIDsIfPossible()
        recompute()
    }

    public func currentPreferences(viewStyle: String) -> UpcomingPreferences {
        let selectedFilterIDs: [String]?
        if hasPendingSelectedFilterIDs {
            selectedFilterIDs = pendingSelectedFilterIDs.map(orderedSelection(from:))
        } else {
            selectedFilterIDs = self.selectedFilterIDs.map(orderedSelection(from:))
        }

        return UpcomingPreferences(
            selectedFilterIDs: selectedFilterIDs,
            sortMode: sortMode,
            sortAscending: sortAscending,
            boardGrouping: boardGrouping,
            viewStyle: viewStyle,
            filterPresets: normalizedFilterPresets(filterPresets)
        )
    }

    public func saveFilterPreset(named name: String) {
        guard !allFilterOptions.isEmpty else { return }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }

        filterPresets = normalizedFilterPresets(
            filterPresets + [
                UpcomingFilterPreset(
                    id: UUID().uuidString,
                    name: trimmedName,
                    selection: currentFilterSelectionSnapshot()
                ),
            ]
        )
    }

    public func applyFilterPreset(_ preset: UpcomingFilterPreset) {
        guard !allFilterOptions.isEmpty else { return }
        let allowed = Set(allFilterOptions.map(\.id))
        setSelectedFilterIDs(Set(preset.selection.filter { allowed.contains($0) }))
    }

    public func deleteFilterPreset(_ preset: UpcomingFilterPreset) {
        filterPresets.removeAll { $0.id == preset.id }
    }

    public func tasks(for dateKey: String) -> [BoardTaskItem] {
        dayTaskMap[dateKey] ?? []
    }

    public func events(for dateKey: String) -> [UpcomingCalendarEventItem] {
        dayEventMap[dateKey] ?? []
    }

    public func resolvedDateKey(preferred: String) -> String? {
        guard !groups.isEmpty else { return nil }
        if groups.contains(where: { $0.dateKey == preferred }) {
            return preferred
        }
        if let next = groups.first(where: { $0.dateKey > preferred }) {
            return next.dateKey
        }
        return groups.last?.dateKey
    }

    public func dayNumbersWithItems(inMonth anchor: Date) -> Set<Int> {
        let calendar = Calendar.current
        let monthComponents = calendar.dateComponents([.year, .month], from: anchor)
        let dayKeys = Set(dayTaskMap.keys).union(dayEventMap.keys)

        return Set(dayKeys.compactMap { key in
            guard let parsed = Self.parseDateKey(key) else { return nil }
            guard parsed.year == monthComponents.year, parsed.month == monthComponents.month else { return nil }
            return parsed.day
        })
    }

    public func listName(for task: BoardTaskItem) -> String? {
        locationListName(boardId: task.boardId, columnId: task.columnId)
    }

    public func listName(for event: UpcomingCalendarEventItem) -> String? {
        locationListName(boardId: event.boardId, columnId: event.columnId)
    }

    public func locationLabel(for task: BoardTaskItem) -> String {
        locationLabel(
            boardId: task.boardId,
            boardName: task.boardName,
            columnId: task.columnId
        )
    }

    public func locationLabel(for event: UpcomingCalendarEventItem) -> String {
        let base = locationLabel(
            boardId: event.boardId,
            boardName: event.boardName,
            columnId: event.columnId
        )
        guard let location = event.locations.first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            return base
        }
        return "\(base) • \(location.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    public func eventTimeLabel(for event: UpcomingCalendarEventItem, showDate: Bool = false) -> String {
        if event.kind == "date" {
            guard let startKey = normalizedDateKey(event.startDate) else { return "" }
            let endKey = normalizedDateKey(event.endDate)
            let validEnd = (endKey != nil && endKey! >= startKey) ? endKey! : startKey
            let isMultiDay = validEnd != startKey
            let startLabel = Self.shortDateLabel(startKey)
            let endLabel = Self.shortDateLabel(validEnd)
            if !showDate {
                return isMultiDay ? "All-day • \(startLabel) – \(endLabel)" : ""
            }
            return isMultiDay ? "All-day • \(startLabel) – \(endLabel)" : startLabel
        }

        guard let startISO = event.startISO,
              let startLabel = Self.timeLabel(fromISO: startISO, timeZoneId: event.startTzid) else {
            return ""
        }

        let endLabel = event.endISO.flatMap { Self.timeLabel(fromISO: $0, timeZoneId: event.endTzid ?? event.startTzid) } ?? ""
        let core = endLabel.isEmpty ? startLabel : "\(startLabel) – \(endLabel)"
        guard showDate else { return core }

        let dateKey = eventDateKeys(for: event).first ?? ""
        if dateKey.isEmpty { return core }
        return "\(core) • \(Self.shortDateLabel(dateKey))"
    }

    public static func defaultAscending(for mode: TaskSortMode) -> Bool {
        switch mode {
        case .manual, .dueDate, .alphabetical:
            return true
        case .priority, .createdAt:
            return false
        }
    }

    private var allFilterOptions: [UpcomingFilterOption] {
        filterGroups.flatMap { [$0.boardOption] + $0.listOptions }
    }

    private func rebuildFilterGroups() {
        filterGroups = boardDefinitions.compactMap { board in
            guard board.kind != "bible", board.kind != "compound" else { return nil }

            let boardOption = UpcomingFilterOption(
                id: Self.boardOptionID(for: board.id),
                label: board.name,
                boardId: board.id
            )
            let listOptions = board.kind == "lists"
                ? board.columns.map { column in
                    UpcomingFilterOption(
                        id: Self.columnOptionID(for: board.id, columnId: column.id),
                        label: column.name,
                        boardId: board.id,
                        columnId: column.id
                    )
                }
                : []

            return UpcomingFilterGroup(
                id: board.id,
                label: board.name,
                boardId: board.id,
                boardOption: boardOption,
                listOptions: listOptions
            )
        }
    }

    private func applyPendingSelectedFilterIDsIfPossible() {
        guard hasPendingSelectedFilterIDs else { return }
        if pendingSelectedFilterIDs != nil && allFilterOptions.isEmpty {
            return
        }

        selectedFilterIDs = normalizedFilterSelection(pendingSelectedFilterIDs)
        pendingSelectedFilterIDs = nil
        hasPendingSelectedFilterIDs = false
    }

    private func recompute() {
        let filteredTasks = applyTaskFilters(to: allTasks)
        let filteredEvents = applyEventFilters(to: allEvents)

        self.filteredTasks = filteredTasks
        self.filteredEvents = filteredEvents
        itemCount = filteredTasks.count + filteredEvents.count

        var groupedTasks: [String: [BoardTaskItem]] = [:]
        filteredTasks.forEach { task in
            guard let dateKey = groupedDueDateKey(for: task) else { return }
            groupedTasks[dateKey, default: []].append(task)
        }

        var groupedEvents: [String: [UpcomingCalendarEventItem]] = [:]
        filteredEvents.forEach { event in
            groupedEventDateKeys(for: event).forEach { dateKey in
                groupedEvents[dateKey, default: []].append(event)
            }
        }

        for key in groupedTasks.keys {
            groupedTasks[key] = sortTasks(groupedTasks[key] ?? [])
        }
        for key in groupedEvents.keys {
            groupedEvents[key] = sortEvents(groupedEvents[key] ?? [])
        }

        dayTaskMap = groupedTasks
        dayEventMap = groupedEvents

        let orderedKeys = Set(groupedTasks.keys).union(groupedEvents.keys).sorted()
        groups = orderedKeys.map { key in
            UpcomingDateGroup(
                dateKey: key,
                label: Self.formatUpcomingDayLabel(key),
                date: Self.dateFromKey(key),
                tasks: groupedTasks[key] ?? [],
                events: groupedEvents[key] ?? []
            )
        }

        filterLabel = buildFilterLabel()
    }

    private func applyTaskFilters(to tasks: [BoardTaskItem]) -> [BoardTaskItem] {
        var filtered = tasks.filter { task in
            guard !task.completed else { return false }
            guard task.dueDateEnabled != false else { return false }
            return groupedDueDateKey(for: task) != nil
        }

        if !allFilterOptions.isEmpty, let selectedFilterIDs {
            if selectedFilterIDs.isEmpty {
                filtered = []
            } else {
                let selection = selectedBoardAndListSelections(selectedFilterIDs)
                filtered = filtered.filter { task in
                    matchesSelection(
                        boardId: task.boardId,
                        columnId: task.columnId,
                        selection: selection
                    )
                }
            }
        }

        let searchTerm = normalizedSearchTerm
        guard !searchTerm.isEmpty else { return filtered }

        return filtered.filter { task in
            let note = task.note?.lowercased() ?? ""
            return task.title.lowercased().contains(searchTerm) || note.contains(searchTerm)
        }
    }

    private func applyEventFilters(to events: [UpcomingCalendarEventItem]) -> [UpcomingCalendarEventItem] {
        var filtered = events.filter { !groupedEventDateKeys(for: $0).isEmpty }

        if !allFilterOptions.isEmpty, let selectedFilterIDs {
            if selectedFilterIDs.isEmpty {
                filtered = []
            } else {
                let selection = selectedBoardAndListSelections(selectedFilterIDs)
                filtered = filtered.filter { event in
                    matchesSelection(
                        boardId: event.boardId,
                        columnId: event.columnId,
                        selection: selection
                    )
                }
            }
        }

        let searchTerm = normalizedSearchTerm
        guard !searchTerm.isEmpty else { return filtered }

        return filtered.filter { event in
            let title = event.title.lowercased()
            let summary = event.summary?.lowercased() ?? ""
            let description = event.description?.lowercased() ?? ""
            let locations = event.locations.joined(separator: " ").lowercased()
            let references = event.references.joined(separator: " ").lowercased()

            return title.contains(searchTerm)
                || summary.contains(searchTerm)
                || description.contains(searchTerm)
                || locations.contains(searchTerm)
                || references.contains(searchTerm)
        }
    }

    private func sortTasks(_ tasks: [BoardTaskItem]) -> [BoardTaskItem] {
        tasks.sorted { lhs, rhs in
            compareTasks(lhs, rhs) < 0
        }
    }

    private func sortEvents(_ events: [UpcomingCalendarEventItem]) -> [UpcomingCalendarEventItem] {
        events.sorted { lhs, rhs in
            compareEvents(lhs, rhs) < 0
        }
    }

    private func compareTasks(_ lhs: BoardTaskItem, _ rhs: BoardTaskItem) -> Int {
        if boardGrouping == .grouped {
            let boardDiff = boardOrder(forBoardId: lhs.boardId) - boardOrder(forBoardId: rhs.boardId)
            if boardDiff != 0 { return boardDiff }
        }

        if sortMode == .manual {
            let orderDiff = (lhs.order ?? 0) - (rhs.order ?? 0)
            if orderDiff != 0 { return orderDiff }
            return compareTaskFallback(lhs, rhs)
        }

        let primary: Int
        switch sortMode {
        case .manual:
            primary = 0
        case .dueDate:
            primary = compareTaskDue(lhs, rhs, ascending: sortAscending)
        case .priority:
            primary = compareNumber(lhs.priority ?? 0, rhs.priority ?? 0, ascending: sortAscending)
        case .createdAt:
            primary = compareNumber(lhs.createdAt ?? 0, rhs.createdAt ?? 0, ascending: sortAscending)
        case .alphabetical:
            primary = compareText(lhs.title, rhs.title, ascending: sortAscending)
        }

        if primary != 0 { return primary }
        return compareTaskFallback(lhs, rhs)
    }

    private func compareEvents(_ lhs: UpcomingCalendarEventItem, _ rhs: UpcomingCalendarEventItem) -> Int {
        if boardGrouping == .grouped {
            let boardDiff = boardOrder(forBoardId: lhs.boardId) - boardOrder(forBoardId: rhs.boardId)
            if boardDiff != 0 { return boardDiff }
        }

        if sortMode == .manual {
            let orderDiff = (lhs.order ?? 0) - (rhs.order ?? 0)
            if orderDiff != 0 { return orderDiff }
            return compareEventFallback(lhs, rhs)
        }

        let primary: Int
        switch sortMode {
        case .manual:
            primary = 0
        case .dueDate:
            primary = compareUpcomingEventTime(lhs, rhs, ascending: sortAscending)
        case .alphabetical:
            primary = compareText(lhs.title, rhs.title, ascending: sortAscending)
        case .priority, .createdAt:
            primary = 0
        }

        if primary != 0 { return primary }
        return compareEventFallback(lhs, rhs)
    }

    private func compareTaskFallback(_ lhs: BoardTaskItem, _ rhs: BoardTaskItem) -> Int {
        let timeDiff = compareUpcomingTime(lhs, rhs, ascending: Self.defaultAscending(for: .dueDate))
        if timeDiff != 0 { return timeDiff }

        let boardDiff = boardOrder(forBoardId: lhs.boardId) - boardOrder(forBoardId: rhs.boardId)
        if boardDiff != 0 { return boardDiff }

        let orderDiff = (lhs.order ?? 0) - (rhs.order ?? 0)
        if orderDiff != 0 { return orderDiff }

        let titleDiff = compareText(lhs.title, rhs.title, ascending: Self.defaultAscending(for: .alphabetical))
        if titleDiff != 0 { return titleDiff }

        return compareText(lhs.id, rhs.id, ascending: true)
    }

    private func compareEventFallback(_ lhs: UpcomingCalendarEventItem, _ rhs: UpcomingCalendarEventItem) -> Int {
        let timeDiff = compareUpcomingEventTime(lhs, rhs, ascending: Self.defaultAscending(for: .dueDate))
        if timeDiff != 0 { return timeDiff }

        let boardDiff = boardOrder(forBoardId: lhs.boardId) - boardOrder(forBoardId: rhs.boardId)
        if boardDiff != 0 { return boardDiff }

        let orderDiff = (lhs.order ?? 0) - (rhs.order ?? 0)
        if orderDiff != 0 { return orderDiff }

        let titleDiff = compareText(lhs.title, rhs.title, ascending: Self.defaultAscending(for: .alphabetical))
        if titleDiff != 0 { return titleDiff }

        return compareText(lhs.id, rhs.id, ascending: true)
    }

    private func compareTaskDue(_ lhs: BoardTaskItem, _ rhs: BoardTaskItem, ascending: Bool) -> Int {
        let lhsDateKey = dueDateKey(for: lhs)
        let rhsDateKey = dueDateKey(for: rhs)

        if lhsDateKey == nil, rhsDateKey == nil { return 0 }
        if lhsDateKey == nil { return 1 }
        if rhsDateKey == nil { return -1 }
        if lhsDateKey != rhsDateKey {
            return compareText(lhsDateKey ?? "", rhsDateKey ?? "", ascending: ascending)
        }

        let lhsHasTime = lhs.dueTimeEnabled == true
        let rhsHasTime = rhs.dueTimeEnabled == true
        if lhsHasTime != rhsHasTime {
            return lhsHasTime ? -1 : 1
        }

        if lhsHasTime, rhsHasTime {
            let lhsTimestamp = dueTimestamp(for: lhs)
            let rhsTimestamp = dueTimestamp(for: rhs)
            if lhsTimestamp == nil, rhsTimestamp == nil { return 0 }
            if lhsTimestamp == nil { return 1 }
            if rhsTimestamp == nil { return -1 }
            return compareNumber(lhsTimestamp ?? 0, rhsTimestamp ?? 0, ascending: ascending)
        }

        return 0
    }

    private func compareUpcomingTime(_ lhs: BoardTaskItem, _ rhs: BoardTaskItem, ascending: Bool) -> Int {
        let lhsTime = taskTimeValue(for: lhs)
        let rhsTime = taskTimeValue(for: rhs)

        if let lhsTime, let rhsTime, lhsTime != rhsTime {
            return compareNumber(lhsTime, rhsTime, ascending: ascending)
        }
        if lhsTime != nil, rhsTime == nil { return -1 }
        if lhsTime == nil, rhsTime != nil { return 1 }
        return 0
    }

    private func compareUpcomingEventTime(
        _ lhs: UpcomingCalendarEventItem,
        _ rhs: UpcomingCalendarEventItem,
        ascending: Bool
    ) -> Int {
        let lhsTime = eventTimeValue(for: lhs)
        let rhsTime = eventTimeValue(for: rhs)
        if lhsTime != rhsTime {
            return compareNumber(lhsTime, rhsTime, ascending: ascending)
        }
        return 0
    }

    private func compareNumber(_ lhs: Int, _ rhs: Int, ascending: Bool) -> Int {
        let diff = lhs - rhs
        return ascending ? diff : -diff
    }

    private func compareText(_ lhs: String, _ rhs: String, ascending: Bool) -> Int {
        let result = lhs.localizedStandardCompare(rhs)
        switch result {
        case .orderedAscending:
            return ascending ? -1 : 1
        case .orderedDescending:
            return ascending ? 1 : -1
        case .orderedSame:
            return 0
        }
    }

    private func dueDateKey(for task: BoardTaskItem) -> String? {
        guard task.dueDateEnabled != false,
              let dueISO = task.dueISO else {
            return nil
        }
        return Self.dateKey(fromISO: dueISO)
    }

    private func groupedDueDateKey(for task: BoardTaskItem) -> String? {
        guard let dateKey = dueDateKey(for: task) else { return nil }
        guard let minimumDateKeyExclusive else { return dateKey }
        return dateKey > minimumDateKeyExclusive ? dateKey : nil
    }

    private func dueTimestamp(for task: BoardTaskItem) -> Int? {
        guard let dueISO = task.dueISO,
              let date = Self.parseISO(dueISO) else {
            return nil
        }
        return Int(date.timeIntervalSince1970)
    }

    private func taskTimeValue(for task: BoardTaskItem) -> Int? {
        guard task.dueTimeEnabled == true,
              let dueISO = task.dueISO else {
            return nil
        }
        return Self.timeValue(fromISO: dueISO)
    }

    private func eventTimeValue(for event: UpcomingCalendarEventItem) -> Int {
        if event.kind == "date" { return -1 }
        guard let startISO = event.startISO else { return 0 }
        return Self.timeValue(fromISO: startISO, timeZoneId: event.startTzid) ?? 0
    }

    private func eventDateKeys(for event: UpcomingCalendarEventItem) -> [String] {
        if event.kind == "date" {
            guard let startKey = normalizedDateKey(event.startDate) else { return [] }
            let endKey = normalizedDateKey(event.endDate)
            let validEnd = (endKey != nil && endKey! >= startKey) ? endKey! : startKey

            var keys: [String] = []
            var current = startKey
            var guardCount = 0
            while guardCount < 366 {
                keys.append(current)
                if current == validEnd { break }
                guard let next = Self.addDays(to: current, count: 1) else { break }
                current = next
                guardCount += 1
            }
            return keys
        }

        guard let startISO = event.startISO,
              let dateKey = Self.dateKey(fromISO: startISO, timeZoneId: event.startTzid) else {
            return []
        }
        return [dateKey]
    }

    private func groupedEventDateKeys(for event: UpcomingCalendarEventItem) -> [String] {
        let keys = eventDateKeys(for: event)
        guard let minimumDateKeyExclusive else { return keys }
        return keys.filter { $0 > minimumDateKeyExclusive }
    }

    private func locationListName(boardId: String?, columnId: String?) -> String? {
        guard let boardId,
              let columnId,
              let board = boardDefinitionsById[boardId],
              board.kind == "lists" else {
            return nil
        }
        return board.columns.first(where: { $0.id == columnId })?.name
    }

    private func locationLabel(boardId: String?, boardName: String?, columnId: String?) -> String {
        let trimmedBoardName = boardName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedBoardName = (trimmedBoardName?.isEmpty == false ? trimmedBoardName : nil)
            ?? boardId.flatMap { boardDefinitionsById[$0]?.name }
            ?? "Board"

        if let listName = locationListName(boardId: boardId, columnId: columnId), !listName.isEmpty {
            return "\(resolvedBoardName) • \(listName)"
        }

        return resolvedBoardName
    }

    private func matchesSelection(
        boardId: String?,
        columnId: String?,
        selection: (selectedBoards: Set<String>, selectedLists: [String: Set<String>])
    ) -> Bool {
        guard let boardId else { return false }
        let board = boardDefinitionsById[boardId]
        let listSet = selection.selectedLists[boardId]

        if selection.selectedBoards.contains(boardId) {
            if board?.kind == "lists" {
                guard let columnId else { return false }
                guard let listSet else { return true }
                guard !listSet.isEmpty else { return false }
                return listSet.contains(columnId)
            }
            return true
        }

        if let listSet, let columnId, listSet.contains(columnId) {
            return true
        }

        return false
    }

    private func boardOrder(forBoardId boardId: String?) -> Int {
        guard let boardId,
              let index = boardDefinitions.firstIndex(where: { $0.id == boardId }) else {
            return boardDefinitions.count + 1
        }
        return index
    }

    private var normalizedSearchTerm: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func normalizedFilterSelection(_ ids: Set<String>?) -> Set<String>? {
        let allOptionIDs = Set(allFilterOptions.map(\.id))
        guard !allOptionIDs.isEmpty else { return nil }
        guard var next = ids else { return nil }

        next = next.intersection(allOptionIDs)

        let optionMap = Dictionary(uniqueKeysWithValues: allFilterOptions.map { ($0.id, $0) })
        for optionID in Array(next) {
            guard let option = optionMap[optionID], option.columnId != nil else { continue }
            next.insert(Self.boardOptionID(for: option.boardId))
        }

        for group in filterGroups {
            guard next.contains(group.boardOption.id), !group.listOptions.isEmpty else { continue }
            let hasAnyList = group.listOptions.contains(where: { next.contains($0.id) })
            if !hasAnyList {
                group.listOptions.forEach { next.insert($0.id) }
            }
        }

        if next.count == allOptionIDs.count {
            return nil
        }

        return next
    }

    private func selectedBoardAndListSelections(
        _ selectedIDs: Set<String>
    ) -> (selectedBoards: Set<String>, selectedLists: [String: Set<String>]) {
        let optionMap = Dictionary(uniqueKeysWithValues: allFilterOptions.map { ($0.id, $0) })

        var boards = Set<String>()
        var lists: [String: Set<String>] = [:]

        for id in selectedIDs {
            guard let option = optionMap[id] else { continue }
            if let columnId = option.columnId {
                lists[option.boardId, default: []].insert(columnId)
            } else {
                boards.insert(option.boardId)
            }
        }

        return (boards, lists)
    }

    private func buildFilterLabel() -> String {
        guard !allFilterOptions.isEmpty else { return "No boards" }
        guard let selectedFilterIDs else { return "All boards" }
        if selectedFilterIDs.isEmpty { return "None" }
        if selectedFilterIDs.count == 1, let first = selectedFilterIDs.first {
            return allFilterOptions.first(where: { $0.id == first })?.label ?? "1 selected"
        }
        return "\(selectedFilterIDs.count) selected"
    }

    private func normalizedFilterPresets(_ presets: [UpcomingFilterPreset]) -> [UpcomingFilterPreset] {
        presets.compactMap { preset in
            let trimmedName = preset.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedName.isEmpty else { return nil }

            let normalizedID = preset.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? UUID().uuidString
                : preset.id

            let dedupedSelection = dedupeSelection(preset.selection)
            let normalizedSelection: [String]
            if allFilterOptions.isEmpty {
                normalizedSelection = dedupedSelection
            } else {
                let allowed = Set(dedupedSelection).intersection(Set(allFilterOptions.map(\.id)))
                normalizedSelection = allFilterOptions.map(\.id).filter { allowed.contains($0) }
            }

            return UpcomingFilterPreset(
                id: normalizedID,
                name: trimmedName,
                selection: normalizedSelection
            )
        }
    }

    private func currentFilterSelectionSnapshot() -> [String] {
        if hasPendingSelectedFilterIDs {
            guard let pendingSelectedFilterIDs else {
                return allFilterOptions.map(\.id)
            }
            return orderedSelection(from: pendingSelectedFilterIDs)
        }
        guard let selectedFilterIDs else {
            return allFilterOptions.map(\.id)
        }
        return orderedSelection(from: selectedFilterIDs)
    }

    private func orderedSelection(from ids: Set<String>) -> [String] {
        let ordered = allFilterOptions.map(\.id).filter { ids.contains($0) }
        let extras = ids.subtracting(Set(ordered)).sorted()
        return ordered + extras
    }

    private func dedupeSelection(_ selection: [String]) -> [String] {
        var seen = Set<String>()
        return selection.filter { seen.insert($0).inserted }
    }

    private func normalizedDateKey(_ value: String?) -> String? {
        guard let value,
              Self.parseDateKey(value) != nil else {
            return nil
        }
        return value
    }

    private static func parseISO(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    private static func parseDateKey(_ value: String) -> DateComponents? {
        let parts = value.split(separator: "-")
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
        return components
    }

    private static func dateFromKey(_ value: String) -> Date? {
        guard let components = parseDateKey(value) else { return nil }
        return Calendar.current.date(from: components)
    }

    private static func addDays(to dateKey: String, count: Int) -> String? {
        guard let components = parseDateKey(dateKey) else { return nil }
        let calendar = Calendar(identifier: .gregorian)
        guard let date = calendar.date(from: components),
              let shifted = calendar.date(byAdding: .day, value: count, to: date) else {
            return nil
        }
        let shiftedParts = calendar.dateComponents([.year, .month, .day], from: shifted)
        guard let year = shiftedParts.year,
              let month = shiftedParts.month,
              let day = shiftedParts.day else {
            return nil
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func calendar(for timeZoneId: String? = nil) -> Calendar {
        var calendar = Calendar.current
        if let timeZoneId,
           let timeZone = TimeZone(identifier: timeZoneId) {
            calendar.timeZone = timeZone
        }
        return calendar
    }

    private static func dateKey(fromISO iso: String, timeZoneId: String? = nil) -> String? {
        guard let date = parseISO(iso) else { return nil }
        let calendar = calendar(for: timeZoneId)
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        guard let year = components.year,
              let month = components.month,
              let day = components.day else {
            return nil
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func timeValue(fromISO iso: String, timeZoneId: String? = nil) -> Int? {
        guard let date = parseISO(iso) else { return nil }
        let calendar = calendar(for: timeZoneId)
        let components = calendar.dateComponents([.hour, .minute], from: date)
        guard let hour = components.hour,
              let minute = components.minute else {
            return nil
        }
        return hour * 60 + minute
    }

    private static func timeLabel(fromISO iso: String, timeZoneId: String? = nil) -> String? {
        guard let date = parseISO(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        if let timeZoneId,
           let timeZone = TimeZone(identifier: timeZoneId) {
            formatter.timeZone = timeZone
        }
        return formatter.string(from: date)
    }

    private static func shortDateLabel(_ dateKey: String) -> String {
        guard let date = dateFromKey(dateKey) else { return dateKey }
        return monthDayFormatter.string(from: date)
    }

    private static func formatUpcomingDayLabel(_ dateKey: String) -> String {
        guard let date = dateFromKey(dateKey) else { return dateKey }
        let weekday = weekdayFormatter.string(from: date)
        let monthDay = monthDayFormatter.string(from: date)
        return "\(weekday) — \(monthDay)"
    }

    private static func boardOptionID(for boardId: String) -> String {
        "board:\(boardId)"
    }

    private static func columnOptionID(for boardId: String, columnId: String) -> String {
        "board:\(boardId):col:\(columnId)"
    }

    private static let weekdayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEE")
        return formatter
    }()

    private static let monthDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }()
}
