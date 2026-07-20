import Foundation
import XCTest
@testable import TaskifyCore

final class CryptoSyncTests: XCTestCase {
    func testBoardDerivationMatchesPWAReference() throws {
        let boardID = "test-board-id"

        XCTAssertEqual(
            BoardCrypto.boardTag(for: boardID),
            "975f9ca47e275848a17d1004f96d918bb866c5aa2b3ffcd1a89706b399ba6d2c"
        )
        XCTAssertEqual(
            BoardCrypto.signingPrivateKey(for: boardID).hexString,
            "fb9b7a1482d0a4b7a2caeac449e11a26be3faeae91cb8bebdb0f29d73f78c9e9"
        )
        XCTAssertEqual(
            try BoardCrypto.signingPublicKey(for: boardID).hexString,
            "7867df404773e8684a7992bc58f3122ed2a56c6e79b414bb672adbe975fd2ef4"
        )
    }

    func testNostrSigningMatchesReferenceEvent() throws {
        let privateKey = try Data(hex: String(repeating: "0", count: 63) + "1")
        let event = try NostrEvent.signed(
            privateKey: privateKey,
            createdAt: 1_700_000_000,
            kind: 1,
            tags: [["d", "task-1"], ["b", "board-tag"]],
            content: "hello"
        )

        XCTAssertEqual(
            event.publicKey,
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        )
        XCTAssertEqual(
            event.id,
            "a7e1b2f8b9170e8083226d48b376a8386bccb7ad0f6b1e2a527e18dca0f65281"
        )
        XCTAssertTrue(event.verify())
    }

    func testPWAEncryptedFixtureDecrypts() throws {
        let encrypted = "AAECAwQFBgcICQoLGvH2tbCQySFZA1SA2XqMTGyjAS5DDIc1YIkSn9q6G1UTH6P7HhdkGQOmCJ/GsW4crvf1jgvaIAuQFsbBhfQ5NRv0a8dK6eGu4B9G2Q2vgGxnAKtwbJY9azLuCwjnoZ/fN0Yw40zYFbLvlMut9hTYe5fvnzMfksdv3tYaX+rjn8kYkPhz4x89oXMWWKopy8LgIU5g4xdx/6l43oLajPIivhFuTIPsfUSuFSPo1VCYwqi0Bry16dJWtGhqgqX2P7Eq+W15qeqhI4nXCFXpUp3SyLCNO8kSVBlNgFvtoIkbbuX2UvMEZLVTjss4JIcQJHaeMczuzWBAfUnVP99asBVqVZiBCvUCOSdOJhJFA7a3JaybuYFdosZ3X72qg2jPDPotaXI/XzoVkwdfTnfEDtpNV1LYrSGYGJBFuYjWZFu6hkL/fCCezUAkdmJtJINiGKR98BerwlHhSyEoVWO3chrueMVVHheM4em5sFJTHVml+IeFnLSAWDb8a6eCoQ2WaOLFZv0pzlGwOKkq0Azs1pnCxyIALVxyjd6mOjLvyOzGZAlHWaOk/f6MUjiKTBNIBKTRJwzCJ91rNpxJ7mFOvn94sl9ImbR4kg/JDSxsGUQN2M0bzeIJ/+ZC6UK+DX46a1TvngGCh/j08TC/zvMqX0D5GC7KLhHeQT+egr/TedBeqLukPx76ViftQuHDB7D5u45bgZcVDRTEm8E2r0THCclVXybrBJB3TdXE/k8yk0k5bRPn"
        let plaintext = try BoardCrypto.decrypt(encrypted, boardID: "test-board-id")
        let payload = try JSONDecoder().decode(TaskSyncPayload.self, from: plaintext)

        XCTAssertEqual(payload.title, "PWA fixture")
        XCTAssertEqual(payload.priority, 2)
        XCTAssertEqual(payload.note, "interop")
        XCTAssertEqual(payload.dueISO, "2026-07-20T00:00:00.000Z")
        XCTAssertEqual(payload.createdAt, 1_700_000_000_000)
    }

    func testTaskEventRoundTripsThroughPWAContract() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let board = Board(
            id: "local-board",
            name: "Shared Week",
            kind: .week,
            columns: [],
            nostrBoardID: "test-board-id"
        )
        let task = TaskItem(
            id: "task-1",
            boardID: board.id,
            title: "Sync this",
            note: "Encrypted",
            dueDate: Date(timeIntervalSince1970: 1_753_056_000),
            dueDateEnabled: true,
            priority: .high,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            columnID: WeekdayColumn.sunday.rawValue,
            createdBy: "author",
            lastEditedBy: "author"
        )

        let event = try TaskEventCodec.taskEvent(task: task, board: board, createdAt: 1_700_000_123)
        let decoded = try TaskEventCodec.decodeTaskEvent(event, board: board, calendar: calendar)

