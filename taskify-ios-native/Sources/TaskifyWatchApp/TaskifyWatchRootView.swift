import SwiftUI
import TaskifyWatchShared

struct TaskifyWatchRootView: View {
    @Environment(TaskifyWatchAppModel.self) private var model

    var body: some View {
        if model.isProvisioned {
            NavigationStack {
                List {
                    Section {
                        NavigationLink {
                            TaskifyWatchTaskList(title: "Today", tasks: model.todayTasks)
                        } label: {
                            WatchDestinationLabel(
                                title: "Today",
                                count: model.todayTasks.count,
                                systemImage: "sun.max.fill",
                                color: .orange
                            )
                        }

                        NavigationLink {
                            TaskifyWatchTaskList(title: "Upcoming", tasks: model.upcomingTasks)
                        } label: {
                            WatchDestinationLabel(
                                title: "Upcoming",
                                count: model.upcomingTasks.count,
                                systemImage: "calendar",
                                color: .blue
                            )
                        }
                    }

                    Section("Boards") {
                        ForEach(model.snapshot.boards) { board in
                            NavigationLink {
                                TaskifyWatchTaskList(
                                    title: board.name,
                                    tasks: model.tasks(for: board.id)
                                )
                            } label: {
                                WatchDestinationLabel(
                                    title: board.name,
                                    count: board.openTaskCount,
                                    systemImage: "rectangle.stack.fill",
                                    color: .purple
                                )
                            }
                        }
                    }

                    Section {
                        Label(model.statusMessage, systemImage: "lock.shield.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .navigationTitle("Taskify")
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "applewatch.and.arrow.forward")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.blue)
                Text("Finish setup")
                    .font(.headline)
                Text("Keep Taskify open here, then choose Enable Watch sync in Taskify Settings on your iPhone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text(model.statusMessage)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
    }
}

private struct WatchDestinationLabel: View {
    let title: String
    let count: Int
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(color)
                .frame(width: 24)
            Text(title)
                .lineLimit(1)
            Spacer()
            Text(count, format: .number)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}

private struct TaskifyWatchTaskList: View {
    let title: String
    let tasks: [TaskifyWatchTask]

    var body: some View {
        List {
            if tasks.isEmpty {
                ContentUnavailableView(
                    "All clear",
                    systemImage: "checkmark.circle.fill",
                    description: Text("No open tasks here.")
                )
            } else {
                ForEach(tasks) { task in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title)
                            .font(.body.weight(.semibold))
                        HStack(spacing: 4) {
                            Text(task.boardName)
                            if let columnName = task.columnName {
                                Text("·")
                                Text(columnName)
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                        if let dueDate = task.dueDate {
                            Label {
                                if task.dueTimeEnabled {
                                    Text(dueDate, format: .dateTime.month(.abbreviated).day().hour().minute())
                                } else {
                                    Text(dueDate, format: .dateTime.month(.abbreviated).day())
                                }
                            } icon: {
                                Image(systemName: "calendar")
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle(title)
    }
}
