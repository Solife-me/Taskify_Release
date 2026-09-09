import Foundation
import XCTest
@testable import TaskifyCore

/// Multiple attachments per send stay one file per kind 15 rumor (NIP-17 has
/// no multi-file event), wrapped as one ordered batch with the caption as a
/// trailing kind 14.
final class MultiAttachmentBatchTests: XCTestCase {
    func testMultiAttachmentBatchSendsOneKindFifteenPerFileAndOneComment() throws {
        let fixture = try fixture()
        let sender = fixture.identities[0]
        let recipient = fixture.identities[1].publicKeyHex
        let rumors = try attachmentRumors(sender: sender, recipients: [recipient], count: 3)
        let batch = try NIP17OutgoingMessageBatch(
            rumors: rumors,
            attachmentComment: " \nThree files\n ",
            identity: sender,
            relayURLsByRecipient: fixture.routes
        )
        let comment = try expectedCommentRumor(sender: sender, recipients: [recipient],
            parent: rumors[2], comment: "Three files")
        XCTAssertEqual(batch.localMessages.map(\.rumorEventID),
            rumors.map(\.id) + [comment.id])
        XCTAssertEqual(batch.localMessages.map(\.deliveryState),
            Array(repeating: .queued, count: 4))

        for identity in fixture.identities {
            let copies = batch.deliveries.filter { $0.event.tags.contains(["p", identity.publicKeyHex]) }
            XCTAssertEqual(copies.count, 4)
            XCTAssertEqual(copies.map(\.rumorEventID), rumors.map(\.id) + [comment.id])
            XCTAssertNil(copies[0].dependsOnEventID)
            for (index, copy) in copies.enumerated().dropFirst() {
                XCTAssertEqual(copy.dependsOnEventID, copies[index - 1].event.id)
            }
            let files = try copies.prefix(3).map {
                try NIP17GiftWrap.unwrapRumor($0.event, recipient: identity).rumor
            }
            XCTAssertEqual(files.map(\.kind), [15, 15, 15])
            XCTAssertEqual(files.map(\.content), rumors.map(\.content))
            let parsed = try files.map { attachment in
                try XCTUnwrap(NostrDirectMessageAttachment(rumor: attachment))
            }
            XCTAssertEqual(parsed.map(\.url), rumors.map(\.content))
            for (index, file) in files.enumerated() {
                XCTAssertEqual(file.createdAt, rumors[index].createdAt)
                XCTAssertEqual(file.recipientPublicKeys, [recipient])
                XCTAssertEqual(Set(file.tags.map(\.first)), [
                    "p", "file-type", "encryption-algorithm", "decryption-key",
                    "decryption-nonce", "size", "filename",
                ])
            }
            let unwrappedComment = try NIP17GiftWrap.unwrapRumor(copies[3].event, recipient: identity).rumor
            XCTAssertEqual(unwrappedComment.kind, 14)
            XCTAssertEqual(unwrappedComment.content, "Three files")
            XCTAssertEqual(unwrappedComment.createdAt, rumors[2].createdAt)
            XCTAssertEqual(unwrappedComment.tags.filter { $0.first == "e" }, [["e", rumors[2].id]])
            XCTAssertEqual(unwrappedComment.recipientPublicKeys, [recipient])
            XCTAssertFalse(unwrappedComment.tags.contains {
                $0.first == "decryption-key" || $0.first == "file-type"
            })
        }
    }

    func testMultiAttachmentBatchWithoutCommentSendsOnlyFiles() throws {
        let fixture = try fixture()
        let sender = fixture.identities[0]
        let rumors = try attachmentRumors(
            sender: sender,
            recipients: [fixture.identities[1].publicKeyHex],
            count: 2
        )
        for comment in [nil, "", " \n\t "] {
            let batch = try NIP17OutgoingMessageBatch(
                rumors: rumors,
                attachmentComment: comment,
                identity: sender,
                relayURLsByRecipient: fixture.routes
            )
            XCTAssertEqual(batch.localMessages.map(\.rumorEventID), rumors.map(\.id))
            for identity in fixture.identities {
                let copies = batch.deliveries.filter { $0.event.tags.contains(["p", identity.publicKeyHex]) }
                XCTAssertEqual(copies.count, 2)
                XCTAssertEqual(copies.map(\.rumorEventID), rumors.map(\.id))
                XCTAssertNil(copies[0].dependsOnEventID)
                XCTAssertEqual(copies[1].dependsOnEventID, copies[0].event.id)
            }
        }
    }

