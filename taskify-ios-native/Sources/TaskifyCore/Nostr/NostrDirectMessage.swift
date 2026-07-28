import CryptoKit
import Foundation

public struct NostrDirectMessageAttachment: Codable, Equatable, Sendable {
    public static let rumorKind = 15
    public static let algorithm = "aes-gcm"

    public var url: String
    public var mimeType: String
    public var filename: String?
    public var size: Int?
    public var width: Int?
    public var height: Int?
    public var algorithm: String
    public var keyHex: String
    public var nonceHex: String
    public var sha256: String?

    public init?(
        url: String,
        mimeType: String,
        filename: String? = nil,
        size: Int? = nil,
        width: Int? = nil,
        height: Int? = nil,
        algorithm: String = Self.algorithm,
        keyHex: String,
        nonceHex: String,
        sha256: String? = nil
    ) {
        let normalizedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAlgorithm = algorithm.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedKey = keyHex.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedNonce = nonceHex.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let parsedURL = URL(string: normalizedURL),
              let scheme = parsedURL.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              normalizedAlgorithm == Self.algorithm || normalizedAlgorithm == "aes-256-gcm",
              normalizedKey.count == 64,
              normalizedNonce.count == 32,
              (try? Data(hex: normalizedKey))?.count == 32,
              (try? Data(hex: normalizedNonce))?.count == 16 else {
            return nil
        }

        self.url = parsedURL.absoluteString
        self.mimeType = mimeType.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? "application/octet-stream"
        self.filename = filename?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
            .map { String($0.prefix(255)) }
        self.size = size.flatMap { $0 > 0 ? $0 : nil }
        self.width = width.flatMap { $0 > 0 ? $0 : nil }
        self.height = height.flatMap { $0 > 0 ? $0 : nil }
        self.algorithm = normalizedAlgorithm
        self.keyHex = normalizedKey
        self.nonceHex = normalizedNonce
        let normalizedHash = sha256?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.sha256 = normalizedHash.flatMap {
            $0.count == 64 && (try? Data(hex: $0))?.count == 32 ? $0 : nil
        }
    }

    public init?(rumor: NIP17Rumor) {
        guard rumor.kind == Self.rumorKind else { return nil }
        var values: [String: String] = [:]
        for tag in rumor.tags where tag.count >= 2 && values[tag[0]] == nil {
            values[tag[0]] = tag[1]
        }
        var width: Int?
        var height: Int?
        if let dimensions = values["dim"]?.split(separator: "x", maxSplits: 1),
           dimensions.count == 2 {
            width = Int(dimensions[0])
            height = Int(dimensions[1])
        }
        self.init(
            url: rumor.content,
            mimeType: values["file-type"] ?? "application/octet-stream",
            filename: values["filename"],
            size: values["size"].flatMap(Int.init),
            width: width,
            height: height,
            algorithm: values["encryption-algorithm"] ?? "",
            keyHex: values["decryption-key"] ?? "",
            nonceHex: values["decryption-nonce"] ?? "",
            sha256: values["x"]
        )
    }

    public var rumorTags: [[String]] {
        var tags = [
            ["file-type", mimeType],
            ["encryption-algorithm", algorithm],
            ["decryption-key", keyHex],
            ["decryption-nonce", nonceHex],
        ]
        if let sha256 { tags.append(["x", sha256]) }
        if let size { tags.append(["size", String(size)]) }
        if let width, let height { tags.append(["dim", "\(width)x\(height)"]) }
        if let filename { tags.append(["filename", filename]) }
        return tags
    }

    public var isImage: Bool { mimeType.lowercased().hasPrefix("image/") }
    public var isVideo: Bool { mimeType.lowercased().hasPrefix("video/") }
    public var isAudio: Bool { mimeType.lowercased().hasPrefix("audio/") }

    public var displayName: String {
        if let filename { return filename }
        if isImage { return "Photo" }
        if isVideo { return "Video" }
        if isAudio { return "Audio" }
        return "Attachment"
    }

    public var messagePreview: String {
        if isImage { return "📷 \(displayName)" }
        if isVideo { return "🎬 \(displayName)" }
        if isAudio { return "🎵 \(displayName)" }
        return "📎 \(displayName)"
    }
}

public struct NostrDirectMessageEncryptedAttachment: Equatable, Sendable {
    public var ciphertext: Data
    public var keyHex: String
    public var nonceHex: String
    public var sha256: String

    public init(ciphertext: Data, keyHex: String, nonceHex: String, sha256: String) {
        self.ciphertext = ciphertext
        self.keyHex = keyHex
        self.nonceHex = nonceHex
        self.sha256 = sha256
    }
}

