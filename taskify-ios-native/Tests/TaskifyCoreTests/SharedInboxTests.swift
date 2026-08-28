import Foundation
import XCTest
@testable import TaskifyCore

final class SharedInboxTests: XCTestCase {
    private let senderPrivateKey = String(repeating: "0", count: 63) + "1"
    private let recipientPrivateKey = String(repeating: "0", count: 63) + "2"
    private let ephemeralPrivateKey = String(repeating: "0", count: 63) + "3"
    private let fourthPrivateKey = String(repeating: "0", count: 63) + "4"

    func testDecodesPWATaskEnvelopeWithSubtaskWithoutID() throws {
        let recipient = try identity(recipientPrivateKey)
        let json = """
        {
          "v": 1,
          "kind": "taskify-share",
          "sender": {"name": "Nathan", "npub": "npub1sender"},
          "item": {
            "type": "task",
            "title": "  Review native inbox  ",
            "note": "Keep PWA fields",
            "priority": 3,
            "dueISO": "2026-07-22T15:30:00.000Z",
            "dueDateEnabled": true,
            "dueTimeEnabled": true,
            "dueTimeZone": "America/Chicago",
            "subtasks": [{"title": "First step", "completed": true}],
            "assignees": [{"pubkey": "\(recipient.publicKeyHex)", "status": "pending"}],
            "sourceTaskId": "pwa-task-1",
            "assignment": true,
            "relays": ["relay.solife.me", "wss://relay.solife.me/"]
          }
        }
        """

        let envelope = try XCTUnwrap(TaskifyShareEnvelope.decode(content: json))
        guard case .task(let task) = envelope.item else {
            return XCTFail("Expected a shared task")
        }

        XCTAssertEqual(task.title, "Review native inbox")
        XCTAssertEqual(task.priority, 3)
        XCTAssertEqual(task.subtasks?.first?.title, "First step")
        XCTAssertEqual(task.subtasks?.first?.completed, true)
        XCTAssertFalse(try XCTUnwrap(task.subtasks?.first?.id).isEmpty)
        XCTAssertEqual(task.assignees?.first?.publicKey, recipient.publicKeyHex)
        XCTAssertEqual(task.relayURLs, ["wss://relay.solife.me"])
        XCTAssertTrue(task.isAssignment)
        XCTAssertEqual(envelope.senderName, "Nathan")
    }

    func testDecodesEmbeddedTaskifyShareEnvelope() throws {
        let envelope = TaskifyShareEnvelope(
            item: .task(SharedTaskDelivery(title: "Embedded task")),
            senderName: "PWA"
        )
        let data = try envelope.encoded()
        let token = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        let decoded = try XCTUnwrap(TaskifyShareEnvelope.decode(
            content: "A task was shared with you.\n\nTaskify-Share: \(token)"
        ))
        guard case .task(let task) = decoded.item else {
            return XCTFail("Expected an embedded task")
        }
        XCTAssertEqual(task.title, "Embedded task")
        XCTAssertEqual(decoded.senderName, "PWA")
    }

    func testContactShareRoundTripsThroughPWAContract() throws {
        let shared = try identity(ephemeralPrivateKey)
        let sharedNpub = try XCTUnwrap(NostrPublicKey.npub(
            from: try XCTUnwrap(NostrPublicKey.parse(shared.publicKeyHex))
        ))
        let json = """
        {
          "v": 1,
          "kind": "taskify-share",
          "sender": {"name": "Alice"},
          "item": {
            "type": "contact",
            "npub": "\(sharedNpub)",
            "displayName": "Sam Example",
            "username": "sam",
            "nip05": "sam@example.com",
            "lud16": "sam@example.com",
            "relays": ["relay.solife.me"]
          }
        }
        """

        let decoded = try XCTUnwrap(TaskifyShareEnvelope.decode(content: json))
        guard case .contact(let contact) = decoded.item else {
            return XCTFail("Expected a shared contact")
        }
        XCTAssertEqual(contact.publicKey, shared.publicKeyHex)
        XCTAssertEqual(contact.primaryName, "Sam Example")
        XCTAssertEqual(contact.nip05, "sam@example.com")
        XCTAssertEqual(contact.relayURLs, ["wss://relay.solife.me"])

        let encoded = try TaskifyShareEnvelope(
            item: .contact(contact),
            senderName: "Alice"
        ).encoded()
        let roundTripped = try XCTUnwrap(TaskifyShareEnvelope.decode(
            content: String(decoding: encoded, as: UTF8.self)
        ))
        XCTAssertEqual(roundTripped, decoded)
    }

