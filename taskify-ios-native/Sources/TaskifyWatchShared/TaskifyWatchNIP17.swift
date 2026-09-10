import CryptoKit
import Foundation

public struct TaskifyWatchNIP17Rumor: Codable, Equatable, Sendable {
    public let id: String
    public let publicKey: String
    public let createdAt: Int
    public let kind: Int
    public let tags: [[String]]
    public let content: String

    enum CodingKeys: String, CodingKey {
        case id
        case publicKey = "pubkey"
        case createdAt = "created_at"
        case kind
        case tags
        case content
    }

    public init(
        publicKey: String,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String
    ) throws {
        self.publicKey = publicKey.lowercased()
        self.createdAt = createdAt
        self.kind = kind
        self.tags = tags
        self.content = content
        id = try TaskifyWatchNostrCrypto.eventID(
            publicKey: self.publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )
    }

    public var recipientPublicKeys: [String] {
        tags.compactMap {
            $0.count >= 2 && $0[0] == "p" ? $0[1].lowercased() : nil
        }
    }

    public func verifyID() -> Bool {
        (try? TaskifyWatchNostrCrypto.eventID(
            publicKey: publicKey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )) == id.lowercased()
    }
}

public struct TaskifyWatchNIP17RecipientWrap: Equatable, Sendable {
    public let recipientPublicKey: String
    public let event: TaskifyWatchNostrEvent

    public init(recipientPublicKey: String, event: TaskifyWatchNostrEvent) {
        self.recipientPublicKey = recipientPublicKey.lowercased()
        self.event = event
    }
}

public struct TaskifyWatchNIP17EnvelopeSet: Equatable, Sendable {
    public let rumor: TaskifyWatchNIP17Rumor
    public let wraps: [TaskifyWatchNIP17RecipientWrap]

    public init(rumor: TaskifyWatchNIP17Rumor, wraps: [TaskifyWatchNIP17RecipientWrap]) {
        self.rumor = rumor
        self.wraps = wraps
    }
}

public struct TaskifyWatchNIP17DecryptedRumor: Equatable, Sendable {
    public let wrapEventID: String
    public let rumor: TaskifyWatchNIP17Rumor

    public init(wrapEventID: String, rumor: TaskifyWatchNIP17Rumor) {
        self.wrapEventID = wrapEventID
        self.rumor = rumor
    }
}

public enum TaskifyWatchNIP17Error: LocalizedError, Equatable {
    case invalidMembers
    case invalidRumor
    case invalidWrap
    case wrongRecipient
    case invalidSeal
    case unsupportedMessage

    public var errorDescription: String? {
        switch self {
        case .invalidMembers: "The direct-message recipients are invalid."
        case .invalidRumor: "The encrypted direct-message rumor is invalid."
        case .invalidWrap: "The encrypted direct-message wrapper is invalid."
        case .wrongRecipient: "The direct message belongs to another account."
        case .invalidSeal: "The encrypted direct-message seal is invalid."
        case .unsupportedMessage: "This direct-message type is not supported on Apple Watch."
        }
    }
}

public enum TaskifyWatchNIP17 {
    public static let wrapKind = 1_059
    public static let sealKind = 13
    public static let textKind = 14
    public static let attachmentKind = 15
    public static let reactionKind = 7

    public static func createEnvelopeSet(
        content: String,
        senderPrivateKey: Data,
        memberPublicKeys: [String],
        subject: String? = nil,
        replyToRumorID: String? = nil,
        reactionToRumorID: String? = nil,
        kind: Int = textKind,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> TaskifyWatchNIP17EnvelopeSet {
        let sender = try TaskifyWatchNostrCrypto.publicKeyHex(for: senderPrivateKey)
        var members = Array(Set(memberPublicKeys.map { $0.lowercased() })).sorted()
        if !members.contains(sender) { members.append(sender) }
        members.sort()
        guard (2...TaskifyWatchGroupConversation.maximumMemberCount).contains(members.count),
              members.allSatisfy(isPublicKey) else {
            throw TaskifyWatchNIP17Error.invalidMembers
        }
        let recipients = members.filter { $0 != sender }
        var tags = recipients.map { ["p", $0] }
        if let subject = subject?.trimmingCharacters(in: .whitespacesAndNewlines),
           !subject.isEmpty,
           recipients.count > 1 {
            tags.append(["subject", String(subject.prefix(120))])
        }
        if let reply = replyToRumorID?.lowercased(), isEventID(reply) {
            tags.append(["e", reply, "", "reply"])
        }
        if kind == reactionKind {
            guard let target = reactionToRumorID?.lowercased(), isEventID(target) else {
                throw TaskifyWatchNIP17Error.invalidRumor
            }
            tags.removeAll { $0.first == "e" }
            tags.append(["e", target])
        }
        guard [textKind, reactionKind].contains(kind),
              !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TaskifyWatchNIP17Error.unsupportedMessage
        }
        let rumor = try TaskifyWatchNIP17Rumor(
            publicKey: sender,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )
        var wraps: [TaskifyWatchNIP17RecipientWrap] = []
        for recipient in recipients + [sender] {
            guard let recipientData = Data(taskifyChatHex: recipient) else {
                throw TaskifyWatchNIP17Error.invalidMembers
            }
            wraps.append(TaskifyWatchNIP17RecipientWrap(
                recipientPublicKey: recipient,
                event: try wrap(
                    rumor: rumor,
                    senderPrivateKey: senderPrivateKey,
                    recipientPublicKey: recipientData
                )
            ))
        }
        return TaskifyWatchNIP17EnvelopeSet(rumor: rumor, wraps: wraps)
    }

