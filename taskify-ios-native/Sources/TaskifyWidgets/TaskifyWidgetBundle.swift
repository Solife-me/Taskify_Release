import AppIntents
import SwiftUI
import TaskifyCore
import WidgetKit

@main
struct TaskifyWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        UpcomingWidget()
        NextTaskWidget()
        BoardWidget()
        if #available(iOS 18.0, *) {
            NewTaskControl()
        }
    }
}

// MARK: - Timeline

struct TaskifyEntry: TimelineEntry {
    let date: Date
    let data: TaskifyWidgetData
}

/// Upcoming lists Apple Calendar and Reminders alongside Taskify's own items, mirroring the
/// Upcoming tab. Today does not: its count is tasks only, so pulling device items into the same
/// payload would risk them being counted.
private func loadUpcomingData(now: Date = Date()) async -> TaskifyWidgetData {
    var data = await TaskifyWidgetStore.load(now: now)
    let device = await DeviceItemsReader.upcomingItems(from: now)
    guard !device.isEmpty else { return data }
    data.upcoming = (data.upcoming + device)
        .sorted { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }
    return data
}

struct TaskifyProvider: TimelineProvider {
    /// Reading EventKit costs a permission check and a store query, so only the widgets that show
    /// device items pay for it.
    var includesDeviceItems = false

    private func load(now: Date) async -> TaskifyWidgetData {
        includesDeviceItems ? await loadUpcomingData(now: now) : await TaskifyWidgetStore.load(now: now)
    }

    func placeholder(in context: Context) -> TaskifyEntry {
        TaskifyEntry(date: Date(), data: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (TaskifyEntry) -> Void) {
        Task {
            let data = context.isPreview ? .preview : await load(now: Date())
            completion(TaskifyEntry(date: Date(), data: data))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TaskifyEntry>) -> Void) {
        Task {
            let now = Date()
            let entry = TaskifyEntry(date: now, data: await load(now: now))
            completion(Timeline(
                entries: [entry],
                policy: .after(TaskifyWidgetStore.nextReloadDate(after: now))
            ))
        }
    }
}

extension TaskifyWidgetData {
    /// Stand-in for the gallery and for redacted placeholders, where reading real data isn't
    /// allowed and an empty widget would look broken.
    static var preview: TaskifyWidgetData {
        TaskifyWidgetData(
            today: [
                TaskifyWidgetTask(id: "1", title: "Review the roadmap", boardID: "b", boardName: "Work", dueDate: Date()),
                TaskifyWidgetTask(id: "2", title: "Call the dentist", boardID: "b", boardName: "Personal", dueDate: Date()),
                TaskifyWidgetTask(id: "3", title: "Buy oat milk", boardID: "b", boardName: "Errands", dueDate: Date()),
            ],
            upcoming: [
                TaskifyWidgetTask(id: "1", title: "Review the roadmap", boardID: "b", boardName: "Work", dueDate: Date()),
                TaskifyWidgetTask(
                    id: "event-1",
                    title: "Design review",
                    boardID: "b",
                    boardName: "Work",
                    dueDate: Date().addingTimeInterval(3_600),
                    endDate: Date().addingTimeInterval(7_200),
                    kind: .event
                ),
                TaskifyWidgetTask(id: "4", title: "Renew the domain", boardID: "b", boardName: "Work", dueDate: Date().addingTimeInterval(86_400), isAllDay: true),
                TaskifyWidgetTask(id: "5", title: "Book the flights", boardID: "b", boardName: "Personal", dueDate: Date().addingTimeInterval(172_800)),
            ],

            boards: [TaskifyWidgetBoard(id: "b", name: "Work", openTaskCount: 4)]
        )
    }
}

// MARK: - Today

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TaskifyTodayWidget", provider: TaskifyProvider(includesDeviceItems: true)) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Today")
        .description("Today's tasks, with a tap to tick them off.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TaskifyEntry

    private var rows: [TaskifyWidgetTask] {
        entry.data.upcoming.filter { item in
            guard let dueDate = item.dueDate else { return false }
            return Calendar.current.isDate(dueDate, inSameDayAs: entry.date)
        }
    }

    var body: some View {
        CalendarScheduleWidgetBody(
            mode: .today,
            referenceDate: entry.date,
            items: rows,
            family: family,
            emptyMessage: "Nothing due today",
            totalTaskCount: entry.data.todayCount
        )
        // Tapping anywhere but a row opens the view this widget represents.
        .widgetURL(TaskifyWidgetLink.upcoming.url)
    }
}

