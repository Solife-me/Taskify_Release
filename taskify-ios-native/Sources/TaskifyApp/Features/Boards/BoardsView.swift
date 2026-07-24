import CoreImage
import CoreImage.CIFilterBuiltins
import CoreTransferable
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers

private extension UTType {
    static let taskifyTask = UTType(exportedAs: "me.solife.taskify.task")
}

private struct TaskDragPayload: Codable, Hashable, Transferable {
    let taskID: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .taskifyTask)
    }
}

private enum TaskDropTargetStyle: Equatable {
    case card
    case column
}

private struct BoardQuickAddDestination: Equatable {
    let boardID: String
    let columnID: String
    let displayName: String
    let weekday: WeekdayColumn?
}

private struct TaskDropTargetModifier: ViewModifier {
    @Environment(AppModel.self) private var model
    let boardID: String
    let columnID: String
    let beforeTaskID: String?
    let style: TaskDropTargetStyle
    @State private var isTargeted = false

    func body(content: Content) -> some View {
        content
            .dropDestination(for: TaskDragPayload.self) { payloads, _ in
                guard let payload = payloads.first else { return false }
                if beforeTaskID == payload.taskID { return true }
                return model.moveTask(
                    payload.taskID,
                    toBoardID: boardID,
                    columnID: columnID,
                    beforeTaskID: beforeTaskID
                )
            } isTargeted: { targeted in
                withAnimation(.easeOut(duration: 0.14)) {
                    isTargeted = targeted
                }
            }
            .overlay(alignment: style == .card ? .top : .center) {
                if isTargeted {
                    switch style {
                    case .card:
                        Capsule()
                            .fill(TaskifyTheme.accent)
                            .frame(height: 4)
                            .padding(.horizontal, 10)
                            .offset(y: -5)
                            .allowsHitTesting(false)
                    case .column:
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(TaskifyTheme.accent, lineWidth: 2)
                            .padding(2)
                            .allowsHitTesting(false)
                    }
                }
            }
    }
}

private struct TaskDragSourceModifier: ViewModifier {
    let payload: TaskDragPayload?
    let title: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if let payload {
            content
                .draggable(payload) {
                    Label(title, systemImage: "rectangle.stack.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(1)
                        .padding(.horizontal, 16)
                        .frame(height: 48)
                        .frame(maxWidth: 260, alignment: .leading)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(TaskifyTheme.border, lineWidth: 1)
                        )
                }
                .accessibilityHint("Touch and hold, then drag to another list or day")
        } else {
            content
        }
    }
}

private extension View {
    func taskDropTarget(
        boardID: String,
        columnID: String,
        beforeTaskID: String? = nil,
        style: TaskDropTargetStyle
    ) -> some View {
        modifier(TaskDropTargetModifier(
            boardID: boardID,
            columnID: columnID,
            beforeTaskID: beforeTaskID,
            style: style
        ))
    }
}

