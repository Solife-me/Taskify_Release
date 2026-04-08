import Foundation
import SwiftData

@Model
final class TaskifyTask {
    var id: String
    var boardId: String
    var title: String
    var note: String?
    var dueISO: String
    var dueDateEnabled: Bool?
    var dueTimeEnabled: Bool?
    var dueTimeZone: String?
    var priority: Int?
    var createdAt: Int
    var order: Int
    var column: String?
    var completed: Bool
    var completedAt: String?
    var hiddenUntilISO: String?
    var recurrence: Data?
    var seriesId: String?
    var streak: Int?
    var longestStreak: Int?
    var bounty: Data?
    var bountyDeletedAt: String?
    var bountyLists: [String]?
    var reminders: [String]?
    var reminderTime: String?
    var documents: [Document]?
    var scriptureMemoryId: String?
    var scriptureMemoryStage: Int?
    var scriptureMemoryPrevReviewISO: String?
    var scriptureMemoryScheduledAt: String?

    init(
        id: String,
        boardId: String,
        title: String,
        note: String? = nil,
        dueISO: String,
        dueDateEnabled: Bool? = true,
        dueTimeEnabled: Bool? = false,
        dueTimeZone: String? = nil,
        priority: Int? = nil,
        createdAt: Int = Int(Date().timeIntervalSince1970 * 1000),
        order: Int = 0,
        column: String? = "day",
        completed: Bool = false,
        completedAt: String? = nil,
        hiddenUntilISO: String? = nil,
        recurrence: RecurrenceRule? = nil,
        seriesId: String? = nil,
        streak: Int? = nil,
        longestStreak: Int? = nil,
        bounty: Bounty? = nil,
        bountyDeletedAt: String? = nil,
        bountyLists: [String]? = nil,
        reminders: [String]? = nil,
        reminderTime: String? = nil,
        documents: [Document]? = nil,
        scriptureMemoryId: String? = nil,
        scriptureMemoryStage: Int? = nil,
        scriptureMemoryPrevReviewISO: String? = nil,
        scriptureMemoryScheduledAt: String? = nil
    ) {
        self.id = id
        self.boardId = boardId
        self.title = title
        self.note = note
        self.dueISO = dueISO
        self.dueDateEnabled = dueDateEnabled
        self.dueTimeEnabled = dueTimeEnabled
        self.dueTimeZone = dueTimeZone
        self.priority = priority
        self.createdAt = createdAt
        self.order = order
        self.column = column
        self.completed = completed
        self.completedAt = completedAt
        self.hiddenUntilISO = hiddenUntilISO
        self.seriesId = seriesId
        self.streak = streak
        self.longestStreak = longestStreak
        self.bountyDeletedAt = bountyDeletedAt
        self.bountyLists = bountyLists
        self.reminders = reminders
        self.reminderTime = reminderTime
        self.documents = documents
        self.scriptureMemoryId = scriptureMemoryId
        self.scriptureMemoryStage = scriptureMemoryStage
        self.scriptureMemoryPrevReviewISO = scriptureMemoryPrevReviewISO
        self.scriptureMemoryScheduledAt = scriptureMemoryScheduledAt

        if let recurrence = recurrence {
            self.recurrence = try? JSONEncoder().encode(recurrence)
        }
        if let bounty = bounty {
            self.bounty = try? JSONEncoder().encode(bounty)
        }
    }
}

@Model
final class TaskifyEvent {
    var id: String
    var boardId: String
    var columnId: String?
    var order: Int
    var title: String
    var summary: String?
    var description: String?
    var documents: [Document]?
    var image: String?
    var locations: [String]?
    var geohash: String?
    var reminders: [String]?
    var reminderTime: String?
    var readOnly: Bool?
    var hiddenUntilISO: String?
    var recurrence: Data?
    var seriesId: String?
    var kind: String // "date" or "time"
    var startISO: String?
    var endISO: String?
    var startTzid: String?
    var endTzid: String?
    var startDate: String?
    var endDate: String?
    var participants: [Participant]?
    var hashtags: [String]?
    var references: [String]?
    var external: Bool?
    var originBoardId: String?
    var eventKey: String?
    var inviteTokens: [String: String]?
    var canonicalAddress: String?
    var viewAddress: String?
    var inviteToken: String?
    var inviteRelays: [String]?
    var boardPubkey: String?
    var rsvpStatus: String?
    var rsvpCreatedAt: Int?
    var rsvpFb: String

