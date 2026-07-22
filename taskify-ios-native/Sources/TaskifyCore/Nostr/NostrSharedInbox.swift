import Foundation

public enum NostrPublicKey {
    public static func parse(_ value: String) -> Data? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("npub1") {
            guard let decoded = try? Bech32.decode(trimmed, expectedPrefix: "npub"),
                  decoded.count == 32 else { return nil }
            return decoded
        }
        let raw = (trimmed.hasPrefix("02") || trimmed.hasPrefix("03")) && trimmed.count == 66
            ? String(trimmed.dropFirst(2))
            : trimmed
        guard raw.count == 64,
              let decoded = try? Data(hex: raw),
              decoded.count == 32 else { return nil }
        return decoded
    }

    public static func npub(from publicKey: Data) -> String? {
        guard publicKey.count == 32 else { return nil }
        return try? Bech32.encode(prefix: "npub", data: publicKey)
    }
}

public enum SharedTaskAssignmentStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case accepted
    case declined
    case tentative
}

public struct SharedTaskAssignee: Codable, Equatable, Sendable {
    public var publicKey: String
    public var relay: String?
    public var status: SharedTaskAssignmentStatus?
    public var respondedAt: Int64?

    enum CodingKeys: String, CodingKey {
        case publicKey = "pubkey"
        case relay
        case status
        case respondedAt
    }

    public init(
        publicKey: String,
        relay: String? = nil,
        status: SharedTaskAssignmentStatus? = nil,
        respondedAt: Int64? = nil
    ) {
        self.publicKey = publicKey
        self.relay = relay
        self.status = status
        self.respondedAt = respondedAt
    }
}

public struct SharedTaskDelivery: Codable, Equatable, Sendable {
    public var title: String
    public var note: String?
    public var priority: Int?
    public var dueISO: String?
    public var dueDateEnabled: Bool?
    public var dueTimeEnabled: Bool?
    public var dueTimeZone: String?
    public var reminders: [TaskReminder]?
    public var subtasks: [TaskSubtask]?
    public var recurrence: TaskRecurrence?
    public var documents: [TaskDocument]?
    public var assignees: [SharedTaskAssignee]?
    public var sourceTaskID: String?
    public var assignment: Bool?
    public var relayURLs: [String]?

    enum CodingKeys: String, CodingKey {
        case title
        case note
        case priority
        case dueISO
        case dueDateEnabled
        case dueTimeEnabled
        case dueTimeZone
        case reminders
        case subtasks
        case recurrence
        case documents
        case assignees
        case sourceTaskID = "sourceTaskId"
        case assignment
        case relayURLs = "relays"
    }

    public init(
        title: String,
        note: String? = nil,
        priority: Int? = nil,
        dueISO: String? = nil,
        dueDateEnabled: Bool? = nil,
        dueTimeEnabled: Bool? = nil,
        dueTimeZone: String? = nil,
        reminders: [TaskReminder]? = nil,
        subtasks: [TaskSubtask]? = nil,
        recurrence: TaskRecurrence? = nil,
        documents: [TaskDocument]? = nil,
        assignees: [SharedTaskAssignee]? = nil,
        sourceTaskID: String? = nil,
        assignment: Bool? = nil,
        relayURLs: [String]? = nil
    ) {
        self.title = title
        self.note = note
        self.priority = priority
        self.dueISO = dueISO
        self.dueDateEnabled = dueDateEnabled
        self.dueTimeEnabled = dueTimeEnabled
        self.dueTimeZone = dueTimeZone
        self.reminders = reminders
        self.subtasks = subtasks
        self.recurrence = recurrence
        self.documents = documents
        self.assignees = assignees
        self.sourceTaskID = sourceTaskID
        self.assignment = assignment
        self.relayURLs = relayURLs
    }

    public init(
        task: TaskItem,
        relayURLs: [String],
        assignmentRecipientPublicKey: String? = nil
    ) {
        let normalizedRecipient = assignmentRecipientPublicKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        var assignmentAssignees: [SharedTaskAssignee]?
        if let normalizedRecipient,
           NostrPublicKey.parse(normalizedRecipient) != nil {
            var current = task.sharedTaskAssignees
            if let index = current.firstIndex(where: { $0.publicKey == normalizedRecipient }) {
                current[index].status = .pending
                current[index].respondedAt = nil
            } else {
                current.append(SharedTaskAssignee(
                    publicKey: normalizedRecipient,
                    status: .pending
                ))
            }
            assignmentAssignees = current
        }

        self.init(
            title: task.title,
            note: task.note.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            priority: task.priority?.rawValue,
            dueISO: task.dueDate.map(TaskSyncPayload.format),
            dueDateEnabled: task.dueDateEnabled,
            dueTimeEnabled: task.dueTimeEnabled,
            dueTimeZone: task.dueTimeZone,
            reminders: task.reminders?.nilIfEmpty,
            subtasks: task.subtasks?.nilIfEmpty,
            recurrence: task.recurrence?.isActive == true ? task.recurrence : nil,
            documents: task.documents?.nilIfEmpty,
            assignees: assignmentAssignees,
            sourceTaskID: assignmentAssignees == nil ? nil : task.id,
            assignment: assignmentAssignees == nil ? nil : true,
            relayURLs: TaskifyRelayURL.normalizedList(relayURLs).nilIfEmpty
        )
    }

    public var dueDate: Date? { TaskSyncPayload.parse(dueISO) }
    public var isAssignment: Bool {
        assignment == true && sourceTaskID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    fileprivate func normalized() -> SharedTaskDelivery? {
        var copy = self
        copy.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !copy.title.isEmpty else { return nil }
        copy.note = note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        copy.priority = priority.flatMap { (1...3).contains($0) ? $0 : nil }
        copy.dueISO = dueDate.map(TaskSyncPayload.format)
        copy.dueTimeZone = dueTimeZone.flatMap { TimeZone(identifier: $0) == nil ? nil : $0 }
        copy.sourceTaskID = sourceTaskID?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        copy.relayURLs = TaskifyRelayURL.normalizedList(relayURLs ?? []).nilIfEmpty
        copy.subtasks = subtasks?.compactMap { subtask in
            let title = subtask.title.trimmingCharacters(in: .whitespacesAndNewlines)
            return title.isEmpty ? nil : TaskSubtask(id: subtask.id, title: title, completed: subtask.completed)
        }.nilIfEmpty
        copy.assignees = assignees?.compactMap { assignee in
            let key = assignee.publicKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard key.count == 64, (try? Data(hex: key)) != nil else { return nil }
            return SharedTaskAssignee(
                publicKey: key,
                relay: TaskifyRelayURL.normalize(assignee.relay ?? ""),
                status: assignee.status,
                respondedAt: assignee.respondedAt
            )
        }.uniqued(by: \.publicKey).nilIfEmpty
        return copy
    }
}

public struct SharedInboxSender: Codable, Equatable, Sendable {
    public var publicKey: String
    public var npub: String?
    public var name: String?

    public init(publicKey: String, npub: String? = nil, name: String? = nil) {
        self.publicKey = publicKey
        self.npub = npub
        self.name = name
    }

    public var displayName: String {
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name
        }
        if let npub, !npub.isEmpty {
            return npub.count > 20 ? "\(npub.prefix(10))…\(npub.suffix(6))" : npub
        }
        return publicKey.count > 18
            ? "\(publicKey.prefix(10))…\(publicKey.suffix(6))"
            : publicKey
    }
}

public enum SharedInboxItemStatus: String, Codable, Sendable {
    case pending
    case accepted
    case declined
    case tentative
    case deleted
}

