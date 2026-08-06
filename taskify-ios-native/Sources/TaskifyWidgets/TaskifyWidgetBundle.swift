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

struct TaskifyProvider: TimelineProvider {
    func placeholder(in context: Context) -> TaskifyEntry {
        TaskifyEntry(date: Date(), data: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (TaskifyEntry) -> Void) {
        Task {
            let data = context.isPreview ? .preview : await TaskifyWidgetStore.load()
            completion(TaskifyEntry(date: Date(), data: data))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TaskifyEntry>) -> Void) {
        Task {
            let now = Date()
            let entry = TaskifyEntry(date: now, data: await TaskifyWidgetStore.load(now: now))
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
                TaskifyWidgetTask(id: "4", title: "Renew the domain", boardID: "b", boardName: "Work", dueDate: Date().addingTimeInterval(86_400)),
                TaskifyWidgetTask(id: "5", title: "Book the flights", boardID: "b", boardName: "Personal", dueDate: Date().addingTimeInterval(172_800)),
            ],

            boards: [TaskifyWidgetBoard(id: "b", name: "Work", openTaskCount: 4)]
        )
    }
}

// MARK: - Today

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TaskifyTodayWidget", provider: TaskifyProvider()) { entry in
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

    private var rows: [TaskifyWidgetTask] { Array(entry.data.today.prefix(maxRows)) }

    private var maxRows: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        default: return 7
        }
    }

    var body: some View {
        TaskListWidgetBody(
            title: "Today",
            // Counting is the Today widget's job; Upcoming deliberately doesn't.
            trailing: entry.data.todayCount > rows.count ? "+\(entry.data.todayCount - rows.count)" : nil,
            rows: rows,
            showsBoard: family != .systemSmall,
            emptyMessage: "Nothing due today",
            completable: true
        )
        // Tapping anywhere but a row opens the view this widget represents.
        .widgetURL(TaskifyWidgetLink.upcoming.url)
    }
}

// MARK: - Upcoming

struct UpcomingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TaskifyUpcomingWidget", provider: TaskifyProvider()) { entry in
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

    private var maxRows: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        default: return 7
        }
    }

    var body: some View {
        TaskListWidgetBody(
            title: "Upcoming",
            // No total: a running count of everything ahead of you isn't a number that means much.
            trailing: nil,
            rows: Array(entry.data.upcoming.prefix(maxRows)),
            showsBoard: family != .systemSmall,
            emptyMessage: "Nothing scheduled",
            completable: true
        )
        .widgetURL(TaskifyWidgetLink.upcoming.url)
    }
}

/// Shared layout for the list widgets. Padding lives here rather than on each caller: without it
/// the header sat flush against the container edge, which is what made the gallery preview look
/// clipped.
private struct TaskListWidgetBody: View {
    let title: String
    var trailing: String?
    let rows: [TaskifyWidgetTask]
    var showsBoard: Bool
    let emptyMessage: String
    var completable: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 4)
                if let trailing {
                    Text(trailing)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            if rows.isEmpty {
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
                ForEach(rows) { task in
                    TaskRow(task: task, showsBoard: showsBoard, completable: completable)
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct TaskRow: View {
    let task: TaskifyWidgetTask
    var showsBoard: Bool
    var completable: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if completable {
                // Completes in place (iOS 17+). The tappable area is the padded frame, not the
                // glyph -- a bare SF Symbol is a ~15pt target and near-impossible to hit.
                Button(intent: CompleteTaskIntent(taskID: task.id)) {
                    Image(systemName: "circle")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            // Only the text opens the task, so it can't swallow the checkbox's taps.
            Link(destination: TaskifyWidgetLink.task(id: task.id, boardID: task.boardID).url) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(task.title)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if showsBoard, !task.boardName.isEmpty {
                        Text(task.boardName)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
        }
    }
}

// MARK: - Lock Screen

struct NextTaskWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TaskifyNextTaskWidget", provider: TaskifyProvider()) { entry in
            NextTaskWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Next Task")
        .description("What's due next, at a glance.")
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
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.data.todayCount == 0 ? "All clear" : "\(entry.data.todayCount) due today")
                    .font(.headline)
                if let next = entry.data.nextTask {
                    Text(next.title)
                        .font(.caption)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Board

struct BoardWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TaskifyBoardWidget", provider: TaskifyProvider()) { entry in
            BoardWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Board")
        .description("A board's open tasks, with a shortcut to add one.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct BoardWidgetView: View {
    let entry: TaskifyEntry

    private var board: TaskifyWidgetBoard? { entry.data.boards.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(board?.name ?? "Taskify")
                .font(.headline)
                .lineLimit(1)
            Text("\(board?.openTaskCount ?? 0) open")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)

            // Widgets can't take text input, so this hands off to the app with the quick-add
            // field focused rather than pretending to capture a title here.
            Link(destination: TaskifyWidgetLink.quickAdd(boardID: board?.id).url) {
                Label("Add task", systemImage: "plus.circle.fill")
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(.tint.opacity(0.18), in: Capsule())
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(TaskifyWidgetLink.boards.url)
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
