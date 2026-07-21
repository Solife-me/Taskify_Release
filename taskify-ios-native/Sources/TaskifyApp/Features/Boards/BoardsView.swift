import SwiftUI
import TaskifyCore

struct BoardsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showCompleted = false
    @State private var showingAddList = false
    @State private var newListName = ""

    var body: some View {
        VStack(spacing: 10) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 6)

            boardContent
        }
        .alert("Add list", isPresented: $showingAddList) {
            TextField("List name", text: $newListName)
            Button("Cancel", role: .cancel) { newListName = "" }
            Button("Add") {
                guard model.addListColumn(name: newListName) else { return }
                newListName = ""
            }
            .disabled(newListName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("Create another column on \(model.selectedBoard?.name ?? "this board").")
        }
    }

    @ViewBuilder
    private var boardContent: some View {
        switch model.selectedBoard?.kind {
        case .week:
            WeekBoardView(showCompleted: showCompleted)
        case .list:
            if let board = model.selectedBoard {
                ListBoardView(board: board, showCompleted: showCompleted)
            }
        case .compound:
            ContentUnavailableView("Compound board migration pending", systemImage: "square.stack.3d.up")
                .foregroundStyle(TaskifyTheme.secondaryText)
        case .bible:
            ContentUnavailableView("Bible board migration pending", systemImage: "book.closed")
                .foregroundStyle(TaskifyTheme.secondaryText)
        case nil:
            ContentUnavailableView("No board selected", systemImage: "square.grid.2x2")
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Menu {
                ForEach(model.visibleBoards) { board in
                    Button {
                        model.selectBoard(board.id)
                    } label: {
                        if board.id == model.selectedBoardID {
                            Label(board.name, systemImage: "checkmark")
                        } else {
                            Text(board.name)
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(model.selectedBoard?.name ?? "Boards")
                        .font(.system(size: 17, weight: .semibold))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .bold))
                }
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(.horizontal, 16)
                .frame(height: 42)
                .background(TaskifyTheme.raisedFill, in: Capsule())
                .overlay(Capsule().stroke(TaskifyTheme.border, lineWidth: 1))
            }

            Spacer(minLength: 4)

            HeaderIconButton(
                systemName: showCompleted ? "checkmark.circle.fill" : "checkmark",
                accent: showCompleted,
                accessibilityLabel: showCompleted ? "Hide completed tasks" : "Show completed tasks"
            ) {
                withAnimation(.snappy) { showCompleted.toggle() }
            }

            if model.selectedBoard?.kind == .list {
                HeaderIconButton(
                    systemName: "rectangle.stack.badge.plus",
                    accessibilityLabel: "Add list"
                ) {
                    showingAddList = true
                }
            } else {
                HeaderIconButton(
                    systemName: "calendar",
                    accessibilityLabel: "Board upcoming"
                ) { }
            }

            HeaderIconButton(
                systemName: "arrow.up.arrow.down",
                accessibilityLabel: "Filter and sort"
            ) { }
        }
    }
}

private struct ListBoardView: View {
    let board: Board
    let showCompleted: Bool

    private var columns: [BoardColumn] {
        board.columns.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(columns) { column in
                        ListColumnView(column: column, showCompleted: showCompleted)
                            .frame(width: min(330, proxy.size.width - 50))
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
        }
    }
}

private struct ListColumnView: View {
    @EnvironmentObject private var model: AppModel
    let column: BoardColumn
    let showCompleted: Bool
    @State private var draft = ""

    private var tasks: [TaskItem] {
        model.tasks(forColumnID: column.id, includeCompleted: showCompleted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(column.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                Text("\(tasks.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(TaskifyTheme.raisedFill, in: Capsule())
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task)
                    }
                }
            }
            .scrollIndicators(.hidden)

            HStack(spacing: 8) {
                TextField("New Task", text: $draft)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .onSubmit(addTask)
                    .padding(.horizontal, 16)
                    .frame(height: 46)
                    .background(Color.black.opacity(0.26), in: Capsule())
                    .overlay(Capsule().stroke(TaskifyTheme.border, lineWidth: 1))

                Button(action: addTask) {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .bold))
                        .frame(width: 46, height: 46)
                        .foregroundStyle(.white)
                        .background(TaskifyTheme.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Add task to \(column.name)")
            }
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
    }

    private func addTask() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.addQuickTask(title: draft, columnID: column.id)
        draft = ""
    }
}

private struct WeekBoardView: View {
    let showCompleted: Bool

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(WeekdayColumn.allCases) { weekday in
                        DayColumnView(weekday: weekday, showCompleted: showCompleted)
                            .frame(width: min(330, proxy.size.width - 50))
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
        }
    }
}

private struct DayColumnView: View {
    @EnvironmentObject private var model: AppModel
    let weekday: WeekdayColumn
    let showCompleted: Bool
    @State private var draft = ""

