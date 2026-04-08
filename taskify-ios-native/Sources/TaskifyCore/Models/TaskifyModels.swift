import Foundation

public typealias Weekday = Int

public enum TaskPriority: Int, Codable, Sendable {
    case low = 1
    case medium = 2
    case high = 3
}

public enum RecurrenceType: String, Codable, Sendable {
    case none
    case daily
    case weekly
    case every
    case monthlyDay
}

public struct RecurrenceRule: Codable, Equatable, Sendable {
    public var type: RecurrenceType
    public var unit: String?
    public var n: Int?
    public var days: [Weekday]?
    public var day: Int?
    public var interval: Int?
    public var untilISO: String?

    public init(
        type: RecurrenceType,
        unit: String? = nil,
        n: Int? = nil,
        days: [Weekday]? = nil,
        day: Int? = nil,
        interval: Int? = nil,
        untilISO: String? = nil
    ) {
        self.type = type
        self.unit = unit
        self.n = n
        self.days = days
        self.day = day
        self.interval = interval
        self.untilISO = untilISO
    }
}

public struct Bounty: Codable, Equatable, Sendable {
    public var owner: String?
    public var sender: String?
    public var receiver: String?
    public var token: String?
    public var enc: String?
    public var state: String?
    public var lock: String?

    public init(
        owner: String? = nil,
        sender: String? = nil,
        receiver: String? = nil,
        token: String? = nil,
        enc: String? = nil,
        state: String? = nil,
        lock: String? = nil
    ) {
        self.owner = owner
        self.sender = sender
        self.receiver = receiver
        self.token = token
        self.enc = enc
        self.state = state
        self.lock = lock
    }
}

public struct Document: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var mimeType: String?
    public var size: Int?
    public var createdAt: Int?

    public init(
        id: String,
        name: String,
        mimeType: String? = nil,
        size: Int? = nil,
        createdAt: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.size = size
        self.createdAt = createdAt
    }
}

public struct Task: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var boardId: String
    public var title: String
    public var note: String?
    public var dueISO: String
    public var dueDateEnabled: Bool?
    public var dueTimeEnabled: Bool?
    public var dueTimeZone: String?
    public var priority: TaskPriority?
    public var createdAt: Int?
    public var order: Int?
    public var column: String?
    public var completed: Bool?
    public var completedAt: String?
    public var hiddenUntilISO: String?
    public var recurrence: RecurrenceRule?
    public var seriesId: String?
    public var streak: Int?
    public var longestStreak: Int?
    public var bounty: Bounty?
    public var bountyDeletedAt: String?
    public var bountyLists: [String]?
    public var reminders: [String]?
    public var reminderTime: String?
    public var documents: [Document]?
    public var scriptureMemoryId: String?
    public var scriptureMemoryStage: Int?
    public var scriptureMemoryPrevReviewISO: String?
    public var scriptureMemoryScheduledAt: String?

    public init(
        id: String,
        boardId: String,
        title: String,
        note: String? = nil,
        dueISO: String,
        dueDateEnabled: Bool? = nil,
        dueTimeEnabled: Bool? = nil,
        dueTimeZone: String? = nil,
        priority: TaskPriority? = nil,
        createdAt: Int? = nil,
        order: Int? = nil,
        column: String? = nil,
        completed: Bool? = nil,
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
        self.recurrence = recurrence
        self.seriesId = seriesId
        self.streak = streak
        self.longestStreak = longestStreak
        self.bounty = bounty
        self.bountyDeletedAt = bountyDeletedAt
        self.bountyLists = bountyLists
        self.reminders = reminders
        self.reminderTime = reminderTime
        self.documents = documents
        self.scriptureMemoryId = scriptureMemoryId
        self.scriptureMemoryStage = scriptureMemoryStage
        self.scriptureMemoryPrevReviewISO = scriptureMemoryPrevReviewISO
        self.scriptureMemoryScheduledAt = scriptureMemoryScheduledAt
    }
}

public enum EventKind: String, Codable, Sendable {
    case date
    case time
}

public struct CalendarEventParticipant: Codable, Equatable, Sendable {
    public var pubkey: String
    public var relay: String?
    public var role: String?