    public static func wrap(
        rumor: TaskifyWatchNIP17Rumor,
        senderPrivateKey: Data,
        recipientPublicKey: Data,
        ephemeralPrivateKey: Data? = nil,
        sealCreatedAt: Int? = nil,
        wrapCreatedAt: Int? = nil,
        sealNonce: Data? = nil,
        wrapNonce: Data? = nil
    ) throws -> TaskifyWatchNostrEvent {
        guard recipientPublicKey.count == 32,
              rumor.verifyID(),
              rumor.publicKey == (try TaskifyWatchNostrCrypto.publicKeyHex(for: senderPrivateKey)) else {
            throw TaskifyWatchNIP17Error.invalidRumor
        }
        let rumorData = try JSONEncoder().encode(rumor)
        let sealedContent = try TaskifyWatchNIP44V2.encrypt(
            rumorData,
            privateKey: senderPrivateKey,
            publicKey: recipientPublicKey,
            nonce: sealNonce
        )
        let seal = try TaskifyWatchNostrCrypto.signedEvent(
            privateKey: senderPrivateKey,
            createdAt: sealCreatedAt ?? randomizedPastTimestamp(relativeTo: rumor.createdAt),
            kind: sealKind,
            tags: [],
            content: sealedContent
        )
        let sealData = try JSONEncoder().encode(seal)
        let ephemeral = try ephemeralPrivateKey ?? TaskifyWatchNostrCrypto.randomPrivateKey()
        let wrapContent = try TaskifyWatchNIP44V2.encrypt(
            sealData,
            privateKey: ephemeral,
            publicKey: recipientPublicKey,
            nonce: wrapNonce
        )
        return try TaskifyWatchNostrCrypto.signedEvent(
            privateKey: ephemeral,
            createdAt: wrapCreatedAt ?? randomizedPastTimestamp(relativeTo: rumor.createdAt),
            kind: wrapKind,
            tags: [["p", recipientPublicKey.taskifyChatHexString]],
            content: wrapContent
        )
    }

    public static func unwrap(
        _ wrap: TaskifyWatchNostrEvent,
        recipientPrivateKey: Data
    ) throws -> TaskifyWatchNIP17DecryptedRumor {
        let recipient = try TaskifyWatchNostrCrypto.publicKeyHex(for: recipientPrivateKey)
        guard wrap.kind == wrapKind, TaskifyWatchNostrCrypto.verify(wrap) else {
            throw TaskifyWatchNIP17Error.invalidWrap
        }
        let outerRecipients = wrap.tags.compactMap {
            $0.count >= 2 && $0[0] == "p" ? $0[1].lowercased() : nil
        }
        guard outerRecipients == [recipient] else { throw TaskifyWatchNIP17Error.wrongRecipient }
        guard let ephemeralPublicKey = Data(taskifyChatHex: wrap.publicKey) else {
            throw TaskifyWatchNIP17Error.invalidWrap
        }
        let sealData = try TaskifyWatchNIP44V2.decrypt(
            wrap.content,
            privateKey: recipientPrivateKey,
            publicKey: ephemeralPublicKey
        )
        guard let seal = try? JSONDecoder().decode(TaskifyWatchNostrEvent.self, from: sealData),
              seal.kind == sealKind, seal.tags.isEmpty,
              TaskifyWatchNostrCrypto.verify(seal),
              let senderPublicKey = Data(taskifyChatHex: seal.publicKey) else {
            throw TaskifyWatchNIP17Error.invalidSeal
        }
        let rumorData = try TaskifyWatchNIP44V2.decrypt(
            seal.content,
            privateKey: recipientPrivateKey,
            publicKey: senderPublicKey
        )
        guard let rumorObject = try? JSONSerialization.jsonObject(with: rumorData) as? [String: Any],
              rumorObject["sig"] == nil,
              let rumor = try? JSONDecoder().decode(TaskifyWatchNIP17Rumor.self, from: rumorData),
              rumor.publicKey.lowercased() == seal.publicKey.lowercased(),
              rumor.verifyID() else {
            throw TaskifyWatchNIP17Error.invalidRumor
        }
        return TaskifyWatchNIP17DecryptedRumor(wrapEventID: wrap.id, rumor: rumor)
    }

