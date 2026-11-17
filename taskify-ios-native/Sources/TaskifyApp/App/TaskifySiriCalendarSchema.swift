import AppIntents
import Foundation
import TaskifyCore

#if os(iOS) || (TASKIFY_MAC_SHORTCUTS && !TASKIFY_MAC_UI_TEST)
@available(iOS 27.0, macOS 27.0, *)
@AppEntity(schema: .calendar.calendar)
struct TaskifySiriCalendarEntity {
    static let defaultQuery = CalendarQuery()

    let id: String
    var title: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }

    init(board: Board) {
        id = board.id
        title = board.name
    }

    struct CalendarQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifySiriCalendarEntity] {
            let boards = try await calendars()
            return identifiers.compactMap { id in boards.first(where: { $0.id == id }) }
        }

        func entities(matching string: String) async throws -> [TaskifySiriCalendarEntity] {
            let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return try await calendars().filter {
                needle.isEmpty || $0.title.localizedCaseInsensitiveContains(needle)
            }
        }

        func suggestedEntities() async throws -> [TaskifySiriCalendarEntity] {
            try await calendars()
        }

        private func calendars() async throws -> [TaskifySiriCalendarEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return TaskifyAddTaskDestination.namedBoards(in: snapshot).map(TaskifySiriCalendarEntity.init)
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppEntity(schema: .calendar.attendee)
struct TaskifySiriAttendeeEntity: TransientAppEntity {
    var person: IntentPerson
    var status: TaskifySiriParticipantStatus?
    var isAttendanceOptional: Bool
    var type: TaskifySiriAttendeeType?

    var displayRepresentation: DisplayRepresentation { person.displayRepresentation }

    init() {
        person = IntentPerson(handle: .init(applicationDefined: "unknown"))
        status = nil
        isAttendanceOptional = false
        type = .person
    }

    init(participant: TaskifyEventParticipant) {
        person = IntentPerson(
            identifier: .applicationDefined(participant.publicKey),
            name: .displayName(participant.publicKey),
            handle: .init(applicationDefined: participant.publicKey)
        )
        status = .accepted
        isAttendanceOptional = false
        type = .person
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppEntity(schema: .calendar.event)
struct TaskifySiriEventEntity {
    static let defaultQuery = EventQuery()

    let id: String
    var calendar: TaskifySiriCalendarEntity
    var title: String
    var startDate: Date
    var endDate: Date
    var isAllDay: Bool
    var recurrence: Calendar.RecurrenceRule?
    var note: AttributedString?
    var travelTime: Duration?
    var location: TaskifySiriEventLocation?
    var virtualLocation: URL?
    var status: TaskifySiriEventStatus?
    var alarms: [TaskifySiriEventAlarm]
    var organizers: [IntentPerson]
    var attendees: [TaskifySiriAttendeeEntity]

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(calendar.title)")
    }

    init(event: TaskifyEvent, board: Board) {
        id = event.id
        calendar = TaskifySiriCalendarEntity(board: board)
        title = event.title
        startDate = event.startDate ?? Date.distantPast
        endDate = event.endDate ?? event.startDate ?? Date.distantPast
        isAllDay = event.isAllDay
        recurrence = TaskifySiriRecurrence.calendarRule(from: event.recurrence, startDate: event.startDate)
        note = event.details.map(AttributedString.init)
        travelTime = nil
        location = event.locations?.first.map(TaskifySiriEventLocation.text)
        virtualLocation = event.locations?.compactMap(URL.init(string:)).first
        status = event.isDeleted ? .cancelled : .confirmed
        alarms = (event.reminders ?? []).compactMap { reminder in
            reminder.minutesBefore.map { .duration(.seconds($0 * 60)) }
        }
        organizers = []
        attendees = (event.participants ?? []).map(TaskifySiriAttendeeEntity.init)
    }

    struct EventQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [TaskifySiriEventEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            let ids = Set(identifiers)
            return Self.entities(in: snapshot).filter { ids.contains($0.id) }
        }

        func entities(matching string: String) async throws -> [TaskifySiriEventEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return Self.entities(in: snapshot).filter {
                needle.isEmpty || $0.title.localizedCaseInsensitiveContains(needle)
            }
        }

        func suggestedEntities() async throws -> [TaskifySiriEventEntity] {
            let snapshot = try await JSONTaskStore().read(areas: [.tasks])
            return Array(Self.entities(in: snapshot).prefix(100))
        }

        private static func entities(in snapshot: TaskifySnapshot) -> [TaskifySiriEventEntity] {
            let boards = Dictionary(uniqueKeysWithValues: snapshot.boards.map { ($0.id, $0) })
            return (snapshot.taskifyEvents ?? [])
                .filter { !$0.isDeleted && $0.startDate != nil && !$0.isGenerated }
                .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
                .compactMap { event in
                    guard let boardID = event.boardID, let board = boards[boardID] else { return nil }
                    return TaskifySiriEventEntity(event: event, board: board)
                }
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
enum TaskifySiriCalendarError: LocalizedError {
    case unsupportedAttendees
    case unsupportedRecurrence

    var errorDescription: String? {
        switch self {
        case .unsupportedAttendees:
            "Taskify can create this event, but Siri contacts cannot be converted to Taskify invite keys yet. Try without attendees."
        case .unsupportedRecurrence:
            "Taskify doesn't support that event recurrence pattern yet."
        }
    }
}

@available(iOS 27.0, macOS 27.0, *)
@AppIntent(schema: .calendar.createEvent)
struct TaskifyCreateCalendarEventIntent {
    var title: String
    var startDate: Date
    var endDate: Date?
    var location: TaskifySiriEventLocation?
    var calendar: TaskifySiriCalendarEntity
    var isAllDay: Bool
    var recurrence: Calendar.RecurrenceRule?
    var attendees: [TaskifySiriAttendeeEntity]
    var note: AttributedString?

    func perform() async throws -> some ReturnsValue<TaskifySiriEventEntity> & ProvidesDialog {
        guard attendees.isEmpty else { throw TaskifySiriCalendarError.unsupportedAttendees }
        let convertedRecurrence: TaskRecurrence?
        if let recurrence {
            guard let converted = TaskifySiriRecurrence.taskRecurrence(
                from: recurrence,
                startDate: startDate
            ) else {
                throw TaskifySiriCalendarError.unsupportedRecurrence
            }
            convertedRecurrence = converted
        } else {
            convertedRecurrence = nil
        }
        let created = try await TaskifyExternalActions.createCalendarEvent(
            title: title,
            startDate: startDate,
            endDate: endDate,
            isAllDay: isAllDay,
            boardID: calendar.id,
            details: note.map { String($0.characters) } ?? "",
            location: location?.taskifyValue,
            recurrence: convertedRecurrence
        )
        let entity = TaskifySiriEventEntity(event: created.event, board: created.board)
        return .result(
            value: entity,
            dialog: "Added \"\(entity.title)\" to \(entity.calendar.title)."
        )
    }
}
#endif
