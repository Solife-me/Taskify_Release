import EventKit
import SwiftUI
import TaskifyCore
import UIKit

struct TaskifyEventEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var details: String
    @State private var location: String
    @State private var boardID: String
    @State private var columnID: String
    @State private var startDate: Date
    @State private var endDate: Date
    @State private var allDay: Bool
    @State private var timeZoneID: String
    @State private var reminders: [TaskReminder]
    @State private var reminderTime: Date
    @State private var showingTimeZonePicker = false
    @State private var repeatChoice: TaskifyEventRepeatChoice
    @State private var repeatHasEnd: Bool
    @State private var repeatEndDate: Date
    @State private var confirmingDeletion = false
    @State private var showingEventShare = false
    @State private var selectedAttendeePublicKeys: Set<String>
    @State private var showingAttendeePicker = false
    let event: TaskifyEvent

    init(event: TaskifyEvent) {
        self.event = event
        let start = event.startDate ?? Date()
        _title = State(initialValue: event.title)
        _details = State(initialValue: event.details ?? "")
        _location = State(initialValue: event.locations?.first ?? "")
        _boardID = State(initialValue: event.boardID ?? "")
        _columnID = State(initialValue: event.columnID ?? "")
        _startDate = State(initialValue: start)
        _endDate = State(initialValue: event.endDate ?? start.addingTimeInterval(60 * 60))
        _allDay = State(initialValue: event.isAllDay)
        _timeZoneID = State(initialValue: event.startTimeZoneID ?? TimeZone.current.identifier)
        _reminders = State(initialValue: event.reminders ?? [])
        _reminderTime = State(initialValue: Self.reminderClock(from: event.reminderTime))
        _repeatChoice = State(initialValue: TaskifyEventRepeatChoice(event.recurrence))
        _repeatHasEnd = State(initialValue: event.recurrence?.untilDate != nil)
        _repeatEndDate = State(
            initialValue: event.recurrence?.untilDate
                ?? Calendar.current.date(byAdding: .month, value: 6, to: start)
                ?? start
        )
        _selectedAttendeePublicKeys = State(initialValue: Set(
            (event.participants ?? []).compactMap {
                NostrPublicKey.parse($0.publicKey)?.hexString
            }
        ))
    }

    private var eventBoards: [Board] {
        model.visibleBoards.filter { $0.kind == .week || $0.kind == .list }
    }

    private var selectedEventBoard: Board? {
        eventBoards.first { $0.id == boardID }
    }

    private var selectedBoardColumns: [BoardColumn] {
        guard selectedEventBoard?.kind == .list else { return [] }
        return selectedEventBoard?.columns.sorted { $0.order < $1.order } ?? []
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    Picker(selection: $boardID) {
                        ForEach(eventBoards) { board in
                            Text(board.name).tag(board.id)
                        }
                    } label: {
                        Label("Board", systemImage: "square.grid.2x2")
                    }
                    .pickerStyle(.navigationLink)
                    if selectedEventBoard?.kind == .list {
                        Picker(selection: $columnID) {
                            ForEach(selectedBoardColumns) { column in
                                Text(column.name).tag(column.id)
                            }
                        } label: {
                            Label("List", systemImage: "list.bullet")
                        }
                        .pickerStyle(.navigationLink)
                    }
                }

                Section("Date & Time") {
                    Toggle(isOn: $allDay) {
                        Label("All-day", systemImage: "calendar")
                    }
                    DatePicker(
                        selection: $startDate,
                        displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                    ) {
                        Label("Starts", systemImage: "calendar")
                    }
                    .environment(\.timeZone, selectedTimeZone)
                    DatePicker(
                        selection: $endDate,
                        in: startDate...,
                        displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                    ) {
                        Label("Ends", systemImage: "clock")
                    }
                    .environment(\.timeZone, selectedTimeZone)
                    if !allDay {
                        Button {
                            showingTimeZonePicker = true
                        } label: {
                            HStack {
                                Label("Time Zone", systemImage: "globe")
                                Spacer(minLength: 8)
                                Text(timeZoneID)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(TaskifyTheme.primaryText)
                    }
                }

                Section("Location") {
                    HStack {
                        Label("Location", systemImage: "mappin.and.ellipse")
                        Spacer(minLength: 8)
                        TextField("Optional", text: $location)
                            .multilineTextAlignment(.trailing)
                    }
                }

                TaskifyEventRemindersSection(
                    isAllDay: allDay,
                    reminders: $reminders,
                    reminderTime: $reminderTime
                )

                TaskifyEventAttendeesSection(
                    selectedPublicKeys: $selectedAttendeePublicKeys,
                    contacts: model.nostrContacts,
                    onAdd: { showingAttendeePicker = true }
                )

                if !selectedAttendeePublicKeys.isEmpty {
                    TaskifyEventResponsesSection(
                        responses: model.taskifyEventRSVPs(for: event.id),
                        contacts: model.nostrContacts,
                        isRefreshing: model.isRefreshingTaskifyEventRSVPs(for: event.id),
                        refreshIsUnavailable: model.taskifyEventRSVPRefreshIsUnavailable(
                            for: event.id
                        ),
                        onRefresh: {
                            Task { await model.refreshTaskifyEventRSVPs(eventID: event.id) }
                        }
                    )
                }

                if canEditSeriesRecurrence {
                    TaskifyEventRepeatSection(
                        choice: $repeatChoice,
                        hasEnd: $repeatHasEnd,
                        endDate: $repeatEndDate,
                        minimumEndDate: startDate,
                        preservesCustomRule: repeatChoice == .custom
                    )
                } else if event.recurrence?.isActive == true {
                    Section("Repeat") {
                        Label(TaskifyEventRepeatChoice(event.recurrence).label, systemImage: "repeat")
                        Text("Edit the first event in this series to change its repeat schedule.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Notes") {
                    TextEditor(text: $details)
                        .frame(minHeight: 100)
                }

                Section("Sharing") {
                    Button {
                        showingEventShare = true
                    } label: {
                        Label("Share Event", systemImage: "paperplane")
                    }
                    Text("Choose a contact or chat group. Group members receive this encrypted event invitation in their group chat.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button("Delete Event", role: .destructive) {
                        confirmingDeletion = true
                    }
                }
            }
            .navigationTitle("Edit Event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if model.updateTaskifyEvent(
                            eventID: event.id,
                            title: title,
                            details: details,
                            location: location,
                            startDate: startDate,
                            endDate: endDate,
                            isAllDay: allDay,
                            boardID: boardID,
                            columnID: columnID.isEmpty ? nil : columnID,
                            startTimeZoneID: timeZoneID,
                            reminders: reminders,
                            reminderTime: formattedReminderTime,
                            recurrence: recurrence,
                            participants: selectedEventParticipants
                        ) {
                            dismiss()
                        }
                    }
                    .disabled(
                        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || !eventPlacementIsValid
                    )
                }
            }
            .confirmationDialog(
                "Delete this Taskify event?",
                isPresented: $confirmingDeletion,
                titleVisibility: .visible
            ) {
                Button(
                    event.recurrence?.isActive == true ? "Delete This Event" : "Delete Event",
                    role: .destructive
                ) {
                    model.deleteTaskifyEvent(event.id, scope: .single)
                    dismiss()
                }
                if event.recurrence?.isActive == true {
                    Button("Delete This and Future Events", role: .destructive) {
                        model.deleteTaskifyEvent(event.id, scope: .thisAndFuture)
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The deletion will sync to the PWA and other clients.")
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showingTimeZonePicker) {
            TimeZonePickerSheet(selection: $timeZoneID, referenceDate: startDate)
                .preferredColorScheme(.dark)
        }
        .sheet(isPresented: $showingAttendeePicker) {
            TaskifyEventAttendeePickerSheet(
                contacts: model.nostrContacts.filter { $0.publicKey != model.identityPublicKey },
                selection: $selectedAttendeePublicKeys
            )
            .preferredColorScheme(.dark)
        }
        .sheet(isPresented: $showingEventShare, onDismiss: {
            let participants = model.snapshot.taskifyEvents?.first { $0.id == event.id }?.participants ?? []
            selectedAttendeePublicKeys.formUnion(participants.map(\.publicKey))
        }) {
            TaskShareSheet(eventID: event.id)
                .preferredColorScheme(.dark)
        }
        .onAppear {
            if !eventBoards.contains(where: { $0.id == boardID }) {
                boardID = eventBoards.first?.id ?? ""
            }
            resolveSelectedColumn()
        }
        .task(id: event.canonicalAddress) {
            await model.refreshTaskifyEventRSVPs(eventID: event.id)
        }
        .onChange(of: boardID) { _, _ in resolveSelectedColumn() }
        .onChange(of: startDate) { _, newStart in
            if endDate < newStart {
                endDate = allDay
                    ? newStart
                    : newStart.addingTimeInterval(60 * 60)
            }
            if repeatEndDate < newStart {
                repeatEndDate = newStart
            }
        }
        .onChange(of: timeZoneID) { oldZoneID, newZoneID in
            guard oldZoneID != newZoneID else { return }
            startDate = taskifyRebasedWallClock(startDate, from: oldZoneID, to: newZoneID)
            endDate = taskifyRebasedWallClock(endDate, from: oldZoneID, to: newZoneID)
        }
    }

    private var selectedTimeZone: TimeZone {
        TimeZone(identifier: timeZoneID) ?? .current
    }

    private var eventPlacementIsValid: Bool {
        guard let board = selectedEventBoard else { return false }
        return board.kind == .week || selectedBoardColumns.contains(where: { $0.id == columnID })
    }

    private func resolveSelectedColumn() {
        guard selectedEventBoard?.kind == .list else {
            columnID = ""
            return
        }
        if !selectedBoardColumns.contains(where: { $0.id == columnID }) {
            columnID = selectedBoardColumns.first?.id ?? ""
        }
    }

    private var formattedReminderTime: String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: reminderTime)
        return String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0)
    }

    private var canEditSeriesRecurrence: Bool {
        event.seriesID == nil || event.seriesID == event.id
    }

    private var recurrence: TaskRecurrence? {
        guard canEditSeriesRecurrence else { return event.recurrence }
        return TaskifyEventRepeatChoice.recurrence(
            for: repeatChoice,
            startDate: startDate,
            timeZoneID: allDay ? "UTC" : timeZoneID,
            until: repeatHasEnd ? repeatEndDate : nil,
            preserving: event.recurrence
        )
    }

    private var selectedEventParticipants: [TaskifyEventParticipant] {
        // Participants come from another person's event: one key can appear twice (npub and hex).
        let existing = Dictionary((event.participants ?? []).compactMap {
            participant -> (String, TaskifyEventParticipant)? in
            guard let publicKey = NostrPublicKey.parse(participant.publicKey)?.hexString else {
                return nil
            }
            return (publicKey, participant)
        }, uniquingKeysWith: { first, _ in first })
        return selectedAttendeePublicKeys.sorted().map { publicKey in
            let contact = model.nostrContact(publicKey: publicKey)
            return TaskifyEventParticipant(
                publicKey: publicKey,
                relayURL: contact?.relayURLs.first ?? existing[publicKey]?.relayURL,
                role: existing[publicKey]?.role ?? "attendee"
            )
        }
    }

    private static func reminderClock(from value: String?) -> Date {
        let parts = (value ?? "09:00").split(separator: ":")
        let hour = parts.first.flatMap { Int($0) } ?? 9
        let minute = parts.dropFirst().first.flatMap { Int($0) } ?? 0
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }
}