public struct SharedInboxItem: Identifiable, Codable, Equatable, Sendable {
    public var id: String { wrapEventID }
    public var wrapEventID: String
    public var rumorEventID: String
    public var sender: SharedInboxSender
    public var task: SharedTaskDelivery
    public var receivedAt: Date
    public var status: SharedInboxItemStatus
    public var respondedAt: Date?

    public init(
        wrapEventID: String,
        rumorEventID: String,
        sender: SharedInboxSender,
        task: SharedTaskDelivery,
        receivedAt: Date,
        status: SharedInboxItemStatus = .pending,
        respondedAt: Date? = nil
    ) {
        self.wrapEventID = wrapEventID
        self.rumorEventID = rumorEventID
        self.sender = sender
        self.task = task
        self.receivedAt = receivedAt
        self.status = status
        self.respondedAt = respondedAt
    }
}

public struct SharedContactDelivery: Codable, Equatable, Sendable {
    public var npub: String
    public var name: String?
    public var displayName: String?
    public var username: String?
    public var nip05: String?
    public var lud16: String?
    public var relayURLs: [String]?
    public var about: String?
    public var picture: String?

    public init(
        npub: String,
        name: String? = nil,
        displayName: String? = nil,
        username: String? = nil,
        nip05: String? = nil,
        lud16: String? = nil,
        relayURLs: [String]? = nil,
        about: String? = nil,
        picture: String? = nil
    ) {
        self.npub = npub
        self.name = name
        self.displayName = displayName
        self.username = username
        self.nip05 = nip05
        self.lud16 = lud16
        self.relayURLs = relayURLs
        self.about = about
        self.picture = picture
    }

    public init(contact: NostrContact) {
        self.init(
            npub: contact.npub,
            name: contact.profile?.name,
            displayName: contact.profile?.displayName ?? contact.petname,
            username: contact.profile?.username,
            nip05: contact.profile?.nip05,
            lud16: contact.profile?.lud16,
            relayURLs: contact.relayURLs,
            about: contact.profile?.about,
            picture: contact.profile?.picture
        )
    }

    public var publicKey: String? { NostrPublicKey.parse(npub)?.hexString }
    public var primaryName: String {
        displayName?.trimmedNilIfEmpty
            ?? name?.trimmedNilIfEmpty
            ?? username?.trimmedNilIfEmpty.map { "@\($0.trimmingCharacters(in: CharacterSet(charactersIn: "@")))" }
            ?? nip05?.trimmedNilIfEmpty
            ?? shortNpub
    }
    public var shortNpub: String {
        npub.count > 22 ? "\(npub.prefix(12))…\(npub.suffix(6))" : npub
    }

    fileprivate func normalized() -> SharedContactDelivery? {
        guard let key = NostrPublicKey.parse(npub),
              let canonicalNpub = NostrPublicKey.npub(from: key) else { return nil }
        var copy = self
        copy.npub = canonicalNpub
        copy.name = name?.trimmedNilIfEmpty
        copy.displayName = displayName?.trimmedNilIfEmpty
        copy.username = username?.trimmedNilIfEmpty
        copy.nip05 = nip05?.trimmedNilIfEmpty
        copy.lud16 = lud16?.trimmedNilIfEmpty
        copy.relayURLs = TaskifyRelayURL.normalizedList(relayURLs ?? []).nilIfEmpty
        copy.about = about?.trimmedNilIfEmpty
        copy.picture = picture?.trimmedNilIfEmpty
        return copy
    }
}

public struct SharedContactInboxItem: Identifiable, Codable, Equatable, Sendable {
    public var id: String { wrapEventID }
    public var wrapEventID: String
    public var rumorEventID: String
    public var sender: SharedInboxSender
    public var contact: SharedContactDelivery
    public var receivedAt: Date
    public var status: SharedInboxItemStatus
    public var respondedAt: Date?

    public init(
        wrapEventID: String,
        rumorEventID: String,
        sender: SharedInboxSender,
        contact: SharedContactDelivery,
        receivedAt: Date,
        status: SharedInboxItemStatus = .pending,
        respondedAt: Date? = nil
    ) {
        self.wrapEventID = wrapEventID
        self.rumorEventID = rumorEventID
        self.sender = sender
        self.contact = contact
        self.receivedAt = receivedAt
        self.status = status
        self.respondedAt = respondedAt
    }
}

public struct SharedCalendarEventDelivery: Codable, Equatable, Sendable {
    public var eventID: String
    public var canonical: String
    public var view: String
    public var eventKey: String
    public var inviteToken: String
    public var title: String?
    public var start: String?
    public var end: String?
    public var relayURLs: [String]?

    public init(
        eventID: String,
        canonical: String,
        view: String,
        eventKey: String,
        inviteToken: String,
        title: String? = nil,
        start: String? = nil,
        end: String? = nil,
        relayURLs: [String]? = nil
    ) {
        self.eventID = eventID
        self.canonical = canonical
        self.view = view
        self.eventKey = eventKey
        self.inviteToken = inviteToken
        self.title = title
        self.start = start
        self.end = end
        self.relayURLs = relayURLs
    }

    public var displayTitle: String { title?.trimmedNilIfEmpty ?? "Event invite" }
    public var eventAuthorPublicKey: String? {
        Self.calendarAddress(canonical, expectedKind: 30_310)?.publicKey
    }
    public var isAllDay: Bool {
        start.map(Self.isDateOnly) == true
    }
    public var startDate: Date? { start.flatMap(Self.parseDate) }
    public var endDate: Date? { end.flatMap(Self.parseDate) }

    fileprivate func normalized() -> SharedCalendarEventDelivery? {
        let eventID = eventID.trimmingCharacters(in: .whitespacesAndNewlines)
        let canonical = canonical.trimmingCharacters(in: .whitespacesAndNewlines)
        let view = view.trimmingCharacters(in: .whitespacesAndNewlines)
        let eventKey = eventKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let inviteToken = inviteToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !eventID.isEmpty, !eventKey.isEmpty, !inviteToken.isEmpty,
              let canonicalAddress = Self.calendarAddress(canonical, expectedKind: 30_310),
              let viewAddress = Self.calendarAddress(view, expectedKind: 30_311),
              canonicalAddress.publicKey == viewAddress.publicKey,
              canonicalAddress.identifier == eventID,
              viewAddress.identifier == eventID else { return nil }
        return SharedCalendarEventDelivery(
            eventID: eventID,
            canonical: canonical,
            view: view,
            eventKey: eventKey,
            inviteToken: inviteToken,
            title: title?.trimmedNilIfEmpty,
            start: start?.trimmedNilIfEmpty,
            end: end?.trimmedNilIfEmpty,
            relayURLs: TaskifyRelayURL.normalizedList(relayURLs ?? []).nilIfEmpty
        )
    }

    private static func calendarAddress(
        _ value: String,
        expectedKind: Int
    ) -> (publicKey: String, identifier: String)? {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, Int(parts[0]) == expectedKind,
              NostrPublicKey.parse(String(parts[1])) != nil else { return nil }
        let identifier = parts.dropFirst(2).joined(separator: ":")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty else { return nil }
        return (String(parts[1]).lowercased(), identifier)
    }

    private static func parseDate(_ value: String) -> Date? {
        if isDateOnly(value) {
            return dateOnlyFormatter.date(from: value)
        }
        return ISO8601DateFormatter().date(from: value)
    }

    private static func isDateOnly(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return dateOnlyExpression.firstMatch(in: value, range: range)?.range == range
    }

    private static let dateOnlyExpression = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}$"#)
    private static let dateOnlyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

public struct SharedCalendarInviteInboxItem: Identifiable, Codable, Equatable, Sendable {
    public var id: String { wrapEventID }
    public var wrapEventID: String
    public var rumorEventID: String
    public var sender: SharedInboxSender
    public var event: SharedCalendarEventDelivery
    public var receivedAt: Date
    public var status: SharedInboxItemStatus
    public var respondedAt: Date?

