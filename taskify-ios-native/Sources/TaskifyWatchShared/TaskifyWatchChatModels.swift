import Foundation

public enum TaskifyWatchRelayResolutionStatus: String, Codable, Equatable, Sendable {
    case published
    case confirmedAbsent
    case publishedButUnusable
    case indeterminate
}

public struct TaskifyWatchRelayDecision: Codable, Equatable, Sendable {
    public let status: TaskifyWatchRelayResolutionStatus
    public let relayURLs: [String]
    public let eventCreatedAt: Int?
    public let isStale: Bool

    public init(
        status: TaskifyWatchRelayResolutionStatus,
        relayURLs: [String] = [],
        eventCreatedAt: Int? = nil,
        isStale: Bool = false
    ) {
        self.status = status
        self.relayURLs = relayURLs
        self.eventCreatedAt = eventCreatedAt
        self.isStale = isStale
    }

    public var canPublish: Bool {
        (status == .published || status == .confirmedAbsent) && !relayURLs.isEmpty
    }
}

/// Freshness measures when discovery succeeded, not when someone last changed their
/// published relay list (which can legitimately be months old).
public struct TaskifyWatchRelayDecisionCache: Sendable {
    private struct Entry: Sendable {
        let decision: TaskifyWatchRelayDecision
        let seedEventID: String?
        let checkedAt: Date
    }
    private var entries: [String: Entry] = [:]
    private let freshness: TimeInterval
    private let maximumCount: Int

    public init(freshness: TimeInterval = 6 * 60 * 60, maximumCount: Int = 128) {
        self.freshness = freshness
        self.maximumCount = max(1, maximumCount)
    }

    public func decision(
        for recipient: String,
        seedEventID: String?,
        now: Date = Date()
    ) -> TaskifyWatchRelayDecision? {
        guard let entry = entries[recipient.lowercased()], entry.seedEventID == seedEventID,
              now.timeIntervalSince(entry.checkedAt) >= 0,
              now.timeIntervalSince(entry.checkedAt) < freshness else { return nil }
        return entry.decision
    }

    public mutating func record(
        _ decision: TaskifyWatchRelayDecision,
        for recipient: String,
        seedEventID: String?,
        checkedAt: Date = Date()
    ) {
        guard decision.canPublish, !decision.isStale else { return }
        entries[recipient.lowercased()] = Entry(
            decision: decision, seedEventID: seedEventID, checkedAt: checkedAt
        )
        if entries.count > maximumCount,
           let oldest = entries.min(by: { $0.value.checkedAt < $1.value.checkedAt })?.key {
            entries.removeValue(forKey: oldest)
        }
    }
}

public enum TaskifyWatchRelayRouting {
    public static let maximumRelayCount = 16
    public static let defaultFallbackRelayURLs = [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.solife.me",
    ]

    public static func normalizedRelayURLs(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { raw in
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard var components = URLComponents(string: trimmed),
                  components.scheme?.lowercased() == "wss",
                  components.user == nil,
                  components.password == nil,
                  let host = components.host?.lowercased(),
                  !host.isEmpty,
                  host != "localhost",
                  !host.hasSuffix(".localhost"),
                  !host.hasSuffix(".local"),
                  !Self.isPrivateLiteral(host) else { return nil }
            components.scheme = "wss"
            components.host = host
            components.fragment = nil
            if components.port == 443 { components.port = nil }
            if components.path == "/" { components.path = "" }
            guard let canonical = components.url?.absoluteString else { return nil }
            let normalized = canonical.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard seen.insert(normalized).inserted else { return nil }
            return normalized
        }
    }

    /// Wraps that remain unroutable for this many flush attempts fall back to degraded
    /// delivery instead of cycling on discovery forever. The iPhone always falls back to its
    /// own relay set when a recipient's NIP-17 inbox list cannot be resolved; the Watch owes
    /// the same liveness, with a bounded delay so a momentarily flaky discovery network is
    /// still given a chance to resolve the real inbox relays first.
    public static let degradedFallbackAttemptThreshold = 3

