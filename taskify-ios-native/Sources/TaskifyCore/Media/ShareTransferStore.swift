import CryptoKit
import Foundation
import Darwin

public struct ShareRecipient: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let members: [String]
    public let isGroup: Bool
    public let discoveryRelays: [String]

    public init(id: String, name: String, members: [String], isGroup: Bool, discoveryRelays: [String]) {
        self.id = id; self.name = name; self.members = members; self.isGroup = isGroup
        self.discoveryRelays = discoveryRelays
    }
    public func suggestionID(account: String) -> String {
        Data(SHA256.hash(data: Data("taskify-share:\(account):\(id)".utf8))).hexString
    }
}

public struct ShareAccount: Codable, Equatable, Sendable {
    public let publicKey: String
    public let recipients: [ShareRecipient]
    public let server: TaskifyFileServerEntry
    public let senderRelays: [String]
    public init(publicKey: String, recipients: [ShareRecipient], server: TaskifyFileServerEntry, senderRelays: [String]) {
        self.publicKey = publicKey; self.recipients = recipients; self.server = server; self.senderRelays = senderRelays
    }
}

public struct ShareDelivery: Codable, Sendable {
    public let event: NostrEvent
    public let relays: [String]
    public var accepted: Bool = false
    public var rumorEventID: String?
    public var dependsOnEventID: String?
}

public struct ShareTransfer: Codable, Identifiable, Sendable {
    public let id: UUID
    public let account: String
    public let recipient: ShareRecipient
    public let server: TaskifyFileServerEntry
    public let createdAt: Date
    public var filename: String?
    public var mimeType: String?
    public var size: Int?
    public var keyHex: String?
    public var nonceHex: String?
    public var sha256: String?
    public var ciphertextName: String?
    public var bodyName: String?
    public var sessionID: String?
    public var text: String?
    public var remoteURL: String?
    public var deliveries: [ShareDelivery] = []
    public var localMessage: NostrDirectMessage?
    /// Optional so transfers queued by earlier versions remain readable.
    public var additionalLocalMessages: [NostrDirectMessage]?
    public var state = "preparing"
    public var error: String?

    public init(account: ShareAccount, recipient: ShareRecipient, text: String? = nil) {
        self.id = UUID(); self.account = account.publicKey; self.recipient = recipient
        self.server = account.server; self.createdAt = Date(); self.text = text
    }

    public var messages: [NostrDirectMessage] {
        ([localMessage].compactMap { $0 } + (additionalLocalMessages ?? [])).map { input in
            var message = input
            let copies = deliveries.filter { $0.rumorEventID == message.rumorEventID }
            message.deliveryState = state == "sent" || (!copies.isEmpty && copies.allSatisfy(\.accepted)) ? .sent : .queued
            return message
        }
    }

    func readyDeliveryIndices(excluding attempted: Set<Int>) -> [Int] {
        let accepted = Set(deliveries.filter(\.accepted).map(\.event.id))
        return deliveries.indices.filter { index in
            let delivery = deliveries[index]
            return !delivery.accepted && !attempted.contains(index) &&
                (delivery.dependsOnEventID == nil || delivery.dependsOnEventID.map(accepted.contains) == true)
        }
    }
}

/// A separate App Group: never opens the main snapshot or wallet files.
public enum ShareTransferStore {
    public static let groupID = "group.solife.me.Taskify.Share"
    public static func root() throws -> URL {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID) else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try AttachmentFiles.directory(in: root)
    }
    public static func account() throws -> ShareAccount {
        try JSONDecoder().decode(ShareAccount.self, from: Data(contentsOf: root().appendingPathComponent("account.json")))
    }
    public static func clearAccount() {
        if let url = try? root().appendingPathComponent("account.json") { try? FileManager.default.removeItem(at: url) }
    }
    public static func saveAccount(_ value: ShareAccount) throws {
        try write(value, to: root().appendingPathComponent("account.json"))
    }
    public static func directory(_ id: UUID) throws -> URL {
        let url = try root().appendingPathComponent(id.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try AttachmentFiles.protect(url)
        return url
    }
    public static func save(_ job: ShareTransfer) throws {
        try write(job, to: directory(job.id).appendingPathComponent("transfer.json"))
    }
    public static func load(_ id: UUID) throws -> ShareTransfer {
        try JSONDecoder().decode(ShareTransfer.self, from: Data(contentsOf: root().appendingPathComponent(id.uuidString).appendingPathComponent("transfer.json")))
    }
    public static func purgeOrphanedFiles() {
        guard let root = try? root(), let folders = try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.creationDateKey]) else { return }
        for folder in folders where UUID(uuidString: folder.lastPathComponent) != nil {
            guard !FileManager.default.fileExists(atPath: folder.appendingPathComponent("transfer.json").path),
                  let date = try? folder.resourceValues(forKeys: [.creationDateKey]).creationDate,
                  date < Date().addingTimeInterval(-3_600) else { continue }
            try? FileManager.default.removeItem(at: folder)
        }
    }
    public static func all() -> [ShareTransfer] {
        guard let root = try? root(), let urls = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        return urls.compactMap { UUID(uuidString: $0.lastPathComponent) }.compactMap { try? load($0) }
    }
    public static func remove(_ id: UUID) { if let url = try? root().appendingPathComponent(id.uuidString) { try? FileManager.default.removeItem(at: url) } }
    public static func file(_ name: String, job: UUID) throws -> URL {
        guard name == URL(fileURLWithPath: name).lastPathComponent, name != ".", name != ".." else { throw AttachmentFileError.invalidFile }
        return try directory(job).appendingPathComponent(name)
    }
    private static func write<T: Encodable>(_ value: T, to url: URL) throws {
        let bytes = try JSONEncoder().encode(value)
        #if os(iOS)
        try bytes.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try bytes.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try AttachmentFiles.protect(url)
    }
}

/// Cross-process exclusion survives suspension and releases automatically if killed.
public final class ShareTransferLease: @unchecked Sendable {
    private let descriptor: Int32
    public init?(id: UUID) {
        guard let folder = try? ShareTransferStore.root().appendingPathComponent(id.uuidString),
              FileManager.default.fileExists(atPath: folder.appendingPathComponent("transfer.json").path) else { return nil }
        let url = folder.appendingPathComponent(".lock")
        let fd = open(url.path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); return nil }
        descriptor = fd
    }
    deinit { flock(descriptor, LOCK_UN); close(descriptor) }
}