    public init(
        wrapEventID: String,
        rumorEventID: String,
        sender: SharedInboxSender,
        event: SharedCalendarEventDelivery,
        receivedAt: Date,
        status: SharedInboxItemStatus = .pending,
        respondedAt: Date? = nil
    ) {
        self.wrapEventID = wrapEventID
        self.rumorEventID = rumorEventID
        self.sender = sender
        self.event = event
        self.receivedAt = receivedAt
        self.status = status
        self.respondedAt = respondedAt
    }
}

public enum TaskifyEventSchedule: String, Codable, Sendable {
    case date
    case time
}

public struct TaskifyEventParticipant: Codable, Equatable, Sendable {
    public var publicKey: String
    public var relayURL: String?
    public var role: String?

    public init(publicKey: String, relayURL: String? = nil, role: String? = nil) {
        self.publicKey = publicKey
        self.relayURL = relayURL
        self.role = role
    }

    enum CodingKeys: String, CodingKey {
        case publicKey = "pubkey"
        case relayURL = "relay"
        case role
    }
}

/// A Taskify event accepted from the encrypted event-sharing protocol. This is
/// deliberately independent from EventKit and the optional Apple integrations.
public struct TaskifyEvent: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var boardID: String?
    public var columnID: String?
    public var order: Int?
    public var title: String
    public var summary: String?
    public var details: String?
    public var imageURL: String?
    public var documents: [TaskDocument]?
    public var locations: [String]?
    public var geohash: String?
    public var hashtags: [String]?
    public var references: [String]?
    public var participants: [TaskifyEventParticipant]?
    public var schedule: TaskifyEventSchedule
    public var startDateValue: String?
    public var endDateValue: String?
    public var startISO: String?
    public var endISO: String?
    public var startTimeZoneID: String?
    public var endTimeZoneID: String?
    public var createdBy: String?
    public var lastEditedBy: String?
    public var canonicalAddress: String
    public var viewAddress: String
    public var eventKey: String
    public var inviteToken: String
    public var inviteTokens: [String: String]?
    public var relayURLs: [String]?
    public var rsvpStatus: SharedInboxItemStatus
    public var sourceUpdatedAt: Int?
    public var readOnly: Bool?
    public var deleted: Bool?
    public var nostrUpdatedAt: Int?

    public init(
        id: String,
        boardID: String? = nil,
        columnID: String? = nil,
        order: Int? = nil,
        title: String,
        summary: String? = nil,
        details: String? = nil,
        imageURL: String? = nil,
        documents: [TaskDocument]? = nil,
        locations: [String]? = nil,
        geohash: String? = nil,
        hashtags: [String]? = nil,
        references: [String]? = nil,
        participants: [TaskifyEventParticipant]? = nil,
        schedule: TaskifyEventSchedule,
        startDateValue: String? = nil,
        endDateValue: String? = nil,
        startISO: String? = nil,
        endISO: String? = nil,
        startTimeZoneID: String? = nil,
        endTimeZoneID: String? = nil,
        createdBy: String? = nil,
        lastEditedBy: String? = nil,
        canonicalAddress: String,
        viewAddress: String,
        eventKey: String,
        inviteToken: String,
        inviteTokens: [String: String]? = nil,
        relayURLs: [String]? = nil,
        rsvpStatus: SharedInboxItemStatus,
        sourceUpdatedAt: Int? = nil,
        readOnly: Bool? = nil,
        deleted: Bool? = nil,
        nostrUpdatedAt: Int? = nil
    ) {
        self.id = id
        self.boardID = boardID
        self.columnID = columnID
        self.order = order
        self.title = title
        self.summary = summary
        self.details = details
        self.imageURL = imageURL
        self.documents = documents
        self.locations = locations
        self.geohash = geohash
        self.hashtags = hashtags
        self.references = references
        self.participants = participants
        self.schedule = schedule
        self.startDateValue = startDateValue
        self.endDateValue = endDateValue
        self.startISO = startISO
        self.endISO = endISO
        self.startTimeZoneID = startTimeZoneID
        self.endTimeZoneID = endTimeZoneID
        self.createdBy = createdBy
        self.lastEditedBy = lastEditedBy
        self.canonicalAddress = canonicalAddress
        self.viewAddress = viewAddress
        self.eventKey = eventKey
        self.inviteToken = inviteToken
        self.inviteTokens = inviteTokens
        self.relayURLs = relayURLs
        self.rsvpStatus = rsvpStatus
        self.sourceUpdatedAt = sourceUpdatedAt
        self.readOnly = readOnly
        self.deleted = deleted
        self.nostrUpdatedAt = nostrUpdatedAt
    }

    public var isAllDay: Bool { schedule == .date }
    public var isReadOnly: Bool { readOnly ?? (boardID == nil) }
    public var isDeleted: Bool { deleted == true }

    public var startDate: Date? {
        switch schedule {
        case .date: startDateValue.flatMap(Self.dateOnly)
        case .time: startISO.flatMap(Self.isoDate)
        }
    }

    public var endDate: Date? {
        switch schedule {
        case .date: endDateValue.flatMap(Self.dateOnly) ?? startDate
        case .time: endISO.flatMap(Self.isoDate)
        }
    }

    public func occurs(on date: Date, calendar: Calendar = .current) -> Bool {
        guard let startDate else { return false }
        let day = calendar.startOfDay(for: date)
        let first = calendar.startOfDay(for: startDate)
        let last = calendar.startOfDay(for: endDate ?? startDate)
        return day >= first && day <= max(first, last)
    }

    static func dateOnly(_ value: String) -> Date? {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            return nil
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func isoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: value)
    }
}

public enum TaskifyEventInviteError: LocalizedError, Equatable {
    case invalidInvitation
    case eventDeleted
    case eventUnavailable

    public var errorDescription: String? {
        switch self {
        case .invalidInvitation: "This Taskify event invitation is invalid."
        case .eventDeleted: "This Taskify event was deleted by its organizer."
        case .eventUnavailable: "The Taskify event details could not be loaded from its relays."
        }
    }
}

public enum TaskifyEventContract {
    public static let canonicalEventKind = 30_310
    public static let viewEventKind = 30_311

    public static func decodeViewEvent(
        _ event: NostrEvent,
        invite: SharedCalendarEventDelivery,
        status: SharedInboxItemStatus
    ) throws -> TaskifyEvent {
        guard status == .accepted || status == .tentative,
              event.kind == viewEventKind,
              event.verify(),
              event.publicKey.caseInsensitiveCompare(invite.eventAuthorPublicKey ?? "") == .orderedSame,
              event.firstTagValue(named: "d") == invite.eventID,
              event.firstTagValue(named: "a") == invite.canonical,
              let key = Data(base64Encoded: invite.eventKey), key.count == 32 else {
            throw TaskifyEventInviteError.invalidInvitation
        }
        let plaintext = try NIP44V2.decrypt(event.content, conversationKey: key)
        let payload = try JSONDecoder().decode(ViewPayload.self, from: plaintext)
        guard payload.version == 1, payload.eventID == invite.eventID else {
            throw TaskifyEventInviteError.invalidInvitation
        }
        if payload.deleted == true { throw TaskifyEventInviteError.eventDeleted }
        return try materialize(
            payload: payload,
            invite: invite,
            status: status,
            sourceUpdatedAt: event.createdAt
        )
    }