    /// Degraded routing used once bounded discovery keeps failing: the Taskify push relay
    /// first (Taskify recipients advertise it in their own NIP-17 inbox list, and the
    /// gateway ingests it locally), then the same interoperable defaults used for confirmed
    /// absence, then the account's discovery relays as trailing redundancy.
    public static func fallbackDecision(
        pushRelayWSSURL: String,
        contextRelayURLs: [String]
    ) -> TaskifyWatchRelayDecision {
        let relayURLs = Array(normalizedRelayURLs(
            [pushRelayWSSURL] + defaultFallbackRelayURLs + contextRelayURLs
        ).prefix(maximumRelayCount))
        return TaskifyWatchRelayDecision(status: .confirmedAbsent, relayURLs: relayURLs)
    }

    public static func resolve(
        recipientPublicKey: String,
        events: [TaskifyWatchNostrEvent],
        discoveryComplete: Bool,
        lastKnownPositive: TaskifyWatchRelayDecision? = nil
    ) -> TaskifyWatchRelayDecision {
        let recipient = recipientPublicKey.lowercased()
        let candidates = events.filter {
            $0.kind == 10_050
                && $0.publicKey.lowercased() == recipient
                && TaskifyWatchNostrCrypto.verify($0)
        }.sorted {
            if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
            return $0.id < $1.id
        }
        if let newest = candidates.first {
            let advertised = newest.tags.compactMap { tag in
                tag.count >= 2 && tag[0] == "relay" ? tag[1] : nil
            }
            let relays = normalizedRelayURLs(advertised)
            guard !relays.isEmpty, relays.count <= maximumRelayCount else {
                return TaskifyWatchRelayDecision(
                    status: .publishedButUnusable,
                    eventCreatedAt: newest.createdAt
                )
            }
            return TaskifyWatchRelayDecision(
                status: .published,
                relayURLs: relays,
                eventCreatedAt: newest.createdAt
            )
        }
        if discoveryComplete {
            return TaskifyWatchRelayDecision(
                status: .confirmedAbsent,
                relayURLs: defaultFallbackRelayURLs
            )
        }
        if let lastKnownPositive,
           lastKnownPositive.status == .published,
           !lastKnownPositive.relayURLs.isEmpty {
            return TaskifyWatchRelayDecision(
                status: .published,
                relayURLs: lastKnownPositive.relayURLs,
                eventCreatedAt: lastKnownPositive.eventCreatedAt,
                isStale: true
            )
        }
        return TaskifyWatchRelayDecision(status: .indeterminate)
    }

    private static func isPrivateLiteral(_ host: String) -> Bool {
        if host == "::" || host == "::1" || host.hasPrefix("fc") || host.hasPrefix("fd") {
            return true
        }
        if host.range(of: #"^fe[89ab]"#, options: .regularExpression) != nil { return true }
        let pieces = host.split(separator: ".").compactMap { Int($0) }
        guard pieces.count == 4 else { return false }
        let a = pieces[0]
        let b = pieces[1]
        return a == 0 || a == 10 || a == 127
            || (a == 100 && (64...127).contains(b))
            || (a == 169 && b == 254)
            || (a == 172 && (16...31).contains(b))
            || (a == 192 && b == 168)
            || a >= 224
    }
}

/// Keeps Watch relay discovery both bounded and resilient. Recipient-advertised discovery
/// relays remain highest priority, while the final query slots are reserved for Taskify's
/// interoperable defaults so stale board relays cannot prevent DM routing entirely.
public enum TaskifyWatchRelayDiscoveryPolicy {
    public static let maximumQueriedRelayCount = 8
    public static let maximumContactRelayCount = 5
    public static let minimumCompletedRelayCount = 2

    public static func prioritizedRelayURLs(
        contactRelayURLs: [String],
        contextRelayURLs: [String]
    ) -> [String] {
        let contacts = Array(
            TaskifyWatchRelayRouting.normalizedRelayURLs(contactRelayURLs)
                .prefix(maximumContactRelayCount)
        )
        return Array(
            TaskifyWatchRelayRouting.normalizedRelayURLs(
                contacts
                    + TaskifyWatchRelayRouting.defaultFallbackRelayURLs
                    + contextRelayURLs
            )
            .prefix(maximumQueriedRelayCount)
        )
    }

