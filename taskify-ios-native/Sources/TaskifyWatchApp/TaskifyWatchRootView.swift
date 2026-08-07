import SwiftUI
import TaskifyWatchShared
import WatchKit

struct TaskifyWatchRootView: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @State private var showingQuickAdd = false
    @State private var quickAddBoardID: String?
    @State private var showingInitialSetupPrompt = false
    @State private var hasShownInitialSetupPrompt = false

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
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 30)
            }
            .overlay(alignment: .bottomTrailing) {
                Button {
                    quickAddBoardID = model.quickAddBoardID
                    WKInterfaceDevice.current().play(.click)
                    showingQuickAdd = true
                } label: {
                    Image(systemName: "plus")
                        .font(.headline.weight(.semibold))
                        .frame(width: 38, height: 38)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .padding(.trailing, 5)
                .padding(.bottom, 3)
                .disabled(model.quickAddBoardID == nil)
                .accessibilityLabel("Add task")
            }
            .sheet(isPresented: $showingQuickAdd) {
                TaskifyWatchQuickAddSheet(destinationBoardID: quickAddBoardID)
                    .environment(model)
            }
        } else {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 12) {
                        Image(systemName: "iphone.and.arrow.forward")
                            .font(.largeTitle.weight(.semibold))
                            .foregroundStyle(.blue)

                        Text("Open Taskify on iPhone")
                            .font(.headline)
                            .multilineTextAlignment(.center)

                        Text("Taskify will open Watch authorization automatically. Keep this Watch app open, then tap Enable Watch sync on your iPhone.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)

                        Label(model.statusMessage, systemImage: "lock.shield.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 6)
                }
                .navigationTitle("Setup")
            }
            .task {
                model.requestInitialSetupNavigation()
                guard !hasShownInitialSetupPrompt else { return }
                hasShownInitialSetupPrompt = true
                showingInitialSetupPrompt = true
            }
            .alert("Open Taskify on iPhone", isPresented: $showingInitialSetupPrompt) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Taskify will take you directly to Apple Watch authorization.")
            }
        }
    }
}

private struct TaskifyWatchQuickAddSheet: View {
    private enum Mode {
        case choices
        case type
    }

    @Environment(TaskifyWatchAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let destinationBoardID: String?

    @State private var mode: Mode = .choices
    @State private var draft = ""
    @State private var isRequestingSystemInput = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(model.boardName(for: destinationBoardID), systemImage: "rectangle.stack.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if mode == .choices {
                    Section("Input") {
                        Button {
                            mode = .type
                        } label: {
                            QuickAddOptionLabel(
                                title: "Type task name",
                                subtitle: "Keyboard or Scribble",
                                systemImage: "keyboard"
                            )
                        }

                        Button {
                            requestSystemInput(usingTaskifyVoice: false)
                        } label: {
                            QuickAddOptionLabel(
                                title: "Watch Dictation",
                                subtitle: "One task, exact wording",
                                systemImage: "mic.fill"
                            )
                        }

                        Button {
                            requestSystemInput(usingTaskifyVoice: true)
                        } label: {
                            QuickAddOptionLabel(
                                title: "Taskify Voice",
                                subtitle: "Dates or multiple tasks",
                                systemImage: "waveform.and.sparkles"
                            )
                        }
                    }
                } else {
                    Section("Task name") {
                        TextField("What needs doing?", text: $draft)
                            .onSubmit { submit(draft, usingTaskifyVoice: false) }

                        Button("Add Task") {
                            submit(draft, usingTaskifyVoice: false)
                        }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    Button("Back") { mode = .choices }
                }

                if isRequestingSystemInput {
                    ProgressView("Opening input…")
                }

                Button("Cancel", role: .cancel) { dismiss() }
            }
            .navigationTitle("New Task")
        }
    }

    private func requestSystemInput(usingTaskifyVoice: Bool) {
        guard !isRequestingSystemInput,
              let controller = WKApplication.shared().visibleInterfaceController else { return }
        isRequestingSystemInput = true
        controller.presentTextInputController(
            withSuggestions: nil,
            allowedInputMode: .plain
        ) { results in
            isRequestingSystemInput = false
            guard let text = results?.first as? String else { return }
            submit(text, usingTaskifyVoice: usingTaskifyVoice)
        }
    }

    private func submit(_ value: String, usingTaskifyVoice: Bool) {
        guard model.addTask(
            value,
            boardID: destinationBoardID,
            usingTaskifyVoice: usingTaskifyVoice
        ) else { return }
        WKInterfaceDevice.current().play(.success)
        dismiss()
    }
}

private struct QuickAddOptionLabel: View {
    let title: String
    let subtitle: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(.blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
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

    var boardID: String? {
        if case .board(let boardID) = self { return boardID }
        return nil
    }
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
        .onAppear { model.setActiveQuickAddBoardID(source.boardID) }
        .onDisappear {
            if model.activeQuickAddBoardID == source.boardID {
                model.setActiveQuickAddBoardID(nil)
            }
        }
    }
}
