import Foundation
import XCTest
@testable import TaskifyCore

final class AttachmentCommentTests: XCTestCase {
    func testAttachmentAndCommentAreSeparateRumorsForDMsAndGroups() throws {
        for isGroup in [false, true] {
            let fixture = try fixture(group: isGroup)
            let job = try fixture.prepared()
            XCTAssertEqual(job.messages.count, 2)
            XCTAssertEqual(job.messages.map(\.deliveryState), [.queued, .queued])
            let parentID = try XCTUnwrap(job.localMessage?.rumorEventID)
            for identity in fixture.identities {
                let copies = job.deliveries.filter { $0.event.tags.contains(["p", identity.publicKeyHex]) }
                XCTAssertEqual(copies.count, 2)
                let file = try NIP17GiftWrap.unwrapRumor(copies[0].event, recipient: identity).rumor
                let comment = try NIP17GiftWrap.unwrapRumor(copies[1].event, recipient: identity).rumor
                XCTAssertEqual(file.kind, 15)
                XCTAssertEqual(file.content, fixture.input.remoteURL)
                XCTAssertNotNil(NostrDirectMessageAttachment(rumor: file))
                XCTAssertEqual(comment.kind, 14)
                XCTAssertEqual(comment.content, "Look at this")
                XCTAssertEqual(comment.tags.filter { $0.first == "e" }, [["e", parentID]])
                XCTAssertFalse(comment.tags.contains { $0.first == "decryption-key" || $0.first == "file-type" })
                XCTAssertEqual(comment.recipientPublicKeys, file.recipientPublicKeys)
                XCTAssertEqual(comment.tags.filter { $0.first == "subject" }, file.tags.filter { $0.first == "subject" })
                XCTAssertEqual(comment.createdAt, file.createdAt)
                XCTAssertNil(copies[0].dependsOnEventID)
                XCTAssertEqual(copies[1].dependsOnEventID, copies[0].event.id)
                XCTAssertNotEqual(copies[0].event.id, parentID)
            }
        }
    }

