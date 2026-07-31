import Foundation

public enum VoiceDictationError: LocalizedError, Equatable {
    case notConfigured
    case quotaExceeded
    case unavailable(status: Int)

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Voice dictation isn't available right now."
        case .quotaExceeded:
            return "Daily voice limit reached."
        case .unavailable(let status):
            return "Voice extraction is unavailable right now (\(status))."
        }
    }
}

public struct VoiceExtractionResult: Equatable, Sendable {
    public var operations: [VoiceTaskOperation]
    /// Set when the worker refused on quota grounds. It can still return operations alongside a
    /// 429 (a rule-based fallback rather than the model), which the PWA surfaces too, so this is a
    /// banner rather than an error path.
    public var quotaExhausted: Bool

    public init(operations: [VoiceTaskOperation], quotaExhausted: Bool = false) {
        self.operations = operations
        self.quotaExhausted = quotaExhausted
    }
}

/// Talks to the Taskify Worker's voice endpoints, the same two the PWA uses (`worker/src/voice.ts`):
/// `/api/voice/extract` turns a raw transcript into candidate-list edits via Gemini, and
/// `/api/voice/finalize` resolves confirmed candidates into concrete tasks with real due dates.
///
/// The transcription itself is on-device (`SFSpeechRecognizer`); only the text is ever sent, and
/// only when the user has finished speaking. The npub is included because the worker meters a
/// daily per-identity quota against it.
public struct VoiceDictationClient: Sendable {
    /// The deployed Taskify Worker. The PWA discovers this at runtime from `/api/config` because it
    /// is served by the Worker itself; a native app has no such origin, so it is pinned here.
    public static let defaultBaseURL = URL(string: "https://taskify.solife.me")!

    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL = VoiceDictationClient.defaultBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func extract(
        npub: String,
        transcript: String,
        candidates: [VoiceTaskCandidate],
        sessionDurationSeconds: Int
    ) async throws -> VoiceExtractionResult {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/voice/extract"), timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(
            ExtractRequest(
                npub: npub,
                transcript: transcript,
                candidates: candidates,
                sessionDurationSeconds: sessionDurationSeconds
            )
        )

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw VoiceDictationError.unavailable(status: 0) }

        if http.statusCode == 429 {
            return VoiceExtractionResult(
                operations: Self.parseOperations(from: data),
                quotaExhausted: true
            )
        }
        if http.statusCode == 501 { throw VoiceDictationError.notConfigured }
        guard (200..<300).contains(http.statusCode) else {
            throw VoiceDictationError.unavailable(status: http.statusCode)
        }
        return VoiceExtractionResult(operations: Self.parseOperations(from: data))
    }

    /// Resolves confirmed candidates into final tasks. Any failure falls back to using the
    /// candidate titles verbatim rather than losing what the user just dictated -- the same
    /// trade the PWA makes, on the grounds that a task with no due date beats no task at all.
    public func finalize(
        npub: String,
        candidates: [VoiceTaskCandidate],
        boardID: String?,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) async -> [VoiceFinalTask] {
        let fallback = candidates.map {
            VoiceFinalTask(title: $0.title, boardId: $0.boardId ?? boardID, subtasks: $0.subtasks)
        }
        guard !candidates.isEmpty else { return [] }

        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("api/voice/finalize"), timeoutInterval: 30)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.httpBody = try JSONEncoder().encode(
                FinalizeRequest(
                    npub: npub,
                    candidates: candidates,
                    boardId: boardID,
                    referenceDate: ISO8601DateFormatter().string(from: now),
                    referenceTimeZone: timeZone.identifier,
                    referenceOffsetMinutes: -timeZone.secondsFromGMT(for: now) / 60
                )
            )

            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return fallback
            }
            let tasks = Self.parseFinalTasks(from: data)
            return tasks.isEmpty ? fallback : tasks
        } catch {
            return fallback
        }
    }

    // MARK: - Parsing (pure, unit-testable without a network)

    static func parseOperations(from data: Data) -> [VoiceTaskOperation] {
        struct Envelope: Decodable { let operations: [VoiceTaskOperation]? }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return [] }
        return envelope.operations ?? []
    }

    static func parseFinalTasks(from data: Data) -> [VoiceFinalTask] {
        struct Envelope: Decodable { let tasks: [VoiceFinalTask]? }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return [] }
        return (envelope.tasks ?? []).filter {
            !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    // MARK: - Request bodies

    private struct ExtractRequest: Encodable {
        let npub: String
        let transcript: String
        let candidates: [VoiceTaskCandidate]
        let sessionDurationSeconds: Int
    }

    private struct FinalizeRequest: Encodable {
        let npub: String
        let candidates: [VoiceTaskCandidate]
        let boardId: String?
        let referenceDate: String
        let referenceTimeZone: String
        let referenceOffsetMinutes: Int
    }
}
