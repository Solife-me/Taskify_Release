import Foundation

/// A task the extraction model pulled out of the spoken transcript, pending the user's review.
///
/// Ported from the PWA's `TaskCandidate` in `nostr/useVoiceSession.ts`. The field names are wire
/// format -- they are encoded straight back to `/api/voice/extract` on each follow-up call so the
/// model can revise its earlier guesses -- so they deliberately keep the PWA's JSON spelling.
public struct VoiceTaskCandidate: Identifiable, Codable, Hashable, Sendable {
    public enum Status: String, Codable, Sendable {
        case draft
        case confirmed
        case dismissed
    }

    public var id: String
    public var title: String
    public var dueText: String?
    public var reminderText: String?
    public var boardId: String?
    public var subtasks: [String]?
    public var status: Status

    public init(
        id: String = UUID().uuidString,
        title: String,
        dueText: String? = nil,
        reminderText: String? = nil,
        boardId: String? = nil,
        subtasks: [String]? = nil,
        status: Status = .confirmed
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

/// An edit the model wants applied to the candidate list. The model re-reads the whole transcript
/// on each pass, so it can revise or retract tasks it proposed earlier ("actually, make that
/// Thursday", "no, scrap that one") rather than only appending.
public struct VoiceTaskOperation: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case createTask = "create_task"
        case updateTask = "update_task"
        case deleteTask = "delete_task"
        case markUncertain = "mark_uncertain"
    }

    /// Field-level edits for `update_task`. The model may send changes either nested here or as
    /// top-level fields on the operation; both are honored, matching the PWA reducer.
    public struct Changes: Codable, Hashable, Sendable {
        public var title: String?
        public var dueText: String?
        public var reminderText: String?
        public var boardId: String?
        public var subtasks: [String]?
    }

    public var type: Kind
    public var title: String?
    public var dueText: String?
    public var reminderText: String?
    public var subtasks: [String]?
    public var targetRef: String?
    public var changes: Changes?

    public init(
        type: Kind,
        title: String? = nil,
        dueText: String? = nil,
        reminderText: String? = nil,
        subtasks: [String]? = nil,
        targetRef: String? = nil,
        changes: Changes? = nil
    ) {
        self.type = type
        self.title = title
        self.dueText = dueText
        self.reminderText = reminderText
        self.subtasks = subtasks
        self.targetRef = targetRef
        self.changes = changes
    }
}

/// A candidate resolved into something concrete enough to create: the loose `dueText` ("tomorrow
/// morning") has become a real `dueISO` timestamp, and the model has assigned a priority.
public struct VoiceFinalTask: Codable, Hashable, Sendable {
    public var title: String
    public var dueISO: String?
    public var boardId: String?
    public var notes: String?
    public var subtasks: [String]?
    public var priority: Int?

    public init(
        title: String,
        dueISO: String? = nil,
        boardId: String? = nil,
        notes: String? = nil,
        subtasks: [String]? = nil,
        priority: Int? = nil
    ) {
        self.title = title
        self.dueISO = dueISO
        self.boardId = boardId
        self.notes = notes
        self.subtasks = subtasks
        self.priority = priority
    }
}

/// The whole state of one dictation session. Kept as a plain value type with a pure `apply` so the
/// interesting behavior -- how spoken revisions fold into the candidate list -- is unit testable
/// without a microphone, a network, or a view. Mirrors the PWA's `voiceSessionReducer`.
public struct VoiceSessionState: Equatable, Sendable {
    public var transcript: String = ""
    public var interimTranscript: String = ""
    public var candidates: [VoiceTaskCandidate] = []
    public var isListening: Bool = false
    public var isProcessing: Bool = false
    public var quotaExhausted: Bool = false

    public init() {}

    public var visibleCandidates: [VoiceTaskCandidate] {
        candidates.filter { $0.status != .dismissed }
    }

    public var confirmedCandidates: [VoiceTaskCandidate] {
        candidates.filter { $0.status == .confirmed }
    }

    /// The full text to send for extraction: everything committed so far plus whatever the
    /// recognizer is still refining, so a session that ends mid-sentence doesn't drop its tail.
    public func combinedTranscript() -> String {
        [transcript, interimTranscript]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public mutating func commitTranscript(_ text: String) {
        let separator = transcript.isEmpty ? "" : " "
        transcript += separator + text
        interimTranscript = ""
    }

    public mutating func apply(_ operations: [VoiceTaskOperation], idProvider: () -> String = { UUID().uuidString }) {
        for operation in operations {
            apply(operation, idProvider: idProvider)
        }
    }

    private mutating func apply(_ operation: VoiceTaskOperation, idProvider: () -> String) {
        switch operation.type {
        case .createTask:
            candidates.append(
                VoiceTaskCandidate(
                    id: idProvider(),
                    title: operation.title ?? "",
                    dueText: operation.dueText,
                    reminderText: operation.reminderText,
                    boardId: operation.changes?.boardId,
                    subtasks: operation.subtasks,
                    status: .confirmed
                )
            )

        case .updateTask:
            guard let index = resolveTarget(operation.targetRef) else { return }
            var candidate = candidates[index]
            if let value = operation.changes?.title { candidate.title = value }
            if let value = operation.changes?.dueText { candidate.dueText = value }
            if let value = operation.changes?.reminderText { candidate.reminderText = value }
            if let value = operation.changes?.boardId { candidate.boardId = value }
            if let value = operation.changes?.subtasks { candidate.subtasks = value }
            // Top-level fields win over `changes`, matching the PWA's spread ordering.
            if let value = operation.title { candidate.title = value }
            if let value = operation.dueText { candidate.dueText = value }
            if let value = operation.reminderText { candidate.reminderText = value }
            if let value = operation.subtasks { candidate.subtasks = value }
            candidates[index] = candidate

        case .deleteTask:
            if operation.targetRef == "all" {
                for index in candidates.indices { candidates[index].status = .dismissed }
                return
            }
            guard let index = resolveTarget(operation.targetRef) else { return }
            candidates[index].status = .dismissed

        case .markUncertain:
            guard let index = resolveTarget(operation.targetRef) else { return }
            candidates[index].status = .draft
        }
    }

    /// Resolves which candidate an operation points at: the most recent live one by default (or
    /// for the explicit "last_task"), an exact `task:<id>` reference, else the last candidate whose
    /// title contains the reference text.
    func resolveTarget(_ targetRef: String?) -> Int? {
        guard !candidates.isEmpty else { return nil }

        guard let targetRef, targetRef != "last_task" else {
            if let live = candidates.lastIndex(where: { $0.status != .dismissed }) { return live }
            return candidates.indices.last
        }

        if targetRef.hasPrefix("task:") {
            let id = String(targetRef.dropFirst("task:".count))
            return candidates.firstIndex { $0.id == id }
        }

        let needle = targetRef.lowercased()
        return candidates.lastIndex { $0.title.lowercased().contains(needle) }
    }
}