    public static func fallbackEvent(
        invite: SharedCalendarEventDelivery,
        status: SharedInboxItemStatus
    ) throws -> TaskifyEvent {
        guard status == .accepted || status == .tentative,
              let start = invite.start?.trimmedNilIfEmpty else {
            throw TaskifyEventInviteError.eventUnavailable
        }
        let payload: ViewPayload
        if TaskifyEvent.dateOnly(start) != nil {
            payload = ViewPayload(
                version: 1,
                eventID: invite.eventID,
                kind: .date,
                title: invite.displayTitle,
                startDate: start,
                endDate: invite.end
            )
        } else if TaskifyEvent.isoDate(start) != nil {
            payload = ViewPayload(
                version: 1,
                eventID: invite.eventID,
                kind: .time,
                title: invite.displayTitle,
                startISO: start,
                endISO: invite.end
            )
        } else {
            throw TaskifyEventInviteError.eventUnavailable
        }
        return try materialize(payload: payload, invite: invite, status: status, sourceUpdatedAt: nil)
    }

    private static func materialize(
        payload: ViewPayload,
        invite: SharedCalendarEventDelivery,
        status: SharedInboxItemStatus,
        sourceUpdatedAt: Int?
    ) throws -> TaskifyEvent {
        guard let kind = payload.kind,
              let title = payload.title?.trimmedNilIfEmpty else {
            throw TaskifyEventInviteError.invalidInvitation
        }
        switch kind {
        case .date:
            guard let start = payload.startDate?.trimmedNilIfEmpty,
                  TaskifyEvent.dateOnly(start) != nil else {
                throw TaskifyEventInviteError.invalidInvitation
            }
            let end = payload.endDate?.trimmedNilIfEmpty.flatMap {
                TaskifyEvent.dateOnly($0) != nil && $0 >= start ? $0 : nil
            }
            return event(
                payload: payload,
                invite: invite,
                status: status,
                schedule: .date,
                title: title,
                startDateValue: start,
                endDateValue: end,
                sourceUpdatedAt: sourceUpdatedAt
            )
        case .time:
            guard let start = payload.startISO?.trimmedNilIfEmpty,
                  let startDate = TaskifyEvent.isoDate(start) else {
                throw TaskifyEventInviteError.invalidInvitation
            }
            let end: String? = payload.endISO?.trimmedNilIfEmpty.flatMap { value -> String? in
                guard let date = TaskifyEvent.isoDate(value), date > startDate else { return nil }
                return value
            }
            return event(
                payload: payload,
                invite: invite,
                status: status,
                schedule: .time,
                title: title,
                startISO: start,
                endISO: end,
                sourceUpdatedAt: sourceUpdatedAt
            )
        }
    }

    private static func event(
        payload: ViewPayload,
        invite: SharedCalendarEventDelivery,
        status: SharedInboxItemStatus,
        schedule: TaskifyEventSchedule,
        title: String,
        startDateValue: String? = nil,
        endDateValue: String? = nil,
        startISO: String? = nil,
        endISO: String? = nil,
        sourceUpdatedAt: Int?
    ) -> TaskifyEvent {
        TaskifyEvent(
            id: invite.eventID,
            title: title,
            summary: payload.summary?.trimmedNilIfEmpty,
            details: payload.description?.trimmedNilIfEmpty,
            imageURL: payload.image?.trimmedNilIfEmpty,
            documents: payload.documents,
            locations: normalized(payload.locations),
            geohash: payload.geohash?.trimmedNilIfEmpty,
            hashtags: normalized(payload.hashtags),
            references: normalized(payload.references),
            schedule: schedule,
            startDateValue: startDateValue,
            endDateValue: endDateValue,
            startISO: startISO,
            endISO: endISO,
            startTimeZoneID: payload.startTimeZoneID?.trimmedNilIfEmpty,
            endTimeZoneID: payload.endTimeZoneID?.trimmedNilIfEmpty,
            createdBy: normalizedPublicKey(payload.createdBy),
            lastEditedBy: normalizedPublicKey(payload.lastEditedBy),
            canonicalAddress: invite.canonical,
            viewAddress: invite.view,
            eventKey: invite.eventKey,
            inviteToken: invite.inviteToken,
            relayURLs: TaskifyRelayURL.normalizedList(invite.relayURLs ?? []).nilIfEmpty,
            rsvpStatus: status,
            sourceUpdatedAt: sourceUpdatedAt
        )
    }

    private static func normalized(_ values: [String]?) -> [String]? {
        values?.compactMap(\.trimmedNilIfEmpty).nilIfEmpty
    }

    private static func normalizedPublicKey(_ value: String?) -> String? {
        value.flatMap { NostrPublicKey.parse($0)?.hexString }
    }

    private struct ViewPayload: Codable {
        var version: Int
        var eventID: String
        var createdBy: String?
        var lastEditedBy: String?
        var kind: TaskifyEventSchedule?
        var title: String?
        var summary: String?
        var description: String?
        var image: String?
        var documents: [TaskDocument]?
        var locations: [String]?
        var geohash: String?
        var hashtags: [String]?
        var references: [String]?
        var startDate: String?
        var endDate: String?
        var startISO: String?
        var endISO: String?
        var startTimeZoneID: String?
        var endTimeZoneID: String?
        var deleted: Bool?

        enum CodingKeys: String, CodingKey {
            case version = "v"
            case eventID = "eventId"
            case createdBy, lastEditedBy, kind, title, summary, description, image
            case documents, locations, geohash, hashtags, references, startDate, endDate, startISO, endISO
            case startTimeZoneID = "startTzid"
            case endTimeZoneID = "endTzid"
            case deleted
        }

        init(
            version: Int,
            eventID: String,
            kind: TaskifyEventSchedule,
            title: String,
            startDate: String? = nil,
            endDate: String? = nil,
            startISO: String? = nil,
            endISO: String? = nil
        ) {
            self.version = version
            self.eventID = eventID
            self.kind = kind
            self.title = title
            self.startDate = startDate
            self.endDate = endDate
            self.startISO = startISO
            self.endISO = endISO
        }
    }
}

public enum TaskifyEventInvitationResolver {
    public static func resolve(
        invite: SharedCalendarEventDelivery,
        status: SharedInboxItemStatus,
        relayURLs: [String],
        timeout: Duration = .seconds(3)
    ) async throws -> TaskifyEvent {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        if let author = invite.eventAuthorPublicKey, !relays.isEmpty {
            let events = await withTaskGroup(of: [NostrEvent].self) { group in
                for relayURL in relays {
                    group.addTask {
                        await fetchView(
                            relayURL: relayURL,
                            authorPublicKey: author,
                            eventID: invite.eventID,
                            timeout: timeout
                        )
                    }
                }
                var collected: [NostrEvent] = []
                for await relayEvents in group { collected.append(contentsOf: relayEvents) }
                return collected
            }
            if let latest = events.max(by: { $0.createdAt < $1.createdAt }) {
                do {
                    return try TaskifyEventContract.decodeViewEvent(latest, invite: invite, status: status)
                } catch TaskifyEventInviteError.eventDeleted {
                    throw TaskifyEventInviteError.eventDeleted
                } catch {
                    // The authenticated DM summary remains a safe fallback when a relay
                    // has a stale or temporarily unreadable view event.
                }
            }
        }
        return try TaskifyEventContract.fallbackEvent(invite: invite, status: status)
    }

