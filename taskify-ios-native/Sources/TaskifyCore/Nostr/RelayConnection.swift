import Foundation

public enum NostrRelayMessage: Sendable {
    case event(subscriptionID: String, event: NostrEvent)
    case endOfStoredEvents(subscriptionID: String)
    case acknowledgement(eventID: String, accepted: Bool, message: String)
    case notice(String)
    case closed(subscriptionID: String, message: String)
    case disconnected(String)
    case auth(challenge: String)

    static func decode(_ data: Data) throws -> NostrRelayMessage? {
        guard let array = try JSONSerialization.jsonObject(with: data) as? [Any],
              let type = array.first as? String else { return nil }

        switch type {
        case "EVENT":
            guard array.count >= 3,
                  let subscriptionID = array[1] as? String,
                  JSONSerialization.isValidJSONObject(array[2]) else { return nil }
            let eventData = try JSONSerialization.data(withJSONObject: array[2])
            return .event(
                subscriptionID: subscriptionID,
                event: try JSONDecoder().decode(NostrEvent.self, from: eventData)
            )
        case "EOSE":
            guard array.count >= 2, let subscriptionID = array[1] as? String else { return nil }
            return .endOfStoredEvents(subscriptionID: subscriptionID)
        case "OK":
            guard array.count >= 4,
                  let eventID = array[1] as? String,
                  let accepted = array[2] as? Bool,
                  let message = array[3] as? String else { return nil }
            return .acknowledgement(eventID: eventID, accepted: accepted, message: message)
        case "NOTICE":
            return .notice(array.count >= 2 ? (array[1] as? String ?? "Relay notice") : "Relay notice")
        case "CLOSED":
            guard array.count >= 3,
                  let subscriptionID = array[1] as? String,
                  let message = array[2] as? String else { return nil }
            return .closed(subscriptionID: subscriptionID, message: message)
        case "AUTH":
            guard array.count >= 2, let challenge = array[1] as? String else { return nil }
            return .auth(challenge: challenge)
        default:
            return nil
        }
    }
}

/// NIP-42: relay-issued authentication. A client proves control of a pubkey by signing a
/// kind 22242 event echoing the relay's challenge and sending it back as an `AUTH` frame.
public enum NIP42AuthContract {
    public static let eventKind = 22_242
}

enum NostrRelayWire {
    static func encode(_ object: [Any]) throws -> String {
        let data = try JSONSerialization.data(
            withJSONObject: object,
            options: [.withoutEscapingSlashes]
        )
        guard let text = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        return text
    }
}

/// Resolves a WebSocket ping from either its pong callback or a timeout, whichever arrives first.
/// `URLSessionWebSocketTask.sendPing` has no native async timeout and a suspended socket can leave
/// its callback pending indefinitely. Keeping the one-shot resolution behind a lock lets the
/// foreground health check return promptly without risking a double-resumed continuation when a
/// late pong arrives after the timeout.
private final class NostrRelayPingResolution: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?

    init(continuation: CheckedContinuation<Bool, Never>) {
        self.continuation = continuation
    }

    func resolve(_ isResponsive: Bool) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: isResponsive)
    }
}

