import SwiftUI
import TaskifyWatchShared
import WatchKit

private enum TaskifyWatchTheme {
    static let fallbackAccent = Color(
        red: TaskifyBrand.accentRed,
        green: TaskifyBrand.accentGreen,
        blue: TaskifyBrand.accentBlue
    )
    static let fallbackAccentOn = Color(
        red: TaskifyBrand.accentOnRed,
        green: TaskifyBrand.accentOnGreen,
        blue: TaskifyBrand.accentOnBlue
    )
}

extension TaskifyWatchAppModel {
    var taskifyAccentColor: Color {
        guard let accent = snapshot.accent else { return TaskifyWatchTheme.fallbackAccent }
        return Color(
            red: Double(accent.red) / 255,
            green: Double(accent.green) / 255,
            blue: Double(accent.blue) / 255
        )
    }

    var taskifyAccentForegroundColor: Color {
        guard let accent = snapshot.accent else { return TaskifyWatchTheme.fallbackAccentOn }
        return Color(
            red: Double(accent.foregroundRed) / 255,
            green: Double(accent.foregroundGreen) / 255,
            blue: Double(accent.foregroundBlue) / 255
        )
    }
}

/// A clear, untinted circular Liquid Glass surface for compact Watch controls. Keeping the glass
/// neutral lets the synchronized Taskify accent remain legible on the symbol instead of tinting
/// both the symbol and its background the same color.
struct TaskifyWatchCircularGlassControl: ViewModifier {
    let size: CGFloat

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(watchOS 26.0, *) {
            content
                .frame(width: size, height: size)
                .contentShape(Circle())
                .glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .frame(width: size, height: size)
                .contentShape(Circle())
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 0.8))
        }
    }
}

extension View {
    func taskifyWatchCircularGlassControl(size: CGFloat) -> some View {
        modifier(TaskifyWatchCircularGlassControl(size: size))
    }
}

private enum TaskifyWatchRootRoute: Hashable {
    case today
    case upcoming
    case chat
    case board(String)
}

