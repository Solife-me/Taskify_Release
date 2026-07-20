import Foundation

public enum TaskSyncState: Equatable, Sendable {
    case stopped
    case connecting
    case online
    case offline(String)
}

public enum TaskSyncUpdate: Sendable {
    case task(TaskRelayRecord)
    case state(TaskSyncState)
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
    private var pendingSubscriptions: [String: Set<String>] = [:]
    private var relayBatches: [String: [String: TaskRelayStartupBatch]] = [:]

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
        updateContinuation.finish()
    }

    public nonisolated func updates() -> AsyncStream<TaskSyncUpdate> {
        updateStream
    }

    public func configure(boards: [Board]) async {
        self.boards = boards.filter(\.isVisible)
        updateContinuation.yield(.state(.connecting))
        let wantedRelays = Set(self.boards.flatMap(\.effectiveRelayURLs))

        for relayURL in Set(connections.keys).subtracting(wantedRelays) {
            listenerTasks.removeValue(forKey: relayURL)?.cancel()
            pendingSubscriptions.removeValue(forKey: relayURL)
            relayBatches.removeValue(forKey: relayURL)
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

        for (relayURL, connection) in connections {
            do {
                try await connectAndSubscribe(connection, relayURL: relayURL)
            } catch {
                updateContinuation.yield(.state(.offline(error.localizedDescription)))
            }
        }
        await flushOutbox()
    }

    public func stop() async {
        listenerTasks.values.forEach { $0.cancel() }
        listenerTasks.removeAll()
        for connection in connections.values {
            await connection.disconnect()
        }
        connections.removeAll()
        pendingSubscriptions.removeAll()
        relayBatches.removeAll()
        updateContinuation.yield(.state(.stopped))
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
        var sent = false
        for relayURL in entry.relayURLs {
            guard let connection = connections[relayURL] else { continue }
            do {
                try await connection.publish(entry.event)
                sent = true
            } catch {
                continue
            }
        }
        if !sent {
            updateContinuation.yield(.state(.offline("Changes are saved and waiting for a relay connection.")))
        }
    }

    private func handle(_ message: NostrRelayMessage, from relayURL: String) async {
        switch message {
        case .event(let subscriptionID, let event):
            guard let boardTag = event.firstTagValue(named: "b"),
                  let board = boards.first(where: {
                      BoardCrypto.boardTag(for: $0.effectiveNostrBoardID) == boardTag &&
                      $0.effectiveRelayURLs.contains(relayURL)
                  }),
                  let record = try? TaskEventCodec.decodeTaskEvent(event, board: board) else { return }
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
            if accepted {
                try? await outbox.markAccepted(eventID: eventID)
                updateContinuation.yield(.state(.online))
            } else {
                updateContinuation.yield(.state(.offline(message)))
            }
        case .disconnected(let message):
            updateContinuation.yield(.state(.offline(message)))
            scheduleReconnect(relayURL: relayURL)
        case .notice(let message), .closed(_, let message):
            updateContinuation.yield(.state(.offline(message)))
        case .endOfStoredEvents(let subscriptionID):
            var batch = relayBatches[relayURL]?[subscriptionID] ?? TaskRelayStartupBatch()
            let records = batch.drain()
            relayBatches[relayURL]?[subscriptionID] = nil
            pendingSubscriptions[relayURL]?.remove(subscriptionID)
            for record in records {
                updateContinuation.yield(.task(record))
            }
            updateContinuation.yield(.state(.online))
        }
    }

    private func scheduleReconnect(relayURL: String) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            await self?.reconnect(relayURL: relayURL)
        }
    }

    private func reconnect(relayURL: String) async {
        guard let connection = connections[relayURL] else { return }
        do {
            try await connectAndSubscribe(connection, relayURL: relayURL)
            await flushOutbox()
        } catch {
            updateContinuation.yield(.state(.offline(error.localizedDescription)))
            scheduleReconnect(relayURL: relayURL)
        }
    }

    private func subscriptionID(relayURL: String, boardTag: String) -> String {
        let relayToken = abs(relayURL.hashValue)
        return "taskify-\(relayToken)-\(boardTag.prefix(16))"
    }
}