    func testBoardShareRoundTripsThroughPWAContract() throws {
        let json = """
        {
          "v": 1,
          "kind": "taskify-share",
          "sender": {"name": "Alice"},
          "item": {
            "type": "board",
            "boardId": "shared-board-1",
            "boardName": "Family Projects",
            "relays": ["relay.solife.me", "wss://relay.solife.me/"]
          }
        }
        """

        let decoded = try XCTUnwrap(TaskifyShareEnvelope.decode(content: json))
        guard case .board(let board) = decoded.item else {
            return XCTFail("Expected a shared board")
        }
        XCTAssertEqual(board.boardID, "shared-board-1")
        XCTAssertEqual(board.boardName, "Family Projects")
        XCTAssertEqual(board.relayURLs, ["wss://relay.solife.me"])

        let encoded = try TaskifyShareEnvelope(item: .board(board), senderName: "Alice").encoded()
        let roundTripped = try XCTUnwrap(TaskifyShareEnvelope.decode(
            content: String(decoding: encoded, as: UTF8.self)
        ))
        XCTAssertEqual(roundTripped, decoded)

        XCTAssertNil(TaskifyShareEnvelope.decode(content: """
        {"v": 1, "kind": "taskify-share", "item": {"type": "board", "boardId": "   "}}
        """))
    }

    func testCalendarInviteAndRSVPMirrorPWAContracts() throws {
        let calendarAuthor = try identity(senderPrivateKey)
        let attendee = try identity(recipientPrivateKey)
        let eventID = "event-2026-07-22"
        let canonical = "30310:\(calendarAuthor.publicKeyHex):\(eventID)"
        let view = "30311:\(calendarAuthor.publicKeyHex):\(eventID)"
        let json = """
        {
          "v": 1,
          "kind": "taskify-share",
          "item": {
            "type": "event",
            "eventId": "\(eventID)",
            "canonical": "\(canonical)",
            "view": "\(view)",
            "eventKey": "event-secret",
            "inviteToken": "invite-secret",
            "title": "Native parity review",
            "start": "2026-07-24T15:00:00Z",
            "end": "2026-07-24T16:00:00Z",
            "relays": ["wss://relay.solife.me"]
          }
        }
        """

        let envelope = try XCTUnwrap(TaskifyShareEnvelope.decode(content: json))
        guard case .calendarEvent(let invite) = envelope.item else {
            return XCTFail("Expected a calendar invite")
        }
        XCTAssertEqual(invite.eventAuthorPublicKey, calendarAuthor.publicKeyHex)
        XCTAssertEqual(invite.displayTitle, "Native parity review")

        let rsvp = try SharedCalendarRSVPContract.event(
            invite: invite,
            status: .accepted,
            identity: attendee,
            createdAt: 1_784_647_200
        )
        XCTAssertTrue(rsvp.verify())
        XCTAssertEqual(rsvp.kind, 30_312)
        XCTAssertEqual(rsvp.firstTagValue(named: "d"), "\(eventID):\(attendee.publicKeyHex)")
        XCTAssertEqual(rsvp.firstTagValue(named: "a"), canonical)
        let plaintext = try NIP44V2.decrypt(
            rsvp.content,
            privateKey: calendarAuthor.privateKey,
            publicKey: attendee.publicKey
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
        )
        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertEqual(object["eventId"] as? String, eventID)
        XCTAssertEqual(object["status"] as? String, "accepted")
        XCTAssertEqual(object["inviteToken"] as? String, "invite-secret")
    }

