import Foundation
import TaskifyWatchShared

public enum TaskSyncState: Equatable, Sendable {
    case stopped
    case connecting
    case online
    case offline(String)
}

public enum TaskRelayPhase: String, Equatable, Sendable {
    case connecting
    case syncing
    case online
    case offline
}

public struct TaskRelayStatus: Identifiable, Equatable, Sendable {
    public var id: String { relayURL }
    public let relayURL: String
    public let phase: TaskRelayPhase
    public let message: String?

    public init(relayURL: String, phase: TaskRelayPhase, message: String? = nil) {
        self.relayURL = relayURL
        self.phase = phase
        self.message = message
    }
}

public struct TaskSyncReport: Equatable, Sendable {
    public let state: TaskSyncState
    public let relays: [TaskRelayStatus]
    public let queuedChangeCount: Int

    public init(relays: [TaskRelayStatus], queuedChangeCount: Int) {
        self.relays = relays.sorted { $0.relayURL < $1.relayURL }
        self.queuedChangeCount = queuedChangeCount
        state = Self.aggregateState(for: relays)
    }

    public init(state: TaskSyncState, relays: [TaskRelayStatus], queuedChangeCount: Int) {
        self.state = state
        self.relays = relays.sorted { $0.relayURL < $1.relayURL }
        self.queuedChangeCount = queuedChangeCount
    }

    public static func aggregateState(for relays: [TaskRelayStatus]) -> TaskSyncState {
        if relays.contains(where: { $0.phase == .online }) {
            return .online
        }
        if relays.contains(where: { $0.phase == .connecting || $0.phase == .syncing }) {
            return .connecting
        }
        let message = relays.compactMap(\.message).first
            ?? (relays.isEmpty ? "No relays are configured." : "No relay is currently available.")
        return .offline(message)
    }
}

/// One queued outbox entry, for the settings screen's queue diagnostics. Carries routing
/// metadata only — never event content.
public struct TaskPendingOutboxRecord: Identifiable, Equatable, Sendable {
    public let id: String
    public let recordID: String
    public let outboxScope: String
    public let pendingRelayURLs: [String]
    public let acceptedRelayCount: Int
    public let eventKind: Int
    public let relayRejections: [String: RelayRejectionBackoff]
    public let queuedAt: Date
    public let dependsOnEventID: String?

    public init(
        id: String,
        recordID: String,
        outboxScope: String,
        pendingRelayURLs: [String],
        acceptedRelayCount: Int,
        queuedAt: Date,
        dependsOnEventID: String? = nil,
        eventKind: Int = 0,
        relayRejections: [String: RelayRejectionBackoff] = [:]
    ) {
        self.id = id
        self.recordID = recordID
        self.outboxScope = outboxScope
        self.pendingRelayURLs = pendingRelayURLs
        self.acceptedRelayCount = acceptedRelayCount
        self.eventKind = eventKind
        self.relayRejections = relayRejections
        self.queuedAt = queuedAt
        self.dependsOnEventID = dependsOnEventID
    }
}

public struct TaskSyncPublishRequest: Sendable {
    public let event: NostrEvent
    public let board: Board
    public let taskID: String

    public init(event: NostrEvent, board: Board, taskID: String) {
        self.event = event
        self.board = board
        self.taskID = taskID
    }
}

public struct TaskSyncRelayPublishRequest: Sendable {
    public let event: NostrEvent
    public let relayURLs: [String]
    public let outboxScope: String
    public let recordID: String
    public let acknowledgementPolicy: NostrOutboxAcknowledgementPolicy
    public let expiresAt: Date?
    public let dependsOnEventID: String?

    public init(
        event: NostrEvent,
        relayURLs: [String],
        outboxScope: String,
        recordID: String,
        acknowledgementPolicy: NostrOutboxAcknowledgementPolicy = .everyRelay,
        expiresAt: Date? = nil,
        dependsOnEventID: String? = nil
    ) {
        self.event = event
        self.relayURLs = TaskifyRelayURL.normalizedList(relayURLs)
        self.outboxScope = outboxScope
        self.recordID = recordID
        self.acknowledgementPolicy = acknowledgementPolicy
        self.expiresAt = expiresAt
        self.dependsOnEventID = dependsOnEventID
    }
}

public enum TaskPublishDeliveryState: Equatable, Sendable {
    case queued
    case sent
    case failed(String)
}

public enum TaskSyncUpdate: Sendable {
    case board(BoardRelayRecord)
    case task(TaskRelayRecord)
    case calendarEvent(TaskifyCalendarRelayRecord)
    /// A relay's whole stored-event backlog, delivered in one piece. Initial sync replays the
    /// account's entire history, and handing those over one-at-a-time made the consumer redo an
    /// O(all tasks) merge and a full view invalidation per event.
    case batch(tasks: [TaskRelayRecord], calendarEvents: [TaskifyCalendarRelayRecord])
    case sharedInbox(NostrEvent)
    /// Stored NIP-17 events are forwarded as they arrive, before EOSE. The consumer coalesces
    /// these into bounded crypto batches and gives live arrivals priority over recovery.
    case sharedInboxBatch([NostrEvent])
    case publishState(recordID: String, state: TaskPublishDeliveryState)
    case status(TaskSyncReport)
}

struct TaskRelayStartupBatch: Sendable {
    private var recordsByTaskID: [String: TaskRelayRecord] = [:]
    private var calendarRecordsByEventID: [String: TaskifyCalendarRelayRecord] = [:]
    private var sharedInboxEventsByID: [String: NostrEvent] = [:]

    mutating func insert(_ record: TaskRelayRecord) {
        let existingClock = recordsByTaskID[record.task.id]?.eventCreatedAt ?? 0
        if record.eventCreatedAt >= existingClock {
            recordsByTaskID[record.task.id] = record
        }
    }

    mutating func drain() -> [TaskRelayRecord] {
        let records = recordsByTaskID.values.sorted {
            if $0.eventCreatedAt != $1.eventCreatedAt {
                return $0.eventCreatedAt < $1.eventCreatedAt
            }
            return $0.task.id < $1.task.id
        }
        recordsByTaskID.removeAll()
        return records
    }

    mutating func insert(_ record: TaskifyCalendarRelayRecord) {
        let existingClock = calendarRecordsByEventID[record.event.id]?.eventCreatedAt ?? 0
        if record.eventCreatedAt >= existingClock {
            calendarRecordsByEventID[record.event.id] = record
        }
    }

    mutating func drainCalendarEvents() -> [TaskifyCalendarRelayRecord] {
        let records = calendarRecordsByEventID.values.sorted {
            if $0.eventCreatedAt != $1.eventCreatedAt {
                return $0.eventCreatedAt < $1.eventCreatedAt
            }
            return $0.event.id < $1.event.id
        }
        calendarRecordsByEventID.removeAll()
        return records
    }

    mutating func insert(sharedInboxEvent event: NostrEvent) {
        sharedInboxEventsByID[event.id] = event
    }

    mutating func drainSharedInboxEvents() -> [NostrEvent] {
        let events = sharedInboxEventsByID.values.sorted {
            if $0.createdAt != $1.createdAt {
                return $0.createdAt < $1.createdAt
            }
            return $0.id < $1.id
        }
        sharedInboxEventsByID.removeAll()
        return events
    }
}

// NIP-11 does not advertise publish throughput, and public relays throttle or ban per IP, so
// each relay gets a proactive budget (a burst, then a steady refill) rather than discovering its
// limit by being rejected. On top of that, the pace adapts when NIP-01 reports `rate-limited:`.
struct RelayPublishPacer: Equatable, Sendable {
    /// Relays Taskify operates, matching the runtime's `FIRST_PARTY_RELAYS`. They get a generous
    /// budget so a large change (a 60-task template) lands there in seconds; clients read from
    /// every relay, so it appears quickly while public relays receive it at their pace.
    static let firstPartyRelayURLs: Set<String> = TaskifyFirstPartyRelays.urls

    /// Public relays: a burst of 8, then one event every 7.5 s — the strictest documented limit
    /// we know of (noteguard's example of 8 events/minute per IP). First-party: 100, then 10/s.
    static func forRelay(_ relayURL: String) -> RelayPublishPacer {
        let normalized = TaskifyRelayURL.normalize(relayURL) ?? relayURL
        return firstPartyRelayURLs.contains(normalized)
            ? RelayPublishPacer(burst: 100, refillInterval: 0.1)
            : RelayPublishPacer()
    }

    let defaultInterval: TimeInterval
    let baseBackoff: TimeInterval
    let maximumBackoff: TimeInterval
    let burst: Int
    let refillInterval: TimeInterval
    private(set) var currentInterval: TimeInterval
    private(set) var nextPublishAt: TimeInterval = 0
    private(set) var consecutiveRateLimits = 0
    private var acceptedSinceRateLimit = 0
    private var tokens: Int
    private var tokensUpdatedAt: TimeInterval?

    init(
        defaultInterval: TimeInterval = 0.05,
        baseBackoff: TimeInterval = 2,
        maximumBackoff: TimeInterval = 30,
        burst: Int = 8,
        refillInterval: TimeInterval = 7.5
    ) {
        self.defaultInterval = defaultInterval
        self.baseBackoff = baseBackoff
        self.maximumBackoff = maximumBackoff
        self.burst = max(1, burst)
        self.refillInterval = max(0.001, refillInterval)
        currentInterval = defaultInterval
        tokens = max(1, burst)
    }

    private func refilledTokens(at now: TimeInterval) -> (tokens: Int, updatedAt: TimeInterval) {
        guard let updatedAt = tokensUpdatedAt else { return (tokens, now) }
        let refilled = Int(((now - updatedAt) / refillInterval).rounded(.down))
        guard refilled > 0 else { return (tokens, updatedAt) }
        let next = min(burst, tokens + refilled)
        return (next, next >= burst ? now : updatedAt + Double(refilled) * refillInterval)
    }

    func delayBeforePublish(at now: TimeInterval) -> TimeInterval {
        let spacing = max(0, nextPublishAt - now)
        let bucket = refilledTokens(at: now)
        let budget = bucket.tokens > 0 ? 0 : max(0, bucket.updatedAt + refillInterval - now)
        return max(spacing, budget)
    }

    mutating func recordPublish(at now: TimeInterval) {
        let bucket = refilledTokens(at: now)
        tokens = max(0, bucket.tokens - 1)
        tokensUpdatedAt = bucket.updatedAt
        nextPublishAt = max(now, nextPublishAt) + currentInterval
    }

    @discardableResult
    mutating func recordRateLimit(at now: TimeInterval) -> TimeInterval {
        consecutiveRateLimits += 1
        acceptedSinceRateLimit = 0
        currentInterval = min(max(currentInterval * 2, 0.1), 1)
        let multiplier = pow(2, Double(max(0, consecutiveRateLimits - 1)))
        let backoff = min(baseBackoff * multiplier, maximumBackoff)
        nextPublishAt = max(nextPublishAt, now + backoff)
        return delayBeforePublish(at: now)
    }

    mutating func recordAccepted() {
        guard currentInterval > defaultInterval || consecutiveRateLimits > 0 else { return }
        acceptedSinceRateLimit += 1
        guard acceptedSinceRateLimit >= 8 else { return }
        currentInterval = max(defaultInterval, currentInterval * 0.75)
        consecutiveRateLimits = max(0, consecutiveRateLimits - 1)
        acceptedSinceRateLimit = 0
    }
}

/// Favors current state while reserving regular capacity for older durable work. `entries` must
/// be newest-first; selected entries are removed so one drain never schedules the same event twice.
struct RelayOutboxScheduler: Equatable, Sendable {
    let freshBurstLimit: Int
    private(set) var consecutiveFreshSelections = 0

    init(freshBurstLimit: Int = 3) {
        self.freshBurstLimit = max(1, freshBurstLimit)
    }

    mutating func next(from entries: inout [NostrOutboxEntry]) -> NostrOutboxEntry? {
        guard !entries.isEmpty else { return nil }
        if consecutiveFreshSelections >= freshBurstLimit, entries.count > 1 {
            consecutiveFreshSelections = 0
            return entries.removeLast()
        }
        consecutiveFreshSelections += 1
        return entries.removeFirst()
    }
}

enum NostrRelayRejection {
    enum Kind: Equatable {
        /// Refused outright (`blocked:`, `restricted:`, `invalid:`): don't resend it there soon.
        case refused
        /// Anything else (`error:`, `pow:`, a false `duplicate:`, unknown): retry as usual. Only a
        /// true acceptance confirms delivery (nostr-sync-audit-2026-09-03).
        case transient
    }

    /// The relay already holds something at least as new as this event: a NIP-09 deletion that
    /// covers it (strfry: `deleted: user requested deletion`) or a newer version of the same
    /// address (`replaced: have newer event`). It will never accept the event, and has no need
    /// to, so this relay counts as done with it. A false `duplicate:` still retries.
    static func isSuperseded(_ message: String) -> Bool {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return text.hasPrefix("deleted:") || text.hasPrefix("replaced:")
    }

    static func isRateLimited(_ message: String) -> Bool {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // noteguard documents "rate-limit: …" rather than NIP-01's "rate-limited:".
        return text.hasPrefix("rate-limited:") || text.hasPrefix("rate-limit:")
    }

    static func kind(of message: String) -> Kind {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.hasPrefix("blocked:") || text.hasPrefix("restricted:") || text.hasPrefix("invalid:") {
            return .refused
        }
        return .transient
    }