    public static func hasSufficientAbsenceEvidence(
        completedRelayURLs: [String],
        queriedRelayURLs: [String]
    ) -> Bool {
        let queriedAuthorities = relayAuthorities(queriedRelayURLs)
        guard !queriedAuthorities.isEmpty else { return false }
        let completedAuthorities = relayAuthorities(completedRelayURLs)
            .intersection(queriedAuthorities)
        return completedAuthorities.count >= min(
            minimumCompletedRelayCount,
            queriedAuthorities.count
        )
    }

    private static func relayAuthorities(_ relayURLs: [String]) -> Set<String> {
        Set(TaskifyWatchRelayRouting.normalizedRelayURLs(relayURLs).compactMap { value in
            guard let components = URLComponents(string: value),
                  let host = components.host?.lowercased() else { return nil }
            return components.port.map { "\(host):\($0)" } ?? host
        })
    }
}

public struct TaskifyWatchContact: Identifiable, Codable, Equatable, Sendable {
    public var id: String { publicKey }
    public let publicKey: String
    public let npub: String
    public let displayName: String
    public let avatarURL: URL?
    public let discoveryRelayURLs: [String]
    public let inboxPreferenceEvent: TaskifyWatchNostrEvent?
    public let confirmedAbsentAt: Date?

    public init(
        publicKey: String,
        npub: String,
        displayName: String,
        avatarURL: URL? = nil,
        discoveryRelayURLs: [String] = [],
        inboxPreferenceEvent: TaskifyWatchNostrEvent? = nil,
        confirmedAbsentAt: Date? = nil
    ) {
        self.publicKey = publicKey.lowercased()
        self.npub = npub
        self.displayName = displayName
        self.avatarURL = avatarURL?.scheme?.lowercased() == "https" ? avatarURL : nil
        self.discoveryRelayURLs = TaskifyWatchRelayRouting.normalizedRelayURLs(discoveryRelayURLs)
        self.inboxPreferenceEvent = inboxPreferenceEvent
        self.confirmedAbsentAt = confirmedAbsentAt
    }
}

public struct TaskifyWatchChatProvisioningContext: Codable, Equatable, Sendable {
    public let contacts: [TaskifyWatchContact]
    public let threadSummaries: [TaskifyWatchChatThreadSummary]?
    public let discoveryRelayURLs: [String]
    public let accountInboxPreferenceEvent: TaskifyWatchNostrEvent?
    public let pushRelayHTTPSURL: URL
    public let pushRelayWSSURL: String

    public init(
        contacts: [TaskifyWatchContact] = [],
        threadSummaries: [TaskifyWatchChatThreadSummary] = [],
        discoveryRelayURLs: [String],
        accountInboxPreferenceEvent: TaskifyWatchNostrEvent? = nil,
        pushRelayHTTPSURL: URL = URL(string: "https://push.solife.me")!,
        pushRelayWSSURL: String = "wss://push.solife.me"
    ) {
        self.contacts = Array(contacts.prefix(500))
        self.threadSummaries = TaskifyWatchChatProjection(
            threads: threadSummaries
        ).threads
        self.discoveryRelayURLs = TaskifyWatchRelayRouting.normalizedRelayURLs(discoveryRelayURLs)
        self.accountInboxPreferenceEvent = accountInboxPreferenceEvent
        self.pushRelayHTTPSURL = pushRelayHTTPSURL
        self.pushRelayWSSURL = pushRelayWSSURL
    }
}

public struct TaskifyWatchGroupConversation: Identifiable, Codable, Equatable, Sendable {
    public static let maximumMemberCount = 17
    public var id: String { groupID }
    public let groupID: String
    public var name: String
    public let memberPublicKeys: [String]
    public let createdAt: Int
    public var nameUpdatedAt: Int?
    public var isMuted: Bool
    public var isLeft: Bool