struct TaskifyEventResponsesSection: View {
    let responses: [TaskifyEventRSVPResponse]
    let contacts: [NostrContact]
    let isRefreshing: Bool
    let refreshIsUnavailable: Bool
    let onRefresh: () -> Void

    private var countsLabel: String {
        let accepted = responses.count { $0.status == .accepted }
        let tentative = responses.count { $0.status == .tentative }
        let declined = responses.count { $0.status == .declined }
        return "Accepted \(accepted) · Tentative \(tentative) · Declined \(declined)"
    }

    var body: some View {
        Section {
            Text(countsLabel)
                .font(.caption)
                .foregroundStyle(.secondary)

            if responses.isEmpty {
                Text("No responses yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(responses) { response in
                    responseRow(response)
                }
            }
        } header: {
            HStack {
                Text("Responses")
                Spacer()
                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Refreshing event responses")
                } else {
                    Button(action: onRefresh) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Refresh event responses")
                }
            }
        } footer: {
            if refreshIsUnavailable {
                Text("Responses could not be refreshed. Your last available results are still shown.")
            } else {
                Text("Responses are authenticated with each invitee's private event token.")
            }
        }
    }

    private func responseRow(_ response: TaskifyEventRSVPResponse) -> some View {
        let contact = contacts.first { $0.publicKey == response.authorPublicKey }
        return HStack(spacing: 12) {
            TaskifyEventContactIcon(contact: contact)
            VStack(alignment: .leading, spacing: 2) {
                Text(contact?.displayName ?? shortenedPublicKey(response.authorPublicKey))
                    .foregroundStyle(TaskifyTheme.primaryText)
                if let note = response.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Label(responseLabel(response), systemImage: responseSymbol(response.status))
                .font(.caption.weight(.semibold))
                .foregroundStyle(responseColor(response.status))
                .labelStyle(.titleAndIcon)
        }
        .accessibilityElement(children: .combine)
    }

    private func responseLabel(_ response: TaskifyEventRSVPResponse) -> String {
        let status = switch response.status {
        case .accepted: "Accepted"
        case .tentative: "Tentative"
        case .declined: "Declined"
        case .pending: "Pending"
        case .deleted: "Removed"
        }
        guard let freeBusy = response.freeBusy else { return status }
        return "\(status) · \(freeBusy == .busy ? "Busy" : "Free")"
    }

    private func responseSymbol(_ status: SharedInboxItemStatus) -> String {
        switch status {
        case .accepted: "checkmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .pending: "clock"
        case .deleted: "trash"
        }
    }

    private func responseColor(_ status: SharedInboxItemStatus) -> Color {
        switch status {
        case .accepted: .green
        case .tentative: .orange
        case .declined: .red
        case .pending, .deleted: TaskifyTheme.secondaryText
        }
    }

    private func shortenedPublicKey(_ value: String) -> String {
        value.count > 18 ? "\(value.prefix(10))…\(value.suffix(6))" : value
    }
}

