import Foundation

public struct TaskifyWatchTask: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let boardID: String
    public let boardName: String
    public let columnName: String?
    public let dueDate: Date?
    public let dueTimeEnabled: Bool
    public let priority: Int?
    public let order: Int
    /// Lossless Taskify sync context. These optional fields keep snapshots written by the first
    /// companion-only Watch builds decodable while allowing an authorized Watch to sync directly.
    public let columnID: String?
    public let nostrBoardID: String?
    public let relayURLs: [String]?
    public let syncPayload: Data?
    public let nostrUpdatedAt: Int?

    public init(
        id: String,
        title: String,
        boardID: String,
        boardName: String,
        columnName: String?,
        dueDate: Date?,
        dueTimeEnabled: Bool,
        priority: Int?,
        order: Int,
        columnID: String? = nil,
        nostrBoardID: String? = nil,
        relayURLs: [String]? = nil,
        syncPayload: Data? = nil,
        nostrUpdatedAt: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.boardID = boardID
        self.boardName = boardName
        self.columnName = columnName
        self.dueDate = dueDate
        self.dueTimeEnabled = dueTimeEnabled
        self.priority = priority
        self.order = order
        self.columnID = columnID
        self.nostrBoardID = nostrBoardID
        self.relayURLs = relayURLs
        self.syncPayload = syncPayload
        self.nostrUpdatedAt = nostrUpdatedAt
    }
}

/// Editable fields only; the phone preserves recurrence, attachments, and subtasks.
public struct TaskifyWatchTaskEdit: Codable, Equatable, Sendable {
    public var title: String
    public var note: String
    public var dueDate: Date?
    public var dueTimeEnabled: Bool
    public var dueTimeZone: String?
    public var priority: Int?

    public init(task: TaskifyWatchTask) {
        title = task.title
        note = task.note
        dueDate = task.dueDate
        dueTimeEnabled = task.dueTimeEnabled
        dueTimeZone = task.payloadObject["dueTimeZone"] as? String
        priority = task.priority
    }
}

public struct TaskifyWatchSubtask: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let completed: Bool
}

public extension TaskifyWatchTask {
    var payloadObject: [String: Any] {
        guard let syncPayload,
              let object = try? JSONSerialization.jsonObject(with: syncPayload) as? [String: Any] else { return [:] }
        return object
    }

    var note: String { payloadObject["note"] as? String ?? "" }

    var subtasks: [TaskifyWatchSubtask] {
        guard let rows = payloadObject["subtasks"],
              let data = try? JSONSerialization.data(withJSONObject: rows),
              let result = try? JSONDecoder().decode([TaskifyWatchSubtask].self, from: data) else { return [] }
        return result
    }

    func settingSubtaskCompletion(_ subtaskID: String, completed: Bool) -> TaskifyWatchTask {
        var object = payloadObject
        guard var rows = object["subtasks"] as? [[String: Any]],
              let index = rows.firstIndex(where: { $0["id"] as? String == subtaskID }) else { return self }
        rows[index]["completed"] = completed
        object["subtasks"] = rows
        return TaskifyWatchTask(
            id: id, title: title, boardID: boardID, boardName: boardName,
            columnName: columnName, dueDate: dueDate, dueTimeEnabled: dueTimeEnabled,
            priority: priority, order: order, columnID: columnID,
            nostrBoardID: nostrBoardID, relayURLs: relayURLs,
            syncPayload: try? JSONSerialization.data(withJSONObject: object),
            nostrUpdatedAt: nostrUpdatedAt
        )
    }

    func applying(_ edit: TaskifyWatchTaskEdit) -> TaskifyWatchTask {
        var object = payloadObject
        object["title"] = edit.title
        object["note"] = edit.note
        object["priority"] = edit.priority
        object["dueISO"] = edit.dueDate.map { ISO8601DateFormatter().string(from: $0) }
        object["dueDateEnabled"] = edit.dueDate != nil
        object["dueTimeEnabled"] = edit.dueDate != nil && edit.dueTimeEnabled
        object["dueTimeZone"] = edit.dueTimeEnabled ? edit.dueTimeZone : nil
        return TaskifyWatchTask(
            id: id, title: edit.title, boardID: boardID, boardName: boardName,
            columnName: columnName, dueDate: edit.dueDate,
            dueTimeEnabled: edit.dueDate != nil && edit.dueTimeEnabled,
            priority: edit.priority, order: order, columnID: columnID,
            nostrBoardID: nostrBoardID, relayURLs: relayURLs,
            syncPayload: try? JSONSerialization.data(withJSONObject: object),
            nostrUpdatedAt: nostrUpdatedAt
        )
    }
}

public struct TaskifyWatchBoardColumn: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let order: Int

    public init(id: String, name: String, order: Int) {
        self.id = id
        self.name = name
        self.order = order
    }
}

