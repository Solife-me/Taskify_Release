import PhotosUI
import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers
import UIKit

struct TaskEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let taskID: String

    @State private var title: String
    @State private var note: String
    @State private var dueDate: Date
    @State private var dueDateEnabled: Bool
    @State private var dueTimeEnabled: Bool
    @State private var dueTimeZone: String
    @State private var showingTimeZonePicker = false
    @State private var priority: TaskPriority?
    @State private var selectedColumnID: String
    @State private var subtasks: [TaskSubtask]
    @State private var repeatChoice: RepeatChoice
    @State private var customRepeatCount: Int
    @State private var customRepeatUnit: CustomRepeatUnit
    @State private var customWeekdays: Set<Int>
    @State private var repeatHasEnd: Bool
    @State private var repeatEndDate: Date
    @State private var reminders: [TaskReminder]
    @State private var reminderTime: Date
    @State private var customReminderDate: Date
    @State private var showingCustomReminder = false
    @State private var images: [String]
    @State private var documents: [TaskDocument]
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showingFileImporter = false
    @State private var isUploadingAttachment = false
    @State private var attachmentStatus: String?
    @State private var attachmentError: String?
    @State private var showingTaskShare = false

    init(task: TaskItem) {
        let repeatDraft = RepeatDraft(recurrence: task.recurrence, dueDate: task.dueDate ?? Date())
        let reminderClock = Self.reminderClock(from: task.reminderTime)
        let reminderAnchor = task.reminderAnchor() ?? task.dueDate ?? Date()
        taskID = task.id
        _title = State(initialValue: task.title)
        _note = State(initialValue: task.note)
        _dueDate = State(initialValue: task.dueDate ?? Date())
        _dueDateEnabled = State(initialValue: task.dueDateEnabled)
        _dueTimeEnabled = State(initialValue: task.dueTimeEnabled)
        _dueTimeZone = State(initialValue: task.dueTimeZone ?? TimeZone.current.identifier)
        _priority = State(initialValue: task.priority)
        _selectedColumnID = State(initialValue: task.columnID ?? "")
        _subtasks = State(initialValue: task.subtasks ?? [])
        _repeatChoice = State(initialValue: repeatDraft.choice)
        _customRepeatCount = State(initialValue: repeatDraft.count)
        _customRepeatUnit = State(initialValue: repeatDraft.unit)
        _customWeekdays = State(initialValue: repeatDraft.weekdays)
        _repeatHasEnd = State(initialValue: task.recurrence?.untilDate != nil)
        _repeatEndDate = State(
            initialValue: task.recurrence?.untilDate ?? Calendar.current.date(byAdding: .year, value: 1, to: task.dueDate ?? Date())!
        )
        _reminders = State(initialValue: task.reminders ?? [])
        _reminderTime = State(initialValue: reminderClock)
        _customReminderDate = State(initialValue: reminderAnchor.addingTimeInterval(-3_600))
        _images = State(initialValue: task.images ?? [])
        _documents = State(initialValue: task.documents ?? [])
    }

    private var task: TaskItem? { model.task(withID: taskID) }
    private var board: Board? { task.flatMap { model.board(withID: $0.boardID) } }
    private var orderedColumns: [BoardColumn] {
        board?.columns.sorted { $0.order < $1.order } ?? []
    }
    private var selectedDueTimeZone: TimeZone {
        TimeZone(identifier: dueTimeZone) ?? .current
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
            .navigationTitle("Edit Task")
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
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.data],
            allowsMultipleSelection: true,
            onCompletion: handleFileImport
        )
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
            TaskShareSheet(taskID: taskID)
                .environment(model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private var editorForm: some View {
        Form {
            Section("Task") {
                TextField("Title", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                    .accessibilityIdentifier("Title")
                TextField("Notes", text: $note, axis: .vertical)
                    .lineLimit(3...8)
            }

            Section("Priority") {
                Picker("Priority", selection: $priority) {
                    Text("None").tag(TaskPriority?.none)
                    ForEach(TaskPriority.allCases, id: \.rawValue) { value in
                        Text(value.editorLabel).tag(Optional(value))
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Schedule") {
                Toggle("Due date", isOn: $dueDateEnabled)
                if dueDateEnabled {
                    DatePicker("Date", selection: $dueDate, displayedComponents: .date)
                        .environment(\.timeZone, dueTimeEnabled ? selectedDueTimeZone : .current)
                    Toggle("Include time", isOn: $dueTimeEnabled)
                    if dueTimeEnabled {
                        DatePicker("Time", selection: $dueDate, displayedComponents: .hourAndMinute)
                            .environment(\.timeZone, selectedDueTimeZone)
                        Button {
                            showingTimeZonePicker = true
                        } label: {
                            HStack {
                                LabeledContent(
                                    "Time zone",
                                    value: selectedDueTimeZone.localizedName(for: .generic, locale: .current)
                                        ?? dueTimeZone
                                )
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)
                        .font(.caption)
                    }
                }
            }

            if dueDateEnabled {
                recurrenceSection
                remindersSection
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

            attachmentSection

            Section("Subtasks") {
                if subtasks.isEmpty {
                    Text("Break this task into smaller steps.")
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
                    }
                }
                .onDelete { subtasks.remove(atOffsets: $0) }

                Button {
                    subtasks.append(TaskSubtask(title: ""))
                } label: {
                    Label("Add subtask", systemImage: "plus.circle.fill")
                }
            }

            Section {
                Button("Delete Task", role: .destructive) {
                    model.deleteTask(taskID)
                    dismiss()
                }
            }
        }
    }

    private func save() {
        guard persistChanges() else { return }
        dismiss()
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

        return model.updateTask(
            taskID: taskID,
            title: title,
            note: note,
            dueDate: normalizedDueDate,
            dueDateEnabled: dueDateEnabled,
            dueTimeEnabled: dueTimeEnabled,
            dueTimeZone: dueTimeZone,
            priority: priority,
            columnID: board?.kind == .list ? selectedColumnID : task?.columnID,
            subtasks: subtasks,
            recurrence: makeRecurrence(),
            reminders: reminders,
            reminderTime: dueTimeEnabled ? nil : formattedReminderTime,
            images: images,
            documents: documents
        )
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

    private var attachmentSection: some View {
        Section("Attachments & Links") {
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

            HStack(spacing: 12) {
                PhotosPicker(
                    selection: $selectedPhotos,
                    maxSelectionCount: 5,
                    matching: .images
                ) {
                    Label("Add Photos", systemImage: "photo.badge.plus")
                }
                .disabled(isUploadingAttachment)

                Button {
                    showingFileImporter = true
                } label: {
                    Label("Add Files", systemImage: "paperclip")
                }
                .disabled(isUploadingAttachment)
            }
            .buttonStyle(.bordered)

            Text("New files are encrypted with this board's PWA-compatible key before upload. Removing an item here removes it from the task when you save.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            Task { await addPhotos(items) }
        }
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

    private var recurrenceSection: some View {
        Section("Repeat") {
            Picker("Repeat", selection: $repeatChoice) {
                ForEach(RepeatChoice.allCases) { choice in
                    Text(choice.label).tag(choice)
                }
            }

            if repeatChoice == .custom {
                Picker("Frequency", selection: $customRepeatUnit) {
                    ForEach(CustomRepeatUnit.allCases) { unit in
                        Text(unit.label).tag(unit)
                    }
                }

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
                } else {
                    Stepper(
                        "Every \(customRepeatCount) \(customRepeatUnit.unitLabel(count: customRepeatCount))",
                        value: $customRepeatCount,
                        in: 1...60
                    )
                }
            }

            if repeatChoice != .never {
                Toggle("End repeat", isOn: $repeatHasEnd)
                if repeatHasEnd {
                    DatePicker("End date", selection: $repeatEndDate, displayedComponents: .date)
                }
            }
        }
    }

    private var remindersSection: some View {
        Section("Reminders") {
            ForEach(reminderPresets) { reminder in
                Toggle(reminder.label, isOn: reminderBinding(reminder))
            }

            if !dueTimeEnabled {
                DatePicker("Reminder time", selection: $reminderTime, displayedComponents: .hourAndMinute)
                Text("Date-only tasks use your current time zone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ForEach(customReminders) { reminder in
                HStack {
                    Label(reminder.label, systemImage: "bell.badge")
                    Spacer()
                    Button(role: .destructive) {
                        removeReminder(minutesBefore: reminder.minutesBefore)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.plain)
                }
            }

            DisclosureGroup("Custom reminder", isExpanded: $showingCustomReminder) {
                DatePicker(
                    "Notify me",
                    selection: $customReminderDate,
                    displayedComponents: [.date, .hourAndMinute]
                )
                Text(customReminderSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Add custom reminder", action: addCustomReminder)
                    .disabled(customReminderMinutes == nil)
            }

            if !reminders.isEmpty {
                Text("iOS will ask for notification permission when you save.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var reminderPresets: [TaskReminder] {
        dueTimeEnabled ? TaskReminder.timedPresets : TaskReminder.datePresets
    }

    private var presetMinutes: Set<Int> {
        Set(reminderPresets.compactMap(\.minutesBefore))
    }

    private var customReminders: [TaskReminder] {
        reminders
            .filter { reminder in
                guard let minutes = reminder.minutesBefore else { return true }
                return !presetMinutes.contains(minutes)
            }
            .sorted { ($0.minutesBefore ?? 0) < ($1.minutesBefore ?? 0) }
    }

    private func reminderBinding(_ reminder: TaskReminder) -> Binding<Bool> {
        Binding(
            get: {
                reminders.contains { $0.minutesBefore == reminder.minutesBefore }
            },
            set: { selected in
                removeReminder(minutesBefore: reminder.minutesBefore)
                if selected { reminders.append(reminder) }
            }
        )
    }

    private func removeReminder(minutesBefore: Int?) {
        guard let minutesBefore else { return }
        reminders.removeAll { $0.minutesBefore == minutesBefore }
    }

    private var editorReminderAnchor: Date? {
        guard dueDateEnabled else { return nil }
        if dueTimeEnabled { return dueDate }
        let clock = Calendar.current.dateComponents([.hour, .minute], from: reminderTime)
        return Calendar.current.date(
            bySettingHour: clock.hour ?? 9,
            minute: clock.minute ?? 0,
            second: 0,
            of: dueDate
        )
    }

    private var customReminderMinutes: Int? {
        guard let anchor = editorReminderAnchor else { return nil }
        let minutes = Int((anchor.timeIntervalSince(customReminderDate) / 60).rounded())
        guard abs(minutes) <= 99_999_999 else { return nil }
        return minutes
    }

    private var customReminderSummary: String {
        guard let minutes = customReminderMinutes else { return "Choose a valid reminder date and time." }
        return TaskReminder(minutesBefore: minutes, dateOnly: !dueTimeEnabled).label
    }

    private func addCustomReminder() {
        guard let minutes = customReminderMinutes else { return }
        removeReminder(minutesBefore: minutes)
        reminders.append(TaskReminder(minutesBefore: minutes, dateOnly: !dueTimeEnabled))
        showingCustomReminder = false
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
