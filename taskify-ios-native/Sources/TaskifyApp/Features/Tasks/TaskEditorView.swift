import PhotosUI
import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers
import UIKit
import VisionKit

struct TaskEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private let draftTask: TaskItem
    private let isNewTask: Bool

    @State private var taskID: String?

    @State private var title: String
    @State private var note: String
    @State private var dueDate: Date
    @State private var dueDateEnabled: Bool
    @State private var dueTimeEnabled: Bool
    @State private var dueTimeZone: String
    @State private var urgent: Bool
    @State private var expandedDateTimePicker: DateTimeEditorExpansion?
    @State private var showingTimeZonePicker = false
    @State private var showingUrgentAlarmUnavailable = false
    @State private var priority: TaskPriority?
    @State private var selectedColumnID: String
    @State private var subtasks: [TaskSubtask]
    @State private var subtasksExpanded = false
    @State private var repeatChoice: RepeatChoice
    @State private var customRepeatCount: Int
    @State private var customRepeatUnit: CustomRepeatUnit
    @State private var customWeekdays: Set<Int>
    @State private var repeatHasEnd: Bool
    @State private var repeatEndDate: Date
    @State private var reminders: [TaskReminder]
    @State private var reminderTime: Date
    @State private var images: [String]
    @State private var documents: [TaskDocument]
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showingPhotoLibrary = false
    @State private var showingFileImporter = false
    @State private var showingCamera = false
    @State private var showingDocumentScanner = false
    @State private var isUploadingAttachment = false
    @State private var attachmentStatus: String?
    @State private var attachmentError: String?
    @State private var showingTaskShare = false
    @State private var confirmingRecurringDeletion = false
    @State private var didAutoFocusTitle = false
    @FocusState private var titleIsFocused: Bool

    init(task: TaskItem) {
        self.init(task: task, isNewTask: false)
    }

    init(draft: TaskItem) {
        self.init(task: draft, isNewTask: true)
    }

    private init(task: TaskItem, isNewTask: Bool) {
        let repeatDraft = RepeatDraft(recurrence: task.recurrence, dueDate: task.dueDate ?? Date())
        let reminderClock = Self.reminderClock(from: task.reminderTime)
        draftTask = task
        self.isNewTask = isNewTask
        _taskID = State(initialValue: isNewTask ? nil : task.id)
        _title = State(initialValue: task.title)
        _note = State(initialValue: task.note)
        _dueDate = State(initialValue: task.dueDate ?? Date())
        _dueDateEnabled = State(initialValue: task.dueDateEnabled)
        _dueTimeEnabled = State(initialValue: task.dueTimeEnabled)
        _dueTimeZone = State(initialValue: task.dueTimeZone ?? TimeZone.current.identifier)
        _urgent = State(initialValue: TaskUrgentAlarmPreferences.isEnabled(for: task))
        _expandedDateTimePicker = State(initialValue: nil)
        _priority = State(initialValue: task.priority)
        _selectedColumnID = State(initialValue: task.columnID ?? "")
        _subtasks = State(initialValue: task.subtasks ?? [])
        _repeatChoice = State(initialValue: repeatDraft.choice)
        _customRepeatCount = State(initialValue: repeatDraft.count)
        _customRepeatUnit = State(initialValue: repeatDraft.unit)
        _customWeekdays = State(initialValue: repeatDraft.weekdays)
        _repeatHasEnd = State(initialValue: task.recurrence?.untilDate != nil)
        _repeatEndDate = State(
            initialValue: task.recurrence?.untilDate ?? task.dueDate ?? Date()
        )
        _reminders = State(initialValue: task.reminders ?? [])
        _reminderTime = State(initialValue: reminderClock)
        _images = State(initialValue: task.images ?? [])
        _documents = State(initialValue: task.documents ?? [])
    }

    private var task: TaskItem? {
        if let taskID { return model.task(withID: taskID) }
        return isNewTask ? draftTask : nil
    }
    private var board: Board? { task.flatMap { model.board(withID: $0.boardID) } }
    private var orderedColumns: [BoardColumn] {
        board?.columns.sorted { $0.order < $1.order } ?? []
    }
    private var selectedDueTimeZone: TimeZone {
        TimeZone(identifier: dueTimeZone) ?? .current
    }

    private var dueDateControlBinding: Binding<Bool> {
        Binding(
            get: { dueDateEnabled },
            set: { setDueDateEnabled($0) }
        )
    }

    private var dueTimeControlBinding: Binding<Bool> {
        Binding(
            get: { dueTimeEnabled },
            set: { setDueTimeEnabled($0) }
        )
    }

    private var urgentControlBinding: Binding<Bool> {
        Binding(
            get: { urgent },
            set: { setUrgent($0) }
        )
    }

    private var dueDateSummary: String {
        var calendar = Calendar.current
        calendar.timeZone = dueTimeEnabled ? selectedDueTimeZone : .current
        if calendar.isDateInToday(dueDate) { return "Today" }
        if calendar.isDateInTomorrow(dueDate) { return "Tomorrow" }

        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: dueDate)
    }

    private var dueTimeSummary: String {
        let formatter = DateFormatter()
        formatter.timeZone = selectedDueTimeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: dueDate)
    }

    private var dueTimeZoneSummary: String {
        guard let city = dueTimeZone.split(separator: "/").last else {
            return selectedDueTimeZone.localizedName(for: .generic, locale: .current) ?? dueTimeZone
        }
        return city.replacingOccurrences(of: "_", with: " ")
    }

    private var canSave: Bool {
        guard !isUploadingAttachment else { return false }
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if dueDateEnabled, dueDate.timeIntervalSince1970 <= 0 { return false }
        if dueDateEnabled, repeatChoice == .custom,
           customRepeatUnit == .selectedWeekdays, customWeekdays.isEmpty { return false }
        if dueDateEnabled, repeatChoice != .never, repeatHasEnd,
           Calendar.current.startOfDay(for: repeatEndDate) < Calendar.current.startOfDay(for: dueDate) { return false }
        if board?.kind == .list, selectedColumnID.isEmpty { return false }
        return task != nil
    }

    var body: some View {
        NavigationStack {
            Group {
                if task == nil {
                    ContentUnavailableView(
                        "Task unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text("It may have been deleted on another device.")
                    )
                } else {
                    editorForm
                }
            }
            .navigationTitle(taskID == nil ? "New Task" : "Edit Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isUploadingAttachment)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        guard persistChanges() else { return }
                        showingTaskShare = true
                    } label: {
                        Image(systemName: "paperplane")
                    }
                    .disabled(!canSave)
                    .accessibilityLabel("Send task")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(!canSave)
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .interactiveDismissDisabled(isUploadingAttachment)
        .confirmationDialog(
            "Delete recurring task?",
            isPresented: $confirmingRecurringDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete This Task", role: .destructive) {
                deleteTask(scope: .single)
            }
            Button("Delete This and Future Tasks", role: .destructive) {
                deleteTask(scope: .thisAndFuture)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Choose whether to delete only this occurrence or end the recurring series here.")
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.data],
            allowsMultipleSelection: true,
            onCompletion: handleFileImport
        )
        .photosPicker(
            isPresented: $showingPhotoLibrary,
            selection: $selectedPhotos,
            maxSelectionCount: 5,
            matching: .images
        )
        .fullScreenCover(isPresented: $showingCamera) {
            TaskAttachmentCameraPicker(
                onCapture: { image in
                    showingCamera = false
                    Task { await addCapturedPhoto(image) }
                },
                onCancel: {
                    showingCamera = false
                }
            )
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $showingDocumentScanner) {
            TaskAttachmentDocumentScanner(
                onScan: { pages in
                    showingDocumentScanner = false
                    Task { await addScannedDocument(pages) }
                },
                onCancel: {
                    showingDocumentScanner = false
                },
                onError: { error in
                    showingDocumentScanner = false
                    attachmentError = error.localizedDescription
                }
            )
            .ignoresSafeArea()
        }
        .alert(
            "Attachment unavailable",
            isPresented: Binding(
                get: { attachmentError != nil },
                set: { if !$0 { attachmentError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { attachmentError = nil }
        } message: {
            Text(attachmentError ?? "The attachment could not be added.")
        }
        .alert("Urgent alarms are off", isPresented: $showingUrgentAlarmUnavailable) {
            Button("Open Settings") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Allow Taskify to schedule alarms in iOS Settings, then turn Urgent on again.")
        }
        .sheet(isPresented: $showingTimeZonePicker) {
            TimeZonePickerSheet(
                selection: Binding(
                    get: { dueTimeZone },
                    set: { changeDueTimeZone(to: $0) }
                ),
                referenceDate: dueDate
            )
        }
        .sheet(isPresented: $showingTaskShare) {
            if let taskID {
                TaskShareSheet(taskID: taskID)
                    .environment(model)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
        .onAppear {
            guard isNewTask, !didAutoFocusTitle else { return }
            didAutoFocusTitle = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                titleIsFocused = true
            }
        }
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            Task { await addPhotos(items) }
        }
    }

    private var editorForm: some View {
        Form {
            Section("Task") {
                TextField("Title", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($titleIsFocused)
                    .accessibilityIdentifier("Title")

                notesAndAttachmentControl
                attachmentRows
                subtasksEditor

                Picker(selection: $priority) {
                    Text("None").tag(TaskPriority?.none)
                    ForEach(TaskPriority.allCases, id: \.rawValue) { value in
                        Text(value.editorLabel).tag(Optional(value))
                    }
                } label: {
                    Label("Priority", systemImage: "flag")
                }
                // .navigationLink gives the PWA's label -> value -> chevron row for free, rather
                // than the segmented control that sat in its own section before.
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("task-editor-priority")
            }

            Section {
                dateTimeControlRow(
                    title: "Date",
                    systemImage: "calendar",
                    summary: dueDateEnabled ? dueDateSummary : nil,
                    isOn: dueDateControlBinding,
                    accessibilityIdentifier: "task-editor-date-toggle",
                    action: toggleDatePickerExpansion
                )

                if dueDateEnabled, expandedDateTimePicker == .date {
                    DatePicker(
                        "Date",
                        selection: $dueDate,
                        displayedComponents: .date
                    )
                    .labelsHidden()
                    .datePickerStyle(.graphical)
                    .environment(\.timeZone, dueTimeEnabled ? selectedDueTimeZone : .current)
                    .accessibilityIdentifier("task-editor-date-picker")
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                dateTimeControlRow(
                    title: "Time",
                    systemImage: "clock",
                    summary: dueTimeEnabled ? dueTimeSummary : nil,
                    isOn: dueTimeControlBinding,
                    accessibilityIdentifier: "task-editor-time-toggle",
                    action: toggleTimePickerExpansion
                )

                if dueTimeEnabled, expandedDateTimePicker == .time {
                    DatePicker(
                        "Time",
                        selection: $dueDate,
                        displayedComponents: .hourAndMinute
                    )
                    .labelsHidden()
                    .datePickerStyle(.wheel)
                    .environment(\.timeZone, selectedDueTimeZone)
                    .frame(maxWidth: .infinity, minHeight: 160, maxHeight: 180)
                    .clipped()
                    .accessibilityIdentifier("task-editor-time-picker")
                    .transition(.opacity.combined(with: .move(edge: .top)))

                    Button {
                        showingTimeZonePicker = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "globe")
                                .foregroundStyle(.secondary)
                                .frame(width: 24)
                            Text("Time Zone")
                            Spacer(minLength: 8)
                            Text(dueTimeZoneSummary)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("task-editor-time-zone-row")
                }

                if #available(iOS 26.0, *) {
                    HStack(spacing: 12) {
                        Image(systemName: "alarm.waves.left.and.right")
                            .foregroundStyle(.secondary)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Urgent")
                            if urgent {
                                Text("Alarm on: Taskify")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Toggle("Urgent", isOn: urgentControlBinding)
                            .labelsHidden()
                            .accessibilityIdentifier("task-editor-urgent-toggle")
                    }
                }
            } header: {
                Text("Date & Time")
            } footer: {
                if #available(iOS 26.0, *) {
                    Text(
                        urgent
                            ? "Alarms can sound through Silent Mode and Focus."
                            : "Mark this task as urgent to set an alarm."
                    )
                }
            }

            if dueDateEnabled {
                schedulingSection
            }

            if board?.kind == .list {
                Section("List") {
                    Picker("List", selection: $selectedColumnID) {
                        ForEach(orderedColumns) { column in
                            Text(column.name).tag(column.id)
                        }
                    }
                }
            }

            if taskID != nil {
                Section {
                    Button("Delete Task", role: .destructive) {
                        if task?.recurrence?.isActive == true {
                            confirmingRecurringDeletion = true
                        } else {
                            deleteTask(scope: .single)
                        }
                    }
                }
            }
        }
    }

    private func deleteTask(scope: TaskDeletionScope) {
        guard let taskID else { return }
        model.deleteTask(taskID, scope: scope)
        dismiss()
    }

    private func save() {
        guard persistChanges() else { return }
        dismiss()
    }

    private func dateTimeControlRow(
        title: String,
        systemImage: String,
        summary: String?,
        isOn: Binding<Bool>,
        accessibilityIdentifier: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Button(action: action) {
                HStack(spacing: 12) {
                    Image(systemName: systemImage)
                        .foregroundStyle(.secondary)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .foregroundStyle(.primary)
                        if let summary {
                            Text(summary)
                                .font(.subheadline)
                                .foregroundStyle(TaskifyTheme.accent)
                        }
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task-editor-\(title.lowercased())-row")

            Toggle(title, isOn: isOn)
                .labelsHidden()
                .accessibilityIdentifier(accessibilityIdentifier)
        }
    }

    private func setDueDateEnabled(_ enabled: Bool) {
        titleIsFocused = false
        withAnimation(.snappy(duration: 0.24)) {
            dueDateEnabled = enabled
            if enabled {
                expandedDateTimePicker = .date
            } else {
                dueTimeEnabled = false
                urgent = false
                expandedDateTimePicker = nil
            }
        }
    }

    private func setDueTimeEnabled(_ enabled: Bool) {
        titleIsFocused = false
        withAnimation(.snappy(duration: 0.24)) {
            dueTimeEnabled = enabled
            if enabled {
                dueDateEnabled = true
                expandedDateTimePicker = .time
            } else {
                urgent = false
                if expandedDateTimePicker == .time {
                    expandedDateTimePicker = nil
                }
            }
        }
    }

    private func setUrgent(_ enabled: Bool) {
        titleIsFocused = false
        withAnimation(.snappy(duration: 0.24)) {
            if enabled, !dueTimeEnabled {
                let currentTimeZone = TimeZone.current
                let selectedDate = dueDateEnabled ? dueDate : Date()
                dueDate = TaskifyUrgentAlarmContract.defaultDueDate(
                    for: selectedDate,
                    timeZone: currentTimeZone
                )
                dueTimeZone = currentTimeZone.identifier
                dueDateEnabled = true
                dueTimeEnabled = true
            }
            urgent = enabled
            if enabled {
                expandedDateTimePicker = nil
            }
        }
        requestUrgentAlarmAuthorizationIfNeeded(enabled: enabled)
    }

    private func toggleDatePickerExpansion() {
        guard dueDateEnabled else {
            setDueDateEnabled(true)
            return
        }
        titleIsFocused = false
        withAnimation(.snappy(duration: 0.24)) {
            expandedDateTimePicker = expandedDateTimePicker == .date ? nil : .date
        }
    }

    private func toggleTimePickerExpansion() {
        guard dueTimeEnabled else {
            setDueTimeEnabled(true)
            return
        }
        titleIsFocused = false
        withAnimation(.snappy(duration: 0.24)) {
            expandedDateTimePicker = expandedDateTimePicker == .time ? nil : .time
        }
    }

    /// Keep the visible wall-clock due time stable while changing the zone it belongs to.
    private func changeDueTimeZone(to newIdentifier: String) {
        guard newIdentifier != dueTimeZone,
              let newTimeZone = TimeZone(identifier: newIdentifier) else { return }
        var oldCalendar = Calendar(identifier: .gregorian)
        oldCalendar.timeZone = selectedDueTimeZone
        let components = oldCalendar.dateComponents(
            [.era, .year, .month, .day, .hour, .minute, .second],
            from: dueDate
        )
        var newCalendar = Calendar(identifier: .gregorian)
        newCalendar.timeZone = newTimeZone
        if let translatedDate = newCalendar.date(from: components) {
            dueDate = translatedDate
        }
        dueTimeZone = newIdentifier
    }

    @discardableResult
    private func persistChanges() -> Bool {
        let normalizedDueDate: Date?
        if dueDateEnabled {
            normalizedDueDate = dueTimeEnabled ? dueDate : Calendar.current.startOfDay(for: dueDate)
        } else {
            normalizedDueDate = nil
        }

        let columnID = board?.kind == .list ? selectedColumnID : task?.columnID
        let normalizedUrgent = dueDateEnabled && dueTimeEnabled && urgent
        if let taskID {
            return model.updateTask(
                taskID: taskID,
                title: title,
                note: note,
                dueDate: normalizedDueDate,
                dueDateEnabled: dueDateEnabled,
                dueTimeEnabled: dueTimeEnabled,
                dueTimeZone: dueTimeZone,
                urgent: normalizedUrgent,
                priority: priority,
                columnID: columnID,
                subtasks: subtasks,
                recurrence: makeRecurrence(),
                reminders: reminders,
                reminderTime: dueTimeEnabled ? nil : formattedReminderTime,
                images: images,
                documents: documents
            )
        }

        guard let created = model.addDetailedTask(
            id: draftTask.id,
            title: title,
            note: note,
            boardID: draftTask.boardID,
            columnID: columnID,
            dueDate: normalizedDueDate,
            dueDateEnabled: dueDateEnabled,
            dueTimeEnabled: dueTimeEnabled,
            dueTimeZone: dueTimeZone,
            urgent: normalizedUrgent,
            priority: priority,
            subtasks: subtasks,
            recurrence: makeRecurrence(),
            reminders: reminders,
            reminderTime: dueTimeEnabled ? nil : formattedReminderTime,
            images: images,
            documents: documents
        ) else { return false }
        taskID = created.id
        return true
    }

    private func requestUrgentAlarmAuthorizationIfNeeded(enabled: Bool) {
        guard enabled else { return }
        Task {
            let authorized = await model.requestUrgentAlarmAuthorization()
            guard !authorized else { return }
            urgent = false
            showingUrgentAlarmUnavailable = true
        }
    }

    private func hasMedia(_ task: TaskItem) -> Bool {
        !(task.images ?? []).isEmpty ||
            !(task.documents ?? []).isEmpty ||
            TaskContentLinks.firstURL(title: task.title, note: task.note) != nil
    }

    private var attachmentPreviewTask: TaskItem? {
        guard var preview = task else { return nil }
        preview.title = title
        preview.note = note
        preview.images = images.isEmpty ? nil : images
        preview.documents = documents.isEmpty ? nil : documents
        return preview
    }

    private var notesAndAttachmentControl: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Notes", text: $note, axis: .vertical)
                .lineLimit(3...8)

            HStack {
                Spacer(minLength: 0)
                attachmentMenu
            }
        }
        .padding(.vertical, 2)
    }

    private var attachmentMenu: some View {
        Menu {
            Button {
                titleIsFocused = false
                showingCamera = true
            } label: {
                Label("Capture a Photo", systemImage: "camera")
            }
            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            .accessibilityIdentifier("task-editor-attachment-camera")

            Button {
                titleIsFocused = false
                showingDocumentScanner = true
            } label: {
                Label("Scan a Document", systemImage: "doc.viewfinder")
            }
            .disabled(!VNDocumentCameraViewController.isSupported)
            .accessibilityIdentifier("task-editor-attachment-scan")

            Button {
                titleIsFocused = false
                showingPhotoLibrary = true
            } label: {
                Label("Choose from Photo Library", systemImage: "photo.on.rectangle")
            }
            .accessibilityIdentifier("task-editor-attachment-library")

            Button {
                titleIsFocused = false
                showingFileImporter = true
            } label: {
                Label("Choose a File", systemImage: "folder")
            }
            .accessibilityIdentifier("task-editor-attachment-file")
        } label: {
            Label("Attach", systemImage: "paperclip")
        }
        .buttonStyle(.bordered)
        .disabled(isUploadingAttachment)
        .accessibilityIdentifier("task-editor-attachment-menu")
    }

    @ViewBuilder
    private var attachmentRows: some View {
        if let preview = attachmentPreviewTask, hasMedia(preview) {
            TaskMediaView(
                task: preview,
                boardID: board?.effectiveNostrBoardID ?? preview.boardID
            )
        }

        if isUploadingAttachment {
            HStack(spacing: 12) {
                ProgressView()
                Text(attachmentStatus ?? "Encrypting attachment…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }

        ForEach(Array(images.enumerated()), id: \.offset) { index, _ in
            HStack {
                Label("Synced image \(index + 1)", systemImage: "photo")
                Spacer()
                Button(role: .destructive) {
                    images.remove(at: index)
                } label: {
                    Image(systemName: "trash")
                }
                .disabled(isUploadingAttachment)
                .accessibilityLabel("Remove image \(index + 1)")
            }
        }

        ForEach(documents) { document in
            HStack(spacing: 10) {
                Image(systemName: attachmentIcon(for: document.kind))
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(document.name)
                        .lineLimit(1)
                    Text(attachmentDetail(document))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(role: .destructive) {
                    documents.removeAll { $0.id == document.id }
                } label: {
                    Image(systemName: "trash")
                }
                .disabled(isUploadingAttachment)
                .accessibilityLabel("Remove \(document.name)")
            }
        }
    }

    private var subtasksEditor: some View {
        DisclosureGroup(isExpanded: $subtasksExpanded) {
            if subtasks.isEmpty {
                Text("Break this task into smaller steps.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            ForEach($subtasks) { $subtask in
                HStack(spacing: 10) {
                    Button {
                        subtask.completed.toggle()
                    } label: {
                        Image(systemName: subtask.completed ? "checkmark.circle.fill" : "circle")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(subtask.completed ? "Mark subtask incomplete" : "Complete subtask")

                    TextField("Subtask", text: $subtask.title)
                        .strikethrough(subtask.completed)

                    Button(role: .destructive) {
                        subtasks.removeAll { $0.id == subtask.id }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove subtask")
                }
            }

            Button {
                subtasks.append(TaskSubtask(title: ""))
            } label: {
                Label("Add subtask", systemImage: "plus.circle.fill")
            }
        } label: {
            HStack(spacing: 10) {
                Label(
                    subtasksExpanded ? "Hide subtasks" : "Show subtasks",
                    systemImage: "list.bullet"
                )
                Spacer(minLength: 8)
                Text("\(subtasks.count)")
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("task-editor-subtasks")
    }

    @MainActor
    private func addPhotos(_ items: [PhotosPickerItem]) async {
        guard let boardID = board?.effectiveNostrBoardID else {
            attachmentError = "This task's board is unavailable."
            selectedPhotos = []
            return
        }

        isUploadingAttachment = true
        defer {
            isUploadingAttachment = false
            attachmentStatus = nil
            selectedPhotos = []
        }

        do {
            for (index, item) in items.enumerated() {
                attachmentStatus = "Preparing photo \(index + 1) of \(items.count)…"
                guard let sourceData = try await item.loadTransferable(type: Data.self),
                      sourceData.count <= TaskDocumentContract.maximumUploadBytes,
                      let image = UIImage(data: sourceData),
                      let jpegData = image.jpegData(compressionQuality: 0.88) else {
                    throw TaskAttachmentUploadError.unsupportedFile
                }
                let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
                let name = "task-photo-\(timestamp)-\(index + 1).jpg"
                attachmentStatus = "Encrypting and uploading photo \(index + 1) of \(items.count)…"
                let document = try await TaskAttachmentUploadService.shared.uploadDocument(
                    data: jpegData,
                    name: name,
                    mimeType: "image/jpeg",
                    boardID: boardID
                )
                documents.append(document)
            }
        } catch {
            attachmentError = error.localizedDescription
        }
    }

    @MainActor
    private func addCapturedPhoto(_ image: UIImage) async {
        guard let boardID = board?.effectiveNostrBoardID else {
            attachmentError = "This task's board is unavailable."
            return
        }
        guard let jpegData = image.jpegData(compressionQuality: 0.88) else {
            attachmentError = TaskAttachmentUploadError.unsupportedFile.localizedDescription
            return
        }

        isUploadingAttachment = true
        attachmentStatus = "Encrypting and uploading captured photo…"
        defer {
            isUploadingAttachment = false
            attachmentStatus = nil
        }

        do {
            let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
            let document = try await TaskAttachmentUploadService.shared.uploadDocument(
                data: jpegData,
                name: "task-photo-\(timestamp).jpg",
                mimeType: "image/jpeg",
                boardID: boardID
            )
            documents.append(document)
        } catch {
            attachmentError = error.localizedDescription
        }
    }

    @MainActor
    private func addScannedDocument(_ pages: [UIImage]) async {
        guard !pages.isEmpty else { return }
        guard let boardID = board?.effectiveNostrBoardID else {
            attachmentError = "This task's board is unavailable."
            return
        }

        isUploadingAttachment = true
        attachmentStatus = "Preparing \(pages.count == 1 ? "scanned page" : "\(pages.count) scanned pages")…"
        defer {
            isUploadingAttachment = false
            attachmentStatus = nil
        }

        do {
            let pdfData = try TaskAttachmentPDFRenderer.pdfData(from: pages)
            let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
            attachmentStatus = "Encrypting and uploading scanned document…"
            let document = try await TaskAttachmentUploadService.shared.uploadDocument(
                data: pdfData,
                name: "task-scan-\(timestamp).pdf",
                mimeType: "application/pdf",
                boardID: boardID
            )
            documents.append(document)
        } catch {
            attachmentError = error.localizedDescription
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard !urls.isEmpty else { return }
            Task { await addFiles(urls) }
        case .failure(let error):
            attachmentError = error.localizedDescription
        }
    }

    @MainActor
    private func addFiles(_ urls: [URL]) async {
        guard let boardID = board?.effectiveNostrBoardID else {
            attachmentError = "This task's board is unavailable."
            return
        }

        isUploadingAttachment = true
        defer {
            isUploadingAttachment = false
            attachmentStatus = nil
        }

        do {
            for (index, url) in urls.enumerated() {
                attachmentStatus = "Encrypting and uploading \(url.lastPathComponent) (\(index + 1) of \(urls.count))…"
                let document = try await TaskAttachmentUploadService.shared.uploadDocument(
                    fileURL: url,
                    boardID: boardID
                )
                documents.append(document)
            }
        } catch {
            attachmentError = error.localizedDescription
        }
    }

    private func attachmentDetail(_ document: TaskDocument) -> String {
        let kind = document.kind.uppercased()
        guard let size = document.size else { return kind }
        return "\(kind) · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))"
    }

    private func attachmentIcon(for kind: String) -> String {
        switch kind.lowercased() {
        case "png", "jpg", "jpeg", "webp", "gif": "photo"
        case "mp3", "aac", "m4a", "wav": "waveform"
        case "mp4", "mov", "webm": "video"
        case "pdf": "doc.richtext"
        default: "doc"
        }
    }

    private var schedulingSection: some View {
        Section {
            Menu {
                Button {
                    repeatChoice = .never
                } label: {
                    menuChoiceLabel("Never", selected: repeatChoice == .never)
                }

                Divider()

                ForEach(RepeatChoice.standardChoices) { choice in
                    Button {
                        repeatChoice = choice
                    } label: {
                        menuChoiceLabel(choice.label, selected: repeatChoice == choice)
                    }
                }

                Divider()

                Button {
                    repeatChoice = .custom
                } label: {
                    menuChoiceLabel("Custom", selected: repeatChoice == .custom)
                }
            } label: {
                schedulingMenuLabel(
                    title: "Repeat",
                    systemImage: "repeat",
                    summary: repeatChoice.displayLabel
                )
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .accessibilityIdentifier("task-editor-repeat-menu")

            if repeatChoice == .custom {
                Menu {
                    ForEach(CustomRepeatUnit.selectableCases) { unit in
                        Button {
                            customRepeatUnit = unit
                        } label: {
                            menuChoiceLabel(unit.label, selected: customRepeatUnit == unit)
                        }
                    }
                } label: {
                    schedulingMenuLabel(
                        title: "Frequency",
                        systemImage: "calendar.badge.clock",
                        summary: customRepeatUnit.displayLabel
                    )
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("task-editor-custom-repeat-frequency-menu")

                if customRepeatUnit == .selectedWeekdays {
                    HStack(spacing: 5) {
                        ForEach(0..<7, id: \.self) { weekday in
                            Button {
                                if customWeekdays.contains(weekday) {
                                    customWeekdays.remove(weekday)
                                } else {
                                    customWeekdays.insert(weekday)
                                }
                            } label: {
                                Text(RepeatDraft.weekdaySymbols[weekday])
                                    .font(.caption2.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                                    .background(
                                        customWeekdays.contains(weekday) ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                        in: Circle()
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(RepeatDraft.fullWeekdaySymbols[weekday])
                        }
                    }
                } else if customRepeatUnit == .hour {
                    Text("This older hourly recurrence is preserved. Choose a new frequency to replace it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Stepper(
                        "Every \(customRepeatCount) \(customRepeatUnit.unitLabel(count: customRepeatCount))",
                        value: $customRepeatCount,
                        in: 1...60
                    )
                }
            }

            if repeatChoice != .never {
                Menu {
                    Button {
                        repeatHasEnd = false
                    } label: {
                        menuChoiceLabel("Never", selected: !repeatHasEnd)
                    }
                    Button {
                        repeatHasEnd = true
                        let firstValidDate = Calendar.current.startOfDay(for: dueDate)
                        if Calendar.current.startOfDay(for: repeatEndDate) < firstValidDate {
                            repeatEndDate = firstValidDate
                        }
                    } label: {
                        menuChoiceLabel("On Date", selected: repeatHasEnd)
                    }
                } label: {
                    schedulingMenuLabel(
                        title: "End Repeat",
                        systemImage: "repeat.badge.xmark",
                        summary: repeatHasEnd ? "On Date" : "Never"
                    )
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("task-editor-end-repeat-menu")

                if repeatHasEnd {
                    DatePicker(
                        "End Date",
                        selection: $repeatEndDate,
                        in: Calendar.current.startOfDay(for: dueDate)...,
                        displayedComponents: .date
                    )
                    .datePickerStyle(.compact)
                    .accessibilityIdentifier("task-editor-repeat-end-date")
                }
            }

            ForEach(Array(0...reminders.count), id: \.self) { index in
                reminderEditorRow(at: index)
            }
        }
    }

    @ViewBuilder
    private func reminderEditorRow(at index: Int) -> some View {
        let choice = reminderChoice(at: index)

        Menu {
            Button {
                selectEarlyReminder(.none, at: index)
            } label: {
                menuChoiceLabel("None", selected: choice == .none)
            }

            Divider()

            ForEach(EarlyReminderChoice.standardChoices) { option in
                Button {
                    selectEarlyReminder(option, at: index)
                } label: {
                    menuChoiceLabel(option.label, selected: choice == option)
                }
                .disabled(reminderChoiceIsUsed(option, excluding: index))
            }

            Divider()

            Button {
                selectEarlyReminder(.custom, at: index)
            } label: {
                menuChoiceLabel("Custom", selected: choice == .custom)
            }
        } label: {
            schedulingMenuLabel(
                title: reminderRowTitle(at: index),
                systemImage: "bell",
                summary: reminderSummary(at: index)
            )
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityIdentifier(
            index == 0 ? "task-editor-early-reminder-menu" : "task-editor-alert-menu-\(index)"
        )

        if choice == .custom, index < reminders.count {
            VStack(spacing: 8) {
                Text(reminderSummary(at: index))
                    .font(.body)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .trailing)

                Divider()

                HStack(spacing: 0) {
                    Picker("Amount", selection: customReminderCountBinding(at: index)) {
                        ForEach(1...999, id: \.self) { count in
                            Text("\(count)").tag(count)
                        }
                    }
                    .pickerStyle(.wheel)

                    Picker("Unit", selection: customReminderUnitBinding(at: index)) {
                        ForEach(CustomReminderUnit.allCases) { unit in
                            Text(unit.label).tag(unit)
                        }
                    }
                    .pickerStyle(.wheel)
                }
                .labelsHidden()
                .frame(maxWidth: .infinity, minHeight: 150, maxHeight: 170)
                .clipped()
                .accessibilityIdentifier("task-editor-custom-reminder-picker-\(index)")
            }
        }
    }

    private func schedulingMenuLabel(title: String, systemImage: String, summary: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            Text(title)
            Spacer(minLength: 8)
            Text(summary)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .allowsTightening(true)
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func menuChoiceLabel(_ title: String, selected: Bool) -> some View {
        if selected {
            Label(title, systemImage: "checkmark")
        } else {
            Text(title)
        }
    }

    private func reminderChoice(at index: Int) -> EarlyReminderChoice {
        guard reminders.indices.contains(index) else { return .none }
        let reminder = reminders[index]
        if reminder.rawValue.hasPrefix("custom-") { return .custom }
        guard let minutes = reminder.minutesBefore, minutes > 0 else { return .legacy }
        return EarlyReminderChoice.standardChoices.first(where: { $0.minutesBefore == minutes }) ?? .custom
    }

    private func reminderSummary(at index: Int) -> String {
        guard reminders.indices.contains(index) else { return "None" }
        let choice = reminderChoice(at: index)
        if EarlyReminderChoice.standardChoices.contains(choice) {
            return choice.label
        }
        return reminders[index].label
    }

    private func reminderRowTitle(at index: Int) -> String {
        guard index > 0 else { return "Reminder" }
        let number = index + 1
        let suffix: String
        if (11...13).contains(number % 100) {
            suffix = "th"
        } else {
            switch number % 10 {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(number)\(suffix) Reminder"
    }

    private func reminderChoiceIsUsed(_ choice: EarlyReminderChoice, excluding index: Int) -> Bool {
        guard let minutes = choice.minutesBefore else { return false }
        return reminders.enumerated().contains { offset, reminder in
            offset != index && reminder.minutesBefore == minutes
        }
    }

    private func selectEarlyReminder(_ choice: EarlyReminderChoice, at index: Int) {
        switch choice {
        case .none:
            if reminders.indices.contains(index) {
                reminders.remove(at: index)
            }
        case .custom:
            let existingMinutes = reminders.indices.contains(index) ? reminders[index].minutesBefore : nil
            let draft = CustomReminderDraft(minutesBefore: existingMinutes)
            setReminder(
                TaskReminder(rawValue: "custom-\(draft.count * draft.unit.minutes)"),
                at: index
            )
        case .legacy:
            break
        default:
            guard let minutes = choice.minutesBefore else { return }
            setReminder(TaskReminder(minutesBefore: minutes, dateOnly: !dueTimeEnabled), at: index)
        }
    }

    private func setReminder(_ reminder: TaskReminder, at index: Int) {
        if reminders.indices.contains(index) {
            reminders[index] = reminder
        } else if index == reminders.count {
            reminders.append(reminder)
        }
    }

    private func customReminderCountBinding(at index: Int) -> Binding<Int> {
        Binding(
            get: { customReminderDraft(at: index).count },
            set: { count in
                let unit = customReminderDraft(at: index).unit
                setReminder(TaskReminder(rawValue: "custom-\(count * unit.minutes)"), at: index)
            }
        )
    }

    private func customReminderUnitBinding(at index: Int) -> Binding<CustomReminderUnit> {
        Binding(
            get: { customReminderDraft(at: index).unit },
            set: { unit in
                let count = customReminderDraft(at: index).count
                setReminder(TaskReminder(rawValue: "custom-\(count * unit.minutes)"), at: index)
            }
        )
    }

    private func customReminderDraft(at index: Int) -> CustomReminderDraft {
        let minutes = reminders.indices.contains(index) ? reminders[index].minutesBefore : nil
        return CustomReminderDraft(minutesBefore: minutes)
    }

    private var formattedReminderTime: String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: reminderTime)
        return String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0)
    }

    private func makeRecurrence() -> TaskRecurrence? {
        guard dueDateEnabled, repeatChoice != .never else { return nil }
        let until = repeatHasEnd
            ? Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: repeatEndDate)
            : nil
        let weekday = Calendar.current.component(.weekday, from: dueDate) - 1
        let day = min(max(Calendar.current.component(.day, from: dueDate), 1), 28)
        switch repeatChoice {
        case .never:
            return nil
        case .hourly:
            return .every(1, .hour, until: until)
        case .daily:
            return .daily(until: until)
        case .weekdays:
            return .weekly(days: [1, 2, 3, 4, 5], until: until)
        case .weekends:
            return .weekly(days: [0, 6], until: until)
        case .weekly:
            return .weekly(days: [weekday], until: until)
        case .biweekly:
            return .every(2, .week, until: until)
        case .monthly:
            return .monthlyDay(day: day, until: until)
        case .quarterly:
            return .monthlyDay(day: day, interval: 3, until: until)
        case .semiannual:
            return .monthlyDay(day: day, interval: 6, until: until)
        case .yearly:
            return .monthlyDay(day: day, interval: 12, until: until)
        case .custom:
            switch customRepeatUnit {
            case .hour:
                return .every(customRepeatCount, .hour, until: until)
            case .day:
                return .every(customRepeatCount, .day, until: until)
            case .week:
                return .every(customRepeatCount, .week, until: until)
            case .month:
                return .monthlyDay(day: day, interval: customRepeatCount, until: until)
            case .selectedWeekdays:
                return .weekly(days: customWeekdays.sorted(), until: until)
            }
        }
    }

    private static func reminderClock(from value: String?) -> Date {
        let parts = (value ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) } ?? 0
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }
}

private enum DateTimeEditorExpansion {
    case date
    case time
}

private enum RepeatChoice: String, CaseIterable, Identifiable {
    case never
    case hourly
    case daily
    case weekdays
    case weekends
    case weekly
    case biweekly
    case monthly
    case quarterly
    case semiannual
    case yearly
    case custom

    var id: String { rawValue }

    static let standardChoices: [RepeatChoice] = [
        .daily,
        .weekdays,
        .weekends,
        .weekly,
        .biweekly,
        .monthly,
        .quarterly,
        .semiannual,
        .yearly,
    ]

    var displayLabel: String {
        self == .hourly ? "Hourly (legacy)" : label
    }

    var label: String {
        switch self {
        case .never: "Never"
        case .hourly: "Hourly"
        case .daily: "Daily"
        case .weekdays: "Weekdays"
        case .weekends: "Weekends"
        case .weekly: "Weekly"
        case .biweekly: "Biweekly"
        case .monthly: "Monthly"
        case .quarterly: "Every 3 months"
        case .semiannual: "Every 6 months"
        case .yearly: "Yearly"
        case .custom: "Custom"
        }
    }
}

private enum CustomRepeatUnit: String, CaseIterable, Identifiable {
    case hour
    case day
    case week
    case month
    case selectedWeekdays

    var id: String { rawValue }
    static let selectableCases: [CustomRepeatUnit] = [.day, .week, .month, .selectedWeekdays]

    var displayLabel: String {
        self == .hour ? "Hours (legacy)" : label
    }

    var label: String {
        switch self {
        case .hour: "Hours"
        case .day: "Days"
        case .week: "Weeks"
        case .month: "Months"
        case .selectedWeekdays: "Selected weekdays"
        }
    }

    func unitLabel(count: Int) -> String {
        let singular: String
        switch self {
        case .hour: singular = "hour"
        case .day: singular = "day"
        case .week: singular = "week"
        case .month: singular = "month"
        case .selectedWeekdays: singular = "week"
        }
        return count == 1 ? singular : "\(singular)s"
    }
}

private enum EarlyReminderChoice: String, Identifiable {
    case none
    case fiveMinutes
    case fifteenMinutes
    case thirtyMinutes
    case oneHour
    case twoHours
    case oneDay
    case twoDays
    case oneWeek
    case oneMonth
    case custom
    case legacy

    var id: String { rawValue }

    static let standardChoices: [EarlyReminderChoice] = [
        .fiveMinutes,
        .fifteenMinutes,
        .thirtyMinutes,
        .oneHour,
        .twoHours,
        .oneDay,
        .twoDays,
        .oneWeek,
        .oneMonth,
    ]

    var minutesBefore: Int? {
        switch self {
        case .fiveMinutes: 5
        case .fifteenMinutes: 15
        case .thirtyMinutes: 30
        case .oneHour: 60
        case .twoHours: 120
        case .oneDay: 1_440
        case .twoDays: 2_880
        case .oneWeek: 10_080
        case .oneMonth: 43_200
        case .none, .custom, .legacy: nil
        }
    }

    var label: String {
        switch self {
        case .none: "None"
        case .fiveMinutes: "5 minutes before"
        case .fifteenMinutes: "15 minutes before"
        case .thirtyMinutes: "30 minutes before"
        case .oneHour: "1 hour before"
        case .twoHours: "2 hours before"
        case .oneDay: "1 day before"
        case .twoDays: "2 days before"
        case .oneWeek: "1 week before"
        case .oneMonth: "1 month before"
        case .custom: "Custom"
        case .legacy: "Multiple"
        }
    }
}

private enum CustomReminderUnit: String, CaseIterable, Identifiable {
    case minute
    case hour
    case day
    case week
    case month

    var id: String { rawValue }

    var label: String {
        switch self {
        case .minute: "Minute"
        case .hour: "Hour"
        case .day: "Day"
        case .week: "Week"
        case .month: "Month"
        }
    }

    var minutes: Int {
        switch self {
        case .minute: 1
        case .hour: 60
        case .day: 1_440
        case .week: 10_080
        case .month: 43_200
        }
    }
}

private struct CustomReminderDraft {
    let count: Int
    let unit: CustomReminderUnit

    init(minutesBefore: Int?) {
        let minutes = max(1, abs(minutesBefore ?? 60))
        for candidate in [
            CustomReminderUnit.month,
            .week,
            .day,
            .hour,
            .minute,
        ] where minutes.isMultiple(of: candidate.minutes) {
            let candidateCount = minutes / candidate.minutes
            if (1...999).contains(candidateCount) {
                count = candidateCount
                unit = candidate
                return
            }
        }

        count = min(minutes, 999)
        unit = .minute
    }
}

private struct RepeatDraft {
    static let weekdaySymbols = ["S", "M", "T", "W", "T", "F", "S"]
    static let fullWeekdaySymbols = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    let choice: RepeatChoice
    let count: Int
    let unit: CustomRepeatUnit
    let weekdays: Set<Int>

    init(recurrence: TaskRecurrence?, dueDate: Date) {
        let dueWeekday = Calendar.current.component(.weekday, from: dueDate) - 1
        count = {
            switch recurrence {
            case .every(let count, _, _): max(1, count)
            case .monthlyDay(_, let interval, _): max(1, interval ?? 1)
            default: 1
            }
        }()
        unit = {
            switch recurrence {
            case .every(_, .hour, _): .hour
            case .every(_, .day, _): .day
            case .every(_, .week, _): .week
            case .monthlyDay: .month
            case .weekly: .selectedWeekdays
            default: .day
            }
        }()
        if case .weekly(let days, _) = recurrence {
            weekdays = Set(days.filter { (0...6).contains($0) })
        } else {
            weekdays = [dueWeekday]
        }

        switch recurrence {
        case nil, .some(.none):
            choice = .never
        case .daily:
            choice = .daily
        case .weekly(let days, _):
            let normalized = Set(days)
            if normalized == Set([1, 2, 3, 4, 5]) {
                choice = .weekdays
            } else if normalized == Set([0, 6]) {
                choice = .weekends
            } else if normalized == Set([dueWeekday]) {
                choice = .weekly
            } else {
                choice = .custom
            }
        case .every(let count, let unit, _):
            if count == 1, unit == .hour {
                choice = .hourly
            } else if count == 2, unit == .week {
                choice = .biweekly
            } else {
                choice = .custom
            }
        case .monthlyDay(_, let interval, _):
            switch interval ?? 1 {
            case 1: choice = .monthly
            case 3: choice = .quarterly
            case 6: choice = .semiannual
            case 12: choice = .yearly
            default: choice = .custom
            }
        }
    }
}

private extension TaskPriority {
    var editorLabel: String {
        switch self {
        case .low: "Low !"
        case .medium: "Medium !!"
        case .high: "High !!!"
        }
    }
}
