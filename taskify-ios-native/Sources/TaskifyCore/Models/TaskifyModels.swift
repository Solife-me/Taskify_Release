/// TaskifyModels.swift
/// Swift model types — full parity with FullTaskRecord, FullEventRecord, BoardEntry in the PWA/CLI.

import Foundation
import SwiftData

// MARK: - Task

@Model
public final class TaskifyTask {
    @Attribute(.unique) public var id: String        // UUID from "d" tag
    public var boardId: String
    public var boardName: String?
    public var title: String
    public var note: String?
    public var dueISO: String?
    public var dueDateEnabled: Bool?
    public var dueTimeEnabled: Bool?
    public var dueTimeZone: String?
    public var priority: Int?                        // 1, 2, or 3
    public var completed: Bool
    public var completedAt: String?
    public var completedBy: String?
    public var deleted: Bool
    public var column: String?
    public var createdAt: Int                        // Unix seconds (relay event created_at)
    public var updatedAt: String?
    public var createdBy: String?
    public var lastEditedBy: String?
    public var inboxItem: Bool?
    public var hiddenUntilISO: String?
    public var streak: Int?
    public var longestStreak: Int?
    public var seriesId: String?
    public var sourceBoardId: String?
    // Codable fields stored as JSON strings
    public var recurrenceJSON: String?
    public var subtasksJSON: String?
    public var assigneesJSON: String?
    public var documentsJSON: String?
    public var imagesJSON: String?

    public init(
        id: String,
        boardId: String,
        title: String,
        completed: Bool = false,
        deleted: Bool = false,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) {
        self.id = id
        self.boardId = boardId
        self.title = title
        self.completed = completed
        self.deleted = deleted
        self.createdAt = createdAt
        self.dueISO = ""
    }
}

// MARK: - Calendar Event

@Model
public final class TaskifyCalendarEvent {
    @Attribute(.unique) public var id: String
    public var boardId: String
    public var boardName: String?
    public var title: String
    public var summary: String?
    public var kind: String             // "date" or "time"
    public var startDate: String?
    public var endDate: String?
    public var startISO: String?
    public var endISO: String?
    public var startTzid: String?
    public var endTzid: String?
    public var eventDescription: String?
    public var columnId: String?
    public var order: Int?
    public var deleted: Bool
    public var createdAt: Int
    public var updatedAt: String?
    // Codable fields stored as JSON strings
    public var recurrenceJSON: String?
    public var participantsJSON: String?
    public var documentsJSON: String?
    public var locationsJSON: String?
    public var referencesJSON: String?

    public init(id: String, boardId: String, title: String, kind: String = "date", createdAt: Int = Int(Date().timeIntervalSince1970)) {
        self.id = id
        self.boardId = boardId
        self.title = title
        self.kind = kind
        self.deleted = false
        self.createdAt = createdAt
    }
}

// MARK: - Board

@Model
public final class TaskifyBoard {
    @Attribute(.unique) public var id: String
    public var name: String
    public var kind: String             // "lists" | "week" | "compound"
    public var archived: Bool
    public var hidden: Bool
    public var indexCardEnabled: Bool
    public var clearCompletedDisabled: Bool
    public var hideChildBoardNames: Bool
    public var lastSyncAt: Int?         // Unix seconds — incremental sync cursor
    public var metadataCreatedAt: Int?  // Unix seconds — latest kind 30300 board-definition event
    // JSON-encoded arrays
    public var columnsJSON: String?
    public var childrenJSON: String?
    public var relayHintsJSON: String?
    public var sortMode: String?
    public var sortDirection: String?

    public init(id: String, name: String, kind: String = "lists") {
        self.id = id
        self.name = name
        self.kind = kind
        self.archived = false
        self.hidden = false
        self.indexCardEnabled = false
        self.clearCompletedDisabled = false
        self.hideChildBoardNames = false
    }
}

// MARK: - Profile / Identity

/// Stored in Keychain, not SwiftData.
public struct TaskifyProfile: Codable, Equatable {
    public var name: String
    public var nsecHex: String          // 32-byte hex
    public var npub: String             // bech32
    public var relays: [String]
    public var boards: [ProfileBoardEntry]

    public init(name: String, nsecHex: String, npub: String, relays: [String], boards: [ProfileBoardEntry]) {
        self.name = name
        self.nsecHex = nsecHex
        self.npub = npub
        self.relays = relays
        self.boards = boards
    }
}

public struct ProfileBoardEntry: Codable, Equatable {
    public var id: String
    public var name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

// MARK: - Recurrence (mirrors Recurrence type in CLI)

public struct Recurrence: Codable {
    public var freq: String             // "DAY" | "WKL" | "MON" | "YER"
    public var interval: Int?
    public var byDay: [String]?
    public var endDate: String?
    public var count: Int?
}

// MARK: - Subtask

public struct Subtask: Codable, Identifiable {
    public var id: String
    public var title: String
    public var completed: Bool
}

// MARK: - TaskAssignee

public struct TaskAssignee: Codable {
    public var pubkey: String
    public var relay: String?
    public var status: String?          // "pending" | "accepted" | "declined" | "tentative"
    public var respondedAt: Int?
}

// MARK: - Column

public struct BoardColumn: Codable, Identifiable, Equatable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

// MARK: - Filter / sort helpers

public enum TaskStatus {
    case open, done, any
}

public enum TaskSortMode: String {
    case manual, dueDate, priority, createdAt, alphabetical
}

// MARK: - Contacts

public enum TaskifyContactKind: String, Codable, CaseIterable, Sendable {
    case nostr
    case custom
}

public enum TaskifyContactSource: String, Codable, CaseIterable, Sendable {
    case manual
    case profile
    case scan
    case sync
}

@Model
public final class TaskifyContact {
    @Attribute(.unique) public var id: String
    public var kindRaw: String
    public var name: String
    public var address: String
    public var paymentRequest: String
    public var npub: String
    public var username: String?
    public var displayName: String?
    public var nip05: String?
    public var about: String?
    public var picture: String?
    public var relaysJSON: String?
    public var createdAt: Int
    public var updatedAt: Int
    public var sourceRaw: String?

