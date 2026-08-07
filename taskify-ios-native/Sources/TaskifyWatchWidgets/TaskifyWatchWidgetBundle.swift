import SwiftUI
import TaskifyWatchShared
import WidgetKit

@main
struct TaskifyWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        TaskifyWatchTodayWidget()
    }
}

private struct TaskifyWatchTodayEntry: TimelineEntry {
    let date: Date
    let snapshot: TaskifyWatchWidgetSnapshot

    var todayTasks: [TaskifyWatchWidgetTask] {
        snapshot.todayTasks(now: date)
    }
}

private struct TaskifyWatchTodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TaskifyWatchTodayEntry {
        TaskifyWatchTodayEntry(date: Date(), snapshot: .preview)
    }

    func getSnapshot(
        in context: Context,
        completion: @escaping (TaskifyWatchTodayEntry) -> Void
    ) {
        completion(TaskifyWatchTodayEntry(
            date: Date(),
            snapshot: context.isPreview ? .preview : TaskifyWatchWidgetCache.load()
        ))
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<TaskifyWatchTodayEntry>) -> Void
    ) {
        let now = Date()
        let entry = TaskifyWatchTodayEntry(date: now, snapshot: TaskifyWatchWidgetCache.load())
        completion(Timeline(entries: [entry], policy: .after(nextMidnight(after: now))))
    }

    private func nextMidnight(after date: Date, calendar: Calendar = .current) -> Date {
        let start = calendar.startOfDay(for: date)
        return calendar.date(byAdding: .day, value: 1, to: start) ?? date.addingTimeInterval(86_400)
    }
}

private extension TaskifyWatchWidgetSnapshot {
    static var preview: TaskifyWatchWidgetSnapshot {
        TaskifyWatchWidgetSnapshot(
            tasks: [
                TaskifyWatchWidgetTask(
                    id: "one",
                    title: "Review today's plan",
                    boardName: "Personal",
                    dueDate: Date()
                ),
                TaskifyWatchWidgetTask(
                    id: "two",
                    title: "Call Sam",
                    boardName: "Work",
                    dueDate: Date().addingTimeInterval(3_600)
                ),
                TaskifyWatchWidgetTask(
                    id: "three",
                    title: "Pick up groceries",
                    boardName: "Errands",
                    dueDate: Date().addingTimeInterval(7_200)
                ),
            ]
        )
    }
}

private struct TaskifyWatchTodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: TaskifyWatchWidgetCache.todayWidgetKind,
            provider: TaskifyWatchTodayProvider()
        ) { entry in
            TaskifyWatchTodayView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Today")
        .description("See the Taskify tasks due today.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

private struct TaskifyWatchTodayView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TaskifyWatchTodayEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            circular
        case .accessoryInline:
            inline
        default:
            rectangular
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -1) {
                Image(systemName: "checklist")
                    .font(.caption.bold())
                    .widgetAccentable()
                Text("\(entry.todayTasks.count)")
                    .font(.title3.bold())
                    .minimumScaleFactor(0.7)
            }
        }
        .accessibilityLabel(accessibilitySummary)
    }

    private var inline: some View {
        Group {
            if let first = entry.todayTasks.first {
                Label("\(entry.todayTasks.count) due · \(first.title)", systemImage: "checklist")
                    .privacySensitive()
            } else {
                Label("All clear today", systemImage: "checkmark.circle")
            }
        }
        .accessibilityLabel(accessibilitySummary)
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Label("Today", systemImage: "checklist")
                    .font(.caption.bold())
                    .widgetAccentable()
                Spacer(minLength: 2)
                Text("\(entry.todayTasks.count)")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }

            if entry.todayTasks.isEmpty {
                Spacer(minLength: 0)
                Label("All clear", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .widgetAccentable()
                Spacer(minLength: 0)
            } else {
                ForEach(entry.todayTasks.prefix(2)) { task in
                    HStack(spacing: 5) {
                        Image(systemName: "circle")
                            .font(.caption2.bold())
                            .widgetAccentable()
                        Text(task.title)
                            .font(.caption2)
                            .lineLimit(1)
                            .privacySensitive()
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        let count = entry.todayTasks.count
        guard count > 0 else { return "No Taskify tasks due today" }
        return count == 1 ? "1 Taskify task due today" : "\(count) Taskify tasks due today"
    }
}
