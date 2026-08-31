import Foundation

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

    public init(
        event: NostrEvent,
        relayURLs: [String],
        outboxScope: String,
        recordID: String,
        acknowledgementPolicy: NostrOutboxAcknowledgementPolicy = .everyRelay,
        expiresAt: Date? = nil
    ) {
        self.event = event
        self.relayURLs = TaskifyRelayURL.normalizedList(relayURLs)
        self.outboxScope = outboxScope
        self.recordID = recordID
        self.acknowledgementPolicy = acknowledgementPolicy
        self.expiresAt = expiresAt
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
    /// Initial NIP-17 inbox history is expensive to authenticate and decrypt. Deliver the
    /// stored-event replay as a batch so the app can do that crypto away from the UI thread.
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

// NIP-11 does not advertise publish throughput. Keep healthy relays responsive,
// then adapt this relay's pace when NIP-01 reports a `rate-limited:` rejection.
struct RelayPublishPacer: Equatable, Sendable {
    let defaultInterval: TimeInterval
    let baseBackoff: TimeInterval
    let maximumBackoff: TimeInterval
    private(set) var currentInterval: TimeInterval
    private(set) var nextPublishAt: TimeInterval = 0
    private(set) var consecutiveRateLimits = 0
    private var acceptedSinceRateLimit = 0

    init(
        defaultInterval: TimeInterval = 0.05,
        baseBackoff: TimeInterval = 2,
        maximumBackoff: TimeInterval = 30
    ) {
        self.defaultInterval = defaultInterval
        self.baseBackoff = baseBackoff
        self.maximumBackoff = maximumBackoff
        currentInterval = defaultInterval
    }

    func delayBeforePublish(at now: TimeInterval) -> TimeInterval {
        max(0, nextPublishAt - now)
    }

    mutating func recordPublish(at now: TimeInterval) {
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

enum NostrRelayRejection {
    static func isRateLimited(_ message: String) -> Bool {
        message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix("rate-limited:")
    }

    /// NIP-42: relay is refusing an action until the client authenticates via `AUTH`.
    static func isAuthRequired(_ message: String) -> Bool {
        message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix("auth-required:")
    }
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
        inboxRelayURLs: [String]? = nil
    ) {
        let normalizedAuxiliaryRelays = TaskifyRelayURL.normalizedList(auxiliaryRelayURLs)
        let normalizedInboxRelays = inboxRelayURLs.map(TaskifyRelayURL.normalizedList)
        let normalizedInboxPublicKey = inboxPublicKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let wantedRelays = Set(
            boards.flatMap(\.effectiveRelayURLs)
                + normalizedAuxiliaryRelays
                + (normalizedInboxRelays ?? [])
        )
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

public actor TaskSyncEngine {
    private let outbox: NostrOutboxStore
    private let updateStream: AsyncStream<TaskSyncUpdate>
    private let updateContinuation: AsyncStream<TaskSyncUpdate>.Continuation
    private var boards: [Board] = []
    private var auxiliaryRelayURLs: [String] = []
    private var inboxPublicKey: String?
    private var inboxRelayURLs: Set<String> = []
    private var connections: [String: NostrRelayConnection] = [:]
    private var listenerTasks: [String: Task<Void, Never>] = [:]
    private var reconnectTasks: [String: Task<Void, Never>] = [:]
    private var reconnectAttempts: [String: Int] = [:]
    private var pendingSubscriptions: [String: Set<String>] = [:]
    private var relayBatches: [String: [String: TaskRelayStartupBatch]] = [:]
    private var relayPhases: [String: TaskRelayPhase] = [:]
    private var relayMessages: [String: String] = [:]
    private var publishPacers: [String: RelayPublishPacer] = [:]
    private var rateLimitRetryTasks: [String: Task<Void, Never>] = [:]
    // Per-subscription retries for CLOSED "rate-limited: ..." — NIP-01 scopes that message to
    // the one REQ, so only that subscription is resent rather than tearing down the connection.
    private var subscriptionRateLimitRetryTasks: [String: Task<Void, Never>] = [:]
    private var subscriptionRateLimitAttempts: [String: Int] = [:]
    // NIP-42 authentication state, keyed by relayURL.
    private var identity: NostrIdentity?
    private var relayAuthChallenges: [String: String] = [:]
    private var relayAuthEventIDs: [String: String] = [:]
    private var pendingAuthResubscriptions: [String: Set<String>] = [:]
    private var activeRelayDrains: Set<String> = []
    private var requestedRelayDrains: Set<String> = []
    private var inFlightEventIDs: [String: Set<String>] = [:]
    private var deliveredSharedInboxEventIDs: Set<String> = []
    private var deliveredSharedInboxEventIDOrder: [String] = []
    // The same board/task/calendar event is stored on every relay the board syncs to, so an
    // account on N relays receives N copies of each event. Without this, every copy was handed
    // to the app and merged again — N times the work for one change.
    private var deliveredEventIDs: Set<String> = []
    private var deliveredEventIDOrder: [String] = []
    private var configurationFingerprint: TaskSyncConfigurationFingerprint?
    private var isCheckingForegroundRelayHealth = false
    private var scheduledOutboxFlushTask: Task<Void, Never>?

    public init(outbox: NostrOutboxStore = NostrOutboxStore()) {
        self.outbox = outbox
        let pair = AsyncStream.makeStream(
            of: TaskSyncUpdate.self,
            bufferingPolicy: .bufferingNewest(512)
        )
        updateStream = pair.stream
        updateContinuation = pair.continuation
    }

    deinit {
        listenerTasks.values.forEach { $0.cancel() }
        reconnectTasks.values.forEach { $0.cancel() }
        rateLimitRetryTasks.values.forEach { $0.cancel() }
        subscriptionRateLimitRetryTasks.values.forEach { $0.cancel() }
        scheduledOutboxFlushTask?.cancel()
        updateContinuation.finish()
    }

    public nonisolated func updates() -> AsyncStream<TaskSyncUpdate> {
        updateStream
    }

    /// The identity used to sign NIP-42 `AUTH` responses. Relays that never challenge us never
    /// need this; relays that do get an exemption from tighter rate limits once authenticated.
    public func setIdentity(_ identity: NostrIdentity?) async {
        self.identity = identity
    }

    public func configure(
        boards: [Board],
        auxiliaryRelayURLs: [String] = [],
        inboxPublicKey: String? = nil,
        inboxRelayURLs: [String]? = nil
    ) async {
        let fingerprint = TaskSyncConfigurationFingerprint(
            boards: boards,
            auxiliaryRelayURLs: auxiliaryRelayURLs,
            inboxPublicKey: inboxPublicKey,
            inboxRelayURLs: inboxRelayURLs
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
            deliveredSharedInboxEventIDs.removeAll()
            deliveredSharedInboxEventIDOrder.removeAll()
            deliveredEventIDs.removeAll()
            deliveredEventIDOrder.removeAll()
        }
        self.inboxPublicKey = normalizedInboxPublicKey
        guard !subscriptionsAreUnchanged else { return }
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
        )
        self.inboxRelayURLs = Set(normalizedInboxRelayURLs ?? Array(wantedRelays))

        for relayURL in Set(connections.keys).subtracting(wantedRelays) {
            listenerTasks.removeValue(forKey: relayURL)?.cancel()
            reconnectTasks.removeValue(forKey: relayURL)?.cancel()
            rateLimitRetryTasks.removeValue(forKey: relayURL)?.cancel()
            reconnectAttempts.removeValue(forKey: relayURL)
            pendingSubscriptions.removeValue(forKey: relayURL)
            relayBatches.removeValue(forKey: relayURL)
            relayPhases.removeValue(forKey: relayURL)
            relayMessages.removeValue(forKey: relayURL)
            publishPacers.removeValue(forKey: relayURL)
            requestedRelayDrains.remove(relayURL)
            inFlightEventIDs.removeValue(forKey: relayURL)
            relayAuthChallenges.removeValue(forKey: relayURL)
            relayAuthEventIDs.removeValue(forKey: relayURL)
            pendingAuthResubscriptions.removeValue(forKey: relayURL)
            for key in subscriptionRateLimitRetryTasks.keys where key.hasPrefix("\(relayURL)#") {
                subscriptionRateLimitRetryTasks.removeValue(forKey: key)?.cancel()
                subscriptionRateLimitAttempts.removeValue(forKey: key)
            }
            if let connection = connections.removeValue(forKey: relayURL) {
                await connection.disconnect()
            }
        }

        var newlyCreatedRelays: Set<String> = []
        for relayURL in wantedRelays where connections[relayURL] == nil {
            let connection = NostrRelayConnection(relayURL: relayURL)
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
        _ connection: NostrRelayConnection,
        relayURL: String,
        previousPlan: TaskSyncRelaySubscriptionPlan?,
        nextPlan: TaskSyncRelaySubscriptionPlan
    ) async throws {
        try await connection.connect()
        let previousBoardTags = Set(previousPlan?.boardTags ?? [])
        let nextBoardTags = Set(nextPlan.boardTags)

        for boardTag in previousBoardTags.subtracting(nextBoardTags) {
            let id = subscriptionID(relayURL: relayURL, boardTag: boardTag)
            try? await connection.closeSubscription(id: id)
            pendingSubscriptions[relayURL]?.remove(id)
            relayBatches[relayURL]?.removeValue(forKey: id)
        }
        for boardTag in nextBoardTags.subtracting(previousBoardTags) {
            let id = subscriptionID(relayURL: relayURL, boardTag: boardTag)
            pendingSubscriptions[relayURL, default: []].insert(id)
            relayBatches[relayURL, default: [:]][id] = TaskRelayStartupBatch()
            try await connection.subscribe(
                id: id,
                kinds: [
                    TaskEventCodec.boardEventKind,
                    TaskEventCodec.taskEventKind,
                    TaskifyCalendarEventCodec.canonicalEventKind,
                ],
                boardTag: boardTag
            )
        }

        guard previousPlan?.inboxPublicKey != nextPlan.inboxPublicKey else { return }
        if let previousInboxKey = previousPlan?.inboxPublicKey {
            let id = inboxSubscriptionID(relayURL: relayURL, publicKey: previousInboxKey)
            try? await connection.closeSubscription(id: id)
            pendingSubscriptions[relayURL]?.remove(id)
            relayBatches[relayURL]?.removeValue(forKey: id)
        }
        if let nextInboxKey = nextPlan.inboxPublicKey {
            let id = inboxSubscriptionID(relayURL: relayURL, publicKey: nextInboxKey)
            pendingSubscriptions[relayURL, default: []].insert(id)
            relayBatches[relayURL, default: [:]][id] = TaskRelayStartupBatch()
            try await connection.subscribeToSharedInbox(
                id: id,
                recipientPublicKey: nextInboxKey,
                since: Int(Date().timeIntervalSince1970) - (30 * 24 * 60 * 60),
                limit: 500
            )
        }
    }

    public func stop() async {
        listenerTasks.values.forEach { $0.cancel() }
        listenerTasks.removeAll()
        reconnectTasks.values.forEach { $0.cancel() }
        reconnectTasks.removeAll()
        rateLimitRetryTasks.values.forEach { $0.cancel() }
        rateLimitRetryTasks.removeAll()
        subscriptionRateLimitRetryTasks.values.forEach { $0.cancel() }
        subscriptionRateLimitRetryTasks.removeAll()
        subscriptionRateLimitAttempts.removeAll()
        scheduledOutboxFlushTask?.cancel()
        scheduledOutboxFlushTask = nil
        reconnectAttempts.removeAll()
        for connection in connections.values {
            await connection.disconnect()
        }
        connections.removeAll()
        pendingSubscriptions.removeAll()
        relayBatches.removeAll()
        relayPhases.removeAll()
        relayMessages.removeAll()
        publishPacers.removeAll()
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
        subscriptionRateLimitRetryTasks.values.forEach { $0.cancel() }
        subscriptionRateLimitRetryTasks.removeAll()
        subscriptionRateLimitAttempts.removeAll()
        reconnectAttempts.removeAll()
        pendingSubscriptions.removeAll()
        relayBatches.removeAll()
        inFlightEventIDs.removeAll()
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

    public func publish(
        _ event: NostrEvent,
        board: Board,
        taskID: String
    ) async throws {
        let entry = NostrOutboxEntry(
            event: event,
            relayURLs: board.effectiveRelayURLs,
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
        let normalizedRelays = TaskifyRelayURL.normalizedList(relayURLs)
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

    public func queueForPublish(_ requests: [TaskSyncPublishRequest]) async throws {
        let entries = requests.map { request in
            NostrOutboxEntry(
                event: request.event,
                relayURLs: request.board.effectiveRelayURLs,
                boardLocalID: request.board.id,
                taskID: request.taskID
            )
        }
        try await outbox.enqueue(entries)
        await emitStatus()
    }

    /// Atomically persists a group of relay publications, reports them as queued, and schedules
    /// delivery without making the caller wait behind existing relay backlog or rate limits.
    public func enqueueForPublish(_ requests: [TaskSyncRelayPublishRequest]) async throws {
        let entries = requests.compactMap { request -> NostrOutboxEntry? in
            guard !request.relayURLs.isEmpty else { return nil }
            return NostrOutboxEntry(
                event: request.event,
                relayURLs: request.relayURLs,
                boardLocalID: request.outboxScope,
                taskID: request.recordID,
                acknowledgementPolicy: request.acknowledgementPolicy,
                expiresAt: request.expiresAt
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
        await outbox.allEntries().count
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
        _ connection: NostrRelayConnection,
        relayURL: String
    ) async throws {
        try await connection.connect()
        for board in boards where board.effectiveRelayURLs.contains(relayURL) {
            let boardTag = BoardCrypto.boardTag(for: board.effectiveNostrBoardID)
            let id = subscriptionID(relayURL: relayURL, boardTag: boardTag)
            pendingSubscriptions[relayURL, default: []].insert(id)
            relayBatches[relayURL, default: [:]][id] = TaskRelayStartupBatch()
            try await connection.subscribe(
                id: id,
                kinds: [
                    TaskEventCodec.boardEventKind,
                    TaskEventCodec.taskEventKind,
                    TaskifyCalendarEventCodec.canonicalEventKind,
                ],
                boardTag: boardTag
            )
        }
        if let inboxPublicKey,
           inboxPublicKey.count == 64,
           inboxRelayURLs.contains(relayURL) {
            let id = inboxSubscriptionID(relayURL: relayURL, publicKey: inboxPublicKey)
            pendingSubscriptions[relayURL, default: []].insert(id)
            relayBatches[relayURL, default: [:]][id] = TaskRelayStartupBatch()
            try await connection.subscribeToSharedInbox(
                id: id,
                recipientPublicKey: inboxPublicKey,
                since: Int(Date().timeIntervalSince1970) - (30 * 24 * 60 * 60),
                limit: 500
            )
        }
    }

    private func flushOutbox() async {
        if let expired = try? await outbox.removeExpired() {
            for entry in expired {
                updateContinuation.yield(.publishState(
                    recordID: entry.taskID,
                    state: .failed("Delivery expired before a relay accepted it.")
                ))
            }
        }
        let entries = await outbox.allEntries()
        let relayURLs = Set(entries.flatMap(\.pendingRelayURLs))
        await withTaskGroup(of: Void.self) { group in
            for relayURL in relayURLs {
                group.addTask { [weak self] in
                    await self?.flushOutbox(to: relayURL)
                }
            }
        }
    }

    private func scheduleOutboxFlush() {
        guard scheduledOutboxFlushTask == nil else { return }
        scheduledOutboxFlushTask = Task { [weak self] in
            await Task.yield()
            await self?.runScheduledOutboxFlush()
        }
    }

    private func runScheduledOutboxFlush() async {
        await flushOutbox()
        scheduledOutboxFlushTask = nil
        await emitStatus()
    }

    private func flushOutbox(to relayURL: String) async {
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
            let entries = await outbox.allEntries()
            for entry in entries where entry.pendingRelayURLs.contains(relayURL) {
                await send(entry, to: relayURL)
            }
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
              await outbox.isPending(eventID: entry.event.id, relayURL: relayURL) else { return }
        guard await waitForPublishWindow(relayURL: relayURL) else { return }
        guard let connection = connections[relayURL],
              await outbox.isPending(eventID: entry.event.id, relayURL: relayURL),
              inFlightEventIDs[relayURL]?.contains(entry.event.id) != true else { return }
        inFlightEventIDs[relayURL, default: []].insert(entry.event.id)
        do {
            try await connection.publish(entry.event)
            if relayPhases[relayURL] != .online {
                relayPhases[relayURL] = .syncing
            }
            if rateLimitRetryTasks[relayURL] == nil {
                relayMessages[relayURL] = nil
            }
        } catch {
            inFlightEventIDs[relayURL]?.remove(entry.event.id)
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = error.localizedDescription
            scheduleReconnect(relayURL: relayURL)
        }
    }

    private func waitForPublishWindow(relayURL: String) async -> Bool {
        while !Task.isCancelled {
            let now = ProcessInfo.processInfo.systemUptime
            var pacer = publishPacers[relayURL] ?? RelayPublishPacer()
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

    private func handle(_ message: NostrRelayMessage, from relayURL: String) async {
        switch message {
        case .event(let subscriptionID, let event):
            await markRelayOnline(relayURL)
            if event.kind == NIP17GiftWrap.wrapKind,
               subscriptionID == inboxSubscriptionID(
                   relayURL: relayURL,
                   publicKey: inboxPublicKey ?? ""
               ) {
                if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
                    var subscriptions = relayBatches[relayURL] ?? [:]
                    var batch = subscriptions[subscriptionID] ?? TaskRelayStartupBatch()
                    batch.insert(sharedInboxEvent: event)
                    subscriptions[subscriptionID] = batch
                    relayBatches[relayURL] = subscriptions
                } else if recordSharedInboxEventIfNew(event) {
                    updateContinuation.yield(.sharedInbox(event))
                }
                return
            }
            guard let boardTag = event.firstTagValue(named: "b"),
                  let boardIndex = boards.firstIndex(where: {
                      BoardCrypto.boardTag(for: $0.effectiveNostrBoardID) == boardTag &&
                      $0.effectiveRelayURLs.contains(relayURL)
                  }) else { return }
            let board = boards[boardIndex]

            if event.kind == TaskEventCodec.boardEventKind {
                guard let record = try? TaskEventCodec.decodeBoardEvent(event, board: board),
                      event.createdAt > (board.nostrUpdatedAt ?? 0),
                      recordEventIfNew(event.id) else { return }
                boards[boardIndex] = record.board
                updateContinuation.yield(.board(record))
                return
            }


            if event.kind == TaskifyCalendarEventCodec.canonicalEventKind {
                guard let record = try? TaskifyCalendarEventCodec.decodeCanonicalEvent(
                    event,
                    board: board
                ), recordEventIfNew(event.id) else { return }
                if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
                    var subscriptions = relayBatches[relayURL] ?? [:]
                    var batch = subscriptions[subscriptionID] ?? TaskRelayStartupBatch()
                    batch.insert(record)
                    subscriptions[subscriptionID] = batch
                    relayBatches[relayURL] = subscriptions
                } else {
                    updateContinuation.yield(.calendarEvent(record))
                }
                return
            }

            guard let record = try? TaskEventCodec.decodeTaskEvent(event, board: board),
                  recordEventIfNew(event.id) else { return }
            if pendingSubscriptions[relayURL]?.contains(subscriptionID) == true {
                var subscriptions = relayBatches[relayURL] ?? [:]
                var batch = subscriptions[subscriptionID] ?? TaskRelayStartupBatch()
                batch.insert(record)
                subscriptions[subscriptionID] = batch
                relayBatches[relayURL] = subscriptions
            } else {
                updateContinuation.yield(.task(record))
            }
        case .acknowledgement(let eventID, let accepted, let message):
            if relayAuthEventIDs[relayURL] == eventID {
                relayAuthEventIDs[relayURL] = nil
                if accepted {
                    relayMessages[relayURL] = nil
                    if let subscriptionIDs = pendingAuthResubscriptions.removeValue(forKey: relayURL) {
                        for subscriptionID in subscriptionIDs {
                            try? await resubscribe(subscriptionID: subscriptionID, relayURL: relayURL)
                        }
                    }
                    await markRelayOnline(relayURL)
                    await flushOutbox(to: relayURL)
                } else {
                    pendingAuthResubscriptions.removeValue(forKey: relayURL)
                    relayPhases[relayURL] = .offline
                    relayMessages[relayURL] = message
                    await emitStatus()
                    scheduleReconnect(relayURL: relayURL)
                }
                return
            }
            inFlightEventIDs[relayURL]?.remove(eventID)
            let isDuplicate = message
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
                .hasPrefix("duplicate:")
            if accepted || isDuplicate {
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
                var pacer = publishPacers[relayURL] ?? RelayPublishPacer()
                pacer.recordAccepted()
                publishPacers[relayURL] = pacer
                if rateLimitRetryTasks[relayURL] == nil {
                    await markRelayOnline(relayURL)
                } else {
                    relayPhases[relayURL] = .syncing
                    await emitStatus()
                }
            } else if NostrRelayRejection.isRateLimited(message) {
                await registerRateLimit(message: message, relayURL: relayURL)
            } else if NostrRelayRejection.isAuthRequired(message) {
                await handleAuthRequired(relayURL: relayURL)
            } else {
                relayPhases[relayURL] = .offline
                relayMessages[relayURL] = message
                await emitStatus()
            }
        case .disconnected(let message):
            inFlightEventIDs.removeValue(forKey: relayURL)
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
            relayAuthChallenges[relayURL] = challenge
            await authenticate(relayURL: relayURL, challenge: challenge)
        case .closed(let subscriptionID, let message) where NostrRelayRejection.isRateLimited(message):
            await handleRateLimitedClose(subscriptionID: subscriptionID, relayURL: relayURL)
        case .closed(let subscriptionID, let message) where NostrRelayRejection.isAuthRequired(message):
            await handleAuthRequiredClose(subscriptionID: subscriptionID, relayURL: relayURL)
        case .closed(_, let message):
            inFlightEventIDs.removeValue(forKey: relayURL)
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = message
            await emitStatus()
            scheduleReconnect(relayURL: relayURL)
        case .endOfStoredEvents(let subscriptionID):
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

    /// Recorded only after a successful decode, so a relay that hands us a corrupt or
    /// undecryptable copy never prevents a healthy copy from another relay being processed.
    private func recordEventIfNew(_ eventID: String) -> Bool {
        guard deliveredEventIDs.insert(eventID).inserted else { return false }
        deliveredEventIDOrder.append(eventID)
        let maximumRememberedEventCount = 5_000
        if deliveredEventIDOrder.count > maximumRememberedEventCount {
            let overflow = deliveredEventIDOrder.count - maximumRememberedEventCount
            for expiredID in deliveredEventIDOrder.prefix(overflow) {
                deliveredEventIDs.remove(expiredID)
            }
            deliveredEventIDOrder.removeFirst(overflow)
        }
        return true
    }

    private func recordSharedInboxEventIfNew(_ event: NostrEvent) -> Bool {
        guard deliveredSharedInboxEventIDs.insert(event.id).inserted else { return false }
        deliveredSharedInboxEventIDOrder.append(event.id)
        let maximumRememberedEventCount = 2_000
        if deliveredSharedInboxEventIDOrder.count > maximumRememberedEventCount {
            let overflow = deliveredSharedInboxEventIDOrder.count - maximumRememberedEventCount
            for expiredID in deliveredSharedInboxEventIDOrder.prefix(overflow) {
                deliveredSharedInboxEventIDs.remove(expiredID)
            }
            deliveredSharedInboxEventIDOrder.removeFirst(overflow)
        }
        return true
    }

    private func scheduleReconnect(relayURL: String) {
        guard reconnectTasks[relayURL] == nil, connections[relayURL] != nil else { return }
        let attempt = reconnectAttempts[relayURL, default: 0]
        reconnectAttempts[relayURL] = attempt + 1
        let delay = min(1 << min(attempt, 5), 30)
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
        var pacer = publishPacers[relayURL] ?? RelayPublishPacer()
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

    /// NIP-01: a `CLOSED "rate-limited: ..."` scopes the back-off to the one REQ that triggered
    /// it, not the whole connection. Re-sends just that subscription instead of the full
    /// disconnect/reconnect/resubscribe-everything the generic CLOSED path performs.
    private func handleRateLimitedClose(subscriptionID: String, relayURL: String) async {
        let key = subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        guard subscriptionRateLimitRetryTasks[key] == nil else { return }
        let attempt = subscriptionRateLimitAttempts[key, default: 0]
        subscriptionRateLimitAttempts[key] = attempt + 1
        let delay = min(1 << min(attempt, 5), 30)
        if relayPhases[relayURL] != .online {
            relayPhases[relayURL] = .syncing
        }
        relayMessages[relayURL] = "Rate limited • retrying subscription in \(delay)s"
        await emitStatus()
        subscriptionRateLimitRetryTasks[key] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.retrySubscriptionAfterRateLimit(subscriptionID: subscriptionID, relayURL: relayURL)
        }
    }

    private func retrySubscriptionAfterRateLimit(subscriptionID: String, relayURL: String) async {
        let key = subscriptionRetryKey(relayURL: relayURL, subscriptionID: subscriptionID)
        subscriptionRateLimitRetryTasks[key] = nil
        guard connections[relayURL] != nil else { return }
        do {
            try await resubscribe(subscriptionID: subscriptionID, relayURL: relayURL)
            subscriptionRateLimitAttempts[key] = nil
            if relayMessages[relayURL]?.hasPrefix("Rate limited") == true {
                relayMessages[relayURL] = nil
                await emitStatus()
            }
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

    /// Re-issues the REQ for a single subscription ID without touching any other subscription
    /// on the relay. Used after a rate-limited or auth-required CLOSED.
    private func resubscribe(subscriptionID: String, relayURL: String) async throws {
        guard let connection = connections[relayURL] else { throw URLError(.notConnectedToInternet) }
        for board in boards where board.effectiveRelayURLs.contains(relayURL) {
            let boardTag = BoardCrypto.boardTag(for: board.effectiveNostrBoardID)
            guard self.subscriptionID(relayURL: relayURL, boardTag: boardTag) == subscriptionID else { continue }
            pendingSubscriptions[relayURL, default: []].insert(subscriptionID)
            relayBatches[relayURL, default: [:]][subscriptionID] = TaskRelayStartupBatch()
            try await connection.subscribe(
                id: subscriptionID,
                kinds: [
                    TaskEventCodec.boardEventKind,
                    TaskEventCodec.taskEventKind,
                    TaskifyCalendarEventCodec.canonicalEventKind,
                ],
                boardTag: boardTag
            )
            return
        }
        if let inboxPublicKey,
           inboxPublicKey.count == 64,
           inboxRelayURLs.contains(relayURL),
           inboxSubscriptionID(relayURL: relayURL, publicKey: inboxPublicKey) == subscriptionID {
            pendingSubscriptions[relayURL, default: []].insert(subscriptionID)
            relayBatches[relayURL, default: [:]][subscriptionID] = TaskRelayStartupBatch()
            try await connection.subscribeToSharedInbox(
                id: subscriptionID,
                recipientPublicKey: inboxPublicKey,
                since: Int(Date().timeIntervalSince1970) - (30 * 24 * 60 * 60),
                limit: 500
            )
            return
        }
        throw URLError(.badURL)
    }

    /// NIP-42: sign and send the relay's challenge back as an `AUTH` event so it can grant this
    /// pubkey any rate-limit exemption it offers to known/authenticated clients.
    private func authenticate(relayURL: String, challenge: String) async {
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
        do {
            try await connection.authenticate(event)
        } catch {
            relayAuthEventIDs[relayURL] = nil
            relayMessages[relayURL] = error.localizedDescription
            await emitStatus()
        }
    }

    private func handleAuthRequired(relayURL: String) async {
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
        pendingAuthResubscriptions[relayURL, default: []].insert(subscriptionID)
        await handleAuthRequired(relayURL: relayURL)
    }

    private func reconnectAfterDelay(relayURL: String) async {
        reconnectTasks[relayURL] = nil
        await reconnect(relayURL: relayURL)
    }

    private func resetForForegroundReconnect(relayURL: String) async {
        reconnectTasks.removeValue(forKey: relayURL)?.cancel()
        rateLimitRetryTasks.removeValue(forKey: relayURL)?.cancel()
        reconnectAttempts[relayURL] = 0
        pendingSubscriptions.removeValue(forKey: relayURL)
        relayBatches.removeValue(forKey: relayURL)
        inFlightEventIDs.removeValue(forKey: relayURL)
        relayAuthChallenges.removeValue(forKey: relayURL)
        relayAuthEventIDs.removeValue(forKey: relayURL)
        pendingAuthResubscriptions.removeValue(forKey: relayURL)
        for key in subscriptionRateLimitRetryTasks.keys where key.hasPrefix("\(relayURL)#") {
            subscriptionRateLimitRetryTasks.removeValue(forKey: key)?.cancel()
            subscriptionRateLimitAttempts.removeValue(forKey: key)
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
            reconnectAttempts[relayURL] = 0
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
        reconnectAttempts[relayURL] = 0
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
        let queuedChangeCount = await outbox.allEntries().count
        let report = state.map {
            TaskSyncReport(state: $0, relays: relays, queuedChangeCount: queuedChangeCount)
        } ?? TaskSyncReport(relays: relays, queuedChangeCount: queuedChangeCount)
        updateContinuation.yield(.status(report))
    }

    private func subscriptionID(relayURL: String, boardTag: String) -> String {
        let relayToken = abs(relayURL.hashValue)
        return "taskify-\(relayToken)-\(boardTag.prefix(16))"
    }

    private func inboxSubscriptionID(relayURL: String, publicKey: String) -> String {
        let relayToken = abs(relayURL.hashValue)
        return "taskify-inbox-\(relayToken)-\(publicKey.prefix(12))"
    }
}