struct BoardsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("taskify.board.sort.mode") private var sortModeRaw = UpcomingSortMode.manual.rawValue
    @AppStorage("taskify.board.sort.direction") private var sortDirectionRaw = UpcomingSortDirection.ascending.rawValue
    @State private var showCompleted = false
    @State private var showingAddList = false
    @State private var showingBoardShare = false
    @State private var showingSharedInbox = false
    @State private var showingBoardUpcoming = false
    @State private var showingSortOptions = false
    @State private var showingClearCompletedConfirmation = false
    @State private var newListName = ""
    @State private var quickTaskDraft = ""
    @State private var focusedPageID: String?
    @FocusState private var quickTaskFieldIsFocused: Bool

    private var sortMode: UpcomingSortMode {
        UpcomingSortMode(rawValue: sortModeRaw) ?? .manual
    }

    private var sortDirection: UpcomingSortDirection {
        UpcomingSortDirection(rawValue: sortDirectionRaw) ?? sortMode.defaultDirection
    }

    var body: some View {
        VStack(spacing: 10) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 6)

            boardContent
        }
        .overlay(alignment: .bottom) {
            if let quickAddDestination {
                FloatingQuickAddBar(
                    draft: $quickTaskDraft,
                    isFocused: $quickTaskFieldIsFocused,
                    destinationName: quickAddDestination.displayName,
                    onSubmit: { addQuickTask(dismissKeyboard: false) },
                    onAddButton: { addQuickTask(dismissKeyboard: true) }
                )
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
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
        .sheet(isPresented: $showingBoardShare) {
            if let board = model.selectedBoard {
                BoardShareSheet(board: board)
            }
        }
        .sheet(isPresented: $showingSharedInbox) {
            SharedTaskInboxSheet()
                .environment(model)
        }
        .sheet(isPresented: $showingBoardUpcoming) {
            if let board = model.selectedBoard {
                BoardUpcomingSheet(board: board)
                    .environment(model)
            }
        }
        .sheet(isPresented: $showingSortOptions) {
            BoardSortOptionsSheet(
                sortMode: sortMode,
                sortDirection: sortDirection,
                onSelectSort: selectSortMode
            )
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Clear all completed tasks on \(model.selectedBoard?.name ?? "this board")?",
            isPresented: $showingClearCompletedConfirmation,
            titleVisibility: .visible
        ) {
            Button("Clear completed", role: .destructive) {
                guard let boardID = model.selectedBoard?.id else { return }
                model.clearCompletedTasks(forBoardID: boardID)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
        .onAppear(perform: resetFocusedPage)
        .onChange(of: model.selectedBoardID) { _, _ in
            quickTaskDraft = ""
            quickTaskFieldIsFocused = false
            resetFocusedPage()
        }
    }

    @ViewBuilder
    private var boardContent: some View {
        switch model.selectedBoard?.kind {
        case .week:
            WeekBoardView(
                showCompleted: showCompleted,
                sortMode: sortMode,
                sortDirection: sortDirection,
                focusedPageID: $focusedPageID
            )
        case .list:
            if let board = model.selectedBoard {
                ListBoardView(
                    board: board,
                    showCompleted: showCompleted,
                    sortMode: sortMode,
                    sortDirection: sortDirection,
                    focusedPageID: $focusedPageID
                )
            }
        case .compound:
            if let board = model.selectedBoard {
                CompoundBoardView(
                    board: board,
                    showCompleted: showCompleted,
                    sortMode: sortMode,
                    sortDirection: sortDirection,
                    focusedPageID: $focusedPageID
                )
            }
        case .bible:
            BibleTrackerView(showCompletedBooks: showCompleted)
        case nil:
            ContentUnavailableView("No board selected", systemImage: "square.grid.2x2")
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

    private var quickAddDestination: BoardQuickAddDestination? {
        guard let board = model.selectedBoard else { return nil }

        switch board.kind {
        case .week:
            let weekday = WeekdayColumn(rawValue: focusedPageID ?? "")
                ?? WeekdayColumn.containing(Date())
            return BoardQuickAddDestination(
                boardID: board.id,
                columnID: weekday.rawValue,
                displayName: weekday.fullName,
                weekday: weekday
            )
        case .list:
            let columns = board.columns.sorted {
                if $0.order != $1.order { return $0.order < $1.order }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            guard let column = columns.first(where: { $0.id == focusedPageID }) ?? columns.first else {
                return nil
            }
            return BoardQuickAddDestination(
                boardID: board.id,
                columnID: column.id,
                displayName: column.name,
                weekday: nil
            )
        case .compound:
            let references = model.compoundChildBoards(for: board.id).flatMap { child in
                child.columns.map { CompoundColumnReference(board: child, column: $0) }
            }
            guard let reference = references.first(where: { $0.id == focusedPageID }) ?? references.first else {
                return nil
            }
            return BoardQuickAddDestination(
                boardID: reference.board.id,
                columnID: reference.column.id,
                displayName: "\(reference.board.name), \(reference.column.name)",
                weekday: nil
            )
        case .bible:
            return nil
        }
    }

    private func resetFocusedPage() {
        guard let board = model.selectedBoard else {
            focusedPageID = nil
            return
        }

        switch board.kind {
        case .week:
            focusedPageID = WeekdayColumn.containing(Date()).rawValue
        case .list:
            focusedPageID = board.columns.sorted { $0.order < $1.order }.first?.id
        case .compound:
            focusedPageID = model.compoundChildBoards(for: board.id)
                .flatMap { child in
                    child.columns
                        .sorted { $0.order < $1.order }
                        .map { CompoundColumnReference(board: child, column: $0).id }
                }
                .first
        case .bible:
            focusedPageID = nil
        }
    }

    private func addQuickTask(dismissKeyboard: Bool) {
        guard let quickAddDestination,
              !quickTaskDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        if let weekday = quickAddDestination.weekday {
            model.addQuickTask(title: quickTaskDraft, weekday: weekday)
        } else {
            model.addQuickTask(
                title: quickTaskDraft,
                boardID: quickAddDestination.boardID,
                columnID: quickAddDestination.columnID
            )
        }
        quickTaskDraft = ""

        if dismissKeyboard {
            quickTaskFieldIsFocused = false
        } else {
            DispatchQueue.main.async {
                quickTaskFieldIsFocused = true
            }
        }
    }

    private func selectSortMode(_ mode: UpcomingSortMode) {
        if sortMode == mode, mode.supportsDirection {
            sortDirectionRaw = (sortDirection == .ascending
                ? UpcomingSortDirection.descending
                : UpcomingSortDirection.ascending).rawValue
            return
        }
        sortModeRaw = mode.rawValue
        sortDirectionRaw = mode.defaultDirection.rawValue
    }

    private var header: some View {
        TaskifyGlassControlGroup(spacing: 10) {
            HStack(spacing: 10) {
                HStack(spacing: 0) {
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
                        .padding(.leading, 16)
                        .padding(.trailing, 11)
                        .frame(height: 42)
                    }

                    if model.selectedBoard?.kind != .bible {
                        Rectangle()
                            .fill(TaskifyTheme.border)
                            .frame(width: 1, height: 23)

                        Button {
                            showingBoardShare = true
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .frame(width: 42, height: 42)
                                .contentShape(Rectangle())
                        }
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .buttonStyle(.plain)
                        .accessibilityLabel("Share \(model.selectedBoard?.name ?? "board")")
                    }
                }
                .taskifyGlassControl(in: Capsule())
                .layoutPriority(1)

                Spacer(minLength: 4)

                HeaderIconButton(
                    systemName: showCompleted ? "checkmark.circle.fill" : "checkmark",
                    accent: showCompleted,
                    accessibilityLabel: showCompleted ? "Hide completed tasks" : "Show completed tasks"
                ) {
                    withAnimation(.snappy) { showCompleted.toggle() }
                }
                .contextMenu {
                    if showCompleted, model.selectedBoard?.kind != .bible {
                        Button(role: .destructive) {
                            showingClearCompletedConfirmation = true
                        } label: {
                            Label("Clear completed tasks", systemImage: "trash")
                        }
                    }
                }

                if model.selectedBoard?.kind == .list {
                    HeaderIconButton(
                        systemName: "rectangle.stack.badge.plus",
                        accessibilityLabel: "Add list"
                    ) {
                        showingAddList = true
                    }
                } else if model.selectedBoard?.kind != .bible {
                    HeaderIconButton(
                        systemName: "calendar",
                        accessibilityLabel: "Board upcoming"
                    ) {
                        showingBoardUpcoming = true
                    }
                }

                if model.selectedBoard?.kind != .bible {
                    HeaderIconButton(
                        systemName: "arrow.up.arrow.down",
                        accent: sortMode != .manual,
                        accessibilityLabel: "Sort tasks"
                    ) {
                        showingSortOptions = true
                    }
                }

                HeaderIconButton(
                    systemName: model.pendingSharedInboxCount > 0 ? "tray.full.fill" : "tray",
                    accent: model.pendingSharedInboxCount > 0,
                    accessibilityLabel: model.pendingSharedInboxCount > 0
                        ? "Shared task inbox, \(model.pendingSharedInboxCount) pending"
                        : "Shared task inbox"
                ) {
                    showingSharedInbox = true
                }
            }
        }
    }
}

private struct SharedTaskInboxSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model

    private var visibleItems: [SharedInboxItem] {
        model.sharedInboxItems.filter { $0.status != .deleted }
    }

    private var destinationName: String? {
        guard let board = model.selectedBoard, board.kind != .bible else { return nil }
        return board.name
    }

    var body: some View {
        NavigationStack {
            Group {
                if visibleItems.isEmpty {
                    ContentUnavailableView(
                        "No shared tasks",
                        systemImage: "tray",
                        description: Text("Tasks and assignments sent to your Nostr identity will appear here.")
                    )
                    .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            if let destinationName {
                                Label(
                                    "Accepted tasks are added to \(destinationName)",
                                    systemImage: "arrow.down.app"
                                )
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                            }

                            ForEach(visibleItems) { item in
                                SharedTaskInboxCard(
                                    item: item,
                                    canAccept: destinationName != nil
                                )
                            }
                        }
                        .padding(18)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Shared Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }
}

private struct SharedTaskInboxCard: View {
    @Environment(AppModel.self) private var model
    let item: SharedInboxItem
    let canAccept: Bool

    private var detailCount: Int {
        (item.task.subtasks?.count ?? 0) + (item.task.documents?.count ?? 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Label(
                    item.task.isAssignment ? "ASSIGNMENT" : "SHARED TASK",
                    systemImage: item.task.isAssignment ? "person.crop.circle.badge.checkmark" : "paperplane.fill"
                )
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(TaskifyTheme.accent)

                Spacer()

                Text(item.receivedAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(item.task.title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text("From \(item.sender.displayName)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let note = item.task.note, !note.isEmpty {
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(3)
                        .padding(.top, 2)
                }
            }

            HStack(spacing: 12) {
                if let dueDate = item.task.dueDate {
                    Label(
                        dueDate.formatted(
                            date: .abbreviated,
                            time: item.task.dueTimeEnabled == true ? .shortened : .omitted
                        ),
                        systemImage: "calendar"
                    )
                }
                if let priority = item.task.priority.flatMap(TaskPriority.init(rawValue:)) {
                    Label(priority.cardLabel, systemImage: "exclamationmark")
                        .foregroundStyle(priority.cardColor)
                }
                if detailCount > 0 {
                    Label("\(detailCount)", systemImage: "paperclip")
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(TaskifyTheme.tertiaryText)

            if item.status == .pending {
                pendingActions
            } else {
                HStack {
                    Label(statusLabel, systemImage: statusSymbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(statusColor)
                    Spacer()
                    Button("Remove") {
                        withAnimation(.snappy) {
                            model.dismissSharedInboxItem(item.id)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
        }
        .padding(15)
        .taskifyGlass(cornerRadius: 19)
    }

    @ViewBuilder
    private var pendingActions: some View {
        if item.task.isAssignment {
            HStack(spacing: 9) {
                responseButton("Decline", status: .declined, tint: .red)
                responseButton("Maybe", status: .tentative, tint: .orange)
                responseButton("Accept", status: .accepted, tint: TaskifyTheme.accent)
                    .disabled(!canAccept)
            }
        } else {
            HStack(spacing: 9) {
                Button {
                    withAnimation(.snappy) {
                        model.dismissSharedInboxItem(item.id)
                    }
                } label: {
                    Text("Dismiss")
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                }
                .buttonStyle(.bordered)

                responseButton("Add Task", status: .accepted, tint: TaskifyTheme.accent)
                    .disabled(!canAccept)
            }
        }
    }

    private func responseButton(
        _ title: String,
        status: SharedInboxItemStatus,
        tint: Color
    ) -> some View {
        Button {
            withAnimation(.snappy) {
                _ = model.respondToSharedInboxItem(item.id, status: status)
            }
        } label: {
            Text(title)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
    }

    private var statusLabel: String {
        switch item.status {
        case .pending: "Pending"
        case .accepted: "Accepted"
        case .declined: "Declined"
        case .tentative: "Maybe"
        case .deleted: "Removed"
        }
    }

    private var statusSymbol: String {
        switch item.status {
        case .pending: "clock"
        case .accepted: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .deleted: "trash"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .pending: TaskifyTheme.secondaryText
        case .accepted: .green
        case .declined: .red
        case .tentative: .orange
        case .deleted: TaskifyTheme.tertiaryText
        }
    }
}

private struct BoardSortOptionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    let onSelectSort: (UpcomingSortMode) -> Void

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("SORT TASKS BY")
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1)
                        .foregroundStyle(TaskifyTheme.tertiaryText)

                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(UpcomingSortMode.allCases, id: \.rawValue) { mode in
                            Button {
                                onSelectSort(mode)
                            } label: {
                                HStack(spacing: 7) {
                                    Text(mode.label)
                                    if sortMode == mode, mode.supportsDirection {
                                        Image(systemName: sortDirection == .ascending ? "arrow.up" : "arrow.down")
                                    }
                                }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(sortMode == mode ? .white : TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .background(
                                    sortMode == mode ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                    in: Capsule()
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(18)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Sort Board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct BoardUpcomingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let board: Board

    private struct DayGroup: Identifiable {
        let date: Date
        let tasks: [TaskItem]
        var id: Date { date }
    }

    private var scopedBoardIDs: Set<String> {
        if board.kind == .compound {
            return Set(model.compoundChildBoards(for: board.id).map(\.id))
        }
        return [board.id]
    }

    private var groups: [DayGroup] {
        let calendar = Calendar.current
        let tasks = model.upcomingTasks().filter { scopedBoardIDs.contains($0.boardID) }
        let byDate = Dictionary(grouping: tasks) { calendar.startOfDay(for: $0.dueDate ?? Date()) }
        return byDate
            .map { date, tasks in
                DayGroup(
                    date: date,
                    tasks: UpcomingTaskOrganizer.sort(
                        tasks,
                        mode: .dueDate,
                        direction: .ascending,
                        boardGrouping: .mixed,
                        boardOrder: []
                    )
                )
            }
            .sorted { $0.date < $1.date }
    }

    var body: some View {
        NavigationStack {
            Group {
                if groups.isEmpty {
                    ContentUnavailableView(
                        "No upcoming items",
                        systemImage: "calendar",
                        description: Text("Tasks with a due date on \(board.name) will appear here.")
                    )
                    .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(groups) { group in
                                VStack(alignment: .leading, spacing: 9) {
                                    Text(dayLabel(group.date))
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                    ForEach(group.tasks) { task in
                                        TaskCardView(task: task)
                                    }
                                }
                            }
                        }
                        .padding(18)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("\(board.name) Upcoming")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }

    private func dayLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}

private struct FloatingQuickAddBar: View {
    @Binding var draft: String
    var isFocused: FocusState<Bool>.Binding
    let destinationName: String
    let onSubmit: () -> Void
    let onAddButton: () -> Void

    var body: some View {
        TaskifyGlassControlGroup(spacing: 9) {
            HStack(spacing: 9) {
                TextField("New Task", text: $draft)
                    .focused(isFocused)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .onSubmit(onSubmit)
                    .padding(.horizontal, 17)
                    .frame(height: 48)
                    .taskifyGlassControl(
                        in: Capsule(),
                        fallbackFill: Color.black.opacity(0.32)
                    )
                    .accessibilityLabel("New task in \(destinationName)")

                Button(action: onAddButton) {
                    Image(systemName: "plus")
                        .font(.system(size: 19, weight: .bold))
                        .frame(width: 48, height: 48)
                        .foregroundStyle(.white)
                        .taskifyGlassControl(
                            in: Circle(),
                            tint: TaskifyTheme.accent.opacity(0.72),
                            fallbackFill: TaskifyTheme.accent
                        )
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Add task to \(destinationName) and close keyboard")
            }
        }
    }
}

private struct BoardShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let board: Board

    @State private var shareMode = ShareMode.board
    @State private var copied = false
    @State private var templateShare: BoardTemplateShareResult?
    @State private var templateError: String?
    @State private var isGeneratingTemplate = false
    @State private var requestedTemplate = false

    private enum ShareMode: String, CaseIterable, Identifiable {
        case board = "Board"
        case template = "Template"

        var id: String { rawValue }
    }

    private var activeShareBoard: Board? {
        switch shareMode {
        case .board: board
        case .template: templateShare?.board
        }
    }

    private var sharePayload: String? {
        guard let activeShareBoard else { return nil }
        return (try? BoardShareContract.encode(board: activeShareBoard))
            ?? activeShareBoard.effectiveNostrBoardID
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    Picker("Share mode", selection: $shareMode) {
                        ForEach(ShareMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    VStack(spacing: 5) {
                        Label(
                            shareMode == .board ? "Live board" : "Independent copy",
                            systemImage: shareMode == .board
                                ? "arrow.triangle.2.circlepath"
                                : "square.on.square"
                        )
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TaskifyTheme.accent)
                        Text(
                            shareMode == .board
                                ? "Changes remain synced for everyone who joins this board."
                                : "Creates a snapshot with a new board ID. Future changes won't sync between the two boards."
                        )
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .multilineTextAlignment(.center)
                    }

                    if let sharePayload {
                        Button(action: copyBoardID) {
                            VStack(spacing: 11) {
                                TaskifyQRCode(value: sharePayload)
                                    .frame(width: 250, height: 250)
                                    .padding(10)
                                    .background(.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))

                                Label(copied ? "Board ID copied" : "Tap QR to copy board ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(copied ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(copied ? "Board ID copied" : "Copy board ID")
                    } else {
                        VStack(spacing: 14) {
                            if isGeneratingTemplate {
                                ProgressView()
                                    .controlSize(.large)
                                    .tint(TaskifyTheme.accent)
                                Text("Creating a template snapshot…")
                            } else {
                                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                                    .font(.system(size: 34, weight: .medium))
                                Text(templateError ?? "The template isn't ready yet.")
                                Button("Try again", action: generateTemplate)
                                    .buttonStyle(.bordered)
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .multilineTextAlignment(.center)
                        .frame(width: 270, height: 270)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 22).stroke(TaskifyTheme.border, lineWidth: 1))
                    }

                    if let templateShare, shareMode == .template {
                        Label(templateStatus(templateShare), systemImage: templateShare.failedTaskCount == 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(templateShare.failedTaskCount == 0 ? Color.green : Color.orange)
                            .multilineTextAlignment(.center)
                    }

                    if let activeShareBoard {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(shareMode == .board ? "BOARD ID" : "TEMPLATE BOARD ID")
                                .font(.system(size: 10, weight: .bold))
                                .tracking(1.2)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                            Text(activeShareBoard.effectiveNostrBoardID)
                                .font(.caption.monospaced())
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(14)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 17).stroke(TaskifyTheme.border, lineWidth: 1))
                    }

                    if let sharePayload {
                        HStack(spacing: 10) {
                            Button(action: copyBoardID) {
                                Label(copied ? "Copied" : "Copy ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                            }
                            .buttonStyle(.bordered)

                            ShareLink(
                                item: sharePayload,
                                subject: Text(shareSubject),
                                preview: SharePreview(shareSubject)
                            ) {
                                Label("Share", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 48)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Relays")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                        ForEach(board.effectiveRelayURLs, id: \.self) { relay in
                            Label(relay, systemImage: "antenna.radiowaves.left.and.right")
                                .font(.caption.monospaced())
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Share \(board.name)")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: shareMode) { _, mode in
                copied = false
                guard mode == .template,
                      templateShare == nil,
                      !requestedTemplate else { return }
                generateTemplate()
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func copyBoardID() {
        guard let activeShareBoard else { return }
        UIPasteboard.general.string = activeShareBoard.effectiveNostrBoardID
        withAnimation(.snappy) { copied = true }
    }

    private var shareSubject: String {
        shareMode == .board
            ? "Join \(board.name) in Taskify"
            : "Copy \(board.name) in Taskify"
    }

    private func templateStatus(_ result: BoardTemplateShareResult) -> String {
        if result.failedTaskCount > 0 {
            return "Template ready, but \(result.failedTaskCount) task\(result.failedTaskCount == 1 ? "" : "s") could not be added."
        }
        if result.queuedTaskCount == 0 {
            return "Empty template ready to share. Publishing in the background."
        }
        return "Template ready with \(result.queuedTaskCount) task\(result.queuedTaskCount == 1 ? "" : "s"). Publishing in the background."
    }

    private func generateTemplate() {
        guard !isGeneratingTemplate else { return }
        requestedTemplate = true
        templateError = nil
        isGeneratingTemplate = true
        copied = false

        Task { @MainActor in
            do {
                templateShare = try await model.createTemplateShare(for: board.id)
            } catch {
                templateError = error.localizedDescription
            }
            isGeneratingTemplate = false
        }
    }
}

private struct TaskifyQRCode: View {
    let value: String

    private static let context = CIContext()

    var body: some View {
        if let image = image {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
        } else {
            Image(systemName: "qrcode")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.black)
                .padding(35)
        }
    }

    private var image: CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else {
            return nil
        }
        return Self.context.createCGImage(output, from: output.extent)
    }
}

private struct ListBoardView: View {
    let board: Board
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?

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
                        ListColumnView(
                            column: column,
                            showCompleted: showCompleted,
                            sortMode: sortMode,
                            sortDirection: sortDirection
                        )
                            .frame(width: min(330, proxy.size.width - 50))
                            .id(column.id)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned(limitBehavior: .never))
            .scrollPosition(id: $focusedPageID)
            .onAppear(perform: repairFocusedPage)
            .onChange(of: columns.map(\.id)) { _, _ in repairFocusedPage() }
        }
    }

    private func repairFocusedPage() {
        guard !columns.contains(where: { $0.id == focusedPageID }) else { return }
        focusedPageID = columns.first?.id
    }
}

private struct CompoundBoardView: View {
    @Environment(AppModel.self) private var model
    let board: Board
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?

    private var columns: [CompoundColumnReference] {
        model.compoundChildBoards(for: board.id).flatMap { child in
            child.columns
                .sorted {
                    if $0.order != $1.order { return $0.order < $1.order }
                    return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                }
                .map { CompoundColumnReference(board: child, column: $0) }
        }
    }

    var body: some View {
        if columns.isEmpty {
            ContentUnavailableView(
                "No linked lists",
                systemImage: "square.stack.3d.up",
                description: Text("Add list boards to this compound board from Settings.")
            )
            .foregroundStyle(TaskifyTheme.secondaryText)
        } else {
            GeometryReader { proxy in
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 16) {
                        ForEach(columns) { reference in
                            CompoundColumnView(
                                reference: reference,
                                hideBoardName: board.hideChildBoardNames,
                                showCompleted: showCompleted,
                                sortMode: sortMode,
                                sortDirection: sortDirection
                        )
                            .frame(width: min(330, proxy.size.width - 50))
                            .id(reference.id)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 18)
                    .padding(.bottom, 10)
                }
                .scrollIndicators(.hidden)
                .scrollTargetBehavior(.viewAligned(limitBehavior: .never))
                .scrollPosition(id: $focusedPageID)
                .onAppear(perform: repairFocusedPage)
                .onChange(of: columns.map(\.id)) { _, _ in repairFocusedPage() }
            }
        }
    }

    private func repairFocusedPage() {
        guard !columns.contains(where: { $0.id == focusedPageID }) else { return }
        focusedPageID = columns.first?.id
    }
}

private struct CompoundColumnReference: Identifiable {
    let board: Board
    let column: BoardColumn

    var id: String { "\(board.id)::\(column.id)" }
}

private struct CompoundColumnView: View {
    @Environment(AppModel.self) private var model
    let reference: CompoundColumnReference
    let hideBoardName: Bool
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection

    private var tasks: [TaskItem] {
        let raw = model.tasks(
            boardID: reference.board.id,
            columnID: reference.column.id,
            includeCompleted: showCompleted
        )
        guard sortMode != .manual else { return raw }
        return UpcomingTaskOrganizer.sortBoardTasks(raw, mode: sortMode, direction: sortDirection)
    }

    var body: some View {
        let tasks = tasks

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    if !hideBoardName {
                        Text(reference.board.name.uppercased())
                            .font(.system(size: 9, weight: .bold))
                            .tracking(1)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                            .lineLimit(1)
                    }
                    Text(reference.column.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }

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
                        TaskCardView(task: task, allowsDragging: true)
                            .taskDropTarget(
                                boardID: reference.board.id,
                                columnID: reference.column.id,
                                beforeTaskID: task.id,
                                style: .card
                            )
                    }
                }
            }
            .scrollIndicators(.hidden)
            .contentMargins(.bottom, 76, for: .scrollContent)
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
        .taskDropTarget(
            boardID: reference.board.id,
            columnID: reference.column.id,
            style: .column
        )
    }
}

private struct ListColumnView: View {
    @Environment(AppModel.self) private var model
    let column: BoardColumn
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @State private var renameDraft = ""
    @State private var showingRename = false
    @State private var showingDeleteConfirmation = false

    private var tasks: [TaskItem] {
        let raw = model.tasks(forColumnID: column.id, includeCompleted: showCompleted)
        guard sortMode != .manual else { return raw }
        return UpcomingTaskOrganizer.sortBoardTasks(raw, mode: sortMode, direction: sortDirection)
    }

    private var allTasks: [TaskItem] {
        model.tasks(forColumnID: column.id, includeCompleted: true)
    }

    private var orderedColumns: [BoardColumn] {
        guard let board = model.selectedBoard, board.kind == .list else { return [] }
        return board.columns.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var columnIndex: Int? {
        orderedColumns.firstIndex(where: { $0.id == column.id })
    }

    private var moveDestination: BoardColumn? {
        guard let columnIndex else { return nil }
        if columnIndex > 0 { return orderedColumns[columnIndex - 1] }
        let nextIndex = columnIndex + 1
        return orderedColumns.indices.contains(nextIndex) ? orderedColumns[nextIndex] : nil
    }

    var body: some View {
        let tasks = tasks

        return VStack(alignment: .leading, spacing: 10) {
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

                Menu {
                    Button {
                        renameDraft = column.name
                        showingRename = true
                    } label: {
                        Label("Rename list", systemImage: "pencil")
                    }

                    Divider()

                    Button {
                        withAnimation(.snappy) {
                            _ = model.moveListColumn(columnID: column.id, direction: -1)
                        }
                    } label: {
                        Label("Move left", systemImage: "arrow.left")
                    }
                    .disabled(columnIndex == 0)

                    Button {
                        withAnimation(.snappy) {
                            _ = model.moveListColumn(columnID: column.id, direction: 1)
                        }
                    } label: {
                        Label("Move right", systemImage: "arrow.right")
                    }
                    .disabled(columnIndex == nil || columnIndex == orderedColumns.count - 1)

                    Divider()

                    Button(role: .destructive) {
                        showingDeleteConfirmation = true
                    } label: {
                        Label("Delete list", systemImage: "trash")
                    }
                    .disabled(orderedColumns.count <= 1)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 34, height: 34)
                        .background(TaskifyTheme.raisedFill, in: Circle())
                        .contentShape(Circle())
                }
                .accessibilityLabel("Manage \(column.name) list")
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(tasks) { task in
                        TaskCardView(task: task, allowsDragging: true)
                            .taskDropTarget(
                                boardID: model.selectedBoardID,
                                columnID: column.id,
                                beforeTaskID: task.id,
                                style: .card
                            )
                    }
                }
            }
            .scrollIndicators(.hidden)
            .contentMargins(.bottom, 76, for: .scrollContent)
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
        .taskDropTarget(
            boardID: model.selectedBoardID,
            columnID: column.id,
            style: .column
        )
        .alert("Rename list", isPresented: $showingRename) {
            TextField("List name", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                _ = model.renameListColumn(columnID: column.id, name: renameDraft)
            }
            .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("The new name will sync with everyone sharing this board.")
        }
        .confirmationDialog(
            "Delete \(column.name)?",
            isPresented: $showingDeleteConfirmation,
            titleVisibility: .visible
        ) {
            if let moveDestination, !allTasks.isEmpty {
                Button("Move \(taskCountLabel) to \(moveDestination.name)") {
                    _ = model.removeListColumn(
                        columnID: column.id,
                        moveTasksTo: moveDestination.id
                    )
                }
            }

            Button(
                allTasks.isEmpty ? "Delete empty list" : "Delete list and \(taskCountLabel)",
                role: .destructive
            ) {
                _ = model.removeListColumn(columnID: column.id, moveTasksTo: nil)
            }

            Button("Cancel", role: .cancel) {}
        } message: {
            if allTasks.isEmpty {
                Text("This removes the list from the shared board.")
            } else {
                Text("Choose whether to keep its tasks or delete them. This change syncs to everyone sharing the board.")
            }
        }
    }

    private var taskCountLabel: String {
        "\(allTasks.count) task\(allTasks.count == 1 ? "" : "s")"
    }
}

private struct WeekBoardView: View {
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(WeekdayColumn.allCases) { weekday in
                        DayColumnView(
                            weekday: weekday,
                            showCompleted: showCompleted,
                            sortMode: sortMode,
                            sortDirection: sortDirection
                        )
                            .frame(width: min(330, proxy.size.width - 50))
                            .id(weekday.rawValue)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned(limitBehavior: .never))
            .scrollPosition(id: $focusedPageID)
            .onAppear {
                guard WeekdayColumn(rawValue: focusedPageID ?? "") == nil else { return }
                focusedPageID = WeekdayColumn.containing(Date()).rawValue
            }
        }
    }
}

private struct DayColumnView: View {
    @Environment(AppModel.self) private var model
    let weekday: WeekdayColumn
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection

    private var tasks: [TaskItem] {
        let raw = model.tasks(for: weekday, includeCompleted: showCompleted)
        guard sortMode != .manual else { return raw }
        return UpcomingTaskOrganizer.sortBoardTasks(raw, mode: sortMode, direction: sortDirection)
    }

    var body: some View {
        let tasks = tasks

        return VStack(alignment: .leading, spacing: 10) {
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
                        TaskCardView(task: task, allowsDragging: true)
                            .taskDropTarget(
                                boardID: model.selectedBoardID,
                                columnID: weekday.rawValue,
                                beforeTaskID: task.id,
                                style: .card
                            )
                    }
                }
            }
            .scrollIndicators(.hidden)
            .contentMargins(.bottom, 76, for: .scrollContent)
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
        .taskDropTarget(
            boardID: model.selectedBoardID,
            columnID: weekday.rawValue,
            style: .column
        )
    }
}

struct TaskCardView: View {
    @Environment(AppModel.self) private var model
    let task: TaskItem
    let allowsDragging: Bool
    @State private var showingEditor = false
    @State private var showingTaskShare = false
    @State private var taskShareMode: TaskShareMode = .share
    @State private var completionPreview = false
    @State private var completionBurst = false

    init(task: TaskItem, allowsDragging: Bool = false) {
        self.task = task
        self.allowsDragging = allowsDragging
    }

    private var subtaskProgress: String? {
        guard let subtasks = task.subtasks, !subtasks.isEmpty else { return nil }
        return "\(subtasks.filter(\.completed).count)/\(subtasks.count)"
    }

    /// Streaks are tracked for any "frequent" recurrence (daily/weekly, or every N days/weeks —
    /// see `TaskifySnapshot.toggleCompletion`), but only *displayed* for the simple daily/weekly
    /// cases, matching the PWA's narrower badge condition.
    private var visibleStreak: Int? {
        switch task.recurrence {
        case .daily, .weekly:
            break
        default:
            return nil
        }
        guard let streak = task.streak, streak > 0 else { return nil }
        return streak
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

    private var showsCompletedState: Bool {
        task.completed || completionPreview
    }

    var body: some View {
        // Hoisted once per body evaluation: these are all plain computed properties (not
        // memoized by Swift), and several run regex matching over the title/note
        // (`hasMedia`/`displayTitle`/`displayNote` via `TaskContentLinks`). The old code read
        // them directly at each use site, re-running that work up to 7x per row per frame
        // during scroll.
        let hasMedia = hasMedia
        let displayTitle = displayTitle
        let displayNote = displayNote
        let subtaskProgress = subtaskProgress
        let visibleStreak = visibleStreak
        let showsCompletedState = showsCompletedState
        let cardCornerRadius = hasMedia ? CGFloat(24) : 18

        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 11) {
                Button(action: handleCompletionTap) {
                    ZStack {
                        if completionBurst {
                            Circle()
                                .stroke(TaskifyTheme.accent.opacity(0.72), lineWidth: 2)
                                .frame(width: 27, height: 27)
                                .transition(.asymmetric(
                                    insertion: .scale(scale: 0.55).combined(with: .opacity),
                                    removal: .scale(scale: 1.8).combined(with: .opacity)
                                ))
                        }

                        Image(systemName: showsCompletedState ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(showsCompletedState ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                            .contentTransition(.symbolEffect(.replace))
                            .scaleEffect(completionPreview ? 1.12 : 1)
                    }
                    .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .disabled(completionPreview)
                .accessibilityLabel(showsCompletedState ? "Mark incomplete" : "Complete task")

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
                            subtaskProgress != nil || task.recurrence != nil || !(task.reminders ?? []).isEmpty ||
                            !task.sharedTaskAssignees.isEmpty || visibleStreak != nil {
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

                                if let visibleStreak {
                                    Label {
                                        Text("\(visibleStreak)")
                                    } icon: {
                                        Text("\u{1F525}")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                    .accessibilityLabel("\(visibleStreak) \(visibleStreak == 1 ? "completion" : "completions") streak")
                                }

                                if !(task.reminders ?? []).isEmpty {
                                    Image(systemName: "bell.fill")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                        .accessibilityLabel("Reminder set")
                                }

                                if !task.sharedTaskAssignees.isEmpty {
                                    let hasPending = task.sharedTaskAssignees.contains {
                                        $0.status == nil || $0.status == .pending
                                    }
                                    Label(
                                        "\(task.sharedTaskAssignees.count)",
                                        systemImage: hasPending ? "person.badge.clock" : "person.badge.checkmark"
                                    )
                                    .font(.caption)
                                    .foregroundStyle(hasPending ? TaskifyTheme.secondaryText : TaskifyTheme.accent)
                                    .accessibilityLabel(
                                        "\(task.sharedTaskAssignees.count) assignee\(task.sharedTaskAssignees.count == 1 ? "" : "s")"
                                    )
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Edit \(displayTitle)")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .zIndex(1)

            if hasMedia {
                TaskMediaView(task: task, boardID: mediaBoardID, compact: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .clipped()
                    .contentShape(Rectangle())
                    .zIndex(0)
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
        .modifier(TaskDragSourceModifier(
            payload: allowsDragging ? TaskDragPayload(taskID: task.id) : nil,
            title: displayTitle
        ))
        .accessibilityAction(named: "Edit task") { showingEditor = true }
        .contextMenu {
            Button {
                showingEditor = true
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button {
                taskShareMode = .share
                showingTaskShare = true
            } label: {
                Label("Share Task", systemImage: "paperplane")
            }
            Button {
                taskShareMode = .assignment
                showingTaskShare = true
            } label: {
                Label("Assign Task", systemImage: "person.badge.plus")
            }
            if task.dueDateEnabled, task.dueDate != nil {
                Button {
                    model.postponeTask(task.id, byDays: 1)
                } label: {
                    Label("Postpone 1 Day", systemImage: "calendar.badge.clock")
                }
                Button {
                    model.postponeTask(task.id, byDays: 7)
                } label: {
                    Label("Postpone 1 Week", systemImage: "calendar.badge.clock")
                }
            }
            Button(role: .destructive) {
                model.deleteTask(task.id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .sheet(isPresented: $showingEditor) {
            TaskEditorView(task: task)
                .environment(model)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingTaskShare) {
            TaskShareSheet(taskID: task.id, initialMode: taskShareMode)
                .environment(model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func handleCompletionTap() {
        if task.completed {
            withAnimation(.snappy) {
                model.toggleCompletion(task.id)
            }
            return
        }

        guard !completionPreview else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)

        withAnimation(.spring(response: 0.28, dampingFraction: 0.58)) {
            completionPreview = true
            completionBurst = true
        }

        Task { @MainActor in
            do {
                try await Task.sleep(for: .milliseconds(140))
            } catch {
                return
            }
            withAnimation(.easeOut(duration: 0.28)) {
                completionBurst = false
            }

            do {
                try await Task.sleep(for: .milliseconds(260))
            } catch {
                return
            }
            if model.task(withID: task.id)?.completed == false {
                withAnimation(.snappy) {
                    model.toggleCompletion(task.id)
                }
            }
            completionPreview = false
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