// MARK: - Upcoming

struct UpcomingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TaskifyUpcomingWidget", provider: TaskifyProvider(includesDeviceItems: true)) { entry in
            UpcomingWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Upcoming")
        .description("What's coming up next.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct UpcomingWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TaskifyEntry

    var body: some View {
        CalendarScheduleWidgetBody(
            mode: .upcoming,
            referenceDate: entry.date,
            items: entry.data.upcoming,
            family: family,
            emptyMessage: "Nothing scheduled",
            totalTaskCount: nil
        )
        .widgetURL(TaskifyWidgetLink.upcoming.url)
    }
}

private enum CalendarScheduleMode {
    case today
    case upcoming
}

private struct CalendarScheduleSection: Identifiable {
    let day: Date
    let items: [TaskifyWidgetTask]

    var id: Date { day }
}

/// Calendar-style hierarchy shared by Today and Upcoming. The top date anchors the widget while
/// subsequent dates get compact section labels, matching the native Calendar widget without
/// giving up Taskify's in-place completion buttons.
private struct CalendarScheduleWidgetBody: View {
    let mode: CalendarScheduleMode
    let referenceDate: Date
    let items: [TaskifyWidgetTask]
    let family: WidgetFamily
    let emptyMessage: String
    let totalTaskCount: Int?

    private var maximumItemCount: Int {
        switch family {
        case .systemSmall: 4
        case .systemMedium: 4
        default: 5
        }
    }

    private func visibleItems(limit: Int) -> [TaskifyWidgetTask] {
        switch mode {
        case .today:
            Array(items.prefix(limit))
        case .upcoming:
            items.upcomingWidgetItems(after: referenceDate, limit: limit)
        }
    }