    /// NIP-42: relay is refusing an action until the client authenticates via `AUTH`.
    static func isAuthRequired(_ message: String) -> Bool {
        message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix("auth-required:")
    }
}

/// One board's filter within a grouped board subscription.
public struct BoardSubscriptionFilter: Equatable, Sendable {
    public let boardTag: String
    public let since: Int?

    public init(boardTag: String, since: Int?) {
        self.boardTag = boardTag
        self.since = since
    }
}

/// Splits a relay's boards into a few REQs instead of one each. Relays cap concurrent REQs per
/// connection (strfry refuses the excess with "too many concurrent REQs", leaving those boards
/// unsynced there), and an account with compound boards easily has dozens. Groups are chunks of
/// the sorted tags, so adding or removing a board only re-issues the groups whose membership
/// changed, and each board keeps its own history cursor, so a re-issued group replays nothing old.
struct BoardSubscriptionGrouping: Equatable, Sendable {
    static let boardsPerSubscription = 10

    struct Group: Equatable, Sendable {
        let id: String
        let boardTags: [String]
    }

    let groups: [Group]
    private let groupIDByBoardTag: [String: String]

    init(relayURL: String, boardTags: some Sequence<String>) {
        let sorted = Array(Set(boardTags)).sorted()
        let relayToken = UInt(bitPattern: relayURL.hashValue)
        var groups: [Group] = []
        var index = 0
        while index < sorted.count {
            let members = Array(sorted[index..<min(index + Self.boardsPerSubscription, sorted.count)])
            let membershipToken = UInt(bitPattern: members.joined(separator: ",").hashValue)
            groups.append(Group(id: "taskify-\(relayToken)-g\(membershipToken)", boardTags: members))
            index += Self.boardsPerSubscription
        }
        self.groups = groups
        var groupIDByBoardTag: [String: String] = [:]
        for group in groups {
            for tag in group.boardTags { groupIDByBoardTag[tag] = group.id }
        }
        self.groupIDByBoardTag = groupIDByBoardTag
    }

    func groupID(for boardTag: String) -> String? { groupIDByBoardTag[boardTag] }
    func group(withID id: String) -> Group? { groups.first { $0.id == id } }
}

struct TaskSyncRelaySubscriptionPlan: Equatable, Sendable {
    let relayURL: String
    let boardTags: [String]
    let inboxPublicKey: String?
}

/// The parts of a sync configuration that change relay subscriptions. Board names, columns,
/// clocks, and ordering still refresh the engine's local decode state, but should not cause every
/// relay to replay its stored history again.
struct TaskSyncConfigurationFingerprint: Equatable, Sendable {
    let relayPlans: [TaskSyncRelaySubscriptionPlan]

    init(
        boards: [Board],
        auxiliaryRelayURLs: [String],
        inboxPublicKey: String?,
        inboxRelayURLs: [String]? = nil,
        excludedRelayURLs: Set<String> = []
    ) {
        let normalizedAuxiliaryRelays = TaskifyRelayURL.normalizedList(auxiliaryRelayURLs)
        let normalizedInboxRelays = inboxRelayURLs.map(TaskifyRelayURL.normalizedList)
        let normalizedInboxPublicKey = inboxPublicKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let excludedRelays = Set(TaskifyRelayURL.normalizedList(Array(excludedRelayURLs)))
        let wantedRelays = Set(
            boards.flatMap(\.effectiveRelayURLs)
                + normalizedAuxiliaryRelays
                + (normalizedInboxRelays ?? [])
        ).subtracting(excludedRelays)
        let inboxRelays = Set(normalizedInboxRelays ?? Array(wantedRelays))
        relayPlans = wantedRelays.map { relayURL in
            let boardTags = Set<String>(
                boards.compactMap { board -> String? in
                    guard board.effectiveRelayURLs.contains(relayURL) else { return nil }
                    return BoardCrypto.boardTag(for: board.effectiveNostrBoardID)
                }
            ).sorted()
            return TaskSyncRelaySubscriptionPlan(
                relayURL: relayURL,
                boardTags: boardTags,
                inboxPublicKey: inboxRelays.contains(relayURL)
                    ? normalizedInboxPublicKey
                    : nil
            )
        }.sorted { $0.relayURL < $1.relayURL }
    }
}

/// Sending a WebSocket frame only queues it locally. Keep backing off until the relay
/// actually responds; otherwise an unavailable relay can replay history once per second.
struct RelayRetryBackoff: Sendable {
    private var attempt = 0

    mutating func nextDelay() -> Int {
        let delay = min(1 << attempt, 30)
        attempt = min(attempt + 1, 5)
        return delay
    }
}

/// Allows transport scheduling to be exercised with suspended sends and relay replies without
/// opening network sockets. The production implementation remains NostrRelayConnection.
protocol TaskSyncRelayTransport: AnyObject, Sendable {
    func messages() -> AsyncStream<NostrRelayMessage>
    func connect() async throws
    func disconnect() async
    func isResponsive(timeout: Duration) async -> Bool
    func subscribe(
        id: String,
        kinds: [Int],
        boards: [BoardSubscriptionFilter],
        limit: Int
    ) async throws
    func subscribeToSharedInbox(id: String, recipientPublicKey: String, since: Int, limit: Int) async throws
    func closeSubscription(id: String) async throws
    func publish(_ event: NostrEvent) async throws
    func authenticate(_ event: NostrEvent) async throws
    func request(id: String, filter: NostrRelayFilter) async throws
}

extension TaskSyncRelayTransport {
    /// Transports that can't run arbitrary filters report failure, so the engine falls back to a
    /// fresh connection for that relay.
    func request(id: String, filter: NostrRelayFilter) async throws {
        throw URLError(.unsupportedURL)
    }
}

extension NostrRelayConnection: TaskSyncRelayTransport {}