    private static func fetchView(
        relayURL: String,
        authorPublicKey: String,
        eventID: String,
        timeout: Duration
    ) async -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        let subscriptionID = "taskify-event-view-\(UUID().uuidString)"
        let stream = connection.messages()
        do {
            try await connection.connect()
            try await connection.subscribeToTaskifyEventView(
                id: subscriptionID,
                authorPublicKey: authorPublicKey,
                eventID: eventID
            )
        } catch {
            await connection.disconnect()
            return []
        }
        let result = await withTaskGroup(of: [NostrEvent].self) { group in
            group.addTask {
                var events: [NostrEvent] = []
                for await message in stream {
                    guard !Task.isCancelled else { return events }
                    switch message {
                    case .event(let id, let event) where id == subscriptionID:
                        events.append(event)
                    case .endOfStoredEvents(let id) where id == subscriptionID:
                        return events
                    case .closed(let id, _) where id == subscriptionID:
                        return events
                    case .disconnected:
                        return events
                    default:
                        continue
                    }
                }
                return events
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return []
            }
            let first = await group.next() ?? []
            group.cancelAll()
            return first
        }
        try? await connection.closeSubscription(id: subscriptionID)
        await connection.disconnect()
        return result
    }
}

public enum SharedCalendarRSVPContract {
    public static let eventKind = 30_312

    public static func event(
        invite: SharedCalendarEventDelivery,
        status: SharedInboxItemStatus,
        identity: NostrIdentity,
        createdAt: Int
    ) throws -> NostrEvent {
        guard status == .accepted || status == .declined || status == .tentative,
              let author = invite.eventAuthorPublicKey,
              let authorKey = try? Data(hex: author) else {
            throw NostrEventError.invalidEvent
        }
        let payload = CalendarRSVPPayload(
            version: 1,
            eventID: invite.eventID,
            status: status.rawValue,
            inviteToken: invite.inviteToken
        )
        let plaintext = try JSONEncoder().encode(payload)
        let encrypted = try NIP44V2.encrypt(
            plaintext,
            privateKey: identity.privateKey,
            publicKey: authorKey
        )
        return try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: createdAt,
            kind: eventKind,
            tags: [
                ["d", "\(invite.eventID):\(identity.publicKeyHex)"],
                ["a", invite.canonical],
            ],
            content: encrypted
        )
    }
}

private struct CalendarRSVPPayload: Codable {
    var version: Int
    var eventID: String
    var status: String
    var inviteToken: String

    enum CodingKeys: String, CodingKey {
        case version = "v"
        case eventID = "eventId"
        case status
        case inviteToken
    }
}

public struct SharedTaskAssignmentResponse: Codable, Equatable, Sendable {
    public var taskID: String
    public var status: SharedTaskAssignmentStatus
    public var respondedAt: String?

    enum CodingKeys: String, CodingKey {
        case taskID = "taskId"
        case status
        case respondedAt
    }

    public init(taskID: String, status: SharedTaskAssignmentStatus, respondedAt: String? = nil) {
        self.taskID = taskID
        self.status = status
        self.respondedAt = respondedAt
    }
}

public enum TaskifyShareItem: Equatable, Sendable {
    case task(SharedTaskDelivery)
    case contact(SharedContactDelivery)
    case calendarEvent(SharedCalendarEventDelivery)
    case assignmentResponse(SharedTaskAssignmentResponse)
}

public struct TaskifyShareEnvelope: Equatable, Sendable {
    public var item: TaskifyShareItem
    public var senderNpub: String?
    public var senderName: String?

    public init(item: TaskifyShareItem, senderNpub: String? = nil, senderName: String? = nil) {
        self.item = item
        self.senderNpub = senderNpub
        self.senderName = senderName
    }

    public static func decode(content: String) -> TaskifyShareEnvelope? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let data: Data?
        if trimmed.first == "{" {
            data = Data(trimmed.utf8)
        } else {
            data = embeddedEnvelopeData(in: content)
        }
        guard let data,
              let wire = try? JSONDecoder().decode(ShareEnvelopeWire.self, from: data),
              wire.version == 1,
              wire.kind == "taskify-share" else { return nil }

        let item: TaskifyShareItem
        switch wire.item.type {
        case "task":
            guard let delivery = wire.item.taskDelivery?.normalized() else { return nil }
            item = .task(delivery)
        case "contact":
            guard let delivery = wire.item.contactDelivery?.normalized() else { return nil }
            item = .contact(delivery)
        case "event":
            guard let delivery = wire.item.calendarEventDelivery?.normalized() else { return nil }
            item = .calendarEvent(delivery)
        case "task-assignment-response":
            guard let response = wire.item.assignmentResponse,
                  !response.taskID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  response.status != .pending else { return nil }
            item = .assignmentResponse(response)
        default:
            return nil
        }
        return TaskifyShareEnvelope(
            item: item,
            senderNpub: wire.sender?.npub?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            senderName: wire.sender?.name?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        )
    }

    public func encoded() throws -> Data {
        let item: ShareItemWire
        switch self.item {
        case .task(let delivery):
            item = ShareItemWire(taskDelivery: delivery)
        case .contact(let delivery):
            item = ShareItemWire(contactDelivery: delivery)
        case .calendarEvent(let delivery):
            item = ShareItemWire(calendarEventDelivery: delivery)
        case .assignmentResponse(let response):
            item = ShareItemWire(assignmentResponse: response)
        }
        return try JSONEncoder().encode(ShareEnvelopeWire(
            version: 1,
            kind: "taskify-share",
            item: item,
            sender: (senderNpub == nil && senderName == nil)
                ? nil
                : ShareSenderWire(npub: senderNpub, name: senderName)
        ))
    }

    public func messageContent() throws -> String {
        let json = String(decoding: try encoded(), as: UTF8.self)
        guard case .task(let task) = item, task.isAssignment else { return json }

        var lines = ["Task Assignment", "", "Title: \(task.title)"]
        if let priority = task.priority {
            let label = priority == 3 ? "High" : priority == 2 ? "Medium" : priority == 1 ? "Low" : nil
            if let label { lines.append("Priority: \(label)") }
        }
        lines.append("Due: \(Self.assignmentDueDescription(task))")
        if let note = task.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            lines.append(contentsOf: ["", "Details:", note])
        }
        let subtasks = (task.subtasks ?? [])
            .map { $0.title.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if !subtasks.isEmpty {
            lines.append(contentsOf: ["", "Checklist:"])
            lines.append(contentsOf: subtasks.prefix(5).map { "- \($0)" })
            if subtasks.count > 5 { lines.append("- ...and \(subtasks.count - 5) more") }
        }
        let token = Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        lines.append(contentsOf: [
            "",
            "Open this in Taskify to accept, decline, or maybe.",
            "",
            "Taskify-Share: \(token)",
        ])
        return lines.joined(separator: "\n")
    }

    private static func assignmentDueDescription(_ task: SharedTaskDelivery) -> String {
        guard task.dueDateEnabled != false else { return "No due date" }
        guard let dueDate = task.dueDate else { return "Not specified" }
        let formatter = DateFormatter()
        formatter.locale = .current
        if let zone = task.dueTimeZone.flatMap(TimeZone.init(identifier:)) {
            formatter.timeZone = zone
        }
        formatter.dateStyle = .medium
        formatter.timeStyle = task.dueTimeEnabled == true ? .short : .none
        let formatted = formatter.string(from: dueDate)
        return task.dueTimeZone.map { "\(formatted) (\($0))" } ?? formatted
    }

    private static func embeddedEnvelopeData(in content: String) -> Data? {
        guard let markerRange = content.range(of: "Taskify-Share:") else { return nil }
        let suffix = content[markerRange.upperBound...]
        guard let token = suffix.split(whereSeparator: \.isWhitespace).first else { return nil }
        var base64 = String(token).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }
}

private struct ShareEnvelopeWire: Codable {
    var version: Int
    var kind: String
    var item: ShareItemWire
    var sender: ShareSenderWire?

    enum CodingKeys: String, CodingKey {
        case version = "v"
        case kind
        case item
        case sender
    }
}

private struct ShareSenderWire: Codable {
    var npub: String?
    var name: String?
}

