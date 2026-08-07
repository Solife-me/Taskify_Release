import SwiftUI
import TaskifyWatchShared
import WatchKit

private enum TaskifyWatchTheme {
    static let accent = Color(
        red: TaskifyBrand.accentRed,
        green: TaskifyBrand.accentGreen,
        blue: TaskifyBrand.accentBlue
    )
    static let accentOn = Color(
        red: TaskifyBrand.accentOnRed,
        green: TaskifyBrand.accentOnGreen,
        blue: TaskifyBrand.accentOnBlue
    )
}

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
                Color.clear.frame(height: 16)
            }
            .overlay(alignment: .bottomTrailing) {
                Button {
                    // A board task list supplies a fixed destination. Home, Today, and Upcoming
                    // deliberately pass nil so the sheet asks the user which board to use.
                    quickAddBoardID = model.activeQuickAddBoardID
                    WKInterfaceDevice.current().play(.click)
                    showingQuickAdd = true
                } label: {
                    ZStack {
                        Circle()
                            .fill(TaskifyWatchTheme.accent)
                            .frame(width: 26, height: 26)
                        Image(systemName: "plus")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TaskifyWatchTheme.accentOn)
                    }
                    // Keep a comfortable invisible hit target without making the visible button
                    // dominate the small screen.
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, -2)
                .padding(.bottom, -2)
                .disabled(model.snapshot.boards.isEmpty)
                .accessibilityLabel("Add task")
            }
            .sheet(isPresented: $showingQuickAdd) {
                TaskifyWatchQuickAddSheet(destinationBoardID: quickAddBoardID)
                    .environment(model)
            }
            .task {
                await model.refreshFromRelays()
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
    private enum Mode: Equatable {
        case choices
        case dictationReview
    }

    @Environment(TaskifyWatchAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let destinationBoardID: String?

    @State private var mode: Mode = .choices
    @State private var selectedBoardID: String?
    @State private var dictatedTranscript = ""
    @State private var voicePreview: TaskifyWatchVoicePreview?
    @State private var dictationError: String?
    @State private var isInterpreting = false
    @State private var interpretationTask: Task<Void, Never>?

    private var effectiveBoardID: String? {
        destinationBoardID ?? selectedBoardID
    }

    var body: some View {
        NavigationStack {
            List {
                if let destinationBoardID {
                    Section {
                        Label(model.boardName(for: destinationBoardID), systemImage: "rectangle.stack.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("Add to board") {
                        Picker("Board", selection: $selectedBoardID) {
                            ForEach(model.snapshot.boards) { board in
                                Text(board.name)
                                    .tag(Optional(board.id))
                            }
                        }
                    }
                }

                switch mode {
                case .choices:
                    Section {
                        TextFieldLink(
                            prompt: Text("Task name"),
                            label: {
                                QuickAddChoiceLabel(
                                    title: "Type",
                                    systemImage: "keyboard"
                                )
                            },
                            onSubmit: addTypedTask
                        )

                        TextFieldLink(
                            prompt: Text("Describe tasks naturally"),
                            label: {
                                QuickAddChoiceLabel(
                                    title: "Dictation",
                                    systemImage: "waveform.and.sparkles"
                                )
                            },
                            onSubmit: beginDictationReview
                        )
                    }

                case .dictationReview:
                    Section("You said") {
                        Text(dictatedTranscript)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Section("Tasks") {
                        if isInterpreting {
                            VStack(spacing: 8) {
                                ProgressView()
                                    .tint(TaskifyWatchTheme.accent)
                                Text("Understanding…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        } else if let voicePreview {
                            ForEach(voicePreview.tasks) { task in
                                TaskifyWatchVoiceDraftRow(task: task)
                            }
                        } else if let dictationError {
                            Label(dictationError, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }

                    if let tasks = voicePreview?.tasks, !tasks.isEmpty {
                        Button {
                            addDictatedTasks(tasks)
                        } label: {
                            Label(
                                tasks.count == 1 ? "Add Task" : "Add \(tasks.count) Tasks",
                                systemImage: "checkmark"
                            )
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(TaskifyWatchTheme.accent)
                    } else if dictationError != nil {
                        Button("Try Again") {
                            interpretDictation()
                        }
                    }

                    TextFieldLink(
                        prompt: Text("Describe tasks naturally"),
                        label: { Text("Dictate Again") },
                        onSubmit: { value in
                            resetDictation()
                            beginDictationReview(value)
                        }
                    )
                }
            }
            .navigationTitle(mode == .choices ? "New Task" : "Review")
            .onAppear {
                guard destinationBoardID == nil, selectedBoardID == nil else { return }
                selectedBoardID = model.snapshot.selectedBoardID ?? model.snapshot.boards.first?.id
            }
            .onDisappear {
                interpretationTask?.cancel()
                interpretationTask = nil
            }
        }
    }

    private func addTypedTask(_ value: String) {
        guard effectiveBoardID != nil else { return }
        guard model.addTask(
            value,
            boardID: effectiveBoardID,
            usingTaskifyVoice: false
        ) else { return }
        WKInterfaceDevice.current().play(.success)
        dismiss()
    }

    private func beginDictationReview(_ value: String) {
        guard effectiveBoardID != nil else { return }
        dictatedTranscript = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dictatedTranscript.isEmpty else { return }
        mode = .dictationReview
        interpretDictation()
    }

    private func interpretDictation() {
        guard let boardID = effectiveBoardID, !dictatedTranscript.isEmpty else { return }
        voicePreview = nil
        dictationError = nil
        isInterpreting = true
        interpretationTask?.cancel()
        interpretationTask = Task {
            do {
                let preview = try await model.previewVoiceTasks(
                    transcript: dictatedTranscript,
                    boardID: boardID
                )
                guard !Task.isCancelled else { return }
                voicePreview = preview
                WKInterfaceDevice.current().play(.directionUp)
            } catch {
                guard !Task.isCancelled else { return }
                dictationError = error.localizedDescription
                WKInterfaceDevice.current().play(.failure)
            }
            isInterpreting = false
            interpretationTask = nil
        }
    }

    private func addDictatedTasks(_ tasks: [TaskifyWatchVoiceDraft]) {
        guard let boardID = effectiveBoardID,
              model.addVoiceTasks(tasks, boardID: boardID) else { return }
        WKInterfaceDevice.current().play(.success)
        dismiss()
    }

    private func resetDictation() {
        dictatedTranscript = ""
        voicePreview = nil
        dictationError = nil
        isInterpreting = false
        interpretationTask?.cancel()
        interpretationTask = nil
        mode = .choices
    }
}

private struct QuickAddChoiceLabel: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(TaskifyWatchTheme.accent)
                .frame(width: 24)
            Text(title)
                .font(.body.weight(.semibold))
        }
    }
}

private struct TaskifyWatchVoiceDraftRow: View {
    let task: TaskifyWatchVoiceDraft

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(TaskifyWatchTheme.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let dueDate {
                    Label(
                        dueDate.formatted(.dateTime.month(.abbreviated).day().hour().minute()),
                        systemImage: "calendar"
                    )
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                if let subtasks = task.subtasks, !subtasks.isEmpty {
                    Label(
                        "\(subtasks.count) subtask\(subtasks.count == 1 ? "" : "s")",
                        systemImage: "checklist"
                    )
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var dueDate: Date? {
        guard let dueISO = task.dueISO else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: dueISO) ?? ISO8601DateFormatter().date(from: dueISO)
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
                                .foregroundStyle(TaskifyWatchTheme.accent)
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