public actor TaskSyncEngine {
    /// Four unacknowledged events keep a healthy relay busy without allowing a slow or silent
    /// relay to absorb the whole durable queue at once.
    private static let maximumInFlightPublishesPerRelay = 4
    /// How long a relay may go silent after a publish before the connection is presumed dead.
    /// Measured: relay.solife.me occasionally takes ~30 s to acknowledge under load.
    private let publishAcknowledgementTimeout: Duration
    /// Once another relay has stored an event, keep trying lagging replicas for a week. This is
    /// long enough for ordinary outages without allowing a dead configured relay to retain every
    /// historical mutation forever.
    private static let replicaRetryRetention: TimeInterval = 7 * 24 * 60 * 60
    /// Slack applied when resuming a subscription from its newest observed event, covering
    /// clock skew and events whose relay accepted them out of order.
    private static let replaySinceSkewSeconds = 60
    /// NIP-17 envelopes deliberately backdate each new message by up to two days.
    private static let inboxTimestampRandomizationSeconds = 2 * 24 * 60 * 60
    /// An EVENT/EOSE arriving at least this long after the REQ was issued proves the
    /// subscription is stably up, and resets its CLOSED-retry escalation. Delivery arriving
    /// sooner says nothing: a relay that accepts and immediately closes a subscription would
    /// otherwise defeat the backoff by rearming it to 1 s on every replay.
    private static let subscriptionStabilityInterval: TimeInterval = 60

    private let outbox: NostrOutboxStore
    private let connectionFactory: @Sendable (String) -> any TaskSyncRelayTransport
    let oneShotFallback: any NostrOneShotFetching
    struct OneShotRequest {
        let relayURL: String
        var events: [NostrEvent]
        /// The relay ended its stored events (EOSE), rather than closing the request or going quiet.
        var completed = false
        let continuation: CheckedContinuation<OneShotResult, Error>
    }

    struct OneShotResult {
        var events: [NostrEvent]
        var completed: Bool
    }
    private var outboxAuditRunning = false
    var oneShotRequests: [String: OneShotRequest] = [:]
    /// Features add their relays to the auxiliary list only while publishing, and the next
    /// routine reconfigure drops them. Relays requested within this window stay connected, so a
    /// publish doesn't cost a connect/disconnect cycle (and one-shot lookups can reuse them).
    private let auxiliaryRelayLinger: TimeInterval
    private var auxiliaryRelayLastRequestedAt: [String: Date] = [:]
    private var auxiliaryLingerTask: Task<Void, Never>?
    private var lastConfigureRequest: (
        boards: [Board],
        auxiliaryRelayURLs: [String],
        inboxPublicKey: String?,
        inboxRelayURLs: [String]?,
        excludedRelayURLs: Set<String>
    )?
    private let updateStream: AsyncStream<TaskSyncUpdate>
    private let updateContinuation: AsyncStream<TaskSyncUpdate>.Continuation
    private var boards: [Board] = [] {
        didSet { boardGroupingCache.removeAll() }
    }
    private var boardGroupingCache: [String: BoardSubscriptionGrouping] = [:]
    private var auxiliaryRelayURLs: [String] = []
    private var inboxPublicKey: String?
    private var inboxRelayURLs: Set<String> = []
    var connections: [String: any TaskSyncRelayTransport] = [:]
    private var listenerTasks: [String: Task<Void, Never>] = [:]
    private var reconnectTasks: [String: Task<Void, Never>] = [:]
    private var reconnectBackoffs: [String: RelayRetryBackoff] = [:]
    private var pendingSubscriptions: [String: Set<String>] = [:]
    private var startupBatchFlushTask: Task<Void, Never>?
    private var incompleteHistoryNewest: [String: Int] = [:]
    private var relayBatches: [String: [String: TaskRelayStartupBatch]] = [:]
    var relayPhases: [String: TaskRelayPhase] = [:]
    private var relayMessages: [String: String] = [:]
    private var publishPacers: [String: RelayPublishPacer] = [:]
    private var outboxSchedulers: [String: RelayOutboxScheduler] = [:]
    private var publishAcknowledgementTimeoutTasks: [String: [String: Task<Void, Never>]] = [:]
    /// When each relay last delivered a message. Messages are handled one at a time, so an
    /// acknowledgement waits behind everything the relay sent before it (a full history replay
    /// after reconnecting can take longer than the timeout); a relay still talking is not dead.
    private var lastInboundActivity: [String: ContinuousClock.Instant] = [:]
    /// A relay rejection applies to one EVENT, not its whole WebSocket. Skip that event until the
    /// next reconnect while allowing newer valid work to continue through the same relay.
    private var deferredRejectedEventIDs: [String: Set<String>] = [:]
    private var rateLimitRetryTasks: [String: Task<Void, Never>] = [:]
    // CLOSED applies to one REQ. Retrying all subscriptions replays healthy chat/board
    // histories whenever an unrelated subscription is rejected.
    private var subscriptionRetryTasks: [String: Task<Void, Never>] = [:]
    private var subscriptionRetryBackoffs: [String: RelayRetryBackoff] = [:]
    /// Consecutive CLOSED replies per relay+subscription and when its REQ was last issued.
    /// A relay that accepts a resubscribe and immediately closes it again would otherwise
    /// reset the retry backoff on the next EVENT and loop a full-window replay every second.
    private var subscriptionConsecutiveCloses: [String: Int] = [:]
    private var subscriptionLastIssuedAt: [String: Date] = [:]
    /// Newest event timestamp observed per relay+subscription. Resubscribes and reconnects
    /// resume from it instead of replaying each subscription's whole stored window.
    private var newestEventCreatedAtBySubscription: [String: Int] = [:]
    // NIP-42 authentication state, keyed by relayURL.
    private var identity: NostrIdentity?
    private var relayAuthChallenges: [String: String] = [:]
    /// Relays that refused this client's NIP-42 AUTH (strfry without `serviceUrl` answers every
    /// AUTH with "relay needs serviceUrl to be configured"), and until when to stop offering it.
    /// Such a relay still serves everything that doesn't need auth; only the subscriptions that
    /// do (a private inbox) go without it there.
    private var relayAuthUnavailableUntil: [String: Date] = [:]
    private static let relayAuthRetryInterval: TimeInterval = 6 * 60 * 60

    private func isRelayAuthUnavailable(_ relayURL: String, now: Date = Date()) -> Bool {
        (relayAuthUnavailableUntil[relayURL] ?? .distantPast) > now
    }
    private var relayAuthTimeoutTasks: [String: Task<Void, Never>] = [:]
    private var relayAuthEventIDs: [String: String] = [:]
    private var pendingAuthResubscriptions: [String: Set<String>] = [:]
    private var activeRelayDrains: Set<String> = []
    private var requestedRelayDrains: Set<String> = []
    private var inFlightEventIDs: [String: Set<String>] = [:]
    private var verifiedEventCreatedAt: [String: Int] = [:]
    private var deliveredSharedInboxEventIDs: Set<String> = []
    private var deliveredSharedInboxEventIDOrder: [String] = []
    // The same board/task/calendar event is stored on every relay the board syncs to, so an
    // account on N relays receives N copies of each event. Without this, every copy was handed
    // to the app and merged again — N times the work for one change.
    private var deliveredEventIDs: Set<String> = []
    private var deliveredEventIDOrder: [String] = []
    private var configurationFingerprint: TaskSyncConfigurationFingerprint?
    // Device-local relays the user removed from the sync list. The engine never connects to,
    // publishes to, or waits on them; board relay lists are untouched.
    private var excludedRelayURLs: Set<String> = []
    private var isCheckingForegroundRelayHealth = false
    private var scheduledOutboxFlushTask: Task<Void, Never>?
    private var outboxFlushRequested = false
    private var scheduledRelayOutboxFlushTasks: [String: Task<Void, Never>] = [:]
    private var scheduledRelayOutboxFlushRequests: Set<String> = []
    private var lastEmittedReport: TaskSyncReport?

    public init(outbox: NostrOutboxStore = NostrOutboxStore()) {
        self.init(outbox: outbox, connectionFactory: { NostrRelayConnection(relayURL: $0, automaticallyAuthenticate: false) })
    }

    init(
        outbox: NostrOutboxStore,
        connectionFactory: @escaping @Sendable (String) -> any TaskSyncRelayTransport,
        oneShotFallback: any NostrOneShotFetching = NostrFreshConnectionFetcher(),
        auxiliaryRelayLinger: TimeInterval = 300,
        publishAcknowledgementTimeout: Duration = .seconds(45)
    ) {
        self.outbox = outbox
        self.publishAcknowledgementTimeout = publishAcknowledgementTimeout
        self.connectionFactory = connectionFactory
        self.oneShotFallback = oneShotFallback
        self.auxiliaryRelayLinger = auxiliaryRelayLinger
        let pair = AsyncStream.makeStream(
            of: TaskSyncUpdate.self,
            // Dropping an update after recording its event ID loses it for the rest of this
            // connection. A slow snapshot merge must not discard incoming messages.
            bufferingPolicy: .unbounded
        )
        updateStream = pair.stream
        updateContinuation = pair.continuation
    }

    deinit {
        relayAuthTimeoutTasks.values.forEach { $0.cancel() }
        startupBatchFlushTask?.cancel()
        listenerTasks.values.forEach { $0.cancel() }
        reconnectTasks.values.forEach { $0.cancel() }
        rateLimitRetryTasks.values.forEach { $0.cancel() }
        publishAcknowledgementTimeoutTasks.values
            .flatMap(\.values)
            .forEach { $0.cancel() }
        subscriptionRetryTasks.values.forEach { $0.cancel() }
        scheduledOutboxFlushTask?.cancel()
        scheduledRelayOutboxFlushTasks.values.forEach { $0.cancel() }
        updateContinuation.finish()
    }

    public nonisolated func updates() -> AsyncStream<TaskSyncUpdate> {
        updateStream
    }

    /// The identity used to sign NIP-42 `AUTH` responses. Relays that never challenge us never
    /// need this; relays that do get an exemption from tighter rate limits once authenticated.
    public func setIdentity(_ identity: NostrIdentity?) async {
        self.identity = identity
        await NostrRelayAuthentication.shared.setIdentity(identity)
    }

    /// Re-applies the last configuration once a lingering auxiliary relay's time is up.
    private func scheduleAuxiliaryLingerExpiry(now: Date) {
        auxiliaryLingerTask?.cancel()
        guard let earliest = auxiliaryRelayLastRequestedAt.values.min() else { return }
        let delay = max(0.05, earliest.addingTimeInterval(auxiliaryRelayLinger).timeIntervalSince(now))
        auxiliaryLingerTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.reapplyConfigurationAfterLinger()
        }
    }

    private func reapplyConfigurationAfterLinger() async {
        guard let request = lastConfigureRequest else { return }
        await configure(
            boards: request.boards,
            auxiliaryRelayURLs: request.auxiliaryRelayURLs,
            inboxPublicKey: request.inboxPublicKey,
            inboxRelayURLs: request.inboxRelayURLs,
            excludedRelayURLs: request.excludedRelayURLs
        )
    }

    public func configure(
        boards: [Board],
        auxiliaryRelayURLs: [String] = [],
        inboxPublicKey: String? = nil,
        inboxRelayURLs: [String]? = nil,
        excludedRelayURLs: Set<String> = []
    ) async {
        lastConfigureRequest = (boards, auxiliaryRelayURLs, inboxPublicKey, inboxRelayURLs, excludedRelayURLs)
        let now = Date()
        for relayURL in TaskifyRelayURL.normalizedList(auxiliaryRelayURLs) {
            auxiliaryRelayLastRequestedAt[relayURL] = now
        }
        auxiliaryRelayLastRequestedAt = auxiliaryRelayLastRequestedAt.filter {
            now.timeIntervalSince($0.value) < auxiliaryRelayLinger
        }
        let auxiliaryRelayURLs = auxiliaryRelayLastRequestedAt.keys.sorted()
        scheduleAuxiliaryLingerExpiry(now: now)
        let normalizedExcludedRelayURLs = Set(
            TaskifyRelayURL.normalizedList(Array(excludedRelayURLs))
        )
        let excludedRelaysChanged = normalizedExcludedRelayURLs != self.excludedRelayURLs
        self.excludedRelayURLs = normalizedExcludedRelayURLs
        let fingerprint = TaskSyncConfigurationFingerprint(
            boards: boards,
            auxiliaryRelayURLs: auxiliaryRelayURLs,
            inboxPublicKey: inboxPublicKey,
            inboxRelayURLs: inboxRelayURLs,
            excludedRelayURLs: normalizedExcludedRelayURLs
        )
        let previousFingerprint = configurationFingerprint
        let subscriptionsAreUnchanged = fingerprint == previousFingerprint
        configurationFingerprint = fingerprint
        self.boards = boards
        self.auxiliaryRelayURLs = TaskifyRelayURL.normalizedList(auxiliaryRelayURLs)
        let normalizedInboxRelayURLs = inboxRelayURLs.map(TaskifyRelayURL.normalizedList)
        let normalizedInboxPublicKey = inboxPublicKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if normalizedInboxPublicKey != self.inboxPublicKey {
            verifiedEventCreatedAt.removeAll()
            deliveredSharedInboxEventIDs.removeAll()
            deliveredSharedInboxEventIDOrder.removeAll()
            deliveredEventIDs.removeAll()
            deliveredEventIDOrder.removeAll()
        }
        self.inboxPublicKey = normalizedInboxPublicKey
        guard !subscriptionsAreUnchanged else { return }
        if excludedRelaysChanged {
            // Queued changes that only waited on the newly excluded relays would otherwise sit in
            // the change queue forever.
            await stripExcludedRelayTargets()
        }
        let previousPlans = Dictionary(
            uniqueKeysWithValues: (previousFingerprint?.relayPlans ?? []).map {
                ($0.relayURL, $0)
            }
        )
        let nextPlans = Dictionary(
            uniqueKeysWithValues: fingerprint.relayPlans.map { ($0.relayURL, $0) }
        )
        let wantedRelays = Set(
            self.boards.flatMap(\.effectiveRelayURLs)
                + self.auxiliaryRelayURLs
                + (normalizedInboxRelayURLs ?? [])
        ).subtracting(self.excludedRelayURLs)
        self.inboxRelayURLs = Set(normalizedInboxRelayURLs ?? Array(wantedRelays))

        for relayURL in Set(connections.keys).subtracting(wantedRelays) {
            flushStartupBatches(relayURL: relayURL)
            listenerTasks.removeValue(forKey: relayURL)?.cancel()
            reconnectTasks.removeValue(forKey: relayURL)?.cancel()
            rateLimitRetryTasks.removeValue(forKey: relayURL)?.cancel()
            reconnectBackoffs.removeValue(forKey: relayURL)
            pendingSubscriptions.removeValue(forKey: relayURL)
            relayBatches.removeValue(forKey: relayURL)
            relayPhases.removeValue(forKey: relayURL)
            relayMessages.removeValue(forKey: relayURL)
            publishPacers.removeValue(forKey: relayURL)
            outboxSchedulers.removeValue(forKey: relayURL)
            cancelPublishAcknowledgementTimeouts(relayURL: relayURL)
            deferredRejectedEventIDs.removeValue(forKey: relayURL)
            requestedRelayDrains.remove(relayURL)
            scheduledRelayOutboxFlushTasks.removeValue(forKey: relayURL)?.cancel()
            scheduledRelayOutboxFlushRequests.remove(relayURL)
            inFlightEventIDs.removeValue(forKey: relayURL)
            relayAuthChallenges.removeValue(forKey: relayURL)
            relayAuthTimeoutTasks.removeValue(forKey: relayURL)?.cancel()
            relayAuthEventIDs.removeValue(forKey: relayURL)
            pendingAuthResubscriptions.removeValue(forKey: relayURL)
            for key in Set(subscriptionRetryTasks.keys)
                .union(subscriptionRetryBackoffs.keys)
                .union(subscriptionConsecutiveCloses.keys)
                .union(subscriptionLastIssuedAt.keys)
                where key.hasPrefix("\(relayURL)#") {
                subscriptionRetryTasks.removeValue(forKey: key)?.cancel()
                subscriptionRetryBackoffs.removeValue(forKey: key)
                subscriptionConsecutiveCloses.removeValue(forKey: key)
                subscriptionLastIssuedAt.removeValue(forKey: key)
            }
            if let connection = connections.removeValue(forKey: relayURL) {
                await connection.disconnect()
            }
        }

        var newlyCreatedRelays: Set<String> = []
        for relayURL in wantedRelays where connections[relayURL] == nil {
            let connection = connectionFactory(relayURL)
            connections[relayURL] = connection
            newlyCreatedRelays.insert(relayURL)
            let stream = connection.messages()
            listenerTasks[relayURL] = Task { [weak self] in
                for await message in stream {
                    guard !Task.isCancelled else { return }
                    await self?.handle(message, from: relayURL)
                }
            }
        }

        let changedRelays = wantedRelays.filter { relayURL in
            newlyCreatedRelays.contains(relayURL) || previousPlans[relayURL] != nextPlans[relayURL]
        }
        for relayURL in changedRelays {
            relayPhases[relayURL] = .connecting
            relayMessages[relayURL] = nil
        }
        await emitStatus()

        for relayURL in changedRelays.sorted() {
            guard let connection = connections[relayURL],
                  let nextPlan = nextPlans[relayURL] else { continue }
            do {
                try await reconcileSubscriptions(
                    connection,
                    relayURL: relayURL,
                    previousPlan: newlyCreatedRelays.contains(relayURL)
                        ? nil
                        : previousPlans[relayURL],
                    nextPlan: nextPlan
                )
                if relayPhases[relayURL] != .online {
                    relayPhases[relayURL] = .syncing
                }
                relayMessages[relayURL] = nil
            } catch {
                relayPhases[relayURL] = .offline
                relayMessages[relayURL] = error.localizedDescription
                scheduleReconnect(relayURL: relayURL)
            }
        }
        scheduleOutboxFlush()
        await emitStatus()
    }

    private func reconcileSubscriptions(
        _ connection: any TaskSyncRelayTransport,
        relayURL: String,
        previousPlan: TaskSyncRelaySubscriptionPlan?,
        nextPlan: TaskSyncRelaySubscriptionPlan
    ) async throws {
        try await connection.connect()
        let previousGroups = BoardSubscriptionGrouping(relayURL: relayURL, boardTags: previousPlan?.boardTags ?? []).groups
        let nextGroups = BoardSubscriptionGrouping(relayURL: relayURL, boardTags: nextPlan.boardTags).groups
        let nextGroupIDs = Set(nextGroups.map(\.id))
        let previousGroupIDs = Set(previousGroups.map(\.id))

        for group in previousGroups where !nextGroupIDs.contains(group.id) {
            flushStartupBatches(relayURL: relayURL)
            try? await connection.closeSubscription(id: group.id)
            clearSubscriptionRetry(subscriptionID: group.id, relayURL: relayURL)
            pendingSubscriptions[relayURL]?.remove(group.id)
            relayBatches[relayURL]?.removeValue(forKey: group.id)
        }
        for group in nextGroups where !previousGroupIDs.contains(group.id) {
            try await issueBoardSubscription(group, on: connection, relayURL: relayURL)
        }

        guard previousPlan?.inboxPublicKey != nextPlan.inboxPublicKey else { return }
        if let previousInboxKey = previousPlan?.inboxPublicKey {
            let id = inboxSubscriptionID(relayURL: relayURL, publicKey: previousInboxKey)
            try? await connection.closeSubscription(id: id)
            clearSubscriptionRetry(subscriptionID: id, relayURL: relayURL)
            pendingSubscriptions[relayURL]?.remove(id)
            relayBatches[relayURL]?.removeValue(forKey: id)
        }
        if let nextInboxKey = nextPlan.inboxPublicKey {
            let id = beginSharedInboxReplay(relayURL: relayURL, publicKey: nextInboxKey)
            try await connection.subscribeToSharedInbox(
                id: id,
                recipientPublicKey: nextInboxKey,
                since: sharedInboxSubscriptionSince(
                    relayURL: relayURL,
                    publicKey: nextInboxKey
                ),
                limit: 500
            )
            noteSubscriptionIssued(relayURL: relayURL, subscriptionID: id)
        }
    }

    public func stop() async {
        auxiliaryLingerTask?.cancel()
        auxiliaryLingerTask = nil
        relayAuthTimeoutTasks.values.forEach { $0.cancel() }
        relayAuthTimeoutTasks.removeAll()
        flushStartupBatches()
        incompleteHistoryNewest.removeAll()
        startupBatchFlushTask?.cancel()
        listenerTasks.values.forEach { $0.cancel() }
        listenerTasks.removeAll()
        reconnectTasks.values.forEach { $0.cancel() }
        reconnectTasks.removeAll()
        rateLimitRetryTasks.values.forEach { $0.cancel() }
        rateLimitRetryTasks.removeAll()
        publishAcknowledgementTimeoutTasks.values
            .flatMap(\.values)
            .forEach { $0.cancel() }
        publishAcknowledgementTimeoutTasks.removeAll()
        subscriptionRetryTasks.values.forEach { $0.cancel() }
        subscriptionRetryTasks.removeAll()
        subscriptionRetryBackoffs.removeAll()
        subscriptionConsecutiveCloses.removeAll()
        subscriptionLastIssuedAt.removeAll()
        newestEventCreatedAtBySubscription.removeAll()
        scheduledOutboxFlushTask?.cancel()
        scheduledOutboxFlushTask = nil
        outboxFlushRequested = false
        scheduledRelayOutboxFlushTasks.values.forEach { $0.cancel() }
        scheduledRelayOutboxFlushTasks.removeAll()
        scheduledRelayOutboxFlushRequests.removeAll()
        reconnectBackoffs.removeAll()
        for connection in connections.values {
            await connection.disconnect()
        }
        connections.removeAll()
        pendingSubscriptions.removeAll()
        relayBatches.removeAll()
        relayPhases.removeAll()
        relayMessages.removeAll()
        publishPacers.removeAll()
        outboxSchedulers.removeAll()
        deferredRejectedEventIDs.removeAll()
        requestedRelayDrains.removeAll()
        inFlightEventIDs.removeAll()
        relayAuthChallenges.removeAll()
        relayAuthEventIDs.removeAll()
        pendingAuthResubscriptions.removeAll()
        configurationFingerprint = nil
        await emitStatus(state: .stopped)
    }

    public func retryNow() async {
        reconnectTasks.values.forEach { $0.cancel() }
        reconnectTasks.removeAll()
        rateLimitRetryTasks.values.forEach { $0.cancel() }
        rateLimitRetryTasks.removeAll()
        publishAcknowledgementTimeoutTasks.values
            .flatMap(\.values)
            .forEach { $0.cancel() }
        publishAcknowledgementTimeoutTasks.removeAll()
        subscriptionRetryTasks.values.forEach { $0.cancel() }
        subscriptionRetryTasks.removeAll()
        subscriptionRetryBackoffs.removeAll()
        subscriptionConsecutiveCloses.removeAll()
        subscriptionLastIssuedAt.removeAll()
        reconnectBackoffs.removeAll()
        pendingSubscriptions.removeAll()
        relayBatches.removeAll()
        inFlightEventIDs.removeAll()
        deferredRejectedEventIDs.removeAll()
        pendingAuthResubscriptions.removeAll()
        configurationFingerprint = nil
        for connection in connections.values {
            await connection.disconnect()
        }
        await configure(
            boards: boards,
            auxiliaryRelayURLs: auxiliaryRelayURLs,
            inboxPublicKey: inboxPublicKey,
            inboxRelayURLs: Array(inboxRelayURLs)
        )
    }

    /// A push means the inbox may have new data, not that every board socket needs a reset.
    /// Reissue only inbox subscriptions; healthy board subscriptions and outbox work continue.
    public func refreshSharedInboxAfterPush() async {
        guard let inboxPublicKey else { return }
        await withTaskGroup(of: Void.self) { group in
            for relayURL in inboxRelayURLs {
                group.addTask { [weak self] in
                    await self?.refreshSharedInbox(relayURL: relayURL, publicKey: inboxPublicKey)
                }
            }
        }
    }

    private func refreshSharedInbox(relayURL: String, publicKey: String) async {
        guard let connection = connections[relayURL] else { return }
        let responsive = await connection.isResponsive(timeout: .seconds(2))
        guard inboxPublicKey == publicKey, inboxRelayURLs.contains(relayURL),
              connections[relayURL] === connection else { return }
        if responsive {
            do {
                try await resubscribe(
                    subscriptionID: inboxSubscriptionID(relayURL: relayURL, publicKey: publicKey),
                    relayURL: relayURL
                )
                return
            } catch {
                // Repair this failed socket only.
            }
        }
        await resetForForegroundReconnect(relayURL: relayURL)
        await reconnect(relayURL: relayURL)
    }

    /// Verifies sockets after iOS resumes the app and repairs only the relays that stopped
    /// responding while suspended. A relay can retain an apparently live WebSocket task without
    /// delivering a disconnect callback, so relying on the aggregate `.online` state is not
    /// enough. Healthy sockets keep their subscriptions; failed sockets reconnect, reissue every
    /// board/inbox subscription, and replay any events missed in the background.
    public func refreshAfterForeground(healthCheckTimeout: Duration = .seconds(2)) async {
        guard !isCheckingForegroundRelayHealth else { return }
        isCheckingForegroundRelayHealth = true
        defer { isCheckingForegroundRelayHealth = false }

        let currentConnections = connections
        guard !currentConnections.isEmpty else { return }

        let healthByRelay = await withTaskGroup(
            of: (String, Bool).self,
            returning: [String: Bool].self
        ) { group in
            for (relayURL, connection) in currentConnections {
                group.addTask {
                    (relayURL, await connection.isResponsive(timeout: healthCheckTimeout))
                }
            }
            var result: [String: Bool] = [:]
            for await (relayURL, isResponsive) in group {
                result[relayURL] = isResponsive
            }
            return result
        }

        let unhealthyRelays = healthByRelay.compactMap { relayURL, isResponsive in
            isResponsive ? nil : relayURL
        }.sorted()
        for relayURL in unhealthyRelays {
            guard let currentConnection = currentConnections[relayURL],
                  let configuredConnection = connections[relayURL],
                  configuredConnection === currentConnection else { continue }
            await resetForForegroundReconnect(relayURL: relayURL)
            await reconnect(relayURL: relayURL)
        }

        // Foregrounding is also the earliest reliable opportunity to deliver edits that were
        // queued after iOS exhausted the background handoff window.
        await flushOutbox()
        await emitStatus()
    }

    /// Only an explicit device-local exclusion removes a delivery target. A relay
    /// rejection is not evidence that another event of the same kind will fail.
    private func deliveryRelayURLs(_ relayURLs: [String], for event: NostrEvent) -> [String] {
        relayURLs.filter { relayURL in
            !excludedRelayURLs.contains(relayURL)
        }
    }

    public func publish(
        _ event: NostrEvent,
        board: Board,
        taskID: String
    ) async throws {
        let relayURLs = deliveryRelayURLs(board.effectiveRelayURLs, for: event)
        guard !relayURLs.isEmpty else { return }
        let entry = NostrOutboxEntry(
            event: event,
            relayURLs: relayURLs,
            boardLocalID: board.id,
            taskID: taskID
        )
        try await outbox.enqueue(entry)
        await emitStatus()
        await send(entry)
    }

    public func publish(
        _ event: NostrEvent,
        relayURLs: [String],
        outboxScope: String,
        recordID: String
    ) async throws {
        let normalizedRelays = deliveryRelayURLs(
            TaskifyRelayURL.normalizedList(relayURLs),
            for: event
        )
        guard !normalizedRelays.isEmpty else { return }
        let entry = NostrOutboxEntry(
            event: event,
            relayURLs: normalizedRelays,
            boardLocalID: outboxScope,
            taskID: recordID
        )
        try await outbox.enqueue(entry)
        await emitStatus()
        await send(entry)
    }

    public func discardQueuedPublishes(outboxScope: String) async throws {
        try await outbox.removeEntries(boardLocalID: outboxScope)
        await emitStatus()
    }

    public func queueForPublish(_ requests: [TaskSyncPublishRequest], isRepublish: Bool = false) async throws {
        let entries = requests.compactMap { request -> NostrOutboxEntry? in
            let relayURLs = deliveryRelayURLs(request.board.effectiveRelayURLs, for: request.event)
            guard !relayURLs.isEmpty else { return nil }
            return NostrOutboxEntry(
                event: request.event,
                relayURLs: relayURLs,
                boardLocalID: request.board.id,
                taskID: request.taskID,
                isRepublish: isRepublish
            )
        }
        try await outbox.enqueue(entries)
        await emitStatus()
    }

    /// Stops sending a board's queued republish to public relays; it still reaches Taskify's own
    /// relays. Returns how many queued entries changed.
    @discardableResult
    public func limitQueuedRepublishToFirstPartyRelays(boardLocalID: String) async throws -> Int {
        let changed = try await outbox.limitRepublishedEntries(
            boardLocalID: boardLocalID,
            toRelays: TaskifyFirstPartyRelays.urls
        )
        if changed > 0 { await emitStatus() }
        return changed
    }

    /// Persist a complete task batch once, then let relay delivery proceed independently.
    public func enqueueForPublish(_ requests: [TaskSyncPublishRequest]) async throws {
        guard !requests.isEmpty else { return }
        try await queueForPublish(requests)
        scheduleOutboxFlush()
    }

    /// Atomically persists a group of relay publications, reports them as queued, and schedules
    /// delivery without making the caller wait behind existing relay backlog or rate limits.
    public func enqueueForPublish(_ requests: [TaskSyncRelayPublishRequest]) async throws {
        let entries = requests.compactMap { request -> NostrOutboxEntry? in
            let relayURLs = deliveryRelayURLs(request.relayURLs, for: request.event)
            guard !relayURLs.isEmpty else { return nil }
            return NostrOutboxEntry(
                event: request.event,
                relayURLs: relayURLs,
                boardLocalID: request.outboxScope,
                taskID: request.recordID,
                acknowledgementPolicy: request.acknowledgementPolicy,
                expiresAt: request.expiresAt,
                dependsOnEventID: request.dependsOnEventID
            )
        }
        guard !entries.isEmpty else { return }
        try await outbox.enqueue(entries)
        for entry in entries {
            updateContinuation.yield(.publishState(recordID: entry.taskID, state: .queued))
        }
        await emitStatus()
        scheduleOutboxFlush()
    }

    public func flushQueuedPublishes() async {
        await flushOutbox()
        await emitStatus()
    }

    public func pendingPublishCount() async -> Int {
        await outbox.entryCount()
    }

    /// Every queued entry, oldest first, for the settings screen's queue diagnostics.
    public func pendingOutboxRecords() async -> [TaskPendingOutboxRecord] {
        await outbox.allEntries().map { entry in
            TaskPendingOutboxRecord(
                id: entry.id,
                recordID: entry.taskID,
                outboxScope: entry.boardLocalID,
                pendingRelayURLs: entry.pendingRelayURLs,
                acceptedRelayCount: entry.acceptedRelayURLs?.count ?? 0,
                queuedAt: entry.queuedAt,
                dependsOnEventID: entry.dependsOnEventID,
                eventKind: entry.event.kind,
                relayRejections: entry.relayRejections ?? [:]
            )
        }
    }

    public func replaceQueuedRelayTargets(
        boardLocalID: String,
        relayURLs: [String]
    ) async throws {
        try await outbox.replaceRelayTargets(
            boardLocalID: boardLocalID,
            relayURLs: relayURLs
        )
        await emitStatus()
    }

    private func connectAndSubscribe(
        _ connection: any TaskSyncRelayTransport,
        relayURL: String
    ) async throws {
        flushStartupBatches(relayURL: relayURL)
        try await connection.connect()
        for group in boardGrouping(relayURL: relayURL).groups {
            try await issueBoardSubscription(group, on: connection, relayURL: relayURL)
        }
        if let inboxPublicKey,
           inboxPublicKey.count == 64,
           inboxRelayURLs.contains(relayURL) {
            let id = beginSharedInboxReplay(relayURL: relayURL, publicKey: inboxPublicKey)
            try await connection.subscribeToSharedInbox(
                id: id,
                recipientPublicKey: inboxPublicKey,
                since: sharedInboxSubscriptionSince(
                    relayURL: relayURL,
                    publicKey: inboxPublicKey
                ),
                limit: 500
            )
            noteSubscriptionIssued(relayURL: relayURL, subscriptionID: id)
        }
    }

    private func noteSubscriptionIssued(relayURL: String, subscriptionID: String) {
        subscriptionLastIssuedAt[
            subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        ] = Date()
    }

    private func flushOutbox() async {
        let relayURLs = await prepareOutboxFlush()
        await withTaskGroup(of: Void.self) { group in
            for relayURL in relayURLs {
                group.addTask { [weak self] in
                    await self?.flushOutbox(to: relayURL)
                }
            }
        }
    }

    private func prepareOutboxFlush() async -> Set<String> {
        if let expired = try? await outbox.removeExpired() {
            for entry in expired {
                updateContinuation.yield(.publishState(
                    recordID: entry.taskID,
                    state: .failed("Delivery expired before a relay accepted it.")
                ))
            }
        }
        await pruneStaleReplicaBacklog()
        return await outbox.pendingRelayURLs().subtracting(excludedRelayURLs)
    }

    private func scheduleOutboxFlush() {
        outboxFlushRequested = true
        guard scheduledOutboxFlushTask == nil else { return }
        scheduledOutboxFlushTask = Task { [weak self] in
            await Task.yield()
            await self?.runScheduledOutboxFlush()
        }
    }

    private func runScheduledOutboxFlush() async {
        guard !Task.isCancelled else { return }
        repeat {
            outboxFlushRequested = false
            let relayURLs = await prepareOutboxFlush()
            guard !Task.isCancelled else { return }
            for relayURL in relayURLs { scheduleOutboxFlush(to: relayURL) }
            // Planning never awaits a socket send or publish-pacing delay. A blocked relay
            // must not delay the next queued message or acknowledgement on a healthy relay.
        } while outboxFlushRequested && !Task.isCancelled
        guard !Task.isCancelled else { return }
        scheduledOutboxFlushTask = nil
        await emitStatus()
    }

    private func scheduleOutboxFlush(to relayURL: String) {
        scheduledRelayOutboxFlushRequests.insert(relayURL)
        guard scheduledRelayOutboxFlushTasks[relayURL] == nil else { return }
        scheduledRelayOutboxFlushTasks[relayURL] = Task { [weak self] in
            await self?.runScheduledOutboxFlush(to: relayURL)
        }
    }

    private func runScheduledOutboxFlush(to relayURL: String) async {
        repeat {
            scheduledRelayOutboxFlushRequests.remove(relayURL)
            await flushOutbox(to: relayURL)
        } while scheduledRelayOutboxFlushRequests.contains(relayURL) && !Task.isCancelled
        guard !Task.isCancelled else { return }
        scheduledRelayOutboxFlushTasks[relayURL] = nil
        await emitStatus()
    }

    private func flushOutbox(to relayURL: String) async {
        guard connections[relayURL] != nil, rateLimitRetryTasks[relayURL] == nil else { return }
        guard !activeRelayDrains.contains(relayURL) else {
            requestedRelayDrains.insert(relayURL)
            return
        }
        activeRelayDrains.insert(relayURL)
        defer {
            activeRelayDrains.remove(relayURL)
            requestedRelayDrains.remove(relayURL)
        }

        repeat {
            requestedRelayDrains.remove(relayURL)
            let inFlight = inFlightEventIDs[relayURL] ?? []
            guard inFlight.count < Self.maximumInFlightPublishesPerRelay else { return }
            let excludedEventIDs = inFlight.union(deferredRejectedEventIDs[relayURL] ?? [])
            var entries = await outbox.pendingEntries(
                for: relayURL,
                excludingEventIDs: excludedEventIDs
            )
            guard !entries.isEmpty else { return }

            var scheduler = outboxSchedulers[relayURL] ?? RelayOutboxScheduler()
            while (inFlightEventIDs[relayURL]?.count ?? 0) < Self.maximumInFlightPublishesPerRelay,
                  rateLimitRetryTasks[relayURL] == nil,
                  relayPhases[relayURL] != .offline,
                  let entry = scheduler.next(from: &entries) {
                outboxSchedulers[relayURL] = scheduler
                await send(entry, to: relayURL)
                scheduler = outboxSchedulers[relayURL] ?? scheduler
                if requestedRelayDrains.contains(relayURL) { break }
            }
            guard rateLimitRetryTasks[relayURL] == nil,
                  relayPhases[relayURL] != .offline,
                  (inFlightEventIDs[relayURL]?.count ?? 0) < Self.maximumInFlightPublishesPerRelay
            else { return }
        } while requestedRelayDrains.contains(relayURL)
    }

    private func send(_ entry: NostrOutboxEntry) async {
        await withTaskGroup(of: Void.self) { group in
            for relayURL in entry.pendingRelayURLs {
                group.addTask { [weak self] in
                    await self?.flushOutbox(to: relayURL)
                }
            }
        }
        await emitStatus()
    }

    private func send(_ entry: NostrOutboxEntry, to relayURL: String) async {
        guard connections[relayURL] != nil,
              rateLimitRetryTasks[relayURL] == nil,
              await outbox.isPending(eventID: entry.event.id, relayURL: relayURL) else { return }
        guard await waitForPublishWindow(relayURL: relayURL) else { return }
        guard let connection = connections[relayURL],
              rateLimitRetryTasks[relayURL] == nil,
              await outbox.isPending(eventID: entry.event.id, relayURL: relayURL),
              inFlightEventIDs[relayURL]?.contains(entry.event.id) != true else { return }
        inFlightEventIDs[relayURL, default: []].insert(entry.event.id)
        do {
            try await connection.publish(entry.event)
            schedulePublishAcknowledgementTimeout(
                eventID: entry.event.id,
                relayURL: relayURL
            )
            if relayPhases[relayURL] != .online {
                relayPhases[relayURL] = .syncing
            }
            if rateLimitRetryTasks[relayURL] == nil {
                relayMessages[relayURL] = nil
            }
        } catch {
            await resetForForegroundReconnect(relayURL: relayURL)
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = error.localizedDescription
            await emitStatus()
            scheduleReconnect(relayURL: relayURL)
        }
    }

    private func waitForPublishWindow(relayURL: String) async -> Bool {
        while !Task.isCancelled {
            let now = ProcessInfo.processInfo.systemUptime
            var pacer = publishPacers[relayURL] ?? RelayPublishPacer.forRelay(relayURL)
            let delay = pacer.delayBeforePublish(at: now)
            if delay <= 0 {
                pacer.recordPublish(at: now)
                publishPacers[relayURL] = pacer
                return true
            }
            publishPacers[relayURL] = pacer
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return false
            }
        }
        return false
    }

    // Internal ingress also allows deterministic delayed-EOSE and slow-consumer tests.
    func handle(_ message: NostrRelayMessage, from relayURL: String) async {
        if case .disconnected = message {
            lastInboundActivity[relayURL] = nil
        } else {
            lastInboundActivity[relayURL] = .now
        }
        if routeOneShotMessage(message, from: relayURL) { return }
        switch message {
        case .event(let subscriptionID, let event):
            guard isConfiguredSubscription(subscriptionID, relayURL: relayURL)
                || pendingSubscriptions[relayURL]?.contains(subscriptionID) == true else { return }
            if event.kind == NIP17GiftWrap.wrapKind,
               subscriptionID == inboxSubscriptionID(
                   relayURL: relayURL,
                   publicKey: inboxPublicKey ?? ""
               ) {
                guard event.firstTagValue(named: "p") == inboxPublicKey else { return }
                if let timestamp = verifiedEventCreatedAt[event.id] {
                    if event.verifyID() {
                        clearSubscriptionRetry(subscriptionID: subscriptionID, relayURL: relayURL)
                        noteObservedEventCreatedAt(timestamp, subscriptionID: subscriptionID, relayURL: relayURL)
                        await markRelayOnline(relayURL)
                    }
                    return
                }
                guard event.verify() else { return }
                clearSubscriptionRetry(subscriptionID: subscriptionID, relayURL: relayURL)
                noteObservedEventCreatedAt(event.createdAt, subscriptionID: subscriptionID, relayURL: relayURL)
                await markRelayOnline(relayURL)
                if recordSharedInboxEventIfNew(event) {
                    if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
                        updateContinuation.yield(.sharedInboxBatch([event]))
                    } else {
                        updateContinuation.yield(.sharedInbox(event))
                    }
                }
                return
            }
            guard let boardTag = event.firstTagValue(named: "b"),
                  let boardIndex = boards.firstIndex(where: {
                      BoardCrypto.boardTag(for: $0.effectiveNostrBoardID) == boardTag &&
                      $0.effectiveRelayURLs.contains(relayURL)
                  }) else { return }
            let board = boards[boardIndex]
            guard subscriptionID == boardGrouping(relayURL: relayURL).groupID(for: boardTag) else { return }
            if let timestamp = verifiedEventCreatedAt[event.id] {
                if event.verifyID() {
                    clearSubscriptionRetry(subscriptionID: subscriptionID, relayURL: relayURL)
                    noteObservedBoardEventCreatedAt(timestamp, boardTag: boardTag, subscriptionID: subscriptionID, relayURL: relayURL)
                    await markRelayOnline(relayURL)
                }
                return
            }

            if event.kind == TaskEventCodec.boardEventKind {
                guard let record = try? TaskEventCodec.decodeBoardEvent(event, board: board),
                      event.createdAt > (board.nostrUpdatedAt ?? 0),
                      recordEventIfNew(event) else { return }
                noteObservedBoardEventCreatedAt(event.createdAt, boardTag: boardTag, subscriptionID: subscriptionID, relayURL: relayURL)
                await markRelayOnline(relayURL)
                boards[boardIndex] = record.board
                updateContinuation.yield(.board(record))
                return
            }


            if event.kind == TaskifyCalendarEventCodec.canonicalEventKind {
                guard let record = try? TaskifyCalendarEventCodec.decodeCanonicalEvent(
                    event,
                    board: board
                ), recordEventIfNew(event) else { return }
                noteObservedBoardEventCreatedAt(event.createdAt, boardTag: boardTag, subscriptionID: subscriptionID, relayURL: relayURL)
                await markRelayOnline(relayURL)
                if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
                    var subscriptions = relayBatches[relayURL] ?? [:]
                    var batch = subscriptions[subscriptionID] ?? TaskRelayStartupBatch()
                    batch.insert(record)
                    subscriptions[subscriptionID] = batch
                    relayBatches[relayURL] = subscriptions
                    scheduleStartupBatchFlush()
                } else {
                    updateContinuation.yield(.calendarEvent(record))
                }
                return
            }

            guard let record = try? TaskEventCodec.decodeTaskEvent(event, board: board),
                  recordEventIfNew(event) else { return }
            noteObservedBoardEventCreatedAt(event.createdAt, boardTag: boardTag, subscriptionID: subscriptionID, relayURL: relayURL)
            await markRelayOnline(relayURL)
            if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
                var subscriptions = relayBatches[relayURL] ?? [:]
                var batch = subscriptions[subscriptionID] ?? TaskRelayStartupBatch()
                batch.insert(record)
                subscriptions[subscriptionID] = batch
                relayBatches[relayURL] = subscriptions
                scheduleStartupBatchFlush()
            } else {
                updateContinuation.yield(.task(record))
            }
        case .acknowledgement(let eventID, let accepted, let message):
            if relayAuthEventIDs[relayURL] == eventID {
                relayAuthTimeoutTasks.removeValue(forKey: relayURL)?.cancel()
                relayAuthEventIDs[relayURL] = nil
                if accepted {
                    relayMessages[relayURL] = nil
                    if let subscriptionIDs = pendingAuthResubscriptions.removeValue(forKey: relayURL) {
                        for subscriptionID in subscriptionIDs {
                            try? await resubscribe(subscriptionID: subscriptionID, relayURL: relayURL)
                        }
                    }
                    await markRelayOnline(relayURL)
                    scheduleOutboxFlush()
                } else {
                    // The relay can't authenticate us (or won't). That costs only what needs
                    // auth there; dropping the connection lost board sync and publishing too,
                    // and reconnecting replayed history only to be refused again.
                    relayAuthUnavailableUntil[relayURL] = Date().addingTimeInterval(Self.relayAuthRetryInterval)
                    pendingAuthResubscriptions.removeValue(forKey: relayURL)
                    relayMessages[relayURL] = "Sign-in unavailable here • private inbox uses other relays"
                    await emitStatus()
                }
                return
            }
            cancelPublishAcknowledgementTimeout(eventID: eventID, relayURL: relayURL)
            let wasInFlight = inFlightEventIDs[relayURL]?.remove(eventID) != nil
            guard await outbox.isPending(eventID: eventID, relayURL: relayURL) else {
                if wasInFlight { scheduleOutboxFlush(to: relayURL) }
                return
            }
            if accepted || NostrRelayRejection.isSuperseded(message) {
                let completed = try? await outbox.markAccepted(
                    eventID: eventID,
                    relayURL: relayURL
                )
                if let completed {
                    updateContinuation.yield(.publishState(
                        recordID: completed.taskID,
                        state: .sent
                    ))
                }
                await pruneStaleReplicaBacklog()
                var pacer = publishPacers[relayURL] ?? RelayPublishPacer.forRelay(relayURL)
                pacer.recordAccepted()
                publishPacers[relayURL] = pacer
                if rateLimitRetryTasks[relayURL] == nil {
                    await markRelayOnline(relayURL)
                    // The relay listener awaits this handler before reading its next EVENT.
                    // Publish pacing/backoff must run independently of incoming messages.
                    scheduleOutboxFlush()
                } else {
                    relayPhases[relayURL] = .syncing
                    await emitStatus()
                }
            } else if NostrRelayRejection.isRateLimited(message) {
                await registerRateLimit(message: message, relayURL: relayURL)
            } else if NostrRelayRejection.isAuthRequired(message), isRelayAuthUnavailable(relayURL) {
                // It only takes this event with auth it can't do: hold it back like a refusal.
                _ = try? await outbox.recordRejection(eventID: eventID, relayURL: relayURL)
                scheduleOutboxFlush()
            } else if NostrRelayRejection.isAuthRequired(message) {
                await handleAuthRequired(relayURL: relayURL)
            } else {
                switch NostrRelayRejection.kind(of: message) {
                case .refused:
                    // Keep the change (it may be the only copy) but stop offering it to this
                    // relay on every reconnect; see `RelayRejectionBackoff`.
                    _ = try? await outbox.recordRejection(eventID: eventID, relayURL: relayURL)
                case .transient:
                    deferredRejectedEventIDs[relayURL, default: []].insert(eventID)
                }
                relayPhases[relayURL] = .online
                relayMessages[relayURL] = "Rejected one queued change • \(message)"
                await emitStatus()
                scheduleOutboxFlush()
            }
        case .disconnected(let message):
            flushStartupBatches(relayURL: relayURL)
            cancelPublishAcknowledgementTimeouts(relayURL: relayURL)
            inFlightEventIDs.removeValue(forKey: relayURL)
            deferredRejectedEventIDs.removeValue(forKey: relayURL)
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = message
            await emitStatus()
            scheduleReconnect(relayURL: relayURL)
        case .notice(let message):
            if NostrRelayRejection.isRateLimited(message) {
                await registerRateLimit(message: message, relayURL: relayURL)
            } else if NostrRelayRejection.isAuthRequired(message) {
                await handleAuthRequired(relayURL: relayURL)
            } else {
                relayMessages[relayURL] = message
                await emitStatus()
            }
        case .auth(let challenge):
            if relayAuthChallenges[relayURL] != challenge {
                relayAuthTimeoutTasks.removeValue(forKey: relayURL)?.cancel()
                relayAuthEventIDs[relayURL] = nil
            }
            relayAuthChallenges[relayURL] = challenge
            guard !isRelayAuthUnavailable(relayURL) else { return }
            await authenticate(relayURL: relayURL, challenge: challenge)
        case .closed(let subscriptionID, let message) where NostrRelayRejection.isAuthRequired(message):
            await handleAuthRequiredClose(subscriptionID: subscriptionID, relayURL: relayURL)
        case .closed(let subscriptionID, let message):
            await handleSubscriptionClose(
                subscriptionID: subscriptionID,
                message: message,
                relayURL: relayURL
            )
        case .endOfStoredEvents(let subscriptionID):
            guard isConfiguredSubscription(subscriptionID, relayURL: relayURL)
                || pendingSubscriptions[relayURL]?.contains(subscriptionID) == true else { return }
            let boardTags = boardGrouping(relayURL: relayURL).group(withID: subscriptionID)?.boardTags ?? []
            let cursorKeys = boardTags.isEmpty
                ? [subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)]
                : boardTags.map { boardCursorKey(relayURL: relayURL, boardTag: $0) }
            for cursorKey in cursorKeys {
                if let newest = incompleteHistoryNewest.removeValue(forKey: cursorKey) {
                    newestEventCreatedAtBySubscription[cursorKey] = max(newestEventCreatedAtBySubscription[cursorKey] ?? 0, newest)
                }
            }
            clearSubscriptionRetry(subscriptionID: subscriptionID, relayURL: relayURL)
            var batch = relayBatches[relayURL]?[subscriptionID] ?? TaskRelayStartupBatch()
            let records = batch.drain()
            let calendarRecords = batch.drainCalendarEvents()
            let drainedSharedInboxEvents = batch.drainSharedInboxEvents()
            var sharedInboxEvents: [NostrEvent] = []
            for event in drainedSharedInboxEvents where recordSharedInboxEventIfNew(event) {
                sharedInboxEvents.append(event)
            }
            relayBatches[relayURL]?[subscriptionID] = nil
            pendingSubscriptions[relayURL]?.remove(subscriptionID)
            if !records.isEmpty || !calendarRecords.isEmpty {
                updateContinuation.yield(.batch(tasks: records, calendarEvents: calendarRecords))
            }
            if !sharedInboxEvents.isEmpty {
                updateContinuation.yield(.sharedInboxBatch(sharedInboxEvents))
            }
            await markRelayOnline(relayURL)
        }
    }

    /// Forward verified history regularly even when a relay omits EOSE. Flush before
    /// replacing/removing a subscription so deduplication never strands buffered records.
    private func scheduleStartupBatchFlush() {
        guard startupBatchFlushTask == nil else { return }
        startupBatchFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            await self?.flushStartupBatches()
        }
    }

    private func flushStartupBatches(relayURL: String? = nil) {
        if relayURL == nil {
            startupBatchFlushTask?.cancel()
            startupBatchFlushTask = nil
        }
        for relay in Array(relayBatches.keys) where relayURL == nil || relayURL == relay {
            let subscriptionIDs = relayBatches[relay].map { Array($0.keys) } ?? []
            for id in subscriptionIDs {
                guard var batch = relayBatches[relay]?[id] else { continue }
                let tasks = batch.drain()
                let events = batch.drainCalendarEvents()
                relayBatches[relay]?[id] = batch
                if !tasks.isEmpty || !events.isEmpty {
                    updateContinuation.yield(.batch(tasks: tasks, calendarEvents: events))
                }
            }
        }
    }

    /// Recorded only after a successful decode, so a relay that hands us a corrupt or
    /// undecryptable copy never prevents a healthy copy from another relay being processed.
    private func recordEventIfNew(_ event: NostrEvent) -> Bool {
        let eventID = event.id
        guard deliveredEventIDs.insert(eventID).inserted else { return false }
        verifiedEventCreatedAt[eventID] = event.createdAt
        deliveredEventIDOrder.append(eventID)
        let maximumRememberedEventCount = 5_000
        if deliveredEventIDOrder.count > maximumRememberedEventCount {
            let overflow = deliveredEventIDOrder.count - maximumRememberedEventCount
            for expiredID in deliveredEventIDOrder.prefix(overflow) {
                deliveredEventIDs.remove(expiredID)
                verifiedEventCreatedAt.removeValue(forKey: expiredID)
            }
            deliveredEventIDOrder.removeFirst(overflow)
        }
        return true
    }

    private func recordSharedInboxEventIfNew(_ event: NostrEvent) -> Bool {
        guard deliveredSharedInboxEventIDs.insert(event.id).inserted else { return false }
        verifiedEventCreatedAt[event.id] = event.createdAt
        deliveredSharedInboxEventIDOrder.append(event.id)
        let maximumRememberedEventCount = 2_000
        if deliveredSharedInboxEventIDOrder.count > maximumRememberedEventCount {
            let overflow = deliveredSharedInboxEventIDOrder.count - maximumRememberedEventCount
            for expiredID in deliveredSharedInboxEventIDOrder.prefix(overflow) {
                deliveredSharedInboxEventIDs.remove(expiredID)
                verifiedEventCreatedAt.removeValue(forKey: expiredID)
            }
            deliveredSharedInboxEventIDOrder.removeFirst(overflow)
        }
        return true
    }

    private func scheduleReconnect(relayURL: String) {
        guard reconnectTasks[relayURL] == nil, connections[relayURL] != nil else { return }
        let delay = reconnectBackoffs[relayURL, default: RelayRetryBackoff()].nextDelay()
        reconnectTasks[relayURL] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.reconnectAfterDelay(relayURL: relayURL)
        }
    }

    private func registerRateLimit(message _: String, relayURL: String) async {
        if rateLimitRetryTasks[relayURL] != nil {
            relayPhases[relayURL] = .syncing
            return
        }
        let now = ProcessInfo.processInfo.systemUptime
        var pacer = publishPacers[relayURL] ?? RelayPublishPacer.forRelay(relayURL)
        let delay = pacer.recordRateLimit(at: now)
        publishPacers[relayURL] = pacer
        relayPhases[relayURL] = .syncing
        relayMessages[relayURL] = "Rate limited • queued retry in \(Int(ceil(delay)))s"
        await emitStatus()
        scheduleRateLimitRetry(relayURL: relayURL, delay: delay)
    }

    private func scheduleRateLimitRetry(relayURL: String, delay: TimeInterval) {
        guard rateLimitRetryTasks[relayURL] == nil, connections[relayURL] != nil else { return }
        rateLimitRetryTasks[relayURL] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.retryAfterRateLimit(relayURL: relayURL)
        }
    }

    private func retryAfterRateLimit(relayURL: String) async {
        rateLimitRetryTasks[relayURL] = nil
        guard connections[relayURL] != nil else { return }
        relayPhases[relayURL] = .syncing
        relayMessages[relayURL] = "Retrying queued changes"
        await emitStatus()
        await flushOutbox(to: relayURL)
    }

    private func schedulePublishAcknowledgementTimeout(eventID: String, relayURL: String) {
        guard inFlightEventIDs[relayURL]?.contains(eventID) == true else { return }
        cancelPublishAcknowledgementTimeout(eventID: eventID, relayURL: relayURL)
        schedulePublishAcknowledgementTimeout(
            eventID: eventID,
            relayURL: relayURL,
            after: publishAcknowledgementTimeout,
            // Traffic extends the wait, but not forever: a relay streaming live events can
            // still have lost this one acknowledgement.
            giveUpAt: ContinuousClock.now.advanced(by: publishAcknowledgementTimeout * 4)
        )
    }

    private func schedulePublishAcknowledgementTimeout(
        eventID: String,
        relayURL: String,
        after timeout: Duration,
        giveUpAt: ContinuousClock.Instant
    ) {
        let task = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            await self?.handlePublishAcknowledgementTimeout(
                eventID: eventID,
                relayURL: relayURL,
                giveUpAt: giveUpAt
            )
        }
        publishAcknowledgementTimeoutTasks[relayURL, default: [:]][eventID] = task
    }

    private func cancelPublishAcknowledgementTimeout(eventID: String, relayURL: String) {
        publishAcknowledgementTimeoutTasks[relayURL]?
            .removeValue(forKey: eventID)?
            .cancel()
        if publishAcknowledgementTimeoutTasks[relayURL]?.isEmpty == true {
            publishAcknowledgementTimeoutTasks.removeValue(forKey: relayURL)
        }
    }

    private func cancelPublishAcknowledgementTimeouts(relayURL: String) {
        publishAcknowledgementTimeoutTasks
            .removeValue(forKey: relayURL)?
            .values
            .forEach { $0.cancel() }
    }

    private func handlePublishAcknowledgementTimeout(
        eventID: String,
        relayURL: String,
        giveUpAt: ContinuousClock.Instant
    ) async {
        publishAcknowledgementTimeoutTasks[relayURL]?.removeValue(forKey: eventID)
        if publishAcknowledgementTimeoutTasks[relayURL]?.isEmpty == true {
            publishAcknowledgementTimeoutTasks.removeValue(forKey: relayURL)
        }
        guard inFlightEventIDs[relayURL]?.contains(eventID) == true else { return }
        if let lastActivity = lastInboundActivity[relayURL] {
            let quietDeadline = min(lastActivity.advanced(by: publishAcknowledgementTimeout), giveUpAt)
            let now = ContinuousClock.now
            if quietDeadline > now {
                // Still receiving: the acknowledgement is likely queued behind earlier messages.
                schedulePublishAcknowledgementTimeout(
                    eventID: eventID,
                    relayURL: relayURL,
                    after: now.duration(to: quietDeadline),
                    giveUpAt: giveUpAt
                )
                return
            }
        }
        inFlightEventIDs[relayURL]?.remove(eventID)
        guard await outbox.isPending(eventID: eventID, relayURL: relayURL) else {
            await flushOutbox(to: relayURL)
            return
        }
        await resetForForegroundReconnect(relayURL: relayURL)
        relayPhases[relayURL] = .offline
        relayMessages[relayURL] = "Relay acknowledgement timed out • change remains queued"
        await emitStatus()
        scheduleReconnect(relayURL: relayURL)
    }

    private func pruneStaleReplicaBacklog() async {
        guard let pruned = try? await outbox.removeStaleReplicaBacklog(
            retention: Self.replicaRetryRetention
        ) else { return }
        for entry in pruned {
            updateContinuation.yield(.publishState(
                recordID: entry.taskID,
                state: .sent
            ))
        }
    }

    /// Completes queued changes that only waited on excluded relays, reporting each as sent so
    /// the UI's pending-change count reflects the removal. Later changes never enqueue the
    /// excluded relays in the first place — publish paths filter them out.
    private func stripExcludedRelayTargets() async {
        guard !excludedRelayURLs.isEmpty else { return }
        guard let completed = try? await outbox.stripRelayTargets(excludedRelayURLs) else { return }
        for entry in completed {
            updateContinuation.yield(.publishState(
                recordID: entry.taskID,
                state: .sent
            ))
        }
    }

    private func handleSubscriptionClose(
        subscriptionID: String,
        message: String,
        relayURL: String
    ) async {
        guard isConfiguredSubscription(subscriptionID, relayURL: relayURL) else { return }
        flushStartupBatches(relayURL: relayURL)
        let key = subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        guard subscriptionRetryTasks[key] == nil else { return }
        if NostrRelayRejection.isRateLimited(message) {
            await registerRateLimit(message: message, relayURL: relayURL)
        }
        let cooldown = publishPacers[relayURL]?.delayBeforePublish(
            at: ProcessInfo.processInfo.systemUptime
        ) ?? 0
        let consecutiveCloses = subscriptionConsecutiveCloses[key, default: 0] + 1
        subscriptionConsecutiveCloses[key] = consecutiveCloses
        let backoffDelay = subscriptionRetryBackoffs[key, default: RelayRetryBackoff()].nextDelay()
        // Repeated CLOSED replies escalate into minutes-long cooldowns. The 1–30 s exponential
        // backoff alone cannot contain a relay that accepts a resubscribe and closes it again:
        // each acceptance reissued a full-window replay about once per second, indefinitely.
        let delay = max(
            backoffDelay,
            max(Int(ceil(cooldown)), escalatedSubscriptionCloseDelay(consecutiveCloses: consecutiveCloses))
        )
        if relayPhases[relayURL] != .online {
            relayPhases[relayURL] = .syncing
        }
        let reason = NostrRelayRejection.isRateLimited(message) ? "Rate limited" : "Subscription unavailable"
        relayMessages[relayURL] = "\(reason) • retrying subscription in \(delay)s"
        await emitStatus()
        subscriptionRetryTasks[key] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.retrySubscriptionAfterDelay(subscriptionID: subscriptionID, relayURL: relayURL)
        }
    }

    private func retrySubscriptionAfterDelay(subscriptionID: String, relayURL: String) async {
        let key = subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        subscriptionRetryTasks[key] = nil
        guard connections[relayURL] != nil else { return }
        guard isConfiguredSubscription(subscriptionID, relayURL: relayURL) else {
            subscriptionRetryBackoffs[key] = nil
            subscriptionConsecutiveCloses[key] = nil
            subscriptionLastIssuedAt[key] = nil
            return
        }
        // Another rejection may have extended the shared cooldown while this retry slept.
        let cooldown = publishPacers[relayURL]?.delayBeforePublish(
            at: ProcessInfo.processInfo.systemUptime
        ) ?? 0
        if cooldown > 0 {
            subscriptionRetryTasks[key] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(cooldown))
                guard !Task.isCancelled else { return }
                await self?.retrySubscriptionAfterDelay(subscriptionID: subscriptionID, relayURL: relayURL)
            }
            return
        }
        do {
            try await resubscribe(subscriptionID: subscriptionID, relayURL: relayURL)
            // A successful send is not acceptance: another CLOSED may be on its way.
            // Only an EVENT or EOSE for this subscription resets its backoff.
        } catch {
            // The subscription no longer maps to a known board/inbox (e.g. it was reconfigured
            // away) or the relay dropped us in the meantime — fall back to a full reconnect.
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = error.localizedDescription
            await emitStatus()
            scheduleReconnect(relayURL: relayURL)
        }
    }

    private func subscriptionRetryKey(relayURL: String, subscriptionID: String) -> String {
        "\(relayURL)#\(subscriptionID)"
    }

    private func noteObservedEventCreatedAt(
        _ createdAt: Int,
        subscriptionID: String,
        relayURL: String
    ) {
        let key = subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
            incompleteHistoryNewest[key] = max(incompleteHistoryNewest[key] ?? 0, createdAt)
            return
        }
        if createdAt > (newestEventCreatedAtBySubscription[key] ?? 0) {
            newestEventCreatedAtBySubscription[key] = createdAt
        }
    }

    /// Resume with the full NIP-17 timestamp overlap. A newer rumor can have an older
    /// envelope timestamp, so a one-minute cursor drops even live messages after a refresh.
    /// Event-ID deduplication skips repeated crypto/merges within this overlapping window.
    private func sharedInboxSubscriptionSince(
        relayURL: String,
        publicKey: String
    ) -> Int {
        subscriptionSince(
            relayURL: relayURL,
            subscriptionID: inboxSubscriptionID(relayURL: relayURL, publicKey: publicKey),
            fallback: Int(Date().timeIntervalSince1970) - (30 * 24 * 60 * 60)
        )
    }

    /// Board cursors are per board, not per REQ: a group re-issued because its membership
    /// changed resumes each board where that board left off.
    private func boardCursorKey(relayURL: String, boardTag: String) -> String {
        "\(relayURL)#board:\(boardTag)"
    }

    private func noteObservedBoardEventCreatedAt(
        _ createdAt: Int,
        boardTag: String,
        subscriptionID: String,
        relayURL: String
    ) {
        let key = boardCursorKey(relayURL: relayURL, boardTag: boardTag)
        if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
            incompleteHistoryNewest[key] = max(incompleteHistoryNewest[key] ?? 0, createdAt)
            return
        }
        if createdAt > (newestEventCreatedAtBySubscription[key] ?? 0) {
            newestEventCreatedAtBySubscription[key] = createdAt
        }
    }

    private func boardGrouping(relayURL: String) -> BoardSubscriptionGrouping {
        if let cached = boardGroupingCache[relayURL] { return cached }
        let grouping = BoardSubscriptionGrouping(
            relayURL: relayURL,
            boardTags: boards
                .filter { $0.effectiveRelayURLs.contains(relayURL) }
                .map { BoardCrypto.boardTag(for: $0.effectiveNostrBoardID) }
        )
        boardGroupingCache[relayURL] = grouping
        return grouping
    }

    private func issueBoardSubscription(
        _ group: BoardSubscriptionGrouping.Group,
        on connection: any TaskSyncRelayTransport,
        relayURL: String
    ) async throws {
        pendingSubscriptions[relayURL, default: []].insert(group.id)
        relayBatches[relayURL, default: [:]][group.id] = TaskRelayStartupBatch()
        try await connection.subscribe(
            id: group.id,
            kinds: [
                TaskEventCodec.boardEventKind,
                TaskEventCodec.taskEventKind,
                TaskifyCalendarEventCodec.canonicalEventKind,
            ],
            boards: group.boardTags.map {
                BoardSubscriptionFilter(boardTag: $0, since: boardSubscriptionSince(relayURL: relayURL, boardTag: $0))
            },
            limit: 2_000
        )
        noteSubscriptionIssued(relayURL: relayURL, subscriptionID: group.id)
    }

    /// Board cold starts use a bounded initial query without `since`. Only a completed
    /// history response establishes a cursor for subsequent reconnects.
    private func boardSubscriptionSince(
        relayURL: String,
        boardTag: String
    ) -> Int? {
        let key = boardCursorKey(relayURL: relayURL, boardTag: boardTag)
        guard let newest = newestEventCreatedAtBySubscription[key] else { return nil }
        let now = Int(Date().timeIntervalSince1970)
        return max(0, min(newest, now) - Self.replaySinceSkewSeconds)
    }

    private func subscriptionSince(
        relayURL: String,
        subscriptionID: String,
        fallback: Int
    ) -> Int {
        let key = subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        guard let newest = newestEventCreatedAtBySubscription[key] else { return fallback }
        let now = Int(Date().timeIntervalSince1970)
        // Clamp before subtracting the overlap: a future-dated envelope must not shrink
        // the two-day allowance for normally backdated messages arriving afterward.
        let overlap = Self.inboxTimestampRandomizationSeconds + Self.replaySinceSkewSeconds
        return max(fallback, max(0, min(newest, now) - overlap))
    }

    private func escalatedSubscriptionCloseDelay(consecutiveCloses: Int) -> Int {
        if consecutiveCloses < 3 { return 0 }
        if consecutiveCloses == 3 { return 60 }
        if consecutiveCloses == 4 { return 120 }
        if consecutiveCloses == 5 { return 300 }
        return 600
    }

    private func isConfiguredSubscription(_ id: String, relayURL: String) -> Bool {
        if let inboxPublicKey, inboxRelayURLs.contains(relayURL),
           id == inboxSubscriptionID(relayURL: relayURL, publicKey: inboxPublicKey) {
            return true
        }
        return boardGrouping(relayURL: relayURL).group(withID: id) != nil
    }

    private func clearSubscriptionRetry(subscriptionID: String, relayURL: String) {
        let key = subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        subscriptionRetryTasks.removeValue(forKey: key)?.cancel()
        // Only a subscription that has stayed up well past its issue time proves the
        // accept-then-close cycle is over. Resetting on every early EVENT let a rejecting
        // relay pin this subscription to the 1 s end of the backoff forever.
        guard let issuedAt = subscriptionLastIssuedAt[key],
              Date().timeIntervalSince(issuedAt) >= Self.subscriptionStabilityInterval else {
            return
        }
        subscriptionRetryBackoffs.removeValue(forKey: key)
        subscriptionConsecutiveCloses.removeValue(forKey: key)
        subscriptionLastIssuedAt.removeValue(forKey: key)
    }

    /// Re-issues the REQ for a single subscription ID without touching any other subscription
    /// on the relay. Used after a rate-limited or auth-required CLOSED.
    private func resubscribe(subscriptionID: String, relayURL: String) async throws {
        flushStartupBatches(relayURL: relayURL)
        guard let connection = connections[relayURL] else { throw URLError(.notConnectedToInternet) }
        if let group = boardGrouping(relayURL: relayURL).group(withID: subscriptionID) {
            try await issueBoardSubscription(group, on: connection, relayURL: relayURL)
            return
        }
        if let inboxPublicKey,
           inboxPublicKey.count == 64,
           inboxRelayURLs.contains(relayURL),
           inboxSubscriptionID(relayURL: relayURL, publicKey: inboxPublicKey) == subscriptionID {
            _ = beginSharedInboxReplay(relayURL: relayURL, publicKey: inboxPublicKey)
            try await connection.subscribeToSharedInbox(
                id: subscriptionID,
                recipientPublicKey: inboxPublicKey,
                since: sharedInboxSubscriptionSince(
                    relayURL: relayURL,
                    publicKey: inboxPublicKey
                ),
                limit: 500
            )
            noteSubscriptionIssued(relayURL: relayURL, subscriptionID: subscriptionID)
            return
        }
        throw URLError(.badURL)
    }

    /// NIP-42: sign and send the relay's challenge back as an `AUTH` event so it can grant this
    /// pubkey any rate-limit exemption it offers to known/authenticated clients.
    private func authenticate(relayURL: String, challenge: String) async {
        guard relayAuthEventIDs[relayURL] == nil else { return }
        guard let identity else {
            relayMessages[relayURL] = "Relay requires authentication"
            await emitStatus()
            return
        }
        guard let connection = connections[relayURL] else { return }
        guard let event = try? NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: Int(Date().timeIntervalSince1970),
            kind: NIP42AuthContract.eventKind,
            tags: [["relay", relayURL], ["challenge", challenge]],
            content: ""
        ) else { return }
        relayAuthEventIDs[relayURL] = event.id
        relayAuthTimeoutTasks[relayURL] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            await self?.authTimedOut(relayURL: relayURL, eventID: event.id)
        }
        do {
            try await connection.authenticate(event)
        } catch {
            relayAuthTimeoutTasks.removeValue(forKey: relayURL)?.cancel()
            relayAuthEventIDs[relayURL] = nil
            relayMessages[relayURL] = error.localizedDescription
            await emitStatus()
        }
    }

    private func authTimedOut(relayURL: String, eventID: String) async {
        guard relayAuthEventIDs[relayURL] == eventID else { return }
        await resetForForegroundReconnect(relayURL: relayURL)
        relayPhases[relayURL] = .offline
        relayMessages[relayURL] = "Relay authentication timed out • changes remain queued"
        await emitStatus()
        scheduleReconnect(relayURL: relayURL)
    }

    private func handleAuthRequired(relayURL: String) async {
        guard !isRelayAuthUnavailable(relayURL) else { return }
        if relayPhases[relayURL] != .online {
            relayPhases[relayURL] = .syncing
        }
        relayMessages[relayURL] = "Relay requires authentication"
        await emitStatus()
        if let challenge = relayAuthChallenges[relayURL] {
            await authenticate(relayURL: relayURL, challenge: challenge)
        }
    }

    private func handleAuthRequiredClose(subscriptionID: String, relayURL: String) async {
        guard isConfiguredSubscription(subscriptionID, relayURL: relayURL) else { return }
        // Without auth there the subscription can't be served; leave it closed.
        guard !isRelayAuthUnavailable(relayURL) else {
            flushStartupBatches(relayURL: relayURL)
            pendingSubscriptions[relayURL]?.remove(subscriptionID)
            return
        }
        pendingAuthResubscriptions[relayURL, default: []].insert(subscriptionID)
        await handleAuthRequired(relayURL: relayURL)
    }

    private func reconnectAfterDelay(relayURL: String) async {
        reconnectTasks[relayURL] = nil
        await reconnect(relayURL: relayURL)
    }

    private func resetForForegroundReconnect(relayURL: String) async {
        relayAuthTimeoutTasks.removeValue(forKey: relayURL)?.cancel()
        flushStartupBatches(relayURL: relayURL)
        reconnectTasks.removeValue(forKey: relayURL)?.cancel()
        rateLimitRetryTasks.removeValue(forKey: relayURL)?.cancel()
        // Socket cleanup also runs after send failures and acknowledgement timeouts.
        // Preserve the retry history until a relay response proves recovery.
        pendingSubscriptions.removeValue(forKey: relayURL)
        relayBatches.removeValue(forKey: relayURL)
        cancelPublishAcknowledgementTimeouts(relayURL: relayURL)
        lastInboundActivity.removeValue(forKey: relayURL)
        inFlightEventIDs.removeValue(forKey: relayURL)
        outboxSchedulers.removeValue(forKey: relayURL)
        deferredRejectedEventIDs.removeValue(forKey: relayURL)
        relayAuthChallenges.removeValue(forKey: relayURL)
        relayAuthEventIDs.removeValue(forKey: relayURL)
        pendingAuthResubscriptions.removeValue(forKey: relayURL)
        for key in Set(subscriptionRetryTasks.keys)
            .union(subscriptionRetryBackoffs.keys)
            .union(subscriptionConsecutiveCloses.keys)
            .union(subscriptionLastIssuedAt.keys)
            where key.hasPrefix("\(relayURL)#") {
            subscriptionRetryTasks.removeValue(forKey: key)?.cancel()
            subscriptionRetryBackoffs.removeValue(forKey: key)
            subscriptionConsecutiveCloses.removeValue(forKey: key)
            subscriptionLastIssuedAt.removeValue(forKey: key)
        }
        if let connection = connections[relayURL] {
            await connection.disconnect()
        }
    }

    private func reconnect(relayURL: String) async {
        guard let connection = connections[relayURL] else { return }
        relayPhases[relayURL] = .connecting
        relayMessages[relayURL] = nil
        await emitStatus()
        do {
            try await connectAndSubscribe(connection, relayURL: relayURL)
            if relayPhases[relayURL] != .online {
                relayPhases[relayURL] = .syncing
            }
            relayMessages[relayURL] = nil
            await flushOutbox()
            await emitStatus()
        } catch {
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = error.localizedDescription
            await emitStatus()
            scheduleReconnect(relayURL: relayURL)
        }
    }

    private func markRelayOnline(_ relayURL: String) async {
        // Called for every incoming relay event, so only emit a status report when the
        // relay's phase/message actually changes — during initial sync this otherwise
        // floods the main actor with one status update per stored event per relay.
        reconnectTasks.removeValue(forKey: relayURL)?.cancel()
        reconnectBackoffs.removeValue(forKey: relayURL)
        if rateLimitRetryTasks[relayURL] != nil {
            guard relayPhases[relayURL] != .syncing else { return }
            relayPhases[relayURL] = .syncing
            await emitStatus()
            return
        }
        guard relayPhases[relayURL] != .online || relayMessages[relayURL] != nil else { return }
        relayPhases[relayURL] = .online
        relayMessages[relayURL] = nil
        await emitStatus()
    }

    private func emitStatus(state: TaskSyncState? = nil) async {
        let relays = relayPhases.map { relayURL, phase in
            TaskRelayStatus(
                relayURL: relayURL,
                phase: phase,
                message: relayMessages[relayURL]
            )
        }
        let queuedChangeCount = await outbox.entryCount()
        let report = state.map {
            TaskSyncReport(state: $0, relays: relays, queuedChangeCount: queuedChangeCount)
        } ?? TaskSyncReport(relays: relays, queuedChangeCount: queuedChangeCount)
        guard report != lastEmittedReport else { return }
        lastEmittedReport = report
        updateContinuation.yield(.status(report))
    }

    @discardableResult
    func beginSharedInboxReplay(relayURL: String, publicKey: String) -> String {
        let id = inboxSubscriptionID(relayURL: relayURL, publicKey: publicKey)
        pendingSubscriptions[relayURL, default: []].insert(id)
        relayBatches[relayURL, default: [:]][id] = TaskRelayStartupBatch()
        return id
    }

    private func inboxSubscriptionID(relayURL: String, publicKey: String) -> String {
        let relayToken = UInt(bitPattern: relayURL.hashValue)
        return "taskify-inbox-\(relayToken)-\(publicKey.prefix(12))"
    }
}

