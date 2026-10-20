import EventKit
import SwiftUI
import TaskifyCore
import UIKit

enum NewUpcomingItemType: String, CaseIterable {
    case task = "Task"
    case event = "Event"
}

struct NewUpcomingItemSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var itemType = NewUpcomingItemType.task
    @State private var title = ""
    @State private var dueDate = Date()
    @State private var endDate = Date().addingTimeInterval(60 * 60)
    @State private var allDay = true
    @State private var details = ""
    @State private var location = ""
    @State private var boardID = ""
    @State private var columnID = ""
    @State private var timeZoneID = TimeZone.current.identifier
    @State private var reminders: [TaskReminder] = []
    @State private var reminderTime = Self.reminderClock(from: nil)
    @State private var showingTimeZonePicker = false
    @State private var repeatChoice = TaskifyEventRepeatChoice.never
    @State private var repeatHasEnd = false
    @State private var repeatEndDate = Date().addingTimeInterval(180 * 24 * 60 * 60)
    @State private var selectedAttendeePublicKeys: Set<String> = []
    @State private var showingAttendeePicker = false

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
                    Picker("Type", selection: $itemType) {
                        ForEach(NewUpcomingItemType.allCases, id: \.rawValue) { type in
                            Text(type.rawValue).tag(type)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section(itemType.rawValue) {
                    TextField("Title", text: $title)
                    if itemType == .task {
                        DatePicker("Due date", selection: $dueDate, displayedComponents: .date)
                    } else {
                        Picker("Board", selection: $boardID) {
                            ForEach(eventBoards) { board in
                                Text(board.name).tag(board.id)
                            }
                        }
                        if selectedEventBoard?.kind == .list {
                            Picker("List", selection: $columnID) {
                                ForEach(selectedBoardColumns) { column in
                                    Text(column.name).tag(column.id)
                                }
                            }
                        }
                        Toggle("All-day", isOn: $allDay)
                        DatePicker(
                            "Starts",
                            selection: $dueDate,
                            displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                        )
                        .environment(\.timeZone, selectedTimeZone)
                        DatePicker(
                            "Ends",
                            selection: $endDate,
                            in: dueDate...,
                            displayedComponents: allDay ? [.date] : [.date, .hourAndMinute]
                        )
                        .environment(\.timeZone, selectedTimeZone)
                        if !allDay {
                            Button {
                                showingTimeZonePicker = true
                            } label: {
                                LabeledContent("Time Zone", value: timeZoneID)
                            }
                            .foregroundStyle(TaskifyTheme.primaryText)
                        }
                        TextField("Location (optional)", text: $location)
                    }
                }

                if itemType == .event {
                    TaskifyEventAttendeesSection(
                        selectedPublicKeys: $selectedAttendeePublicKeys,
                        contacts: model.nostrContacts,
                        onAdd: { showingAttendeePicker = true }
                    )
                    TaskifyEventRemindersSection(
                        isAllDay: allDay,
                        reminders: $reminders,
                        reminderTime: $reminderTime
                    )
                    TaskifyEventRepeatSection(
                        choice: $repeatChoice,
                        hasEnd: $repeatHasEnd,
                        endDate: $repeatEndDate,
                        minimumEndDate: dueDate,
                        preservesCustomRule: false
                    )
                    Section("Notes") {
                        TextEditor(text: $details)
                            .frame(minHeight: 100)
                    }
                }
            }
            .navigationTitle("New \(itemType.rawValue)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        if itemType == .task {
                            model.addTask(title: title, dueDate: dueDate)
                        } else {
                            _ = model.addTaskifyEvent(
                                title: title,
                                details: details,
                                location: location,
                                startDate: dueDate,
                                endDate: endDate,
                                isAllDay: allDay,
                                boardID: boardID,
                                columnID: columnID.isEmpty ? nil : columnID,
                                startTimeZoneID: timeZoneID,
                                reminders: reminders,
                                reminderTime: formattedReminderTime,
                                recurrence: recurrence,
                                participants: selectedEventParticipants
                            )
                        }
                        dismiss()
                    }
                    .disabled(
                        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                            (itemType == .event && !eventPlacementIsValid)
                    )
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showingTimeZonePicker) {
            TimeZonePickerSheet(selection: $timeZoneID, referenceDate: dueDate)
                .preferredColorScheme(.dark)
        }
        .sheet(isPresented: $showingAttendeePicker) {
            TaskifyEventAttendeePickerSheet(
                contacts: model.nostrContacts.filter { $0.publicKey != model.identityPublicKey },
                selection: $selectedAttendeePublicKeys
            )
            .preferredColorScheme(.dark)
        }
        .onAppear {
            guard boardID.isEmpty else { return }
            if let selected = model.selectedBoard,
               eventBoards.contains(where: { $0.id == selected.id }) {
                boardID = selected.id
            } else {
                boardID = eventBoards.first?.id ?? ""
            }
            resolveSelectedColumn()
        }
        .onChange(of: boardID) { _, _ in resolveSelectedColumn() }
        .onChange(of: dueDate) { _, newStart in
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
            dueDate = taskifyRebasedWallClock(dueDate, from: oldZoneID, to: newZoneID)
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

    private var recurrence: TaskRecurrence? {
        TaskifyEventRepeatChoice.recurrence(
            for: repeatChoice,
            startDate: dueDate,
            timeZoneID: allDay ? "UTC" : timeZoneID,
            until: repeatHasEnd ? repeatEndDate : nil,
            preserving: nil
        )
    }

    private var selectedEventParticipants: [TaskifyEventParticipant] {
        selectedAttendeePublicKeys.sorted().map { publicKey in
            let contact = model.nostrContact(publicKey: publicKey)
            return TaskifyEventParticipant(
                publicKey: publicKey,
                relayURL: contact?.relayURLs.first,
                role: "attendee"
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