private struct ShareItemWire: Codable {
    var type: String
    var npub: String? = nil
    var name: String? = nil
    var displayName: String? = nil
    var username: String? = nil
    var nip05: String? = nil
    var lud16: String? = nil
    var about: String? = nil
    var picture: String? = nil
    var title: String? = nil
    var note: String? = nil
    var priority: Int? = nil
    var dueISO: String? = nil
    var dueDateEnabled: Bool? = nil
    var dueTimeEnabled: Bool? = nil
    var dueTimeZone: String? = nil
    var reminders: [TaskReminder]? = nil
    var subtasks: [SharedSubtaskWire]? = nil
    var recurrence: TaskRecurrence? = nil
    var documents: [TaskDocument]? = nil
    var assignees: [SharedTaskAssignee]? = nil
    var sourceTaskID: String? = nil
    var assignment: Bool? = nil
    var relayURLs: [String]? = nil
    var taskID: String? = nil
    var status: SharedTaskAssignmentStatus? = nil
    var respondedAt: String? = nil
    var eventID: String? = nil
    var canonical: String? = nil
    var view: String? = nil
    var eventKey: String? = nil
    var inviteToken: String? = nil
    var start: String? = nil
    var end: String? = nil

    enum CodingKeys: String, CodingKey {
        case type
        case npub
        case name
        case displayName
        case username
        case nip05
        case lud16
        case about
        case picture
        case title
        case note
        case priority
        case dueISO
        case dueDateEnabled
        case dueTimeEnabled
        case dueTimeZone
        case reminders
        case subtasks
        case recurrence
        case documents
        case assignees
        case sourceTaskID = "sourceTaskId"
        case assignment
        case relayURLs = "relays"
        case taskID = "taskId"
        case status
        case respondedAt
        case eventID = "eventId"
        case canonical
        case view
        case eventKey
        case inviteToken
        case start
        case end
    }

    init(taskDelivery: SharedTaskDelivery) {
        type = "task"
        title = taskDelivery.title
        note = taskDelivery.note
        priority = taskDelivery.priority
        dueISO = taskDelivery.dueISO
        dueDateEnabled = taskDelivery.dueDateEnabled
        dueTimeEnabled = taskDelivery.dueTimeEnabled
        dueTimeZone = taskDelivery.dueTimeZone
        reminders = taskDelivery.reminders
        subtasks = taskDelivery.subtasks?.map(SharedSubtaskWire.init)
        recurrence = taskDelivery.recurrence
        documents = taskDelivery.documents
        assignees = taskDelivery.assignees
        sourceTaskID = taskDelivery.sourceTaskID
        assignment = taskDelivery.assignment
        relayURLs = taskDelivery.relayURLs
    }

    init(contactDelivery: SharedContactDelivery) {
        type = "contact"
        npub = contactDelivery.npub
        name = contactDelivery.name
        displayName = contactDelivery.displayName
        username = contactDelivery.username
        nip05 = contactDelivery.nip05
        lud16 = contactDelivery.lud16
        relayURLs = contactDelivery.relayURLs
        about = contactDelivery.about
        picture = contactDelivery.picture
    }

    init(calendarEventDelivery: SharedCalendarEventDelivery) {
        type = "event"
        eventID = calendarEventDelivery.eventID
        canonical = calendarEventDelivery.canonical
        view = calendarEventDelivery.view
        eventKey = calendarEventDelivery.eventKey
        inviteToken = calendarEventDelivery.inviteToken
        title = calendarEventDelivery.title
        start = calendarEventDelivery.start
        end = calendarEventDelivery.end
        relayURLs = calendarEventDelivery.relayURLs
    }

    init(assignmentResponse: SharedTaskAssignmentResponse) {
        type = "task-assignment-response"
        taskID = assignmentResponse.taskID
        status = assignmentResponse.status
        respondedAt = assignmentResponse.respondedAt
    }

    var taskDelivery: SharedTaskDelivery? {
        guard let title else { return nil }
        return SharedTaskDelivery(
            title: title,
            note: note,
            priority: priority,
            dueISO: dueISO,
            dueDateEnabled: dueDateEnabled,
            dueTimeEnabled: dueTimeEnabled,
            dueTimeZone: dueTimeZone,
            reminders: reminders,
            subtasks: subtasks?.map(\.taskSubtask),
            recurrence: recurrence,
            documents: documents,
            assignees: assignees,
            sourceTaskID: sourceTaskID,
            assignment: assignment,
            relayURLs: relayURLs
        )
    }

    var assignmentResponse: SharedTaskAssignmentResponse? {
        guard let taskID, let status else { return nil }
        return SharedTaskAssignmentResponse(taskID: taskID, status: status, respondedAt: respondedAt)
    }

    var contactDelivery: SharedContactDelivery? {
        guard let npub else { return nil }
        return SharedContactDelivery(
            npub: npub,
            name: name,
            displayName: displayName,
            username: username,
            nip05: nip05,
            lud16: lud16,
            relayURLs: relayURLs,
            about: about,
            picture: picture
        )
    }

    var calendarEventDelivery: SharedCalendarEventDelivery? {
        guard let eventID, let canonical, let view, let eventKey, let inviteToken else { return nil }
        return SharedCalendarEventDelivery(
            eventID: eventID,
            canonical: canonical,
            view: view,
            eventKey: eventKey,
            inviteToken: inviteToken,
            title: title,
            start: start,
            end: end,
            relayURLs: relayURLs
        )
    }
}

private struct SharedSubtaskWire: Codable {
    var id: String?
    var title: String
    var completed: Bool?

    init(_ subtask: TaskSubtask) {
        id = subtask.id
        title = subtask.title
        completed = subtask.completed
    }

    var taskSubtask: TaskSubtask {
        TaskSubtask(
            id: id?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                ?? UUID().uuidString,
            title: title,
            completed: completed ?? false
        )
    }
}

public struct NIP17InboxMessage: Equatable, Sendable {
    public var wrapEventID: String
    public var rumorEventID: String
    public var senderPublicKey: String
    public var createdAt: Int
    public var envelope: TaskifyShareEnvelope

    public init(
        wrapEventID: String,
        rumorEventID: String,
        senderPublicKey: String,
        createdAt: Int,
        envelope: TaskifyShareEnvelope
    ) {
        self.wrapEventID = wrapEventID
        self.rumorEventID = rumorEventID
        self.senderPublicKey = senderPublicKey
        self.createdAt = createdAt
        self.envelope = envelope
    }
}

public struct NIP17DecryptedRumor: Equatable, Sendable {
    public var wrapEventID: String
    public var rumor: NIP17Rumor

    public init(wrapEventID: String, rumor: NIP17Rumor) {
        self.wrapEventID = wrapEventID
        self.rumor = rumor
    }
}

public enum NIP17GiftWrapError: LocalizedError {
    case invalidWrap
    case wrongRecipient
    case invalidSeal
    case invalidRumor

    public var errorDescription: String? {
        switch self {
        case .invalidWrap: "The shared message wrapper is invalid."
        case .wrongRecipient: "The shared message belongs to another recipient."
        case .invalidSeal: "The shared message seal is invalid."
        case .invalidRumor: "The shared Taskify message is invalid."
        }
    }
}

public enum NIP17GiftWrap {
    public static let wrapKind = 1_059
    public static let sealKind = 13
    public static let rumorKind = 14

    public static func unwrap(
        _ wrap: NostrEvent,
        recipient: NostrIdentity
    ) throws -> NIP17InboxMessage {
        let decrypted = try unwrapRumor(wrap, recipient: recipient)
        let rumor = decrypted.rumor
        guard rumor.kind == rumorKind,
              let envelope = TaskifyShareEnvelope.decode(content: rumor.content) else {
            throw NIP17GiftWrapError.invalidRumor
        }
        return NIP17InboxMessage(
            wrapEventID: decrypted.wrapEventID,
            rumorEventID: rumor.id,
            senderPublicKey: rumor.publicKey.lowercased(),
            createdAt: rumor.createdAt,
            envelope: envelope
        )
    }

