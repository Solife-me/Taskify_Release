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

/// Single-producer relay ingress, shared with deterministic slow-consumer tests.
struct NostrRelayMessageBuffer: Sendable {
    let stream: AsyncStream<NostrRelayMessage>
    private let continuation: AsyncStream<NostrRelayMessage>.Continuation

    init() {
        let pair = AsyncStream.makeStream(of: NostrRelayMessage.self, bufferingPolicy: .bufferingOldest(64))
        stream = pair.stream
        continuation = pair.continuation
    }

    func send(_ message: NostrRelayMessage) async {
        // bufferingOldest rejects the new value when full. Retain that value here and
        // stop reading the socket until the consumer catches up; never evict an EVENT.
        while !Task.isCancelled {
            switch continuation.yield(message) {
            case .enqueued, .terminated:
                return
            case .dropped:
                do { try await Task.sleep(for: .milliseconds(10)) }
                catch { return }
            @unknown default:
                return
            }
        }
    }

    func finish() { continuation.finish() }
}

public actor NostrRelayConnection {
    public nonisolated let relayURL: String

    private let messageBuffer = NostrRelayMessageBuffer()
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var connectionGeneration: UUID?

    private let automaticallyAuthenticate: Bool
    private let authenticationIdentity: NostrIdentity?
    private var authReplay = NostrRelayAuthReplay()

    public init(relayURL: String, automaticallyAuthenticate: Bool = true, authenticationIdentity: NostrIdentity? = nil) {
        self.relayURL = relayURL
        self.automaticallyAuthenticate = automaticallyAuthenticate
        self.authenticationIdentity = authenticationIdentity
    }

    deinit {
        receiveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        messageBuffer.finish()
    }

    public nonisolated func messages() -> AsyncStream<NostrRelayMessage> {
        messageBuffer.stream
    }

    public func connect() throws {
        guard socket == nil else { return }
        guard let url = URL(string: relayURL), Self.isAllowedRelayURL(url) else {
            throw URLError(.badURL)
        }

        let webSocket = URLSession.shared.webSocketTask(with: url)
        let generation = UUID()
        socket = webSocket
        connectionGeneration = generation
        authReplay = NostrRelayAuthReplay()
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
        limit: Int = 2_000,
        since: Int? = nil
    ) async throws {
        var filter: [String: Any] = [
            "kinds": kinds,
            "#b": [boardTag],
            "limit": limit,
        ]
        if let since {
            filter["since"] = max(0, since)
        }
        try await send([
            "REQ",
            id,
            filter,
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

    /// A one-shot REQ with an arbitrary filter (see `NostrOneShotFetching`).
    public func request(id: String, filter: NostrRelayFilter) async throws {
        try await send(["REQ", id, filter.jsonObject()])
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

    public func subscribeToBotCommands(
        id: String,
        authorPublicKey: String,
        limit: Int = 5
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [BotCommandsContract.eventKind],
                "authors": [authorPublicKey],
                "#d": [BotCommandsContract.eventDTag],
                "limit": min(max(1, limit), 20),
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

    /// NIP-47: the wallet's response to one specific request.
    public func subscribeToNWCResponses(
        id: String,
        walletPublicKey: String,
        clientPublicKey: String,
        requestID: String
    ) async throws {
        try await send([
            "REQ",
            id,
            [
                "kinds": [23_195],
                "authors": [walletPublicKey.lowercased()],
                "#p": [clientPublicKey.lowercased()],
                "#e": [requestID.lowercased()],
            ] as [String: Any],
        ])
    }

    /// Secure relays only, except plain `ws://` on this device for local development.
    nonisolated static func isAllowedRelayURL(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "wss": return true
        case "ws": return ["localhost", "127.0.0.1", "::1"].contains(url.host?.lowercased() ?? "")
        default: return false
        }
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
        let frame = try NostrRelayWire.encode(object)
        if automaticallyAuthenticate, let type = object.first as? String {
            if type == "REQ", let id = object.dropFirst().first as? String {
                authReplay.record(key: "REQ:" + id, frame: frame)
            } else if type == "EVENT", let event = object.dropFirst().first as? [String: Any], let id = event["id"] as? String {
                authReplay.record(key: "EVENT:" + id, frame: frame)
            } else if type == "CLOSE", let id = object.dropFirst().first as? String {
                authReplay.remove(key: "REQ:" + id)
            }
        }
        try await socket.send(.string(frame))
    }

    private func handleAuthentication(_ message: NostrRelayMessage, socket: URLSessionWebSocketTask) async throws -> Bool {
        switch message {
        case .auth(let challenge):
            guard authReplay.challenge != challenge else { return true }
            let identity: NostrIdentity?
            if let authenticationIdentity { identity = authenticationIdentity }
            else { identity = await NostrRelayAuthentication.shared.currentIdentity() }
            guard let identity else { return false }
            let event = try NostrEvent.signed(privateKey: identity.privateKey,
                createdAt: Int(Date().timeIntervalSince1970), kind: NIP42AuthContract.eventKind,
                tags: [["relay", relayURL], ["challenge", challenge]], content: "")
            guard authReplay.begin(challenge: challenge, authEventID: event.id) else { return true }
            try await authenticate(event)
            return true
        case .acknowledgement(let eventID, let accepted, let message):
            if let replays = authReplay.acknowledge(eventID: eventID, accepted: accepted) {
                for frame in replays { try await socket.send(.string(frame)) }
                return true
            }
            let key = "EVENT:" + eventID
            if !accepted, message.hasPrefix("auth-required:"), authReplay.block(key: key) {
                for frame in authReplay.takeReplays() { try await socket.send(.string(frame)) }
                return true
            }
            authReplay.remove(key: key)
        case .closed(let subscriptionID, let message):
            let key = "REQ:" + subscriptionID
            if message.hasPrefix("auth-required:"), authReplay.block(key: key) {
                for frame in authReplay.takeReplays() { try await socket.send(.string(frame)) }
                return true
            }
            authReplay.remove(key: key)
        default: break
        }
        return false
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
                if let decoded = try? NostrRelayMessage.decode(data) {
                    if automaticallyAuthenticate, try await handleAuthentication(decoded, socket: socket) { continue }
                    await messageBuffer.send(decoded)
                }
            } catch {
                guard connectionGeneration == generation else { return }
                self.socket = nil
                connectionGeneration = nil
                await messageBuffer.send(.disconnected(error.localizedDescription))
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
