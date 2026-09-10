import Foundation
import TaskifyWatchShared

enum TaskifyWatchChatClientError: LocalizedError {
    case invalidServer
    case invalidResponse
    case requestFailed(Int, String?)
    case discoveryUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidServer: "The Taskify push relay address is invalid."
        case .invalidResponse: "The Taskify push relay returned an invalid response."
        case .requestFailed(_, let message): message ?? "The Taskify push relay rejected the request."
        case .discoveryUnavailable: "The recipient's inbox relay list could not be refreshed."
        }
    }
}

struct TaskifyWatchInboxPage: Sendable {
    let events: [TaskifyWatchNostrEvent]
    let cursor: String
    let hasMore: Bool
}

struct TaskifyWatchGatewayRelayResult: Decodable, Sendable {
    let relay: String
    let status: String
    let message: String?
    let session: String?
    let challenge: String?
}

struct TaskifyWatchGatewayPublishResult: Decodable, Sendable {
    let eventID: String
    let accepted: Int
    let results: [TaskifyWatchGatewayRelayResult]
}

struct TaskifyWatchGatewayAuthorizationResult: Decodable, Sendable {
    let eventID: String
    let result: TaskifyWatchGatewayRelayResult
}

struct TaskifyWatchChatGatewayClient: Sendable {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) throws {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host != nil else {
            throw TaskifyWatchChatClientError.invalidServer
        }
        self.baseURL = baseURL
        self.session = session
    }

    func queryInbox(
        cursor: String?,
        limit: Int = 100,
        privateKey: Data,
        deadline: ContinuousClock.Instant? = nil
    ) async throws -> TaskifyWatchInboxPage {
        // URLRequest.timeoutInterval is an inactivity timeout, not a total deadline. Race
        // the request against a monotonic clock as well, cancelling URLSession on expiry.
        if let deadline {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            return try await withThrowingTaskGroup(of: TaskifyWatchInboxPage.self) { group in
                group.addTask {
                    try await queryInbox(cursor: cursor, limit: limit, privateKey: privateKey)
                }
                group.addTask {
                    try await ContinuousClock().sleep(until: deadline)
                    throw URLError(.timedOut)
                }
                defer { group.cancelAll() }
                return try await group.next()!
            }
        }
        try Task.checkCancellation()
        struct Body: Encodable { let cursor: String?; let limit: Int }
        struct Reply: Decodable {
            let events: [TaskifyWatchNostrEvent]
            let cursor: String
            let hasMore: Bool
        }
        let reply: Reply = try await request(
            path: "v1/watch/inbox/query",
            method: "POST",
            body: Body(cursor: cursor, limit: min(max(limit, 1), 200)),
            privateKey: privateKey
        )
        guard reply.events.count <= min(max(limit, 1), 200) else {
            throw TaskifyWatchChatClientError.invalidResponse
        }
        return TaskifyWatchInboxPage(
            events: reply.events,
            cursor: reply.cursor,
            hasMore: reply.hasMore
        )
    }

    func submit(
        event: TaskifyWatchNostrEvent,
        relayURLs: [String],
        privateKey: Data
    ) async throws -> TaskifyWatchGatewayPublishResult {
        struct Body: Encodable {
            let event: TaskifyWatchNostrEvent
            let relays: [String]
            let returnAfterFirstAccepted = true
        }
        return try await request(
            path: "v1/watch/outbox/submit",
            method: "POST",
            body: Body(event: event, relays: relayURLs),
            privateKey: privateKey,
            acceptedStatuses: 200...202
        )
    }

    /// HTTPS transports public signed preferences; the Watch remains the routing authority.
    /// Query only an outbox recipient (or our own account during inbox enrollment).
    func preferenceEvents(
        recipientPublicKey: String,
        relayURLs: [String],
        privateKey: Data
    ) async throws -> TaskifyWatchRelayDiscoveryResult {
        struct Body: Encodable { let recipientPublicKey: String; let relays: [String] }
        struct Reply: Decodable {
            let events: [TaskifyWatchNostrEvent]
            let completedRelays: [String]
        }
        let recipient = recipientPublicKey.lowercased()
        let relays = Array(TaskifyWatchRelayRouting.normalizedRelayURLs(relayURLs)
            .prefix(TaskifyWatchRelayDiscoveryPolicy.maximumQueriedRelayCount))
        guard recipient.count == 64, recipient.allSatisfy(\.isHexDigit), !relays.isEmpty else {
            throw TaskifyWatchChatClientError.discoveryUnavailable
        }
        let reply: Reply = try await request(
            path: "v1/watch/inbox-preference/query",
            method: "POST",
            body: Body(recipientPublicKey: recipient, relays: relays),
            privateKey: privateKey,
            maximumResponseBytes: 300 * 1024
        )
        guard reply.events.count <= 32, reply.completedRelays.count <= relays.count,
              reply.events.allSatisfy({
                  $0.kind == 10_050 && $0.publicKey.lowercased() == recipient
                      && TaskifyWatchNostrCrypto.verify($0)
              }) else { throw TaskifyWatchChatClientError.invalidResponse }
        let completed = TaskifyWatchRelayRouting.normalizedRelayURLs(reply.completedRelays)
        guard completed.allSatisfy({ relays.contains($0) }) else {
            throw TaskifyWatchChatClientError.invalidResponse
        }
        return TaskifyWatchRelayDiscoveryResult(
            events: reply.events,
            discoveryComplete: TaskifyWatchRelayDiscoveryPolicy.hasSufficientAbsenceEvidence(
                completedRelayURLs: completed, queriedRelayURLs: relays
            )
        )
    }

    func authorize(
        sessionID: String,
        relayURL: String,
        challenge: String,
        privateKey: Data
    ) async throws -> TaskifyWatchGatewayAuthorizationResult {
        struct Body: Encodable { let event: TaskifyWatchNostrEvent }
        let event = try TaskifyWatchNostrCrypto.nip42AuthorizationEvent(
            privateKey: privateKey,
            relayURL: relayURL,
            challenge: challenge
        )
        return try await request(
            path: "v1/watch/outbox/\(sessionID)/authorize",
            method: "POST",
            body: Body(event: event),
            privateKey: privateKey
        )
    }

    func publishInboxPreference(
        event: TaskifyWatchNostrEvent,
        relayURLs: [String],
        privateKey: Data
    ) async throws -> TaskifyWatchGatewayPublishResult {
        struct Body: Encodable {
            let event: TaskifyWatchNostrEvent
            let relays: [String]
        }
        return try await request(
            path: "v1/watch/inbox-preference/publish",
            method: "POST",
            body: Body(event: event, relays: relayURLs),
            privateKey: privateKey,
            acceptedStatuses: 200...202
        )
    }

    func registerWatch(
        deviceToken: Data,
        installationID: String,
        environment: String,
        privateKey: Data
    ) async throws {
        struct Body: Encodable {
            let deviceToken: String
            let environment: String
            let platform = "watchos"
        }
        struct Reply: Decodable { let enabled: Bool }
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let _: Reply = try await request(
            path: "v1/registrations/\(installationID)",
            method: "PUT",
            body: Body(deviceToken: token, environment: environment),
            privateKey: privateKey
        )
    }

    private func request<Body: Encodable, Reply: Decodable>(
        path: String,
        method: String,
        body: Body,
        privateKey: Data,
        acceptedStatuses: ClosedRange<Int> = 200...299,
        maximumResponseBytes: Int? = nil
    ) async throws -> Reply {
        let url = baseURL.appendingPathComponent(path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let bodyData = try encoder.encode(body)
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = method
        request.httpBody = bodyData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            try TaskifyWatchNostrCrypto.nip98AuthorizationHeader(
                privateKey: privateKey,
                url: url,
                method: method,
                body: bodyData
            ),
            forHTTPHeaderField: "Authorization"
        )
        let (data, response) = try await session.data(for: request)
        if let maximumResponseBytes, data.count > maximumResponseBytes {
            throw TaskifyWatchChatClientError.invalidResponse
        }
        guard let http = response as? HTTPURLResponse else {
            throw TaskifyWatchChatClientError.invalidResponse
        }
        guard acceptedStatuses.contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw TaskifyWatchChatClientError.requestFailed(http.statusCode, message)
        }
        guard let decoded = try? JSONDecoder().decode(Reply.self, from: data) else {
            throw TaskifyWatchChatClientError.invalidResponse
        }
        return decoded
    }
}

struct TaskifyWatchRelayDiscoveryResult: Sendable {
    let events: [TaskifyWatchNostrEvent]
    let discoveryComplete: Bool
}