struct TaskifyWatchRootView: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingQuickAdd = false
    @State private var quickAddBoardID: String?
    @State private var showingInitialSetupPrompt = false
    @State private var hasShownInitialSetupPrompt = false
    @State private var navigationPath: [TaskifyWatchRootRoute] = {
#if DEBUG
        // Match the iPhone debug entry point so paired idle profiling can start on Chat.
        if ProcessInfo.processInfo.environment["TASKIFY_INITIAL_TAB"] == "chat" {
            return [.chat]
        }
#endif
        return []
    }()

    var body: some View {
        if model.isProvisioned {
            NavigationStack(path: $navigationPath) {
                List {
                    Section {
                        NavigationLink(value: TaskifyWatchRootRoute.today) {
                            WatchDestinationLabel(
                                title: "Today",
                                count: model.todayTasks.count,
                                systemImage: "sun.max.fill",
                                color: .orange
                            )
                        }

                        NavigationLink(value: TaskifyWatchRootRoute.upcoming) {
                            WatchDestinationLabel(
                                title: "Upcoming",
                                count: model.upcomingTasks.count,
                                systemImage: "calendar",
                                color: .blue
                            )
                        }

                        NavigationLink(value: TaskifyWatchRootRoute.chat) {
                            WatchDestinationLabel(
                                title: "Chat",
                                count: model.chatUnreadCount,
                                systemImage: "bubble.left.and.bubble.right.fill",
                                color: model.taskifyAccentColor
                            )
                        }
                    }

                    Section("Boards") {
                        ForEach(model.snapshot.boards) { board in
                            NavigationLink(value: TaskifyWatchRootRoute.board(board.id)) {
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
                .refreshable {
                    await model.refreshLatestData(forceComplicationReload: true)
                }
                .navigationTitle("Taskify")
                .navigationDestination(for: TaskifyWatchRootRoute.self) { route in
                    switch route {
                    case .today:
                        TaskifyWatchTaskList(title: "Today", source: .today)
                    case .upcoming:
                        TaskifyWatchTaskList(title: "Upcoming", source: .upcoming)
                    case .chat:
                        TaskifyWatchChatListView()
                    case .board(let boardID):
                        TaskifyWatchTaskList(
                            title: model.snapshot.boards.first { $0.id == boardID }?.name ?? "Board",
                            source: .board(boardID)
                        )
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if navigationPath.first != .chat {
                    Color.clear.frame(height: 16)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if navigationPath.first != .chat {
                    Button {
                        // A board task list supplies a fixed destination. Home, Today, and Upcoming
                        // deliberately pass nil so the sheet asks the user which board to use.
                        quickAddBoardID = model.activeQuickAddBoardID
                        WKInterfaceDevice.current().play(.click)
                        showingQuickAdd = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(model.taskifyAccentColor)
                            .taskifyWatchCircularGlassControl(size: 36)
                        // Keep a comfortable invisible hit target without making the visible button
                        // dominate the small screen.
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, -2)
                    .padding(.bottom, -2)
                    .disabled(model.snapshot.boards.isEmpty)
                    .accessibilityLabel("Add task")
                }
            }
            .sheet(isPresented: $showingQuickAdd) {
                TaskifyWatchQuickAddSheet(destinationBoardID: quickAddBoardID)
                    .environment(model)
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                await model.beginAvatarRefresh()
                // Retry WidgetKit when the app becomes active even if the shared snapshot itself
                // did not change. A previously budget-delayed complication reload must not leave
                // an old "All clear" timeline beside a Watch app that already has today's tasks.
                await model.refreshLatestData(forceComplicationReload: true)
                // The independent client intentionally uses short-lived HTTPS relay queries
                // rather than keeping a persistent Watch WebSocket alive. Refresh modestly while
                // the UI is active so edits from a web client appear without reopening the app.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(60))
                    guard !Task.isCancelled else { return }
                    await model.refreshLatestData()
                }
            }
            .tint(model.taskifyAccentColor)
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    model.refreshViewClock()
                    try? await Task.sleep(for: .seconds(model.nextViewClockDelay))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in
                model.refreshViewClock()
            }
            .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
                model.refreshViewClock()
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
                                    .tint(model.taskifyAccentColor)
                                Text("Understanding…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        } else if let voicePreview {
                            ForEach(voicePreview.tasks) { task in
                                TaskifyWatchVoiceDraftRow(task: task, defaultBoardID: effectiveBoardID)
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
                        .tint(model.taskifyAccentColor)
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
    @Environment(TaskifyWatchAppModel.self) private var model
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(model.taskifyAccentColor)
                .frame(width: 24)
            Text(title)
                .font(.body.weight(.semibold))
        }
    }
}

private struct TaskifyWatchVoiceDraftRow: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    let task: TaskifyWatchVoiceDraft
    let defaultBoardID: String?

    var body: some View {
        if let fallback = model.snapshot.boards.first(where: { $0.id == defaultBoardID }) {
            let board = task.destinationBoard(in: model.snapshot.boards, fallback: fallback)
            TaskifyWatchTaskCard(task: task.taskPreview(board: board))
        }
    }
}

private struct TaskifyWatchTaskCard: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    let task: TaskifyWatchTask
    var onComplete: (() -> Void)? = nil
    var showsCompletionIcon = true

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if let onComplete {
                Button(action: onComplete) { completionIcon }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Complete \(task.title)")
            } else if showsCompletionIcon {
                completionIcon.accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(task.title).font(.body.weight(.semibold))
                HStack(spacing: 4) {
                    Text(task.boardName)
                    if let columnName = task.columnName { Text("·"); Text(columnName) }
                }
                .font(.caption2).foregroundStyle(.secondary)
                if let dueDate = task.dueDate {
                    Label {
                        if task.dueTimeEnabled {
                            Text(dueDate, format: .dateTime.month(.abbreviated).day().hour().minute())
                        } else {
                            Text(dueDate, format: .dateTime.month(.abbreviated).day())
                        }
                    } icon: { Image(systemName: "calendar") }
                    .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var completionIcon: some View {
        Image(systemName: "circle").font(.title3)
            .foregroundStyle(model.taskifyAccentColor)
            .frame(width: 40, height: 40).contentShape(Circle())
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
                    HStack(spacing: 4) {
                        Button {
                            WKInterfaceDevice.current().play(.success)
                            withAnimation(.snappy(duration: 0.2)) { model.completeTask(task.id) }
                        } label: {
                            Image(systemName: "circle")
                                .font(.title3)
                                .foregroundStyle(model.taskifyAccentColor)
                                .frame(width: 40, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Complete \(task.title)")
                        NavigationLink {
                            TaskifyWatchTaskDetail(taskID: task.id)
                        } label: {
                            TaskifyWatchTaskCard(task: model.taskWithPendingEdits(task), showsCompletionIcon: false)
                        }
                    }
                }
            }
        }
        .navigationTitle(title)
        .refreshable {
            await model.refreshLatestData(forceComplicationReload: true)
        }
        .onAppear { model.setActiveQuickAddBoardID(source.boardID) }
        .onDisappear {
            if model.activeQuickAddBoardID == source.boardID {
                model.setActiveQuickAddBoardID(nil)
            }
        }
    }
}

private struct TaskifyWatchTaskDetail: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let taskID: String
    @State private var showingEditor = false

    private var task: TaskifyWatchTask? {
        model.snapshot.tasks.first { $0.id == taskID }.map { model.taskWithPendingEdits($0) }
    }

    var body: some View {
        ScrollView {
            if let task {
                VStack(alignment: .leading, spacing: 12) {
                    Text(task.title)
                        .font(.title3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                    ForEach(task.subtasks) { subtask in
                        Button {
                            model.setSubtaskCompletion(
                                taskID: taskID, subtaskID: subtask.id, completed: !subtask.completed
                            )
                            WKInterfaceDevice.current().play(subtask.completed ? .click : .success)
                        } label: {
                            Label(subtask.title, systemImage: subtask.completed ? "checkmark.circle.fill" : "circle")
                                .strikethrough(subtask.completed)
                                .foregroundStyle(subtask.completed ? .secondary : .primary)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .padding(.horizontal, 10)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(subtask.title)
                        .accessibilityValue(subtask.completed ? "Completed" : "Incomplete")
                        .accessibilityHint(subtask.completed ? "Mark as incomplete" : "Mark as completed")
                    }
                    Button("Edit") { showingEditor = true }
                        .frame(maxWidth: .infinity)
                    Button("Mark as Completed") {
                        model.completeTask(taskID)
                        WKInterfaceDevice.current().play(.success)
                        dismiss()
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .padding(.horizontal, 4)
                .sheet(isPresented: $showingEditor) {
                    TaskifyWatchTaskEditor(task: task)
                        .environment(model)
                }
            } else {
                Text("This task is no longer available.")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct TaskifyWatchTaskEditor: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let task: TaskifyWatchTask
    @State private var draft: TaskifyWatchTaskEdit
    @State private var saveFailed = false

    init(task: TaskifyWatchTask) {
        self.task = task
        _draft = State(initialValue: TaskifyWatchTaskEdit(task: task))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $draft.title)
                    TextField("Add Notes", text: $draft.note, axis: .vertical)
                }
                Section {
                    Toggle("Date", isOn: Binding(
                        get: { draft.dueDate != nil },
                        set: { enabled in
                            draft.dueDate = enabled ? Calendar.current.startOfDay(for: Date()) : nil
                            if !enabled { draft.dueTimeEnabled = false }
                        }
                    ))
                    if draft.dueDate != nil {
                        DatePicker("Date", selection: Binding(
                            get: { draft.dueDate ?? Date() },
                            set: { draft.dueDate = $0 }
                        ), displayedComponents: .date)
                        Toggle("Time", isOn: $draft.dueTimeEnabled)
                        if draft.dueTimeEnabled {
                            DatePicker("Time", selection: Binding(
                                get: { draft.dueDate ?? Date() },
                                set: { draft.dueDate = $0; draft.dueTimeZone = TimeZone.current.identifier }
                            ), displayedComponents: .hourAndMinute)
                        }
                    }
                }
                Section {
                    Picker("Priority", selection: $draft.priority) {
                        Text("None").tag(Int?.none)
                        Text("Low").tag(Int?(1))
                        Text("Medium").tag(Int?(2))
                        Text("High").tag(Int?(3))
                    }
                    LabeledContent("Board", value: task.boardName)
                }
                Text("Changes sync through your iPhone when connected.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", systemImage: "checkmark") {
                        draft.title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
                        if draft.dueTimeEnabled && draft.dueTimeZone == nil {
                            draft.dueTimeZone = TimeZone.current.identifier
                        }
                        if model.editTask(task.id, edit: draft) {
                            WKInterfaceDevice.current().play(.success)
                            dismiss()
                        } else { saveFailed = true }
                    }
                    .labelStyle(.iconOnly)
                    .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .alert("Unable to save", isPresented: $saveFailed) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("This task may no longer be available. Close the editor and refresh your tasks.")
            }
        }
    }
}
