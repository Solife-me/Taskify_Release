import Foundation

public enum NostrRelayMessage: Sendable {
    case event(subscriptionID: String, event: NostrEvent)
    case endOfStoredEvents(subscriptionID: String)
    case acknowledgement(eventID: String, accepted: Bool, message: String)
    case notice(String)
    case closed(subscriptionID: String, message: String)
    case disconnected(String)

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
        default:
            return nil
        }
    }
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

    public func publish(_ event: NostrEvent) async throws {
        let eventData = try JSONEncoder().encode(event)
        let eventObject = try JSONSerialization.jsonObject(with: eventData)
        try await send(["EVENT", eventObject])
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