    public static func unwrapRumor(
        _ wrap: NostrEvent,
        recipient: NostrIdentity
    ) throws -> NIP17DecryptedRumor {
        guard wrap.kind == wrapKind, wrap.verify() else { throw NIP17GiftWrapError.invalidWrap }
        guard wrap.tags.contains(where: {
            $0.count >= 2 && $0[0] == "p" && $0[1].lowercased() == recipient.publicKeyHex
        }) else { throw NIP17GiftWrapError.wrongRecipient }
        guard let wrapPublicKey = try? Data(hex: wrap.publicKey) else {
            throw NIP17GiftWrapError.invalidWrap
        }
        let sealData = try NIP44V2.decrypt(
            wrap.content,
            privateKey: recipient.privateKey,
            publicKey: wrapPublicKey
        )
        guard let seal = try? JSONDecoder().decode(NostrEvent.self, from: sealData),
              seal.kind == sealKind,
              seal.verify(),
              let senderPublicKey = try? Data(hex: seal.publicKey) else {
            throw NIP17GiftWrapError.invalidSeal
        }
        let rumorData = try NIP44V2.decrypt(
            seal.content,
            privateKey: recipient.privateKey,
            publicKey: senderPublicKey
        )
        guard let rumor = try? JSONDecoder().decode(NIP17Rumor.self, from: rumorData),
              rumor.publicKey.lowercased() == seal.publicKey.lowercased(),
              rumor.verifyID() else {
            throw NIP17GiftWrapError.invalidRumor
        }
        // The verified outer kind-1059 wrap is encrypted to this recipient and
        // carries its `p` tag. NIP-17 chat clients commonly repeat that tag on
        // the inner kind-14 rumor, but NUT-18/CDK payment senders intentionally
        // create an otherwise valid rumor with no inner tags. Requiring a second
        // recipient marker here silently discarded those Cashu payments before
        // the wallet could journal or redeem them.
        return NIP17DecryptedRumor(
            wrapEventID: wrap.id,
            rumor: rumor
        )
    }

    public static func wrap(
        envelope: TaskifyShareEnvelope,
        sender: NostrIdentity,
        recipientPublicKey: Data,
        createdAt: Int = Int(Date().timeIntervalSince1970),
        ephemeralIdentity: NostrIdentity? = nil
    ) throws -> NostrEvent {
        guard recipientPublicKey.count == 32 else { throw NIP17GiftWrapError.wrongRecipient }
        let recipientHex = recipientPublicKey.hexString
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: createdAt,
            kind: rumorKind,
            tags: [["p", recipientHex]],
            content: try envelope.messageContent()
        )
        return try wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: recipientPublicKey,
            ephemeralIdentity: ephemeralIdentity
        )
    }

    public static func wrap(
        rumor: NIP17Rumor,
        sender: NostrIdentity,
        recipientPublicKey: Data,
        ephemeralIdentity: NostrIdentity? = nil
    ) throws -> NostrEvent {
        guard recipientPublicKey.count == 32 else { throw NIP17GiftWrapError.wrongRecipient }
        guard rumor.publicKey == sender.publicKeyHex, rumor.verifyID() else {
            throw NIP17GiftWrapError.invalidRumor
        }
        let recipientHex = recipientPublicKey.hexString
        let rumorData = try JSONEncoder().encode(rumor)
        let sealedContent = try NIP44V2.encrypt(
            rumorData,
            privateKey: sender.privateKey,
            publicKey: recipientPublicKey
        )
        let seal = try NostrEvent.signed(
            privateKey: sender.privateKey,
            createdAt: randomizedPastTimestamp(relativeTo: rumor.createdAt),
            kind: sealKind,
            tags: [],
            content: sealedContent
        )
        let sealData = try JSONEncoder().encode(seal)
        let ephemeral = try (ephemeralIdentity ?? NostrIdentity.generate())
        let wrapContent = try NIP44V2.encrypt(
            sealData,
            privateKey: ephemeral.privateKey,
            publicKey: recipientPublicKey
        )
        return try NostrEvent.signed(
            privateKey: ephemeral.privateKey,
            createdAt: randomizedPastTimestamp(relativeTo: rumor.createdAt),
            kind: wrapKind,
            tags: [["p", recipientHex]],
            content: wrapContent
        )
    }

    private static func randomizedPastTimestamp(relativeTo timestamp: Int) -> Int {
        max(0, timestamp - Int.random(in: 0...(2 * 24 * 60 * 60)))
    }
}

public struct NIP17Rumor: Codable, Equatable, Sendable {
    public var id: String
    public var publicKey: String
    public var createdAt: Int
    public var kind: Int
    public var tags: [[String]]
    public var content: String

    enum CodingKeys: String, CodingKey {
        case id
        case publicKey = "pubkey"
        case createdAt = "created_at"
        case kind
        case tags
        case content
    }

    public init(publicKey: String, createdAt: Int, kind: Int, tags: [[String]], content: String) throws {
        self.publicKey = publicKey.lowercased()
        self.createdAt = createdAt
        self.kind = kind
        self.tags = tags
        self.content = content
        id = try NostrEvent.calculateID(
            publicKey: self.publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )
    }

    public var recipientPublicKeys: [String] {
        tags.compactMap { $0.count >= 2 && $0[0] == "p" ? $0[1].lowercased() : nil }
    }