    public static func chatMessage(
        from decrypted: TaskifyWatchNIP17DecryptedRumor,
        identityPublicKey: String
    ) throws -> TaskifyWatchChatMessage {
        let rumor = decrypted.rumor
        guard rumor.verifyID() else { throw TaskifyWatchNIP17Error.invalidRumor }
        let identity = identityPublicKey.lowercased()
        let recipients = Array(Set(rumor.recipientPublicKeys)).sorted()
        let members = Array(Set(recipients + [rumor.publicKey.lowercased()])).sorted()
        guard members.contains(identity),
              (2...TaskifyWatchGroupConversation.maximumMemberCount).contains(members.count) else {
            throw TaskifyWatchNIP17Error.invalidMembers
        }
        let conversationID: String
        if recipients.count >= 2 {
            conversationID = groupID(memberPublicKeys: members)
        } else if rumor.publicKey.lowercased() == identity {
            guard let recipient = recipients.first else { throw TaskifyWatchNIP17Error.invalidMembers }
            conversationID = recipient
        } else {
            conversationID = rumor.publicKey.lowercased()
        }
        let reply = rumor.tags.first {
            $0.count >= 2 && $0[0] == "e" && ($0.count < 4 || $0[3] == "reply")
        }?[1]
        let reactionTarget = rumor.kind == reactionKind
            ? rumor.tags.first { $0.count >= 2 && $0[0] == "e" }?[1]
            : nil
        let attachment = rumor.kind == attachmentKind ? attachment(from: rumor) : nil
        let messageKind: TaskifyWatchChatMessageKind
        if rumor.kind == reactionKind {
            messageKind = .reaction
        } else if rumor.kind == attachmentKind {
            messageKind = attachment?.isPhoto == true ? .photo : .unsupportedAttachment
        } else if rumor.kind == textKind {
            messageKind = .text
        } else {
            // A valid NIP-17 rumor can carry a newer or intentionally unsupported payload. Keep a
            // durable placeholder instead of dropping it and advancing the relay cursor forever.
            messageKind = .unsupportedMessage
        }
        let content: String
        if rumor.kind == attachmentKind {
            content = attachment?.isPhoto == true ? "Photo" : "Open attachment on iPhone"
        } else if messageKind == .unsupportedMessage {
            content = "Open this message on iPhone"
        } else {
            content = rumor.content
        }
        return TaskifyWatchChatMessage(
            rumorID: rumor.id,
            wrapID: decrypted.wrapEventID,
            conversationID: conversationID,
            senderPublicKey: rumor.publicKey,
            memberPublicKeys: members,
            content: content,
            createdAt: rumor.createdAt,
            kind: messageKind,
            replyToRumorID: reply,
            reactionTargetRumorID: reactionTarget,
            attachment: attachment,
            deliveryState: rumor.publicKey.lowercased() == identity ? .sent : nil
        )
    }

    public static func groupID(memberPublicKeys: [String]) -> String {
        let members = Array(Set(memberPublicKeys.map { $0.lowercased() })).sorted()
        return Data(SHA256.hash(data: Data(members.joined(separator: ",").utf8)))
            .taskifyChatHexString
    }

    private static func attachment(
        from rumor: TaskifyWatchNIP17Rumor
    ) -> TaskifyWatchChatAttachment? {
        var values: [String: String] = [:]
        for tag in rumor.tags where tag.count >= 2 && values[tag[0]] == nil {
            values[tag[0]] = tag[1]
        }
        guard let url = URL(string: rumor.content),
              ["aes-gcm", "aes-256-gcm"].contains(
                (values["encryption-algorithm"] ?? "").lowercased()
              ) else { return nil }
        return TaskifyWatchChatAttachment(
            url: url,
            mimeType: values["file-type"] ?? "application/octet-stream",
            filename: values["filename"],
            keyHex: values["decryption-key"] ?? "",
            nonceHex: values["decryption-nonce"] ?? "",
            ciphertextSHA256: values["x"],
            size: values["size"].flatMap(Int.init)
        )
    }

    private static func randomizedPastTimestamp(relativeTo timestamp: Int) -> Int {
        max(0, timestamp - Int.random(in: 0...(2 * 24 * 60 * 60)))
    }

    private static func isPublicKey(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy(\.isHexDigit)
    }

    private static func isEventID(_ value: String) -> Bool { isPublicKey(value) }
}

private extension Data {
    init?(taskifyChatHex value: String) {
        guard value.count.isMultiple(of: 2) else { return nil }
        var result = Data(capacity: value.count / 2)
        var index = value.startIndex
        while index < value.endIndex {
            let next = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        self = result
    }

    var taskifyChatHexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