// MARK: - One-shot lookups over open connections

/// What checking the durable outbox against relays settled.
public struct OutboxRelayAudit: Equatable, Sendable {
    /// Relay deliveries found unnecessary because the relay already holds the change.
    public var settledDeliveries = 0
    /// Queued changes that no relay still needs, and so left the outbox.
    public var completedEntries = 0
    public init(settledDeliveries: Int = 0, completedEntries: Int = 0) {
        self.settledDeliveries = settledDeliveries
        self.completedEntries = completedEntries
    }
}

extension TaskSyncEngine {
    /// Self-healing for the durable outbox: asks each relay what it already holds for queued task
    /// changes and settles the deliveries it doesn't need, so a backlog left by an older build
    /// (tombstones republished by the thousand) drains without sending it again. A delivery is
    /// only settled when the relay's own answer proves it redundant (`relayAlreadyHas`); anything
    /// else stays queued, so no real change is dropped. One request per relay at a time, over the
    /// connections the engine already has open, keeps well inside relays' REQ limits.
    @discardableResult
    public func reconcileOutboxWithRelays(batchSize: Int = 100, timeout: TimeInterval = 12) async -> OutboxRelayAudit {
        guard !outboxAuditRunning else { return OutboxRelayAudit() }
        outboxAuditRunning = true
        defer { outboxAuditRunning = false }
        let entries = await outbox.allEntries().filter {
            $0.event.kind == TaskEventCodec.taskEventKind && $0.dependsOnEventID == nil
        }
        var work: [String: [String: [NostrOutboxEntry]]] = [:]
        for entry in entries {
            for relayURL in entry.pendingRelayURLs {
                work[relayURL, default: [:]][entry.boardLocalID, default: []].append(entry)
            }
        }
        guard !work.isEmpty else { return OutboxRelayAudit() }
        var total = OutboxRelayAudit()
        await withTaskGroup(of: OutboxRelayAudit.self) { group in
            for (relayURL, byBoard) in work {
                group.addTask { [weak self] in
                    await self?.auditOutbox(relayURL: relayURL, byBoard: byBoard, batchSize: batchSize, timeout: timeout)
                        ?? OutboxRelayAudit()
                }
            }
            for await result in group {
                total.settledDeliveries += result.settledDeliveries
                total.completedEntries += result.completedEntries
            }
        }
        if total.settledDeliveries > 0 { await emitStatus() }
        return total
    }