public enum NostrDirectMessageAttachmentCrypto {
    public static func encrypt(_ plaintext: Data) throws -> NostrDirectMessageEncryptedAttachment {
        let keyData = randomData(count: 32)
        let nonceData = randomData(count: 16)
        let key = SymmetricKey(data: keyData)
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
        let ciphertext = box.ciphertext + box.tag
        return NostrDirectMessageEncryptedAttachment(
            ciphertext: ciphertext,
            keyHex: keyData.hexString,
            nonceHex: nonceData.hexString,
            sha256: Data(SHA256.hash(data: ciphertext)).hexString
        )
    }

    public static func decrypt(
        _ ciphertext: Data,
        attachment: NostrDirectMessageAttachment
    ) throws -> Data {
        guard ciphertext.count >= 16,
              let keyData = try? Data(hex: attachment.keyHex),
              let nonceData = try? Data(hex: attachment.nonceHex),
              keyData.count == 32,
              nonceData.count == 16 else {
            throw CocoaError(.fileReadCorruptFile)
        }
        if let expectedHash = attachment.sha256,
           Data(SHA256.hash(data: ciphertext)).hexString != expectedHash {
            throw CocoaError(.fileReadCorruptFile)
        }
        let tagStart = ciphertext.index(ciphertext.endIndex, offsetBy: -16)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonceData),
            ciphertext: ciphertext[..<tagStart],
            tag: ciphertext[tagStart...]
        )
        return try AES.GCM.open(box, using: SymmetricKey(data: keyData))
    }

    private static func randomData(count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }
}

public struct NostrGroupConversation: Identifiable, Codable, Equatable, Sendable {
    public static let maximumMemberCount = 17

    public var id: String { groupID }
    public var groupID: String
    public var name: String
    public var memberPublicKeys: [String]
    public var createdAt: Int
    public var nameUpdatedAt: Int?

    public init?(
        name: String,
        memberPublicKeys: [String],
        createdAt: Int,
        nameUpdatedAt: Int? = nil
    ) {
        guard let members = Self.normalizedMembers(memberPublicKeys),
              (2...Self.maximumMemberCount).contains(members.count) else { return nil }
        self.groupID = Self.groupID(for: members)
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.memberPublicKeys = members
        self.createdAt = createdAt
        self.nameUpdatedAt = nameUpdatedAt
    }

    public init?(rumor: NIP17Rumor, identityPublicKey: String) {
        let recipients = Array(Set(rumor.recipientPublicKeys)).sorted()
        guard recipients.count >= 2,
              let members = Self.normalizedMembers(recipients + [rumor.publicKey]),
              members.contains(identityPublicKey.lowercased()),
              members.count <= Self.maximumMemberCount else { return nil }
        self.init(
            name: rumor.tags.first(where: { $0.count >= 2 && $0[0] == "subject" })?[1] ?? "",
            memberPublicKeys: members,
            createdAt: rumor.createdAt,
            nameUpdatedAt: rumor.tags.contains(where: { $0.count >= 2 && $0[0] == "subject" })
                ? rumor.createdAt
                : nil
        )
    }

    public static func groupID(for memberPublicKeys: [String]) -> String {
        let values = normalizedMembers(memberPublicKeys) ?? memberPublicKeys.map { $0.lowercased() }.sorted()
        return Data(SHA256.hash(data: Data(values.joined(separator: ",").utf8))).hexString
    }

    public var displayName: String { name.isEmpty ? "Group" : name }

    private static func normalizedMembers(_ values: [String]) -> [String]? {
        let parsed = Set(values.compactMap { NostrPublicKey.parse($0)?.hexString })
        guard parsed.count == Set(values.map { $0.lowercased() }).count else { return nil }
        return parsed.sorted()
    }
}

public struct NostrDirectMessage: Identifiable, Codable, Equatable, Sendable {
    public var id: String { rumorEventID }
    public var rumorEventID: String
    public var wrapEventID: String
    public var peerPublicKey: String
    public var senderPublicKey: String
    public var content: String
    public var createdAt: Int
    public var isIncoming: Bool
    public var relayURLs: [String]?
    public var replyToEventID: String?
    public var attachment: NostrDirectMessageAttachment?
    public var groupID: String?
    public var groupMemberPublicKeys: [String]?

