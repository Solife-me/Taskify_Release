import SwiftUI
import TaskifyCore

struct MacBoardView: View {
    let board: Board
    let search: String
    @Binding var selectedTaskID: String?
    var edit: (TaskItem) -> Void
    @Environment(AppModel.self) private var model
    @State private var showCompleted = false
    @State private var tableView = false
    private var boards: [Board] { board.kind == .compound ? model.compoundChildBoards(for: board.id) : [board] }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(board.kind == .week ? "Make room for what matters this week." : "A clear view of what comes next.")
                    .foregroundStyle(.secondary)
                Spacer()
                Picker("View", selection: $tableView) {
                    Image(systemName: "rectangle.split.3x1").tag(false)
                    Image(systemName: "list.bullet").tag(true)
                }.pickerStyle(.segmented).labelsHidden().frame(width: 90).help("Board or Table View")
                Toggle("Show Completed", isOn: $showCompleted).toggleStyle(.checkbox)
            }.padding(.horizontal, 24).padding(.vertical, 14)
            Divider()
            if board.kind == .bible {
                MacBibleView()
            } else if tableView {
                MacTaskTable(boards: boards, search: search, showCompleted: showCompleted, selectedTaskID: $selectedTaskID, edit: edit)
            } else {
                ScrollView([.horizontal, .vertical]) {
                    VStack(alignment: .leading, spacing: 24) {
                        ForEach(boards) { child in
                            if board.kind == .compound && !board.hideChildBoardNames { Text(child.name).font(.title2.bold()) }
                            HStack(alignment: .top, spacing: 16) {
                                ForEach(columns(child)) { column in
                                    MacBoardColumn(board: child, column: column, search: search, showCompleted: showCompleted,
                                                   selectedTaskID: $selectedTaskID, edit: edit)
                                }
                            }
                        }
                    }.padding(24)
                }.background(Color(nsColor: .underPageBackgroundColor))
            }
        }
    }

    private func columns(_ board: Board) -> [BoardColumn] {
        guard board.kind == .week else { return board.columns.sorted { $0.order < $1.order } }
        return WeekdayColumn.ordered(startingAt: model.weekStart).compactMap { day in board.columns.first { $0.id == day.rawValue } }
    }
}

private struct MacBoardColumn: View {
    let board: Board
    let column: BoardColumn
    let search: String
    let showCompleted: Bool
    @Binding var selectedTaskID: String?
    var edit: (TaskItem) -> Void
    @Environment(AppModel.self) private var model
    @State private var title = ""
    @State private var targeted = false
    @State private var editingEvent: TaskifyEvent?
    private var tasks: [TaskItem] {
        model.tasks(boardID: board.id, columnID: column.id, includeCompleted: showCompleted)
            .filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.note.localizedCaseInsensitiveContains(search) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(WeekdayColumn(rawValue: column.id)?.fullName ?? column.name).font(.headline)
                Spacer()
                Text("\(tasks.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    .padding(.horizontal, 7).padding(.vertical, 3).background(.quaternary, in: Capsule())
            }.padding(.bottom, 4)
            ForEach(model.boardEvents(boardID: board.id, columnID: column.id, weekday: WeekdayColumn(rawValue: column.id))) { event in
                Button { editingEvent = event } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Label(event.title, systemImage: "calendar").font(.headline)
                        if let date = event.startDate { Text(date.formatted(date: .abbreviated, time: event.isAllDay ? .omitted : .shortened)).font(.caption).foregroundStyle(.secondary) }
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain)
            }
            LazyVStack(spacing: 10) {
                ForEach(tasks) { task in
                    MacTaskCard(task: task, selected: selectedTaskID == task.id)
                        .onTapGesture { selectedTaskID = task.id }
                        .onTapGesture(count: 2) { edit(task) }
                        .draggable(task.id)
                        .contextMenu {
                            Button("Edit…") { edit(task) }
                            Button(task.completed ? "Mark Incomplete" : "Complete") { model.toggleCompletion(task.id) }
                            Button("Postpone One Day") { _ = model.postponeTask(task.id, byDays: 1) }
                            Menu("Move to Board") {
                                ForEach(model.visibleBoards.filter { $0.kind == .week || $0.kind == .list }) { target in
                                    Menu(target.name) {
                                        ForEach(target.columns) { destination in
                                            Button(destination.name) { model.moveTasks([task.id], toBoardID: target.id, columnID: destination.id) }
                                        }
                                    }
                                }
                            }
                            Button("Delete Task", role: .destructive) { model.deleteTask(task.id) }
                        }
                }
            }
            TextField("Add a task…", text: $title)
                .textFieldStyle(.plain).padding(12)
                .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                .onSubmit {
                    guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    if board.kind == .week, let weekday = WeekdayColumn(rawValue: column.id) {
                        model.selectBoard(board.id)
                        model.addQuickTask(title: title, weekday: weekday)
                    } else {
                        model.addQuickTask(title: title, boardID: board.id, columnID: column.id)
                    }
                    title = ""
                }
            if tasks.isEmpty { Text("A little breathing room.").font(.caption).foregroundStyle(.tertiary).padding(.vertical, 16) }
        }
        .padding(14).frame(width: 270, alignment: .topLeading)
        .background(targeted ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
        .sheet(item: $editingEvent) { MacEventEditor(event: $0, initialBoardID: board.id) }
        .dropDestination(for: String.self) { values, _ in
            let ids = values.filter { model.task(withID: $0) != nil }
            guard !ids.isEmpty else { return false }
            model.moveTasks(ids, toBoardID: board.id, columnID: column.id)
            return true
        } isTargeted: { targeted = $0 }
    }
}

