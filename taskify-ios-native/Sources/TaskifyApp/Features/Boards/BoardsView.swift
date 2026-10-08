import CoreImage
import CoreImage.CIFilterBuiltins
import CoreTransferable
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers


struct BoardsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("taskify.board.sort.mode") private var sortModeRaw = UpcomingSortMode.manual.rawValue
    @AppStorage("taskify.board.sort.direction") private var sortDirectionRaw = UpcomingSortDirection.ascending.rawValue
    @AppStorage(TaskPresentationSettings.completedTabKey)
    private var completedTabEnabled = TaskPresentationSettings.completedTabDefault
    @State private var showCompleted = false
    @State private var showingAddBoard = false
    @State private var showingAddList = false
    @State private var showingBoardShare = false
    @State private var showBoardUpcoming = false
    @State private var showingSortOptions = false
    @State private var showingClearCompletedConfirmation = false
    @State private var showingSelectionMoveSheet = false
    @State private var showingVoiceDictation = false
    @State private var detailedTaskDraft: TaskItem?
    @State private var physicalChecklistJob: PhysicalChecklistJob?
    /// Raised by a quick-add deep link from a widget or the Control Center button. Cleared as soon
    /// as the field takes focus so a later return to Boards doesn't pop the keyboard again.
    @Binding var focusQuickAdd: Bool
    /// A configurable Board widget can target a particular list. This is consumed together with
    /// `focusQuickAdd`, after the board transition has settled, so resetFocusedPage cannot replace
    /// the requested list before the field appears.
    @Binding var quickAddColumnID: String?
    @State private var newListName = ""
    @State private var quickTaskDraft = ""
    @State private var focusedPageID: String?
    @State private var selection = TaskSelectionController()
    @State private var completionAnimations = TaskCompletionAnimationController()
    @FocusState private var quickTaskFieldIsFocused: Bool
    /// The quick-add field is a UIKit text field, which a FocusState write alone cannot reach;
    /// bumping this asks it to become first responder.
    @State private var quickAddFocusRequest = 0

    private var sortMode: UpcomingSortMode {
        UpcomingSortMode(rawValue: sortModeRaw) ?? .manual
    }

    private var sortDirection: UpcomingSortDirection {
        UpcomingSortDirection(rawValue: sortDirectionRaw) ?? sortMode.defaultDirection
    }

    private var completedTasksAreVisible: Bool {
        model.selectedBoard?.kind == .bible ? showCompleted : !completedTabEnabled
    }

    private var hasCompletedTasks: Bool {
        guard let boardID = model.selectedBoard?.id else { return false }
        return model.completedTaskCount(forBoardID: boardID) > 0
    }

    var body: some View {
        VStack(spacing: 10) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 6)

            boardContent
                .environment(selection)
                .environment(completionAnimations)
        }
        .coordinateSpace(name: TaskCompletionFlightCoordinateSpace.name)
        .onPreferenceChange(TaskCompletionDestinationPreferenceKey.self) { destination in
            completionAnimations.destination = destination
        }
        .overlay {
            TaskCompletionFlightLayer(controller: completionAnimations)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .overlay(alignment: .bottom) {
            if selection.isActive {
                SelectionActionBar(
                    selection: selection,
                    onMove: { showingSelectionMoveSheet = true },
                    onPrint: {
                        physicalChecklistJob = makeBoardPrintJob(taskIDs: selection.selectedTaskIDs)
                        selection.exit()
                    },
                    onComplete: {
                        model.completeTasks(selection.selectedTaskIDs)
                        selection.exit()
                    },
                    onDelete: {
                        model.deleteTasks(selection.selectedTaskIDs)
                        model.deleteTaskifyEvents(selection.selectedEventIDs)
                        selection.exit()
                    }
                )
                .frame(maxWidth: 720)
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let quickAddDestination {
                FloatingQuickAddBar(
                    draft: $quickTaskDraft,
                    isFocused: $quickTaskFieldIsFocused,
                    focusRequest: quickAddFocusRequest,
                    destinationName: quickAddDestination.displayName,
                    onSubmit: { addQuickTask(dismissKeyboard: false) },
                    onAddButton: { addQuickTask(dismissKeyboard: true) },
                    onVoice: {
                        quickTaskFieldIsFocused = false
                        showingVoiceDictation = true
                    }
                )
                .frame(maxWidth: 720)
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(isPresented: $showingVoiceDictation) {
            VoiceDictationSheet()
                .environment(model)
        }
        .sheet(item: $detailedTaskDraft) { draft in
            TaskEditorView(draft: draft)
                .environment(model)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $physicalChecklistJob) { job in
            PhysicalChecklistSheet(job: job) { scannedIDs in
                model.completeTasks(scannedIDs)
            }
        }
        .sheet(isPresented: $showingAddBoard) {
            BoardAddSheet()
                .environment(model)
        }
        .sheet(isPresented: $showingSelectionMoveSheet) {
            SelectionMoveSheet(selection: selection) {
                selection.exit()
            }
            .environment(model)
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
                BoardShareSheet(board: board) {
                    physicalChecklistJob = makeBoardPrintJob()
                }
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
        .onAppear(perform: TaskCompletionHaptics.warmUp)
        .onChange(of: focusQuickAdd, initial: true) { _, requested in
            guard requested else { return }
            // A beat after the tab switch: focusing while the view is still appearing gets
            // dropped, and the keyboard never comes up.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                if let requestedColumnID = quickAddColumnID,
                   model.selectedBoard?.columns.contains(where: { $0.id == requestedColumnID }) == true {
                    focusedPageID = requestedColumnID
                }
                quickAddColumnID = nil
                quickTaskFieldIsFocused = true
                quickAddFocusRequest += 1
                focusQuickAdd = false
            }
        }
        .onChange(of: model.selectedBoardID) { _, _ in
            selection.exit()
            completionAnimations.reset()
            showBoardUpcoming = false
            quickTaskDraft = ""
            quickTaskFieldIsFocused = false
            resetFocusedPage()
        }
        // Keyed on the snapshot revision rather than on the id sets themselves: comparing those
        // meant building a set of every event id and hashing all ~500 task ids on *every* body
        // evaluation, including the ones a horizontal page change triggers, when the ids can only
        // have moved if the snapshot was written.
        .onChange(of: model.snapshotRevision) { _, _ in
            guard selection.isActive, !selection.isEmpty else { return }
            selection.retainOnlyTasks(model.activeTaskIDs)
            selection.retainOnlyEvents(model.taskifyEventIDs)
        }
        .onChange(of: completedTabEnabled) { _, enabled in
            showCompleted = false
            if !enabled {
                completionAnimations.destination = nil
            }
        }
    }

    @ViewBuilder
    private var boardContent: some View {
        if completedTabEnabled,
           showCompleted,
           let board = model.selectedBoard,
           board.kind != .bible {
            BoardCompletedView(
                board: board,
                onClear: { showingClearCompletedConfirmation = true }
            )
        } else if showBoardUpcoming,
           let board = model.selectedBoard,
           board.kind != .bible {
            BoardUpcomingView(board: board)
        } else {
            switch model.selectedBoard?.kind {
            case .week:
                WeekBoardView(
                    showCompleted: completedTasksAreVisible,
                    sortMode: sortMode,
                    sortDirection: sortDirection,
                    focusedPageID: $focusedPageID
                )
            case .list:
                if let board = model.selectedBoard {
                    ListBoardView(
                        board: board,
                        showCompleted: completedTasksAreVisible,
                        sortMode: sortMode,
                        sortDirection: sortDirection,
                        focusedPageID: $focusedPageID,
                        onAddList: { showingAddList = true }
                    )
                }
            case .compound:
                if let board = model.selectedBoard {
                    CompoundBoardView(
                        board: board,
                        showCompleted: completedTasksAreVisible,
                        sortMode: sortMode,
                        sortDirection: sortDirection,
                        focusedPageID: $focusedPageID
                    )
                }
            case .bible:
                BibleTrackerView(store: model.bibleTrackerStore, showCompletedBooks: showCompleted)
            case nil:
                ContentUnavailableView("No board selected", systemImage: "square.grid.2x2")
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
    }

    private var quickAddDestination: BoardQuickAddDestination? {
        guard !showBoardUpcoming else { return nil }
        guard !completedTabEnabled || !showCompleted else { return nil }
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

    private func dismissQuickTaskKeyboard() {
        quickTaskFieldIsFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private func addQuickTask(dismissKeyboard: Bool) {
        guard let quickAddDestination else { return }
        let title = quickTaskDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            guard dismissKeyboard else { return }
            dismissQuickTaskKeyboard()
            detailedTaskDraft = makeDetailedTaskDraft(for: quickAddDestination)
            return
        }

        quickTaskDraft = ""
        if dismissKeyboard {
            dismissQuickTaskKeyboard()
        }

        if let weekday = quickAddDestination.weekday {
            model.addQuickTask(title: title, weekday: weekday)
        } else {
            model.addQuickTask(
                title: title,
                boardID: quickAddDestination.boardID,
                columnID: quickAddDestination.columnID
            )
        }
    }

    private func makeDetailedTaskDraft(
        for destination: BoardQuickAddDestination
    ) -> TaskItem {
        let dueDate = destination.weekday.map {
            WeekDateResolver.date(
                for: $0,
                inWeekContaining: Date(),
                weekStartsOn: model.weekStart
            )
        }
        return TaskItem(
            boardID: destination.boardID,
            title: "",
            dueDate: dueDate,
            dueDateEnabled: dueDate != nil,
            columnID: destination.columnID
        )
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

                        Divider()

                        Button {
                            showingAddBoard = true
                        } label: {
                            Label("Add or join board", systemImage: "plus")
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

                if completedTabEnabled || model.selectedBoard?.kind == .bible {
                    HeaderIconButton(
                        systemName: showCompleted ? "checkmark.circle.fill" : "checkmark",
                        accent: showCompleted,
                        accessibilityLabel: showCompleted ? "Hide completed tasks" : "Show completed tasks"
                    ) {
                        withAnimation(.snappy) {
                            showBoardUpcoming = false
                            showCompleted.toggle()
                        }
                    }
                    .background {
                        GeometryReader { proxy in
                            let frame = proxy.frame(in: .named(TaskCompletionFlightCoordinateSpace.name))
                            Color.clear.preference(
                                key: TaskCompletionDestinationPreferenceKey.self,
                                value: CGPoint(x: frame.midX, y: frame.midY)
                            )
                        }
                    }
                    .contextMenu {
                        if showCompleted,
                           model.selectedBoard?.kind != .bible,
                           model.selectedBoard?.clearCompletedDisabled == false {
                            Button(role: .destructive) {
                                showingClearCompletedConfirmation = true
                            } label: {
                                Label("Clear completed tasks", systemImage: "trash")
                            }
                        }
                    }
                } else if model.selectedBoard?.clearCompletedDisabled == false {
                    HeaderIconButton(
                        systemName: "trash",
                        accessibilityLabel: "Clear completed tasks"
                    ) {
                        showingClearCompletedConfirmation = true
                    }
                    .disabled(!hasCompletedTasks)
                    .opacity(hasCompletedTasks ? 1 : 0.42)
                }

                if model.selectedBoard?.kind != .bible {
                    HeaderIconButton(
                        systemName: "calendar",
                        accent: showBoardUpcoming,
                        accessibilityLabel: showBoardUpcoming ? "Show board" : "Show board upcoming"
                    ) {
                        selection.exit()
                        withAnimation(.snappy) {
                            showCompleted = false
                            showBoardUpcoming.toggle()
                        }
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
            }
        }
    }

    private func makeBoardPrintJob(taskIDs: Set<String>? = nil) -> PhysicalChecklistJob? {
        guard let board = model.selectedBoard, board.kind != .bible else { return nil }
        let rows: [(task: TaskItem, section: String)]

        if let taskIDs {
            rows = taskIDs.compactMap { taskID in
                guard let task = model.task(withID: taskID), !task.completed, !task.isDeleted else { return nil }
                return (task, printSection(for: task, selectedBoard: board))
            }
            .sorted {
                if $0.section != $1.section {
                    return $0.section.localizedStandardCompare($1.section) == .orderedAscending
                }
                return $0.task.order < $1.task.order
            }
        } else {
            let boards = board.kind == .compound ? model.compoundChildBoards(for: board.id) : [board]
            rows = boards.flatMap { scopedBoard in
                scopedBoard.columns.sorted { $0.order < $1.order }.flatMap { column in
                    model.tasks(
                        boardID: scopedBoard.id,
                        columnID: column.id,
                        includeCompleted: false
                    ).map { task in
                        let section = board.kind == .compound
                            ? "\(scopedBoard.name) — \(column.name)"
                            : column.name
                        return (task, section)
                    }
                }
            }
        }

        guard !rows.isEmpty else { return nil }
        return PhysicalChecklistJob(
            ownerID: "board:\(board.id)",
            title: board.name,
            items: rows.map {
                PhysicalChecklistItem(id: $0.task.id, title: $0.task.title, section: $0.section)
            }
        )
    }

    private func printSection(for task: TaskItem, selectedBoard: Board) -> String {
        let board = model.visibleBoards.first(where: { $0.id == task.boardID }) ?? selectedBoard
        let column = board.columns.first(where: { $0.id == task.columnID })?.name ?? "Tasks"
        return selectedBoard.kind == .compound ? "\(board.name) — \(column)" : column
    }
}