public struct TaskifyWatchBoard: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let openTaskCount: Int
    public let kind: String?
    public let nostrBoardID: String?
    public let relayURLs: [String]?
    public let defaultColumnID: String?
    public let columns: [TaskifyWatchBoardColumn]?
    public let nostrUpdatedAt: Int?

    public init(
        id: String,
        name: String,
        openTaskCount: Int,
        kind: String? = nil,
        nostrBoardID: String? = nil,
        relayURLs: [String]? = nil,
        defaultColumnID: String? = nil,
        columns: [TaskifyWatchBoardColumn]? = nil,
        nostrUpdatedAt: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.openTaskCount = openTaskCount
        self.kind = kind
        self.nostrBoardID = nostrBoardID
        self.relayURLs = relayURLs
        self.defaultColumnID = defaultColumnID
        self.columns = columns
        self.nostrUpdatedAt = nostrUpdatedAt
    }
}

/// The iPhone-selected accent and its legible foreground, represented without SwiftUI so it can
/// travel through the lightweight cross-target Watch contract.
public struct TaskifyWatchAccent: Codable, Equatable, Sendable {
    public let red: UInt8
    public let green: UInt8
    public let blue: UInt8
    public let foregroundRed: UInt8
    public let foregroundGreen: UInt8
    public let foregroundBlue: UInt8

    public init(
        red: UInt8,
        green: UInt8,
        blue: UInt8,
        foregroundRed: UInt8,
        foregroundGreen: UInt8,
        foregroundBlue: UInt8
    ) {
        self.red = red
        self.green = green
        self.blue = blue
        self.foregroundRed = foregroundRed
        self.foregroundGreen = foregroundGreen
        self.foregroundBlue = foregroundBlue
    }
}

public struct TaskifyWatchSnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 2

    public let schemaVersion: Int
    public let tasks: [TaskifyWatchTask]
    public let boards: [TaskifyWatchBoard]
    public let selectedBoardID: String?
    public let generatedAt: Date
    /// Recent command IDs accepted by the iPhone. Optional keeps snapshots written by the first
    /// Watch build decodable after upgrading.
    public let acknowledgedCommandIDs: [String]?
    /// A bounded, paired-device-only thread index. It may include one short local preview, but no
    /// message history or attachment keys; full messages still use the independent encrypted path.
    public let chatProjection: TaskifyWatchChatProjection?
    /// Optional keeps snapshots from builds before appearance sync decodable.
    public let accent: TaskifyWatchAccent?

    public init(
        schemaVersion: Int = TaskifyWatchSnapshot.currentSchemaVersion,
        tasks: [TaskifyWatchTask] = [],
        boards: [TaskifyWatchBoard] = [],
        selectedBoardID: String? = nil,
        generatedAt: Date = Date(),
        acknowledgedCommandIDs: [String]? = nil,
        chatProjection: TaskifyWatchChatProjection? = nil,
        accent: TaskifyWatchAccent? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.tasks = tasks
        self.boards = boards
        self.selectedBoardID = selectedBoardID
        self.generatedAt = generatedAt
        self.acknowledgedCommandIDs = acknowledgedCommandIDs
        self.chatProjection = chatProjection
        self.accent = accent
    }

    public func tasks(for boardID: String) -> [TaskifyWatchTask] {
        tasks.filter { $0.boardID == boardID }
    }

    public func todayTasks(
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskifyWatchTask] {
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
        return tasks.filter {
            guard let dueDate = $0.dueDate else { return false }
            return dueDate >= start && dueDate < end
        }
    }

    public func upcomingTasks(
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskifyWatchTask] {
        let start = calendar.startOfDay(for: now)
        return tasks.filter { ($0.dueDate ?? .distantPast) >= start }
    }
}

// MARK: - Watch widget snapshot

/// The intentionally small subset of a Watch task that is safe and useful in a WidgetKit
/// extension. Relay addresses, encrypted board payloads, and all signing material stay in the
/// Watch app process.
public struct TaskifyWatchWidgetTask: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let boardName: String
    public let dueDate: Date?

    public init(id: String, title: String, boardName: String, dueDate: Date?) {
        self.id = id
        self.title = title
        self.boardName = boardName
        self.dueDate = dueDate
    }
}

public struct TaskifyWatchWidgetSnapshot: Codable, Equatable, Sendable {
    public let tasks: [TaskifyWatchWidgetTask]
    public let generatedAt: Date

    public init(tasks: [TaskifyWatchWidgetTask] = [], generatedAt: Date = Date()) {
        self.tasks = tasks
        self.generatedAt = generatedAt
    }

    public init(
        snapshot: TaskifyWatchSnapshot,
        excludingTaskIDs: Set<String> = []
    ) {
        tasks = snapshot.tasks.compactMap { task in
            guard !excludingTaskIDs.contains(task.id) else { return nil }
            return TaskifyWatchWidgetTask(
                id: task.id,
                title: task.title,
                boardName: task.boardName,
                dueDate: task.dueDate
            )
        }
        generatedAt = snapshot.generatedAt
    }

