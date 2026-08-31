import Foundation
import XCTest
@testable import TaskifyCore

final class CryptoSyncTests: XCTestCase {
    func testRelayURLNormalizationAcceptsNostrSchemesAndDeduplicates() {
        XCTAssertEqual(
            TaskifyRelayURL.normalize(" Relay.Example/ "),
            "wss://relay.example"
        )
        XCTAssertEqual(
            TaskifyRelayURL.normalizedList([
                "wss://relay.example/",
                " WSS://RELAY.EXAMPLE ",
                "ws://localhost:7777",
                "https://not-a-relay.example",
            ]),
            ["wss://relay.example", "ws://localhost:7777"]
        )
        XCTAssertNil(TaskifyRelayURL.normalize("https://not-a-relay.example"))
        XCTAssertNil(TaskifyRelayURL.normalize("wss://user:secret@relay.example"))
    }

    func testSyncConfigurationFingerprintIgnoresPresentationOnlyBoardChanges() {
        let board = Board(
            id: "local-board",
            name: "Original name",
            columns: [BoardColumn(id: "one", name: "One", order: 0)],
            nostrBoardID: "f1a75d28-1ce5-489a-b53a-1e2a447b0cf7",
            relayURLs: ["wss://relay.example", "wss://second.example"]
        )
        var renamed = board
        renamed.name = "Renamed"
        renamed.columns = [BoardColumn(id: "two", name: "Two", order: 0)]
        renamed.nostrUpdatedAt = 100

        let original = TaskSyncConfigurationFingerprint(
            boards: [board],
            auxiliaryRelayURLs: ["wss://inbox.example"],
            inboxPublicKey: String(repeating: "a", count: 64)
        )
        let presentationChange = TaskSyncConfigurationFingerprint(
            boards: [renamed],
            auxiliaryRelayURLs: ["WSS://INBOX.EXAMPLE/"],
            inboxPublicKey: String(repeating: "A", count: 64)
        )

        XCTAssertEqual(original, presentationChange)
    }

    func testSyncConfigurationFingerprintDetectsSubscriptionChanges() {
        let board = Board(
            id: "local-board",
            name: "Board",
            nostrBoardID: "f1a75d28-1ce5-489a-b53a-1e2a447b0cf7",
            relayURLs: ["wss://relay.example"]
        )
        let original = TaskSyncConfigurationFingerprint(
            boards: [board],
            auxiliaryRelayURLs: [],
            inboxPublicKey: String(repeating: "a", count: 64)
        )
        var moved = board
        moved.relayURLs = ["wss://another.example"]
        let relayChange = TaskSyncConfigurationFingerprint(
            boards: [moved],
            auxiliaryRelayURLs: [],
            inboxPublicKey: String(repeating: "a", count: 64)
        )
        let identityChange = TaskSyncConfigurationFingerprint(
            boards: [board],
            auxiliaryRelayURLs: [],
            inboxPublicKey: String(repeating: "b", count: 64)
        )

        XCTAssertNotEqual(original, relayChange)
        XCTAssertNotEqual(original, identityChange)
    }

    func testSyncConfigurationSubscribesToInboxOnlyOnAdvertisedInboxRelays() throws {
        let publicKey = String(repeating: "a", count: 64)
        let fingerprint = TaskSyncConfigurationFingerprint(
            boards: [],
            auxiliaryRelayURLs: [
                "wss://sender-inbox.example",
                "wss://recipient-inbox.example",
            ],
            inboxPublicKey: publicKey,
            inboxRelayURLs: ["wss://sender-inbox.example/"]
        )

        let senderPlan = try XCTUnwrap(fingerprint.relayPlans.first {
            $0.relayURL == "wss://sender-inbox.example"
        })
        let recipientPlan = try XCTUnwrap(fingerprint.relayPlans.first {
            $0.relayURL == "wss://recipient-inbox.example"
        })
        XCTAssertEqual(senderPlan.inboxPublicKey, publicKey)
        XCTAssertNil(recipientPlan.inboxPublicKey)
    }

    func testSyncConfigurationDoesNotUseFallbackInboxRelaysForAnExplicitEmptyList() {
        let fingerprint = TaskSyncConfigurationFingerprint(
            boards: [],
            auxiliaryRelayURLs: ["wss://discovery.example"],
            inboxPublicKey: String(repeating: "b", count: 64),
            inboxRelayURLs: []
        )

        XCTAssertEqual(fingerprint.relayPlans.count, 1)
        XCTAssertNil(fingerprint.relayPlans.first?.inboxPublicKey)
    }

