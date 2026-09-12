import Foundation
import TaskifyWatchShared

struct TaskifyWatchIndependentProfile: Codable, Equatable, Sendable {
    let publicKeyHex: String
    let publicKeyNpub: String
    let relayURLs: [String]
}

enum TaskifyWatchIndependentError: LocalizedError {
    case accountUnavailable
    case serviceUnavailable
    case relayUnavailable
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .accountUnavailable: "Independent Watch sync needs to be authorized again on iPhone."
        case .serviceUnavailable: "Taskify's Watch service is unavailable right now."
        case .relayUnavailable: "No configured Nostr relay accepted the Watch update yet."
        case .invalidResponse: "Taskify received an invalid Watch sync response."
        }
    }
}

/// High-level HTTPS transport for an independent watchOS app. The bridge receives only signed,
/// board-encrypted Nostr events and cannot decrypt them; all keys and event construction stay on
/// Apple Watch. This avoids making unsupported persistent relay WebSockets the Watch's data path.
struct TaskifyWatchIndependentClient: Sendable {
    static let defaultBaseURL = URL(string: "https://taskify.solife.me")!

    private let fallbackBaseURL: URL
    private let session: URLSession

    init(baseURL: URL = Self.defaultBaseURL, session: URLSession = .shared) {
        self.fallbackBaseURL = baseURL
        self.session = session
    }