    public init?(
        name: String,
        memberPublicKeys: [String],
        createdAt: Int,
        nameUpdatedAt: Int? = nil,
        isMuted: Bool = false,
        isLeft: Bool = false
    ) {
        let normalized = Array(Set(memberPublicKeys.map { $0.lowercased() })).sorted()
        guard normalized.count == memberPublicKeys.count,
              (2...Self.maximumMemberCount).contains(normalized.count),
              normalized.allSatisfy(Self.isPublicKey) else { return nil }
        groupID = TaskifyWatchNIP17.groupID(memberPublicKeys: normalized)
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.memberPublicKeys = normalized
        self.createdAt = createdAt
        self.nameUpdatedAt = nameUpdatedAt
        self.isMuted = isMuted
        self.isLeft = isLeft
    }

    public var displayName: String { name.isEmpty ? "Group" : name }

    private static func isPublicKey(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy(\.isHexDigit)
    }
}

/// A bounded, paired-device-only projection of an iPhone chat thread. It contains enough
/// participant metadata and one short local preview to make the Watch inbox useful immediately,
/// but it does not carry message history, attachment keys, or any account secret.
public struct TaskifyWatchChatThreadSummary: Identifiable, Codable, Equatable, Sendable {
    public var id: String { conversationID }
    public let conversationID: String
    public let memberPublicKeys: [String]
    public let displayName: String
    public let latestPreview: String
    public let latestActivityAt: Int
    /// The phone's last-read Nostr timestamp. Optional preserves projections from earlier builds.
    public let readThrough: Int?
    public var unreadCount: Int
    public let isRequest: Bool
    public let avatarURL: URL?
    public let group: TaskifyWatchGroupConversation?

    public init?(
        conversationID: String,
        memberPublicKeys: [String],
        displayName: String,
        latestPreview: String,
        latestActivityAt: Int,
        readThrough: Int? = nil,
        unreadCount: Int,
        isRequest: Bool,
        avatarURL: URL? = nil,
        group: TaskifyWatchGroupConversation? = nil
    ) {
        let normalizedID = conversationID.lowercased()
        let members = Array(Set(memberPublicKeys.map { $0.lowercased() })).sorted()
        guard normalizedID.count == 64,
              normalizedID.allSatisfy(\.isHexDigit),
              (2...TaskifyWatchGroupConversation.maximumMemberCount).contains(members.count),
              members.allSatisfy({ $0.count == 64 && $0.allSatisfy(\.isHexDigit) }),
              group == nil || (group?.groupID == normalizedID && group?.memberPublicKeys == members)
        else { return nil }

        let normalizedName = displayName
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedPreview = latestPreview
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        self.conversationID = normalizedID
        self.memberPublicKeys = members
        self.displayName = String((normalizedName.isEmpty ? "Conversation" : normalizedName).prefix(120))
        self.latestPreview = String(normalizedPreview.prefix(180))
        self.latestActivityAt = max(0, latestActivityAt)
        self.readThrough = readThrough.map { max(0, $0) }
        self.unreadCount = max(0, unreadCount)
        self.isRequest = isRequest
        self.avatarURL = avatarURL?.scheme?.lowercased() == "https" ? avatarURL : nil
        self.group = group
    }

    public var isGroup: Bool { group != nil || memberPublicKeys.count > 2 }
}

public struct TaskifyWatchChatProjection: Codable, Equatable, Sendable {
    public static let maximumThreadCount = 100
    public static let maximumContactCount = 200
    public static let maximumTombstoneCount = 500
    public let threads: [TaskifyWatchChatThreadSummary]
    /// Optional fields preserve application contexts written by earlier builds. They contain only
    /// public routing/display state; the account private key remains reachable-only provisioning.
    public let accountPublicKey: String?
    public let contacts: [TaskifyWatchContact]?
    /// True only when `contacts` represents the complete phone directory. A truncated projection
    /// is merged on Watch so it cannot erase contacts provisioned in the reachable-only setup.
    public let contactDirectoryIsComplete: Bool?
    public let discoveryRelayURLs: [String]?
    public let pushRelayHTTPSURL: URL?
    public let pushRelayWSSURL: String?
    /// Conversations deleted on the paired iPhone. Without ongoing projections this tombstone
    /// list is the only path phone-side deletions have to the Watch cache.
    public let deletedConversationIDs: [String]?
    public let blockedPublicKeys: [String]?
    public let generatedAt: Date

