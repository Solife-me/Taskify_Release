import SwiftUI
import TaskifyWatchShared
import WatchKit

struct TaskifyWatchRootView: View {
    @Environment(TaskifyWatchAppModel.self) private var model

    var body: some View {
        if model.isProvisioned {
            NavigationStack {
                List {
                    Section {
                        NavigationLink {
                            TaskifyWatchTaskList(title: "Today", source: .today)
                        } label: {
                            WatchDestinationLabel(
                                title: "Today",
                                count: model.todayTasks.count,
                                systemImage: "sun.max.fill",
                                color: .orange
                            )
                        }

                        NavigationLink {
                            TaskifyWatchTaskList(title: "Upcoming", source: .upcoming)
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
                                    source: .board(board.id)
                                )
                            } label: {
                                WatchDestinationLabel(
                                    title: board.name,
                                    count: model.openTaskCount(for: board.id),
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
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 10) {
                            Image(systemName: "applewatch.and.arrow.forward")
                                .font(.title2.weight(.semibold))
                                .foregroundStyle(.blue)
                            Text("Connect Taskify")
                                .font(.headline)
                        }

                        WatchSetupStep(number: 1, text: "Keep this screen open.")
                        WatchSetupStep(number: 2, text: "Open Taskify Settings on your iPhone.")
                        WatchSetupStep(number: 3, text: "Find Apple Watch and tap Enable Watch sync.")

                        Label(model.statusMessage, systemImage: "lock.shield.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                }
                .navigationTitle("Setup")
            }
        }
    }
}

private struct WatchSetupStep: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Text(number, format: .number)
                .font(.caption.bold())
                .frame(width: 24, height: 24)
                .background(.blue, in: Circle())
                .foregroundStyle(.white)
            Text(text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
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

private enum TaskifyWatchTaskSource {
    case today
    case upcoming
    case board(String)
}

private struct TaskifyWatchTaskList: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    let title: String
    let source: TaskifyWatchTaskSource

    private var tasks: [TaskifyWatchTask] {
        switch source {
        case .today:
            model.todayTasks
        case .upcoming:
            model.upcomingTasks
        case .board(let boardID):
            model.tasks(for: boardID)
        }
    }

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
                    HStack(alignment: .top, spacing: 9) {
                        Button {
                            WKInterfaceDevice.current().play(.success)
                            withAnimation(.snappy(duration: 0.2)) {
                                model.completeTask(task.id)
                            }
                        } label: {
                            Image(systemName: "circle")
                                .font(.title3)
                                .foregroundStyle(.blue)
                                .frame(width: 40, height: 40)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Complete \(task.title)")

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
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle(title)
    }
}