    private func auditOutbox(
        relayURL: String,
        byBoard: [String: [NostrOutboxEntry]],
        batchSize: Int,
        timeout: TimeInterval
    ) async -> OutboxRelayAudit {
        var audit = OutboxRelayAudit()
        for (boardLocalID, boardEntries) in byBoard.sorted(by: { $0.key < $1.key }) {
            guard let board = boards.first(where: { $0.id == boardLocalID }),
                  let author = try? BoardCrypto.signingPublicKey(for: board.effectiveNostrBoardID).hexString else { continue }
            let boardTag = BoardCrypto.boardTag(for: board.effectiveNostrBoardID)
            var start = 0
            while start < boardEntries.count {
                let batch = Array(boardEntries[start..<min(start + max(1, batchSize), boardEntries.count)])
                start += max(1, batchSize)
                guard let connection = connections[relayURL], relayPhases[relayURL] != .offline else { return audit }
                let addresses = Array(Set(batch.compactMap { $0.event.firstTagValue(named: "d") })).sorted()
                guard !addresses.isEmpty else { continue }
                // Headroom for relays that keep several versions of an address.
                let limit = addresses.count * 3
                guard let result = await requestOnce(
                    relayURL: relayURL,
                    connection: connection,
                    filter: NostrRelayFilter(kinds: [TaskEventCodec.taskEventKind], authors: [author], dTags: addresses, limit: limit),
                    timeout: timeout
                ) else { continue }
                // "Nothing stored" is only evidence when the relay finished and nothing was cut off.
                let answeredCompletely = result.completed && result.events.count < limit
                var latest: [String: NostrEvent] = [:]
                for event in result.events
                where event.publicKey == author
                    && event.kind == TaskEventCodec.taskEventKind
                    && event.firstTagValue(named: "b") == boardTag
                    && event.verify() {
                    guard let address = event.firstTagValue(named: "d") else { continue }
                    if let current = latest[address], !Self.replaces(event, current) { continue }
                    latest[address] = event
                }
                for entry in batch {
                    guard let address = entry.event.firstTagValue(named: "d"),
                          Self.relayAlreadyHas(
                              entry.event,
                              relayLatest: latest[address],
                              relayAnsweredCompletely: answeredCompletely,
                              board: board
                          ),
                          await outbox.isPending(eventID: entry.event.id, relayURL: relayURL) else { continue }
                    inFlightEventIDs[relayURL]?.remove(entry.event.id)
                    cancelPublishAcknowledgementTimeoutForAudit(eventID: entry.event.id, relayURL: relayURL)
                    let completed = try? await outbox.markAccepted(eventID: entry.event.id, relayURL: relayURL)
                    audit.settledDeliveries += 1
                    if let completed {
                        audit.completedEntries += 1
                        updateContinuation.yield(.publishState(recordID: completed.taskID, state: .sent))
                    }
                }
            }
        }
        return audit
    }