    public init(
        id: String,
        kind: TaskifyContactKind = .custom,
        name: String = "",
        address: String = "",
        paymentRequest: String = "",
        npub: String = "",
        createdAt: Int = Int(Date().timeIntervalSince1970 * 1000),
        updatedAt: Int = Int(Date().timeIntervalSince1970 * 1000),
        source: TaskifyContactSource? = nil
    ) {
        self.id = id
        self.kindRaw = kind.rawValue
        self.name = name
        self.address = address
        self.paymentRequest = paymentRequest
        self.npub = npub
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.sourceRaw = source?.rawValue
    }
}

@Model
public final class TaskifyPublicFollow {
    @Attribute(.unique) public var pubkey: String
    public var relay: String?
    public var petname: String?
    public var username: String?
    public var nip05: String?
    public var updatedAt: Int

    public init(
        pubkey: String,
        relay: String? = nil,
        petname: String? = nil,
        username: String? = nil,
        nip05: String? = nil,
        updatedAt: Int = Int(Date().timeIntervalSince1970 * 1000)
    ) {
        self.pubkey = pubkey
        self.relay = relay
        self.petname = petname
        self.username = username
        self.nip05 = nip05
        self.updatedAt = updatedAt
    }
}

public struct TaskifyContactRecord: Identifiable, Equatable, Sendable {
    public var id: String
    public var kind: TaskifyContactKind
    public var name: String
    public var address: String
    public var paymentRequest: String
    public var npub: String
    public var username: String?
    public var displayName: String?
    public var nip05: String?
    public var about: String?
    public var picture: String?
    public var relays: [String]
    public var createdAt: Int
    public var updatedAt: Int
    public var source: TaskifyContactSource?

    public init(
        id: String,
        kind: TaskifyContactKind,
        name: String,
        address: String,
        paymentRequest: String,
        npub: String,
        username: String? = nil,
        displayName: String? = nil,
        nip05: String? = nil,
        about: String? = nil,
        picture: String? = nil,
        relays: [String] = [],
        createdAt: Int,
        updatedAt: Int,
        source: TaskifyContactSource? = nil
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.address = address
        self.paymentRequest = paymentRequest
        self.npub = npub
        self.username = username
        self.displayName = displayName
        self.nip05 = nip05
        self.about = about
        self.picture = picture
        self.relays = relays
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.source = source
    }
}

public struct TaskifyContactDraft: Equatable, Sendable {
    public var id: String?
    public var kind: TaskifyContactKind
    public var name: String
    public var address: String
    public var paymentRequest: String
    public var npub: String
    public var username: String
    public var displayName: String
    public var nip05: String
    public var about: String
    public var picture: String
    public var relays: [String]
    public var source: TaskifyContactSource?

    public init(
        id: String? = nil,
        kind: TaskifyContactKind = .custom,
        name: String = "",
        address: String = "",
        paymentRequest: String = "",
        npub: String = "",
        username: String = "",
        displayName: String = "",
        nip05: String = "",
        about: String = "",
        picture: String = "",
        relays: [String] = [],
        source: TaskifyContactSource? = nil
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.address = address
        self.paymentRequest = paymentRequest
        self.npub = npub
        self.username = username
        self.displayName = displayName
        self.nip05 = nip05
        self.about = about
        self.picture = picture
        self.relays = relays
        self.source = source
    }
}

public struct TaskifyPublicFollowRecord: Identifiable, Equatable, Codable, Sendable {
    public var pubkey: String
    public var relay: String?
    public var petname: String?
    public var username: String?
    public var nip05: String?
    public var updatedAt: Int

    public init(
        pubkey: String,
        relay: String? = nil,
        petname: String? = nil,
        username: String? = nil,
        nip05: String? = nil,
        updatedAt: Int = Int(Date().timeIntervalSince1970 * 1000)
    ) {
        self.pubkey = pubkey
        self.relay = relay
        self.petname = petname
        self.username = username
        self.nip05 = nip05
        self.updatedAt = updatedAt
    }

    public var id: String { pubkey }
}

public struct TaskifyProfileMetadata: Codable, Equatable, Sendable {
    public var username: String
    public var displayName: String
    public var lud16: String
    public var nip05: String
    public var about: String
    public var picture: String
    public var updatedAt: Int?

    public init(
        username: String = "",
        displayName: String = "",
        lud16: String = "",
        nip05: String = "",
        about: String = "",
        picture: String = "",
        updatedAt: Int? = nil
    ) {
        self.username = username
        self.displayName = displayName
        self.lud16 = lud16
        self.nip05 = nip05
        self.about = about
        self.picture = picture
        self.updatedAt = updatedAt
    }
}
