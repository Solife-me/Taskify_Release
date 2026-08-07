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

public struct TaskifyWatchBoard: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let openTaskCount: Int
    public let kind: String?
    public let nostrBoardID: String?
    public let relayURLs: [String]?
    public let defaultColumnID: String?

    public init(
        id: String,
        name: String,
        openTaskCount: Int,
        kind: String? = nil,
        nostrBoardID: String? = nil,
        relayURLs: [String]? = nil,
        defaultColumnID: String? = nil
    ) {
        self.id = id
        self.name = name
        self.openTaskCount = openTaskCount
        self.kind = kind
        self.nostrBoardID = nostrBoardID
        self.relayURLs = relayURLs
        self.defaultColumnID = defaultColumnID
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

    public init(
        schemaVersion: Int = TaskifyWatchSnapshot.currentSchemaVersion,
        tasks: [TaskifyWatchTask] = [],
        boards: [TaskifyWatchBoard] = [],
        selectedBoardID: String? = nil,
        generatedAt: Date = Date(),
        acknowledgedCommandIDs: [String]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.tasks = tasks
        self.boards = boards
        self.selectedBoardID = selectedBoardID
        self.generatedAt = generatedAt
        self.acknowledgedCommandIDs = acknowledgedCommandIDs
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

/// The only message that is allowed to carry private account material to the Watch.
///
/// This payload is intentionally used with WatchConnectivity's immediate message API rather
/// than application context or background user-info transfers. The receiver must move
/// `privateKey` directly into its device-only Keychain and must never persist the envelope.
public struct TaskifyWatchProvisioningPayload: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 2

    public let schemaVersion: Int
    public let privateKey: Data
    public let publicKeyHex: String
    public let publicKeyNpub: String?
    public let relayURLs: [String]
    public let snapshot: TaskifyWatchSnapshot

    public init(
        schemaVersion: Int = TaskifyWatchProvisioningPayload.currentSchemaVersion,
        privateKey: Data,
        publicKeyHex: String,
        publicKeyNpub: String? = nil,
        relayURLs: [String],
        snapshot: TaskifyWatchSnapshot
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

    public init(publicKeyHex: String) {
        self.publicKeyHex = publicKeyHex.lowercased()
    }
}

public struct TaskifyWatchVoiceDraft: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let dueISO: String?
    public let notes: String?
    public let subtasks: [String]?
    public let priority: Int?

    public init(
        id: String = UUID().uuidString,
        title: String,
        dueISO: String? = nil,
        notes: String? = nil,
        subtasks: [String]? = nil,
        priority: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.dueISO = dueISO
        self.notes = notes
        self.subtasks = subtasks
        self.priority = priority
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
    public let createdAt: Date

    public init(
        id: String = UUID().uuidString,
        kind: Kind,
        taskID: String? = nil,
        title: String? = nil,
        boardID: String? = nil,
        transcript: String? = nil,
        voiceTasks: [TaskifyWatchVoiceDraft]? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.kind = kind
        self.taskID = taskID
        self.title = title
        self.boardID = boardID
        self.transcript = transcript
        self.voiceTasks = voiceTasks
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

    public static var setupNavigationRequest: [String: Any] {
        [setupNavigationRequestKey: true]
    }

    public static func isSetupNavigationRequest(_ values: [String: Any]) -> Bool {
        values[setupNavigationRequestKey] as? Bool == true
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

    public static func encode(_ command: TaskifyWatchCommand) throws -> Data {
        try encoder.encode(command)
    }

    public static func decodeCommand(_ data: Data) throws -> TaskifyWatchCommand {
        let command = try decoder.decode(TaskifyWatchCommand.self, from: data)
        let isValid: Bool
        switch command.kind {
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

    public static func encode(_ payload: TaskifyWatchProvisioningPayload) throws -> Data {
        try encoder.encode(payload)
    }

    public static func decodeProvisioningPayload(_ data: Data) throws -> TaskifyWatchProvisioningPayload {
        let payload = try decoder.decode(TaskifyWatchProvisioningPayload.self, from: data)
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
}
