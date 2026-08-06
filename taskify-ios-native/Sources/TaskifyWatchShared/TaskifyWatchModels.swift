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

    public init(
        id: String,
        title: String,
        boardID: String,
        boardName: String,
        columnName: String?,
        dueDate: Date?,
        dueTimeEnabled: Bool,
        priority: Int?,
        order: Int
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
    }
}

public struct TaskifyWatchBoard: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let openTaskCount: Int

    public init(id: String, name: String, openTaskCount: Int) {
        self.id = id
        self.name = name
        self.openTaskCount = openTaskCount
    }
}

public struct TaskifyWatchSnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let tasks: [TaskifyWatchTask]
    public let boards: [TaskifyWatchBoard]
    public let selectedBoardID: String?
    public let generatedAt: Date

    public init(
        schemaVersion: Int = TaskifyWatchSnapshot.currentSchemaVersion,
        tasks: [TaskifyWatchTask] = [],
        boards: [TaskifyWatchBoard] = [],
        selectedBoardID: String? = nil,
        generatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.tasks = tasks
        self.boards = boards
        self.selectedBoardID = selectedBoardID
        self.generatedAt = generatedAt
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
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let privateKey: Data
    public let publicKeyHex: String
    public let relayURLs: [String]
    public let snapshot: TaskifyWatchSnapshot

    public init(
        schemaVersion: Int = TaskifyWatchProvisioningPayload.currentSchemaVersion,
        privateKey: Data,
        publicKeyHex: String,
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

public struct TaskifyWatchCommand: Identifiable, Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case completeTask
    }

    public let id: String
    public let kind: Kind
    public let taskID: String
    public let createdAt: Date

    public init(
        id: String = UUID().uuidString,
        kind: Kind,
        taskID: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.kind = kind
        self.taskID = taskID
        self.createdAt = createdAt
    }
}

public enum TaskifyWatchTransfer {
    public static let snapshotDataKey = "taskify.watch.snapshot.v1"
    public static let commandDataKey = "taskify.watch.command.v1"
    public static let requestSnapshotKey = "taskify.watch.requestSnapshot.v1"
    public static let commandAcceptedKey = "taskify.watch.commandAccepted.v1"
    public static let provisioningDataKey = "taskify.watch.provisioning.v1"

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
        try decoder.decode(TaskifyWatchCommand.self, from: data)
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

        public var errorDescription: String? {
            switch self {
            case .unsupportedSchema(let version):
                "This Watch data uses unsupported schema version \(version)."
            case .invalidPrivateKey:
                "The Watch provisioning message does not contain a valid private key."
            case .invalidPublicKey:
                "The Watch provisioning message does not contain a valid public key."
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