    public func verifyID() -> Bool {
        (try? NostrEvent.calculateID(
            publicKey: publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )) == id.lowercased()
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
    var trimmedNilIfEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

private extension Array {
    var nilIfEmpty: [Element]? { isEmpty ? nil : self }

    func uniqued<Key: Hashable>(by keyPath: KeyPath<Element, Key>) -> [Element] {
        var seen = Set<Key>()
        return filter { seen.insert($0[keyPath: keyPath]).inserted }
    }
}

public extension TaskifySnapshot {
    var sharedInbox: [SharedInboxItem] {
        (sharedInboxItems ?? []).sorted { lhs, rhs in
            if lhs.status != rhs.status {
                return lhs.status == .pending
            }
            return lhs.receivedAt > rhs.receivedAt
        }
    }

    var pendingSharedInboxCount: Int {
        (sharedInboxItems ?? []).filter { $0.status == .pending }.count
    }

    var sharedContactInbox: [SharedContactInboxItem] {
        (sharedContactInboxItems ?? []).sorted {
            if $0.status != $1.status { return $0.status == .pending }
            return $0.receivedAt > $1.receivedAt
        }
    }

    var sharedCalendarInvites: [SharedCalendarInviteInboxItem] {
        (sharedCalendarInviteItems ?? []).sorted {
            if $0.status != $1.status { return $0.status == .pending }
            return $0.receivedAt > $1.receivedAt
        }
    }

    var acceptedTaskifyEvents: [TaskifyEvent] {
        (taskifyEvents ?? []).filter { !$0.isDeleted }.sorted {
            ($0.startDate ?? .distantFuture) < ($1.startDate ?? .distantFuture)
        }
    }

    @discardableResult
    mutating func ingestSharedInboxItem(_ item: SharedInboxItem) -> Bool {
        var items = sharedInboxItems ?? []
        guard !items.contains(where: {
            $0.wrapEventID == item.wrapEventID || $0.rumorEventID == item.rumorEventID
        }) else { return false }
        items.append(item)
        if items.count > 400 {
            items = Array(items.sorted { $0.receivedAt > $1.receivedAt }.prefix(400))
        }
        sharedInboxItems = items
        return true
    }

    @discardableResult
    mutating func ingestSharedContactInboxItem(_ item: SharedContactInboxItem) -> Bool {
        var items = sharedContactInboxItems ?? []
        guard !items.contains(where: {
            $0.wrapEventID == item.wrapEventID || $0.rumorEventID == item.rumorEventID
        }) else { return false }
        items.append(item)
        if items.count > 400 {
            items = Array(items.sorted { $0.receivedAt > $1.receivedAt }.prefix(400))
        }
        sharedContactInboxItems = items
        return true
    }

    @discardableResult
    mutating func ingestSharedCalendarInvite(_ item: SharedCalendarInviteInboxItem) -> Bool {
        var items = sharedCalendarInviteItems ?? []
        guard !items.contains(where: {
            $0.wrapEventID == item.wrapEventID ||
                $0.rumorEventID == item.rumorEventID ||
                ($0.event.canonical == item.event.canonical && $0.sender.publicKey == item.sender.publicKey)
        }) else { return false }
        items.append(item)
        if items.count > 400 {
            items = Array(items.sorted { $0.receivedAt > $1.receivedAt }.prefix(400))
        }
        sharedCalendarInviteItems = items
        return true
    }

    @discardableResult
    mutating func setSharedInboxStatus(
        itemID: String,
        status: SharedInboxItemStatus,
        now: Date = Date()
    ) -> SharedInboxItem? {
        guard var items = sharedInboxItems,
              let index = items.firstIndex(where: { $0.id == itemID }) else { return nil }
        items[index].status = status
        items[index].respondedAt = now
        sharedInboxItems = items
        return items[index]
    }

    @discardableResult
    mutating func setSharedContactInboxStatus(
        itemID: String,
        status: SharedInboxItemStatus,
        now: Date = Date()
    ) -> SharedContactInboxItem? {
        guard var items = sharedContactInboxItems,
              let index = items.firstIndex(where: { $0.id == itemID }) else { return nil }
        items[index].status = status
        items[index].respondedAt = now
        sharedContactInboxItems = items
        return items[index]
    }

    @discardableResult
    mutating func setSharedCalendarInviteStatus(
        itemID: String,
        status: SharedInboxItemStatus,
        now: Date = Date()
    ) -> SharedCalendarInviteInboxItem? {
        guard var items = sharedCalendarInviteItems,
              let index = items.firstIndex(where: { $0.id == itemID }) else { return nil }
        items[index].status = status
        items[index].respondedAt = now
        sharedCalendarInviteItems = items
        return items[index]
    }

    @discardableResult
    mutating func upsertTaskifyEvent(_ event: TaskifyEvent) -> Bool {
        var events = taskifyEvents ?? []
        if let index = events.firstIndex(where: {
            $0.id == event.id && $0.viewAddress == event.viewAddress
        }) {
            guard events[index] != event else { return false }
            events[index] = event
        } else {
            events.append(event)
        }
        taskifyEvents = events
        return true
    }

    @discardableResult
    mutating func mergeRemoteTaskifyEvent(
        _ remoteEvent: TaskifyEvent,
        eventCreatedAt: Int
    ) -> Bool {
        var events = taskifyEvents ?? []
        if let index = events.firstIndex(where: {
            $0.id == remoteEvent.id && $0.boardID == remoteEvent.boardID
        }) {
            guard eventCreatedAt > (events[index].nostrUpdatedAt ?? 0) else { return false }
            var merged = remoteEvent
            merged.nostrUpdatedAt = eventCreatedAt
            events[index] = merged
        } else {
            var inserted = remoteEvent
            inserted.nostrUpdatedAt = eventCreatedAt
            events.append(inserted)
        }
        taskifyEvents = events
        return true
    }

    @discardableResult
    mutating func acceptSharedTask(
        inboxItemID: String,
        destinationBoardID: String,
        destinationColumnID: String?,
        recipientPublicKey: String,
        now: Date = Date(),
        calendar baseCalendar: Calendar = .current
    ) -> TaskItem? {
        guard let inboxItem = (sharedInboxItems ?? []).first(where: { $0.id == inboxItemID }),
              inboxItem.status != .accepted,
              let board = boards.first(where: { $0.id == destinationBoardID && $0.isVisible }),
              board.kind == .week || board.kind == .list else { return nil }

        let delivery = inboxItem.task
        var dueDate = delivery.dueDate
        let dueDateEnabled: Bool
        let columnID: String?
        switch board.kind {
        case .week:
            dueDate = dueDate ?? now
            dueDateEnabled = true
            columnID = WeekdayColumn.containing(dueDate!, calendar: baseCalendar).rawValue
        case .list:
            guard let destinationColumnID,
                  board.columns.contains(where: { $0.id == destinationColumnID }) else { return nil }
            dueDateEnabled = delivery.dueDateEnabled ?? (dueDate != nil)
            if dueDateEnabled, dueDate == nil { dueDate = now }
            if !dueDateEnabled { dueDate = nil }
            columnID = destinationColumnID
        case .compound, .bible:
            return nil
        }

        let normalizedRecipient = recipientPublicKey.lowercased()
        let respondedAt = Int64(now.timeIntervalSince1970 * 1_000)
        var assignees = delivery.assignees ?? []
        if let index = assignees.firstIndex(where: { $0.publicKey.lowercased() == normalizedRecipient }) {
            assignees[index].status = .accepted
            assignees[index].respondedAt = respondedAt
        } else if delivery.isAssignment {
            assignees.append(SharedTaskAssignee(
                publicKey: normalizedRecipient,
                status: .accepted,
                respondedAt: respondedAt
            ))
        }

        var preservedFields: [String: TaskPayloadValue] = [:]
        if !assignees.isEmpty {
            preservedFields["assignees"] = .array(assignees.map { assignee in
                var object: [String: TaskPayloadValue] = [
                    "pubkey": .string(assignee.publicKey),
                ]
                if let relay = assignee.relay { object["relay"] = .string(relay) }
                if let status = assignee.status { object["status"] = .string(status.rawValue) }
                if let respondedAt = assignee.respondedAt { object["respondedAt"] = .integer(respondedAt) }
                return .object(object)
            })
        }

        let notePrefix = "\(delivery.isAssignment ? "Assigned" : "Shared") by \(inboxItem.sender.displayName)"
        let note = [notePrefix, delivery.note]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        let nextOrder = (
            tasks
                .filter { $0.boardID == board.id && $0.columnID == columnID && !$0.isDeleted }
                .map(\.order)
                .max() ?? -1
        ) + 1
        let recurrence = dueDateEnabled && delivery.recurrence?.isActive == true
            ? delivery.recurrence
            : nil
        let task = TaskItem(
            boardID: board.id,
            title: delivery.title,
            note: note,
            dueDate: dueDate,
            dueDateEnabled: dueDateEnabled,
            dueTimeEnabled: dueDateEnabled && delivery.dueTimeEnabled == true,
            dueTimeZone: dueDateEnabled && delivery.dueTimeEnabled == true ? delivery.dueTimeZone : nil,
            priority: delivery.priority.flatMap(TaskPriority.init(rawValue:)),
            documents: delivery.documents,
            subtasks: delivery.subtasks,
            recurrence: recurrence,
            reminders: dueDateEnabled ? delivery.reminders : nil,
            createdAt: now,
            order: nextOrder,
            columnID: columnID,
            createdBy: inboxItem.sender.publicKey,
            lastEditedBy: inboxItem.sender.publicKey,
            preservedSyncFields: preservedFields.isEmpty ? nil : preservedFields
        )
        tasks.append(task)
        _ = setSharedInboxStatus(itemID: inboxItemID, status: .accepted, now: now)
        return task
    }
}