    func testOrganizerDecodesPWAEventRSVPAndKeepsLatestResponsePerAttendee() throws {
        let attendee = try identity(recipientPrivateKey)
        let secondAttendee = try identity(ephemeralPrivateKey)
        let board = Board(
            id: "calendar-board",
            name: "Calendar",
            kind: .week,
            nostrBoardID: "calendar-board-secret",
            relayURLs: ["wss://relay.solife.me"]
        )
        let eventID = "event-rsvp-1"
        let boardPublicKey = try BoardCrypto.signingPublicKey(
            for: board.effectiveNostrBoardID
        ).hexString
        let canonical = "30310:\(boardPublicKey):\(eventID)"
        let taskifyEvent = TaskifyEvent(
            id: eventID,
            boardID: board.id,
            title: "Dinner",
            participants: [
                TaskifyEventParticipant(publicKey: attendee.publicKeyHex),
                TaskifyEventParticipant(publicKey: secondAttendee.publicKeyHex),
            ],
            schedule: .time,
            startISO: "2026-08-03T23:00:00Z",
            endISO: "2026-08-04T00:00:00Z",
            canonicalAddress: canonical,
            viewAddress: "30311:\(boardPublicKey):\(eventID)",
            eventKey: TaskifyCalendarEventCodec.generateEventKey(),
            inviteToken: "",
            inviteTokens: [
                attendee.publicKeyHex: "attendee-token",
                secondAttendee.publicKeyHex: "second-token",
            ],
            relayURLs: board.relayURLs,
            rsvpStatus: .accepted
        )

        func response(
            from identity: NostrIdentity,
            status: String,
            token: String,
            createdAt: Int,
            freeBusy: String? = nil,
            note: String? = nil
        ) throws -> NostrEvent {
            var payload: [String: Any] = [
                "v": 1,
                "eventId": eventID,
                "status": status,
                "inviteToken": token,
            ]
            if let freeBusy { payload["fb"] = freeBusy }
            if let note { payload["note"] = note }
            let plaintext = try JSONSerialization.data(withJSONObject: payload)
            let encrypted = try NIP44V2.encrypt(
                plaintext,
                privateKey: identity.privateKey,
                publicKey: try Data(hex: boardPublicKey),
                nonce: Data(repeating: UInt8(createdAt % 255), count: 32)
            )
            return try NostrEvent.signed(
                privateKey: identity.privateKey,
                createdAt: createdAt,
                kind: SharedCalendarRSVPContract.eventKind,
                tags: [
                    ["d", "\(eventID):\(identity.publicKeyHex)"],
                    ["a", canonical],
                ],
                content: encrypted
            )
        }

        let earlier = try response(
            from: attendee,
            status: "tentative",
            token: "attendee-token",
            createdAt: 1_785_775_200
        )
        let latest = try response(
            from: attendee,
            status: "accepted",
            token: "attendee-token",
            createdAt: 1_785_775_260,
            freeBusy: "busy",
            note: "Bringing dessert"
        )
        let declined = try response(
            from: secondAttendee,
            status: "declined",
            token: "second-token",
            createdAt: 1_785_775_230
        )

        let decoded = try SharedCalendarRSVPContract.decodeOrganizerResponse(
            latest,
            event: taskifyEvent,
            board: board
        )
        XCTAssertEqual(decoded.eventID, eventID)
        XCTAssertEqual(decoded.authorPublicKey, attendee.publicKeyHex)
        XCTAssertEqual(decoded.status, .accepted)
        XCTAssertEqual(decoded.freeBusy, .busy)
        XCTAssertEqual(decoded.note, "Bringing dessert")
        XCTAssertEqual(decoded.createdAt, 1_785_775_260)

        let responses = SharedCalendarRSVPContract.latestResponses(
            [
                try SharedCalendarRSVPContract.decodeOrganizerResponse(
                    latest,
                    event: taskifyEvent,
                    board: board
                ),
                try SharedCalendarRSVPContract.decodeOrganizerResponse(
                    earlier,
                    event: taskifyEvent,
                    board: board
                ),
                try SharedCalendarRSVPContract.decodeOrganizerResponse(
                    declined,
                    event: taskifyEvent,
                    board: board
                ),
            ]
        )
        XCTAssertEqual(responses.map(\.authorPublicKey), [
            attendee.publicKeyHex,
            secondAttendee.publicKeyHex,
        ])
        XCTAssertEqual(responses.map(\.status), [.accepted, .declined])

        let wrongToken = try response(
            from: attendee,
            status: "accepted",
            token: "wrong-token",
            createdAt: 1_785_775_300
        )
        XCTAssertThrowsError(try SharedCalendarRSVPContract.decodeOrganizerResponse(
            wrongToken,
            event: taskifyEvent,
            board: board
        ))
    }

    func testCalendarInvitationPlanRetainsExistingTokensAndInvitesOnlyNewAttendees() throws {
        let organizer = try identity(senderPrivateKey)
        let existingAttendee = try identity(recipientPrivateKey)
        let newAttendee = try identity(ephemeralPrivateKey)
        let removedAttendee = try identity(fourthPrivateKey)
        let board = Board(
            id: "calendar-board",
            name: "Calendar",
            kind: .week,
            nostrBoardID: "calendar-board-secret",
            relayURLs: ["wss://relay.solife.me"]
        )
        let event = TaskifyEvent(
            id: "event-1",
            boardID: board.id,
            title: "Native parity review",
            participants: [
                TaskifyEventParticipant(publicKey: existingAttendee.publicKeyHex, role: "attendee")
            ],
            schedule: .time,
            startISO: "2026-08-03T15:00:00Z",
            endISO: "2026-08-03T16:00:00Z",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: TaskifyCalendarEventCodec.generateEventKey(),
            inviteToken: "",
            inviteTokens: [
                existingAttendee.publicKeyHex: "existing-token",
                removedAttendee.publicKeyHex: "stale-token",
            ],
            relayURLs: board.relayURLs,
            rsvpStatus: .accepted
        )

        var generatedTokens = ["new-token"]
        let plan = TaskifyEventInvitationPlanner.prepare(
            event: event,
            participants: [
                TaskifyEventParticipant(
                    publicKey: existingAttendee.publicKeyHex,
                    relayURL: "wss://relay.solife.me/",
                    role: "attendee"
                ),
                TaskifyEventParticipant(
                    publicKey: newAttendee.npub,
                    relayURL: "relay.damus.io",
                    role: "attendee"
                ),
                TaskifyEventParticipant(publicKey: organizer.publicKeyHex, role: "organizer"),
                TaskifyEventParticipant(publicKey: "not-a-key", role: "attendee"),
            ],
            previousParticipants: event.participants ?? [],
            senderPublicKey: organizer.publicKeyHex,
            generateInviteToken: { generatedTokens.removeFirst() }
        )

        XCTAssertEqual(plan.event.participants?.map(\.publicKey), [
            existingAttendee.publicKeyHex,
            newAttendee.publicKeyHex,
        ])
        XCTAssertEqual(plan.event.participants?.map(\.relayURL), [
            "wss://relay.solife.me",
            "wss://relay.damus.io",
        ])
        XCTAssertEqual(plan.event.inviteTokens, [
            existingAttendee.publicKeyHex: "existing-token",
            newAttendee.publicKeyHex: "new-token",
        ])
        XCTAssertEqual(plan.addedRecipientPublicKeys, [newAttendee.publicKeyHex])

        let pair = try TaskifyCalendarEventCodec.eventPair(
            event: plan.event,
            board: board,
            createdAt: 1_785_775_200
        )
        let delivery = try XCTUnwrap(TaskifyEventInvitationPlanner.delivery(
            event: pair.normalizedEvent,
            recipientPublicKey: newAttendee.publicKeyHex
        ))
        XCTAssertEqual(delivery.eventID, event.id)
        XCTAssertEqual(delivery.canonical, pair.normalizedEvent.canonicalAddress)
        XCTAssertEqual(delivery.view, pair.normalizedEvent.viewAddress)
        XCTAssertEqual(delivery.inviteToken, "new-token")
        XCTAssertEqual(delivery.start, "2026-08-03T15:00:00Z")

        let envelope = TaskifyShareEnvelope(
            item: .calendarEvent(delivery),
            senderNpub: organizer.npub
        )
        let decoded = try XCTUnwrap(TaskifyShareEnvelope.decode(
            content: String(decoding: try envelope.encoded(), as: UTF8.self)
        ))
        XCTAssertEqual(decoded, envelope)
    }