    public init(
        threads: [TaskifyWatchChatThreadSummary],
        accountPublicKey: String? = nil,
        contacts: [TaskifyWatchContact]? = nil,
        contactDirectoryIsComplete: Bool? = nil,
        discoveryRelayURLs: [String]? = nil,
        pushRelayHTTPSURL: URL? = nil,
        pushRelayWSSURL: String? = nil,
        deletedConversationIDs: [String]? = nil,
        blockedPublicKeys: [String]? = nil,
        generatedAt: Date = Date()
    ) {
        var newestByID: [String: TaskifyWatchChatThreadSummary] = [:]
        for thread in threads {
            guard let current = newestByID[thread.id],
                  current.latestActivityAt > thread.latestActivityAt else {
                newestByID[thread.id] = thread
                continue
            }
        }
        self.threads = Array(newestByID.values.sorted {
            if $0.latestActivityAt != $1.latestActivityAt {
                return $0.latestActivityAt > $1.latestActivityAt
            }
            return $0.id < $1.id
        }.prefix(Self.maximumThreadCount))
        let normalizedAccount = accountPublicKey?.lowercased()
        self.accountPublicKey = normalizedAccount?.count == 64
            && normalizedAccount?.allSatisfy(\.isHexDigit) == true
            ? normalizedAccount
            : nil
        if let contacts {
            var byPublicKey: [String: TaskifyWatchContact] = [:]
            for contact in contacts where contact.publicKey.count == 64
                && contact.publicKey.allSatisfy(\.isHexDigit) {
                byPublicKey[contact.publicKey] = contact
            }
            self.contacts = Array(byPublicKey.values.sorted {
                let comparison = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
                return comparison == .orderedSame
                    ? $0.publicKey < $1.publicKey
                    : comparison == .orderedAscending
            }.prefix(Self.maximumContactCount))
            self.contactDirectoryIsComplete = contactDirectoryIsComplete
                ?? (byPublicKey.count <= Self.maximumContactCount)
        } else {
            self.contacts = nil
            self.contactDirectoryIsComplete = nil
        }
        self.discoveryRelayURLs = discoveryRelayURLs.map(
            TaskifyWatchRelayRouting.normalizedRelayURLs
        )
        self.pushRelayHTTPSURL = pushRelayHTTPSURL?.scheme?.lowercased() == "https"
            ? pushRelayHTTPSURL
            : nil
        self.pushRelayWSSURL = pushRelayWSSURL.flatMap {
            TaskifyWatchRelayRouting.normalizedRelayURLs([$0]).first
        }
        self.deletedConversationIDs = deletedConversationIDs.map { list in
            Self.normalizedTombstoneIDs(list)
        }
        self.blockedPublicKeys = blockedPublicKeys.map { list in
            Self.normalizedTombstoneIDs(list)
        }
        self.generatedAt = generatedAt
    }

    /// Lowercases, validates as 32-byte hex, deduplicates, and bounds a tombstone list. nil in →
    /// nil out preserves "this projection carries no tombstones" vs "it carries none at all".
    private static func normalizedTombstoneIDs(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var normalized: [String] = []
        for value in values {
            let key = value.lowercased()
            guard key.count == 64, key.allSatisfy(\.isHexDigit), seen.insert(key).inserted else {
                continue
            }
            normalized.append(key)
            if normalized.count == Self.maximumTombstoneCount { break }
        }
        return normalized
    }
}

public enum TaskifyWatchChatMessageKind: String, Codable, Equatable, Sendable {
    case text
    case reaction
    case photo
    case unsupportedAttachment
    case unsupportedMessage
}

public struct TaskifyWatchChatAttachment: Codable, Equatable, Sendable {
    public let url: URL
    public let mimeType: String
    public let filename: String?
    public let keyHex: String
    public let nonceHex: String
    public let ciphertextSHA256: String?
    public let size: Int?