    private var tasks: [TaskItem] {
        model.tasks(for: weekday, includeCompleted: showCompleted)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(weekday.shortName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                Menu {
                    Button("Add task") { }
                    Button("Select tasks") { }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 30, height: 30)
                }
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task)
                    }
                }
            }
            .scrollIndicators(.hidden)

            HStack(spacing: 8) {
                TextField("New Task", text: $draft)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .onSubmit(addTask)
                    .padding(.horizontal, 16)
                    .frame(height: 46)
                    .background(Color.black.opacity(0.26), in: Capsule())
                    .overlay(Capsule().stroke(TaskifyTheme.border, lineWidth: 1))

                Button(action: addTask) {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .bold))
                        .frame(width: 46, height: 46)
                        .foregroundStyle(.white)
                        .background(TaskifyTheme.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Add task to \(weekday.fullName)")
            }
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
    }

    private func addTask() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.addQuickTask(title: draft, weekday: weekday)
        draft = ""
    }
}

struct TaskCardView: View {
    @EnvironmentObject private var model: AppModel
    let task: TaskItem
    @State private var showingEditor = false

    private var subtaskProgress: String? {
        guard let subtasks = task.subtasks, !subtasks.isEmpty else { return nil }
        return "\(subtasks.filter(\.completed).count)/\(subtasks.count)"
    }

    private var mediaBoardID: String {
        model.board(withID: task.boardID)?.effectiveNostrBoardID ?? task.boardID
    }

    private var hasMedia: Bool {
        !(task.images ?? []).isEmpty ||
            !(task.documents ?? []).isEmpty ||
            TaskContentLinks.firstURL(title: task.title, note: task.note) != nil
    }

    private var displayTitle: String {
        guard TaskContentLinks.isURLOnly(task.title),
              let url = TaskContentLinks.firstURL(title: task.title, note: "") else {
            return task.title
        }
        return TaskContentLinks.fallbackTitle(for: url)
    }

    private var displayNote: String {
        TaskContentLinks.removingURLs(from: task.note)
    }

    private var cardCornerRadius: CGFloat { hasMedia ? 24 : 18 }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 11) {
                Button {
                    withAnimation(.snappy) { model.toggleCompletion(task.id) }
                } label: {
                    Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(task.completed ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(task.completed ? "Mark incomplete" : "Complete task")

                Button {
                    showingEditor = true
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(displayTitle)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(task.completed ? TaskifyTheme.tertiaryText : TaskifyTheme.primaryText)
                            .strikethrough(task.completed)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if !displayNote.isEmpty {
                            Text(displayNote)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(2)
                        }

                        if task.priority != nil || (task.dueDateEnabled && task.dueDate != nil) ||
                            subtaskProgress != nil || task.recurrence != nil || !(task.reminders ?? []).isEmpty {
                            HStack(spacing: 9) {
                                if let priority = task.priority {
                                    Text(String(repeating: "!", count: priority.rawValue))
                                        .font(.caption.bold())
                                        .foregroundStyle(priority.cardColor)
                                        .accessibilityLabel("\(priority.cardLabel) priority")
                                }

                                if task.dueDateEnabled, let dueDate = task.dueDate {
                                    Label {
                                        Text(task.dueTimeEnabled
                                            ? dueDate.formatted(.dateTime.month(.abbreviated).day().hour().minute())
                                            : dueDate.formatted(.dateTime.month(.abbreviated).day()))
                                    } icon: {
                                        Image(systemName: task.dueTimeEnabled ? "clock" : "calendar")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                }

                                if let subtaskProgress {
                                    Label(subtaskProgress, systemImage: "checklist")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }

                                if task.recurrence != nil {
                                    Image(systemName: "repeat")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                        .accessibilityLabel("Repeating task")
                                }

                                if !(task.reminders ?? []).isEmpty {
                                    Image(systemName: "bell.fill")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                        .accessibilityLabel("Reminder set")
                                }
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Edit \(displayTitle)")
            }

            if hasMedia {
                TaskMediaView(task: task, boardID: mediaBoardID, compact: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, hasMedia ? 10 : 13)
        .padding(.vertical, hasMedia ? 10 : 12)
        .background(
            LinearGradient(
                colors: [Color.white.opacity(0.13), Color.white.opacity(0.035)],
                startPoint: .top,
                endPoint: .bottom
            ),
            in: RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
                .stroke(Color.white.opacity(hasMedia ? 0.15 : 0.12), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.22), radius: 8, y: 5)
        .contentShape(RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous))
        .accessibilityAction(named: "Edit task") { showingEditor = true }
        .contextMenu {
            Button {
                showingEditor = true
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive) {
                model.deleteTask(task.id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .sheet(isPresented: $showingEditor) {
            TaskEditorView(task: task)
                .environmentObject(model)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

private extension TaskPriority {
    var cardColor: Color {
        switch self {
        case .low: Color.blue
        case .medium: Color.orange
        case .high: Color.red
        }
    }

    var cardLabel: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        }
    }
}