    /// NIP-01 replaceable ordering: the newer event wins; on a tie, the lower id.
    static func replaces(_ candidate: NostrEvent, _ current: NostrEvent) -> Bool {
        candidate.createdAt != current.createdAt
            ? candidate.createdAt > current.createdAt
            : candidate.id < current.id
    }

    /// Whether a relay whose latest version of the address is `relayLatest` gains nothing from
    /// receiving `ours`:
    /// - it already holds this event, or a version that wins over it;
    /// - ours is a tombstone and the relay already has the task deleted, or (having answered in
    ///   full) has no version of it at all, so there is nothing there to delete;
    /// - ours is a live version with the same content as the relay's.
    static func relayAlreadyHas(
        _ ours: NostrEvent,
        relayLatest: NostrEvent?,
        relayAnsweredCompletely: Bool,
        board: Board
    ) -> Bool {
        let oursIsTombstone = ours.firstTagValue(named: "status") == "deleted"
        guard let relayLatest else { return oursIsTombstone && relayAnsweredCompletely }
        if relayLatest.id == ours.id || replaces(relayLatest, ours) { return true }
        let relayIsTombstone = relayLatest.firstTagValue(named: "status") == "deleted"
        if oursIsTombstone || relayIsTombstone { return oursIsTombstone && relayIsTombstone }
        guard let mine = try? TaskEventCodec.decodeTaskEvent(ours, board: board),
              let theirs = try? TaskEventCodec.decodeTaskEvent(relayLatest, board: board) else { return false }
        var lhs = mine.task
        var rhs = theirs.task
        lhs.nostrUpdatedAt = nil
        rhs.nostrUpdatedAt = nil
        return lhs == rhs
    }