    public func todayTasks(
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskifyWatchWidgetTask] {
        let start = calendar.startOfDay(for: now)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
        return tasks
            .filter { task in
                guard let dueDate = task.dueDate else { return false }
                return dueDate >= start && dueDate < end
            }
            .sorted { lhs, rhs in
                if lhs.dueDate != rhs.dueDate {
                    return (lhs.dueDate ?? .distantFuture) < (rhs.dueDate ?? .distantFuture)
                }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
    }

    /// Open tasks due today or later, ordered the same way as the Watch app's Upcoming view.
    /// Undated tasks are intentionally omitted because they are not part of the dated agenda.
    public func upcomingTasks(
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TaskifyWatchWidgetTask] {
        let start = calendar.startOfDay(for: now)
        return tasks
            .filter { ($0.dueDate ?? .distantPast) >= start }
            .sorted { lhs, rhs in
                if lhs.dueDate != rhs.dueDate {
                    return (lhs.dueDate ?? .distantFuture) < (rhs.dueDate ?? .distantFuture)
                }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
    }
}

/// Shares non-secret widget data between the Watch app and its WidgetKit extension. App Groups
/// are device-local here: this container lives on Apple Watch and does not copy the iPhone store.
public enum TaskifyWatchWidgetCache {
    public static let appGroupIdentifier = "group.solife.me.Taskify"
    public static let todayWidgetKind = "TaskifyWatchTodayWidget"
    public static let upcomingWidgetKind = "TaskifyWatchUpcomingWidget"
    public static let widgetKinds = [todayWidgetKind, upcomingWidgetKind]

    private static let snapshotKey = "taskify-watch-widget-snapshot-v1"

    public static func load() -> TaskifyWatchWidgetSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier),
              let data = defaults.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(TaskifyWatchWidgetSnapshot.self, from: data) else {
            return TaskifyWatchWidgetSnapshot()
        }
        return snapshot
    }

    /// Returns true only when the stored value changed, allowing the Watch app to preserve the
    /// system's WidgetKit reload budget.
    @discardableResult
    public static func saveIfChanged(_ snapshot: TaskifyWatchWidgetSnapshot) -> Bool {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier),
              let data = try? JSONEncoder().encode(snapshot),
              defaults.data(forKey: snapshotKey) != data else { return false }
        defaults.set(data, forKey: snapshotKey)
        return true
    }
}

/// The only message that is allowed to carry private account material to the Watch.
///
/// This payload is intentionally used with WatchConnectivity's immediate message API rather
/// than application context or background user-info transfers. The receiver must move
/// `privateKey` directly into its device-only Keychain and must never persist the envelope.
public struct TaskifyWatchProvisioningPayload: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 3

    public let schemaVersion: Int
    public let privateKey: Data
    public let publicKeyHex: String
    public let publicKeyNpub: String?
    public let relayURLs: [String]
    public let snapshot: TaskifyWatchSnapshot
    public let chatContext: TaskifyWatchChatProvisioningContext?

    public init(
        schemaVersion: Int = TaskifyWatchProvisioningPayload.currentSchemaVersion,
        privateKey: Data,
        publicKeyHex: String,
        publicKeyNpub: String? = nil,
        relayURLs: [String],
        snapshot: TaskifyWatchSnapshot,
        chatContext: TaskifyWatchChatProvisioningContext? = nil
    ) throws {
        guard privateKey.count == 32 else {
            throw TaskifyWatchTransfer.TransferError.invalidPrivateKey
        }
        let normalizedPublicKey = publicKeyHex.lowercased()
        guard normalizedPublicKey.count == 64,
              normalizedPublicKey.allSatisfy(\.isHexDigit) else {
            throw TaskifyWatchTransfer.TransferError.invalidPublicKey
        }

        self.schemaVersion = schemaVersion
        self.privateKey = privateKey
        self.publicKeyHex = normalizedPublicKey
        self.publicKeyNpub = publicKeyNpub?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.relayURLs = Self.normalizedRelays(relayURLs)
        self.snapshot = snapshot
        self.chatContext = chatContext
    }

    private static func normalizedRelays(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let components = URLComponents(string: trimmed),
                  let scheme = components.scheme?.lowercased(),
                  scheme == "wss" || scheme == "ws",
                  components.host != nil else { return nil }
            let normalized = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard seen.insert(normalized).inserted else { return nil }
            return normalized
        }
    }
}

public struct TaskifyWatchProvisioningReceipt: Codable, Equatable, Sendable {
    public let publicKeyHex: String
    public let errorMessage: String?