    public init?(
        url: URL,
        mimeType: String,
        filename: String? = nil,
        keyHex: String,
        nonceHex: String,
        ciphertextSHA256: String? = nil,
        size: Int? = nil
    ) {
        guard url.scheme?.lowercased() == "https",
              keyHex.count == 64,
              nonceHex.count == 32,
              keyHex.allSatisfy(\.isHexDigit),
              nonceHex.allSatisfy(\.isHexDigit) else { return nil }
        self.url = url
        self.mimeType = mimeType.lowercased()
        self.filename = filename
        self.keyHex = keyHex.lowercased()
        self.nonceHex = nonceHex.lowercased()
        self.ciphertextSHA256 = ciphertextSHA256?.lowercased()
        self.size = size
    }

    public var isPhoto: Bool { mimeType.hasPrefix("image/") }
}

public enum TaskifyWatchChatDeliveryState: String, Codable, Equatable, Sendable {
    case queued
    case partiallySent
    case sent
    case failed
}

public struct TaskifyWatchChatMessage: Identifiable, Codable, Equatable, Sendable {
    public var id: String { rumorID }
    public let rumorID: String
    public let wrapID: String
    public let conversationID: String
    public let senderPublicKey: String
    public let memberPublicKeys: [String]
    public let content: String
    public let createdAt: Int
    public let kind: TaskifyWatchChatMessageKind
    public let replyToRumorID: String?
    public let reactionTargetRumorID: String?
    public let attachment: TaskifyWatchChatAttachment?
    public var deliveryState: TaskifyWatchChatDeliveryState?
    public var lastSubmissionError: String?

    public init(
        rumorID: String,
        wrapID: String,
        conversationID: String,
        senderPublicKey: String,
        memberPublicKeys: [String],
        content: String,
        createdAt: Int,
        kind: TaskifyWatchChatMessageKind,
        replyToRumorID: String? = nil,
        reactionTargetRumorID: String? = nil,
        attachment: TaskifyWatchChatAttachment? = nil,
        deliveryState: TaskifyWatchChatDeliveryState? = nil,
        lastSubmissionError: String? = nil
    ) {
        self.rumorID = rumorID.lowercased()
        self.wrapID = wrapID.lowercased()
        self.conversationID = conversationID.lowercased()
        self.senderPublicKey = senderPublicKey.lowercased()
        self.memberPublicKeys = memberPublicKeys.map { $0.lowercased() }.sorted()
        self.content = content
        self.createdAt = createdAt
        self.kind = kind
        self.replyToRumorID = replyToRumorID?.lowercased()
        self.reactionTargetRumorID = reactionTargetRumorID?.lowercased()
        self.attachment = attachment
        self.deliveryState = deliveryState
        self.lastSubmissionError = lastSubmissionError
    }
}

public enum TaskifyWatchRelayAcknowledgementState: String, Codable, Equatable, Sendable {
    case pending
    case accepted
    case rejected
    case authenticationRequired
}

public struct TaskifyWatchRelayAcknowledgement: Codable, Equatable, Sendable {
    public let relayURL: String
    public var state: TaskifyWatchRelayAcknowledgementState
    public var message: String?
    public var session: String?
    public var challenge: String?

    public init(
        relayURL: String,
        state: TaskifyWatchRelayAcknowledgementState = .pending,
        message: String? = nil,
        session: String? = nil,
        challenge: String? = nil
    ) {
        self.relayURL = relayURL
        self.state = state
        self.message = message
        self.session = session
        self.challenge = challenge
    }
}

public struct TaskifyWatchOutboxWrap: Identifiable, Codable, Equatable, Sendable {
    public var id: String { event.id }
    public let recipientPublicKey: String
    public var event: TaskifyWatchNostrEvent
    public var proofOfWorkPrepared: Bool? = false
    public var routingDecision: TaskifyWatchRelayDecision
    public var acknowledgements: [TaskifyWatchRelayAcknowledgement]
    public var attempts: Int
    public var nextAttemptAt: Date
    public var lastSubmissionError: String?

