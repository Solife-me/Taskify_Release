import SwiftUI
import TaskifyCore
import UIKit

/// A jump-to-list navigation card shown as the leading page in a list/compound board's
/// horizontal column scroller, matching the PWA's opt-in "Index" card. It participates in the
/// same view-aligned paging as the columns it lets you jump to.
struct IndexCardEntry: Identifiable {
    let id: String
    let title: String
}

struct IndexCardGroup: Identifiable {
    let id: String
    let title: String?
    let entries: [IndexCardEntry]
}

struct IndexCardColumnView: View {
    let groups: [IndexCardGroup]
    @Binding var focusedPageID: String?

    private var flatEntries: [IndexCardEntry] {
        groups.flatMap(\.entries)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Index")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)

            if flatEntries.isEmpty {
                Text("No lists yet.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(groups) { group in
                            if let title = group.title {
                                Text(title.uppercased())
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                                    .padding(.top, group.id == groups.first?.id ? 0 : 6)
                                    .padding(.horizontal, 4)
                            }
                            ForEach(group.entries) { entry in
                                indexEntryButton(entry)
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .padding(10)
        .taskifyGlass(cornerRadius: 22)
    }

    private func indexEntryButton(_ entry: IndexCardEntry) -> some View {
        let order = (flatEntries.firstIndex(where: { $0.id == entry.id }) ?? 0) + 1
        let isActive = focusedPageID == entry.id
        return Button {
            withAnimation(.snappy) {
                focusedPageID = entry.id
            }
        } label: {
            HStack {
                Text(entry.title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                Text("\(order)")
                    .font(.caption)
            }
            .foregroundStyle(isActive ? TaskifyTheme.primaryText : TaskifyTheme.secondaryText)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isActive ? TaskifyTheme.accent.opacity(0.15) : TaskifyTheme.raisedFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(isActive ? TaskifyTheme.accent.opacity(0.6) : TaskifyTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

let indexCardPageID = "board-index-card"

struct ListBoardView: View {
    let board: Board
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?
    let onAddList: () -> Void

    private var columns: [BoardColumn] {
        board.columns.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var indexGroups: [IndexCardGroup] {
        [IndexCardGroup(
            id: indexCardPageID,
            title: nil,
            entries: columns.map { IndexCardEntry(id: $0.id, title: $0.name) }
        )]
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    if board.indexCardEnabled {
                        IndexCardColumnView(groups: indexGroups, focusedPageID: $focusedPageID)
                            .frame(width: boardColumnWidth(in: proxy.size.width))
                            .id(indexCardPageID)
                    }
                    ForEach(columns) { column in
                        ListColumnView(
                            column: column,
                            showCompleted: showCompleted,
                            sortMode: sortMode,
                            sortDirection: sortDirection,
                            onAddList: onAddList
                        )
                            .frame(width: boardColumnWidth(in: proxy.size.width))
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
            .horizontalTaskDragAutoScroll(
                pageIDs: columns.map(\.id),
                focusedPageID: $focusedPageID,
                viewportWidth: proxy.size.width
            )
            .onAppear(perform: repairFocusedPage)
            .onChange(of: columns.map(\.id)) { _, _ in repairFocusedPage() }
        }
    }

    private func repairFocusedPage() {
        if board.indexCardEnabled && focusedPageID == indexCardPageID { return }
        guard !columns.contains(where: { $0.id == focusedPageID }) else { return }
        focusedPageID = columns.first?.id
    }
}

struct CompoundBoardView: View {
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

    private var indexGroups: [IndexCardGroup] {
        var groups: [IndexCardGroup] = []
        var groupIndexByBoardID: [String: Int] = [:]
        for reference in columns {
            let entry = IndexCardEntry(id: reference.id, title: reference.column.name)
            if let index = groupIndexByBoardID[reference.board.id] {
                groups[index] = IndexCardGroup(
                    id: groups[index].id,
                    title: groups[index].title,
                    entries: groups[index].entries + [entry]
                )
            } else {
                groupIndexByBoardID[reference.board.id] = groups.count
                groups.append(IndexCardGroup(
                    id: reference.board.id,
                    title: board.hideChildBoardNames ? nil : reference.board.name,
                    entries: [entry]
                ))
            }
        }
        return groups
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
                        if board.indexCardEnabled {
                            IndexCardColumnView(groups: indexGroups, focusedPageID: $focusedPageID)
                                .frame(width: boardColumnWidth(in: proxy.size.width))
                                .id(indexCardPageID)
                        }
                        ForEach(columns) { reference in
                            CompoundColumnView(
                                reference: reference,
                                hideBoardName: board.hideChildBoardNames,
                                showCompleted: showCompleted,
                                sortMode: sortMode,
                                sortDirection: sortDirection
                        )
                            .frame(width: boardColumnWidth(in: proxy.size.width))
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
                .horizontalTaskDragAutoScroll(
                    pageIDs: columns.map(\.id),
                    focusedPageID: $focusedPageID,
                    viewportWidth: proxy.size.width
                )
                .onAppear(perform: repairFocusedPage)
                .onChange(of: columns.map(\.id)) { _, _ in repairFocusedPage() }
            }
        }
    }

    private func repairFocusedPage() {
        if board.indexCardEnabled && focusedPageID == indexCardPageID { return }
        guard !columns.contains(where: { $0.id == focusedPageID }) else { return }
        focusedPageID = columns.first?.id
    }
}

struct CompoundColumnReference: Identifiable {
    let board: Board
    let column: BoardColumn

    var id: String { "\(board.id)::\(column.id)" }
}

struct CompoundColumnView: View {
    @Environment(AppModel.self) private var model
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    let reference: CompoundColumnReference
    let hideBoardName: Bool
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection

    private var tasks: [TaskItem] {
        model.tasks(
            boardID: reference.board.id,
            columnID: reference.column.id,
            includeCompleted: showCompleted,
            sortMode: sortMode,
            sortDirection: sortDirection
        )
    }

    private var events: [TaskifyEvent] {
        model.boardEvents(boardID: reference.board.id, columnID: reference.column.id)
    }

    var body: some View {
        let tasks = tasks
        let events = events

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

                Text("\(tasks.count + events.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(TaskifyTheme.raisedFill, in: Capsule())

                Menu {
                    Button {
                        withAnimation(.snappy) {
                            if selection?.isActive == true {
                                selection?.exit()
                            } else {
                                selection?.enter()
                            }
                        }
                    } label: {
                        Label(
                            selection?.isActive == true ? "Exit selection" : "Select items",
                            systemImage: selection?.isActive == true ? "xmark.circle" : "checklist"
                        )
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 34, height: 34)
                        .background(TaskifyTheme.raisedFill, in: Circle())
                        .contentShape(Circle())
                }
                .accessibilityLabel("Manage \(reference.column.name) list")
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(events) { event in
                        TaskifyEventCard(event: event, showDate: true, allowsSelection: true)
                    }
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
                .immediateScrollTouchDelivery()
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
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

struct ListColumnView: View {
    @Environment(AppModel.self) private var model
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    let column: BoardColumn
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    let onAddList: () -> Void
    @State private var renameDraft = ""
    @State private var showingRename = false
    @State private var showingDeleteConfirmation = false

    private var tasks: [TaskItem] {
        model.tasks(forColumnID: column.id, includeCompleted: showCompleted, sortMode: sortMode, sortDirection: sortDirection)
    }

    private var events: [TaskifyEvent] {
        model.boardEvents(boardID: model.selectedBoardID, columnID: column.id)
    }

    private var allTasks: [TaskItem] {
        model.tasks(forColumnID: column.id, includeCompleted: true)
    }

    private var allEvents: [TaskifyEvent] {
        model.taskifyEvents.filter {
            $0.boardID == model.selectedBoardID && $0.columnID == column.id
        }
    }

    private var allItemsAreEmpty: Bool { allTasks.isEmpty && allEvents.isEmpty }

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
        let events = events

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(column.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                Text("\(tasks.count + events.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(TaskifyTheme.raisedFill, in: Capsule())

                Menu {
                    Button {
                        withAnimation(.snappy) {
                            if selection?.isActive == true {
                                selection?.exit()
                            } else {
                                selection?.enter()
                            }
                        }
                    } label: {
                        Label(
                            selection?.isActive == true ? "Exit selection" : "Select items",
                            systemImage: selection?.isActive == true ? "xmark.circle" : "checklist"
                        )
                    }

                    Divider()

                    Button(action: onAddList) {
                        Label("Add list", systemImage: "rectangle.stack.badge.plus")
                    }

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
                    ForEach(events) { event in
                        TaskifyEventCard(event: event, showDate: true, allowsSelection: true)
                    }
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
                .immediateScrollTouchDelivery()
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
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
            if let moveDestination, !allItemsAreEmpty {
                Button("Move \(itemCountLabel) to \(moveDestination.name)") {
                    _ = model.removeListColumn(
                        columnID: column.id,
                        moveTasksTo: moveDestination.id
                    )
                }
            }

            Button(
                allItemsAreEmpty ? "Delete empty list" : "Delete list and \(itemCountLabel)",
                role: .destructive
            ) {
                _ = model.removeListColumn(columnID: column.id, moveTasksTo: nil)
            }

            Button("Cancel", role: .cancel) {}
        } message: {
            if allItemsAreEmpty {
                Text("This removes the list from the shared board.")
            } else {
                Text("Choose whether to keep its items or delete them. This change syncs to everyone sharing the board.")
            }
        }
    }

    private var itemCountLabel: String {
        let count = allTasks.count + allEvents.count
        return "\(count) item\(count == 1 ? "" : "s")"
    }
}

struct WeekBoardView: View {
    @Environment(AppModel.self) private var model
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    @Binding var focusedPageID: String?

    private var orderedWeekdays: [WeekdayColumn] {
        WeekdayColumn.ordered(startingAt: model.weekStart)
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(orderedWeekdays) { weekday in
                        DayColumnView(
                            weekday: weekday,
                            showCompleted: showCompleted,
                            sortMode: sortMode,
                            sortDirection: sortDirection
                        )
                            .frame(width: boardColumnWidth(in: proxy.size.width))
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
            .horizontalTaskDragAutoScroll(
                pageIDs: orderedWeekdays.map(\.rawValue),
                focusedPageID: $focusedPageID,
                viewportWidth: proxy.size.width
            )
            .onAppear {
                guard WeekdayColumn(rawValue: focusedPageID ?? "") == nil else { return }
                focusedPageID = WeekdayColumn.containing(Date()).rawValue
            }
        }
    }
}

struct DayColumnView: View {
    @Environment(AppModel.self) private var model
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    let weekday: WeekdayColumn
    let showCompleted: Bool
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection

    private var tasks: [TaskItem] {
        model.tasks(for: weekday, includeCompleted: showCompleted, sortMode: sortMode, sortDirection: sortDirection)
    }

    private var events: [TaskifyEvent] {
        model.boardEvents(boardID: model.selectedBoardID, columnID: weekday.rawValue, weekday: weekday)
    }

    var body: some View {
        let tasks = tasks
        let events = events

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(weekday.shortName)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                Menu {
                    Button {
                        withAnimation(.snappy) {
                            if selection?.isActive == true {
                                selection?.exit()
                            } else {
                                selection?.enter()
                            }
                        }
                    } label: {
                        Label(
                            selection?.isActive == true ? "Exit selection" : "Select items",
                            systemImage: selection?.isActive == true ? "xmark.circle" : "checklist"
                        )
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(width: 30, height: 30)
                }
            }

            ScrollView {
                LazyVStack(spacing: 9) {
                    ForEach(events) { event in
                        TaskifyEventCard(event: event, allowsSelection: true)
                    }
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
                .immediateScrollTouchDelivery()
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
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
    // Optional: only Boards' own board content injects a TaskSelectionController (via
    // `.environment(selection)` in BoardsView.body). TaskCardView is also used from Upcoming and
    // a couple of other spots that never enter selection mode, so this must tolerate being nil
    // rather than requiring every call site to provide one.
    @Environment(TaskSelectionController.self) private var selection: TaskSelectionController?
    @Environment(TaskCompletionAnimationController.self)
    private var completionAnimations: TaskCompletionAnimationController?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.taskifyOverPhoto) private var overPhoto
    @AppStorage(TaskPresentationSettings.completedTabKey)
    private var completedTabEnabled = TaskPresentationSettings.completedTabDefault
    @AppStorage(TaskPresentationSettings.hideCompletedSubtasksKey)
    private var hideCompletedSubtasks = TaskPresentationSettings.hideCompletedSubtasksDefault
    let task: TaskItem
    let allowsDragging: Bool
    @State private var showingEditor = false
    @State private var showingTaskShare = false
    @State private var taskShareMode: TaskShareMode = .share
    @State private var confirmingRecurringDeletion = false

    init(task: TaskItem, allowsDragging: Bool = false) {
        self.task = task
        self.allowsDragging = allowsDragging
    }

    private var subtaskProgress: String? {
        guard let subtasks = task.subtasks, !subtasks.isEmpty else { return nil }
        return "\(subtasks.filter(\.completed).count)/\(subtasks.count)"
    }

    private var visibleSubtasks: [TaskSubtask] {
        let subtasks = task.subtasks ?? []
        return hideCompletedSubtasks ? subtasks.filter { !$0.completed } : subtasks
    }

    /// Streaks are tracked for any "frequent" recurrence (daily/weekly, or every N days/weeks —
    /// see `TaskifySnapshot.toggleCompletion`), but only *displayed* for the simple daily/weekly
    /// cases, matching the PWA's narrower badge condition.
    private var visibleStreak: Int? {
        guard model.streaksEnabled else { return nil }
        switch task.recurrence {
        case .daily, .weekly:
            break
        default:
            return nil
        }
        let streak = model.runningStreak(for: task)
        guard streak > 0 else { return nil }
        return streak
    }

    private var mediaBoardID: String {
        model.board(withID: task.boardID)?.effectiveNostrBoardID ?? task.boardID
    }

    private var cardText: TaskCardTextCache.Derived {
        TaskCardTextCache.derived(title: task.title, note: task.note)
    }

    private var hasMedia: Bool {
        !(task.images ?? []).isEmpty ||
            !(task.documents ?? []).isEmpty ||
            cardText.hasLink
    }

    private var displayTitle: String { cardText.displayTitle }

    private var displayNote: String { cardText.displayNote }

    var body: some View {
        // Hoisted once per body evaluation: these are all plain computed properties (not
        // memoized by Swift). The link-derived text goes through `TaskCardTextCache` so the
        // regex work behind it happens once per distinct title/note rather than once per body
        // evaluation; reading it once here keeps that to a single cache lookup per row.
        let cardText = cardText
        let hasMedia = !(task.images ?? []).isEmpty
            || !(task.documents ?? []).isEmpty
            || cardText.hasLink
        let displayTitle = cardText.displayTitle
        let displayNote = cardText.displayNote
        let subtaskProgress = subtaskProgress
        let visibleSubtasks = visibleSubtasks
        let visibleStreak = visibleStreak
        let cardCornerRadius = hasMedia ? CGFloat(24) : 18
        let isSelectionMode = selection?.isActive ?? false
        let isSelected = selection?.selectedTaskIDs.contains(task.id) ?? false

        TaskifyPerfMonitor.shared.recordCardBody()

        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 11) {
                GeometryReader { proxy in
                    Button {
                        if isSelectionMode {
                            selection?.toggle(task.id)
                        } else {
                            // Touch-up, and the only path VoiceOver takes. Deduplicated against
                            // the touch-down fire inside `handleCompletionTap`.
                            handleCompletionTap(origin: proxy.flightOrigin)
                        }
                    } label: {
                        Image(systemName: isSelectionMode
                            ? (isSelected ? "checkmark.circle.fill" : "circle")
                            : (task.completed ? "checkmark.circle.fill" : "circle"))
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle((isSelectionMode ? isSelected : task.completed)
                                ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                            .contentTransition(.symbolEffect(.replace))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(TaskCompletionToggleButtonStyle {
                        handleCompletionPressDown(origin: proxy.flightOrigin,
                                                  isSelectionMode: isSelectionMode)
                    })
                    .accessibilityLabel(isSelectionMode
                        ? (isSelected ? "Deselect task" : "Select task")
                        : (task.completed ? "Mark incomplete" : "Complete task"))
                }
                .frame(width: 30, height: 30)

                Button {
                    if isSelectionMode {
                        selection?.toggle(task.id)
                    } else {
                        showingEditor = true
                    }
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
                                        Text(formattedDueDate(dueDate))
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
                    // Text only — the media thumbnails stay outside this subtree, so the shadow's
                    // offscreen pass covers glyphs rather than the whole row.
                    .taskifyLegibilityShadow(overPhoto)
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

            if !visibleSubtasks.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(visibleSubtasks) { subtask in
                        Button {
                            TaskCompletionHaptics.subtaskToggled()
                            model.toggleSubtaskCompletion(
                                taskID: task.id,
                                subtaskID: subtask.id
                            )
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: subtask.completed ? "checkmark.square.fill" : "square")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(
                                        subtask.completed
                                            ? TaskifyTheme.accent
                                            : TaskifyTheme.secondaryText
                                    )
                                    .contentTransition(.symbolEffect(.replace))

                                Text(subtask.title)
                                    .font(.caption)
                                    .foregroundStyle(
                                        subtask.completed
                                            ? TaskifyTheme.tertiaryText
                                            : TaskifyTheme.secondaryText
                                    )
                                    .strikethrough(subtask.completed)
                                    .multilineTextAlignment(.leading)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            subtask.completed
                                ? "Mark \(subtask.title) incomplete"
                                : "Complete \(subtask.title)"
                        )
                    }
                }
                // Caption-sized secondary text is the first thing a photo washes out, and the
                // unchecked box is a hairline square in the same colour.
                .taskifyLegibilityShadow(overPhoto)
                .padding(.leading, 41)
                .padding(.trailing, 3)
            }
        }
        .allowsHitTesting(!isSelectionMode)
        .padding(.horizontal, hasMedia ? 10 : 13)
        .padding(.vertical, hasMedia ? 10 : 12)
        // The drop shadow hangs on the background shape rather than on the card as a whole.
        // A `.shadow` applied to the finished card makes the renderer resolve the entire row —
        // text, badges, thumbnails — into an offscreen buffer just to derive the shadow's alpha,
        // once per card per frame. With a column's worth of rows on screen (and two or three
        // columns in flight during a horizontal swipe) that was the bulk of the paging cost.
        // The silhouette is the rounded rectangle either way, so this renders the same.
        .background(
            ZStack {
                // Alone among the app's cards, a task card carries no material — just a white
                // sheen over whatever is behind it. On the standard gradient that reads as glass
                // because the gradient is already dark; over a photo it is a clear pane, so a
                // bright sky or a hard light/shadow edge lands directly under the text.
                //
                // The blur is what fixes that, not a tint: it flattens the backdrop's local
                // contrast so the card has a smooth base wherever it sits, while still showing
                // the photo's colour through. This is the same recipe as `GlassPanel`, which is
                // why event cards on the same screen already held up where task cards did not.
                if overPhoto, !TaskifyPerfMonitor.cardMaterialDisabled {
                    RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
                        .fill(.ultraThinMaterial)
                }

                RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.13), Color.white.opacity(0.035)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            }
            .shadow(color: Color.black.opacity(0.22), radius: 8, y: 5)
        )
        .overlay(
            RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous)
                .stroke(
                    isSelected
                        ? TaskifyTheme.accent
                        : Color.white.opacity(overPhoto ? 0.22 : (hasMedia ? 0.15 : 0.12)),
                    lineWidth: isSelected ? 2 : 1
                )
        )
        .overlay {
            if isSelectionMode {
                Button {
                    selection?.toggle(task.id)
                } label: {
                    Color.clear
                        .contentShape(RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isSelected ? "Deselect \(displayTitle)" : "Select \(displayTitle)")
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: cardCornerRadius, style: .continuous))
        .modifier(TaskDragSourceModifier(
            payload: (allowsDragging && !isSelectionMode) ? TaskDragPayload(taskID: task.id) : nil,
            title: displayTitle
        ))
        .accessibilityAction(named: isSelectionMode ? "Toggle selection" : "Edit task") {
            if isSelectionMode {
                selection?.toggle(task.id)
            } else {
                showingEditor = true
            }
        }
        .contextMenu {
            if !isSelectionMode {
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
                if let missed = model.missedOccurrenceCount(for: task.id) {
                    Button {
                        model.catchUpRecurringTask(task.id)
                    } label: {
                        Label(catchUpLabel(missed: missed), systemImage: "arrow.uturn.forward.circle")
                    }
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
                    if task.recurrence?.isActive == true {
                        confirmingRecurringDeletion = true
                    } else {
                        model.deleteTask(task.id, scope: .single)
                    }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .confirmationDialog(
            "Delete recurring task?",
            isPresented: $confirmingRecurringDeletion,
            titleVisibility: .visible
        ) {
            if let missed = model.missedOccurrenceCount(for: task.id) {
                Button(catchUpLabel(missed: missed)) {
                    model.catchUpRecurringTask(task.id)
                }
            }
            Button("Delete This Task", role: .destructive) {
                model.deleteTask(task.id, scope: .single)
            }
            Button("Delete This and Future Tasks", role: .destructive) {
                model.deleteTask(task.id, scope: .thisAndFuture)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.missedOccurrenceCount(for: task.id) == nil
                ? "Choose whether to delete only this occurrence or end the recurring series here."
                : "Catching up keeps the series and leaves one task for today. Deleting this and future tasks ends the series.")
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

    private func formattedDueDate(_ dueDate: Date) -> String {
        var style = Date.FormatStyle()
            .month(.abbreviated)
            .day()
        if task.dueTimeEnabled {
            style = style.hour().minute()
        }
        if task.dueTimeEnabled,
           let dueTimeZone = task.dueTimeZone,
           let timeZone = TimeZone(identifier: dueTimeZone) {
            style.timeZone = timeZone
        }
        return dueDate.formatted(style)
    }

    /// Touch-down path: this is what makes a check-off feel instant. Skipped in selection mode
    /// (selection stays a deliberate touch-up action) and while the list is coasting, in which
    /// case the touch-up below still completes the task — a skipped early fire costs a little
    /// latency, never the tap itself.
    private func handleCompletionPressDown(origin: CGPoint, isSelectionMode: Bool) {
        guard !isSelectionMode, !BoardScrollActivity.isMoving else { return }
        handleCompletionTap(origin: origin)
    }

    private func handleCompletionTap(origin: CGPoint) {
        // Touch-down and touch-up can both reach here for one physical tap, and `isPressed` can
        // cycle more than once within a single press. Collapsing them by task id keeps the
        // toggle idempotent per tap without any cross-interaction state to leak — the earlier
        // "did the press already fire?" flag could never be cleared reliably, because completing
        // a task re-renders the row and tears the button down before its action ever runs, so a
        // stale flag went on to swallow the *next* real tap.
        guard CompletionTapCoalescer.shouldHandle(taskID: task.id) else { return }

        if task.completed {
            withAnimation(.snappy) {
                model.toggleCompletion(task.id)
            }
            return
        }

        TaskCompletionHaptics.completed()
        if completedTabEnabled, !reduceMotion {
            completionAnimations?.launch(from: origin)
        }
        // Deliberately *not* wrapped in `withAnimation`: the row must vanish on this runloop
        // turn so a rapid second tap lands on the next task's checkbox rather than on a row
        // that is still animating out (see `testRapidCompletionRemovesEachTaskBeforeTheNextTap`).
        // The flight dot carries the visual continuity instead.
        model.toggleCompletion(task.id)
    }
}

/// Reuses one prepared generator. Allocating a generator per tap spins the haptic engine up from
/// cold each time, which costs main-thread time on exactly the taps that need to stay cheap — a
/// burst of rapid check-offs.
///
/// A `.rigid` impact rather than the previous `.success` notification: the notification pattern is
/// two pulses with a gap between them, so the confirmation you feel arrives well after the tap and
/// smears together when several tasks are checked off quickly. A single crisp pulse lands with the
/// finger.
@MainActor
enum TaskCompletionHaptics {
    private static let generator = UIImpactFeedbackGenerator(style: .rigid)
    private static let subtaskGenerator = UISelectionFeedbackGenerator()

    static func completed() {
        generator.impactOccurred()
        // Keeps the engine warm for the next check-off in a burst.
        generator.prepare()
    }

    /// The Taptic engine idles down after a couple of seconds, and playing on a cold engine adds
    /// its own lag to the very taps that should feel immediate. Warm it when the board appears.
    static func warmUp() {
        generator.prepare()
        subtaskGenerator.prepare()
    }

    static func subtaskToggled() {
        subtaskGenerator.selectionChanged()
        subtaskGenerator.prepare()
    }
}

extension TaskPriority {
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

/// Fit whole, readable columns into wide windows while keeping the phone's next-column peek.
/// "Catch Up to Today" for a recurring task that fell behind, with how many missed occurrences
/// it clears (see `AppModel.catchUpRecurringTask`).
func catchUpLabel(missed: Int) -> String {
    missed > 1 ? "Catch Up to Today (\(missed) missed)" : "Catch Up to Today"
}

func boardColumnWidth(in width: CGFloat) -> CGFloat {
    guard width >= 700 else { return max(1, min(330, width - 50)) }
    let available = width - 36
    let count = max(2, floor((available + 16) / 316))
    return (available - (count - 1) * 16) / count
}