    public init(publicKeyHex: String, errorMessage: String? = nil) {
        self.publicKeyHex = publicKeyHex.lowercased()
        self.errorMessage = errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Recurrence on a finalized voice task, in the Worker's wire format (see
/// `worker/src/voice.ts` `VoiceRecurrence`). Lives in TaskifyWatchShared so the
/// Watch's independent dictation client and the phone's voice pipeline share one
/// wire shape; TaskifyCore maps it onto the native `TaskRecurrence`.
public enum VoiceRecurrence: Hashable, Sendable {
    case none
    case daily
    case weekly(days: [Int])
    case every(count: Int, unit: String)
    case monthlyDay(day: Int, interval: Int?)
}

extension VoiceRecurrence: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, days, n, unit, day, interval
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "none":
            self = .none
        case "daily":
            self = .daily
        case "weekly":
            self = .weekly(days: try container.decodeIfPresent([Int].self, forKey: .days) ?? [])
        case "every":
            let count = try container.decodeIfPresent(Int.self, forKey: .n) ?? 0
            let unit = try container.decodeIfPresent(String.self, forKey: .unit) ?? "day"
            self = .every(count: count, unit: unit)
        case "monthlyDay":
            self = .monthlyDay(
                day: try container.decodeIfPresent(Int.self, forKey: .day) ?? 0,
                interval: try container.decodeIfPresent(Int.self, forKey: .interval)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown recurrence type"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .none:
            try container.encode("none", forKey: .type)
        case .daily:
            try container.encode("daily", forKey: .type)
        case .weekly(let days):
            try container.encode("weekly", forKey: .type)
            try container.encode(days, forKey: .days)
        case .every(let count, let unit):
            try container.encode("every", forKey: .type)
            try container.encode(count, forKey: .n)
            try container.encode(unit, forKey: .unit)
        case .monthlyDay(let day, let interval):
            try container.encode("monthlyDay", forKey: .type)
            try container.encode(day, forKey: .day)
            try container.encodeIfPresent(interval, forKey: .interval)
        }
    }
}

/// Board/list context the Watch sends with `/api/voice/finalize` so the model can
/// route spoken tasks to a named board. Mirrors the Worker's `VoiceBoardContext`
/// wire format.
public struct TaskifyWatchVoiceBoardContext: Codable, Equatable, Sendable {
    public struct Column: Codable, Equatable, Sendable {
        public let id: String
        public let name: String

        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    public let id: String
    public let name: String
    public let kind: String
    public let columns: [Column]?

    public init(id: String, name: String, kind: String, columns: [Column]? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.columns = columns
    }
}

public struct TaskifyWatchVoiceDraft: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let dueISO: String?
    public let boardId: String?
    public let notes: String?
    public let subtasks: [String]?
    public let priority: Int?
    /// Optional recurrence/reminders/list placement so Watch-dictated tasks carry
    /// the same detail the phone sheet saves. Older peers decode payloads without
    /// these keys, so they remain optional and backwards compatible.
    public let reminderMinutesBeforeDue: [Int]?
    public let reminderTime: String?
    public let columnId: String?
    public let recurrence: VoiceRecurrence?

    public init(
        id: String = UUID().uuidString,
        title: String,
        dueISO: String? = nil,
        boardId: String? = nil,
        notes: String? = nil,
        subtasks: [String]? = nil,
        priority: Int? = nil,
        reminderMinutesBeforeDue: [Int]? = nil,
        reminderTime: String? = nil,
        columnId: String? = nil,
        recurrence: VoiceRecurrence? = nil
    ) {
        self.id = id
        self.title = title
        self.dueISO = dueISO
        self.boardId = boardId
        self.notes = notes
        self.subtasks = subtasks
        self.priority = priority
        self.reminderMinutesBeforeDue = reminderMinutesBeforeDue
        self.reminderTime = reminderTime
        self.columnId = columnId
        self.recurrence = recurrence
    }

    /// Resolve each draft independently; old peers omit boardId and keep the session board.
    public func destinationBoard(in boards: [TaskifyWatchBoard], fallback: TaskifyWatchBoard) -> TaskifyWatchBoard {
        guard let boardId,
              let board = boards.first(where: { $0.id == boardId }),
              board.kind == "week" || board.kind == "lists" else { return fallback }
        return board
    }
}

public struct TaskifyWatchVoicePreviewRequest: Identifiable, Codable, Equatable, Sendable {
    public let type: String
    public let id: String
    public let transcript: String
    public let boardID: String

    public init(id: String = UUID().uuidString, transcript: String, boardID: String) {
        self.type = "voicePreview"
        self.id = id
        self.transcript = transcript
        self.boardID = boardID
    }
}

public struct TaskifyWatchVoicePreview: Codable, Equatable, Sendable {
    public let requestID: String
    public let transcript: String
    public let tasks: [TaskifyWatchVoiceDraft]

    public init(requestID: String, transcript: String, tasks: [TaskifyWatchVoiceDraft]) {
        self.requestID = requestID
        self.transcript = transcript
        self.tasks = tasks
    }
}