    public init(
        rumorEventID: String,
        wrapEventID: String,
        peerPublicKey: String,
        senderPublicKey: String,
        content: String,
        createdAt: Int,
        isIncoming: Bool,
        relayURLs: [String]? = nil,
        replyToEventID: String? = nil,
        attachment: NostrDirectMessageAttachment? = nil,
        groupID: String? = nil,
        groupMemberPublicKeys: [String]? = nil
    ) {
        self.rumorEventID = rumorEventID.lowercased()
        self.wrapEventID = wrapEventID.lowercased()
        self.peerPublicKey = peerPublicKey.lowercased()
        self.senderPublicKey = senderPublicKey.lowercased()
        self.content = content
        self.createdAt = createdAt
        self.isIncoming = isIncoming
        self.relayURLs = TaskifyRelayURL.normalizedList(relayURLs ?? []).nilIfEmpty
        self.replyToEventID = replyToEventID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().nilIfEmpty
        self.attachment = attachment
        self.groupID = groupID?.lowercased()
        self.groupMemberPublicKeys = groupMemberPublicKeys?.map { $0.lowercased() }.sorted().nilIfEmpty
    }

    public init?(
        decrypted: NIP17DecryptedRumor,
        identityPublicKey: String,
        relayURLs: [String] = []
    ) {
        let rumor = decrypted.rumor
        let identity = identityPublicKey.lowercased()
        let recipients = Array(Set(rumor.recipientPublicKeys)).sorted()
        guard rumor.kind == NIP17GiftWrap.rumorKind || rumor.kind == NostrDirectMessageAttachment.rumorKind,
              rumor.verifyID(),
              !rumor.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !recipients.isEmpty else { return nil }

        let incoming = rumor.publicKey != identity
        let peer: String
        let group: NostrGroupConversation?
        if recipients.count >= 2 {
            guard let parsedGroup = NostrGroupConversation(
                rumor: rumor,
                identityPublicKey: identity
            ) else { return nil }
            group = parsedGroup
            peer = parsedGroup.groupID
        } else {
            guard let onlyRecipient = recipients.first else { return nil }
            group = nil
            if incoming {
                guard onlyRecipient == identity else { return nil }
                peer = rumor.publicKey
            } else {
                guard onlyRecipient != identity else { return nil }
                peer = onlyRecipient
            }
            guard NostrPublicKey.parse(peer) != nil else { return nil }
        }

        let attachment: NostrDirectMessageAttachment?
        if rumor.kind == NostrDirectMessageAttachment.rumorKind {
            guard let parsedAttachment = NostrDirectMessageAttachment(rumor: rumor) else { return nil }
            attachment = parsedAttachment
        } else {
            attachment = nil
        }

        self.init(
            rumorEventID: rumor.id,
            wrapEventID: decrypted.wrapEventID,
            peerPublicKey: peer,
            senderPublicKey: rumor.publicKey,
            content: rumor.content,
            createdAt: rumor.createdAt,
            isIncoming: incoming,
            relayURLs: relayURLs,
            replyToEventID: rumor.tags.first(where: { $0.count >= 2 && $0[0] == "e" })?[1],
            attachment: attachment,
            groupID: group?.groupID,
            groupMemberPublicKeys: group?.memberPublicKeys
        )
    }

    public var displayContent: String { attachment?.messagePreview ?? content }

    /// Matches the fields surfaced by Taskify's conversation search without
    /// requiring the UI to understand attachment payload details.
    public func matchesSearch(_ query: String, senderName: String? = nil) -> Bool {
        let needle = Self.normalizedSearchText(query)
        guard !needle.isEmpty else { return false }
        let values = [
            content,
            displayContent,
            attachment?.filename,
            attachment?.mimeType,
            senderName,
        ]
        return values.compactMap { $0 }.contains {
            Self.normalizedSearchText($0).contains(needle)
        }
    }

    private static func normalizedSearchText(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
}

public struct NostrDirectMessageReaction: Identifiable, Codable, Equatable, Sendable {
    public var id: String { rumorEventID }
    public var rumorEventID: String
    public var wrapEventID: String
    public var targetEventID: String
    public var senderPublicKey: String
    public var peerPublicKey: String
    public var emoji: String
    public var createdAt: Int
    public var groupID: String?
    public var groupMemberPublicKeys: [String]?

    public init(
        rumorEventID: String,
        wrapEventID: String,
        targetEventID: String,
        senderPublicKey: String,
        peerPublicKey: String,
        emoji: String,
        createdAt: Int,
        groupID: String? = nil,
        groupMemberPublicKeys: [String]? = nil
    ) {
        self.rumorEventID = rumorEventID.lowercased()
        self.wrapEventID = wrapEventID.lowercased()
        self.targetEventID = targetEventID.lowercased()
        self.senderPublicKey = senderPublicKey.lowercased()
        self.peerPublicKey = peerPublicKey.lowercased()
        self.emoji = emoji
        self.createdAt = createdAt
        self.groupID = groupID?.lowercased()
        self.groupMemberPublicKeys = groupMemberPublicKeys?.map { $0.lowercased() }.sorted().nilIfEmpty
    }