    private func cancelPublishAcknowledgementTimeoutForAudit(eventID: String, relayURL: String) {
        publishAcknowledgementTimeoutTasks[relayURL]?.removeValue(forKey: eventID)?.cancel()
    }
}

extension TaskSyncEngine: NostrOneShotFetching {
    /// Runs a one-shot lookup on the relays this engine already has open, instead of opening a
    /// fresh socket per relay per lookup (their connections are also NIP-42 authenticated). Relays
    /// without an open connection, or that can't take the request, go to the fallback fetcher.
    public func fetchOnce(filter: NostrRelayFilter, relayURLs: [String], timeout: TimeInterval) async -> [NostrEvent] {
        let relays = TaskifyRelayURL.normalizedList(relayURLs)
        var reused: [(String, any TaskSyncRelayTransport)] = []
        var unreached: [String] = []
        for relayURL in relays {
            if let connection = connections[relayURL], relayPhases[relayURL] != .offline {
                reused.append((relayURL, connection))
            } else {
                unreached.append(relayURL)
            }
        }
        var events: [NostrEvent] = []
        var failed: [String] = []
        await withTaskGroup(of: (String, [NostrEvent]?).self) { group in
            for (relayURL, connection) in reused {
                group.addTask {
                    (relayURL, await self.requestOnce(relayURL: relayURL, connection: connection, filter: filter, timeout: timeout)?.events)
                }
            }
            for await (relayURL, batch) in group {
                if let batch { events.append(contentsOf: batch) } else { failed.append(relayURL) }
            }
        }
        let fallbackRelays = unreached + failed
        if !fallbackRelays.isEmpty {
            events.append(contentsOf: await oneShotFallback.fetchOnce(filter: filter, relayURLs: fallbackRelays, timeout: timeout))
        }
        var seen = Set<String>()
        return events.filter { seen.insert($0.id).inserted }
    }