struct MacTaskCard: View {
    let task: TaskItem
    var selected = false
    @Environment(AppModel.self) private var model
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button { model.toggleCompletion(task.id) } label: {
                Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(task.completed ? Color.accentColor : Color.secondary)
                    .font(.title3)
            }.buttonStyle(.plain).help(task.completed ? "Mark Incomplete" : "Complete Task")
            VStack(alignment: .leading, spacing: 8) {
                Text(task.title).font(.body.weight(.medium)).strikethrough(task.completed)
                    .foregroundStyle(task.completed ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                if !task.note.isEmpty { Text(task.note).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                HStack(spacing: 9) {
                    if let date = task.dueDate, task.dueDateEnabled {
                        Label(date.formatted(.dateTime.month(.abbreviated).day()), systemImage: "calendar")
                            .foregroundStyle(date < Date() && !task.completed ? Color.orange : Color.secondary)
                    }
                    if let subtasks = task.subtasks, !subtasks.isEmpty {
                        Label("\(subtasks.filter(\.completed).count)/\(subtasks.count)", systemImage: "checklist")
                    }
                    if task.recurrence?.isActive == true { Image(systemName: "repeat") }
                    if let priority = task.priority { Image(systemName: "flag.fill").foregroundStyle(priority == .high ? .red : .orange) }
                }.font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }.padding(13).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(selected ? Color.accentColor : Color.primary.opacity(0.06), lineWidth: selected ? 2 : 1))
            .contentShape(Rectangle())
            .accessibilityElement(children: .contain)
    }
}

struct MacAgendaView: View {
    let todayOnly: Bool
    let search: String
    @Binding var selectedTaskID: String?
    var edit: (TaskItem) -> Void
    @Environment(AppModel.self) private var model
    @State private var calendarDate = Date()
    @State private var editingEvent: TaskifyEvent?
    @State private var filterDate = false
    @EnvironmentObject private var deviceCalendar: DeviceCalendarStore
    private var tasks: [TaskItem] {
        let filtered = UpcomingTaskOrganizer.filter(model.snapshot.tasks, searchText: search,
            includedBoardIDs: Set(model.visibleBoards.map(\.id)), selectedDate: filterDate && !todayOnly ? calendarDate : nil)
        // Reads model.currentCalendarDay (rather than computing today's start from Date() here)
        // so this view recomputes across midnight even if nothing else causes a re-render — see
        // AppModel.refreshCalendarDayIfNeeded.
        let endOfToday = Calendar.current.date(byAdding: .day, value: 1, to: model.currentCalendarDay) ?? Date()
        return UpcomingTaskOrganizer.sort(filtered.filter { !todayOnly || ($0.dueDate ?? .distantFuture) < endOfToday },
            mode: .dueDate, direction: .ascending, boardGrouping: .mixed, boardOrder: model.visibleBoards.map(\.id))
    }
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(todayOnly ? Date().formatted(.dateTime.weekday(.wide).month(.wide).day()) : "Your days, at a glance")
                        .font(.title2.bold())
                    Text("\(tasks.count) tasks \(todayOnly ? "due today or overdue" : "in your agenda")").foregroundStyle(.secondary)
                }.padding(24)
                if tasks.isEmpty {
                    ContentUnavailableView("You're All Caught Up", systemImage: "checkmark.seal", description: Text("Scheduled tasks will appear here."))
                } else {
                    List(selection: $selectedTaskID) {
                        ForEach(tasks) { task in
                            HStack(spacing: 18) {
                                Text(task.dueDate?.formatted(.dateTime.month(.abbreviated).day()) ?? "")
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 62, alignment: .leading)
                                MacTaskCard(task: task).onTapGesture(count: 2) { edit(task) }
                            }.tag(task.id).listRowSeparator(.hidden)
                        }
                    }.listStyle(.inset)
                }
            }
            if !todayOnly {
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    DatePicker("Calendar", selection: $calendarDate, displayedComponents: .date).datePickerStyle(.graphical)
                        .onChange(of: calendarDate) { _, _ in filterDate = true; deviceCalendar.refresh(monthContaining: calendarDate) }
                    Toggle("Only selected date", isOn: $filterDate)
                    Divider()
                    Button("Connect Calendars") { deviceCalendar.requestAccess(monthContaining: calendarDate) }
                    Button("Connect Reminders") { deviceCalendar.requestReminderAccess(monthContaining: calendarDate) }
                    if let error = deviceCalendar.calendarErrorMessage ?? deviceCalendar.reminderErrorMessage { Text(error).font(.caption).foregroundStyle(.red) }
                    Text("TASKIFY EVENTS").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.taskifyEvents.filter { event in
                        guard let start = event.startDate else { return false }
                        return Calendar.current.isDate(start, inSameDayAs: calendarDate)
                    }) { event in
                        Button(event.title) { editingEvent = event }.buttonStyle(.plain)
                    }
                    Text("DEVICE CALENDARS").font(.caption).foregroundStyle(.secondary)
                    ForEach(deviceCalendar.events(on: calendarDate)) { event in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(event.title).font(.headline)
                            Text(event.isAllDay ? "All day" : event.startDate.formatted(date: .omitted, time: .shortened)).font(.caption)
                            Text(event.calendarTitle).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(deviceCalendar.reminders(on: calendarDate)) { reminder in
                        Button { _ = deviceCalendar.completeReminder(reminder) } label: { Label(reminder.title, systemImage: "circle") }.buttonStyle(.plain)
                    }
                }.padding(20).frame(width: 270)
            }
        }.sheet(item: $editingEvent) { MacEventEditor(event: $0, initialBoardID: $0.boardID ?? model.selectedBoardID) }
    }
}