    func testBoardShareContractEncodesPWAEnvelope() throws {
        let board = Board(
            id: "local-board",
            name: "Family Week",
            nostrBoardID: "4f35858d-066b-4f2d-a2f4-235794c77780",
            relayURLs: ["wss://relay.solife.me", "wss://nos.lol"]
        )

        let encoded = try BoardShareContract.encode(board: board)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]
        )
        let item = try XCTUnwrap(object["item"] as? [String: Any])

        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertEqual(object["kind"] as? String, "taskify-share")
        XCTAssertEqual(item["type"] as? String, "board")
        XCTAssertEqual(item["boardId"] as? String, board.nostrBoardID)
        XCTAssertEqual(item["boardName"] as? String, "Family Week")
        XCTAssertEqual(item["relays"] as? [String], ["wss://relay.solife.me", "wss://nos.lol"])
    }

    func testBoardShareContractDecodesPWAEnvelope() throws {
        let fixture = #"{"v":1,"kind":"taskify-share","item":{"type":"board","boardId":"4f35858d-066b-4f2d-a2f4-235794c77780","boardName":"Family Week","relays":[" wss://relay.solife.me ","wss://relay.solife.me","wss://nos.lol"]}}"#

        let decoded = try XCTUnwrap(BoardShareContract.decode(fixture))

        XCTAssertEqual(decoded.boardID, "4f35858d-066b-4f2d-a2f4-235794c77780")
        XCTAssertEqual(decoded.boardName, "Family Week")
        XCTAssertEqual(decoded.relayURLs, ["wss://relay.solife.me", "wss://nos.lol"])
    }

    func testBoardShareContractAcceptsRawUUIDButRejectsOtherText() {
        let boardID = "4f35858d-066b-4f2d-a2f4-235794c77780"

        XCTAssertEqual(BoardShareContract.decode(boardID)?.boardID, boardID)
        XCTAssertNil(BoardShareContract.decode("not a Taskify board share"))
    }

    func testTemplateSnapshotUsesAnIndependentBoardKeyAndPreservesTasks() throws {
        let source = Board(
            id: "local-family-board",
            name: "Family Week",
            kind: .week,
            nostrBoardID: "4f35858d-066b-4f2d-a2f4-235794c77780",
            relayURLs: ["wss://relay.solife.me"]
        )
        let templateID = "f1a75d28-1ce5-489a-b53a-1e2a447b0cf7"
        let template = source.templateSnapshot(boardID: templateID)
        let task = TaskItem(
            id: "task-1",
            boardID: source.id,
            title: "Pack lunches",
            note: "Independent template content",
            dueDate: Date(timeIntervalSince1970: 1_753_056_000),
            dueDateEnabled: true,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            columnID: WeekdayColumn.sunday.rawValue
        )

        XCTAssertEqual(template.id, "template-\(templateID)")
        XCTAssertEqual(template.effectiveNostrBoardID, templateID)
        XCTAssertNotEqual(template.effectiveNostrBoardID, source.effectiveNostrBoardID)
        XCTAssertEqual(template.name, source.name)
        XCTAssertEqual(template.kind, source.kind)
        XCTAssertEqual(template.effectiveRelayURLs, source.effectiveRelayURLs)

        let boardEvent = try TaskEventCodec.boardEvent(board: template, createdAt: 1_700_000_100)
        let taskEvent = try TaskEventCodec.taskEvent(task: task, board: template, createdAt: 1_700_000_101)
        let joinedTemplate = Board(
            id: "joined-template",
            name: "Shared Board",
            kind: .week,
            nostrBoardID: templateID,
            relayURLs: template.effectiveRelayURLs
        )

        let decodedBoard = try TaskEventCodec.decodeBoardEvent(boardEvent, board: joinedTemplate)
        let decodedTask = try TaskEventCodec.decodeTaskEvent(taskEvent, board: joinedTemplate)

        XCTAssertEqual(decodedBoard.board.name, source.name)
        XCTAssertEqual(decodedTask.task.boardID, joinedTemplate.id)
        XCTAssertEqual(decodedTask.task.title, task.title)
        XCTAssertEqual(decodedTask.task.note, task.note)
    }

    func testTemplateSnapshotRehomesTaskifyEventsUnderTheIndependentBoardKey() throws {
        let source = Board(
            id: "local-family-board",
            name: "Family Week",
            kind: .week,
            nostrBoardID: "4f35858d-066b-4f2d-a2f4-235794c77780",
            relayURLs: ["wss://relay.solife.me"]
        )
        let templateID = "f1a75d28-1ce5-489a-b53a-1e2a447b0cf7"
        let template = source.templateSnapshot(boardID: templateID)
        let event = TaskifyEvent(
            id: "event-1",
            boardID: source.id,
            title: "Family dinner",
            details: "Bring dessert",
            schedule: .time,
            startISO: "2026-08-04T23:00:00Z",
            endISO: "2026-08-05T00:00:00Z",
            canonicalAddress: "30310:old:event-1",
            viewAddress: "30311:old:event-1",
            eventKey: Data(repeating: 7, count: 32).base64EncodedString(),
            inviteToken: "",
            relayURLs: source.effectiveRelayURLs,
            rsvpStatus: .accepted,
            readOnly: false,
            deleted: false,
            nostrUpdatedAt: 1_700_000_000
        )

        let snapshot = try XCTUnwrap(TaskifyEventTemplateSnapshot.make(
            event: event,
            sourceBoard: source,
            templateBoard: template
        ))
        XCTAssertEqual(snapshot.boardID, template.id)
        XCTAssertEqual(snapshot.title, event.title)
        XCTAssertEqual(snapshot.details, event.details)
        XCTAssertEqual(snapshot.eventKey, event.eventKey)
        XCTAssertEqual(snapshot.canonicalAddress, "")
        XCTAssertEqual(snapshot.viewAddress, "")
        XCTAssertEqual(snapshot.relayURLs, template.effectiveRelayURLs)
        XCTAssertNil(snapshot.nostrUpdatedAt)

        let pair = try TaskifyCalendarEventCodec.eventPair(
            event: snapshot,
            board: template,
            createdAt: 1_700_000_100
        )
        let joinedTemplate = Board(
            id: "joined-template",
            name: "Shared Board",
            kind: .week,
            nostrBoardID: templateID,
            relayURLs: template.effectiveRelayURLs
        )
        let decoded = try TaskifyCalendarEventCodec.decodeCanonicalEvent(
            pair.canonical,
            board: joinedTemplate
        )
        XCTAssertEqual(decoded.event.boardID, joinedTemplate.id)
        XCTAssertEqual(decoded.event.title, event.title)
        XCTAssertEqual(decoded.event.details, event.details)

        var external = event
        external.readOnly = true
        XCTAssertNil(TaskifyEventTemplateSnapshot.make(
            event: external,
            sourceBoard: source,
            templateBoard: template
        ))
    }

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

    func testTaskifyCalendarEventRoundTripsThroughPWAContract() throws {
        let board = Board(
            id: "local-board",
            name: "Shared Week",
            kind: .week,
            columns: [],
            nostrBoardID: "test-board-id",
            relayURLs: ["wss://relay.solife.me"]
        )
        let eventKey = Data(repeating: 9, count: 32).base64EncodedString()
        let taskifyEvent = TaskifyEvent(
            id: "event-1",
            boardID: board.id,
            order: 2,
            title: "PWA parity review",
            details: "Verify both event records",
            locations: ["Remote"],
            schedule: .time,
            startISO: "2026-07-24T15:00:00.000Z",
            endISO: "2026-07-24T16:00:00.000Z",
            startTimeZoneID: "America/Chicago",
            endTimeZoneID: "America/Chicago",
            reminders: [TaskReminder(rawValue: "15m"), TaskReminder(rawValue: "1h")],
            recurrence: .weekly(days: [5]),
            seriesID: "event-1",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: eventKey,
            inviteToken: "",
            rsvpStatus: .accepted,
            readOnly: false
        )

        let pair = try TaskifyCalendarEventCodec.eventPair(
            event: taskifyEvent,
            board: board,
            createdAt: 1_700_000_500
        )
        XCTAssertEqual(pair.canonical.kind, 30_310)
        XCTAssertEqual(pair.view.kind, 30_311)
        XCTAssertEqual(pair.canonical.firstTagValue(named: "b"), BoardCrypto.boardTag(for: "test-board-id"))
        XCTAssertEqual(pair.view.firstTagValue(named: "a"), pair.normalizedEvent.canonicalAddress)
        XCTAssertTrue(pair.canonical.verify())
        XCTAssertTrue(pair.view.verify())

        let boardPrivateKey = BoardCrypto.signingPrivateKey(for: board.effectiveNostrBoardID)
        let boardPublicKey = try BoardCrypto.signingPublicKey(for: board.effectiveNostrBoardID)
        let canonicalPlaintext = try NIP44V2.decrypt(
            pair.canonical.content,
            privateKey: boardPrivateKey,
            publicKey: boardPublicKey
        )
        let canonical = try XCTUnwrap(
            JSONSerialization.jsonObject(with: canonicalPlaintext) as? [String: Any]
        )
        XCTAssertEqual(canonical["v"] as? Int, 1)
        XCTAssertEqual(canonical["eventId"] as? String, "event-1")
        XCTAssertEqual(canonical["eventKey"] as? String, eventKey)
        XCTAssertEqual(canonical["kind"] as? String, "time")
        XCTAssertEqual(canonical["description"] as? String, "Verify both event records")
        XCTAssertEqual(canonical["reminders"] as? [String], ["15m", "1h"])
        XCTAssertEqual(canonical["seriesId"] as? String, "event-1")

        let viewPlaintext = try NIP44V2.decrypt(
            pair.view.content,
            conversationKey: try XCTUnwrap(Data(base64Encoded: eventKey))
        )
        let view = try XCTUnwrap(
            JSONSerialization.jsonObject(with: viewPlaintext) as? [String: Any]
        )
        XCTAssertNil(view["eventKey"])
        XCTAssertEqual(view["title"] as? String, "PWA parity review")
        XCTAssertEqual(view["reminders"] as? [String], ["15m", "1h"])

        let decoded = try TaskifyCalendarEventCodec.decodeCanonicalEvent(
            pair.canonical,
            board: board
        )
        XCTAssertEqual(decoded.event.title, taskifyEvent.title)
        XCTAssertEqual(decoded.event.details, taskifyEvent.details)
        XCTAssertEqual(decoded.event.schedule, .time)
        XCTAssertEqual(decoded.event.boardID, board.id)
        XCTAssertEqual(decoded.event.reminders, taskifyEvent.reminders)
        XCTAssertEqual(decoded.event.recurrence, taskifyEvent.recurrence)
        XCTAssertEqual(decoded.event.seriesID, taskifyEvent.seriesID)
        XCTAssertFalse(decoded.event.isReadOnly)
        XCTAssertEqual(decoded.event.nostrUpdatedAt, 1_700_000_500)
    }

    func testTaskifyCalendarMoveTombstoneRoundTripsThroughPWAContract() throws {
        let board = Board(
            id: "source-board",
            name: "Source",
            kind: .week,
            columns: [],
            nostrBoardID: "source-board-id"
        )
        let taskifyEvent = TaskifyEvent(
            id: "moved-event",
            boardID: board.id,
            title: "Moved event",
            schedule: .date,
            startDateValue: "2026-07-30",
            recurrence: .daily(
                until: try XCTUnwrap(TaskifyEvent.dateOnly("2026-07-29"))
            ),
            seriesID: "event-series",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: Data(repeating: 10, count: 32).base64EncodedString(),
            inviteToken: "",
            rsvpStatus: .accepted,
            readOnly: false,
            deleted: true
        )

        let pair = try TaskifyCalendarEventCodec.eventPair(
            event: taskifyEvent,
            board: board,
            createdAt: 1_700_000_700
        )
        let boardPrivateKey = BoardCrypto.signingPrivateKey(for: board.effectiveNostrBoardID)
        let boardPublicKey = try BoardCrypto.signingPublicKey(for: board.effectiveNostrBoardID)
        let canonicalPlaintext = try NIP44V2.decrypt(
            pair.canonical.content,
            privateKey: boardPrivateKey,
            publicKey: boardPublicKey
        )
        let canonical = try XCTUnwrap(
            JSONSerialization.jsonObject(with: canonicalPlaintext) as? [String: Any]
        )

        XCTAssertEqual(canonical["deleted"] as? Bool, true)
        XCTAssertNil(canonical["title"])
        XCTAssertNil(canonical["kind"])
        XCTAssertEqual(canonical["seriesId"] as? String, "event-series")
        XCTAssertNotNil(canonical["recurrence"])
        let decoded = try TaskifyCalendarEventCodec.decodeCanonicalEvent(
            pair.canonical,
            board: board
        )
        XCTAssertTrue(decoded.event.isDeleted)
        XCTAssertEqual(decoded.event.id, taskifyEvent.id)
        XCTAssertEqual(decoded.event.recurrence, taskifyEvent.recurrence)
        XCTAssertEqual(decoded.event.seriesID, taskifyEvent.seriesID)
        XCTAssertEqual(decoded.event.nostrUpdatedAt, 1_700_000_700)
    }

    func testTaskifyCalendarDecoderPreservesPWASchedulingFields() throws {
        let board = Board(
            id: "local-board",
            name: "Shared Week",
            kind: .week,
            columns: [],
            nostrBoardID: "test-board-id"
        )
        let eventKey = Data(repeating: 6, count: 32).base64EncodedString()
        let payload: [String: Any] = [
            "v": 1,
            "eventId": "scheduled-event",
            "eventKey": eventKey,
            "kind": "time",
            "title": "Recurring PWA event",
            "startISO": "2026-07-27T14:00:00.000Z",
            "endISO": "2026-07-27T15:00:00.000Z",
            "startTzid": "America/Chicago",
            "endTzid": "America/Chicago",
            "reminders": ["15m", "1h"],
            "recurrence": ["type": "weekly", "days": [1, 3, 5]],
            "seriesId": "event-series-1",
        ]
        let boardPrivateKey = BoardCrypto.signingPrivateKey(for: board.effectiveNostrBoardID)
        let boardPublicKey = try BoardCrypto.signingPublicKey(for: board.effectiveNostrBoardID)
        let content = try NIP44V2.encrypt(
            JSONSerialization.data(withJSONObject: payload),
            privateKey: boardPrivateKey,
            publicKey: boardPublicKey
        )
        let nostrEvent = try NostrEvent.signed(
            privateKey: boardPrivateKey,
            createdAt: 1_700_000_600,
            kind: TaskifyCalendarEventCodec.canonicalEventKind,
            tags: [
                ["d", "scheduled-event"],
                ["b", BoardCrypto.boardTag(for: board.effectiveNostrBoardID)],
                ["col", "day"],
            ],
            content: content
        )

        let decoded = try TaskifyCalendarEventCodec.decodeCanonicalEvent(nostrEvent, board: board)

        XCTAssertEqual(decoded.event.reminders, [
            TaskReminder(rawValue: "15m"),
            TaskReminder(rawValue: "1h"),
        ])
        XCTAssertEqual(decoded.event.recurrence, .weekly(days: [1, 3, 5]))
        XCTAssertEqual(decoded.event.seriesID, "event-series-1")
    }

    func testNativeEditPreservesUnsupportedAndFuturePWATaskFields() throws {
        let board = Board(
            id: "local-board",
            name: "Shared Week",
            kind: .week,
            columns: [],
            nostrBoardID: "test-board-id"
        )
        let payload: [String: Any] = [
            "title": "Advanced PWA task",
            "note": "Keep every advanced field",
            "dueISO": "2026-07-21T14:00:00.000Z",
            "createdAt": 1_700_000_000_000,
            "streak": 7,
            "longestStreak": 19,
            "assignees": [[
                "pubkey": String(repeating: "a", count: 64),
                "relay": "wss://relay.example",
                "status": "accepted",
                "respondedAt": 1_700_000_123_456,
            ]],
            "bounty": [
                "id": "bounty-1",
                "token": "cashuAexample",
                "amount": 21,
                "state": "locked",
                "updatedAt": "2026-07-21T13:59:00.000Z",
                "enc": [
                    "alg": "aes-gcm-256",
                    "iv": "fixture-iv",
                    "ct": "fixture-ciphertext",
                ],
            ],
            "inboxItem": [
                "type": "task",
                "receivedAt": "2026-07-21T13:30:00.000Z",
                "status": "accepted",
                "sender": [
                    "pubkey": String(repeating: "b", count: 64),
                    "name": "PWA sender",
                ],
            ],
            "scriptureMemoryId": "scripture-entry-1",
            "scriptureMemoryStage": 4,
            "scriptureMemoryPrevReviewISO": "2026-07-20T14:00:00.000Z",
            "scriptureMemoryScheduledAt": "2026-07-21T08:00:00.000Z",
            "bountyDeletedAt": NSNull(),
            "futureTaskifyFeature": [
                "enabled": true,
                "threshold": 2.5,
                "labels": ["one", "two"],
                "optional": NSNull(),
            ],
        ]
        let content = try BoardCrypto.encrypt(
            JSONSerialization.data(withJSONObject: payload),
            boardID: board.effectiveNostrBoardID
        )
        let incomingEvent = try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: board.effectiveNostrBoardID),
            createdAt: 1_700_000_500,
            kind: TaskEventCodec.taskEventKind,
            tags: [
                ["d", "advanced-task"],
                ["b", BoardCrypto.boardTag(for: board.effectiveNostrBoardID)],
                ["col", "day"],
                ["status", "open"],
            ],
            content: content
        )

        let decoded = try TaskEventCodec.decodeTaskEvent(incomingEvent, board: board)
        XCTAssertNil(decoded.task.preservedSyncFields?["title"])
        XCTAssertEqual(decoded.task.preservedSyncFields?["streak"], .integer(7))
        XCTAssertEqual(decoded.task.preservedSyncFields?["longestStreak"], .integer(19))
        XCTAssertNil(decoded.task.preservedSyncFields?["scriptureMemoryStage"])
        XCTAssertEqual(decoded.task.scriptureMemoryID, "scripture-entry-1")
        XCTAssertEqual(decoded.task.scriptureMemoryStage, 4)
        XCTAssertEqual(decoded.task.scriptureMemoryPreviousReviewISO, "2026-07-20T14:00:00.000Z")
        XCTAssertEqual(decoded.task.scriptureMemoryScheduledAtISO, "2026-07-21T08:00:00.000Z")
        XCTAssertEqual(decoded.task.preservedSyncFields?["bountyDeletedAt"], .null)

        let localData = try JSONEncoder().encode(decoded.task)
        var edited = try JSONDecoder().decode(TaskItem.self, from: localData)
        edited.title = "Edited safely on iOS"
        edited.completed = true
        edited.completedAt = Date(timeIntervalSince1970: 1_753_107_660)
        edited.lastEditedBy = String(repeating: "c", count: 64)

        let outgoingEvent = try TaskEventCodec.taskEvent(
            task: edited,
            board: board,
            createdAt: 1_700_000_600
        )
        let outgoingData = try BoardCrypto.decrypt(
            outgoingEvent.content,
            boardID: board.effectiveNostrBoardID
        )
        let outgoing = try XCTUnwrap(
            JSONSerialization.jsonObject(with: outgoingData) as? [String: Any]
        )

        XCTAssertEqual(outgoing["title"] as? String, "Edited safely on iOS")
        XCTAssertEqual(outgoing["streak"] as? Int, 7)
        XCTAssertEqual(outgoing["longestStreak"] as? Int, 19)
        XCTAssertEqual(outgoing["scriptureMemoryId"] as? String, "scripture-entry-1")
        XCTAssertEqual(outgoing["scriptureMemoryStage"] as? Int, 4)
        XCTAssertEqual(outgoing["scriptureMemoryPrevReviewISO"] as? String, "2026-07-20T14:00:00.000Z")
        XCTAssertEqual(outgoing["scriptureMemoryScheduledAt"] as? String, "2026-07-21T08:00:00.000Z")
        XCTAssertTrue(outgoing["bountyDeletedAt"] is NSNull)

        let assignee = try XCTUnwrap((outgoing["assignees"] as? [[String: Any]])?.first)
        XCTAssertEqual(assignee["status"] as? String, "accepted")
        XCTAssertEqual(assignee["respondedAt"] as? Int64, 1_700_000_123_456)

        let bounty = try XCTUnwrap(outgoing["bounty"] as? [String: Any])
        XCTAssertEqual(bounty["amount"] as? Int, 21)
        XCTAssertEqual((bounty["enc"] as? [String: Any])?["alg"] as? String, "aes-gcm-256")

        let inboxItem = try XCTUnwrap(outgoing["inboxItem"] as? [String: Any])
        XCTAssertEqual((inboxItem["sender"] as? [String: Any])?["name"] as? String, "PWA sender")

        let future = try XCTUnwrap(outgoing["futureTaskifyFeature"] as? [String: Any])
        XCTAssertEqual(future["enabled"] as? Bool, true)
        XCTAssertEqual(future["threshold"] as? Double, 2.5)
        XCTAssertEqual(future["labels"] as? [String], ["one", "two"])
        XCTAssertTrue(future["optional"] is NSNull)
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

    func testChatLinkExtractionMatchesPWAAndPreservesMessageOrder() {
        let links = TaskContentLinks.allURLs(
            in: "Read (https://example.com/native-ios) then https://taskify.example/help?q=chat"
        )

        XCTAssertEqual(links.map(\.absoluteString), [
            "https://example.com/native-ios",
            "https://taskify.example/help?q=chat",
        ])
        XCTAssertTrue(TaskContentLinks.allURLs(in: "nostr:example and ftp://example.com").isEmpty)
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

    func testFaviconURLUsesThePWAsFaviconServiceAndDomain() throws {
        let url = try XCTUnwrap(URL(string: "https://www.example.com/articles/native-ios/"))
        let favicon = try XCTUnwrap(TaskContentLinks.faviconURL(for: url))
        let components = try XCTUnwrap(URLComponents(url: favicon, resolvingAgainstBaseURL: false))

        XCTAssertEqual(components.host, "www.google.com")
        XCTAssertEqual(components.path, "/s2/favicons")
        XCTAssertEqual(
            components.queryItems?.first(where: { $0.name == "domain" })?.value,
            "www.example.com"
        )
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

    func testPWACompoundMetadataConvertsJoinedBoard() throws {
        let joinedBoard = Board(
            id: "local-compound",
            name: "Pending metadata",
            kind: .week,
            columns: Board.week().columns,
            nostrBoardID: "compound-board-id"
        )
        let payload: [String: Any] = [
            "children": ["child-a", "child-b", "child-a", ""],
            "clearCompletedDisabled": true,
            "listIndex": true,
            "hideBoardNames": true,
        ]
        let content = try BoardCrypto.encrypt(
            JSONSerialization.data(withJSONObject: payload),
            boardID: joinedBoard.effectiveNostrBoardID
        )
        let event = try NostrEvent.signed(
            privateKey: BoardCrypto.signingPrivateKey(for: joinedBoard.effectiveNostrBoardID),
            createdAt: 1_700_000_791,
            kind: TaskEventCodec.boardEventKind,
            tags: [
                ["d", BoardCrypto.boardTag(for: joinedBoard.effectiveNostrBoardID)],
                ["b", BoardCrypto.boardTag(for: joinedBoard.effectiveNostrBoardID)],
                ["k", "compound"],
                ["name", "All Projects"],
            ],
            content: content
        )

        let record = try TaskEventCodec.decodeBoardEvent(event, board: joinedBoard)

        XCTAssertEqual(record.board.kind, .compound)
        XCTAssertEqual(record.board.name, "All Projects")
        XCTAssertEqual(record.board.children, ["child-a", "child-b"])
        XCTAssertTrue(record.board.clearCompletedDisabled)
        XCTAssertTrue(record.board.indexCardEnabled)
        XCTAssertTrue(record.board.hideChildBoardNames)
        XCTAssertTrue(record.board.columns.isEmpty)
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
        let staleVersionPending = await store.isPending(
            eventID: first.id,
            relayURL: TaskifyRelayDefaults.urls[0]
        )
        let currentVersionPending = await store.isPending(
            eventID: second.id,
            relayURL: TaskifyRelayDefaults.urls[0]
        )
        XCTAssertFalse(staleVersionPending)
        XCTAssertTrue(currentVersionPending)
        for relayURL in TaskifyRelayDefaults.urls {
            try await store.markAccepted(eventID: second.id, relayURL: relayURL)
        }
        let remainingEntries = await store.allEntries()
        XCTAssertTrue(remainingEntries.isEmpty)
        try? FileManager.default.removeItem(at: directory)
    }

    func testOutboxKeepsEventUntilEveryRelayAcknowledgesIt() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-relay-acks-\(UUID().uuidString)", isDirectory: true)
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let event = try referenceEvent(content: "multi-relay", createdAt: 3)
        let relays = ["wss://one.example", "wss://two.example"]

        try await store.enqueue(NostrOutboxEntry(
            event: event,
            relayURLs: relays,
            boardLocalID: "board",
            taskID: "task"
        ))
        try await store.markAccepted(eventID: event.id, relayURL: relays[0])

        var queuedEntries = await store.allEntries()
        XCTAssertEqual(queuedEntries.count, 1)
        XCTAssertEqual(queuedEntries[0].pendingRelayURLs, [relays[1]])
        let acknowledgedRelayPending = await store.isPending(
            eventID: event.id,
            relayURL: relays[0]
        )
        let unacknowledgedRelayPending = await store.isPending(
            eventID: event.id,
            relayURL: relays[1]
        )
        XCTAssertFalse(acknowledgedRelayPending)
        XCTAssertTrue(unacknowledgedRelayPending)

        try await store.markAccepted(eventID: event.id, relayURL: relays[1])
        queuedEntries = await store.allEntries()
        XCTAssertTrue(queuedEntries.isEmpty)
        try? FileManager.default.removeItem(at: directory)
    }

    func testOutboxAnyRelayPolicyCompletesAfterFirstAcknowledgement() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-any-relay-ack-\(UUID().uuidString)", isDirectory: true)
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let event = try referenceEvent(content: "dm", createdAt: 30)
        let entry = NostrOutboxEntry(
            event: event,
            relayURLs: ["wss://one.example", "wss://two.example"],
            boardLocalID: "__taskify-direct-messages__",
            taskID: "rumor:recipient",
            acknowledgementPolicy: .anyRelay,
            expiresAt: Date(timeIntervalSince1970: 20_000)
        )

        try await store.enqueue(entry)
        let completed = try await store.markAccepted(
            eventID: event.id,
            relayURL: "wss://one.example"
        )

        XCTAssertEqual(completed?.taskID, "rumor:recipient")
        let remaining = await store.allEntries()
        XCTAssertTrue(remaining.isEmpty)
        try? FileManager.default.removeItem(at: directory)
    }

    func testOutboxPrunesExpiredEntriesAndReturnsThemForFailureReporting() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-expired-outbox-\(UUID().uuidString)", isDirectory: true)
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let expiredEvent = try referenceEvent(content: "expired", createdAt: 31)
        let activeEvent = try referenceEvent(content: "active", createdAt: 32)
        try await store.enqueue([
            NostrOutboxEntry(
                event: expiredEvent,
                relayURLs: ["wss://one.example"],
                boardLocalID: "__taskify-direct-messages__",
                taskID: "expired:recipient",
                expiresAt: Date(timeIntervalSince1970: 100)
            ),
            NostrOutboxEntry(
                event: activeEvent,
                relayURLs: ["wss://one.example"],
                boardLocalID: "__taskify-direct-messages__",
                taskID: "active:recipient",
                expiresAt: Date(timeIntervalSince1970: 300)
            ),
        ])

        let expired = try await store.removeExpired(now: Date(timeIntervalSince1970: 200))
        let remaining = await store.allEntries()

        XCTAssertEqual(expired.map(\.taskID), ["expired:recipient"])
        XCTAssertEqual(remaining.map(\.taskID), ["active:recipient"])
        try? FileManager.default.removeItem(at: directory)
    }

    func testSyncEngineAtomicallyQueuesRelayPublishBatchWithoutWaitingForDelivery() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-dm-batch-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        let store = NostrOutboxStore(fileURL: fileURL)
        let engine = TaskSyncEngine(outbox: store)
        let recipient = try referenceEvent(content: "recipient", createdAt: 40)
        let sender = try referenceEvent(content: "sender", createdAt: 41)

        try await engine.enqueueForPublish([
            TaskSyncRelayPublishRequest(
                event: recipient,
                relayURLs: ["wss://recipient.example"],
                outboxScope: "__taskify-direct-messages__",
                recordID: "rumor:recipient",
                acknowledgementPolicy: .anyRelay
            ),
            TaskSyncRelayPublishRequest(
                event: sender,
                relayURLs: ["wss://sender.example"],
                outboxScope: "__taskify-direct-messages__",
                recordID: "rumor:sender",
                acknowledgementPolicy: .anyRelay
            ),
        ])

        let pendingCount = await engine.pendingPublishCount()
        let reloaded = NostrOutboxStore(fileURL: fileURL)
        let persisted = await reloaded.allEntries()
        XCTAssertEqual(pendingCount, 2)
        XCTAssertEqual(persisted.map(\.taskID), [
            "rumor:recipient",
            "rumor:sender",
        ])
        try? FileManager.default.removeItem(at: directory)
    }

    func testOutboxRetargetsQueuedBoardEventsWhenRelaysChange() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-relay-retarget-\(UUID().uuidString)", isDirectory: true)
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let event = try referenceEvent(content: "retarget", createdAt: 4)

        try await store.enqueue(NostrOutboxEntry(
            event: event,
            relayURLs: ["wss://one.example", "wss://removed.example"],
            boardLocalID: "board",
            taskID: "task"
        ))
        try await store.markAccepted(eventID: event.id, relayURL: "wss://one.example")
        try await store.replaceRelayTargets(
            boardLocalID: "board",
            relayURLs: ["wss://one.example", "wss://new.example"]
        )

        let entries = await store.allEntries()
        let queued = try XCTUnwrap(entries.first)
        XCTAssertEqual(queued.relayURLs, ["wss://one.example", "wss://new.example"])
        XCTAssertEqual(queued.acceptedRelayURLs, ["wss://one.example"])
        XCTAssertEqual(queued.pendingRelayURLs, ["wss://new.example"])
        try? FileManager.default.removeItem(at: directory)
    }

    func testOutboxCanDiscardAnImportedIdentityScopeWithoutLosingTaskChanges() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-account-outbox-\(UUID().uuidString)", isDirectory: true)
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let accountEvent = try referenceEvent(content: "old identity backup", createdAt: 5)
        let taskEvent = try referenceEvent(content: "task change", createdAt: 6)
        try await store.enqueue(NostrOutboxEntry(
            event: accountEvent,
            relayURLs: TaskifyRelayDefaults.urls,
            boardLocalID: "__taskify-account-backup__",
            taskID: "taskify-app-backup"
        ))
        try await store.enqueue(NostrOutboxEntry(
            event: taskEvent,
            relayURLs: TaskifyRelayDefaults.urls,
            boardLocalID: "board",
            taskID: "task"
        ))

        try await store.removeEntries(boardLocalID: "__taskify-account-backup__")

        let remaining = await store.allEntries()
        XCTAssertEqual(remaining.map(\.event.id), [taskEvent.id])
        try? FileManager.default.removeItem(at: directory)
    }

    func testRelayPublishPacerSpacesBurstsAndBacksOffPerRelay() {
        var pacer = RelayPublishPacer(
            defaultInterval: 0.05,
            baseBackoff: 2,
            maximumBackoff: 30
        )

        XCTAssertEqual(pacer.delayBeforePublish(at: 100), 0, accuracy: 0.001)
        pacer.recordPublish(at: 100)
        XCTAssertEqual(pacer.delayBeforePublish(at: 100.01), 0.04, accuracy: 0.001)

        let firstBackoff = pacer.recordRateLimit(at: 100.1)
        XCTAssertEqual(firstBackoff, 2, accuracy: 0.001)
        XCTAssertEqual(pacer.currentInterval, 0.1, accuracy: 0.001)
        XCTAssertEqual(pacer.delayBeforePublish(at: 101), 1.1, accuracy: 0.001)
        XCTAssertTrue(NostrRelayRejection.isRateLimited("rate-limited: slow down"))
        XCTAssertTrue(NostrRelayRejection.isRateLimited(" RATE-LIMITED: burst "))
        XCTAssertFalse(NostrRelayRejection.isRateLimited("blocked: not allowed"))

        let secondBackoff = pacer.recordRateLimit(at: 102.1)
        XCTAssertEqual(secondBackoff, 4, accuracy: 0.001)
        XCTAssertEqual(pacer.delayBeforePublish(at: 103), 3.1, accuracy: 0.001)
    }

    func testDefaultRelayPacerSendsHealthySixtyTaskTemplateWithinFewSeconds() {
        var pacer = RelayPublishPacer()
        var now: TimeInterval = 100
        let startedAt = now

        // One board metadata event plus sixty task events.
        for _ in 0..<61 {
            now += pacer.delayBeforePublish(at: now)
            pacer.recordPublish(at: now)
        }

        XCTAssertLessThanOrEqual(now - startedAt, 3.01)
    }

    func testTemplateOutboxEntriesDoNotReplaceLiveBoardEntries() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-template-outbox-\(UUID().uuidString)", isDirectory: true)
        let store = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let liveEvent = try referenceEvent(content: "live", createdAt: 1)
        let templateEvent = try referenceEvent(content: "template", createdAt: 2)
        let liveBoard = Board(id: "live-local", name: "Live")
        let templateBoard = liveBoard.templateSnapshot(
            boardID: "f1a75d28-1ce5-489a-b53a-1e2a447b0cf7"
        )

        try await store.enqueue(NostrOutboxEntry(
            event: liveEvent,
            relayURLs: liveBoard.effectiveRelayURLs,
            boardLocalID: liveBoard.id,
            taskID: "task"
        ))
        try await store.enqueue(NostrOutboxEntry(
            event: templateEvent,
            relayURLs: templateBoard.effectiveRelayURLs,
            boardLocalID: templateBoard.id,
            taskID: "task"
        ))

        let queuedEntries = await store.allEntries()
        XCTAssertEqual(queuedEntries.count, 2)
        XCTAssertEqual(Set(queuedEntries.map(\.boardLocalID)), Set([liveBoard.id, templateBoard.id]))
        try? FileManager.default.removeItem(at: directory)
    }

    func testSyncEngineQueuesTemplateBatchBeforeBackgroundDelivery() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-template-batch-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        let store = NostrOutboxStore(fileURL: fileURL)
        let engine = TaskSyncEngine(outbox: store)
        let board = Board(id: "template-local", name: "Template").templateSnapshot(
            boardID: "f1a75d28-1ce5-489a-b53a-1e2a447b0cf7"
        )
        let boardEvent = try TaskEventCodec.boardEvent(board: board, createdAt: 10)
        let task = TaskItem(id: "task", boardID: board.id, title: "Queued task")
        let taskEvent = try TaskEventCodec.taskEvent(task: task, board: board, createdAt: 11)

        try await engine.queueForPublish([
            TaskSyncPublishRequest(event: boardEvent, board: board, taskID: "_board"),
            TaskSyncPublishRequest(event: taskEvent, board: board, taskID: task.id),
        ])

        let pendingPublishCount = await engine.pendingPublishCount()
        XCTAssertEqual(pendingPublishCount, 2)
        let queuedEntries = await store.allEntries()
        XCTAssertEqual(queuedEntries.map(\.event.id), [boardEvent.id, taskEvent.id])

        let reloadedStore = NostrOutboxStore(fileURL: fileURL)
        let persistedEntries = await reloadedStore.allEntries()
        XCTAssertEqual(persistedEntries.map(\.event.id), [boardEvent.id, taskEvent.id])
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

    func testRelayStartupBatchDeduplicatesAndOrdersSharedInboxEvents() {
        var batch = TaskRelayStartupBatch()
        let newer = NostrEvent(
            id: "newer",
            publicKey: "sender",
            createdAt: 12,
            kind: NIP17GiftWrap.wrapKind,
            tags: [],
            content: "newer",
            signature: "signature"
        )
        let older = NostrEvent(
            id: "older",
            publicKey: "sender",
            createdAt: 10,
            kind: NIP17GiftWrap.wrapKind,
            tags: [],
            content: "older",
            signature: "signature"
        )

        batch.insert(sharedInboxEvent: newer)
        batch.insert(sharedInboxEvent: older)
        batch.insert(sharedInboxEvent: newer)

        XCTAssertEqual(batch.drainSharedInboxEvents().map(\.id), ["older", "newer"])
        XCTAssertTrue(batch.drainSharedInboxEvents().isEmpty)
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

    func testDisconnectedRelayHealthCheckFailsWithoutWaitingForTimeout() async {
        let connection = NostrRelayConnection(relayURL: "wss://relay.example")
        let startedAt = ProcessInfo.processInfo.systemUptime

        let isResponsive = await connection.isResponsive(timeout: .seconds(5))

        XCTAssertFalse(isResponsive)
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - startedAt, 0.25)
    }

    func testForegroundRelayRefreshIsSafeBeforeSyncConfiguration() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-foreground-refresh-\(UUID().uuidString)", isDirectory: true)
        let engine = TaskSyncEngine(
            outbox: NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        )

        await engine.refreshAfterForeground(healthCheckTimeout: .milliseconds(10))

        let pendingPublishCount = await engine.pendingPublishCount()
        XCTAssertEqual(pendingPublishCount, 0)
        try? FileManager.default.removeItem(at: directory)
    }

    func testIdentityImportsHexAndNsec() throws {
        let hex = String(repeating: "0", count: 63) + "1"
        let identity = try NostrIdentity(importedValue: hex)
        let restored = try NostrIdentity(importedValue: identity.nsec)

        XCTAssertEqual(restored, identity)
        XCTAssertTrue(identity.npub.hasPrefix("npub1"))
    }

    func testStaleBoardCleanupKeepsLatestReplaceableEventPerTask() throws {
        let board = Board(name: "Cleanup", nostrBoardID: UUID().uuidString)
        let privateKey = BoardCrypto.signingPrivateKey(for: board.effectiveNostrBoardID)
        let author = try BoardCrypto.signingPublicKey(for: board.effectiveNostrBoardID).hexString
        func event(taskID: String, createdAt: Int) throws -> NostrEvent {
            try NostrEvent.signed(
                privateKey: privateKey,
                createdAt: createdAt,
                kind: TaskEventCodec.taskEventKind,
                tags: [["d", taskID], ["b", BoardCrypto.boardTag(for: board.effectiveNostrBoardID)]],
                content: "encrypted"
            )
        }
        let oldA = try event(taskID: "a", createdAt: 10)
        let latestA = try event(taskID: "a", createdAt: 20)
        let onlyB = try event(taskID: "b", createdAt: 15)

        XCTAssertEqual(
            TaskEventCodec.staleReplaceableEventIDs(
                [latestA, oldA, onlyB],
                expectedAuthor: author
            ),
            [oldA.id]
        )

        let deletion = try TaskEventCodec.eventDeletionRequest(
            eventIDs: [oldA.id],
            board: board,
            createdAt: 30
        )
        XCTAssertEqual(deletion.kind, 5)
        XCTAssertTrue(deletion.tags.contains(["e", oldA.id]))
        XCTAssertTrue(deletion.verify())
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