public struct TaskifyWatchCommand: Identifiable, Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case completeTask
        case editTask
        case setSubtaskCompletion
        case createTask
        case createVoiceTasks
        case processVoiceTranscript
    }

    public let id: String
    public let kind: Kind
    public let taskID: String?
    public let title: String?
    public let boardID: String?
    public let transcript: String?
    public let voiceTasks: [TaskifyWatchVoiceDraft]?
    public let edit: TaskifyWatchTaskEdit?
    public let subtaskID: String?
    public let subtaskCompleted: Bool?
    public let createdAt: Date

    public init(
        id: String = UUID().uuidString,
        kind: Kind,
        taskID: String? = nil,
        title: String? = nil,
        boardID: String? = nil,
        transcript: String? = nil,
        voiceTasks: [TaskifyWatchVoiceDraft]? = nil,
        edit: TaskifyWatchTaskEdit? = nil,
        subtaskID: String? = nil,
        subtaskCompleted: Bool? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.kind = kind
        self.taskID = taskID
        self.title = title
        self.boardID = boardID
        self.transcript = transcript
        self.voiceTasks = voiceTasks
        self.edit = edit
        self.subtaskID = subtaskID
        self.subtaskCompleted = subtaskCompleted
        self.createdAt = createdAt
    }
}

/// A successful iPhone acknowledgement. Returning the refreshed snapshot in the same reply keeps
/// an optimistically completed task from briefly reappearing while application context catches up.
public struct TaskifyWatchCommandReceipt: Codable, Equatable, Sendable {
    public let commandID: String
    public let snapshot: TaskifyWatchSnapshot

    public init(commandID: String, snapshot: TaskifyWatchSnapshot) {
        self.commandID = commandID
        self.snapshot = snapshot
    }
}

public enum TaskifyWatchTransfer {
    public static let snapshotDataKey = "taskify.watch.snapshot.v1"
    public static let commandDataKey = "taskify.watch.command.v1"
    public static let requestSnapshotKey = "taskify.watch.requestSnapshot.v1"
    public static let commandAcceptedKey = "taskify.watch.commandAccepted.v1"
    public static let provisioningDataKey = "taskify.watch.provisioning.v1"
    public static let setupNavigationRequestKey = "taskify.watch.setup-navigation-request.v1"
    public static let provisioningStatusRequestKey = "taskify.watch.provisioning-status-request.v1"
    public static let provisioningStatusPublicKeyKey = "taskify.watch.provisioning-status-pubkey.v1"
    public static let chatReadConversationIDKey = "taskify.watch.chat-read-conversation.v1"
    public static let chatReadThroughKey = "taskify.watch.chat-read-through.v1"
    public static let chatDirectoryRequestKey = "taskify.watch.chat-directory-request.v1"

    public static var setupNavigationRequest: [String: Any] {
        [setupNavigationRequestKey: true]
    }

    public static var snapshotRequest: [String: Any] {
        [requestSnapshotKey: true]
    }

    public static var chatDirectoryRequest: [String: Any] {
        [chatDirectoryRequestKey: true]
    }

    public static var provisioningStatusRequest: [String: Any] {
        [provisioningStatusRequestKey: true]
    }

    public static func provisioningStatusResponse(publicKeyHex: String?) -> [String: Any] {
        guard let publicKeyHex else { return [:] }
        return [provisioningStatusPublicKeyKey: publicKeyHex.lowercased()]
    }

    public static func chatReadUpdate(
        conversationID: String,
        through timestamp: Int
    ) -> [String: Any]? {
        let normalized = conversationID.lowercased()
        guard normalized.count == 64,
              normalized.allSatisfy(\.isHexDigit),
              timestamp > 0 else { return nil }
        return [
            chatReadConversationIDKey: normalized,
            chatReadThroughKey: timestamp,
        ]
    }

    public static func chatReadUpdate(
        from values: [String: Any]
    ) -> (conversationID: String, timestamp: Int)? {
        guard let conversationID = values[chatReadConversationIDKey] as? String,
              let timestamp = values[chatReadThroughKey] as? Int else { return nil }
        let normalized = conversationID.lowercased()
        guard normalized.count == 64,
              normalized.allSatisfy(\.isHexDigit),
              timestamp > 0 else { return nil }
        return (normalized, timestamp)
    }

    public static func isSetupNavigationRequest(_ values: [String: Any]) -> Bool {
        values[setupNavigationRequestKey] as? Bool == true
    }

    public static func isSnapshotRequest(_ values: [String: Any]) -> Bool {
        values[requestSnapshotKey] as? Bool == true
    }

    public static func isProvisioningStatusRequest(_ values: [String: Any]) -> Bool {
        values[provisioningStatusRequestKey] as? Bool == true
    }

    public static func isChatDirectoryRequest(_ values: [String: Any]) -> Bool {
        values[chatDirectoryRequestKey] as? Bool == true
    }

    public static func provisioningStatusPublicKey(_ values: [String: Any]) -> String? {
        guard let value = values[provisioningStatusPublicKeyKey] as? String else { return nil }
        let normalized = value.lowercased()
        guard normalized.count == 64, normalized.allSatisfy(\.isHexDigit) else { return nil }
        return normalized
    }

    public static func encode(_ snapshot: TaskifyWatchSnapshot) throws -> Data {
        try encoder.encode(snapshot)
    }

    public static func decodeSnapshot(_ data: Data) throws -> TaskifyWatchSnapshot {
        let snapshot = try decoder.decode(TaskifyWatchSnapshot.self, from: data)
        guard snapshot.schemaVersion <= TaskifyWatchSnapshot.currentSchemaVersion else {
            throw TransferError.unsupportedSchema(snapshot.schemaVersion)
        }
        return snapshot
    }