    public init(pubkey: String, relay: String? = nil, role: String? = nil) {
        self.pubkey = pubkey
        self.relay = relay
        self.role = role
    }
}

public struct CalendarEvent: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var boardId: String
    public var columnId: String?
    public var order: Int?
    public var title: String
    public var summary: String?
    public var description: String?
    public var documents: [Document]?
    public var image: String?
    public var locations: [String]?
    public var geohash: String?
    public var reminders: [String]?
    public var reminderTime: String?
    public var readOnly: Bool?
    public var hiddenUntilISO: String?
    public var recurrence: RecurrenceRule?
    public var seriesId: String?
    public var kind: EventKind
    public var startISO: String?
    public var endISO: String?
    public var startTzid: String?
    public var endTzid: String?
    public var startDate: String?
    public var endDate: String?
    public var participants: [CalendarEventParticipant]?
    public var hashtags: [String]?
    public var references: [String]?
    public var external: Bool?
    public var originBoardId: String?
    public var eventKey: String?
    public var inviteTokens: [String: String]?
    public var canonicalAddress: String?
    public var viewAddress: String?
    public var inviteToken: String?
    public var inviteRelays: [String]?
    public var boardPubkey: String?
    public var rsvpStatus: String?
    public var rsvpCreatedAt: Int?
    public var rsvpFb: String?

    public init(
        id: String,
        boardId: String,
        title: String,
        kind: EventKind,
        columnId: String? = nil,
        order: Int? = nil,
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
        startISO: String? = nil,
        endISO: String? = nil,
        startTzid: String? = nil,
        endTzid: String? = nil,
        startDate: String? = nil,
        endDate: String? = nil,
        participants: [CalendarEventParticipant]? = nil,
        hashtags: [String]? = nil,
        references: [String]? = nil,
        external: Bool? = nil,
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
        rsvpFb: String? = nil
    ) {
        self.id = id
        self.boardId = boardId
        self.columnId = columnId
        self.order = order
        self.title = title
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
        self.recurrence = recurrence
        self.seriesId = seriesId
        self.kind = kind
        self.startISO = startISO
        self.endISO = endISO
        self.startTzid = startTzid
        self.endTzid = endTzid
        self.startDate = startDate
        self.endDate = endDate
        self.participants = participants
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
    }
}

public enum BoardKind: String, Codable, Sendable {
    case week
    case lists
    case compound
    case bible
    case list
}

public struct ListColumn: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct BoardNostrInfo: Codable, Equatable, Sendable {
    public var boardId: String?
    public var relays: [String]?
    public var description: String?

    public init(boardId: String? = nil, relays: [String]? = nil, description: String? = nil) {
        self.boardId = boardId
        self.relays = relays
        self.description = description
    }
}

public struct Board: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var kind: BoardKind
    public var archived: Bool
    public var hidden: Bool
    public var clearCompletedDisabled: Bool
    public var columns: [ListColumn]
    public var children: [String]
    public var nostr: BoardNostrInfo?
    public var indexCardEnabled: Bool
    public var hideChildBoardNames: Bool

    public init(
        id: String,
        name: String,
        kind: BoardKind,
        archived: Bool = false,
        hidden: Bool = false,
        clearCompletedDisabled: Bool = false,
        columns: [ListColumn] = [],
        children: [String] = [],
        nostr: BoardNostrInfo? = nil,
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

public struct Settings: Codable, Equatable, Sendable {
    public var timeZone: String?
    public var weekStart: Weekday
    public var newTaskPosition: String
    public var defaultBoardId: String
    public var notificationsEnabled: Bool
    public var soundEnabled: Bool
    public var darkMode: Bool?

    public init(
        timeZone: String? = nil,
        weekStart: Weekday = 1,
        newTaskPosition: String = "bottom",
        defaultBoardId: String = "week-default",
        notificationsEnabled: Bool = true,
        soundEnabled: Bool = true,
        darkMode: Bool? = nil
    ) {
        self.timeZone = timeZone
        self.weekStart = weekStart
        self.newTaskPosition = newTaskPosition
        self.defaultBoardId = defaultBoardId
        self.notificationsEnabled = notificationsEnabled
        self.soundEnabled = soundEnabled
        self.darkMode = darkMode
    }
}