    func testCommentRepliesToNewAttachmentEvenWhenAttachmentIsItselfAReply() throws {
        let fixture = try fixture()
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(url: "https://files.example/photo",
            mimeType: "image/jpeg", keyHex: String(repeating: "a", count: 64), nonceHex: String(repeating: "b", count: 32)))
        let earlier = String(repeating: "c", count: 64)
        let rumor = try NIP17Rumor(publicKey: fixture.account.publicKey, createdAt: 100,
            kind: 15, tags: [["p", fixture.recipient.id], ["e", earlier]] + attachment.rumorTags, content: attachment.url)
        let batch = try NIP17OutgoingMessageBatch(rumor: rumor, attachmentComment: "Comment",
            identity: fixture.identities[0], relayURLsByRecipient: fixture.routes)
        XCTAssertEqual(batch.localMessages[0].replyToEventID, earlier)
        XCTAssertEqual(batch.localMessages[1].replyToEventID, rumor.id)
    }

    func testNoteToSelfCreatesOneFileAndOneReplyWithoutDuplicateSelfCopies() throws {
        let fixture = try fixture()
        let sender = fixture.identities[0]
        let recipient = ShareRecipient(id: sender.publicKeyHex, name: "Note to Self",
            members: [sender.publicKeyHex], isGroup: false, discoveryRelays: [])
        var input = ShareTransfer(account: fixture.account, recipient: recipient, text: "Keep this")
        input.remoteURL = fixture.input.remoteURL; input.keyHex = fixture.input.keyHex; input.nonceHex = fixture.input.nonceHex
        let job = try ShareMessageDelivery.prepared(input, identity: sender,
            routes: [sender.publicKeyHex: fixture.account.senderRelays])
        XCTAssertEqual(job.deliveries.count, 2)
        XCTAssertEqual(job.messages.map(\.peerPublicKey), [sender.publicKeyHex, sender.publicKeyHex])
        XCTAssertTrue(job.messages.allSatisfy { !$0.isIncoming })
        XCTAssertEqual(job.messages[1].replyToEventID, job.messages[0].rumorEventID)
    }

    func testBlankCommentsSendOnlyTheAttachmentAndTextSharesStillWork() throws {
        let fixture = try fixture()
        for comment: String? in [nil, "", " \n\t "] {
            var input = fixture.input
            input.text = comment
            let job = try ShareMessageDelivery.prepared(input, identity: fixture.identities[0], routes: fixture.routes)
            XCTAssertEqual(job.messages.count, 1)
            XCTAssertEqual(job.deliveries.count, fixture.identities.count)
            XCTAssertTrue(job.deliveries.allSatisfy { $0.dependsOnEventID == nil })
        }
        let text = ShareTransfer(account: fixture.account, recipient: fixture.recipient, text: "https://example.com/episode")
        let job = try ShareMessageDelivery.prepared(text, identity: fixture.identities[0], routes: fixture.routes)
        XCTAssertEqual(job.messages.count, 1)
        XCTAssertEqual(job.localMessage?.content, text.text)
        XCTAssertNil(job.localMessage?.attachment)
        XCTAssertNil(job.localMessage?.replyToEventID)
    }

    func testUnfinishedUploadCannotFallBackToSendingTheCommentAlone() throws {
        let fixture = try fixture()
        var input = fixture.input
        input.remoteURL = nil
        XCTAssertThrowsError(try ShareMessageDelivery.prepared(input, identity: fixture.identities[0], routes: fixture.routes))
    }

    func testDurableOutboxHoldsEachCommentUntilItsOwnParentIsAccepted() async throws {
        let fixture = try fixture()
        let job = try fixture.prepared()
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("outbox.json")
        let outbox = NostrOutboxStore(fileURL: url)
        let engine = TaskSyncEngine(outbox: outbox)
        try await engine.enqueueForPublish(job.deliveries.map { delivery in
            TaskSyncRelayPublishRequest(event: delivery.event, relayURLs: delivery.relays,
                outboxScope: "dm", recordID: delivery.event.id, acknowledgementPolicy: .anyRelay,
                dependsOnEventID: delivery.dependsOnEventID)
        })
        let restarted = NostrOutboxStore(fileURL: url)
        let queued = await restarted.allEntries()
        XCTAssertEqual(Set(queued.map(\.id)), Set(job.deliveries.map(\.event.id)))
        for parent in job.deliveries where parent.dependsOnEventID == nil {
            let child = try XCTUnwrap(job.deliveries.first { $0.dependsOnEventID == parent.event.id })
            let relay = try XCTUnwrap(parent.relays.first)
            let ready = await restarted.pendingEntries(for: relay)
            XCTAssertEqual(ready.map(\.id), [parent.event.id])
            let premature = await restarted.isPending(eventID: child.event.id, relayURL: relay)
            XCTAssertFalse(premature)
            _ = try await restarted.markAccepted(eventID: parent.event.id, relayURL: "wss://unrelated.example")
            let stillBlocked = await restarted.isPending(eventID: child.event.id, relayURL: relay)
            XCTAssertFalse(stillBlocked)
            _ = try await restarted.markAccepted(eventID: parent.event.id, relayURL: relay)
            let reloaded = NostrOutboxStore(fileURL: url)
            let nowReady = await reloaded.pendingEntries(for: relay)
            XCTAssertEqual(nowReady.map(\.id), [child.event.id])
            XCTAssertNil(nowReady.first?.dependsOnEventID)
        }
        await engine.stop()
    }

    func testExpiringAnUndeliveredAttachmentAlsoFailsItsComment() async throws {
        let job = try fixture().prepared()
        let parent = try XCTUnwrap(job.deliveries.first { $0.dependsOnEventID == nil })
        let child = try XCTUnwrap(job.deliveries.first { $0.dependsOnEventID == parent.event.id })
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        try await outbox.enqueue([
            NostrOutboxEntry(event: parent.event, relayURLs: parent.relays, boardLocalID: "dm", taskID: "file",
                expiresAt: Date(timeIntervalSince1970: 100)),
            NostrOutboxEntry(event: child.event, relayURLs: child.relays, boardLocalID: "dm", taskID: "comment",
                expiresAt: Date(timeIntervalSince1970: 300), dependsOnEventID: parent.event.id),
        ])
        let expired = try await outbox.removeExpired(now: Date(timeIntervalSince1970: 200))
        XCTAssertEqual(Set(expired.map(\.id)), [parent.event.id, child.event.id])
        let remaining = await outbox.allEntries()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testFailedAtomicEnqueueLeavesNeitherMessageInMemory() async throws {
        let job = try fixture().prepared()
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let blocker = directory.appendingPathComponent("not-a-directory")
        try Data().write(to: blocker)
        let outbox = NostrOutboxStore(fileURL: blocker.appendingPathComponent("outbox.json"))
        do {
            try await outbox.enqueue(job.deliveries.map {
                NostrOutboxEntry(event: $0.event, relayURLs: $0.relays, boardLocalID: "dm", taskID: $0.event.id,
                    dependsOnEventID: $0.dependsOnEventID)
            })
            XCTFail("Expected disk failure")
        } catch {}
        let remaining = await outbox.allEntries()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testShareDoesNotSendCommentsWhenParentsFail() async throws {
        let job = try fixture().prepared()
        let probe = DeliveryProbe(failures: Set(job.deliveries.map(\.event.id)))
        do {
            _ = try await ShareMessageDelivery.deliver(job, save: { _ in }) { await probe.send($0) }
            XCTFail("Expected delivery failure")
        } catch {}
        let attempts = await probe.attempts
        XCTAssertEqual(Set(attempts), Set(job.deliveries.filter { $0.dependsOnEventID == nil }.map(\.event.id)))
    }

    func testAcknowledgementDiskFailureKeepsCommentBlockedUntilDurableRetry() async throws {
        let job = try fixture().prepared()
        let parent = try XCTUnwrap(job.deliveries.first { $0.dependsOnEventID == nil })
        let child = try XCTUnwrap(job.deliveries.first { $0.dependsOnEventID == parent.event.id })
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue")
        let backup = directory.appendingPathComponent("backup")
        let outbox = NostrOutboxStore(fileURL: queue.appendingPathComponent("outbox.json"))
        try await outbox.enqueue([parent, child].map {
            NostrOutboxEntry(event: $0.event, relayURLs: $0.relays, boardLocalID: "dm", taskID: $0.event.id,
                acknowledgementPolicy: .anyRelay, dependsOnEventID: $0.dependsOnEventID)
        })
        try FileManager.default.moveItem(at: queue, to: backup)
        try Data().write(to: queue)
        do {
            _ = try await outbox.markAccepted(eventID: parent.event.id, relayURL: parent.relays[0])
            XCTFail("Expected persistence failure")
        } catch {}
        let blocked = await outbox.isPending(eventID: child.event.id, relayURL: child.relays[0])
        XCTAssertFalse(blocked)
        let remaining = await outbox.allEntries()
        XCTAssertEqual(Set(remaining.map(\.id)), [parent.event.id, child.event.id])
        try FileManager.default.removeItem(at: queue)
        try FileManager.default.moveItem(at: backup, to: queue)
        _ = try await outbox.markAccepted(eventID: parent.event.id, relayURL: parent.relays[0])
        let reloaded = NostrOutboxStore(fileURL: queue.appendingPathComponent("outbox.json"))
        let released = await reloaded.isPending(eventID: child.event.id, relayURL: child.relays[0])
        XCTAssertTrue(released)
    }

    func testShareRetryReusesIDsAndOnlyResendsUnacknowledgedComments() async throws {
        let fixture = try fixture()
        let job = try fixture.prepared()
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = ShareJournal(file: directory.appendingPathComponent("transfer.json"))
        try journal.save(job)
        let comments = Set(job.deliveries.filter { $0.dependsOnEventID != nil }.map(\.event.id))
        let first = DeliveryProbe(failures: comments)
        do {
            _ = try await ShareMessageDelivery.deliver(job, save: journal.save) { delivery in
                if let parent = delivery.dependsOnEventID {
                    XCTAssertTrue(try journal.load().deliveries.contains { $0.event.id == parent && $0.accepted })
                }
                return await first.send(delivery)
            }
            XCTFail("Expected comment failure")
        } catch {}
        let saved = try journal.load()
        XCTAssertEqual(saved.messages.map(\.deliveryState), [.sent, .queued])
        let resumed = try ShareMessageDelivery.prepared(saved, identity: fixture.identities[0], routes: fixture.routes)
        XCTAssertEqual(resumed.deliveries.map(\.event.id), job.deliveries.map(\.event.id))
        XCTAssertEqual(resumed.messages.map(\.rumorEventID), job.messages.map(\.rumorEventID))
        let second = DeliveryProbe()
        let finished = try await ShareMessageDelivery.deliver(resumed, save: journal.save) { await second.send($0) }
        let attempts = await second.attempts
        XCTAssertEqual(Set(attempts), comments)
        XCTAssertEqual(finished.state, "sent")
        XCTAssertEqual(finished.messages.map(\.deliveryState), [.sent, .sent])
        XCTAssertEqual(try journal.load().messages, finished.messages)
    }

    func testLegacyTransfersAndOutboxesDecodeWithoutCommentFields() throws {
        let fixture = try fixture(comment: nil)
        let job = try fixture.prepared()
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(job)) as? [String: Any])
        legacy.removeValue(forKey: "additionalLocalMessages")
        legacy["deliveries"] = try XCTUnwrap(legacy["deliveries"] as? [[String: Any]]).map { input in
            var value = input
            value.removeValue(forKey: "dependsOnEventID")
            value.removeValue(forKey: "rumorEventID")
            return value
        }
        let decoded = try JSONDecoder().decode(ShareTransfer.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertEqual(decoded.messages.count, 1)
        XCTAssertEqual(decoded.readyDeliveryIndices(excluding: []).count, job.deliveries.count)
        let delivery = try XCTUnwrap(job.deliveries.first)
        let entry = NostrOutboxEntry(event: delivery.event, relayURLs: delivery.relays, boardLocalID: "dm", taskID: "old")
        let restored = try JSONDecoder().decode(NostrOutboxEntry.self, from: JSONEncoder().encode(entry))
        XCTAssertNil(restored.dependsOnEventID)
        XCTAssertEqual(restored, entry)
    }

    func testHistoryPlacesSameSecondReplyAfterAttachmentWhenItArrivesFirst() throws {
        let job = try fixture().prepared()
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.ingestDirectMessage(job.messages[1]))
        XCTAssertTrue(snapshot.ingestDirectMessage(job.messages[0]))
        XCTAssertEqual(snapshot.directMessageHistory.map(\.rumorEventID), job.messages.map(\.rumorEventID))
        let restored = try JSONDecoder().decode(TaskifySnapshot.self, from: JSONEncoder().encode(snapshot))
        XCTAssertEqual(restored.directMessageHistory.map(\.rumorEventID), job.messages.map(\.rumorEventID))
    }

    private struct Fixture {
        let identities: [NostrIdentity]
        let recipient: ShareRecipient
        let account: ShareAccount
        let routes: [String: [String]]
        let input: ShareTransfer
        func prepared() throws -> ShareTransfer {
            try ShareMessageDelivery.prepared(input, identity: identities[0], routes: routes)
        }
    }

    private func fixture(group: Bool = false, comment: String? = " \nLook at this\n ") throws -> Fixture {
        let identities = try (1...(group ? 3 : 2)).map {
            try NostrIdentity(privateKey: Data(hex: String(repeating: "0", count: 63) + String($0)))
        }
        let routes = Dictionary(uniqueKeysWithValues: identities.enumerated().map {
            ($0.element.publicKeyHex, ["wss://inbox\($0.offset).example", "wss://backup\($0.offset).example"])
        })
        let recipient = ShareRecipient(id: identities[1].publicKeyHex, name: group ? "Friends" : "Friend",
            members: (group ? identities : Array(identities.dropFirst())).map(\.publicKeyHex),
            isGroup: group, discoveryRelays: [])
        let account = ShareAccount(publicKey: identities[0].publicKeyHex, recipients: [recipient],
            server: TaskifyFileServerEntry(url: "https://files.example", type: .blossom),
            senderRelays: routes[identities[0].publicKeyHex]!)
        var input = ShareTransfer(account: account, recipient: recipient, text: comment)
        input.remoteURL = "https://files.example/encrypted.bin"
        input.keyHex = String(repeating: "a", count: 64)
        input.nonceHex = String(repeating: "b", count: 32)
        input.filename = "photo.jpg"; input.mimeType = "image/jpeg"; input.size = 100
        return Fixture(identities: identities, recipient: recipient, account: account, routes: routes, input: input)
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("taskify-comment-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

private struct ShareJournal: Sendable {
    let file: URL
    func save(_ job: ShareTransfer) throws { try JSONEncoder().encode(job).write(to: file, options: .atomic) }
    func load() throws -> ShareTransfer { try JSONDecoder().decode(ShareTransfer.self, from: Data(contentsOf: file)) }
}

private actor DeliveryProbe {
    let failures: Set<String>
    var attempts: [String] = []
    init(failures: Set<String> = []) { self.failures = failures }
    func send(_ delivery: ShareDelivery) -> Bool {
        attempts.append(delivery.event.id)
        return !failures.contains(delivery.event.id)
    }
}
