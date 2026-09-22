import SwiftUI
import TaskifyCore

struct MacTaskEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let original: TaskItem?
    @State private var draft: TaskItem
    @State private var subtask = ""
    @StateObject private var attachments = MacAttachmentQueue()
    @State private var saving = false
    @State private var error: String?
    @State private var recurrenceChoice = "keep"
    @State private var interval = 1
    @State private var intervalUnit = TaskRecurrenceUnit.day
    @State private var weeklyDays = Set<Int>()
    @State private var monthlyInterval = 1
    @State private var untilEnabled = false
    @State private var until = Date()
    @State private var deleteConfirmation = false
    @State private var isDropTargeted = false
    @State private var saveTask: Task<Void, Never>?
    private var columns: [BoardColumn] { model.board(withID: draft.boardID)?.columns ?? [] }

    init(task: TaskItem?, boardID: String) {
        original = task
        _draft = State(initialValue: task ?? TaskItem(boardID: boardID, title: ""))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(original == nil ? "New Task" : "Edit Task").font(.title2.bold())
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                Button("Save") { saveTask = Task { await save() } }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(saving || attachments.importing || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding(22)
            Divider()
            Form {
                Section("Task") {
                    TextField("Title", text: $draft.title, axis: .vertical).lineLimit(1...4)
                    TextField("Notes", text: $draft.note, axis: .vertical).lineLimit(3...10)
                    if original == nil {
                        Picker("Board", selection: $draft.boardID) {
                            ForEach(model.visibleBoards.filter { $0.kind == .week || $0.kind == .list }) { Text($0.name).tag($0.id) }
                        }
                    }
                    Picker("Column", selection: Binding(get: { draft.columnID ?? columns.first?.id ?? "" }, set: { draft.columnID = $0 })) {
                        ForEach(columns) { Text($0.name).tag($0.id) }
                    }
                    Picker("Priority", selection: $draft.priority) {
                        Text("None").tag(TaskPriority?.none)
                        ForEach(TaskPriority.allCases, id: \.self) { Text(String(describing: $0).capitalized).tag(Optional($0)) }
                    }
                }
                Section("Schedule") {
                    Toggle("Due Date", isOn: $draft.dueDateEnabled)
                    if draft.dueDateEnabled {
                        DatePicker("Date", selection: Binding(get: { draft.dueDate ?? Date() }, set: { draft.dueDate = $0 }), displayedComponents: .date)
                        Toggle("Include Time", isOn: $draft.dueTimeEnabled)
                        if draft.dueTimeEnabled {
                            DatePicker("Time", selection: Binding(get: { draft.dueDate ?? Date() }, set: { draft.dueDate = $0 }), displayedComponents: .hourAndMinute)
                            Picker("Time Zone", selection: Binding(get: { draft.dueTimeZone ?? TimeZone.current.identifier }, set: { draft.dueTimeZone = $0 })) {
                                ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) }
                            }
                        }
                    }
                    Picker("Repeat", selection: $recurrenceChoice) {
                        Text(draft.recurrence?.isActive == true ? "Keep Existing Schedule" : "Does Not Repeat").tag("keep")
                        Text("Does Not Repeat").tag("none")
                        Text("Daily").tag("daily")
                        Text("Weekly").tag("weekly")
                        Text("Monthly").tag("monthly")
                        Text("Every…").tag("interval")
                    }
                    if recurrenceChoice == "weekly" {
                        HStack {
                            ForEach(WeekdayColumn.ordered(startingAt: model.weekStart)) { day in
                                let value = day.calendarWeekday - 1
                                Button(day.shortName) {
                                    if weeklyDays.contains(value) { weeklyDays.remove(value) } else { weeklyDays.insert(value) }
                                }.buttonStyle(.bordered).tint(weeklyDays.contains(value) ? Color.accentColor : Color.secondary)
                            }
                        }
                    }
                    if recurrenceChoice == "monthly" {
                        Stepper("Every \(monthlyInterval) month\(monthlyInterval == 1 ? "" : "s")", value: $monthlyInterval, in: 1...24)
                    }
                    if recurrenceChoice == "interval" {
                        Stepper("Every \(interval)", value: $interval, in: 1...365)
                        Picker("Unit", selection: $intervalUnit) {
                            ForEach(TaskRecurrenceUnit.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                        }
                    }
                    if recurrenceChoice != "keep" && recurrenceChoice != "none" {
                        Toggle("End Repeat", isOn: $untilEnabled)
                        if untilEnabled { DatePicker("Repeat Until", selection: $until, displayedComponents: .date) }
                    }
                }
                Section("Reminders") {
                    ForEach([TaskReminder(rawValue: "0h"), TaskReminder(rawValue: "15m"), TaskReminder(rawValue: "1h"), TaskReminder(rawValue: "1d")], id: \.rawValue) { reminder in
                        Toggle(reminder.label, isOn: Binding(get: { draft.reminders?.contains(reminder) == true }, set: { enabled in
                            var reminders = draft.reminders ?? []
                            reminders.removeAll { $0 == reminder }
                            if enabled { reminders.append(reminder) }
                            draft.reminders = reminders
                        }))
                    }
                }
                Section("Attachments") {
                    ForEach(draft.documents ?? []) { document in
                        HStack { Text(document.name); Spacer(); Button("Remove") { draft.documents?.removeAll { $0.id == document.id } } }
                    }
                    MacAttachmentQueueView(queue: attachments, busy: saving, onCancel: { saveTask?.cancel() })
                    HStack {
                        Button("Attach Files…") { attachments.chooseFiles() }.disabled(saving || attachments.importing)
                        PasteButton(payloadType: URL.self) { urls in attachments.stage(urls) }
                            .labelStyle(.iconOnly).disabled(saving || attachments.importing).help("Paste Files")
                    }
                    .padding(6)
                    .background(isDropTargeted ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                    .dropDestination(for: URL.self) { urls, _ in
                        guard !saving else { return false }
                        attachments.stage(urls)
                        return true
                    } isTargeted: { isDropTargeted = $0 }
                }
                Section("Subtasks") {
                    ForEach(draft.subtasks ?? []) { item in
                        HStack {
                            Toggle(item.title, isOn: Binding(get: { draft.subtasks?.first { $0.id == item.id }?.completed ?? false }, set: { value in
                                guard let index = draft.subtasks?.firstIndex(where: { $0.id == item.id }) else { return }
                                draft.subtasks?[index].completed = value
                            }))
                            Spacer()
                            Button(role: .destructive) { draft.subtasks?.removeAll { $0.id == item.id } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                        }
                    }
                    HStack {
                        TextField("Add a subtask", text: $subtask)
                        Button("Add") {
                            var items = draft.subtasks ?? []
                            items.append(TaskSubtask(title: subtask.trimmingCharacters(in: .whitespacesAndNewlines)))
                            draft.subtasks = items; subtask = ""
                        }.disabled(subtask.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).textSelection(.enabled) } }
                if original != nil {
                    Section { Button("Delete Task…", role: .destructive) { deleteConfirmation = true } }
                }
            }.formStyle(.grouped).disabled(saving)
        }.frame(width: 610, height: 710).interactiveDismissDisabled(saving)
            .onDisappear { attachments.clear() }
            .onAppear { if original == nil { prepareNewBoard() } }
            .onChange(of: draft.boardID) { _, _ in prepareNewBoard() }
            .onChange(of: draft.columnID) { _, value in
                guard model.board(withID: draft.boardID)?.kind == .week, let value, let weekday = WeekdayColumn(rawValue: value) else { return }
                draft.dueDateEnabled = true
                draft.dueDate = WeekDateResolver.date(for: weekday, inWeekContaining: draft.dueDate ?? Date(), weekStartsOn: model.weekStart)
            }
            .onChange(of: recurrenceChoice) { _, value in
                switch value {
                case "weekly" where weeklyDays.isEmpty:
                    if case .weekly(let days, _) = draft.recurrence { weeklyDays = Set(days) }
                    else { weeklyDays = [Calendar.current.component(.weekday, from: draft.dueDate ?? Date()) - 1] }
                case "monthly":
                    if case .monthlyDay(_, let interval, _) = draft.recurrence { monthlyInterval = interval ?? 1 }
                default: break
                }
            }
            .confirmationDialog("Delete this task?", isPresented: $deleteConfirmation) {
                Button("Delete This Task", role: .destructive) { model.deleteTask(draft.id); dismiss() }
                if draft.recurrence?.isActive == true {
                    Button("Delete This and Future Occurrences", role: .destructive) { model.deleteTask(draft.id, scope: .thisAndFuture); dismiss() }
                }
                Button("Cancel", role: .cancel) {}
            }
    }

    private func prepareNewBoard() {
        guard let board = model.board(withID: draft.boardID) else { return }
        draft = MacTaskDraft.place(draft, on: board, weekStartsOn: model.weekStart)
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        if let original, model.task(withID: original.id) != original {
            error = "This task changed in another window or through sync. Close and reopen the editor to see the latest version before saving."
            return
        }
        if draft.dueDateEnabled && draft.dueDate == nil { draft.dueDate = Date() }
        if recurrenceChoice == "weekly" && weeklyDays.isEmpty {
            error = "Choose at least one day for weekly repeats."
            return
        }
        draft.recurrence = MacRecurrenceBuilder.build(choice: recurrenceChoice, referenceDate: draft.dueDate ?? Date(),
            weeklyDays: weeklyDays, monthlyInterval: monthlyInterval, interval: interval, intervalUnit: intervalUnit,
            until: untilEnabled ? until : nil, existing: draft.recurrence)
        do {
            let uploaded = try await attachments.uploadDocuments(boardID: model.board(withID: draft.boardID)?.effectiveNostrBoardID ?? draft.boardID)
            let existing = draft.documents ?? []
            draft.documents = existing + uploaded.filter { item in !existing.contains { $0.id == item.id } }
        } catch is CancellationError {
            attachments.progress = nil
            return
        } catch { self.error = error.localizedDescription; return }
        if let original, model.task(withID: original.id) != original {
            error = "This task changed while attachments uploaded. Close and reopen it before saving."; return
        }
        if original == nil {
            guard model.addDetailedTask(id: draft.id, title: draft.title, note: draft.note, boardID: draft.boardID,
                columnID: draft.columnID ?? columns.first?.id, dueDate: draft.dueDate, dueDateEnabled: draft.dueDateEnabled,
                dueTimeEnabled: draft.dueTimeEnabled, dueTimeZone: draft.dueTimeZone, urgent: false, priority: draft.priority,
                subtasks: draft.subtasks ?? [], recurrence: draft.recurrence, reminders: draft.reminders ?? [], reminderTime: draft.reminderTime,
                images: draft.images ?? [], documents: draft.documents ?? []) != nil else {
                error = "The task could not be created. Choose an available board and column."; return
            }
        } else {
            guard model.updateTask(taskID: draft.id, title: draft.title, note: draft.note, dueDate: draft.dueDate,
                dueDateEnabled: draft.dueDateEnabled, dueTimeEnabled: draft.dueTimeEnabled, dueTimeZone: draft.dueTimeZone,
                priority: draft.priority, columnID: draft.columnID, subtasks: draft.subtasks ?? [], recurrence: draft.recurrence,
                reminders: draft.reminders ?? [], reminderTime: draft.reminderTime, images: draft.images ?? [], documents: draft.documents ?? []) else {
                error = "The task could not be saved."; return
            }
        }
        attachments.clear()
        dismiss()
    }
}

