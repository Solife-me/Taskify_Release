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
            images: ["https://originless.example/image"],
            documents: [TaskDocument(
                id: "document-1",
                name: "plan.pdf",
                mimeType: "application/pdf",
                kind: "pdf",
                size: 2_048,
                remoteURL: "https://originless.example/document",
                encrypted: true,
                encryptionBoardID: board.effectiveNostrBoardID
            )],
            subtasks: [
                TaskSubtask(id: "subtask-1", title: "Verify on PWA", completed: true),
            ],
            recurrence: .weekly(days: [1, 3, 5]),
            seriesID: "series-1",
            reminders: [TaskReminder(rawValue: "15m"), TaskReminder(rawValue: "1d")],
            reminderTime: "09:00",
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
        XCTAssertEqual(decoded.task.images, task.images)
        XCTAssertEqual(decoded.task.documents, task.documents)
        XCTAssertEqual(decoded.task.subtasks, task.subtasks)
        XCTAssertEqual(decoded.task.recurrence, task.recurrence)
        XCTAssertEqual(decoded.task.seriesID, "series-1")
        XCTAssertEqual(decoded.task.reminders, task.reminders)
        XCTAssertEqual(decoded.task.reminderTime, "09:00")
        XCTAssertEqual(decoded.task.createdBy, "author")
        XCTAssertEqual(decoded.eventCreatedAt, 1_700_000_123)
    }

    func testTaskDecoderPreservesPWAImagesAndDocuments() throws {
        let board = Board(
            id: "local-board",
            name: "Shared Week",
            kind: .week,
            columns: [],
            nostrBoardID: "test-board-id"
        )
        let payload: [String: Any] = [
            "title": "PWA task with media",
            "dueISO": "2026-07-20T00:00:00.000Z",
            "recurrence": ["type": "weekly", "interval": 1],
            "images": ["https://originless.example/encrypted-image"],
            "documents": [[
                "id": "document-1",
                "name": "plan.pdf",
                "mimeType": "application/pdf",
                "kind": "pdf",
                "size": 1_024,
                "createdAt": "2026-07-20T12:00:00.000Z",
                "remoteUrl": "https://originless.example/encrypted-document",
                "encrypted": true,
                "encryptionBoardId": "test-board-id",
            ]],
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
        XCTAssertEqual(decoded.task.title, "PWA task with media")
        XCTAssertNil(decoded.task.recurrence)
        XCTAssertEqual(decoded.task.images, ["https://originless.example/encrypted-image"])
        XCTAssertEqual(decoded.task.documents?.first?.id, "document-1")
        XCTAssertEqual(decoded.task.documents?.first?.name, "plan.pdf")
        XCTAssertEqual(decoded.task.documents?.first?.remoteURL, "https://originless.example/encrypted-document")
        XCTAssertTrue(decoded.task.documents?.first?.encrypted == true)
        XCTAssertEqual(decoded.task.documents?.first?.encryptionBoardID, "test-board-id")
    }

    func testPWAAttachmentV2FixtureDecrypts() throws {
        let encrypted = try Data(hex: "54464132000102030405060708090a0b8f27e5451df691df487a7a3ab66c5ba3bdb75d2954065d3bec71f93fac8ff6b251b992fa")

        let plaintext = try TaskAttachmentCrypto.decrypt(
            encrypted,
            boardID: "test-board-id"
        )

        XCTAssertEqual(String(data: plaintext, encoding: .utf8), "PWA attachment bytes")
    }

    func testNativeAttachmentEncryptionUsesPWAEnvelope() throws {
        let plaintext = Data("native attachment upload".utf8)

        let encrypted = try TaskAttachmentCrypto.encrypt(
            plaintext,
            boardID: "test-board-id"
        )

        XCTAssertEqual(encrypted.prefix(4), Data("TFA2".utf8))
        XCTAssertNotEqual(encrypted, plaintext)
        XCTAssertEqual(
            try TaskAttachmentCrypto.decrypt(encrypted, boardID: "test-board-id"),
            plaintext
        )
    }

    func testRemoteDocumentFactoryMatchesPWAContract() throws {
        let document = try XCTUnwrap(TaskDocumentContract.remoteDocument(
            name: "release-notes.md",
            mimeType: "text/markdown",
            size: 4_096,
            remoteURL: "https://originless.example/ipfs/cid",
            boardID: "test-board-id",
            createdAt: "2026-07-21T00:00:00.000Z"
        ))

        XCTAssertEqual(document.kind, "md")
        XCTAssertEqual(document.mimeType, "text/markdown")
        XCTAssertEqual(document.remoteURL, "https://originless.example/ipfs/cid")
        XCTAssertTrue(document.encrypted == true)
        XCTAssertEqual(document.encryptionBoardID, "test-board-id")
        XCTAssertNil(document.dataURL)
        XCTAssertNil(document.preview)
        XCTAssertNil(document.full)
        XCTAssertNil(TaskDocumentContract.inferKind(name: "archive.zip", mimeType: "application/zip"))
    }

    func testLegacyPWAAttachmentFixtureStillDecrypts() throws {
        let encrypted = try Data(hex: "000102030405060708090a0bed754622fa5b5a23bea3761aadaa252771c1212c6f54b142cdac4063fcc93c71a2")

        let plaintext = try TaskAttachmentCrypto.decrypt(
            encrypted,
            boardID: "test-board-id"
        )

        XCTAssertEqual(String(data: plaintext, encoding: .utf8), "legacy attachment")
    }

    func testTaskContentFindsFirstPWAStyleHTTPLink() {
        XCTAssertEqual(
            TaskContentLinks.firstURL(
                title: "Research",
                note: "Compare https://example.com/articles/native-ios) before Friday"
            )?.absoluteString,
            "https://example.com/articles/native-ios"
        )
    }

    func testTaskContentRemovesPreviewedURLsWithoutDamagingNotes() {
        XCTAssertEqual(
            TaskContentLinks.removingURLs(
                from: "Review https://example.com/articles/native-ios and share the useful parts."
            ),
            "Review and share the useful parts."
        )
        XCTAssertEqual(
            TaskContentLinks.removingURLs(from: "https://example.com/only"),
            ""
        )
    }

    func testURLOnlyTaskGetsReadableFallbackTitle() throws {
        let url = try XCTUnwrap(URL(string: "https://www.example.com/articles/native-ios/"))

        XCTAssertTrue(TaskContentLinks.isURLOnly("  https://www.example.com/articles/native-ios/  "))
        XCTAssertEqual(TaskContentLinks.fallbackTitle(for: url), "example.com / articles / native-ios")
        XCTAssertFalse(TaskContentLinks.isURLOnly("Read https://example.com"))
    }

    func testRecurrenceEncodesUsingPWAContract() throws {
        let rule = TaskRecurrence.every(2, .week)
        let data = try JSONEncoder().encode(rule)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["type"] as? String, "every")
        XCTAssertEqual(object["n"] as? Int, 2)
        XCTAssertEqual(object["unit"] as? String, "week")
        XCTAssertNil(object["untilISO"])
    }

    func testPWAListBoardMetadataConvertsJoinedBoard() throws {
        let joinedBoard = Board(
            id: "local-board",
            name: "Shared Board",
            kind: .week,
            columns: Board.week().columns,
            nostrBoardID: "test-board-id"
        )
        let payload: [String: Any] = [
            "columns": [
                ["id": "backlog", "name": "Backlog"],
                ["id": "doing", "name": "Doing"],
            ],
            "clearCompletedDisabled": true,
            "listIndex": false,
        ]
        let content = try BoardCrypto.encrypt(
            JSONSerialization.data(withJSONObject: payload),
            boardID: joinedBoard.effectiveNostrBoardID
        )
        let event = try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: joinedBoard.effectiveNostrBoardID),
            createdAt: 1_700_000_789,
            kind: TaskEventCodec.boardEventKind,
            tags: [
                ["d", BoardCrypto.boardTag(for: joinedBoard.effectiveNostrBoardID)],
                ["b", BoardCrypto.boardTag(for: joinedBoard.effectiveNostrBoardID)],
                ["k", "lists"],
                ["name", "PWA Projects"],
            ],
            content: content
        )

        let record = try TaskEventCodec.decodeBoardEvent(event, board: joinedBoard)

        XCTAssertEqual(record.board.kind, .list)
        XCTAssertEqual(record.board.name, "PWA Projects")
        XCTAssertEqual(record.board.columns.map(\.name), ["Backlog", "Doing"])
        XCTAssertEqual(record.board.columns.map(\.order), [0, 1])
        XCTAssertTrue(record.board.clearCompletedDisabled)
        XCTAssertFalse(record.board.indexCardEnabled)
    }

    func testListColumnTagSurvivesBeforeBoardMetadataArrives() throws {
        let joinedBoard = Board(
            id: "local-board",
            name: "Pending metadata",
            kind: .week,
            columns: Board.week().columns,
            nostrBoardID: "test-board-id"
        )
        let content = try BoardCrypto.encrypt(
            JSONSerialization.data(withJSONObject: ["title": "List task"]),
            boardID: joinedBoard.effectiveNostrBoardID
        )
        let event = try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: joinedBoard.effectiveNostrBoardID),
            createdAt: 1_700_000_790,
            kind: TaskEventCodec.taskEventKind,
            tags: [
                ["d", "list-task"],
                ["b", BoardCrypto.boardTag(for: joinedBoard.effectiveNostrBoardID)],
                ["col", "doing"],
                ["status", "open"],
            ],
            content: content
        )

        let record = try TaskEventCodec.decodeTaskEvent(event, board: joinedBoard)
        XCTAssertEqual(record.task.columnID, "doing")
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

    func testSyncReportStaysOnlineWhenOneRelayIsUnavailable() {
        let report = TaskSyncReport(
            relays: [
                TaskRelayStatus(relayURL: "wss://healthy.example", phase: .online),
                TaskRelayStatus(
                    relayURL: "wss://offline.example",
                    phase: .offline,
                    message: "Connection refused"
                ),
            ],
            queuedChangeCount: 0
        )

        XCTAssertEqual(report.state, .online)
        XCTAssertEqual(report.relays.map(\.relayURL), [
            "wss://healthy.example",
            "wss://offline.example",
        ])
    }

    func testSyncReportOnlyReportsOfflineWhenNoRelayIsUsable() {
        let report = TaskSyncReport(
            relays: [
                TaskRelayStatus(
                    relayURL: "wss://offline.example",
                    phase: .offline,
                    message: "Connection refused"
                ),
            ],
            queuedChangeCount: 2
        )

        XCTAssertEqual(report.state, .offline("Connection refused"))
        XCTAssertEqual(report.queuedChangeCount, 2)
    }

    func testRelayWireEncodesNostrMessagesAsJSONText() throws {
        let text = try NostrRelayWire.encode([
            "REQ",
            "taskify-test",
            ["kinds": [30_300, 30_301], "#b": ["board-tag"]] as [String: Any],
        ])
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any]
        )

        XCTAssertEqual(decoded.first as? String, "REQ")
        XCTAssertEqual(decoded[1] as? String, "taskify-test")
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
