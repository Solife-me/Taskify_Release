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

    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = Self.defaultBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func publish(
        _ event: TaskifyWatchNostrEvent,
        relayURLs: [String],
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws {
        struct Body: Encodable {
            let relays: [String]
            let event: TaskifyWatchNostrEvent
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
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async throws -> [TaskifyWatchNostrEvent] {
        struct Filter: Encodable {
            let kinds: [Int]
            let authors: [String]
            let limit: Int
        }
        struct Body: Encodable {
            let relays: [String]
            let filter: Filter
        }
        struct Reply: Decodable { let events: [TaskifyWatchNostrEvent] }

        let usableBoards = boards.compactMap { board -> (String, [String])? in
            guard let boardID = board.nostrBoardID,
                  let author = try? TaskifyWatchNostrCrypto.boardPublicKeyHex(for: boardID) else {
                return nil
            }
            return (author, board.relayURLs ?? [])
        }
        let authors = Array(Set(usableBoards.map(\.0))).sorted()
        let relays = normalizedRelays(usableBoards.flatMap(\.1) + profile.relayURLs)
        guard !authors.isEmpty, !relays.isEmpty else {
            throw TaskifyWatchIndependentError.accountUnavailable
        }
        let reply: Reply = try await authenticatedPost(
            path: "api/watch/nostr/query",
            body: Body(
                relays: relays,
                filter: Filter(kinds: [TaskifyWatchNostrCrypto.taskEventKind], authors: authors, limit: 1_000)
            ),
            profile: profile,
            privateKey: privateKey
        )
        return reply.events
    }

    func interpretVoice(
        transcript: String,
        boardID: String,
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
                    notes: task.notes,
                    subtasks: task.subtasks,
                    priority: task.priority
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
        profile: TaskifyWatchIndependentProfile,
        privateKey: Data
    ) async -> [VoiceFinalWire] {
        struct Body: Encodable {
            let npub: String
            let candidates: [VoiceCandidateWire]
            let boardId: String
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
        var request = URLRequest(url: baseURL.appendingPathComponent(path), timeoutInterval: 15)
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
    let boardId: String?
    let subtasks: [String]?
    let status: String

    init(
        id: String,
        title: String,
        dueText: String? = nil,
        reminderText: String? = nil,
        boardId: String? = nil,
        subtasks: [String]? = nil,
        status: String
    ) {
        self.id = id
        self.title = title
        self.dueText = dueText
        self.reminderText = reminderText
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
    let boardId: String?
    let subtasks: [String]?
}

private struct VoiceFinalWire: Codable, Sendable {
    let title: String
    let dueISO: String?
    let notes: String?
    let subtasks: [String]?
    let priority: Int?
}