public actor NostrRelayConnection {
    public nonisolated let relayURL: String

    private let messageStream: AsyncStream<NostrRelayMessage>
    private let messageContinuation: AsyncStream<NostrRelayMessage>.Continuation
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var connectionGeneration: UUID?

    public init(relayURL: String) {
        self.relayURL = relayURL
        let pair = AsyncStream.makeStream(
            of: NostrRelayMessage.self,
            bufferingPolicy: .bufferingNewest(512)
        )
        messageStream = pair.stream
        messageContinuation = pair.continuation
    }

    deinit {
        receiveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        messageContinuation.finish()
    }

    public nonisolated func messages() -> AsyncStream<NostrRelayMessage> {
        messageStream
    }

    public func connect() throws {
        guard socket == nil else { return }
        guard let url = URL(string: relayURL), url.scheme?.lowercased() == "wss" else {
            throw URLError(.badURL)
        }

        let webSocket = URLSession.shared.webSocketTask(with: url)
        let generation = UUID()
        socket = webSocket
        connectionGeneration = generation
        webSocket.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(socket: webSocket, generation: generation)
        }
    }

    public func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connectionGeneration = nil
    }

    /// Confirms that the relay socket can still exchange WebSocket control frames.
    ///
    /// iOS can suspend a backgrounded WebSocket without immediately completing `receive()` with
    /// an error. In that state `socket` is non-nil and the sync engine still looks online even
    /// though no new relay events can arrive. A pong proves the existing subscription is alive;
    /// a missing pong tells the engine to reconnect and replay the subscription backlog.
    public func isResponsive(timeout: Duration = .seconds(2)) async -> Bool {
        guard let socket, socket.state == .running else { return false }
        return await withCheckedContinuation { continuation in
            let resolution = NostrRelayPingResolution(continuation: continuation)
            socket.sendPing { error in
                resolution.resolve(error == nil)
            }
            Task {
                try? await Task.sleep(for: timeout)
                resolution.resolve(false)
            }
        }
    }

    public func subscribe(
        id: String,
        kinds: [Int],
        boardTag: String,
        limit: Int = 2_000
    ) async throws {
        try await send([
            "REQ",
            id,
            ["kinds": kinds, "#b": [boardTag], "limit": limit] as [String: Any],
        ])
    }

    public func subscribeToAuthoredBoardEvents(
        id: String,
        kinds: [Int],
        authorPublicKey: String,
        boardTag: String,
        limit: Int = 2_000
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": kinds,
                "authors": [authorPublicKey.lowercased()],
                "#b": [boardTag],
                "limit": min(max(1, limit), 5_000),
            ] as [String: Any],
        ])
    }

    public func subscribeToAccountBackup(
        id: String,
        authorPublicKey: String,
        limit: Int = 5
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [NostrAppBackupContract.eventKind],
                "authors": [authorPublicKey],
                "#d": [NostrAppBackupContract.eventDTag],
                "limit": limit,
            ] as [String: Any],
        ])
    }

    public func subscribeToSharedInbox(
        id: String,
        recipientPublicKey: String,
        since: Int,
        limit: Int = 200
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [NIP17GiftWrap.wrapKind],
                "#p": [recipientPublicKey],
                "since": max(0, since),
                "limit": min(max(1, limit), 500),
            ] as [String: Any],
        ])
    }

    public func subscribeToNIP17InboxRelayPreferences(
        id: String,
        authorPublicKey: String,
        limit: Int = 5
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [NIP17InboxRelayResolver.preferenceEventKind],
                "authors": [authorPublicKey],
                "limit": min(max(1, limit), 20),
            ] as [String: Any],
        ])
    }

    public func subscribeToPrivateContacts(
        id: String,
        authorPublicKey: String,
        limit: Int = 5
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [NIP51ContactListContract.eventKind],
                "authors": [authorPublicKey],
                "#d": [NIP51ContactListContract.eventDTag],
                "limit": min(max(1, limit), 20),
            ] as [String: Any],
        ])
    }

    public func subscribeToProfiles(
        id: String,
        authorPublicKeys: [String],
        limit: Int = 500
    ) async throws {
        let authors = Array(Set(authorPublicKeys.map { $0.lowercased() })).prefix(500)
        guard !authors.isEmpty else { return }
        try await send([
            "REQ",
            id,
            [
                "kinds": [0],
                "authors": Array(authors),
                "limit": min(max(1, limit), 500),
            ] as [String: Any],
        ])
    }

    public func subscribeToTaskifyEventView(
        id: String,
        authorPublicKey: String,
        eventID: String,
        limit: Int = 10
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [TaskifyEventContract.viewEventKind],
                "authors": [authorPublicKey.lowercased()],
                "#d": [eventID],
                "limit": min(max(1, limit), 20),
            ] as [String: Any],
        ])
    }

    public func subscribeToTaskifyEventRSVPs(
        id: String,
        canonicalAddress: String,
        limit: Int = 200
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [SharedCalendarRSVPContract.eventKind],
                "#a": [canonicalAddress],
                "limit": min(max(1, limit), 500),
            ] as [String: Any],
        ])
    }

    public func closeSubscription(id: String) async throws {
        try await send(["CLOSE", id])
    }

    public func publish(_ event: NostrEvent) async throws {
        let eventData = try JSONEncoder().encode(event)
        let eventObject = try JSONSerialization.jsonObject(with: eventData)
        try await send(["EVENT", eventObject])
    }

    /// Responds to a NIP-42 `AUTH` challenge with a signed kind 22242 event.
    public func authenticate(_ event: NostrEvent) async throws {
        let eventData = try JSONEncoder().encode(event)
        let eventObject = try JSONSerialization.jsonObject(with: eventData)
        try await send(["AUTH", eventObject])
    }

    private func send(_ object: [Any]) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
        try await socket.send(.string(NostrRelayWire.encode(object)))
    }

    private func receiveLoop(
        socket: URLSessionWebSocketTask,
        generation: UUID
    ) async {
        while !Task.isCancelled, connectionGeneration == generation {
            do {
                let message = try await socket.receive()
                let data: Data
                switch message {
                case .data(let receivedData): data = receivedData
                case .string(let text): data = Data(text.utf8)
                @unknown default: continue
                }
                if let decoded = try NostrRelayMessage.decode(data) {
                    messageContinuation.yield(decoded)
                }
            } catch {
                guard connectionGeneration == generation else { return }
                self.socket = nil
                connectionGeneration = nil
                messageContinuation.yield(.disconnected(error.localizedDescription))
                return
            }
        }
    }
}

public enum NostrRelayHistoryFetcher {
    public static func authoredBoardEvents(
        relayURL: String,
        kinds: [Int],
        authorPublicKey: String,
        boardTag: String,
        timeout: Duration = .seconds(5)
    ) async throws -> [NostrEvent] {
        let connection = NostrRelayConnection(relayURL: relayURL)
        try await connection.connect()
        let subscriptionID = "cleanup-\(UUID().uuidString.prefix(12))"
        let result = try await withThrowingTaskGroup(of: [NostrEvent].self) { group in
            group.addTask {
                var events: [NostrEvent] = []
                for await message in connection.messages() {
                    guard !Task.isCancelled else { return events }
                    switch message {
                    case .event(let id, let event) where id == subscriptionID:
                        events.append(event)
                    case .endOfStoredEvents(let id) where id == subscriptionID:
                        return events
                    case .closed(let id, _) where id == subscriptionID:
                        return events
                    case .disconnected(let message):
                        throw URLError(.networkConnectionLost, userInfo: [
                            NSLocalizedDescriptionKey: message,
                        ])
                    default:
                        continue
                    }
                }
                return events
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                return []
            }
            try await connection.subscribeToAuthoredBoardEvents(
                id: subscriptionID,
                kinds: kinds,
                authorPublicKey: authorPublicKey,
                boardTag: boardTag
            )
            let events = try await group.next() ?? []
            group.cancelAll()
            return events
        }
        await connection.disconnect()
        return result
    }
}
