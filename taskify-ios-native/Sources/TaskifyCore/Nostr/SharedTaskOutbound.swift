import Foundation

public struct SharedTaskRecipient: Identifiable, Codable, Equatable, Sendable {
    public var id: String { publicKey }
    public var publicKey: String
    public var npub: String
    public var relayURLs: [String]
    public var lastSentAt: Date

    public init(
        publicKey: String,
        npub: String,
        relayURLs: [String],
        lastSentAt: Date = Date()
    ) {
        self.publicKey = publicKey.lowercased()
        self.npub = npub
        self.relayURLs = TaskifyRelayURL.normalizedList(relayURLs)
        self.lastSentAt = lastSentAt
    }

    public var shortDisplayName: String {
        npub.count > 22 ? "\(npub.prefix(12))…\(npub.suffix(6))" : npub
    }
}

public extension TaskItem {
    var sharedTaskAssignees: [SharedTaskAssignee] {
        guard case .array(let values) = preservedSyncFields?["assignees"] else { return [] }
        var seen = Set<String>()
        return values.compactMap { value in
            guard case .object(let object) = value,
                  case .string(let rawKey) = object["pubkey"] else { return nil }
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard NostrPublicKey.parse(key) != nil, seen.insert(key).inserted else { return nil }
            let relay: String?
            if case .string(let value) = object["relay"] {
                relay = TaskifyRelayURL.normalize(value)
            } else {
                relay = nil
            }
            let status: SharedTaskAssignmentStatus?
            if case .string(let value) = object["status"] {
                status = SharedTaskAssignmentStatus(rawValue: value == "maybe" ? "tentative" : value)
            } else {
                status = nil
            }
            let respondedAt: Int64?
            switch object["respondedAt"] {
            case .integer(let value): respondedAt = value > 0 ? value : nil
            case .number(let value): respondedAt = value > 0 ? Int64(value.rounded()) : nil
            default: respondedAt = nil
            }
            return SharedTaskAssignee(
                publicKey: key,
                relay: relay,
                status: status,
                respondedAt: respondedAt
            )
        }
    }
}

public extension TaskifySnapshot {
    var recentSharedTaskRecipients: [SharedTaskRecipient] {
        (sharedTaskRecipients ?? []).sorted { $0.lastSentAt > $1.lastSentAt }
    }

    mutating func upsertSharedTaskRecipient(_ recipient: SharedTaskRecipient) {
        var recipients = sharedTaskRecipients ?? []
        recipients.removeAll { $0.publicKey == recipient.publicKey }
        recipients.append(recipient)
        sharedTaskRecipients = Array(
            recipients.sorted { $0.lastSentAt > $1.lastSentAt }.prefix(24)
        )
    }

    @discardableResult
    mutating func markTaskAssigned(
        taskID: String,
        recipientPublicKey: String,
        recipientRelayURL: String? = nil,
        editorPublicKey: String? = nil
    ) -> TaskItem? {
        let key = recipientPublicKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard NostrPublicKey.parse(key) != nil,
              let index = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }) else {
            return nil
        }
        var assignees = tasks[index].sharedTaskAssignees
        let pending = SharedTaskAssignee(
            publicKey: key,
            relay: recipientRelayURL.flatMap(TaskifyRelayURL.normalize),
            status: .pending
        )
        if let assigneeIndex = assignees.firstIndex(where: { $0.publicKey == key }) {
            assignees[assigneeIndex] = pending
        } else {
            assignees.append(pending)
        }
        setAssignees(assignees, onTaskAt: index)
        tasks[index].lastEditedBy = editorPublicKey ?? tasks[index].lastEditedBy
        return tasks[index]
    }

    @discardableResult
    mutating func applyTaskAssignmentResponse(
        taskID: String,
        senderPublicKey: String,
        status: SharedTaskAssignmentStatus,
        respondedAt: Date,
        editorPublicKey: String? = nil
    ) -> TaskItem? {
        guard status != .pending else { return nil }
        let key = senderPublicKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let index = tasks.firstIndex(where: { $0.id == taskID && !$0.isDeleted }) else {
            return nil
        }
        var assignees = tasks[index].sharedTaskAssignees
        guard let assigneeIndex = assignees.firstIndex(where: { $0.publicKey == key }) else {
            return nil
        }
        let responseMilliseconds = Int64(respondedAt.timeIntervalSince1970 * 1_000)
        if let existing = assignees[assigneeIndex].respondedAt,
           existing > responseMilliseconds {
            return nil
        }
        if assignees[assigneeIndex].status == status,
           assignees[assigneeIndex].respondedAt == responseMilliseconds {
            return nil
        }
        assignees[assigneeIndex].status = status
        assignees[assigneeIndex].respondedAt = responseMilliseconds
        setAssignees(assignees, onTaskAt: index)
        tasks[index].lastEditedBy = editorPublicKey ?? key
        return tasks[index]
    }

    private mutating func setAssignees(
        _ assignees: [SharedTaskAssignee],
        onTaskAt index: Int
    ) {
        var preserved = tasks[index].preservedSyncFields ?? [:]
        preserved["assignees"] = .array(assignees.map { assignee in
            var object: [String: TaskPayloadValue] = [
                "pubkey": .string(assignee.publicKey),
            ]
            if let relay = assignee.relay { object["relay"] = .string(relay) }
            if let status = assignee.status { object["status"] = .string(status.rawValue) }
            if let respondedAt = assignee.respondedAt {
                object["respondedAt"] = .integer(respondedAt)
            }
            return .object(object)
        })
        tasks[index].preservedSyncFields = preserved
    }
}