    func publish(
        _ event: TaskifyWatchNostrEvent,
        relayURLs: [String],
        boardID: String,
        gatewayBaseURL: URL?,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws {
        struct Body: Encodable {
            let relays: [String]
            let event: TaskifyWatchNostrEvent
        }
        if let gatewayBaseURL {
            do {
                try await publishThroughGateway(
                    event,
                    relayURLs: relayURLs,
                    boardID: boardID,
                    gatewayBaseURL: gatewayBaseURL,
                    privateKey: privateKey
                )
                return
            } catch {
                if Task.isCancelled { throw CancellationError() }
                // Preserve the existing Taskify Watch bridge as a failover. The immutable signed
                // event is safe to retry because both the bridge and Nostr relays deduplicate IDs.
            }
        }

        struct Reply: Decodable { let accepted: Int }
        let reply: Reply = try await authenticatedPost(
            path: "api/watch/nostr/publish",
            body: Body(relays: relayURLs, event: event),
            profile: profile,
            privateKey: privateKey
        )
        guard reply.accepted > 0 else { throw TaskifyWatchIndependentError.relayUnavailable }
    }

    func fetchTasks(
        boards: [TaskifyWatchBoard],
        gatewayBaseURL: URL?,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> [TaskifyWatchNostrEvent] {
        struct Filter: Encodable {
            let kinds: [Int]
            let authors: [String]
            let boardTags: [String]
            let limit: Int

            enum CodingKeys: String, CodingKey {
                case kinds
                case authors
                case boardTags = "#b"
                case limit
            }
        }
        struct Body: Encodable {
            let relays: [String]
            let filter: Filter
        }
        struct Reply: Decodable { let events: [TaskifyWatchNostrEvent] }

        let usableBoards = boards.compactMap {
            board -> (boardID: String, author: String, boardTag: String, relays: [String])? in
            guard let boardID = board.nostrBoardID,
                  let author = try? TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID) else {
                return nil
            }
            return (
                boardID,
                author,
                TaskifyWatchNostrCrypto.boardTag(for: boardID),
                board.relayURLs ?? []
            )
        }
        let authors = Array(Set(usableBoards.map(\.author))).sorted()
        let boardTags = Array(Set(usableBoards.map(\.boardTag))).sorted()
        let relays = normalizedRelays(usableBoards.flatMap(\.relays) + profile.relayURLs)
        guard !authors.isEmpty, !relays.isEmpty else {
            throw TaskifyWatchIndependentError.accountUnavailable
        }
        if let gatewayBaseURL {
            do {
                return try await fetchCachedTasks(
                    boards: usableBoards,
                    relayURLs: relays,
                    gatewayBaseURL: gatewayBaseURL,
                    profile: profile,
                    privateKey: privateKey
                )
            } catch {
                if Task.isCancelled { throw CancellationError() }
                // The existing taskify.solife.me service remains the explicit failover whenever
                // the self-hosted or hosted push relay cannot refresh its bounded ciphertext cache.
            }
        }
        let reply: Reply = try await authenticatedPost(
            path: "api/watch/nostr/query",
            body: Body(
                relays: relays,
                filter: Filter(
                    kinds: [
                        TaskifyWatchNostrCrypto.boardEventKind,
                        TaskifyWatchNostrCrypto.taskEventKind,
                    ],
                    authors: authors,
                    boardTags: boardTags,
                    limit: 1_000
                )
            ),
            profile: profile,
            privateKey: privateKey
        )
        return reply.events
    }

    private func fetchCachedTasks(
        boards: [(boardID: String, author: String, boardTag: String, relays: [String])],
        relayURLs: [String],
        gatewayBaseURL: URL,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> [TaskifyWatchNostrEvent] {
        struct Source: Encodable {
            let author: String
            let boardTag: String
            let proof: TaskifyWatchNostrEvent
        }
        struct Body: Encodable {
            let relays: [String]
            let sources: [Source]
            let limit: Int
        }
        struct Reply: Decodable {
            let events: [TaskifyWatchNostrEvent]
            let refreshed: Bool
            let cacheHit: Bool
        }
        let endpoint = gatewayBaseURL.appendingPathComponent("v1/watch/tasks/query")
        let createdAt = Int(Date().timeIntervalSince1970)
        let uniqueBoards = Dictionary(grouping: boards, by: \.author).compactMap {
            $0.value.first
        }.sorted { $0.author < $1.author }
        let sources = try uniqueBoards.map { board in
            Source(
                author: board.author,
                boardTag: board.boardTag,
                proof: try TaskifyWatchNostrCrypto.taskCacheAccessProof(
                    boardID: board.boardID,
                    accountPublicKey: profile.publicKeyHex,
                    url: endpoint,
                    createdAt: createdAt
                )
            )
        }
        let reply: Reply = try await nip98Post(
            url: endpoint,
            body: Body(relays: relayURLs, sources: sources, limit: 1_000),
            privateKey: privateKey
        )
        guard reply.refreshed || reply.cacheHit else {
            throw TaskifyWatchIndependentError.relayUnavailable
        }
        return reply.events
    }

    private func publishThroughGateway(
        _ event: TaskifyWatchNostrEvent,
        relayURLs: [String],
        boardID: String,
        gatewayBaseURL: URL,
        privateKey: Data
    ) async throws {
        struct Body: Encodable {
            let event: TaskifyWatchNostrEvent
            let relays: [String]
        }
        struct RelayResult: Decodable {
            let relay: String
            let status: String
            let session: String?
            let challenge: String?
        }
        struct Reply: Decodable {
            let accepted: Int
            let results: [RelayResult]
        }
        struct AuthorizationBody: Encodable { let event: TaskifyWatchNostrEvent }
        struct AuthorizationReply: Decodable {
            struct Result: Decodable { let status: String }
            let result: Result
        }

        let endpoint = gatewayBaseURL.appendingPathComponent("v1/watch/task-events/publish")
        let reply: Reply = try await nip98Post(
            url: endpoint,
            body: Body(event: event, relays: relayURLs),
            privateKey: privateKey,
            acceptedStatuses: 200...202
        )
        var accepted = reply.accepted
        for result in reply.results where result.status == "auth-required" {
            guard let sessionID = result.session,
                  let challenge = result.challenge else { continue }
            let authorization = try TaskifyWatchNostrCrypto.nip42BoardAuthorizationEvent(
                boardID: boardID,
                relayURL: result.relay,
                challenge: challenge
            )
            let authorizationURL = gatewayBaseURL.appendingPathComponent(
                "v1/watch/outbox/\(sessionID)/authorize"
            )
            if let authorized: AuthorizationReply = try? await nip98Post(
                url: authorizationURL,
                body: AuthorizationBody(event: authorization),
                privateKey: privateKey
            ), authorized.result.status == "accepted" {
                accepted += 1
            }
        }
        guard accepted > 0 else { throw TaskifyWatchIndependentError.relayUnavailable }
    }

    private func nip98Post<Body: Encodable, Reply: Decodable>(
        url: URL,
        body: Body,
        privateKey: Data,
        acceptedStatuses: ClosedRange<Int> = 200...299
    ) async throws -> Reply {
        guard url.scheme?.lowercased() == "https", url.host != nil else {
            throw TaskifyWatchIndependentError.serviceUnavailable
        }
        let data = try encoded(body)
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            try TaskifyWatchNostrCrypto.nip98AuthorizationHeader(
                privateKey: privateKey,
                url: url,
                method: "POST",
                body: data
            ),
            forHTTPHeaderField: "Authorization"
        )
        let (responseData, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse,
              acceptedStatuses.contains(response.statusCode) else {
            throw TaskifyWatchIndependentError.serviceUnavailable
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: responseData) else {
            throw TaskifyWatchIndependentError.invalidResponse
        }
        return reply
    }

    func interpretVoice(
        transcript: String,
        boardID: String,
        boards: [TaskifyWatchVoiceBoardContext],
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> TaskifyWatchVoicePreview {
        let requestID = UUID().uuidString
        let candidateTasks = try await extractVoice(
            transcript: transcript,
            profile: profile,
            privateKey: privateKey
        )
        let tasks = await finalizeVoice(
            candidates: candidateTasks,
            boardID: boardID,
            boards: boards,
            profile: profile,
            privateKey: privateKey
        )
        let final = tasks.isEmpty
            ? [VoiceFinalWire(title: transcript, dueISO: nil, notes: nil, subtasks: nil, priority: nil)]
            : tasks
        return TaskifyWatchVoicePreview(
            requestID: requestID,
            transcript: transcript,
            tasks: final.enumerated().map { index, task in
                TaskifyWatchVoiceDraft(
                    id: "\(requestID)-\(index)",
                    title: task.title,
                    dueISO: task.dueISO,
                    boardId: task.boardId,
                    notes: task.notes,
                    subtasks: task.subtasks,
                    priority: task.priority,
                    reminderMinutesBeforeDue: task.reminderMinutesBeforeDue,
                    reminderTime: task.reminderTime,
                    columnId: task.columnId,
                    recurrence: task.recurrence
                )
            }
        )
    }

    private func extractVoice(
        transcript: String,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> [VoiceCandidateWire] {
        struct Body: Encodable {
            let npub: String
            let transcript: String
            let candidates: [VoiceCandidateWire]
            let sessionDurationSeconds: Int
        }
        struct Reply: Decodable { let operations: [VoiceOperationWire]? }

        let body = Body(
            npub: profile.publicKeyNpub,
            transcript: transcript,
            candidates: [],
            sessionDurationSeconds: max(1, transcript.split(whereSeparator: \.isWhitespace).count / 2)
        )
        let reply: Reply = try await authenticatedPost(
            path: "api/voice/extract",
            body: body,
            profile: profile,
            privateKey: privateKey,
            acceptsRateLimitBody: true
        )
        let candidates = (reply.operations ?? []).compactMap { operation -> VoiceCandidateWire? in
            guard operation.type == "create_task" else { return nil }
            let title = (operation.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            return VoiceCandidateWire(
                id: UUID().uuidString,
                title: title,
                dueText: operation.dueText,
                reminderText: operation.reminderText,
                notes: operation.notes,
                recurrenceText: operation.recurrenceText,
                boardId: operation.boardId,
                subtasks: operation.subtasks,
                status: "confirmed"
            )
        }
        return candidates.isEmpty
            ? [VoiceCandidateWire(id: UUID().uuidString, title: transcript, status: "confirmed")]
            : candidates
    }

    private func finalizeVoice(
        candidates: [VoiceCandidateWire],
        boardID: String,
        boards: [TaskifyWatchVoiceBoardContext],
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async -> [VoiceFinalWire] {
        struct Body: Encodable {
            let npub: String
            let candidates: [VoiceCandidateWire]
            let boardId: String
            let boards: [TaskifyWatchVoiceBoardContext]
            let referenceDate: String
            let referenceTimeZone: String
            let referenceOffsetMinutes: Int
        }
        struct Reply: Decodable { let tasks: [VoiceFinalWire]? }
        let now = Date()
        let timeZone = TimeZone.current
        let body = Body(
            npub: profile.publicKeyNpub,
            candidates: candidates,
            boardId: boardID,
            boards: boards,
            referenceDate: ISO8601DateFormatter().string(from: now),
            referenceTimeZone: timeZone.identifier,
            referenceOffsetMinutes: -timeZone.secondsFromGMT(for: now) / 60
        )
        guard let reply: Reply = try? await authenticatedPost(
            path: "api/voice/finalize",
            body: body,
            profile: profile,
            privateKey: privateKey
        ) else {
            return candidates.map {
                VoiceFinalWire(title: $0.title, dueISO: nil, notes: nil, subtasks: $0.subtasks, priority: nil)
            }
        }
        return (reply.tasks ?? []).filter {
            !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func authenticatedPost<Body: Encodable, Reply: Decodable>(
        path: String,
        body: Body,
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data,
        acceptsRateLimitBody: Bool = false
    ) async throws -> Reply {
        let data = try encoded(body)
        let authentication = try TaskifyWatchNostrCrypto.requestAuthentication(
            privateKey: privateKey,
            publicKeyHex: profile.publicKeyHex,
            body: data
        )
        var request = URLRequest(url: fallbackBaseURL.appendingPathComponent(path), timeoutInterval: 15)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in authentication.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return try await response(for: request, acceptsRateLimitBody: acceptsRateLimitBody)
    }

    private func response<Reply: Decodable>(
        for request: URLRequest,
        acceptsRateLimitBody: Bool = false
    ) async throws -> Reply {
        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse,
              (200..<300).contains(response.statusCode)
                || (acceptsRateLimitBody && response.statusCode == 429) else {
            throw TaskifyWatchIndependentError.serviceUnavailable
        }
        guard let decoded = try? JSONDecoder().decode(Reply.self, from: data) else {
            throw TaskifyWatchIndependentError.invalidResponse
        }
        return decoded
    }

    private func encoded<Value: Encodable>(_ value: Value) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    private func normalizedRelays(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            let normalized = value.trimmingCharacters(in: CharacterSet(charactersIn: " /"))
            guard normalized.hasPrefix("wss://"), seen.insert(normalized).inserted else { return nil }
            return normalized
        }
    }
}

private struct VoiceCandidateWire: Codable, Sendable {
    let id: String
    let title: String
    let dueText: String?
    let reminderText: String?
    let notes: String?
    let recurrenceText: String?
    let boardId: String?
    let subtasks: [String]?
    let status: String

    init(
        id: String,
        title: String,
        dueText: String? = nil,
        reminderText: String? = nil,
        notes: String? = nil,
        recurrenceText: String? = nil,
        boardId: String? = nil,
        subtasks: [String]? = nil,
        status: String
    ) {
        self.id = id
        self.title = title
        self.dueText = dueText
        self.reminderText = reminderText
        self.notes = notes
        self.recurrenceText = recurrenceText
        self.boardId = boardId
        self.subtasks = subtasks
        self.status = status
    }
}

private struct VoiceOperationWire: Decodable, Sendable {
    let type: String
    let title: String?
    let dueText: String?
    let reminderText: String?
    let notes: String?
    let recurrenceText: String?
    let boardId: String?
    let subtasks: [String]?
}

private struct VoiceFinalWire: Codable, Sendable {
    let title: String
    let dueISO: String?
    let boardId: String?
    let columnId: String?
    let notes: String?
    let subtasks: [String]?
    let priority: Int?
    let reminderMinutesBeforeDue: [Int]?
    let reminderTime: String?
    let recurrence: VoiceRecurrence?

    init(
        title: String,
        dueISO: String? = nil,
        boardId: String? = nil,
        columnId: String? = nil,
        notes: String? = nil,
        subtasks: [String]? = nil,
        priority: Int? = nil,
        reminderMinutesBeforeDue: [Int]? = nil,
        reminderTime: String? = nil,
        recurrence: VoiceRecurrence? = nil
    ) {
        self.title = title
        self.dueISO = dueISO
        self.boardId = boardId
        self.columnId = columnId
        self.notes = notes
        self.subtasks = subtasks
        self.priority = priority
        self.reminderMinutesBeforeDue = reminderMinutesBeforeDue
        self.reminderTime = reminderTime
        self.recurrence = recurrence
    }
}