    public init?(
        decrypted: NIP17DecryptedRumor,
        identityPublicKey: String
    ) {
        let rumor = decrypted.rumor
        let identity = identityPublicKey.lowercased()
        guard rumor.kind == 7,
              rumor.verifyID(),
              let target = rumor.tags.first(where: { $0.count >= 2 && $0[0] == "e" })?[1]
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased().nilIfEmpty else {
            return nil
        }
        let recipients = Array(Set(rumor.recipientPublicKeys)).sorted()
        let incoming = rumor.publicKey != identity
        let peer: String
        let group: NostrGroupConversation?
        if recipients.count >= 2 {
            guard let parsedGroup = NostrGroupConversation(
                rumor: rumor,
                identityPublicKey: identity
            ) else { return nil }
            group = parsedGroup
            peer = parsedGroup.groupID
        } else {
            group = nil
            if incoming {
                guard recipients.contains(identity) else { return nil }
                peer = rumor.publicKey
            } else {
                guard let recipient = recipients.first(where: { $0 != identity }) else {
                    return nil
                }
                peer = recipient
            }
            guard NostrPublicKey.parse(peer) != nil else { return nil }
        }
        let value = rumor.content.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(
            rumorEventID: rumor.id,
            wrapEventID: decrypted.wrapEventID,
            targetEventID: target,
            senderPublicKey: rumor.publicKey,
            peerPublicKey: peer,
            emoji: value.isEmpty ? "❤️" : value,
            createdAt: rumor.createdAt,
            groupID: group?.groupID,
            groupMemberPublicKeys: group?.memberPublicKeys
        )
    }

    public var isRemoval: Bool { emoji == "-" }
}

public struct NostrDirectMessageThread: Identifiable, Equatable, Sendable {
    public var id: String { peerPublicKey }
    public var peerPublicKey: String
    public var messages: [NostrDirectMessage]
    public var sharedTasks: [SharedInboxItem]
    public var sharedContacts: [SharedContactInboxItem]
    public var calendarInvites: [SharedCalendarInviteInboxItem]
    public var sharedBoards: [SharedBoardInboxItem]
    public var unreadCount: Int
    public var actionRequiredCount: Int

    public init(
        peerPublicKey: String,
        messages: [NostrDirectMessage],
        sharedTasks: [SharedInboxItem] = [],
        sharedContacts: [SharedContactInboxItem] = [],
        calendarInvites: [SharedCalendarInviteInboxItem] = [],
        sharedBoards: [SharedBoardInboxItem] = [],
        unreadCount: Int,
        actionRequiredCount: Int = 0
    ) {
        self.peerPublicKey = peerPublicKey
        self.messages = messages
        self.sharedTasks = sharedTasks
        self.sharedContacts = sharedContacts
        self.calendarInvites = calendarInvites
        self.sharedBoards = sharedBoards
        self.unreadCount = unreadCount
        self.actionRequiredCount = actionRequiredCount
    }

    public var latestMessage: NostrDirectMessage? { messages.last }
    public var latestSharedTask: SharedInboxItem? { sharedTasks.last }
    public var latestSharedContact: SharedContactInboxItem? { sharedContacts.last }
    public var latestCalendarInvite: SharedCalendarInviteInboxItem? { calendarInvites.last }
    public var latestSharedBoard: SharedBoardInboxItem? { sharedBoards.last }
    public var latestActivityTimestamp: Int {
        [
            latestMessage?.createdAt ?? 0,
            Int(latestSharedTask?.receivedAt.timeIntervalSince1970 ?? 0),
            Int(latestSharedContact?.receivedAt.timeIntervalSince1970 ?? 0),
            Int(latestCalendarInvite?.receivedAt.timeIntervalSince1970 ?? 0),
            Int(latestSharedBoard?.receivedAt.timeIntervalSince1970 ?? 0),
        ].max() ?? 0
    }
}

public extension TaskifySnapshot {
    var groupConversations: [NostrGroupConversation] {
        (nostrGroupConversations ?? []).sorted {
            if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
            return $0.groupID < $1.groupID
        }
    }

    func groupConversation(id: String) -> NostrGroupConversation? {
        let normalized = id.lowercased()
        return (nostrGroupConversations ?? []).first { $0.groupID == normalized }
    }

