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

public enum TaskSyncUpdate: Sendable {
    case board(BoardRelayRecord)
    case task(TaskRelayRecord)
    case status(TaskSyncReport)
}

struct TaskRelayStartupBatch: Sendable {
    private var recordsByTaskID: [String: TaskRelayRecord] = [:]

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
}

public actor TaskSyncEngine {
    private let outbox: NostrOutboxStore
    private let updateStream: AsyncStream<TaskSyncUpdate>
    private let updateContinuation: AsyncStream<TaskSyncUpdate>.Continuation
    private var boards: [Board] = []
    private var connections: [String: NostrRelayConnection] = [:]
    private var listenerTasks: [String: Task<Void, Never>] = [:]
    private var reconnectTasks: [String: Task<Void, Never>] = [:]
    private var reconnectAttempts: [String: Int] = [:]
    private var pendingSubscriptions: [String: Set<String>] = [:]
    private var relayBatches: [String: [String: TaskRelayStartupBatch]] = [:]
    private var relayPhases: [String: TaskRelayPhase] = [:]
    private var relayMessages: [String: String] = [:]

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
        updateContinuation.finish()
    }

    public nonisolated func updates() -> AsyncStream<TaskSyncUpdate> {
        updateStream
    }

    public func configure(boards: [Board]) async {
        self.boards = boards
        let wantedRelays = Set(self.boards.flatMap(\.effectiveRelayURLs))

        for relayURL in Set(connections.keys).subtracting(wantedRelays) {
            listenerTasks.removeValue(forKey: relayURL)?.cancel()
            reconnectTasks.removeValue(forKey: relayURL)?.cancel()
            reconnectAttempts.removeValue(forKey: relayURL)
            pendingSubscriptions.removeValue(forKey: relayURL)
            relayBatches.removeValue(forKey: relayURL)
            relayPhases.removeValue(forKey: relayURL)
            relayMessages.removeValue(forKey: relayURL)
            if let connection = connections.removeValue(forKey: relayURL) {
                await connection.disconnect()
            }
        }

        for relayURL in wantedRelays where connections[relayURL] == nil {
            let connection = NostrRelayConnection(relayURL: relayURL)
            connections[relayURL] = connection
            let stream = connection.messages()
            listenerTasks[relayURL] = Task { [weak self] in
                for await message in stream {
                    guard !Task.isCancelled else { return }
                    await self?.handle(message, from: relayURL)
                }
            }
        }

        for relayURL in wantedRelays {
            relayPhases[relayURL] = .connecting
            relayMessages[relayURL] = nil
        }
        await emitStatus()

        for relayURL in connections.keys.sorted() {
            guard let connection = connections[relayURL] else { continue }
            do {
                try await connectAndSubscribe(connection, relayURL: relayURL)
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
        await flushOutbox()
        await emitStatus()
    }

    public func stop() async {
        listenerTasks.values.forEach { $0.cancel() }
        listenerTasks.removeAll()
        reconnectTasks.values.forEach { $0.cancel() }
        reconnectTasks.removeAll()
        reconnectAttempts.removeAll()
        for connection in connections.values {
            await connection.disconnect()
        }
        connections.removeAll()
        pendingSubscriptions.removeAll()
        relayBatches.removeAll()
        relayPhases.removeAll()
        relayMessages.removeAll()
        await emitStatus(state: .stopped)
    }

    public func retryNow() async {
        reconnectTasks.values.forEach { $0.cancel() }
        reconnectTasks.removeAll()
        reconnectAttempts.removeAll()
        pendingSubscriptions.removeAll()
        relayBatches.removeAll()
        for connection in connections.values {
            await connection.disconnect()
        }
        await configure(boards: boards)
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
                kinds: [TaskEventCodec.boardEventKind, TaskEventCodec.taskEventKind],
                boardTag: boardTag
            )
        }
    }

    private func flushOutbox() async {
        let entries = await outbox.allEntries()
        for entry in entries { await send(entry) }
    }

    private func send(_ entry: NostrOutboxEntry) async {
        for relayURL in entry.relayURLs {
            guard let connection = connections[relayURL] else { continue }
            do {
                try await connection.publish(entry.event)
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
        await emitStatus()
    }

    private func handle(_ message: NostrRelayMessage, from relayURL: String) async {
        switch message {
        case .event(let subscriptionID, let event):
            await markRelayOnline(relayURL)
            guard let boardTag = event.firstTagValue(named: "b"),
                  let boardIndex = boards.firstIndex(where: {
                      BoardCrypto.boardTag(for: $0.effectiveNostrBoardID) == boardTag &&
                      $0.effectiveRelayURLs.contains(relayURL)
                  }) else { return }
            let board = boards[boardIndex]

            if event.kind == TaskEventCodec.boardEventKind {
                guard let record = try? TaskEventCodec.decodeBoardEvent(event, board: board),
                      event.createdAt > (board.nostrUpdatedAt ?? 0) else { return }
                boards[boardIndex] = record.board
                updateContinuation.yield(.board(record))
                return
            }

            guard let record = try? TaskEventCodec.decodeTaskEvent(event, board: board) else { return }
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
            let isDuplicate = message
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
                .hasPrefix("duplicate:")
            if accepted || isDuplicate {
                try? await outbox.markAccepted(eventID: eventID)
                await markRelayOnline(relayURL)
            } else {
                relayPhases[relayURL] = .offline
                relayMessages[relayURL] = message
                await emitStatus()
            }
        case .disconnected(let message):
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = message
            await emitStatus()
            scheduleReconnect(relayURL: relayURL)
        case .notice(let message):
            relayMessages[relayURL] = message
            await emitStatus()
        case .closed(_, let message):
            relayPhases[relayURL] = .offline
            relayMessages[relayURL] = message
            await emitStatus()
            scheduleReconnect(relayURL: relayURL)
        case .endOfStoredEvents(let subscriptionID):
            var batch = relayBatches[relayURL]?[subscriptionID] ?? TaskRelayStartupBatch()
            let records = batch.drain()
            relayBatches[relayURL]?[subscriptionID] = nil
            pendingSubscriptions[relayURL]?.remove(subscriptionID)
            for record in records {
                updateContinuation.yield(.task(record))
            }
            await markRelayOnline(relayURL)
        }
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

    private func reconnectAfterDelay(relayURL: String) async {
        reconnectTasks[relayURL] = nil
        await reconnect(relayURL: relayURL)
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
        reconnectTasks.removeValue(forKey: relayURL)?.cancel()
        reconnectAttempts[relayURL] = 0
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
}