    public init(
        recipientPublicKey: String,
        event: TaskifyWatchNostrEvent,
        routingDecision: TaskifyWatchRelayDecision,
        acknowledgements: [TaskifyWatchRelayAcknowledgement]? = nil,
        attempts: Int = 0,
        nextAttemptAt: Date = Date(),
        lastSubmissionError: String? = nil
    ) {
        self.recipientPublicKey = recipientPublicKey.lowercased()
        self.event = event
        self.routingDecision = routingDecision
        self.acknowledgements = acknowledgements ?? routingDecision.relayURLs.map {
            TaskifyWatchRelayAcknowledgement(relayURL: $0)
        }
        self.attempts = attempts
        self.nextAttemptAt = nextAttemptAt
        self.lastSubmissionError = lastSubmissionError
    }

    public var isDelivered: Bool { acknowledgements.contains { $0.state == .accepted } }
    public var isFullyReplicated: Bool {
        !acknowledgements.isEmpty && acknowledgements.allSatisfy { $0.state == .accepted }
    }

    /// Matches a gateway result's relay string back to its acknowledgement. The gateway
    /// echoes Node/WHATWG-normalized URLs, which can differ from this Watch's Swift
    /// normalization (e.g. `wss://relay.example/?x=1` vs `wss://relay.example?x=1`); exact
    /// string matching alone would silently discard an accepted result and leave the wrap
    /// pending even though the relay holds the event.
    public func acknowledgementIndex(forResultRelay resultRelay: String) -> Int? {
        if let exact = acknowledgements.firstIndex(where: { $0.relayURL == resultRelay }) {
            return exact
        }
        guard let echoed = TaskifyWatchRelayRouting.normalizedRelayURLs([resultRelay]).first else {
            return nil
        }
        return acknowledgements.firstIndex {
            $0.relayURL == echoed
                || TaskifyWatchRelayRouting.normalizedRelayURLs([$0.relayURL]).first == echoed
        }
    }
}

public struct TaskifyWatchChatOutboxEntry: Identifiable, Codable, Equatable, Sendable {
    public var id: String { rumorID }
    public let rumorID: String
    public let conversationID: String
    public var wraps: [TaskifyWatchOutboxWrap]
    public let senderPublicKey: String
    public let createdAt: Date
    public let expiresAt: Date