    @discardableResult
    mutating func upsertGroupConversation(_ group: NostrGroupConversation) -> Bool {
        var values = nostrGroupConversations ?? []
        if let index = values.firstIndex(where: { $0.groupID == group.groupID }) {
            var current = values[index]
            current.createdAt = min(current.createdAt, group.createdAt)
            guard (group.nameUpdatedAt ?? 0) > (current.nameUpdatedAt ?? 0) else {
                if current != values[index] {
                    values[index] = current
                    nostrGroupConversations = values
                    return true
                }
                return false
            }
            current.name = group.name
            current.nameUpdatedAt = group.nameUpdatedAt
            current.memberPublicKeys = group.memberPublicKeys
            values[index] = current
        } else {
            values.append(group)
        }
        nostrGroupConversations = values
        return true
    }

    var directMessageHistory: [NostrDirectMessage] {
        (directMessages ?? []).sorted(by: Self.directMessageSort)
    }

    func directMessages(with peerPublicKey: String) -> [NostrDirectMessage] {
        guard let peer = Self.normalizedConversationID(peerPublicKey) else { return [] }
        return (directMessages ?? [])
            .filter { $0.peerPublicKey == peer }
            .sorted(by: Self.directMessageSort)
    }

    func directMessageThreads() -> [NostrDirectMessageThread] {
        let conversations = nostrGroupConversations ?? []
        let conversationByID = Dictionary(
            conversations.map { ($0.groupID, $0) },
            uniquingKeysWith: { current, candidate in
                (candidate.nameUpdatedAt ?? candidate.createdAt)
                    > (current.nameUpdatedAt ?? current.createdAt)
                    ? candidate
                    : current
            }
        )
        let groupedMessages = Dictionary(
            grouping: directMessages ?? [],
            by: \NostrDirectMessage.peerPublicKey
        )
        let groupedShares = Dictionary(
            grouping: (sharedInboxItems ?? []).filter { $0.status != .deleted },
            by: { $0.sender.publicKey.lowercased() }
        )
        let groupedContacts = Dictionary(
            grouping: (sharedContactInboxItems ?? []).filter { $0.status != .deleted },
            by: { $0.sender.publicKey.lowercased() }
        )
        let groupedCalendarInvites = Dictionary(
            grouping: (sharedCalendarInviteItems ?? []).filter { $0.status != .deleted },
            by: { $0.sender.publicKey.lowercased() }
        )
        let groupedBoards = Dictionary(
            grouping: (sharedBoardInboxItems ?? []).filter { $0.status != .deleted },
            by: { $0.sender.publicKey.lowercased() }
        )
        let groupIDs = Set(conversationByID.keys)
        let peerIDs = Set(groupedMessages.keys)
            .union(groupedShares.keys)
            .union(groupedContacts.keys)
            .union(groupedCalendarInvites.keys)
            .union(groupedBoards.keys)
            .union(groupIDs)
        let threads = peerIDs.map { peer -> NostrDirectMessageThread in
            let sorted = (groupedMessages[peer] ?? []).sorted(by: Self.directMessageSort)
            let sharedTasks = (groupedShares[peer] ?? []).sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
            let sharedContacts = (groupedContacts[peer] ?? []).sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
            let calendarInvites = (groupedCalendarInvites[peer] ?? []).sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
            let sharedBoards = (groupedBoards[peer] ?? []).sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
            let readAt = directMessageReadAt?[peer] ?? 0
            let mutedAt = directMessageMutedGroups?[peer]
            return NostrDirectMessageThread(
                peerPublicKey: peer,
                messages: sorted,
                sharedTasks: sharedTasks,
                sharedContacts: sharedContacts,
                calendarInvites: calendarInvites,
                sharedBoards: sharedBoards,
                unreadCount: sorted.filter {
                    $0.isIncoming &&
                        $0.createdAt > readAt &&
                        $0.createdAt < (mutedAt ?? .max)
                }.count,
                actionRequiredCount: sharedTasks.filter { $0.status == .pending }.count
                    + sharedContacts.filter { $0.status == .pending }.count
                    + calendarInvites.filter { $0.status == .pending }.count
                    + sharedBoards.filter { $0.status == .pending }.count
            )
        }
        return threads.sorted {
            let lhs = $0.latestActivityTimestamp
            let rhs = $1.latestActivityTimestamp
            if lhs != rhs { return lhs > rhs }
            let lhsGroupCreated = conversationByID[$0.peerPublicKey]?.createdAt ?? 0
            let rhsGroupCreated = conversationByID[$1.peerPublicKey]?.createdAt ?? 0
            if lhsGroupCreated != rhsGroupCreated { return lhsGroupCreated > rhsGroupCreated }
            return $0.peerPublicKey < $1.peerPublicKey
        }
    }