    init(
        id: String,
        boardId: String,
        title: String,
        kind: String = "time",
        startISO: String? = nil,
        endISO: String? = nil,
        startTzid: String? = nil,
        endTzid: String? = nil,
        columnId: String? = nil,
        order: Int = 0,
        summary: String? = nil,
        description: String? = nil,
        documents: [Document]? = nil,
        image: String? = nil,
        locations: [String]? = nil,
        geohash: String? = nil,
        reminders: [String]? = nil,
        reminderTime: String? = nil,
        readOnly: Bool? = nil,
        hiddenUntilISO: String? = nil,
        recurrence: RecurrenceRule? = nil,
        seriesId: String? = nil,
        participants: [Participant]? = nil,
        hashtags: [String]? = nil,
        references: [String]? = nil,
        external: Bool? = false,
        originBoardId: String? = nil,
        eventKey: String? = nil,
        inviteTokens: [String: String]? = nil,
        canonicalAddress: String? = nil,
        viewAddress: String? = nil,
        inviteToken: String? = nil,
        inviteRelays: [String]? = nil,
        boardPubkey: String? = nil,
        rsvpStatus: String? = nil,
        rsvpCreatedAt: Int? = nil,
        rsvpFb: String = "free",
        startDate: String? = nil,
        endDate: String? = nil
    ) {
        self.id = id
        self.boardId = boardId
        self.title = title
        self.kind = kind
        self.startISO = startISO
        self.endISO = endISO
        self.startTzid = startTzid
        self.endTzid = endTzid
        self.columnId = columnId
        self.order = order
        self.summary = summary
        self.description = description
        self.documents = documents
        self.image = image
        self.locations = locations
        self.geohash = geohash
        self.reminders = reminders
        self.reminderTime = reminderTime
        self.readOnly = readOnly
        self.hiddenUntilISO = hiddenUntilISO
        self.seriesId = seriesId
        self.hashtags = hashtags
        self.references = references
        self.external = external
        self.originBoardId = originBoardId
        self.eventKey = eventKey
        self.inviteTokens = inviteTokens
        self.canonicalAddress = canonicalAddress
        self.viewAddress = viewAddress
        self.inviteToken = inviteToken
        self.inviteRelays = inviteRelays
        self.boardPubkey = boardPubkey
        self.rsvpStatus = rsvpStatus
        self.rsvpCreatedAt = rsvpCreatedAt
        self.rsvpFb = rsvpFb
        self.startDate = startDate
        self.endDate = endDate

        if let recurrence = recurrence {
            self.recurrence = try? JSONEncoder().encode(recurrence)
        }

        if let participants = participants {
            self.participants = participants
        }
    }
}

@Model
final class TaskifyBoard {
    var id: String
    var name: String
    var kind: String // "week", "lists", "compound", "bible", "list"
    var archived: Bool
    var hidden: Bool
    var clearCompletedDisabled: Bool
    var columns: [ListColumn]?
    var children: [String]?
    var nostr: String?
    var indexCardEnabled: Bool
    var hideChildBoardNames: Bool

    init(
        id: String,
        name: String,
        kind: String = "week",
        archived: Bool = false,
        hidden: Bool = false,
        clearCompletedDisabled: Bool = false,
        columns: [ListColumn]? = nil,
        children: [String]? = nil,
        nostr: String? = nil,
        indexCardEnabled: Bool = false,
        hideChildBoardNames: Bool = false
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.archived = archived
        self.hidden = hidden
        self.clearCompletedDisabled = clearCompletedDisabled
        self.columns = columns
        self.children = children
        self.nostr = nostr
        self.indexCardEnabled = indexCardEnabled
        self.hideChildBoardNames = hideChildBoardNames
    }
}

@Model
final class TaskifySettings {
    var timeZone: String?
    var weekStart: Int
    var newTaskPosition: String
    var defaultBoardId: String
    var notificationsEnabled: Bool
    var soundEnabled: Bool
    var darkMode: Bool?
    var createdAt: Int
    var updatedAt: Int

    init(
        timeZone: String? = nil,
        weekStart: Int = 1,
        newTaskPosition: String = "bottom",
        defaultBoardId: String = "week-default",
        notificationsEnabled: Bool = true,
        soundEnabled: Bool = true,
        darkMode: Bool? = nil
    ) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        self.timeZone = timeZone
        self.weekStart = weekStart
        self.newTaskPosition = newTaskPosition
        self.defaultBoardId = defaultBoardId
        self.notificationsEnabled = notificationsEnabled
        self.soundEnabled = soundEnabled
        self.darkMode = darkMode
        self.createdAt = now
        self.updatedAt = now
    }
}

@Model
final class TaskifyDocument {
    var id: String
    var name: String
    var mimeType: String?
    var size: Int?
    var createdAt: Int

    init(
        id: String,
        name: String,
        mimeType: String? = nil,
        size: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.size = size
        self.createdAt = Int(Date().timeIntervalSince1970 * 1000)
    }
}

@Model
final class TaskifyParticipant {
    var id: String
    var pubkey: String
    var relay: String?
    var role: String?

    init(pubkey: String, relay: String? = nil, role: String? = nil) {
        self.id = UUID().uuidString
        self.pubkey = pubkey
        self.relay = relay
        self.role = role
    }
}

// MARK: - Codable Conformances for SwiftData types

extension TaskifyTask {
    var decodedRecurrence: RecurrenceRule? {
        guard let data = recurrence, let recurrence = try? JSONDecoder().decode(RecurrenceRule.self, from: data) else {
            return nil
        }
        return recurrence
    }

    var decodedBounty: Bounty? {
        guard let data = bounty, let bounty = try? JSONDecoder().decode(Bounty.self, from: data) else {
            return nil
        }
        return bounty
    }
}

extension TaskifyEvent {
    var decodedRecurrence: RecurrenceRule? {
        guard let data = recurrence, let recurrence = try? JSONDecoder().decode(RecurrenceRule.self, from: data) else {
            return nil
        }
        return recurrence
    }

    var decodedParticipants: [CalendarEventParticipant]? {
        guard let participants = participants,
              let data = try? JSONEncoder().encode(participants),
              let decoded = try? JSONDecoder().decode([CalendarEventParticipant].self, from: data) else {
            return nil
        }
        return decoded
    }
}