        XCTAssertEqual(event.kind, 30_301)
        XCTAssertTrue(event.verify())
        XCTAssertEqual(decoded.task.id, task.id)
        XCTAssertEqual(decoded.task.title, task.title)
        XCTAssertEqual(decoded.task.note, task.note)
        XCTAssertEqual(decoded.task.priority, .high)
        XCTAssertEqual(decoded.task.createdBy, "author")
        XCTAssertEqual(decoded.eventCreatedAt, 1_700_000_123)
    }

    func testTaskDecoderIgnoresPWAFieldsNotYetShownNatively() throws {
        let board = Board(
            id: "local-board",
            name: "Shared Week",
            kind: .week,
            columns: [],
            nostrBoardID: "test-board-id"
        )
        let payload: [String: Any] = [
            "title": "Recurring PWA task",
            "dueISO": "2026-07-20T00:00:00.000Z",
            "recurrence": ["type": "weekly", "interval": 1],
            "images": ["https://example.invalid/encrypted-image"],
        ]
        let content = try BoardCrypto.encrypt(
            JSONSerialization.data(withJSONObject: payload),
            boardID: board.effectiveNostrBoardID
        )
        let event = try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: board.effectiveNostrBoardID),
            createdAt: 1_700_000_456,
            kind: TaskEventCodec.taskEventKind,
            tags: [
                ["d", "recurring-task"],
                ["b", BoardCrypto.boardTag(for: board.effectiveNostrBoardID)],
                ["col", "day"],
                ["status", "open"],
            ],
            content: content
        )

        let decoded = try TaskEventCodec.decodeTaskEvent(event, board: board)
        XCTAssertEqual(decoded.task.title, "Recurring PWA task")
    }

    func testNewerRemoteTombstoneWinsAndOlderEventIsIgnored() throws {
        var snapshot = TaskifySnapshot.empty
        let local = try XCTUnwrap(snapshot.addTask(
            title: "Remove me",
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.monday.rawValue,
            dueDate: nil
        ))
        snapshot.tasks[0].nostrUpdatedAt = 20
        var remote = local
        remote.deleted = true

        XCTAssertFalse(snapshot.mergeRemoteTask(remote, eventCreatedAt: 19))
        XCTAssertFalse(snapshot.tasks[0].isDeleted)
        XCTAssertTrue(snapshot.mergeRemoteTask(remote, eventCreatedAt: 21))
        XCTAssertTrue(snapshot.tasks[0].isDeleted)
        XCTAssertTrue(snapshot.tasks(
            boardID: snapshot.selectedBoardID,
            columnID: WeekdayColumn.monday.rawValue,
            includeCompleted: true
        ).isEmpty)
    }

    func testOutboxKeepsLatestEventForTaskUntilAccepted() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-outbox-\(UUID().uuidString)", isDirectory: true)
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let first = try referenceEvent(content: "first", createdAt: 1)
        let second = try referenceEvent(content: "second", createdAt: 2)

        try await store.enqueue(NostrOutboxEntry(
            event: first,
            relayURLs: TaskifyRelayDefaults.urls,
            boardLocalID: "board",
            taskID: "task"
        ))
        try await store.enqueue(NostrOutboxEntry(
            event: second,
            relayURLs: TaskifyRelayDefaults.urls,
            boardLocalID: "board",
            taskID: "task"
        ))

        let queuedEntries = await store.allEntries()
        XCTAssertEqual(queuedEntries.map(\.event.id), [second.id])
        try await store.markAccepted(eventID: second.id)
        let remainingEntries = await store.allEntries()
        XCTAssertTrue(remainingEntries.isEmpty)
        try? FileManager.default.removeItem(at: directory)
    }

    func testRelayStartupBatchKeepsNewestTaskVersionUntilEOSE() {
        var batch = TaskRelayStartupBatch()
        let older = TaskRelayRecord(
            task: TaskItem(id: "task", boardID: "board", title: "Older"),
            eventCreatedAt: 10
        )
        let newest = TaskRelayRecord(
            task: TaskItem(id: "task", boardID: "board", title: "Newest"),
            eventCreatedAt: 12
        )
        let outOfOrder = TaskRelayRecord(
            task: TaskItem(id: "task", boardID: "board", title: "Out of order"),
            eventCreatedAt: 11
        )

        batch.insert(older)
        batch.insert(newest)
        batch.insert(outOfOrder)

        XCTAssertEqual(batch.drain().map(\.task.title), ["Newest"])
        XCTAssertTrue(batch.drain().isEmpty)
    }

    func testIdentityImportsHexAndNsec() throws {
        let hex = String(repeating: "0", count: 63) + "1"
        let identity = try NostrIdentity(importedValue: hex)
        let restored = try NostrIdentity(importedValue: identity.nsec)

        XCTAssertEqual(restored, identity)
        XCTAssertTrue(identity.npub.hasPrefix("npub1"))
    }

    private func referenceEvent(content: String, createdAt: Int) throws -> NostrEvent {
        try NostrEvent.signed(
            privateKey: Data(hex: String(repeating: "0", count: 63) + "1"),
            createdAt: createdAt,
            kind: 1,
            tags: [],
            content: content
        )
    }
}