    /// nil when the request couldn't be sent on this connection.
    private func requestOnce(
        relayURL: String,
        connection: any TaskSyncRelayTransport,
        filter: NostrRelayFilter,
        timeout: TimeInterval
    ) async -> OneShotResult? {
        let subscriptionID = "once-\(UUID().uuidString)"
        do {
            // Registered before the REQ goes out so no reply can arrive unrouted.
            return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<OneShotResult, Error>) in
                oneShotRequests[subscriptionID] = OneShotRequest(
                    relayURL: relayURL,
                    events: [],
                    continuation: continuation
                )
                Task {
                    do {
                        try await connection.request(id: subscriptionID, filter: filter)
                    } catch {
                        self.failOneShot(subscriptionID, error: error)
                        return
                    }
                    try? await Task.sleep(nanoseconds: UInt64(max(0.25, timeout) * 1_000_000_000))
                    self.finishOneShot(subscriptionID)
                }
            }
        } catch {
            return nil
        }
    }

    private func finishOneShot(_ subscriptionID: String) {
        guard let request = oneShotRequests.removeValue(forKey: subscriptionID) else { return }
        request.continuation.resume(returning: OneShotResult(events: request.events, completed: request.completed))
        if let connection = connections[request.relayURL] {
            Task { try? await connection.closeSubscription(id: subscriptionID) }
        }
    }

    private func failOneShot(_ subscriptionID: String, error: Error) {
        guard let request = oneShotRequests.removeValue(forKey: subscriptionID) else { return }
        request.continuation.resume(throwing: error)
    }

    /// Consumes relay messages that belong to a one-shot lookup. Returns whether it did.
    func routeOneShotMessage(_ message: NostrRelayMessage, from relayURL: String) -> Bool {
        switch message {
        case .event(let subscriptionID, let event):
            guard oneShotRequests[subscriptionID]?.relayURL == relayURL else { return false }
            oneShotRequests[subscriptionID]?.events.append(event)
            return true
        case .endOfStoredEvents(let subscriptionID):
            guard oneShotRequests[subscriptionID]?.relayURL == relayURL else { return false }
            oneShotRequests[subscriptionID]?.completed = true
            finishOneShot(subscriptionID)
            return true
        case .closed(let subscriptionID, _):
            guard oneShotRequests[subscriptionID]?.relayURL == relayURL else { return false }
            finishOneShot(subscriptionID)
            return true
        case .disconnected:
            for (subscriptionID, request) in oneShotRequests where request.relayURL == relayURL {
                finishOneShot(subscriptionID)
            }
            return false
        default:
            return false
        }
    }
}