    func testTaskifyEventViewDecryptsAndMaterializesSeparatelyFromAppleCalendar() throws {
        let organizer = try identity(senderPrivateKey)
        let eventID = "taskify-event-1"
        let eventKey = Data(repeating: 7, count: 32)
        let canonical = "30310:\(organizer.publicKeyHex):\(eventID)"
        let invite = SharedCalendarEventDelivery(
            eventID: eventID,
            canonical: canonical,
            view: "30311:\(organizer.publicKeyHex):\(eventID)",
            eventKey: eventKey.base64EncodedString(),
            inviteToken: "invite-token",
            title: "Envelope title",
            start: "2026-07-24T15:00:00Z",
            relayURLs: ["wss://relay.solife.me"]
        )
        let payload = """
        {
          "v": 1,
          "eventId": "\(eventID)",
          "kind": "time",
          "title": "Native parity review",
          "summary": "Taskify event, not EventKit",
          "description": "Review the native implementation",
          "locations": ["Remote"],
          "startISO": "2026-07-24T15:00:00Z",
          "endISO": "2026-07-24T16:00:00Z",
          "startTzid": "America/Chicago",
          "endTzid": "America/Chicago",
          "reminders": ["15m"],
          "recurrence": {"type":"weekly","days":[5]},
          "seriesId": "\(eventID)"
        }
        """
        let encrypted = try NIP44V2.encrypt(
            Data(payload.utf8),
            conversationKey: eventKey,
            nonce: Data(repeating: 4, count: 32)
        )
        let viewEvent = try NostrEvent.signed(
            privateKey: organizer.privateKey,
            createdAt: 1_784_647_200,
            kind: TaskifyEventContract.viewEventKind,
            tags: [["d", eventID], ["a", canonical]],
            content: encrypted
        )

        let event = try TaskifyEventContract.decodeViewEvent(
            viewEvent,
            invite: invite,
            status: .accepted
        )
        XCTAssertEqual(event.title, "Native parity review")
        XCTAssertEqual(event.summary, "Taskify event, not EventKit")
        XCTAssertEqual(event.schedule, .time)
        XCTAssertEqual(event.locations, ["Remote"])
        XCTAssertEqual(event.startTimeZoneID, "America/Chicago")
        XCTAssertEqual(event.reminders, [TaskReminder(rawValue: "15m")])
        XCTAssertEqual(event.recurrence, .weekly(days: [5]))
        XCTAssertEqual(event.seriesID, eventID)
        XCTAssertEqual(event.rsvpStatus, .accepted)
        XCTAssertEqual(event.canonicalAddress, canonical)
        XCTAssertEqual(event.sourceUpdatedAt, 1_784_647_200)

        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.upsertTaskifyEvent(event))
        XCTAssertFalse(snapshot.upsertTaskifyEvent(event))
        XCTAssertEqual(snapshot.acceptedTaskifyEvents, [event])
    }

    func testPublicKeyParserAcceptsNpubRawAndCompressedKeys() throws {
        let recipient = try identity(recipientPrivateKey)
        XCTAssertEqual(NostrPublicKey.parse(recipient.npub), recipient.publicKey)
        XCTAssertEqual(NostrPublicKey.parse(recipient.publicKeyHex), recipient.publicKey)
        XCTAssertEqual(NostrPublicKey.parse("02\(recipient.publicKeyHex)"), recipient.publicKey)
        XCTAssertNil(NostrPublicKey.parse("npub1invalid"))
        XCTAssertNil(NostrPublicKey.parse(String(repeating: "a", count: 63)))
    }

    func testAssignmentContentMatchesPWAReadableEnvelopeContract() throws {
        let recipient = try identity(recipientPrivateKey)
        let task = TaskItem(
            id: "outbound-task",
            boardID: "board",
            title: "Review release",
            note: "Check the TestFlight build",
            dueDate: Date(timeIntervalSince1970: 1_784_647_200),
            dueDateEnabled: true,
            dueTimeEnabled: true,
            priority: .high,
            subtasks: [TaskSubtask(title: "Open build")]
        )
        let delivery = SharedTaskDelivery(
            task: task,
            relayURLs: ["relay.solife.me"],
            assignmentRecipientPublicKey: recipient.publicKeyHex
        )
        let envelope = TaskifyShareEnvelope(item: .task(delivery))
        let content = try envelope.messageContent()

        XCTAssertTrue(content.hasPrefix("Task Assignment\n"))
        XCTAssertTrue(content.contains("Title: Review release"))
        XCTAssertTrue(content.contains("Taskify-Share: "))
        let decoded = try XCTUnwrap(TaskifyShareEnvelope.decode(content: content))
        guard case .task(let decodedTask) = decoded.item else {
            return XCTFail("Expected task assignment")
        }
        XCTAssertEqual(decodedTask.sourceTaskID, "outbound-task")
        XCTAssertEqual(decodedTask.assignees?.first?.publicKey, recipient.publicKeyHex)
        XCTAssertEqual(decodedTask.assignees?.first?.status, .pending)
        XCTAssertTrue(decodedTask.isAssignment)
    }

    func testAssignmentResponseContentAvoidsPWAECashMisclassification() throws {
        let envelope = TaskifyShareEnvelope(
            item: .assignmentResponse(SharedTaskAssignmentResponse(
                taskID: "assigned-task",
                status: .accepted,
                respondedAt: "2026-07-26T19:00:00.000Z"
            )),
            senderName: "Native assignee"
        )

        let content = try envelope.messageContent()

        XCTAssertTrue(content.hasPrefix("Task Assignment Response\n"))
        XCTAssertTrue(content.contains("Status: Accepted"))
        XCTAssertTrue(content.contains("Taskify-Share: "))
        XCTAssertFalse(content.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("{"))

        let decoded = try XCTUnwrap(TaskifyShareEnvelope.decode(content: content))
        guard case .assignmentResponse(let response) = decoded.item else {
            return XCTFail("Expected an assignment response")
        }
        XCTAssertEqual(response.taskID, "assigned-task")
        XCTAssertEqual(response.status, .accepted)
    }

    func testTaskifyEventUpsertReplacesNormalizedCopyInsteadOfDuplicatingIt() {
        let local = TaskifyEvent(
            id: "native-event",
            boardID: "week-default",
            title: "Planning",
            schedule: .date,
            startDateValue: "2026-07-27",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: "event-key",
            inviteToken: "",
            rsvpStatus: .accepted
        )
        var normalized = local
        normalized.canonicalAddress = "30310:author:native-event"
        normalized.viewAddress = "30311:author:native-event"
        normalized.nostrUpdatedAt = 1_784_647_200
        var snapshot = TaskifySnapshot.empty

        XCTAssertTrue(snapshot.upsertTaskifyEvent(local))
        XCTAssertTrue(snapshot.upsertTaskifyEvent(normalized))
        XCTAssertEqual(snapshot.acceptedTaskifyEvents.count, 1)
        XCTAssertEqual(snapshot.acceptedTaskifyEvents.first?.viewAddress, normalized.viewAddress)
    }

    func testSnapshotRepairRemovesPreviouslyPersistedTaskifyEventDuplicates() {
        let local = TaskifyEvent(
            id: "persisted-event",
            boardID: "week-default",
            title: "Planning",
            schedule: .date,
            startDateValue: "2026-07-27",
            canonicalAddress: "",
            viewAddress: "",
            eventKey: "event-key",
            inviteToken: "",
            rsvpStatus: .accepted
        )
        var normalized = local
        normalized.viewAddress = "30311:author:persisted-event"
        normalized.nostrUpdatedAt = 1_784_647_200
        var snapshot = TaskifySnapshot.empty
        snapshot.taskifyEvents = [local, normalized]

        snapshot.repairSelection()

        XCTAssertEqual(snapshot.taskifyEvents?.count, 1)
        XCTAssertEqual(snapshot.taskifyEvents?.first?.viewAddress, normalized.viewAddress)
    }

    func testNIP17GiftWrapRoundTripsAndRejectsAnotherRecipient() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let ephemeral = try identity(ephemeralPrivateKey)
        let envelope = TaskifyShareEnvelope(
            item: .task(SharedTaskDelivery(
                title: "Encrypted assignment",
                sourceTaskID: "task-42",
                assignment: true
            )),
            senderNpub: sender.npub,
            senderName: "Task owner"
        )

        let wrap = try NIP17GiftWrap.wrap(
            envelope: envelope,
            sender: sender,
            recipientPublicKey: recipient.publicKey,
            createdAt: 1_784_647_200,
            ephemeralIdentity: ephemeral
        )
        let decoded = try NIP17GiftWrap.unwrap(wrap, recipient: recipient)

        XCTAssertEqual(wrap.kind, NIP17GiftWrap.wrapKind)
        XCTAssertTrue(wrap.verify())
        XCTAssertEqual(decoded.senderPublicKey, sender.publicKeyHex)
        XCTAssertEqual(decoded.createdAt, 1_784_647_200)
        XCTAssertEqual(decoded.envelope.senderName, "Task owner")
        guard case .task(let task) = decoded.envelope.item else {
            return XCTFail("Expected a task rumor")
        }
        XCTAssertEqual(task.sourceTaskID, "task-42")

        let wrongRecipient = try identity(String(repeating: "0", count: 63) + "4")
        XCTAssertThrowsError(try NIP17GiftWrap.unwrap(wrap, recipient: wrongRecipient))
    }

    func testNIP17GiftWrapPairCreatesIndependentRecipientAndSenderCopies() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let envelope = TaskifyShareEnvelope(
            item: .contact(SharedContactDelivery(
                npub: recipient.npub,
                displayName: "Alice"
            )),
            senderNpub: sender.npub
        )

        let pair = try NIP17GiftWrap.wrapPair(
            envelope: envelope,
            sender: sender,
            recipientPublicKey: recipient.publicKey,
            createdAt: 1_784_647_200
        )
        let recipientRumor = try NIP17GiftWrap.unwrapRumor(
            pair.recipientWrap,
            recipient: recipient
        ).rumor
        let senderRumor = try NIP17GiftWrap.unwrapRumor(
            pair.senderWrap,
            recipient: sender
        ).rumor

        XCTAssertEqual(pair.rumor, recipientRumor)
        XCTAssertEqual(pair.rumor, senderRumor)
        XCTAssertNotEqual(pair.recipientWrap.publicKey, pair.senderWrap.publicKey)
        XCTAssertEqual(pair.recipientWrap.firstTagValue(named: "p"), recipient.publicKeyHex)
        XCTAssertEqual(pair.senderWrap.firstTagValue(named: "p"), sender.publicKeyHex)
    }

    func testNIP17AcceptsCDKPaymentRumorWithoutInnerRecipientTag() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let ephemeral = try identity(ephemeralPrivateKey)
        let payload = """
        {"id":"request-1","mint":"https://mint.example","unit":"sat","proofs":[{"amount":1}]}
        """
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 1_784_647_200,
            kind: NIP17GiftWrap.rumorKind,
            tags: [],
            content: payload
        )
        let wrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: recipient.publicKey,
            ephemeralIdentity: ephemeral
        )

        let decrypted = try NIP17GiftWrap.unwrapRumor(wrap, recipient: recipient)

        XCTAssertEqual(decrypted.rumor.tags, [])
        XCTAssertEqual(decrypted.rumor.content, payload)
        XCTAssertEqual(decrypted.rumor.publicKey, sender.publicKeyHex)
    }

    func testInboxDeduplicatesAndAcceptsIntoSelectedListContract() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let board = Board(
            id: "inbox-board",
            name: "Inbox",
            kind: .list,
            columns: [BoardColumn(id: "new", name: "New", order: 0)]
        )
        var snapshot = TaskifySnapshot(
            boards: [board],
            tasks: [],
            selectedBoardID: board.id
        )
        let item = SharedInboxItem(
            wrapEventID: "wrap-1",
            rumorEventID: "rumor-1",
            sender: SharedInboxSender(publicKey: sender.publicKeyHex, name: "Alice"),
            task: SharedTaskDelivery(
                title: "Assigned task",
                note: "Original note",
                priority: 2,
                dueISO: "2026-07-22T15:30:00.000Z",
                dueDateEnabled: true,
                dueTimeEnabled: true,
                dueTimeZone: "America/Chicago",
                subtasks: [TaskSubtask(title: "Child")],
                assignees: [SharedTaskAssignee(
                    publicKey: recipient.publicKeyHex,
                    status: .pending
                )],
                sourceTaskID: "source-1",
                assignment: true
            ),
            receivedAt: Date(timeIntervalSince1970: 1_784_647_200)
        )

        XCTAssertTrue(snapshot.ingestSharedInboxItem(item))
        XCTAssertFalse(snapshot.ingestSharedInboxItem(item))
        XCTAssertEqual(snapshot.pendingSharedInboxCount, 1)

        let accepted = try XCTUnwrap(snapshot.acceptSharedTask(
            inboxItemID: item.id,
            destinationBoardID: board.id,
            destinationColumnID: "new",
            recipientPublicKey: recipient.publicKeyHex,
            now: Date(timeIntervalSince1970: 1_784_647_300)
        ))

        XCTAssertEqual(accepted.boardID, board.id)
        XCTAssertEqual(accepted.columnID, "new")
        XCTAssertEqual(accepted.priority, .medium)
        XCTAssertTrue(accepted.note.contains("Assigned by Alice"))
        XCTAssertTrue(accepted.note.contains("Original note"))
        XCTAssertEqual(accepted.subtasks?.first?.title, "Child")
        XCTAssertEqual(
            accepted.preservedSyncFields?["assignees"],
            .array([.object([
                "pubkey": .string(recipient.publicKeyHex),
                "status": .string("accepted"),
                "respondedAt": .integer(1_784_647_300_000),
            ])])
        )
        XCTAssertEqual(snapshot.pendingSharedInboxCount, 0)
        XCTAssertEqual(snapshot.sharedInbox.first?.status, .accepted)
    }

    func testOutboundAssignmentTracksAuthenticatedResponsesAndRejectsStaleUpdates() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let board = Board.week(id: "week", name: "Week")
        let task = TaskItem(id: "assigned-task", boardID: board.id, title: "Assigned")
        var snapshot = TaskifySnapshot(boards: [board], tasks: [task], selectedBoardID: board.id)

        let assigned = try XCTUnwrap(snapshot.markTaskAssigned(
            taskID: task.id,
            recipientPublicKey: recipient.publicKeyHex,
            recipientRelayURL: "relay.solife.me",
            editorPublicKey: sender.publicKeyHex
        ))
        XCTAssertEqual(assigned.sharedTaskAssignees.first?.status, .pending)
        XCTAssertEqual(assigned.sharedTaskAssignees.first?.relay, "wss://relay.solife.me")

        XCTAssertNil(snapshot.applyTaskAssignmentResponse(
            taskID: task.id,
            senderPublicKey: sender.publicKeyHex,
            status: .accepted,
            respondedAt: Date(timeIntervalSince1970: 200)
        ))
        let accepted = try XCTUnwrap(snapshot.applyTaskAssignmentResponse(
            taskID: task.id,
            senderPublicKey: recipient.publicKeyHex,
            status: .accepted,
            respondedAt: Date(timeIntervalSince1970: 200)
        ))
        XCTAssertEqual(accepted.sharedTaskAssignees.first?.status, .accepted)
        XCTAssertEqual(accepted.sharedTaskAssignees.first?.respondedAt, 200_000)

        XCTAssertNil(snapshot.applyTaskAssignmentResponse(
            taskID: task.id,
            senderPublicKey: recipient.publicKeyHex,
            status: .declined,
            respondedAt: Date(timeIntervalSince1970: 100)
        ))
        XCTAssertEqual(snapshot.tasks.first?.sharedTaskAssignees.first?.status, .accepted)
    }

    func testRecentRecipientsPersistNewestFirstAndDeduplicate() throws {
        let first = try identity(senderPrivateKey)
        let second = try identity(recipientPrivateKey)
        var snapshot = TaskifySnapshot.empty
        snapshot.upsertSharedTaskRecipient(SharedTaskRecipient(
            publicKey: first.publicKeyHex,
            npub: first.npub,
            relayURLs: ["wss://one.example"],
            lastSentAt: Date(timeIntervalSince1970: 100)
        ))
        snapshot.upsertSharedTaskRecipient(SharedTaskRecipient(
            publicKey: second.publicKeyHex,
            npub: second.npub,
            relayURLs: ["wss://two.example"],
            lastSentAt: Date(timeIntervalSince1970: 200)
        ))
        snapshot.upsertSharedTaskRecipient(SharedTaskRecipient(
            publicKey: first.publicKeyHex,
            npub: first.npub,
            relayURLs: ["wss://new.example"],
            lastSentAt: Date(timeIntervalSince1970: 300)
        ))

        XCTAssertEqual(snapshot.recentSharedTaskRecipients.map(\.publicKey), [
            first.publicKeyHex,
            second.publicKeyHex,
        ])
        XCTAssertEqual(snapshot.recentSharedTaskRecipients.first?.relayURLs, ["wss://new.example"])
        let roundTrip = try JSONDecoder().decode(
            TaskifySnapshot.self,
            from: JSONEncoder().encode(snapshot)
        )
        XCTAssertEqual(roundTrip.recentSharedTaskRecipients, snapshot.recentSharedTaskRecipients)
    }

    func testRecipientInboxRelayPreferenceUsesNewestVerifiedEvent() throws {
        let recipient = try identity(recipientPrivateKey)
        let older = try NostrEvent.signed(
            privateKey: recipient.privateKey,
            createdAt: 100,
            kind: NIP17InboxRelayResolver.preferenceEventKind,
            tags: [["relay", "wss://old.example"]],
            content: ""
        )
        let newer = try NostrEvent.signed(
            privateKey: recipient.privateKey,
            createdAt: 200,
            kind: NIP17InboxRelayResolver.preferenceEventKind,
            tags: [
                ["relay", "relay.solife.me"],
                ["relay", "wss://inbox.example/"],
                ["not-relay", "wss://ignored.example"],
            ],
            content: ""
        )
        let impostor = try NostrEvent.signed(
            privateKey: try identity(senderPrivateKey).privateKey,
            createdAt: 300,
            kind: NIP17InboxRelayResolver.preferenceEventKind,
            tags: [["relay", "wss://attacker.example"]],
            content: ""
        )

        XCTAssertEqual(
            NIP17InboxRelayResolver.relayURLs(
                from: [older, impostor, newer],
                recipientPublicKey: recipient.publicKeyHex
            ),
            ["wss://relay.solife.me", "wss://inbox.example"]
        )
    }

    func testNIP17DeliveryPlanKeepsRecipientAndSenderInboxRelaysSeparate() throws {
        let plan = try XCTUnwrap(NIP17RelayRouting.deliveryPlan(
            recipientInboxRelayURLs: [
                "wss://recipient-inbox.example/",
                "wss://recipient-backup.example",
            ],
            senderInboxRelayURLs: ["wss://sender-inbox.example/"]
        ))

        XCTAssertEqual(plan.recipientRelayURLs, [
            "wss://recipient-inbox.example",
            "wss://recipient-backup.example",
        ])
        XCTAssertEqual(plan.senderRelayURLs, ["wss://sender-inbox.example"])
        XCTAssertFalse(plan.senderRelayURLs.contains("wss://recipient-inbox.example"))
    }

    func testNIP17DeliveryPlanRequiresBothAdvertisedInboxLists() {
        XCTAssertNil(NIP17RelayRouting.deliveryPlan(
            recipientInboxRelayURLs: [],
            senderInboxRelayURLs: ["wss://sender-inbox.example"]
        ))
        XCTAssertNil(NIP17RelayRouting.deliveryPlan(
            recipientInboxRelayURLs: ["wss://recipient-inbox.example"],
            senderInboxRelayURLs: []
        ))
    }

    func testCreatesSignedNIP17InboxRelayPreferenceEvent() throws {
        let owner = try identity(recipientPrivateKey)
        let event = try NIP17InboxRelayPreference.event(
            identity: owner,
            relayURLs: [
                "push.taskify.example",
                "wss://push.taskify.example/",
                "wss://backup.example",
            ],
            createdAt: 1_784_647_200
        )

        XCTAssertEqual(event.kind, 10_050)
        XCTAssertEqual(event.publicKey, owner.publicKeyHex)
        XCTAssertEqual(event.tags, [
            ["relay", "wss://push.taskify.example"],
            ["relay", "wss://backup.example"],
        ])
        XCTAssertEqual(event.content, "")
        XCTAssertTrue(event.verify())
    }

    func testInboxRelayPreferenceCacheStoresEmptyResultsAndExpires() async {
        let cache = NIP17InboxRelayPreferenceCache()
        let now = Date(timeIntervalSince1970: 1_000)

        await cache.store(
            [],
            for: "ABCDEF",
            expiresAfter: 60,
            now: now
        )

        let cached = await cache.relayURLs(for: "abcdef", now: now.addingTimeInterval(59))
        XCTAssertEqual(cached, [])
        let expired = await cache.relayURLs(for: "ABCDEF", now: now.addingTimeInterval(60))
        XCTAssertNil(expired)
    }

    func testInboxRelayPreferenceCacheNormalizesRelayURLs() async {
        let cache = NIP17InboxRelayPreferenceCache()
        let now = Date(timeIntervalSince1970: 2_000)

        await cache.store(
            ["relay.solife.me", "wss://relay.solife.me/", "wss://inbox.example/"],
            for: "ABCDEF",
            expiresAfter: 60,
            now: now
        )

        let cached = await cache.relayURLs(for: "abcdef", now: now)
        XCTAssertEqual(cached, ["wss://relay.solife.me", "wss://inbox.example"])
    }

    func testSnapshotWithoutInboxFieldStillDecodes() throws {
        let snapshot = TaskifySnapshot.empty
        let encoded = try JSONEncoder().encode(snapshot)
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        object.removeValue(forKey: "sharedInboxItems")
        object.removeValue(forKey: "sharedContactInboxItems")
        object.removeValue(forKey: "sharedCalendarInviteItems")
        object.removeValue(forKey: "taskifyEvents")
        object.removeValue(forKey: "sharedTaskRecipients")
        let legacyData = try JSONSerialization.data(withJSONObject: object)

        let decoded = try JSONDecoder().decode(TaskifySnapshot.self, from: legacyData)
        XCTAssertTrue(decoded.sharedInbox.isEmpty)
        XCTAssertTrue(decoded.sharedContactInbox.isEmpty)
        XCTAssertTrue(decoded.sharedCalendarInvites.isEmpty)
        XCTAssertTrue(decoded.acceptedTaskifyEvents.isEmpty)
        XCTAssertEqual(decoded.pendingSharedInboxCount, 0)
    }

    private func identity(_ privateKeyHex: String) throws -> NostrIdentity {
        try NostrIdentity(privateKey: Data(hex: privateKeyHex))
    }
}