struct MacBoardEditor: View {
    let board: Board?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var kind = BoardKind.list
    @State private var children = Set<String>()
    @State private var newColumn = ""
    @State private var renamingColumnID: String?
    @State private var renamingColumnName = ""
    @State private var deletingColumn: BoardColumn?
    @State private var joinCode = ""
    @State private var deletingBoard = false
    @State private var relays = ""
    @State private var error: String?
    private var current: Board? { board.flatMap { model.board(withID: $0.id) } }
    var body: some View {
        VStack {
            HStack {
                Text(board == nil ? "New Board" : "Board Settings").font(.title2.bold())
                Spacer()
                Button("Done") { save() }.keyboardShortcut(.defaultAction)
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding()
            Form {
                TextField("Name", text: $name)
                if board == nil {
                    Picker("Layout", selection: $kind) {
                        Text("List Board").tag(BoardKind.list)
                        Text("Week Board").tag(BoardKind.week)
                        Text("Compound Board").tag(BoardKind.compound)
                    }
                    if kind == .compound {
                        ForEach(model.visibleBoards.filter { $0.kind != .compound && $0.kind != .bible }) { child in
                            Toggle(child.name, isOn: Binding(get: { children.contains(child.id) }, set: { if $0 { children.insert(child.id) } else { children.remove(child.id) } }))
                        }
                    }
                    Section("Join a Shared Board") {
                        TextField("Share code", text: $joinCode, axis: .vertical)
                        Button("Join Board") {
                            if model.joinSharedBoard(shareText: joinCode, name: name) { dismiss() }
                            else { error = "Enter a valid Taskify board share code." }
                        }.disabled(joinCode.isEmpty)
                    }
                }
                if let current, current.kind == .list {
                    Section("Columns") {
                        ForEach(current.columns.sorted { $0.order < $1.order }) { column in
                            HStack {
                                if renamingColumnID == column.id {
                                    TextField("Column name", text: $renamingColumnName).onSubmit { renameColumn(id: column.id) }
                                    Button("Save") { renameColumn(id: column.id) }
                                        .disabled(renamingColumnName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                    Button("Cancel") { renamingColumnID = nil }
                                } else {
                                    Text(column.name)
                                    Spacer()
                                    Button("Rename") { renamingColumnID = column.id; renamingColumnName = column.name }
                                    Button("Move Up") { model.selectBoard(current.id); _ = model.moveListColumn(columnID: column.id, direction: -1) }
                                    Button("Move Down") { model.selectBoard(current.id); _ = model.moveListColumn(columnID: column.id, direction: 1) }
                                    if current.columns.count > 1 {
                                        Button("Delete…", role: .destructive) { deletingColumn = column }
                                    }
                                }
                            }
                        }
                        HStack {
                            TextField("New column", text: $newColumn)
                            Button("Add") { model.selectBoard(current.id); if model.addListColumn(name: newColumn) { newColumn = "" } }.disabled(newColumn.isEmpty)
                        }
                    }
                }
                if let current, current.kind == .compound {
                    Section("Included Boards") {
                        ForEach(model.visibleBoards.filter { $0.id != current.id && $0.kind != .compound && $0.kind != .bible }) { child in
                            Toggle(child.name, isOn: Binding(get: { current.children.contains(child.id) }, set: { _ = model.setCompoundChild(boardID: current.id, childBoardID: child.id, included: $0) }))
                        }
                    }
                }
                if let current {
                    Section("Relay Sync") {
                        TextField("Relay URLs, separated by commas", text: $relays, axis: .vertical).lineLimit(2...5)
                        Button("Update Board Relays") { if !model.updateBoardRelayURLs(boardID: current.id, relayURLs: relays.split(separator: ",").map(String.init)) { error = "Enter valid relay URLs." } }
                    }
                    Section("Sharing") {
                        Button("Copy Live Board Share") { if let value = try? BoardShareContract.encode(board: current) { macCopy(value) } }
                        Button("Create Independent Template") {
                            Task {
                                do { let result = try await model.createTemplateShare(for: current.id); macCopy(try BoardShareContract.encode(board: result.board)) }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                    }
                }
                if let current {
                    Section { Button("Delete Board…", role: .destructive) { deletingBoard = true } }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }.formStyle(.grouped)
        }.frame(width: 560, height: 620).onAppear { if let board { name = board.name; kind = board.kind; relays = board.effectiveRelayURLs.joined(separator: ", ") } }
        .confirmationDialog("Delete this board and its tasks?", isPresented: $deletingBoard) {
            if let board {
                Button("Delete Board", role: .destructive) { if model.deleteBoard(boardID: board.id) { dismiss() } else { error = "The board could not be deleted." } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(deletingColumn.map { "Delete “\($0.name)”?" } ?? "",
            isPresented: Binding(get: { deletingColumn != nil }, set: { if !$0 { deletingColumn = nil } }), presenting: deletingColumn) { column in
            ForEach((current?.columns ?? []).filter { $0.id != column.id }.sorted { $0.order < $1.order }) { destination in
                Button("Move Tasks to “\(destination.name)”") { removeColumn(column, moveTasksTo: destination.id) }
            }
            Button("Delete Its Tasks Too", role: .destructive) { removeColumn(column, moveTasksTo: nil) }
            Button("Cancel", role: .cancel) { deletingColumn = nil }
        } message: { _ in
            Text("Choose where its tasks go, or delete them along with the column.")
        }
    }
    private func renameColumn(id: String) {
        let name = renamingColumnName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let boardID = current?.id else { return }
        model.selectBoard(boardID)
        if model.renameListColumn(columnID: id, name: name) { renamingColumnID = nil }
        else { error = "The column could not be renamed." }
    }
    private func removeColumn(_ column: BoardColumn, moveTasksTo destinationColumnID: String?) {
        guard let boardID = current?.id else { return }
        model.selectBoard(boardID)
        if !model.removeListColumn(columnID: column.id, moveTasksTo: destinationColumnID) {
            error = "The column could not be deleted."
        }
        deletingColumn = nil
    }
    private func save() {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "Enter a board name."; return }
        let success: Bool
        if let board { success = model.renameBoard(boardID: board.id, name: name) }
        else {
            switch kind {
            case .week: success = model.createWeekBoard(name: name)
            case .compound: success = model.createCompoundBoard(name: name, childBoardIDs: children.sorted())
            default: success = model.createListBoard(name: name)
            }
        }
        if success { dismiss() } else { error = "The board could not be saved. Check its name and selected child boards." }
    }
}