    /// Builds the inbox without rescanning every model-wide message/share collection once for
    /// each thread. Archive state can be decided from the already-computed latest activity.
    func activeDirectMessageThreads() -> [NostrDirectMessageThread] {
        let archivedAt = directMessageArchivedAt ?? [:]
        guard !archivedAt.isEmpty else { return directMessageThreads() }
        let groupCreatedAt = Dictionary(
            (nostrGroupConversations ?? []).map {
                ($0.groupID, $0.createdAt)
            },
            uniquingKeysWith: min
        )
        return directMessageThreads().filter { thread in
            guard let archivedTimestamp = archivedAt[thread.peerPublicKey] else { return true }
            return max(
                thread.latestActivityTimestamp,
                groupCreatedAt[thread.peerPublicKey] ?? 0
            ) > archivedTimestamp
        }
    }

    func isDirectMessageThreadArchived(_ peerPublicKey: String) -> Bool {
        guard let peer = Self.normalizedConversationID(peerPublicKey),
              let archivedAt = directMessageArchivedAt?[peer] else { return false }
        let latestMessage = (directMessages ?? [])
            .filter { $0.peerPublicKey == peer }
            .map(\.createdAt)
            .max() ?? 0
        let latestSharedTask = (sharedInboxItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let latestSharedContact = (sharedContactInboxItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let latestCalendarInvite = (sharedCalendarInviteItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let latestSharedBoard = (sharedBoardInboxItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let groupCreatedAt = groupConversation(id: peer)?.createdAt ?? 0
        return ([
            latestMessage, latestSharedTask, latestSharedContact, latestCalendarInvite,
            latestSharedBoard, groupCreatedAt,
        ].max() ?? 0) <= archivedAt
    }

    @discardableResult
    mutating func archiveDirectMessageThread(
        peerPublicKey: String,
        at timestamp: Int = Int(Date().timeIntervalSince1970)
    ) -> Bool {
        guard let peer = Self.normalizedConversationID(peerPublicKey) else { return false }
        let latestMessage = (directMessages ?? [])
            .filter { $0.peerPublicKey == peer }
            .map(\.createdAt)
            .max() ?? 0
        let latestSharedTask = (sharedInboxItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let latestSharedContact = (sharedContactInboxItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let latestCalendarInvite = (sharedCalendarInviteItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let latestSharedBoard = (sharedBoardInboxItems ?? [])
            .filter { $0.status != .deleted && $0.sender.publicKey.lowercased() == peer }
            .map { Int($0.receivedAt.timeIntervalSince1970) }
            .max() ?? 0
        let latestActivity = [
            timestamp,
            latestMessage,
            latestSharedTask,
            latestSharedContact,
            latestCalendarInvite,
            latestSharedBoard,
            groupConversation(id: peer)?.createdAt ?? 0,
        ].max() ?? timestamp
        let archivedAt = max(
            timestamp,
            latestActivity
        )
        var states = directMessageArchivedAt ?? [:]
        guard states[peer] != archivedAt else { return false }
        states[peer] = archivedAt
        directMessageArchivedAt = states
        _ = markDirectMessageThreadRead(peerPublicKey: peer, through: archivedAt)
        return true
    }

    @discardableResult
    mutating func unarchiveDirectMessageThread(peerPublicKey: String) -> Bool {
        guard let peer = Self.normalizedConversationID(peerPublicKey),
              directMessageArchivedAt?[peer] != nil else { return false }
        var states = directMessageArchivedAt ?? [:]
        states.removeValue(forKey: peer)
        directMessageArchivedAt = states.nilIfEmpty
        return true
    }

    @discardableResult
    mutating func deleteDirectMessageThread(
        peerPublicKey: String,
        at timestamp: Int = Int(Date().timeIntervalSince1970),
        suppressionDuration: Int = 3 * 24 * 60 * 60
    ) -> Bool {
        guard let peer = Self.normalizedConversationID(peerPublicKey) else { return false }
        let removedMessages = (directMessages ?? []).filter { $0.peerPublicKey == peer }
        let removedSharedTasks = (sharedInboxItems ?? []).filter {
            $0.status != .deleted && $0.sender.publicKey.lowercased() == peer
        }
        let removedSharedContacts = (sharedContactInboxItems ?? []).filter {
            $0.status != .deleted && $0.sender.publicKey.lowercased() == peer
        }
        let removedCalendarInvites = (sharedCalendarInviteItems ?? []).filter {
            $0.status != .deleted && $0.sender.publicKey.lowercased() == peer
        }
        let removedSharedBoards = (sharedBoardInboxItems ?? []).filter {
            $0.status != .deleted && $0.sender.publicKey.lowercased() == peer
        }
        let hadGroup = groupConversation(id: peer) != nil
        guard !removedMessages.isEmpty || !removedSharedTasks.isEmpty ||
                !removedSharedContacts.isEmpty || !removedCalendarInvites.isEmpty ||
                !removedSharedBoards.isEmpty || hadGroup else {
            return false
        }

        let expiry = timestamp + max(0, suppressionDuration)
        var suppressed = (directMessageDeletedEventIDs ?? [:]).filter { $0.value > timestamp }
        for message in removedMessages {
            suppressed[message.rumorEventID] = expiry
            suppressed[message.wrapEventID] = expiry
        }
        if suppressed.count > 1_600 {
            let newest = suppressed.sorted { $0.value > $1.value }.prefix(1_600)
            suppressed = Dictionary(uniqueKeysWithValues: newest.map { ($0.key, $0.value) })
        }
        directMessageDeletedEventIDs = suppressed.nilIfEmpty
        directMessages = (directMessages ?? []).filter { $0.peerPublicKey != peer }.nilIfEmpty
        directMessageReactions = (directMessageReactions ?? []).filter { $0.peerPublicKey != peer }.nilIfEmpty
        if !removedSharedTasks.isEmpty {
            var items = sharedInboxItems ?? []
            let respondedAt = Date(timeIntervalSince1970: TimeInterval(timestamp))
            for index in items.indices where
                items[index].status != .deleted &&
                items[index].sender.publicKey.lowercased() == peer {
                items[index].status = .deleted
                items[index].respondedAt = respondedAt
            }
            sharedInboxItems = items.nilIfEmpty
        }
        if !removedSharedContacts.isEmpty {
            var items = sharedContactInboxItems ?? []
            let respondedAt = Date(timeIntervalSince1970: TimeInterval(timestamp))
            for index in items.indices where
                items[index].status != .deleted &&
                items[index].sender.publicKey.lowercased() == peer {
                items[index].status = .deleted
                items[index].respondedAt = respondedAt
            }
            sharedContactInboxItems = items.nilIfEmpty
        }
        if !removedCalendarInvites.isEmpty {
            var items = sharedCalendarInviteItems ?? []
            let respondedAt = Date(timeIntervalSince1970: TimeInterval(timestamp))
            for index in items.indices where
                items[index].status != .deleted &&
                items[index].sender.publicKey.lowercased() == peer {
                items[index].status = .deleted
                items[index].respondedAt = respondedAt
            }
            sharedCalendarInviteItems = items.nilIfEmpty
        }
        if !removedSharedBoards.isEmpty {
            var items = sharedBoardInboxItems ?? []
            let respondedAt = Date(timeIntervalSince1970: TimeInterval(timestamp))
            for index in items.indices where
                items[index].status != .deleted &&
                items[index].sender.publicKey.lowercased() == peer {
                items[index].status = .deleted
                items[index].respondedAt = respondedAt
            }
            sharedBoardInboxItems = items.nilIfEmpty
        }
        directMessageReadAt?.removeValue(forKey: peer)
        directMessageArchivedAt?.removeValue(forKey: peer)
        if hadGroup {
            nostrGroupConversations = (nostrGroupConversations ?? [])
                .filter { $0.groupID != peer }
                .nilIfEmpty
            directMessageMutedGroups?.removeValue(forKey: peer)
            directMessageLeftGroups = directMessageLeftGroups?.filter { $0 != peer }.nilIfEmpty
        }
        return true
    }

    func isDirectMessagePeerBlocked(_ peerPublicKey: String) -> Bool {
        guard let peer = Self.normalizedConversationID(peerPublicKey) else { return false }
        return directMessageBlockedPeers?.contains(peer) == true
    }

    @discardableResult
    mutating func setDirectMessagePeerBlocked(_ peerPublicKey: String, blocked: Bool) -> Bool {
        guard let peer = NostrPublicKey.parse(peerPublicKey)?.hexString else { return false }
        var values = Set(directMessageBlockedPeers ?? [])
        let changed = blocked ? values.insert(peer).inserted : values.remove(peer) != nil
        guard changed else { return false }
        directMessageBlockedPeers = values.sorted().nilIfEmpty
        return true
    }

    func isDirectMessageGroupMuted(_ groupID: String) -> Bool {
        guard let group = Self.normalizedConversationID(groupID) else { return false }
        return directMessageMutedGroups?[group] != nil
    }

    @discardableResult
    mutating func setDirectMessageGroupMuted(
        _ groupID: String,
        muted: Bool,
        at timestamp: Int = Int(Date().timeIntervalSince1970)
    ) -> Bool {
        guard let group = Self.normalizedConversationID(groupID), groupConversation(id: group) != nil else {
            return false
        }
        var states = directMessageMutedGroups ?? [:]
        let changed: Bool
        if muted {
            changed = states[group] != timestamp
            states[group] = timestamp
        } else {
            changed = states.removeValue(forKey: group) != nil
        }
        guard changed else { return false }
        directMessageMutedGroups = states.nilIfEmpty
        return true
    }

    func hasLeftDirectMessageGroup(_ groupID: String) -> Bool {
        guard let group = Self.normalizedConversationID(groupID) else { return false }
        return directMessageLeftGroups?.contains(group) == true
    }

    @discardableResult
    mutating func setDirectMessageGroupLeft(_ groupID: String, left: Bool) -> Bool {
        guard let group = Self.normalizedConversationID(groupID), groupConversation(id: group) != nil else {
            return false
        }
        var values = Set(directMessageLeftGroups ?? [])
        let changed = left ? values.insert(group).inserted : values.remove(group) != nil
        guard changed else { return false }
        directMessageLeftGroups = values.sorted().nilIfEmpty
        return true
    }

    func directMessageReactions(for message: NostrDirectMessage) -> [NostrDirectMessageReaction] {
        (directMessageReactions ?? [])
            .filter {
                !$0.isRemoval &&
                    $0.peerPublicKey == message.peerPublicKey &&
                    ($0.targetEventID == message.rumorEventID || $0.targetEventID == message.wrapEventID)
            }
            .sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                return $0.rumorEventID < $1.rumorEventID
            }
    }

    @discardableResult
    mutating func ingestDirectMessage(
        _ message: NostrDirectMessage,
        maximumCount: Int = 400,
        now: Int = Int(Date().timeIntervalSince1970)
    ) -> Bool {
        guard Self.normalizedConversationID(message.peerPublicKey) != nil,
              message.groupID == nil || message.groupID == message.peerPublicKey,
              !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        let suppressed = (directMessageDeletedEventIDs ?? [:]).filter { $0.value > now }
        directMessageDeletedEventIDs = suppressed.nilIfEmpty
        guard suppressed[message.rumorEventID] == nil,
              suppressed[message.wrapEventID] == nil else { return false }
        var values = directMessages ?? []
        guard !values.contains(where: { $0.rumorEventID == message.rumorEventID }) else {
            return false
        }
        values.append(message)
        values.sort(by: Self.directMessageSort)
        if values.count > maximumCount {
            values.removeFirst(values.count - maximumCount)
        }
        directMessages = values
        return true
    }

    @discardableResult
    mutating func ingestDirectMessageReaction(
        _ reaction: NostrDirectMessageReaction,
        maximumCount: Int = 800
    ) -> Bool {
        let target = (directMessages ?? []).first(where: {
            $0.rumorEventID == reaction.targetEventID || $0.wrapEventID == reaction.targetEventID
        })
        guard target == nil || target?.peerPublicKey == reaction.peerPublicKey else { return false }

        var values = directMessageReactions ?? []
        if let index = values.firstIndex(where: {
            $0.targetEventID == reaction.targetEventID &&
                $0.senderPublicKey == reaction.senderPublicKey
        }) {
            let current = values[index]
            guard reaction.createdAt > current.createdAt ||
                    (reaction.createdAt == current.createdAt && reaction.rumorEventID > current.rumorEventID) else {
                return false
            }
            values[index] = reaction
        } else {
            guard !values.contains(where: { $0.rumorEventID == reaction.rumorEventID }) else {
                return false
            }
            values.append(reaction)
        }
        values.sort {
            if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
            return $0.rumorEventID < $1.rumorEventID
        }
        if values.count > maximumCount {
            values.removeFirst(values.count - maximumCount)
        }
        directMessageReactions = values
        return true
    }

    @discardableResult
    mutating func markDirectMessageThreadRead(
        peerPublicKey: String,
        through timestamp: Int? = nil
    ) -> Bool {
        guard let peer = Self.normalizedConversationID(peerPublicKey) else { return false }
        let newestIncoming = (directMessages ?? [])
            .filter { $0.peerPublicKey == peer && $0.isIncoming }
            .map(\.createdAt)
            .max() ?? 0
        let target = max(timestamp ?? newestIncoming, newestIncoming)
        guard target > (directMessageReadAt?[peer] ?? 0) else { return false }
        var states = directMessageReadAt ?? [:]
        states[peer] = target
        directMessageReadAt = states
        return true
    }

    private static func directMessageSort(
        _ lhs: NostrDirectMessage,
        _ rhs: NostrDirectMessage
    ) -> Bool {
        if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
        return lhs.rumorEventID < rhs.rumorEventID
    }

    private static func normalizedConversationID(_ value: String) -> String? {
        if let publicKey = NostrPublicKey.parse(value)?.hexString { return publicKey }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.count == 64, (try? Data(hex: normalized))?.count == 32 else { return nil }
        return normalized
    }
}

private extension Array {
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}

private extension Dictionary {
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
