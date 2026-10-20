import Foundation
import XCTest
@testable import TaskifyCore

/// Calendar event vectors shared with the PWA (C8-5): canonical calendar events, attachments
/// included. `calendar-event-vectors-pwa.json` is made by the PWA and decoded here;
/// `calendar-event-vectors-ios.json` is made here (TASKIFY_WRITE_CALENDAR_VECTORS=1) and decoded
/// by the PWA.
final class CalendarEventVectorTests: XCTestCase {
    struct Expected: Codable, Equatable {
        var id: String
        var title: String
        var start: String
        var image: String?
        var documents: [TaskEventVectorTests.VectorDocument]?

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(title, forKey: .title)
            try c.encode(start, forKey: .start)
            try c.encode(image, forKey: .image)
            try c.encode(documents, forKey: .documents)
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
        var boards: [String: TaskEventVectorTests.VectorBoard]
        var vectors: [Vector]
    }

    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("taskify-core/fixtures")

    private static func board(_ entry: TaskEventVectorTests.VectorBoard) -> Board {
        Board(
            id: entry.id,
            name: entry.name,
            kind: entry.kind == "lists" ? .list : .week,
            columns: (entry.columns ?? []).enumerated().map { BoardColumn(id: $1.id, name: $1.name, order: $0) },
            nostrBoardID: entry.nostr.boardId,
            relayURLs: []
        )
    }

    private static func decode(_ event: NostrEvent, board: Board) throws -> Expected {
        let decoded = try TaskifyCalendarEventCodec.decodeCanonicalEvent(event, board: board).event
        let start: String
        if decoded.schedule == .date {
            start = decoded.startDateValue ?? ""
        } else {
            start = decoded.startDate.map { String(Int($0.timeIntervalSince1970)) } ?? ""
        }
        let documents = decoded.documents ?? []
        return Expected(
            id: decoded.id,
            title: decoded.title,
            start: start,
            image: decoded.imageURL,
            documents: documents.isEmpty ? nil : documents.map {
                .init(id: $0.id, name: $0.name, mimeType: $0.mimeType, kind: $0.kind,
                      remoteUrl: $0.remoteURL, encrypted: $0.encrypted == true)
            }
        )
    }

    private func check(_ fileName: String) throws {
        let data = try Data(contentsOf: Self.fixtures.appendingPathComponent(fileName))
        let file = try JSONDecoder().decode(VectorFile.self, from: data)
        XCTAssertFalse(file.vectors.isEmpty)
        for vector in file.vectors {
            let board = Self.board(try XCTUnwrap(file.boards[vector.board]))
            XCTAssertEqual(try Self.decode(vector.event, board: board), vector.expected, vector.name)
        }
    }

    func testIOSDecodesThePWAVectors() throws {
        try check("calendar-event-vectors-pwa.json")
    }

    func testIOSDecodesItsOwnVectors() throws {
        try check("calendar-event-vectors-ios.json")
    }

    /// Writes calendar-event-vectors-ios.json when TASKIFY_WRITE_CALENDAR_VECTORS=1.
    func testWriteIOSVectors() throws {
        guard ProcessInfo.processInfo.environment["TASKIFY_WRITE_CALENDAR_VECTORS"] == "1" else {
            throw XCTSkip("Set TASKIFY_WRITE_CALENDAR_VECTORS=1 to regenerate the iOS vectors.")
        }
        let boards = TaskEventVectorTests.vectorBoards
        func uploaded(_ id: String, _ name: String, _ mime: String, _ kind: String) -> TaskDocument {
            TaskDocument(id: id, name: name, mimeType: mime, kind: kind, createdAt: "2026-10-18T10:00:00.000Z",
                         remoteURL: "https://files.example/\(id).bin", encrypted: true,
                         encryptionBoardID: "taskify-vector-lists-board")
        }
        func event(_ id: String, board: String, title: String, schedule: TaskifyEventSchedule,
                   startDate: String? = nil, startISO: String? = nil, endISO: String? = nil,
                   image: String? = nil, documents: [TaskDocument]? = nil) -> TaskifyEvent {
            TaskifyEvent(
                id: id, boardID: board, columnID: board == "lists" ? "c1" : nil, title: title,
                imageURL: image, documents: documents, schedule: schedule,
                startDateValue: startDate, startISO: startISO, endISO: endISO,
                startTimeZoneID: startISO == nil ? nil : "America/Chicago",
                canonicalAddress: "", viewAddress: "", eventKey: TaskifyCalendarEventCodec.generateEventKey(),
                inviteToken: "", rsvpStatus: .accepted
            )
        }
        let cases: [(String, String, TaskifyEvent)] = [
            ("timed event with an image and documents", "lists", event(
                "ios-cal-docs", board: "lists", title: "Site visit", schedule: .time,
                startISO: "2026-10-28T14:30:00.000Z", endISO: "2026-10-28T15:30:00.000Z",
                image: "https://files.example/ios-cal-image.bin",
                documents: [uploaded("ios-cal-doc-1", "Plans.pdf", "application/pdf", "pdf")]
            )),
            ("all-day event without attachments", "week", event(
                "ios-cal-plain", board: "week", title: "Thanksgiving", schedule: .date, startDate: "2026-11-26"
            )),
        ]
        var vectors: [Vector] = []
        var createdAt = 1_792_460_000
        for (name, boardKey, item) in cases {
            let board = Self.board(boards[boardKey]!)
            let pair = try TaskifyCalendarEventCodec.eventPair(event: item, board: board, createdAt: createdAt)
            createdAt += 1
            vectors.append(Vector(name: name, board: boardKey, event: pair.canonical,
                                  expected: try Self.decode(pair.canonical, board: board)))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(VectorFile(
            description: "Calendar events (canonical copies) made by iOS, and what every client must decode them to. Checked by Swift CalendarEventVectorTests and PWA vitest.",
            boards: boards,
            vectors: vectors
        )).write(to: Self.fixtures.appendingPathComponent("calendar-event-vectors-ios.json"))
    }
}
