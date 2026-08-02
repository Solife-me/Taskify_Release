import AppIntents
import SwiftUI
import TaskifyCore
import WidgetKit

@main
struct TaskifyWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
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
                TaskifyWidgetTask(id: "1", title: "Review the roadmap", boardID: "b", boardName: "Work", dueDate: Date(), isOverdue: false),
                TaskifyWidgetTask(id: "2", title: "Call the dentist", boardID: "b", boardName: "Personal", dueDate: Date(), isOverdue: false),
                TaskifyWidgetTask(id: "3", title: "Buy oat milk", boardID: "b", boardName: "Errands", dueDate: Date(), isOverdue: false),
            ],
            overdue: [
                TaskifyWidgetTask(id: "0", title: "Send the invoice", boardID: "b", boardName: "Work", dueDate: Date(), isOverdue: true),
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

    /// Overdue first: it's the work most likely to be forgotten, and the small sizes only have
    /// room for a couple of rows.
    private var rows: [TaskifyWidgetTask] {
        Array((entry.data.overdue + entry.data.today).prefix(maxRows))
    }

    private var maxRows: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        default: return 7
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Today")
                    .font(.headline)
                Spacer()
                if entry.data.remainingCount > rows.count {
                    Text("+\(entry.data.remainingCount - rows.count)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            if rows.isEmpty {
                Spacer()
                HStack {
                    Spacer()
                    VStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.green)
                        Text("All clear")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                Spacer()
            } else {
                ForEach(rows) { task in
                    TaskRow(task: task, showsBoard: family != .systemSmall)
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

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Interactive: completes in place without opening the app (iOS 17+).
            Button(intent: CompleteTaskIntent(taskID: task.id)) {
                Image(systemName: "circle")
                    .font(.callout)
                    .foregroundStyle(task.isOverdue ? .orange : .secondary)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 1) {
                Text(task.title)
                    .font(.caption.weight(.medium))
                    .lineLimit(2)
                if showsBoard, !task.boardName.isEmpty {
                    Text(task.boardName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
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
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text("\(entry.data.remainingCount)")
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
                Text(entry.data.remainingCount == 0 ? "All clear" : "\(entry.data.remainingCount) due today")
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
            Link(destination: URL(string: "taskify://quick-add?board=\(board?.id ?? "")")!) {
                Label("Add task", systemImage: "plus.circle.fill")
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(.tint.opacity(0.18), in: Capsule())
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Control Center

@available(iOS 18.0, *)
struct NewTaskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "TaskifyNewTaskControl") {
            ControlWidgetButton(action: OpenQuickAddIntent()) {
                Label("New Task", systemImage: "plus.circle.fill")
            }
        }
        .displayName("New Task")
        .description("Jump straight to adding a task.")
    }
}

/// Opens the app on the quick-add field. A control can't collect text either, so like the board
/// widget it hands off rather than pretending to.
///
/// Gated to iOS 18 alongside the control that uses it -- `OpenURLIntent` doesn't exist earlier.
@available(iOS 18.0, *)
struct OpenQuickAddIntent: AppIntent {
    static var title: LocalizedStringResource = "New Task"
    static var openAppWhenRun: Bool = true

    init() {}

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(URL(string: "taskify://quick-add")!))
    }
}