    /// Encodes the latest-state snapshot for WatchConnectivity. Application-context and
    /// interactive-message payloads have a relatively small practical budget, while a Watch
    /// snapshot can contain the lossless encrypted-task context needed for independent writes.
    /// LZFSE keeps the full projection in the common case; if an unusually attachment-heavy
    /// account is still too large, the least relevant trailing tasks are removed while board
    /// order and counts remain intact.
    public static func encodeConnectivitySnapshot(
        _ snapshot: TaskifyWatchSnapshot,
        maximumBytes: Int = 48 * 1_024
    ) throws -> Data {
        let byteLimit = max(1_024, maximumBytes)
        var lowerBound = 0
        var upperBound = snapshot.tasks.count
        var bestData: Data?

        while lowerBound <= upperBound {
            let taskCount = lowerBound + (upperBound - lowerBound) / 2
            let candidate = taskCount == snapshot.tasks.count
                ? snapshot
                : TaskifyWatchSnapshot(
                    schemaVersion: snapshot.schemaVersion,
                    tasks: Array(snapshot.tasks.prefix(taskCount)),
                    boards: snapshot.boards,
                    selectedBoardID: snapshot.selectedBoardID,
                    generatedAt: snapshot.generatedAt,
                    acknowledgedCommandIDs: snapshot.acknowledgedCommandIDs,
                    chatProjection: snapshot.chatProjection,
                    accent: snapshot.accent
                )
            let data = try compressedSnapshotData(candidate)
            if data.count <= byteLimit {
                bestData = data
                lowerBound = taskCount + 1
            } else {
                upperBound = taskCount - 1
            }
        }

        if let bestData { return bestData }

        // Task payloads are normally the largest part of a snapshot. If the bounded chat index
        // itself is the remaining pressure, retain as many of the newest threads as fit. An empty
        // projection is intentionally distinct from nil: it tells the Watch to clear an older
        // projected index rather than leave stale rows behind.
        if let projection = snapshot.chatProjection {
            lowerBound = 0
            upperBound = projection.threads.count
            while lowerBound <= upperBound {
                let threadCount = lowerBound + (upperBound - lowerBound) / 2
                let candidate = TaskifyWatchSnapshot(
                    schemaVersion: snapshot.schemaVersion,
                    tasks: [],
                    boards: snapshot.boards,
                    selectedBoardID: snapshot.selectedBoardID,
                    generatedAt: snapshot.generatedAt,
                    acknowledgedCommandIDs: snapshot.acknowledgedCommandIDs,
                    chatProjection: TaskifyWatchChatProjection(
                        threads: Array(projection.threads.prefix(threadCount)),
                        accountPublicKey: projection.accountPublicKey,
                        // Omitting an oversized contact update preserves the Watch's last complete
                        // provisioned directory while still delivering newest thread state.
                        contacts: nil,
                        discoveryRelayURLs: projection.discoveryRelayURLs,
                        pushRelayHTTPSURL: projection.pushRelayHTTPSURL,
                        pushRelayWSSURL: projection.pushRelayWSSURL,
                        // Tombstones survive trimming: they are the only path phone-side
                        // deletions and blocks have to the Watch cache.
                        deletedConversationIDs: projection.deletedConversationIDs,
                        blockedPublicKeys: projection.blockedPublicKeys,
                        generatedAt: projection.generatedAt
                    ),
                    accent: snapshot.accent
                )
                let data = try compressedSnapshotData(candidate)
                if data.count <= byteLimit {
                    bestData = data
                    lowerBound = threadCount + 1
                } else {
                    upperBound = threadCount - 1
                }
            }

        }

        if let bestData { return bestData }
        throw TransferError.transportPayloadTooLarge
    }

    public static func decodeConnectivitySnapshot(_ data: Data) throws -> TaskifyWatchSnapshot {
        guard data.starts(with: compressedSnapshotHeader) else {
            // Backward compatibility with application contexts written by older iPhone builds.
            return try decodeSnapshot(data)
        }
        let compressed = data.dropFirst(compressedSnapshotHeader.count)
        let decoded = try (Data(compressed) as NSData).decompressed(using: .lzfse) as Data
        return try decodeSnapshot(decoded)
    }

    public static func encode(_ command: TaskifyWatchCommand) throws -> Data {
        try encoder.encode(command)
    }