struct TaskifyEventAttendeesSection: View {
    @Binding var selectedPublicKeys: Set<String>
    let contacts: [NostrContact]
    let onAdd: () -> Void

    private var selectedContacts: [(publicKey: String, contact: NostrContact?)] {
        selectedPublicKeys.map { publicKey in
            (publicKey, contacts.first(where: { $0.publicKey == publicKey }))
        }.sorted {
            ($0.contact?.displayName ?? $0.publicKey)
                .localizedCaseInsensitiveCompare($1.contact?.displayName ?? $1.publicKey)
                == .orderedAscending
        }
    }

    var body: some View {
        Section {
            Button(action: onAdd) {
                Label("Add People", systemImage: "person.badge.plus")
            }

            if selectedContacts.isEmpty {
                Text("Invite people from your Taskify contacts.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(selectedContacts, id: \.publicKey) { item in
                    HStack(spacing: 12) {
                        TaskifyEventContactIcon(contact: item.contact)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.contact?.displayName ?? "Taskify contact")
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text(item.contact?.subtitle ?? shortenedPublicKey(item.publicKey))
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                        }
                        Spacer()
                        Button {
                            selectedPublicKeys.remove(item.publicKey)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(item.contact?.displayName ?? "attendee")")
                    }
                }
            }
        } header: {
            Text("Invitees")
        } footer: {
            if !selectedContacts.isEmpty {
                Text("New invitees receive an encrypted Taskify event invitation when you save.")
            }
        }
    }

    private func shortenedPublicKey(_ value: String) -> String {
        value.count > 18 ? "\(value.prefix(10))…\(value.suffix(6))" : value
    }
}

struct TaskifyEventAttendeePickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let contacts: [NostrContact]
    @Binding var selection: Set<String>
    @State private var searchText = ""

    private var visibleContacts: [NostrContact] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return contacts.filter { contact in
            query.isEmpty
                || contact.displayName.localizedCaseInsensitiveContains(query)
                || contact.subtitle.localizedCaseInsensitiveContains(query)
                || contact.npub.localizedCaseInsensitiveContains(query)
        }.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if visibleContacts.isEmpty {
                    ContentUnavailableView(
                        searchText.isEmpty ? "No Taskify Contacts" : "No Matches",
                        systemImage: searchText.isEmpty ? "person.crop.circle.badge.plus" : "magnifyingglass",
                        description: Text(
                            searchText.isEmpty
                                ? "Add contacts in Chat before inviting them to an event."
                                : "Try another name, NIP-05 address, or public key."
                        )
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(visibleContacts) { contact in
                        Button {
                            if selection.contains(contact.publicKey) {
                                selection.remove(contact.publicKey)
                            } else {
                                selection.insert(contact.publicKey)
                            }
                        } label: {
                            HStack(spacing: 12) {
                                TaskifyEventContactIcon(contact: contact)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(contact.displayName)
                                        .foregroundStyle(TaskifyTheme.primaryText)
                                    Text(contact.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Image(systemName: selection.contains(contact.publicKey)
                                    ? "checkmark.circle.fill"
                                    : "circle")
                                    .font(.title3)
                                    .foregroundStyle(selection.contains(contact.publicKey)
                                        ? TaskifyTheme.accent
                                        : TaskifyTheme.tertiaryText)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("Invite People")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search contacts")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct TaskifyEventContactIcon: View {
    let contact: NostrContact?

    var body: some View {
        Group {
            if let url = contact?.pictureURL {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: 34, height: 34)
        .clipShape(Circle())
    }

    private var fallback: some View {
        ZStack {
            Circle().fill(TaskifyTheme.accent.opacity(0.18))
            Text(contact?.initials ?? "?")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TaskifyTheme.accent)
        }
    }
}

enum TaskifyEventRepeatChoice: String, CaseIterable, Identifiable {
    case never
    case hourly
    case daily
    case weekdays
    case weekends
    case weekly
    case biweekly
    case monthly
    case quarterly
    case yearly
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .never: "Never"
        case .hourly: "Hourly"
        case .daily: "Daily"
        case .weekdays: "Every Weekday"
        case .weekends: "Every Weekend"
        case .weekly: "Weekly"
        case .biweekly: "Every 2 Weeks"
        case .monthly: "Monthly"
        case .quarterly: "Every 3 Months"
        case .yearly: "Yearly"
        case .custom: "Custom"
        }
    }

    init(_ recurrence: TaskRecurrence?) {
        guard let recurrence, recurrence.isActive else {
            self = .never
            return
        }
        switch recurrence {
        case .daily:
            self = .daily
        case .weekly(let days, _):
            let normalized = Set(days)
            if normalized == Set([1, 2, 3, 4, 5]) {
                self = .weekdays
            } else if normalized == Set([0, 6]) {
                self = .weekends
            } else if normalized.count == 1 {
                self = .weekly
            } else {
                self = .custom
            }
        case .every(let count, .hour, _):
            self = count == 1 ? .hourly : .custom
        case .every(let count, .week, _):
            self = count == 2 ? .biweekly : .custom
        case .every:
            self = .custom
        case .monthlyDay(_, let interval, _):
            switch max(1, interval ?? 1) {
            case 1: self = .monthly
            case 3: self = .quarterly
            case 12: self = .yearly
            default: self = .custom
            }
        case .none:
            self = .never
        }
    }

    static func recurrence(
        for choice: TaskifyEventRepeatChoice,
        startDate: Date,
        timeZoneID: String,
        until: Date?,
        preserving existing: TaskRecurrence?
    ) -> TaskRecurrence? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeZoneID) ?? .current
        let normalizedUntil = until.flatMap {
            calendar.date(bySettingHour: 12, minute: 0, second: 0, of: $0)
        }
        let weekday = calendar.component(.weekday, from: startDate) - 1
        let monthDay = min(max(calendar.component(.day, from: startDate), 1), 28)
        switch choice {
        case .never:
            return nil
        case .hourly:
            return .every(1, .hour, until: normalizedUntil)
        case .daily:
            return .daily(until: normalizedUntil)
        case .weekdays:
            return .weekly(days: [1, 2, 3, 4, 5], until: normalizedUntil)
        case .weekends:
            return .weekly(days: [0, 6], until: normalizedUntil)
        case .weekly:
            return .weekly(days: [weekday], until: normalizedUntil)
        case .biweekly:
            return .every(2, .week, until: normalizedUntil)
        case .monthly:
            return .monthlyDay(day: monthDay, until: normalizedUntil)
        case .quarterly:
            return .monthlyDay(day: monthDay, interval: 3, until: normalizedUntil)
        case .yearly:
            return .monthlyDay(day: monthDay, interval: 12, until: normalizedUntil)
        case .custom:
            return existing?.isActive == true ? existing?.withUntilDate(normalizedUntil) : nil
        }
    }
}

struct TaskifyEventRepeatSection: View {
    @Binding var choice: TaskifyEventRepeatChoice
    @Binding var hasEnd: Bool
    @Binding var endDate: Date
    let minimumEndDate: Date
    let preservesCustomRule: Bool

    var body: some View {
        Section("Repeat") {
            Picker(selection: $choice) {
                ForEach(availableChoices) { option in
                    Text(option.label).tag(option)
                }
            } label: {
                Label("Repeat", systemImage: "repeat")
            }
            .pickerStyle(.navigationLink)
            if choice != .never {
                Toggle(isOn: $hasEnd) {
                    Label("End Repeat", systemImage: "calendar.badge.minus")
                }
                if hasEnd {
                    DatePicker(
                        "End date",
                        selection: $endDate,
                        in: minimumEndDate...,
                        displayedComponents: .date
                    )
                }
            }
            if choice == .custom {
                Text("This custom PWA repeat rule will be preserved. Choose a preset to replace it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var availableChoices: [TaskifyEventRepeatChoice] {
        TaskifyEventRepeatChoice.allCases.filter { $0 != .custom || preservesCustomRule }
    }
}

struct TaskifyEventRemindersSection: View {
    let isAllDay: Bool
    @Binding var reminders: [TaskReminder]
    @Binding var reminderTime: Date

    var body: some View {
        Section("Reminders") {
            ForEach(presets) { reminder in
                Toggle(isOn: binding(for: reminder)) {
                    Label(reminder.eventLabel, systemImage: "bell")
                }
            }
            if isAllDay {
                DatePicker(selection: $reminderTime, displayedComponents: .hourAndMinute) {
                    Label("Reminder time", systemImage: "bell")
                }
                Text("All-day events use your current time zone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !reminders.isEmpty {
                Text("iOS will ask for notification permission when you save.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var presets: [TaskReminder] {
        isAllDay ? TaskReminder.datePresets : TaskReminder.timedPresets
    }

    private func binding(for reminder: TaskReminder) -> Binding<Bool> {
        Binding(
            get: { reminders.contains { $0.minutesBefore == reminder.minutesBefore } },
            set: { selected in
                reminders.removeAll { $0.minutesBefore == reminder.minutesBefore }
                if selected { reminders.append(reminder) }
            }
        )
    }
}

func taskifyRebasedWallClock(_ date: Date, from oldZoneID: String, to newZoneID: String) -> Date {
    guard let oldZone = TimeZone(identifier: oldZoneID),
          let newZone = TimeZone(identifier: newZoneID) else { return date }
    var oldCalendar = Calendar(identifier: .gregorian)
    oldCalendar.timeZone = oldZone
    let components = oldCalendar.dateComponents(
        [.year, .month, .day, .hour, .minute, .second],
        from: date
    )
    var newCalendar = Calendar(identifier: .gregorian)
    newCalendar.timeZone = newZone
    return newCalendar.date(from: components) ?? date
}
