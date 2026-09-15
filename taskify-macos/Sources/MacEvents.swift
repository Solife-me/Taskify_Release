import SwiftUI
import TaskifyCore

struct MacEventEditor: View {
    let event: TaskifyEvent?
    let initialBoardID: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var details = ""
    @State private var location = ""
    @State private var start = Date()
    @State private var end = Date().addingTimeInterval(3600)
    @State private var allDay = false
    @State private var boardID = ""
    @State private var columnID = ""
    @State private var timeZone = TimeZone.current.identifier
    @State private var remind = false
    @State private var error: String?
    @State private var deleting = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(event == nil ? "New Event" : "Event Details").font(.title2.bold())
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                if event?.isReadOnly != true { Button("Save", action: save).keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent) }
            }.padding(22)
            Form {
                Section {
                    TextField("Title", text: $title)
                    TextField("Details", text: $details, axis: .vertical).lineLimit(3...8)
                    TextField("Location", text: $location)
                    Picker("Board", selection: $boardID) {
                        ForEach(model.visibleBoards.filter { $0.kind == .list || $0.kind == .week }) { Text($0.name).tag($0.id) }
                    }
                    if let board = model.board(withID: boardID), board.kind == .list {
                        Picker("Column", selection: $columnID) { ForEach(board.columns) { Text($0.name).tag($0.id) } }
                    }
                }
                Section("Schedule") {
                    Toggle("All Day", isOn: $allDay)
                    DatePicker("Starts", selection: $start, displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                    DatePicker("Ends", selection: $end, in: start..., displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                    if !allDay {
                        Picker("Time Zone", selection: $timeZone) {
                            ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) }
                        }
                    }
                    Toggle("Remind at Start", isOn: $remind)
                }
                if let event, event.isReadOnly { Text("This event was shared with you. Its organizer controls the details.").foregroundStyle(.secondary) }
                if let event, !event.isReadOnly { Button("Delete Event…", role: .destructive) { deleting = true } }
                if let error { Text(error).foregroundStyle(.red) }
            }.formStyle(.grouped).disabled(event?.isReadOnly == true)
        }.frame(width: 570, height: 620)
            .onAppear {
                boardID = event?.boardID ?? initialBoardID
                columnID = event?.columnID ?? model.board(withID: boardID)?.columns.first?.id ?? ""
                if let event {
                    title = event.title; details = event.details ?? ""; location = event.locations?.first ?? ""
                    start = event.startDate ?? Date(); end = event.endDate ?? start.addingTimeInterval(3600)
                    allDay = event.isAllDay; timeZone = event.startTimeZoneID ?? TimeZone.current.identifier
                    remind = event.reminders?.contains { $0.minutesBefore == 0 } == true
                }
            }
            .onChange(of: boardID) { _, _ in columnID = model.board(withID: boardID)?.columns.first?.id ?? "" }
            .onChange(of: start) { _, value in if end < value { end = value.addingTimeInterval(allDay ? 0 : 3600) } }
            .confirmationDialog("Delete this event?", isPresented: $deleting) {
                if let event {
                    Button("Delete This Event", role: .destructive) { model.deleteTaskifyEvent(event.id); dismiss() }
                    if event.recurrence?.isActive == true {
                        Button("Delete This and Future Occurrences", role: .destructive) { model.deleteTaskifyEvent(event.id, scope: .thisAndFuture); dismiss() }
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
    }
    private func save() {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "Enter an event title."; return }
        if let event, model.taskifyEvents.first(where: { $0.id == event.id }) != event {
            error = "This event changed while you were editing. Reopen it before saving."; return
        }
        var reminders = event?.reminders?.filter { $0.minutesBefore != 0 } ?? []
        if remind { reminders.append(TaskReminder(minutesBefore: 0, dateOnly: allDay)) }
        let success: Bool
        if let event {
            success = model.updateTaskifyEvent(eventID: event.id, title: title, details: details, location: location, startDate: start,
                endDate: end, isAllDay: allDay, boardID: boardID, columnID: columnID, startTimeZoneID: timeZone,
                reminders: reminders, reminderTime: event.reminderTime, recurrence: event.recurrence, participants: event.participants)
        } else {
            success = model.addTaskifyEvent(title: title, details: details, location: location, startDate: start, endDate: end,
                isAllDay: allDay, boardID: boardID, columnID: columnID, startTimeZoneID: timeZone, reminders: reminders)
        }
        if success { dismiss() } else { error = "The event could not be saved. Check its board and schedule." }
    }
}

struct MacTaskShare: View {
    let task: TaskItem
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recipient = ""
    @State private var assignment = false
    @State private var sending = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Share Task").font(.title2.bold())
            Text(task.title).font(.headline)
            TextField("Recipient npub or public key", text: $recipient)
            Picker("Contact", selection: $recipient) {
                Text("Enter a recipient above").tag("")
                ForEach(model.nostrContacts) { Text($0.displayName).tag($0.publicKey) }
            }
            Toggle("Request Assignment", isOn: $assignment)
            Text("The recipient can accept or decline. Your task is sent through encrypted messaging.").font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.disabled(sending)
                Spacer()
                Button("Send Task") {
                    sending = true
                    Task {
                        defer { sending = false }
                        do { _ = try await model.sendSharedTask(taskID: task.id, recipientValue: recipient, assignment: assignment); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }
                }.buttonStyle(.borderedProminent).disabled(sending || recipient.isEmpty)
            }
        }.padding(28).frame(width: 480).interactiveDismissDisabled(sending)
    }
}