    public static func decodeCommand(_ data: Data) throws -> TaskifyWatchCommand {
        let command = try decoder.decode(TaskifyWatchCommand.self, from: data)
        let isValid: Bool
        switch command.kind {
        case .setSubtaskCompletion:
            isValid = !(command.taskID ?? "").isEmpty &&
                !(command.subtaskID ?? "").isEmpty && command.subtaskCompleted != nil
        case .editTask:
            isValid = !(command.taskID ?? "").isEmpty &&
                !(command.edit?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                (command.edit?.priority == nil || (1...3).contains(command.edit!.priority!))
        case .completeTask:
            isValid = !(command.taskID ?? "").isEmpty
        case .createTask:
            isValid = !(command.boardID ?? "").isEmpty &&
                !(command.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .createVoiceTasks:
            isValid = !(command.boardID ?? "").isEmpty &&
                !(command.voiceTasks ?? []).isEmpty &&
                (command.voiceTasks ?? []).allSatisfy {
                    !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }
        case .processVoiceTranscript:
            isValid = !(command.boardID ?? "").isEmpty &&
                !(command.transcript ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard isValid else { throw TransferError.invalidCommand }
        return command
    }

    public static func encode(_ receipt: TaskifyWatchCommandReceipt) throws -> Data {
        try encoder.encode(receipt)
    }

    public static func decodeCommandReceipt(_ data: Data) throws -> TaskifyWatchCommandReceipt {
        let receipt = try decoder.decode(TaskifyWatchCommandReceipt.self, from: data)
        guard receipt.snapshot.schemaVersion <= TaskifyWatchSnapshot.currentSchemaVersion else {
            throw TransferError.unsupportedSchema(receipt.snapshot.schemaVersion)
        }
        return receipt
    }

    public static func encode(_ request: TaskifyWatchVoicePreviewRequest) throws -> Data {
        try encoder.encode(request)
    }

    public static func decodeVoicePreviewRequest(_ data: Data) throws -> TaskifyWatchVoicePreviewRequest {
        let request = try decoder.decode(TaskifyWatchVoicePreviewRequest.self, from: data)
        guard request.type == "voicePreview",
              !request.boardID.isEmpty,
              !request.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TransferError.invalidVoicePreview
        }
        return request
    }

    public static func encode(_ preview: TaskifyWatchVoicePreview) throws -> Data {
        try encoder.encode(preview)
    }

    public static func decodeVoicePreview(_ data: Data) throws -> TaskifyWatchVoicePreview {
        let preview = try decoder.decode(TaskifyWatchVoicePreview.self, from: data)
        guard !preview.requestID.isEmpty,
              !preview.tasks.isEmpty,
              preview.tasks.allSatisfy({
                  !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              }) else {
            throw TransferError.invalidVoicePreview
        }
        return preview
    }

    /// Encodes the one-time secure setup envelope for WatchConnectivity's immediate-message API.
    /// The full payload is retained whenever it fits. If it does not, the ordinary application
    /// context sent immediately after the receipt supplies task state, while this envelope keeps
    /// the account key, relay configuration, newest thread index, and the routing contacts needed
    /// by each retained conversation.
    public static func encode(
        _ payload: TaskifyWatchProvisioningPayload,
        maximumBytes: Int = 48 * 1_024
    ) throws -> Data {
        let byteLimit = max(1_024, maximumBytes)
        let fullData = try compressedProvisioningData(payload)
        if fullData.count <= byteLimit { return fullData }

        let minimalSnapshot = TaskifyWatchSnapshot(
            schemaVersion: payload.snapshot.schemaVersion,
            generatedAt: payload.snapshot.generatedAt,
            acknowledgedCommandIDs: payload.snapshot.acknowledgedCommandIDs,
            accent: payload.snapshot.accent
        )
        guard let context = payload.chatContext else {
            let candidate = try provisioningCandidate(
                payload,
                snapshot: minimalSnapshot,
                chatContext: nil
            )
            let data = try compressedProvisioningData(candidate)
            guard data.count <= byteLimit else {
                throw TransferError.transportPayloadTooLarge
            }
            return data
        }

        let allThreads = context.threadSummaries ?? []
        var threadLimit = allThreads.count
        var extraContactLimit = context.contacts.count
        var includeAccountPreference = true

        while true {
            let boundedContext = boundedProvisioningContext(
                context,
                accountPublicKey: payload.publicKeyHex,
                threadLimit: threadLimit,
                extraContactLimit: extraContactLimit,
                includeAccountPreference: includeAccountPreference
            )
            let candidate = try provisioningCandidate(
                payload,
                snapshot: minimalSnapshot,
                chatContext: boundedContext
            )
            let data = try compressedProvisioningData(candidate)
            if data.count <= byteLimit { return data }

            if extraContactLimit > 0 {
                extraContactLimit = reducedLimit(extraContactLimit)
            } else if threadLimit > 0 {
                threadLimit = reducedLimit(threadLimit)
            } else if includeAccountPreference {
                // The signed preference is public and can be rediscovered by the Watch. Dropping
                // it is a final size fallback; discovery must still complete before defaults are
                // used, preserving Taskify's recipient-routing privacy rule.
                includeAccountPreference = false
            } else {
                throw TransferError.transportPayloadTooLarge
            }
        }
    }

    public static func decodeProvisioningPayload(_ data: Data) throws -> TaskifyWatchProvisioningPayload {
        let decoded: Data
        if data.starts(with: compressedProvisioningHeader) {
            let compressed = data.dropFirst(compressedProvisioningHeader.count)
            decoded = try (Data(compressed) as NSData).decompressed(using: .lzfse) as Data
        } else {
            // Backward compatibility with secure setup envelopes written by older iPhone builds.
            decoded = data
        }
        let payload = try decoder.decode(TaskifyWatchProvisioningPayload.self, from: decoded)
        guard payload.schemaVersion <= TaskifyWatchProvisioningPayload.currentSchemaVersion else {
            throw TransferError.unsupportedSchema(payload.schemaVersion)
        }
        guard payload.privateKey.count == 32 else { throw TransferError.invalidPrivateKey }
        guard payload.publicKeyHex.count == 64,
              payload.publicKeyHex.allSatisfy(\.isHexDigit) else {
            throw TransferError.invalidPublicKey
        }
        return payload
    }

    public static func encode(_ receipt: TaskifyWatchProvisioningReceipt) throws -> Data {
        try encoder.encode(receipt)
    }

    public static func decodeProvisioningReceipt(_ data: Data) throws -> TaskifyWatchProvisioningReceipt {
        try decoder.decode(TaskifyWatchProvisioningReceipt.self, from: data)
    }

    public enum TransferError: LocalizedError, Equatable {
        case unsupportedSchema(Int)
        case invalidPrivateKey
        case invalidPublicKey
        case invalidCommand
        case invalidVoicePreview
        case transportPayloadTooLarge

        public var errorDescription: String? {
            switch self {
            case .unsupportedSchema(let version):
                "This Watch data uses unsupported schema version \(version)."
            case .invalidPrivateKey:
                "The Watch provisioning message does not contain a valid private key."
            case .invalidPublicKey:
                "The Watch provisioning message does not contain a valid public key."
            case .invalidCommand:
                "The Watch command is incomplete."
            case .invalidVoicePreview:
                "The Watch dictation preview is incomplete."
            case .transportPayloadTooLarge:
                "The secure Watch setup data is too large to transfer."
            }
        }
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }

    private static let compressedSnapshotHeader = Data([0x54, 0x46, 0x57, 0x53, 0x01])
    private static let compressedProvisioningHeader = Data([0x54, 0x46, 0x57, 0x50, 0x01])

    private static func compressedSnapshotData(_ snapshot: TaskifyWatchSnapshot) throws -> Data {
        let source = try encode(snapshot)
        let compressed = try (source as NSData).compressed(using: .lzfse) as Data
        return compressedSnapshotHeader + compressed
    }

    private static func compressedProvisioningData(
        _ payload: TaskifyWatchProvisioningPayload
    ) throws -> Data {
        let source = try encoder.encode(payload)
        let compressed = try (source as NSData).compressed(using: .lzfse) as Data
        return compressedProvisioningHeader + compressed
    }

    private static func provisioningCandidate(
        _ source: TaskifyWatchProvisioningPayload,
        snapshot: TaskifyWatchSnapshot,
        chatContext: TaskifyWatchChatProvisioningContext?
    ) throws -> TaskifyWatchProvisioningPayload {
        try TaskifyWatchProvisioningPayload(
            schemaVersion: source.schemaVersion,
            privateKey: source.privateKey,
            publicKeyHex: source.publicKeyHex,
            publicKeyNpub: source.publicKeyNpub,
            relayURLs: source.relayURLs,
            snapshot: snapshot,
            chatContext: chatContext
        )
    }

    private static func boundedProvisioningContext(
        _ source: TaskifyWatchChatProvisioningContext,
        accountPublicKey: String,
        threadLimit: Int,
        extraContactLimit: Int,
        includeAccountPreference: Bool
    ) -> TaskifyWatchChatProvisioningContext {
        let threads = Array((source.threadSummaries ?? []).prefix(max(0, threadLimit)))
        let requiredKeys = Set(threads.flatMap(\.memberPublicKeys))
            .subtracting([accountPublicKey.lowercased()])
        var selectedContacts: [TaskifyWatchContact] = []
        var selectedKeys = Set<String>()

        for contact in source.contacts where requiredKeys.contains(contact.publicKey.lowercased()) {
            guard selectedKeys.insert(contact.publicKey.lowercased()).inserted else { continue }
            selectedContacts.append(contact)
        }
        var remainingAllowance = max(0, extraContactLimit)
        for contact in source.contacts where remainingAllowance > 0 {
            guard selectedKeys.insert(contact.publicKey.lowercased()).inserted else { continue }
            selectedContacts.append(contact)
            remainingAllowance -= 1
        }

        return TaskifyWatchChatProvisioningContext(
            contacts: selectedContacts,
            threadSummaries: threads,
            discoveryRelayURLs: source.discoveryRelayURLs,
            accountInboxPreferenceEvent: includeAccountPreference
                ? source.accountInboxPreferenceEvent
                : nil,
            pushRelayHTTPSURL: source.pushRelayHTTPSURL,
            pushRelayWSSURL: source.pushRelayWSSURL
        )
    }

    private static func reducedLimit(_ value: Int) -> Int {
        value <= 1 ? 0 : value / 2
    }
}