private struct MacTaskTable: View {
    let boards: [Board]
    let search: String
    let showCompleted: Bool
    @Binding var selectedTaskID: String?
    let edit: (TaskItem) -> Void
    @Environment(AppModel.self) private var model
    @State private var selection = Set<String>()
    @State private var sort = [KeyPathComparator(\TaskItem.title)]
    @State private var deleting = false
    private var tasks: [TaskItem] {
        let ids = Set(boards.map(\.id))
        return model.snapshot.tasks.filter {
            ids.contains($0.boardID) && !$0.isDeleted && (showCompleted || !$0.completed) &&
            (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.note.localizedCaseInsensitiveContains(search))
        }.sorted(using: sort)
    }
    var body: some View {
        Table(tasks, selection: $selection, sortOrder: $sort) {
            TableColumn("Done") { task in
                Button { model.toggleCompletion(task.id) } label: { Image(systemName: task.completed ? "checkmark.circle.fill" : "circle") }.buttonStyle(.plain)
            }.width(45)
            TableColumn("Task", value: \.title)
            TableColumn("Due") { task in Text(task.dueDateEnabled ? task.dueDate?.formatted(date: .abbreviated, time: .omitted) ?? "" : "") }.width(110)
            TableColumn("Priority") { task in Text(task.priority.map { String(describing: $0).capitalized } ?? "—") }.width(70)
            TableColumn("Column") { task in Text(boards.first { $0.id == task.boardID }?.columns.first { $0.id == task.columnID }?.name ?? "") }.width(100)
        }
        .contextMenu(forSelectionType: String.self) { ids in
            Button("Complete Selected") { model.completeTasks(ids) }.disabled(ids.isEmpty)
            Button("Delete Selected…", role: .destructive) { deleting = true }.disabled(ids.isEmpty)
        } primaryAction: { ids in if let id = ids.first, let task = model.task(withID: id) { edit(task) } }
        .onChange(of: selection) { _, ids in selectedTaskID = ids.count == 1 ? ids.first : nil }
        .onChange(of: model.snapshotRevision) { _, _ in selection.formIntersection(Set(tasks.map(\.id))) }
        .safeAreaInset(edge: .bottom) {
            if !selection.isEmpty {
                HStack {
                    Text("\(selection.count) selected").font(.caption)
                    Spacer()
                    Menu("Move…") {
                        ForEach(model.visibleBoards.filter { $0.kind == .week || $0.kind == .list }) { board in
                            Menu(board.name) { ForEach(board.columns) { column in Button(column.name) { model.moveTasks(selection, toBoardID: board.id, columnID: column.id) } } }
                        }
                    }
                    Button("Complete") { model.completeTasks(selection) }
                    Button("Delete…", role: .destructive) { deleting = true }
                }.padding(12).background(.bar)
            }
        }
        .confirmationDialog("Delete \(selection.count) selected tasks?", isPresented: $deleting) {
            Button("Delete Tasks", role: .destructive) { model.deleteTasks(selection); selection = [] }
            Button("Cancel", role: .cancel) {}
        }
    }
}