    public init(
        rumorID: String,
        conversationID: String,
        wraps: [TaskifyWatchOutboxWrap],
        senderPublicKey: String,
        createdAt: Date = Date(),
        expiresAt: Date = Date().addingTimeInterval(48 * 60 * 60)
    ) {
        self.rumorID = rumorID.lowercased()
        self.conversationID = conversationID.lowercased()
        self.wraps = wraps
        self.senderPublicKey = senderPublicKey.lowercased()
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    public var areRecipientCopiesDelivered: Bool {
        let recipients = wraps.filter { $0.recipientPublicKey != senderPublicKey }
        return !recipients.isEmpty && recipients.allSatisfy(\.isDelivered)
    }

    /// The most recent gateway rejection recorded for a real recipient copy, for surfacing
    /// on the message bubble instead of the previous silent queued-forever behavior.
    public var lastSubmissionError: String? {
        wraps
            .filter { $0.recipientPublicKey != senderPublicKey }
            .compactMap(\.lastSubmissionError)
            .first
    }

    public var deliveryState: TaskifyWatchChatDeliveryState {
        deliveryState(at: Date())
    }

    public func deliveryState(at now: Date) -> TaskifyWatchChatDeliveryState {
        let recipients = wraps.filter { $0.recipientPublicKey != senderPublicKey }
        if areRecipientCopiesDelivered { return .sent }
        if recipients.contains(where: \.isDelivered) { return .partiallySent }
        if expiresAt <= now { return .failed }
        return .queued
    }
}

public struct TaskifyWatchChatSnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 2
    public var schemaVersion: Int
    public var contacts: [TaskifyWatchContact]
    public var threadSummaries: [TaskifyWatchChatThreadSummary]?
    public var groups: [TaskifyWatchGroupConversation]
    public var messages: [TaskifyWatchChatMessage]
    public var outbox: [TaskifyWatchChatOutboxEntry]
    public var cursor: String?
    public var readAt: [String: Int]
    public var blockedPublicKeys: [String]
    /// A bounded replay/deletion ledger. Message rows are pruned independently, so using only the
    /// currently visible rows for deduplication lets an older relay page resurrect deleted or
    /// expired messages after a cursor reset.
    public var processedWrapIDs: [String]
    public var processedRumorIDs: [String]
    public var generatedAt: Date

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        contacts: [TaskifyWatchContact] = [],
        threadSummaries: [TaskifyWatchChatThreadSummary] = [],
        groups: [TaskifyWatchGroupConversation] = [],
        messages: [TaskifyWatchChatMessage] = [],
        outbox: [TaskifyWatchChatOutboxEntry] = [],
        cursor: String? = nil,
        readAt: [String: Int] = [:],
        blockedPublicKeys: [String] = [],
        processedWrapIDs: [String] = [],
        processedRumorIDs: [String] = [],
        generatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.contacts = contacts
        self.threadSummaries = threadSummaries
        self.groups = groups
        self.messages = messages
        self.outbox = outbox
        self.cursor = cursor
        self.readAt = readAt
        self.blockedPublicKeys = blockedPublicKeys
        self.processedWrapIDs = processedWrapIDs
        self.processedRumorIDs = processedRumorIDs
        self.generatedAt = generatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case contacts
        case threadSummaries
        case groups
        case messages
        case outbox
        case cursor
        case readAt
        case blockedPublicKeys
        case processedWrapIDs
        case processedRumorIDs
        case generatedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        contacts = try values.decodeIfPresent([TaskifyWatchContact].self, forKey: .contacts) ?? []
        threadSummaries = try values.decodeIfPresent(
            [TaskifyWatchChatThreadSummary].self,
            forKey: .threadSummaries
        )
        groups = try values.decodeIfPresent(
            [TaskifyWatchGroupConversation].self,
            forKey: .groups
        ) ?? []
        messages = try values.decodeIfPresent(
            [TaskifyWatchChatMessage].self,
            forKey: .messages
        ) ?? []
        outbox = try values.decodeIfPresent(
            [TaskifyWatchChatOutboxEntry].self,
            forKey: .outbox
        ) ?? []
        cursor = try values.decodeIfPresent(String.self, forKey: .cursor)
        readAt = try values.decodeIfPresent([String: Int].self, forKey: .readAt) ?? [:]
        blockedPublicKeys = try values.decodeIfPresent(
            [String].self,
            forKey: .blockedPublicKeys
        ) ?? []
        processedWrapIDs = try values.decodeIfPresent(
            [String].self,
            forKey: .processedWrapIDs
        ) ?? messages.map(\.wrapID)
        processedRumorIDs = try values.decodeIfPresent(
            [String].self,
            forKey: .processedRumorIDs
        ) ?? messages.map(\.rumorID)
        generatedAt = try values.decodeIfPresent(Date.self, forKey: .generatedAt) ?? Date()
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schemaVersion, forKey: .schemaVersion)
        try values.encode(contacts, forKey: .contacts)
        try values.encodeIfPresent(threadSummaries, forKey: .threadSummaries)
        try values.encode(groups, forKey: .groups)
        try values.encode(messages, forKey: .messages)
        try values.encode(outbox, forKey: .outbox)
        try values.encodeIfPresent(cursor, forKey: .cursor)
        try values.encode(readAt, forKey: .readAt)
        try values.encode(blockedPublicKeys, forKey: .blockedPublicKeys)
        try values.encode(processedWrapIDs, forKey: .processedWrapIDs)
        try values.encode(processedRumorIDs, forKey: .processedRumorIDs)
        try values.encode(generatedAt, forKey: .generatedAt)
    }
}