    private func sections(for visibleItems: [TaskifyWidgetTask]) -> [CalendarScheduleSection] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: visibleItems) { item in
            calendar.startOfDay(for: item.dueDate ?? referenceDate)
        }
        return grouped.keys.sorted().map { day in
            CalendarScheduleSection(day: day, items: grouped[day] ?? [])
        }
    }

    private var header: String {
        let suffix = referenceDate.formatted(.dateTime.month(.abbreviated).day())
        switch mode {
        case .today:
            return "Today, \(suffix)"
        case .upcoming:
            return referenceDate.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
        }
    }

    private func hiddenTaskCount(for visibleItems: [TaskifyWidgetTask]) -> Int {
        guard let totalTaskCount else { return 0 }
        return max(0, totalTaskCount - visibleItems.filter { $0.kind == .task }.count)
    }

    var body: some View {
        Group {
            if items.isEmpty {
                scheduleContent(visibleItems: [])
            } else if family == .systemSmall {
                // StandBy presents system-small widgets at a much larger physical scale. Use
                // natural-height rows and take the first candidate that fits so same-day lists
                // can show four tasks while several date headings can gracefully fall back.
                ViewThatFits(in: .vertical) {
                    scheduleContent(visibleItems: visibleItems(limit: 4))
                    scheduleContent(visibleItems: visibleItems(limit: 3))
                    scheduleContent(visibleItems: visibleItems(limit: 2))
                }
            } else {
                scheduleContent(visibleItems: visibleItems(limit: maximumItemCount))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func scheduleContent(visibleItems: [TaskifyWidgetTask]) -> some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 7 : 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(header.uppercased())
                    .font((family == .systemSmall ? Font.caption2 : .caption).weight(.bold))
                    .tracking(0.35)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Spacer(minLength: 4)
                let hiddenCount = hiddenTaskCount(for: visibleItems)
                if hiddenCount > 0 {
                    Text("+\(hiddenCount)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            if visibleItems.isEmpty {
                Spacer(minLength: 0)
                HStack {
                    Spacer()
                    VStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.green)
                        Text(emptyMessage)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    Spacer()
                }
                Spacer(minLength: 0)
            } else {
                VStack(alignment: .leading, spacing: family == .systemLarge ? 7 : 3) {
                    ForEach(sections(for: visibleItems)) { section in
                        CalendarScheduleSectionView(
                            section: section,
                            referenceDate: referenceDate,
                            mode: mode,
                            compact: family != .systemLarge,
                            dense: family == .systemSmall
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

private struct CalendarScheduleSectionView: View {
    let section: CalendarScheduleSection
    let referenceDate: Date
    let mode: CalendarScheduleMode
    let compact: Bool
    let dense: Bool

    private var showsHeading: Bool {
        guard mode == .upcoming else { return false }
        return !Calendar.current.isDate(section.day, inSameDayAs: referenceDate)
    }

    private var heading: String {
        let calendar = Calendar.current
        let referenceDay = calendar.startOfDay(for: referenceDate)
        let sectionDay = calendar.startOfDay(for: section.day)
        if calendar.dateComponents([.day], from: referenceDay, to: sectionDay).day == 1 {
            return "Tomorrow"
        }
        return section.day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: dense ? 0 : (compact ? 1 : 5)) {
            if showsHeading {
                Text(heading.uppercased())
                    .font((dense ? Font.system(size: 8) : (compact ? Font.system(size: 9) : .caption2)).weight(.semibold))
                    .tracking(0.3)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            ForEach(section.items) { item in
                if item.kind == .event || item.kind == .calendar {
                    CalendarEventWidgetRow(item: item, compact: compact, dense: dense)
                } else {
                    CalendarTaskWidgetRow(item: item, compact: compact, dense: dense)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

private struct CalendarTaskWidgetRow: View {
    let item: TaskifyWidgetTask
    let compact: Bool
    let dense: Bool

    var body: some View {
        HStack(alignment: .center, spacing: dense ? 3 : (compact ? 5 : 7)) {
            if item.kind.isCompletable {
                // Completes in place (iOS 17+). The tappable area is the padded frame, not the
                // glyph -- a bare SF Symbol is a ~15pt target and near-impossible to hit.
                Button(intent: CompleteTaskIntent(taskID: item.id)) {
                    Image(systemName: item.kind.symbolName)
                        .font(dense ? .system(size: 10, weight: .semibold) : (compact ? .caption.weight(.semibold) : .body.weight(.semibold)))
                        .foregroundStyle(.secondary)
                        .frame(width: dense ? 20 : (compact ? 24 : 29), height: dense ? 20 : (compact ? 24 : 29))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Image(systemName: item.kind.symbolName)
                    .font(dense ? .system(size: 10, weight: .semibold) : (compact ? .caption.weight(.semibold) : .body.weight(.semibold)))
                    .foregroundStyle(.secondary)
                    .frame(width: dense ? 20 : (compact ? 24 : 29), height: dense ? 20 : (compact ? 24 : 29))
            }

            // Only the text opens the task, so it can't swallow the checkbox's taps.
            Link(destination: destination) {
                HStack(alignment: .center, spacing: 5) {
                    Text(item.title)
                        .font((dense ? Font.system(size: 10.5) : (compact ? Font.caption : .subheadline)).weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 3)
                    if let timing = timingLabel {
                        Text(timing)
                            .font(dense ? .system(size: 9) : .caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
        }
        .padding(.vertical, dense ? 0 : (compact ? 1 : 5))
        .padding(.horizontal, dense ? 4 : (compact ? 5 : 7))
        .frame(maxWidth: .infinity, minHeight: dense ? 20 : nil)
        .background(.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: dense ? 6 : (compact ? 8 : 10), style: .continuous))
    }

    private var destination: URL {
        guard item.kind == .task else { return TaskifyWidgetLink.upcoming.url }
        return TaskifyWidgetLink.task(id: item.id, boardID: item.boardID).url
    }

    private var timingLabel: String? {
        guard let dueDate = item.dueDate else { return nil }
        if item.isAllDay { return "all-day" }
        return dueDate.formatted(date: .omitted, time: .shortened)
    }
}

private struct CalendarEventWidgetRow: View {
    let item: TaskifyWidgetTask
    let compact: Bool
    let dense: Bool

    var body: some View {
        Link(destination: TaskifyWidgetLink.upcoming.url) {
            HStack(alignment: .center, spacing: dense ? 3 : (compact ? 5 : 7)) {
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: dense ? 2 : (compact ? 3 : 4))

                Text(item.title)
                    .font((dense ? Font.system(size: 10.5) : (compact ? Font.caption : .subheadline)).weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(compact ? 1 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)

                eventTiming
            }
            .padding(.vertical, dense ? 1 : (compact ? 2 : 6))
            .padding(.horizontal, dense ? 4 : (compact ? 5 : 7))
            .frame(
                maxWidth: .infinity,
                minHeight: dense ? 20 : (compact ? 24 : 42)
            )
            .background(.primary.opacity(0.11), in: RoundedRectangle(cornerRadius: dense ? 6 : (compact ? 8 : 10), style: .continuous))
            .contentShape(Rectangle())
        }
    }

    @ViewBuilder
    private var eventTiming: some View {
        if item.isAllDay {
            Text("all-day")
                .font(dense ? .system(size: 9) : .caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        } else if let start = item.dueDate {
            VStack(alignment: .trailing, spacing: -1) {
                Text(start, style: .time)
                if let end = item.endDate, end != start {
                    Text(end, style: .time)
                        .foregroundStyle(.secondary)
                }
            }
            .font(dense ? .system(size: 9) : .caption2)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
        }
    }
}

// MARK: - Lock Screen

struct NextTaskWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TaskifyNextTaskWidget", provider: TaskifyProvider(includesDeviceItems: true)) { entry in
            NextTaskWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Tasks")
        .description("Today's Taskify tasks at a glance.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct NextTaskWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TaskifyEntry

    var body: some View {
        content.widgetURL(TaskifyWidgetLink.upcoming.url)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text("\(entry.data.todayCount)")
                        .font(.title2.bold())
                    Text("due")
                        .font(.caption2)
                }
            }
        case .accessoryInline:
            if let next = entry.data.nextTask {
                Label(next.title, systemImage: "checklist")
            } else {
                Label("All clear", systemImage: "checkmark.circle")
            }
        default:
            LockScreenTaskList(tasks: entry.data.today)
        }
    }
}

/// The rectangular Lock Screen family has enough room for a short list, and is considerably more
/// useful when it spends that space on task names instead of a large count. It remains display-only
/// because Lock Screen accessories route their single tap through the widget URL.
private struct LockScreenTaskList: View {
    let tasks: [TaskifyWidgetTask]

    private var visibleTasks: [TaskifyWidgetTask] { Array(tasks.prefix(2)) }
    private var hiddenCount: Int { max(0, tasks.count - visibleTasks.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("Today")
                    .font(.caption.weight(.bold))
                Spacer(minLength: 3)
                if hiddenCount > 0 {
                    Text("+\(hiddenCount)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            if visibleTasks.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle")
                        .font(.caption2.weight(.semibold))
                    Text("No tasks due today")
                        .font(.caption2.weight(.medium))
                        .lineLimit(1)
                }
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(visibleTasks) { task in
                    HStack(spacing: 4) {
                        Image(systemName: "circle")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 11)
                        Text(task.title)
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.78)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        guard !tasks.isEmpty else { return "No Taskify tasks due today" }
        let count = tasks.count
        let titles = visibleTasks.map(\.title).joined(separator: ", ")
        return "\(count) Taskify \(count == 1 ? "task" : "tasks") due today: \(titles)"
    }
}

// MARK: - Board

struct BoardWidgetBoardEntity: AppEntity, Hashable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Board")
    static var defaultQuery = BoardWidgetBoardQuery()

    let id: String
    let name: String
    let kindRawValue: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(board: Board) {
        id = board.id
        name = board.name
        kindRawValue = board.kind.rawValue
    }
}

struct BoardWidgetBoardQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [BoardWidgetBoardEntity] {
        guard let snapshot = await TaskifyWidgetStore.loadSnapshot() else { return [] }
        let entities = Dictionary(uniqueKeysWithValues: widgetBoards(in: snapshot).map {
            ($0.id, BoardWidgetBoardEntity(board: $0))
        })
        return identifiers.compactMap { entities[$0] }
    }

    func suggestedEntities() async throws -> [BoardWidgetBoardEntity] {
        guard let snapshot = await TaskifyWidgetStore.loadSnapshot() else { return [] }
        return widgetBoards(in: snapshot).map(BoardWidgetBoardEntity.init)
    }
}

struct BoardWidgetScopeEntity: AppEntity, Hashable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "View")
    static var defaultQuery = BoardWidgetScopeQuery()

    let id: String
    let boardID: String
    let name: String
    let columnID: String?
    let scopeKind: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    var widgetScope: TaskifyWidgetBoardScope {
        switch scopeKind {
        case "today": .today
        case "column": columnID.map(TaskifyWidgetBoardScope.column) ?? .all
        default: .all
        }
    }

    static func choices(for board: Board) -> [BoardWidgetScopeEntity] {
        switch board.kind {
        case .week:
            return [
                BoardWidgetScopeEntity(
                    id: "\(board.id)|today",
                    boardID: board.id,
                    name: "Today",
                    columnID: nil,
                    scopeKind: "today"
                ),
                BoardWidgetScopeEntity(
                    id: "\(board.id)|all",
                    boardID: board.id,
                    name: "All",
                    columnID: nil,
                    scopeKind: "all"
                ),
            ]
        case .list:
            let all = BoardWidgetScopeEntity(
                id: "\(board.id)|all",
                boardID: board.id,
                name: "All",
                columnID: nil,
                scopeKind: "all"
            )
            let columns = board.columns.sorted {
                if $0.order != $1.order { return $0.order < $1.order }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }.map { column in
                BoardWidgetScopeEntity(
                    id: "\(board.id)|column|\(column.id)",
                    boardID: board.id,
                    name: column.name,
                    columnID: column.id,
                    scopeKind: "column"
                )
            }
            return [all] + columns
        default:
            return []
        }
    }
}

struct BoardWidgetScopeQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [BoardWidgetScopeEntity] {
        guard let snapshot = await TaskifyWidgetStore.loadSnapshot() else { return [] }
        let choices = widgetBoards(in: snapshot).flatMap(BoardWidgetScopeEntity.choices)
        let entities = Dictionary(uniqueKeysWithValues: choices.map { ($0.id, $0) })
        return identifiers.compactMap { entities[$0] }
    }

    func suggestedEntities() async throws -> [BoardWidgetScopeEntity] {
        guard let snapshot = await TaskifyWidgetStore.loadSnapshot() else { return [] }
        return widgetBoards(in: snapshot).flatMap(BoardWidgetScopeEntity.choices)
    }
}

struct BoardWidgetScopeOptionsProvider: DynamicOptionsProvider {
    @IntentParameterDependency<BoardWidgetConfigurationIntent>(\.$board)
    var intent

    func results() async throws -> [BoardWidgetScopeEntity] {
        guard let selectedBoard = intent?.board,
              let snapshot = await TaskifyWidgetStore.loadSnapshot(),
              let board = widgetBoards(in: snapshot).first(where: { $0.id == selectedBoard.id }) else {
            return []
        }
        return BoardWidgetScopeEntity.choices(for: board)
    }
}

struct BoardWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Board"
    static var description = IntentDescription("Choose a board and the list or day this widget shows.")

    @Parameter(title: "Board")
    var board: BoardWidgetBoardEntity?

    @Parameter(title: "View", optionsProvider: BoardWidgetScopeOptionsProvider())
    var scope: BoardWidgetScopeEntity?

    init() {}
}

struct BoardWidgetEntry: TimelineEntry {
    let date: Date
    let data: TaskifyBoardWidgetData?
}

struct BoardWidgetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> BoardWidgetEntry {
        BoardWidgetEntry(date: Date(), data: .preview)
    }

    func snapshot(
        for configuration: BoardWidgetConfigurationIntent,
        in context: Context
    ) async -> BoardWidgetEntry {
        if context.isPreview {
            return BoardWidgetEntry(date: Date(), data: .preview)
        }
        return await entry(for: configuration, now: Date())
    }

    func timeline(
        for configuration: BoardWidgetConfigurationIntent,
        in context: Context
    ) async -> Timeline<BoardWidgetEntry> {
        let now = Date()
        return Timeline(
            entries: [await entry(for: configuration, now: now)],
            policy: .after(TaskifyWidgetStore.nextReloadDate(after: now))
        )
    }

    private func entry(
        for configuration: BoardWidgetConfigurationIntent,
        now: Date
    ) async -> BoardWidgetEntry {
        guard let snapshot = await TaskifyWidgetStore.loadSnapshot() else {
            return BoardWidgetEntry(date: now, data: nil)
        }
        let boards = widgetBoards(in: snapshot)
        guard let board = configuration.board.flatMap({ selected in
            boards.first { $0.id == selected.id }
        }) ?? boards.first else {
            return BoardWidgetEntry(date: now, data: nil)
        }

        let scope: TaskifyWidgetBoardScope
        if let configuredScope = configuration.scope,
           configuredScope.boardID == board.id {
            scope = configuredScope.widgetScope
        } else {
            scope = board.kind == .week ? .today : .all
        }

        return BoardWidgetEntry(
            date: now,
            data: snapshot.boardWidgetData(boardID: board.id, scope: scope, now: now)
        )
    }
}

private func widgetBoards(in snapshot: TaskifySnapshot) -> [Board] {
    snapshot.visibleBoards.filter { $0.kind == .week || $0.kind == .list }
}

struct BoardWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: "TaskifyBoardWidget",
            intent: BoardWidgetConfigurationIntent.self,
            provider: BoardWidgetProvider()
        ) { entry in
            BoardWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Board")
        .description("Open tasks and events from the board and list you choose.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct BoardWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BoardWidgetEntry

    private var maximumRows: Int { family == .systemSmall ? 2 : 3 }
    private var visibleItems: [TaskifyWidgetTask] {
        Array((entry.data?.items ?? []).prefix(maximumRows))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(entry.data?.board.name ?? "Board")
                    .font((family == .systemSmall ? Font.caption2 : .caption).weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text("\(entry.data?.itemCount ?? 0)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Link(destination: quickAddURL) {
                    Image(systemName: "plus")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)
                        .frame(width: 28, height: 28)
                        .background(.primary.opacity(0.13), in: Circle())
                        .contentShape(Circle())
                }
                .accessibilityLabel("Add task to \(entry.data?.board.name ?? "board")")
            }

            if visibleItems.isEmpty {
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("Nothing in \(entry.data?.scopeName.lowercased() ?? "this view")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(visibleItems.enumerated()), id: \.element.id) { index, item in
                        BoardWidgetItemRow(item: item, referenceDate: entry.date)
                        if index < visibleItems.count - 1 {
                            Divider().padding(.leading, 29)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(TaskifyWidgetLink.boards.url)
    }

    private var quickAddURL: URL {
        TaskifyWidgetLink.quickAdd(
            boardID: entry.data?.board.id,
            columnID: entry.data?.destinationColumnID
        ).url
    }
}

private struct BoardWidgetItemRow: View {
    let item: TaskifyWidgetTask
    let referenceDate: Date

    var body: some View {
        HStack(spacing: 5) {
            if item.kind.isCompletable {
                Button(intent: CompleteTaskIntent(taskID: item.id)) {
                    Image(systemName: item.kind.symbolName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Image(systemName: item.kind.symbolName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tint)
                    .frame(width: 24, height: 24)
            }

            Link(destination: destination) {
                HStack(spacing: 5) {
                    Text(item.title)
                        .font(.caption.weight(item.kind == .event ? .semibold : .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 3)
                    if let dueLabel {
                        Text(dueLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 27, alignment: .leading)
                .contentShape(Rectangle())
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var dueLabel: String? {
        guard let dueDate = item.dueDate else { return nil }
        if Calendar.current.isDate(dueDate, inSameDayAs: referenceDate) {
            return item.isAllDay ? "Today" : dueDate.formatted(date: .omitted, time: .shortened)
        }
        return dueDate.formatted(.dateTime.month(.abbreviated).day())
    }

    private var destination: URL {
        if item.kind == .event {
            return TaskifyWidgetLink.event(id: item.id, boardID: item.boardID).url
        }
        return TaskifyWidgetLink.task(id: item.id, boardID: item.boardID).url
    }
}

private extension TaskifyBoardWidgetData {
    static var preview: TaskifyBoardWidgetData {
        TaskifyBoardWidgetData(
            board: TaskifyWidgetBoard(id: "b", name: "Work Tasks", openTaskCount: 3),
            scopeName: "All",
            destinationColumnID: "todo",
            itemCount: 3,
            tasks: [
                TaskifyWidgetTask(id: "1", title: "Review the roadmap", boardID: "b", boardName: "Work Tasks", dueDate: Date()),
                TaskifyWidgetTask(
                    id: "2",
                    title: "Design review",
                    boardID: "b",
                    boardName: "Work Tasks",
                    dueDate: Date().addingTimeInterval(3_600),
                    endDate: Date().addingTimeInterval(7_200),
                    kind: .event
                ),
                TaskifyWidgetTask(id: "3", title: "Plan next sprint", boardID: "b", boardName: "Work Tasks", dueDate: nil),
            ]
        )
    }
}

// MARK: - Control Center

@available(iOS 18.0, *)
struct NewTaskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "TaskifyNewTaskControl") {
            // TaskifyQuickAddIntent is compiled into the app as well as this extension. A
            // control's action runs with openAppWhenRun in the *app's* process, so a type that
            // exists only here leaves iOS with nothing to run -- which is exactly why this button
            // did nothing. See the intent's own notes.
            ControlWidgetButton(action: TaskifyQuickAddIntent()) {
                Label("New Task", systemImage: "plus.circle.fill")
            }
        }
        .displayName("New Task")
        .description("Jump straight to adding a task.")
    }
}
