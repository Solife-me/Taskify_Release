import SwiftUI
import TaskifyCore

struct TaskEditView: View {
    @ObservedObject var viewModel: TaskEditViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appAccent) private var accentChoice

    @State private var newSubtaskTitle = ""
    @State private var showRecurrencePicker = false
    @State private var showPriorityPicker = false
    @State private var showDeleteConfirm = false
    @State private var showEndRepeatPicker = false

    private var isCreate: Bool { viewModel.mode == .create }
    private var accentColor: Color { ThemeColors.accent(for: accentChoice) }

    var body: some View {
        NavigationStack {
            Form {
                contentSection
                dateTimeSection
                recurrenceSection
                locationSection
                subtasksSection
                if !isCreate { dangerSection }
            }
            .navigationTitle(isCreate ? "New Task" : "Edit Task")
            .platformInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isCreate ? "Add" : "Save") {
                        viewModel.save()
                        dismiss()
                    }
                    .bold()
                    .disabled(!viewModel.isValid)
                }
            }
            .sheet(isPresented: $showRecurrencePicker) {
                RecurrencePickerSheet(rule: $viewModel.recurrence)
            }
            .confirmationDialog("Delete Task", isPresented: $showDeleteConfirm) {
                Button("Delete", role: .destructive) {
                    viewModel.requestDelete()
                    dismiss()
                }
            } message: {
                Text("This task will be permanently deleted.")
            }
        }
    }

    // MARK: - Content Section

    private var contentSection: some View {
        Section {
            TextField("Task title", text: $viewModel.title, axis: .vertical)
                .lineLimit(1...4)

            TextField("Notes", text: $viewModel.note, axis: .vertical)
                .lineLimit(2...6)
                .foregroundStyle(.secondary)

            // Priority
            HStack {
                Label("Priority", systemImage: "exclamationmark.triangle")
                Spacer()
                Menu {
                    ForEach(TaskPriority.allCases) { p in
                        Button(action: { viewModel.priority = p }) {
                            HStack {
                                Text(p.label)
                                if viewModel.priority == p {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        if viewModel.priority != .none {
                            Text(viewModel.priority.marks)
                                .foregroundStyle(priorityColor(viewModel.priority))
                                .bold()
                        }
                        Text(viewModel.priority.label)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("Content")
        }
    }

    // MARK: - Date & Time Section

    private var dateTimeSection: some View {
        Section {
            // Due date toggle + picker
            Toggle(isOn: $viewModel.dueDateEnabled) {
                Label("Due Date", systemImage: "calendar")
            }

            if viewModel.dueDateEnabled {
                DatePicker("Date", selection: $viewModel.dueDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)

                // Time toggle + picker
                Toggle(isOn: $viewModel.dueTimeEnabled) {
                    Label("Time", systemImage: "clock")
                }

                if viewModel.dueTimeEnabled {
                    DatePicker("Time", selection: $viewModel.dueTime, displayedComponents: .hourAndMinute)

                    // Timezone
                    HStack {
                        Label("Timezone", systemImage: "globe")
                        Spacer()
                        Text(abbreviation(for: viewModel.dueTimeZone))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("Date & Time")
        }
    }

    // MARK: - Recurrence Section

    private var recurrenceSection: some View {
        Section {
            Button(action: { showRecurrencePicker = true }) {
                HStack {
                    Label("Repeat", systemImage: "repeat")
                    Spacer()
                    Text(viewModel.recurrence.displayLabel)
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .tint(.primary)

            if viewModel.recurrence.isActive {
                // End repeat
                HStack {
                    Label("End Repeat", systemImage: "calendar.badge.minus")
                    Spacer()
                    if let until = viewModel.recurrence.untilISO, !until.isEmpty {
                        Text(formatEndDate(until))
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Never")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("Recurrence")
        }
    }

    // MARK: - Location Section

    private var locationSection: some View {
        Section {
            HStack {
                Label("Board", systemImage: "square.grid.2x2")
                Spacer()
                if viewModel.availableBoards.isEmpty {
                    Text(viewModel.location.boardName)
                        .foregroundStyle(.secondary)
                } else {
                    Picker("", selection: Binding(
                        get: { viewModel.location.boardId },
                        set: { newId in
                            if let loc = viewModel.availableBoards.first(where: { $0.boardId == newId }) {
                                viewModel.location = loc
                            }
                        }
                    )) {
                        ForEach(viewModel.availableBoards, id: \.boardId) { loc in
                            Text(loc.boardName).tag(loc.boardId)
                        }
                    }
                    .labelsHidden()
                }
            }

            if !viewModel.availableColumns.isEmpty {
                Picker(selection: Binding(
                    get: { viewModel.location.columnId ?? "" },
                    set: { newCol in
                        viewModel.location.columnId = newCol.isEmpty ? nil : newCol
                        viewModel.location.columnName = viewModel.availableColumns.first(where: { $0.id == newCol })?.name
                    }
                )) {
                    ForEach(viewModel.availableColumns) { col in
                        Text(col.name).tag(col.id)
                    }
                } label: {
                    Label("List", systemImage: "list.bullet")
                }
            }
        } header: {
            Text("Location")
        }
    }

    // MARK: - Subtasks Section

    private var subtasksSection: some View {
        Section {
            ForEach(viewModel.subtasks) { sub in
                HStack(spacing: 8) {
                    Button(action: { viewModel.toggleSubtask(id: sub.id) }) {
                        Image(systemName: sub.completed ? "checkmark.square.fill" : "square")
                            .foregroundStyle(sub.completed ? accentColor : .secondary)
                    }
                    .buttonStyle(.plain)

                    Text(sub.title)
                        .strikethrough(sub.completed)
                        .foregroundStyle(sub.completed ? .secondary : .primary)

                    Spacer()

                    Button(action: { viewModel.removeSubtask(id: sub.id) }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                }
            }
            .onMove { from, to in viewModel.moveSubtask(fromOffsets: from, toOffset: to) }

            HStack {
                TextField("New subtask", text: $newSubtaskTitle)
                    .onSubmit { addSubtask() }

                Button(action: addSubtask) {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(.blue)
                }
                .buttonStyle(.plain)
                .disabled(newSubtaskTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        } header: {
            HStack {
                Text("Subtasks")
                if !viewModel.subtasks.isEmpty {
                    Spacer()
                    let done = viewModel.subtasks.filter(\.completed).count
                    Text("\(done)/\(viewModel.subtasks.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Danger Section

    private var dangerSection: some View {
        Section {
            Button(role: .destructive, action: { showDeleteConfirm = true }) {
                Label("Delete Task", systemImage: "trash")
            }
        }
    }

    // MARK: - Helpers

    private func addSubtask() {
        let trimmed = newSubtaskTitle.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        viewModel.addSubtask(title: trimmed)
        newSubtaskTitle = ""
    }

    private func priorityColor(_ p: TaskPriority) -> Color {
        switch p {
        case .none: return .clear
        case .low: return .blue
        case .medium: return .orange
        case .high: return .red
        }
    }

    private func abbreviation(for tzId: String) -> String {
        TimeZone(identifier: tzId)?.abbreviation() ?? tzId
    }

    private func formatEndDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: iso) else { return iso }
        let df = DateFormatter()
        df.dateStyle = .medium
        return df.string(from: date)
    }
}

// MARK: - Recurrence Picker Sheet

struct RecurrencePickerSheet: View {
    @Binding var rule: RecurrenceRule
    @Environment(\.dismiss) private var dismiss

    @State private var localRule: RecurrenceRule = RecurrenceRule()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(RecurrenceType.allCases) { type in
                        Button(action: { localRule.type = type }) {
                            HStack {
                                Text(type.label)
                                Spacer()
                                if localRule.type == type {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.blue)
                                }
                            }
                        }
                        .tint(.primary)
                    }
                }

                if localRule.type == .weekly {
                    Section("Days") {
                        let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 7), spacing: 8) {
                            ForEach(0..<7, id: \.self) { day in
                                Button(action: {
                                    if localRule.days.contains(day) { localRule.days.remove(day) }
                                    else { localRule.days.insert(day) }
                                }) {
                                    Text(dayNames[day])
                                        .font(.caption.bold())
                                        .frame(maxWidth: .infinity, minHeight: 36)
                                        .background(localRule.days.contains(day) ? Color.blue : Color.secondary.opacity(0.15))
                                        .foregroundStyle(localRule.days.contains(day) ? .white : .primary)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }

                if localRule.type == .every {
                    Section("Interval") {
                        Stepper("Every \(localRule.interval)", value: $localRule.interval, in: 1...99)
                        Picker("Unit", selection: $localRule.unit) {
                            Text("Hours").tag("hour")
                            Text("Days").tag("day")
                            Text("Weeks").tag("week")
                        }
                        .pickerStyle(.segmented)
                    }
                }

                if localRule.type == .monthlyDay {
                    Section("Monthly") {
                        Stepper("Day \(localRule.monthDay)", value: $localRule.monthDay, in: 1...28)
                        if localRule.monthInterval > 1 {
                            Stepper("Every \(localRule.monthInterval) months", value: $localRule.monthInterval, in: 1...24)
                        }
                    }
                }
            }
            .navigationTitle("Repeat")
            .platformInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        rule = localRule
                        dismiss()
                    }
                    .bold()
                }
            }
            .onAppear { localRule = rule }
        }
    }
}
