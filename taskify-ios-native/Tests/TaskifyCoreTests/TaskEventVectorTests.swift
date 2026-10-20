import Foundation
import XCTest
@testable import TaskifyCore

/// Task event vectors shared with the PWA (C7-3): real signed, board-encrypted task events and
/// what each must decode to. `task-event-vectors-pwa.json` is made by the PWA and decoded here;
/// `task-event-vectors-ios.json` is made here (TASKIFY_WRITE_TASK_VECTORS=1) and decoded by the
/// PWA. Fields only the other client uses must survive a republish.
final class TaskEventVectorTests: XCTestCase {
    struct VectorBoard: Codable {
        struct Nostr: Codable { var boardId: String; var relays: [String] }
        struct Column: Codable { var id: String; var name: String }
        var id: String
        var name: String
        var kind: String
        var columns: [Column]?
        var nostr: Nostr
    }

    struct VectorDocument: Codable, Equatable {
        var id: String
        var name: String
        var mimeType: String
        var kind: String
        var remoteUrl: String?
        var encrypted: Bool

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
            try c.encode(mimeType, forKey: .mimeType)
            try c.encode(kind, forKey: .kind)
            try c.encode(remoteUrl, forKey: .remoteUrl)
            try c.encode(encrypted, forKey: .encrypted)
        }
    }

    struct Expected: Codable, Equatable {
        var id: String
        var title: String
        var note: String
        var dueAt: Int?
        var status: String
        var columnId: String?
        var priority: Int?
        var recurrence: TaskPayloadValue?
        var seriesId: String?
        var scriptureMemoryId: String?
        var scriptureMemoryStage: Int?
        var documents: [VectorDocument]?
        var republishKeeps: [String: TaskPayloadValue]

        // Every field written, nil as null, so the fixture states each expectation explicitly.
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(title, forKey: .title)
            try c.encode(note, forKey: .note)
            try c.encode(dueAt, forKey: .dueAt)
            try c.encode(status, forKey: .status)
            try c.encode(columnId, forKey: .columnId)
            try c.encode(priority, forKey: .priority)
            try c.encode(recurrence ?? .null, forKey: .recurrence)
            try c.encode(seriesId, forKey: .seriesId)
            try c.encode(scriptureMemoryId, forKey: .scriptureMemoryId)
            try c.encode(scriptureMemoryStage, forKey: .scriptureMemoryStage)
            try c.encode(documents, forKey: .documents)
            try c.encode(republishKeeps, forKey: .republishKeeps)
        }
    }

    struct Vector: Codable {
        var name: String
        var board: String
        var event: NostrEvent
        var expected: Expected
    }

    struct VectorFile: Codable {
        var description: String
        var boards: [String: VectorBoard]
        var vectors: [Vector]
    }

    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // TaskifyCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // taskify-ios-native
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("taskify-core/fixtures")

    static var vectorBoards: [String: VectorBoard] { boards }

    private static let boards: [String: VectorBoard] = [
        "lists": VectorBoard(id: "lists", name: "Lists", kind: "lists", columns: [.init(id: "c1", name: "Todo")],
                             nostr: .init(boardId: "taskify-vector-lists-board", relays: [])),
        "week": VectorBoard(id: "week", name: "Week", kind: "week", columns: nil,
                            nostr: .init(boardId: "taskify-vector-week-board", relays: [])),
    ]

    private static func board(_ entry: VectorBoard) -> Board {
        Board(
            id: entry.id,
            name: entry.name,
            kind: entry.kind == "lists" ? .list : .week,
            columns: (entry.columns ?? []).enumerated().map { BoardColumn(id: $1.id, name: $1.name, order: $0) },
            nostrBoardID: entry.nostr.boardId,
            relayURLs: []
        )
    }

    private static func payloadValue<T: Encodable>(_ value: T?) throws -> TaskPayloadValue? {
        guard let value else { return nil }
        return try JSONDecoder().decode(TaskPayloadValue.self, from: JSONEncoder().encode(value))
    }

    /// What iOS makes of an event, in the vectors' terms.
    private static func decode(_ vector: Vector, boards: [String: VectorBoard]) throws -> Expected {
        let board = board(try XCTUnwrap(boards[vector.board]))
        let task = try TaskEventCodec.decodeTaskEvent(vector.event, board: board).task
        // A republish of the decoded task must carry the fields the other client wrote.
        let republished = try JSONDecoder().decode(
            [String: TaskPayloadValue].self,
            from: JSONEncoder().encode(TaskSyncPayload(task: task))
        )
        var keeps: [String: TaskPayloadValue] = [:]
        for key in vector.expected.republishKeeps.keys {
            if let value = republished[key] { keeps[key] = value }
        }
        return Expected(
            id: task.id,
            title: task.title,
            note: task.note,
            dueAt: task.dueDate.map { Int($0.timeIntervalSince1970) },
            status: task.isDeleted ? "deleted" : (task.completed ? "done" : "open"),
            columnId: board.kind == .list ? task.columnID : nil,
            priority: task.priority?.rawValue,
            recurrence: try payloadValue(task.recurrence),
            seriesId: task.seriesID,
            scriptureMemoryId: task.scriptureMemoryID,
            scriptureMemoryStage: task.scriptureMemoryStage,
            documents: (task.documents ?? []).isEmpty ? nil : task.documents?.map {
                VectorDocument(id: $0.id, name: $0.name, mimeType: $0.mimeType, kind: $0.kind,
                               remoteUrl: $0.remoteURL, encrypted: $0.encrypted == true)
            },
            republishKeeps: keeps
        )
    }

    private func check(_ fileName: String) throws {
        let url = Self.fixtures.appendingPathComponent(fileName)
        let file = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
        XCTAssertFalse(file.vectors.isEmpty)
        for vector in file.vectors {
            var decoded = try Self.decode(vector, boards: file.boards)
            var expected = vector.expected
            // Compare recurrences as iOS reads them: equal rules, whatever optional keys each writes.
            if let a = expected.recurrence, let b = decoded.recurrence {
                let ra = try JSONDecoder().decode(TaskRecurrence.self, from: JSONEncoder().encode(a))
                let rb = try JSONDecoder().decode(TaskRecurrence.self, from: JSONEncoder().encode(b))
                XCTAssertEqual(ra, rb, vector.name)
                expected.recurrence = nil
                decoded.recurrence = nil
            }
            XCTAssertEqual(decoded, expected, vector.name)
        }
    }

    func testIOSDecodesThePWAVectors() throws {
        try check("task-event-vectors-pwa.json")
    }

    func testIOSDecodesItsOwnVectors() throws {
        try check("task-event-vectors-ios.json")
    }

    /// Writes task-event-vectors-ios.json when TASKIFY_WRITE_TASK_VECTORS=1.
    func testWriteIOSVectors() throws {
        guard ProcessInfo.processInfo.environment["TASKIFY_WRITE_TASK_VECTORS"] == "1" else {
            throw XCTSkip("Set TASKIFY_WRITE_TASK_VECTORS=1 to regenerate the iOS vectors.")
        }
        let iso = ISO8601DateFormatter()
        func date(_ value: String) -> Date { iso.date(from: value)! }
        let daily = try JSONDecoder().decode(TaskRecurrence.self, from: Data(#"{"type":"daily"}"#.utf8))

        var open = TaskItem(id: "ios-open", boardID: "lists", title: "Book flights")
        open.note = "Window seat"
        open.priority = .high
        open.dueDate = date("2026-10-22T16:00:00Z")
        open.dueDateEnabled = true
        open.dueTimeEnabled = true
        open.columnID = "c1"

        var done = TaskItem(id: "ios-done", boardID: "lists", title: "Renew passport")
        done.dueDate = date("2026-10-18T05:00:00Z")
        done.completed = true
        done.completedAt = date("2026-10-18T12:00:00Z")
        done.columnID = "c1"

        var weekly = TaskItem(id: "ios-daily", boardID: "week", title: "Water plants")
        weekly.dueDate = date("2026-10-19T05:00:00Z")
        weekly.recurrence = daily
        weekly.seriesID = "series-plants"

        var reminders = TaskItem(id: "ios-reminders", boardID: "lists", title: "Team call")
        reminders.dueDate = date("2026-10-23T15:00:00Z")
        reminders.dueTimeEnabled = true
        reminders.reminders = [TaskReminder(rawValue: "15m")]
        reminders.reminderTime = "09:00"
        reminders.columnID = "c1"

        var review = TaskItem(id: "recurrence:scripture-memory:2026-10-20", boardID: "lists", title: "Review Psalm 23:1")
        review.dueDate = date("2026-10-20T05:00:00Z")
        review.recurrence = daily
        review.seriesID = "scripture-memory"
        review.scriptureMemoryID = "entry-9"
        review.scriptureMemoryStage = 1
        review.columnID = "c1"

        var docs = TaskItem(id: "ios-docs", boardID: "lists", title: "Review the contract")
        docs.dueDate = date("2026-10-24T05:00:00Z")
        docs.columnID = "c1"
        docs.documents = [TaskDocument(
            id: "doc-ios-1", name: "Contract.pdf", mimeType: "application/pdf", kind: "pdf", size: 91_022,
            createdAt: "2026-10-18T10:00:00.000Z", remoteURL: "https://files.example/c0ffee.bin",
            encrypted: true, encryptionBoardID: "taskify-vector-lists-board"
        )]

        var deleted = TaskItem(id: "ios-deleted", boardID: "lists", title: "Cancelled plan")
        deleted.dueDate = date("2026-10-02T05:00:00Z")
        deleted.deleted = true
        deleted.columnID = "c1"

        let cases: [(String, String, TaskItem, [String: TaskPayloadValue])] = [
            ("open task with a note, priority and a timed due date", "lists", open, [:]),
            ("completed task", "lists", done, [:]),
            ("daily recurring task on a week board", "week", weekly, [:]),
            ("reminders survive another client's republish", "lists", reminders, [
                "reminders": .array([.string("15m")]),
                "reminderTime": .string("09:00"),
            ]),
            ("Scripture Memory review keeps its passage link", "lists", review, [:]),
            ("uploaded document travels by reference", "lists", docs, [:]),
            ("deleted task (tombstone)", "lists", deleted, [:]),
        ]
        var vectors: [Vector] = []
        var createdAt = 1_792_500_000
        for (name, boardKey, task, keeps) in cases {
            let board = Self.board(Self.boards[boardKey]!)
            let event = try TaskEventCodec.taskEvent(task: task, board: board, createdAt: createdAt)
            createdAt += 1
            var expected = try Self.decode(
                Vector(name: name, board: boardKey, event: event, expected: Expected(
                    id: "", title: "", note: "", dueAt: nil, status: "", columnId: nil, priority: nil,
                    recurrence: nil, seriesId: nil, scriptureMemoryId: nil, scriptureMemoryStage: nil,
                    documents: nil, republishKeeps: keeps
                )),
                boards: Self.boards
            )
            expected.republishKeeps = keeps
            vectors.append(Vector(name: name, board: boardKey, event: event, expected: expected))
        }
        let file = VectorFile(
            description: "Task events made by iOS, and what every client must decode them to. Checked by Swift TaskEventVectorTests and PWA vitest.",
            boards: Self.boards,
            vectors: vectors
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(file).write(to: Self.fixtures.appendingPathComponent("task-event-vectors-ios.json"))
    }
}