    func testMultiAttachmentBatchRejectsEmptyAndMismatchedRecipientSets() throws {
        let fixture = try fixture()
        let sender = fixture.identities[0]
        XCTAssertThrowsError(try NIP17OutgoingMessageBatch(
            rumors: [],
            attachmentComment: "Nothing",
            identity: sender,
            relayURLsByRecipient: fixture.routes
        ))
        let matched = try attachmentRumors(
            sender: sender,
            recipients: [fixture.identities[1].publicKeyHex],
            count: 2
        )
        let otherRecipient = try NostrIdentity(
            privateKey: Data(hex: String(repeating: "0", count: 62) + "99")
        ).publicKeyHex
        var mismatched = matched
        mismatched[1] = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: matched[1].createdAt,
            kind: NostrDirectMessageAttachment.rumorKind,
            tags: [["p", otherRecipient]] + matched[1].tags.filter { $0.first != "p" },
            content: matched[1].content
        )
        XCTAssertThrowsError(try NIP17OutgoingMessageBatch(
            rumors: mismatched,
            identity: sender,
            relayURLsByRecipient: fixture.routes
        ))
    }

    func testGroupMultiAttachmentBatchCarriesSubjectAndMemberTagsOnEveryRumor() throws {
        let fixture = try fixture(memberCount: 3)
        let sender = fixture.identities[0]
        let members = fixture.identities.map(\.publicKeyHex)
        let rumors = try attachmentRumors(
            sender: sender,
            recipients: members,
            subject: "Friends",
            count: 2
        )
        let batch = try NIP17OutgoingMessageBatch(
            rumors: rumors,
            attachmentComment: "For everyone",
            identity: sender,
            relayURLsByRecipient: fixture.routes
        )
        for identity in fixture.identities {
            let copies = batch.deliveries.filter { $0.event.tags.contains(["p", identity.publicKeyHex]) }
            XCTAssertEqual(copies.count, 3)
            let unwrapped = try copies.map {
                try NIP17GiftWrap.unwrapRumor($0.event, recipient: identity).rumor
            }
            XCTAssertEqual(unwrapped.map(\.kind), [15, 15, 14])
            for rumor in unwrapped {
                XCTAssertEqual(rumor.recipientPublicKeys.sorted(), members.sorted())
                XCTAssertEqual(rumor.tags.filter { $0.first == "subject" }, [["subject", "Friends"]])
            }
            XCTAssertEqual(unwrapped[2].tags.filter { $0.first == "e" }, [["e", rumors[1].id]])
        }
    }

    func testHistoryKeepsCaptionAfterAllFilesWhenItArrivesFirst() throws {
        let fixture = try fixture()
        let sender = fixture.identities[0]
        let rumors = try attachmentRumors(
            sender: sender,
            recipients: [fixture.identities[1].publicKeyHex],
            count: 3
        )
        let batch = try NIP17OutgoingMessageBatch(
            rumors: rumors,
            attachmentComment: "Caption",
            identity: sender,
            relayURLsByRecipient: fixture.routes
        )
        var snapshot = TaskifySnapshot.empty
        // Reverse arrival: the caption (sharing the last file's createdAt)
        // lands before any file. The same-second reply reparenting must still
        // order it after every file it describes.
        for message in batch.localMessages.reversed() {
            XCTAssertTrue(snapshot.ingestDirectMessage(message))
        }
        XCTAssertEqual(
            snapshot.directMessageHistory.map(\.rumorEventID),
            batch.localMessages.map(\.rumorEventID)
        )
        let restored = try JSONDecoder().decode(TaskifySnapshot.self, from: JSONEncoder().encode(snapshot))
        XCTAssertEqual(
            restored.directMessageHistory.map(\.rumorEventID),
            batch.localMessages.map(\.rumorEventID)
        )
    }

    func testDurableOutboxReleasesMultiFileChainLinkByLink() async throws {
        let fixture = try fixture()
        let sender = fixture.identities[0]
        let rumors = try attachmentRumors(
            sender: sender,
            recipients: [fixture.identities[1].publicKeyHex],
            count: 3
        )
        let batch = try NIP17OutgoingMessageBatch(
            rumors: rumors,
            attachmentComment: "Caption",
            identity: sender,
            relayURLsByRecipient: fixture.routes
        )
        let copies = batch.deliveries.filter { $0.event.tags.contains(["p", sender.publicKeyHex]) }
        XCTAssertEqual(copies.count, 4)
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        try await outbox.enqueue(copies.map { delivery in
            NostrOutboxEntry(
                event: delivery.event,
                relayURLs: delivery.relayURLs,
                boardLocalID: "dm",
                taskID: delivery.rumorEventID,
                acknowledgementPolicy: .anyRelay,
                expiresAt: Date().addingTimeInterval(60 * 60),
                dependsOnEventID: delivery.dependsOnEventID
            )
        })
        let relay = try XCTUnwrap(copies[0].relayURLs.first)
        for (parent, child) in zip(copies, copies.dropFirst()) {
            let ready = await outbox.pendingEntries(for: relay)
            XCTAssertEqual(ready.map(\.id), [parent.event.id])
            let blocked = await outbox.isPending(eventID: child.event.id, relayURL: relay)
            XCTAssertFalse(blocked)
            _ = try await outbox.markAccepted(eventID: parent.event.id, relayURL: relay)
            let released = await outbox.isPending(eventID: child.event.id, relayURL: relay)
            XCTAssertTrue(released)
        }
    }

    func testExpiringAMidChainFileAlsoFailsItsDependentsButNotEarlierFiles() async throws {
        let fixture = try fixture()
        let sender = fixture.identities[0]
        let rumors = try attachmentRumors(
            sender: sender,
            recipients: [fixture.identities[1].publicKeyHex],
            count: 3
        )
        let batch = try NIP17OutgoingMessageBatch(
            rumors: rumors,
            attachmentComment: "Caption",
            identity: sender,
            relayURLsByRecipient: fixture.routes
        )
        let copies = batch.deliveries.filter { $0.event.tags.contains(["p", sender.publicKeyHex]) }
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = NostrOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        try await outbox.enqueue(copies.enumerated().map { index, delivery in
            NostrOutboxEntry(
                event: delivery.event,
                relayURLs: delivery.relayURLs,
                boardLocalID: "dm",
                taskID: delivery.rumorEventID,
                acknowledgementPolicy: .anyRelay,
                // Only the second file is past expiry; everything it would
                // block on must go with it, the first file must survive.
                expiresAt: Date(timeIntervalSince1970: index == 1 ? 100 : 500),
                dependsOnEventID: delivery.dependsOnEventID
            )
        })
        let expired = try await outbox.removeExpired(now: Date(timeIntervalSince1970: 200))
        XCTAssertEqual(
            Set(expired.map(\.id)),
            Set(copies.dropFirst().map(\.event.id))
        )
        let remaining = await outbox.allEntries()
        XCTAssertEqual(remaining.map(\.id), [copies[0].event.id])
    }

    // MARK: - Fixtures

    private struct Fixture {
        let identities: [NostrIdentity]
        let routes: [String: [String]]
    }

    private func fixture(memberCount: Int = 2) throws -> Fixture {
        let identities = try (1...memberCount).map {
            try NostrIdentity(privateKey: Data(hex: String(repeating: "0", count: 63) + String($0)))
        }
        let routes = Dictionary(uniqueKeysWithValues: identities.enumerated().map {
            ($0.element.publicKeyHex, ["wss://inbox\($0.offset).example"])
        })
        return Fixture(identities: identities, routes: routes)
    }

    private func attachmentRumors(
        sender: NostrIdentity,
        recipients: [String],
        subject: String? = nil,
        count: Int,
        base: Int = 1_000
    ) throws -> [NIP17Rumor] {
        try (0..<count).map { index in
            let attachment = try XCTUnwrap(NostrDirectMessageAttachment(
                url: "https://files.example/file\(index).bin",
                mimeType: "image/jpeg",
                filename: "photo\(index).jpg",
                size: 100,
                keyHex: String(repeating: "a0", count: 32),
                nonceHex: String(repeating: "b0", count: 16)
            ))
            var tags = recipients.map { ["p", $0] }
            if let subject { tags.append(["subject", subject]) }
            tags.append(contentsOf: attachment.rumorTags)
            return try NIP17Rumor(
                publicKey: sender.publicKeyHex,
                createdAt: base + index,
                kind: NostrDirectMessageAttachment.rumorKind,
                tags: tags,
                content: attachment.url
            )
        }
    }

    /// The caption rumor the batch is expected to append: conversation tags
    /// from the parent, an e tag naming the last file, same createdAt.
    private func expectedCommentRumor(
        sender: NostrIdentity,
        recipients: [String],
        parent: NIP17Rumor,
        comment: String
    ) throws -> NIP17Rumor {
        let tags = parent.tags.filter { $0.first == "p" || $0.first == "subject" }
            + [["e", parent.id]]
        return try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: parent.createdAt,
            kind: NIP17GiftWrap.rumorKind,
            tags: tags,
            content: comment
        )
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("taskify-multi-attachment-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}