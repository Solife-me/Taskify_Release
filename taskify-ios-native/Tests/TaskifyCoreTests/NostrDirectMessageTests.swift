import Foundation
import XCTest
@testable import TaskifyCore

final class NostrDirectMessageTests: XCTestCase {
    private let senderPrivateKey = String(repeating: "0", count: 63) + "1"
    private let recipientPrivateKey = String(repeating: "0", count: 63) + "2"
    private let recipientWrapKey = String(repeating: "0", count: 63) + "3"
    private let senderWrapKey = String(repeating: "0", count: 63) + "4"

    func testRecipientAndSelfWrapsShareCanonicalPWARumorID() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 1_784_647_200,
            kind: 14,
            tags: [["p", recipient.publicKeyHex]],
            content: "Hello from native"
        )

        let recipientWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: recipient.publicKey,
            ephemeralIdentity: try identity(recipientWrapKey)
        )
        let senderWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: sender.publicKey,
            ephemeralIdentity: try identity(senderWrapKey)
        )

        let receivedRumor = try NIP17GiftWrap.unwrapRumor(recipientWrap, recipient: recipient)
        let syncedRumor = try NIP17GiftWrap.unwrapRumor(senderWrap, recipient: sender)
        XCTAssertEqual(receivedRumor.rumor.id, rumor.id)
        XCTAssertEqual(syncedRumor.rumor.id, rumor.id)
        XCTAssertNotEqual(recipientWrap.id, senderWrap.id)

        let incoming = try XCTUnwrap(NostrDirectMessage(
            decrypted: receivedRumor,
            identityPublicKey: recipient.publicKeyHex
        ))
        let outgoing = try XCTUnwrap(NostrDirectMessage(
            decrypted: syncedRumor,
            identityPublicKey: sender.publicKeyHex
        ))
        XCTAssertTrue(incoming.isIncoming)
        XCTAssertEqual(incoming.peerPublicKey, sender.publicKeyHex)
        XCTAssertFalse(outgoing.isIncoming)
        XCTAssertEqual(outgoing.peerPublicKey, recipient.publicKeyHex)
        XCTAssertEqual(incoming.content, outgoing.content)
    }

    func testSnapshotDeduplicatesRumorsSortsThreadsAndTracksUnread() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        var snapshot = TaskifySnapshot.empty
        let newer = message(
            rumorID: String(repeating: "b", count: 64),
            wrapID: String(repeating: "c", count: 64),
            peer: sender.publicKeyHex,
            sender: sender.publicKeyHex,
            content: "Second",
            createdAt: 200,
            incoming: true
        )
        let older = message(
            rumorID: String(repeating: "a", count: 64),
            wrapID: String(repeating: "d", count: 64),
            peer: sender.publicKeyHex,
            sender: recipient.publicKeyHex,
            content: "First",
            createdAt: 100,
            incoming: false
        )

        XCTAssertTrue(snapshot.ingestDirectMessage(newer))
        XCTAssertTrue(snapshot.ingestDirectMessage(older))
        XCTAssertFalse(snapshot.ingestDirectMessage(newer))
        XCTAssertEqual(snapshot.directMessageThreads().first?.messages.map(\.content), ["First", "Second"])
        XCTAssertEqual(snapshot.directMessageThreads().first?.unreadCount, 1)
        XCTAssertTrue(snapshot.markDirectMessageThreadRead(peerPublicKey: sender.publicKeyHex))
        XCTAssertEqual(snapshot.directMessageThreads().first?.unreadCount, 0)

        let roundTrip = try JSONDecoder().decode(
            TaskifySnapshot.self,
            from: JSONEncoder().encode(snapshot)
        )
        XCTAssertEqual(roundTrip.directMessageHistory, snapshot.directMessageHistory)
        XCTAssertEqual(roundTrip.directMessageReadAt, snapshot.directMessageReadAt)
    }

    func testPWAGroupRumorUsesDeterministicThreadAndCanonicalIDAcrossWraps() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let third = try identity(senderWrapKey)
        let members = [sender.publicKeyHex, recipient.publicKeyHex, third.publicKeyHex].sorted()
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 100,
            kind: 14,
            tags: members.map { ["p", $0] } + [["subject", "Family"]],
            content: "Group message"
        )
        let recipientWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: recipient.publicKey,
            ephemeralIdentity: try identity(recipientWrapKey)
        )
        let selfWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: sender.publicKey,
            ephemeralIdentity: third
        )
        let incoming = try XCTUnwrap(NostrDirectMessage(
            decrypted: try NIP17GiftWrap.unwrapRumor(recipientWrap, recipient: recipient),
            identityPublicKey: recipient.publicKeyHex
        ))
        let outgoing = try XCTUnwrap(NostrDirectMessage(
            decrypted: try NIP17GiftWrap.unwrapRumor(selfWrap, recipient: sender),
            identityPublicKey: sender.publicKeyHex
        ))
        let expectedGroupID = "918c50ea451f92b1da9ef62cf7600a4980fa6d6e2b8dea0f118000886d552ec4"
        XCTAssertEqual(NostrGroupConversation.groupID(for: members), expectedGroupID)
        XCTAssertEqual(incoming.groupID, expectedGroupID)
        XCTAssertEqual(outgoing.groupID, expectedGroupID)
        XCTAssertEqual(incoming.peerPublicKey, expectedGroupID)
        XCTAssertEqual(incoming.groupMemberPublicKeys, members)
        XCTAssertEqual(incoming.rumorEventID, outgoing.rumorEventID)

        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.ingestDirectMessage(incoming))
        XCTAssertFalse(snapshot.ingestDirectMessage(outgoing))
        XCTAssertEqual(snapshot.directMessageThreads().count, 1)
    }

    func testGroupMetadataPersistsAndNewerSubjectWins() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let third = try identity(senderWrapKey)
        let members = [sender.publicKeyHex, recipient.publicKeyHex, third.publicKeyHex]
        let initial = try XCTUnwrap(NostrGroupConversation(
            name: "Family",
            memberPublicKeys: members,
            createdAt: 100,
            nameUpdatedAt: 100
        ))
        let renamed = try XCTUnwrap(NostrGroupConversation(
            name: "Home",
            memberPublicKeys: Array(members.reversed()),
            createdAt: 200,
            nameUpdatedAt: 200
        ))
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.upsertGroupConversation(initial))
        XCTAssertEqual(snapshot.directMessageThreads().map(\.peerPublicKey), [initial.groupID])
        XCTAssertTrue(snapshot.upsertGroupConversation(renamed))
        XCTAssertEqual(snapshot.groupConversation(id: initial.groupID)?.displayName, "Home")
        XCTAssertEqual(snapshot.groupConversation(id: initial.groupID)?.createdAt, 100)

        let decoded = try JSONDecoder().decode(
            TaskifySnapshot.self,
            from: JSONEncoder().encode(snapshot)
        )
        XCTAssertEqual(decoded.groupConversation(id: initial.groupID), snapshot.groupConversation(id: initial.groupID))
    }

    func testMetadataOnlyGroupRenameUpdatesSubjectWithoutCreatingMessage() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let third = try identity(senderWrapKey)
        let members = [sender.publicKeyHex, recipient.publicKeyHex, third.publicKeyHex].sorted()
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 250,
            kind: 14,
            tags: members.map { ["p", $0] } + [["subject", "Road Trip"]],
            content: ""
        )
        let decrypted = NIP17DecryptedRumor(
            wrapEventID: String(repeating: "a", count: 64),
            rumor: rumor
        )

        let renamed = try XCTUnwrap(NostrGroupConversation(
            rumor: rumor,
            identityPublicKey: recipient.publicKeyHex
        ))
        XCTAssertEqual(renamed.name, "Road Trip")
        XCTAssertEqual(renamed.nameUpdatedAt, 250)
        XCTAssertEqual(renamed.memberPublicKeys, members)
        XCTAssertNil(NostrDirectMessage(
            decrypted: decrypted,
            identityPublicKey: recipient.publicKeyHex
        ))

        let original = try XCTUnwrap(NostrGroupConversation(
            name: "Vacation",
            memberPublicKeys: members,
            createdAt: 100,
            nameUpdatedAt: 100
        ))
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.upsertGroupConversation(original))
        XCTAssertTrue(snapshot.upsertGroupConversation(renamed))
        XCTAssertEqual(snapshot.groupConversation(id: original.groupID)?.displayName, "Road Trip")
        XCTAssertTrue(snapshot.directMessages(with: original.groupID).isEmpty)
    }

    func testPWAGroupReactionRoutesBackToGroupThread() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let third = try identity(senderWrapKey)
        let members = [sender.publicKeyHex, recipient.publicKeyHex, third.publicKeyHex].sorted()
        let targetID = String(repeating: "a", count: 64)
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 300,
            kind: 7,
            tags: members.map { ["p", $0] } + [
                ["e", targetID],
                ["p", recipient.publicKeyHex],
            ],
            content: "❤️"
        )
        let reaction = try XCTUnwrap(NostrDirectMessageReaction(
            decrypted: NIP17DecryptedRumor(
                wrapEventID: String(repeating: "b", count: 64),
                rumor: rumor
            ),
            identityPublicKey: recipient.publicKeyHex
        ))
        XCTAssertEqual(reaction.groupID, NostrGroupConversation.groupID(for: members))
        XCTAssertEqual(reaction.peerPublicKey, reaction.groupID)
        XCTAssertEqual(reaction.targetEventID, targetID)
    }

    func testReplyUsesCanonicalRumorReference() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let targetID = String(repeating: "a", count: 64)
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 200,
            kind: 14,
            tags: [["p", recipient.publicKeyHex], ["e", targetID]],
            content: "This is a reply"
        )
        let message = try XCTUnwrap(NostrDirectMessage(
            decrypted: NIP17DecryptedRumor(
                wrapEventID: String(repeating: "b", count: 64),
                rumor: rumor
            ),
            identityPublicKey: recipient.publicKeyHex
        ))
        XCTAssertEqual(message.replyToEventID, targetID)
    }

    func testReactionArrivingBeforeMessagePersistsAndNewerRemovalWins() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let targetID = String(repeating: "a", count: 64)
        var snapshot = TaskifySnapshot.empty

        let first = reaction(
            rumorID: String(repeating: "b", count: 64),
            targetID: targetID,
            sender: sender.publicKeyHex,
            peer: sender.publicKeyHex,
            emoji: "❤️",
            createdAt: 200
        )
        XCTAssertTrue(snapshot.ingestDirectMessageReaction(first))

        let target = message(
            rumorID: targetID,
            wrapID: String(repeating: "c", count: 64),
            peer: sender.publicKeyHex,
            sender: recipient.publicKeyHex,
            content: "React to this",
            createdAt: 100,
            incoming: false
        )
        XCTAssertTrue(snapshot.ingestDirectMessage(target))
        XCTAssertEqual(snapshot.directMessageReactions(for: target).map(\.emoji), ["❤️"])

        let stale = reaction(
            rumorID: String(repeating: "d", count: 64),
            targetID: targetID,
            sender: sender.publicKeyHex,
            peer: sender.publicKeyHex,
            emoji: "👍",
            createdAt: 150
        )
        XCTAssertFalse(snapshot.ingestDirectMessageReaction(stale))
        let removal = reaction(
            rumorID: String(repeating: "e", count: 64),
            targetID: targetID,
            sender: sender.publicKeyHex,
            peer: sender.publicKeyHex,
            emoji: "-",
            createdAt: 300
        )
        XCTAssertTrue(snapshot.ingestDirectMessageReaction(removal))
        XCTAssertTrue(snapshot.directMessageReactions(for: target).isEmpty)
    }

    func testPWAStyleKindSevenReactionParsesFromGiftWrap() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let targetID = String(repeating: "f", count: 64)
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 300,
            kind: 7,
            tags: [
                ["p", recipient.publicKeyHex],
                ["e", targetID],
                ["p", recipient.publicKeyHex],
            ],
            content: "👍"
        )
        let wrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: recipient.publicKey,
            ephemeralIdentity: try identity(recipientWrapKey)
        )
        let decrypted = try NIP17GiftWrap.unwrapRumor(wrap, recipient: recipient)
        let reaction = try XCTUnwrap(NostrDirectMessageReaction(
            decrypted: decrypted,
            identityPublicKey: recipient.publicKeyHex
        ))
        XCTAssertEqual(reaction.targetEventID, targetID)
        XCTAssertEqual(reaction.emoji, "👍")
        XCTAssertEqual(reaction.peerPublicKey, sender.publicKeyHex)
    }

    func testPWAStyleKindFifteenAttachmentParsesFromRecipientAndSelfWraps() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let plaintext = Data("native and pwa attachment".utf8)
        let encrypted = try NostrDirectMessageAttachmentCrypto.encrypt(plaintext)
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(
            url: "https://originless.solife.me/ipfs/example",
            mimeType: "image/jpeg",
            filename: "Photo.jpg",
            size: plaintext.count,
            width: 1_200,
            height: 800,
            keyHex: encrypted.keyHex,
            nonceHex: encrypted.nonceHex,
            sha256: encrypted.sha256
        ))
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 1_784_647_300,
            kind: 15,
            tags: [["p", recipient.publicKeyHex]] + attachment.rumorTags,
            content: attachment.url
        )
        let recipientWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: recipient.publicKey,
            ephemeralIdentity: try identity(recipientWrapKey)
        )
        let selfWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: sender,
            recipientPublicKey: sender.publicKey,
            ephemeralIdentity: try identity(senderWrapKey)
        )

        let incoming = try XCTUnwrap(NostrDirectMessage(
            decrypted: NIP17GiftWrap.unwrapRumor(recipientWrap, recipient: recipient),
            identityPublicKey: recipient.publicKeyHex
        ))
        let outgoing = try XCTUnwrap(NostrDirectMessage(
            decrypted: NIP17GiftWrap.unwrapRumor(selfWrap, recipient: sender),
            identityPublicKey: sender.publicKeyHex
        ))
        XCTAssertEqual(incoming.attachment, attachment)
        XCTAssertEqual(outgoing.attachment, attachment)
        XCTAssertEqual(incoming.displayContent, "📷 Photo.jpg")
        XCTAssertEqual(
            try NostrDirectMessageAttachmentCrypto.decrypt(encrypted.ciphertext, attachment: attachment),
            plaintext
        )
    }

    func testKindFifteenAttachmentRejectsMissingCryptoMetadata() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 1_784_647_301,
            kind: 15,
            tags: [["p", recipient.publicKeyHex], ["file-type", "image/jpeg"]],
            content: "https://example.com/encrypted.bin"
        )
        XCTAssertNil(NostrDirectMessage(
            decrypted: NIP17DecryptedRumor(
                wrapEventID: String(repeating: "8", count: 64),
                rumor: rumor
            ),
            identityPublicKey: recipient.publicKeyHex
        ))
    }

    func testAttachmentCryptoRejectsCiphertextTampering() throws {
        let encrypted = try NostrDirectMessageAttachmentCrypto.encrypt(Data("secret".utf8))
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(
            url: "https://example.com/encrypted.bin",
            mimeType: "application/pdf",
            filename: "Document.pdf",
            keyHex: encrypted.keyHex,
            nonceHex: encrypted.nonceHex,
            sha256: encrypted.sha256
        ))
        var tampered = encrypted.ciphertext
        tampered[tampered.startIndex] ^= 0xff
        XCTAssertThrowsError(try NostrDirectMessageAttachmentCrypto.decrypt(tampered, attachment: attachment))
    }

    func testAttachmentPersistsInSnapshot() throws {
        let encrypted = try NostrDirectMessageAttachmentCrypto.encrypt(Data("document".utf8))
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(
            url: "https://example.com/encrypted.bin",
            mimeType: "application/pdf",
            filename: "Document.pdf",
            size: 8,
            keyHex: encrypted.keyHex,
            nonceHex: encrypted.nonceHex,
            sha256: encrypted.sha256
        ))
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.ingestDirectMessage(NostrDirectMessage(
            rumorEventID: String(repeating: "7", count: 64),
            wrapEventID: String(repeating: "6", count: 64),
            peerPublicKey: try identity(senderPrivateKey).publicKeyHex,
            senderPublicKey: try identity(senderPrivateKey).publicKeyHex,
            content: attachment.url,
            createdAt: 300,
            isIncoming: true,
            attachment: attachment
        )))
        let decoded = try JSONDecoder().decode(
            TaskifySnapshot.self,
            from: JSONEncoder().encode(snapshot)
        )
        XCTAssertEqual(decoded.directMessageHistory.first?.attachment, attachment)
    }

    func testConversationSearchMatchesTextSenderAndAttachmentMetadata() throws {
        let sender = try identity(senderPrivateKey)
        let textMessage = message(
            rumorID: String(repeating: "1", count: 64),
            wrapID: String(repeating: "2", count: 64),
            peer: sender.publicKeyHex,
            sender: sender.publicKeyHex,
            content: "Café plans for Thursday",
            createdAt: 100,
            incoming: true
        )
        XCTAssertTrue(textMessage.matchesSearch("CAFE"))
        XCTAssertTrue(textMessage.matchesSearch("nathan", senderName: "Nathan Hughes"))
        XCTAssertFalse(textMessage.matchesSearch("Friday", senderName: "Nathan Hughes"))
        XCTAssertFalse(textMessage.matchesSearch("   "))

        let encrypted = try NostrDirectMessageAttachmentCrypto.encrypt(Data("agenda".utf8))
        let attachment = try XCTUnwrap(NostrDirectMessageAttachment(
            url: "https://example.com/encrypted.bin",
            mimeType: "application/pdf",
            filename: "Project Agenda.pdf",
            keyHex: encrypted.keyHex,
            nonceHex: encrypted.nonceHex,
            sha256: encrypted.sha256
        ))
        let attachmentMessage = NostrDirectMessage(
            rumorEventID: String(repeating: "3", count: 64),
            wrapEventID: String(repeating: "4", count: 64),
            peerPublicKey: sender.publicKeyHex,
            senderPublicKey: sender.publicKeyHex,
            content: attachment.url,
            createdAt: 200,
            isIncoming: true,
            attachment: attachment
        )
        XCTAssertTrue(attachmentMessage.matchesSearch("agenda"))
        XCTAssertTrue(attachmentMessage.matchesSearch("application/pdf"))
    }

    func testConversationLifecyclePreferencesPersistAndNewMessagesUnarchive() throws {
        let sender = try identity(senderPrivateKey)
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.ingestDirectMessage(message(
            rumorID: String(repeating: "1", count: 64),
            wrapID: String(repeating: "2", count: 64),
            peer: sender.publicKeyHex,
            sender: sender.publicKeyHex,
            content: "First",
            createdAt: 100,
            incoming: true
        ), now: 100))

        XCTAssertTrue(snapshot.archiveDirectMessageThread(peerPublicKey: sender.publicKeyHex, at: 110))
        XCTAssertTrue(snapshot.isDirectMessageThreadArchived(sender.publicKeyHex))
        XCTAssertTrue(snapshot.activeDirectMessageThreads().isEmpty)
        XCTAssertTrue(snapshot.setDirectMessagePeerBlocked(sender.publicKeyHex, blocked: true))
        XCTAssertTrue(snapshot.isDirectMessagePeerBlocked(sender.publicKeyHex))

        XCTAssertTrue(snapshot.ingestDirectMessage(message(
            rumorID: String(repeating: "3", count: 64),
            wrapID: String(repeating: "4", count: 64),
            peer: sender.publicKeyHex,
            sender: sender.publicKeyHex,
            content: "New after archive",
            createdAt: 120,
            incoming: true
        ), now: 120))
        XCTAssertFalse(snapshot.isDirectMessageThreadArchived(sender.publicKeyHex))
        XCTAssertEqual(snapshot.activeDirectMessageThreads().map(\.peerPublicKey), [sender.publicKeyHex])

        let decoded = try JSONDecoder().decode(
            TaskifySnapshot.self,
            from: JSONEncoder().encode(snapshot)
        )
        XCTAssertTrue(decoded.isDirectMessagePeerBlocked(sender.publicKeyHex))
        XCTAssertFalse(decoded.isDirectMessageThreadArchived(sender.publicKeyHex))
    }

    func testDeletedConversationSuppressesRelayReplayTemporarily() throws {
        let sender = try identity(senderPrivateKey)
        let original = message(
            rumorID: String(repeating: "5", count: 64),
            wrapID: String(repeating: "6", count: 64),
            peer: sender.publicKeyHex,
            sender: sender.publicKeyHex,
            content: "Delete me",
            createdAt: 200,
            incoming: true
        )
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.ingestDirectMessage(original, now: 200))
        XCTAssertTrue(snapshot.deleteDirectMessageThread(
            peerPublicKey: sender.publicKeyHex,
            at: 210,
            suppressionDuration: 30
        ))
        XCTAssertTrue(snapshot.directMessageThreads().isEmpty)
        XCTAssertFalse(snapshot.ingestDirectMessage(original, now: 220))
        XCTAssertTrue(snapshot.ingestDirectMessage(original, now: 241))
    }

    func testSharedTasksParticipateInConversationLifecycle() throws {
        let sender = try identity(senderPrivateKey)
        let firstShare = SharedInboxItem(
            wrapEventID: "shared-wrap-1",
            rumorEventID: "shared-rumor-1",
            sender: SharedInboxSender(publicKey: sender.publicKeyHex, name: "Alice"),
            task: SharedTaskDelivery(title: "Review proposal"),
            receivedAt: Date(timeIntervalSince1970: 100)
        )
        var snapshot = TaskifySnapshot.empty

        XCTAssertTrue(snapshot.ingestSharedInboxItem(firstShare))
        let firstThread = try XCTUnwrap(snapshot.directMessageThreads().first)
        XCTAssertEqual(firstThread.peerPublicKey, sender.publicKeyHex)
        XCTAssertEqual(firstThread.latestSharedTask?.task.title, "Review proposal")
        XCTAssertEqual(firstThread.actionRequiredCount, 1)
        XCTAssertEqual(firstThread.unreadCount, 0)

        XCTAssertTrue(snapshot.archiveDirectMessageThread(peerPublicKey: sender.publicKeyHex, at: 110))
        XCTAssertTrue(snapshot.isDirectMessageThreadArchived(sender.publicKeyHex))
        XCTAssertTrue(snapshot.activeDirectMessageThreads().isEmpty)

        let newerShare = SharedInboxItem(
            wrapEventID: "shared-wrap-2",
            rumorEventID: "shared-rumor-2",
            sender: SharedInboxSender(publicKey: sender.publicKeyHex, name: "Alice"),
            task: SharedTaskDelivery(title: "New after archive"),
            receivedAt: Date(timeIntervalSince1970: 120)
        )
        XCTAssertTrue(snapshot.ingestSharedInboxItem(newerShare))
        XCTAssertFalse(snapshot.isDirectMessageThreadArchived(sender.publicKeyHex))
        XCTAssertEqual(snapshot.activeDirectMessageThreads().map(\.peerPublicKey), [sender.publicKeyHex])
        XCTAssertEqual(snapshot.directMessageThreads().first?.actionRequiredCount, 2)

        XCTAssertTrue(snapshot.deleteDirectMessageThread(peerPublicKey: sender.publicKeyHex, at: 130))
        XCTAssertTrue(snapshot.directMessageThreads().isEmpty)
        XCTAssertEqual(snapshot.sharedInboxItems?.filter { $0.status == .deleted }.count, 2)
    }

    func testContactAndCalendarSharesJoinTheSenderConversation() throws {
        let sender = try identity(senderPrivateKey)
        let sharedContact = try identity(recipientPrivateKey)
        let sharedNpub = try XCTUnwrap(NostrPublicKey.npub(
            from: try XCTUnwrap(NostrPublicKey.parse(sharedContact.publicKeyHex))
        ))
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.ingestSharedContactInboxItem(SharedContactInboxItem(
            wrapEventID: "contact-wrap",
            rumorEventID: "contact-rumor",
            sender: SharedInboxSender(publicKey: sender.publicKeyHex, name: "Alice"),
            contact: SharedContactDelivery(npub: sharedNpub, displayName: "Sam"),
            receivedAt: Date(timeIntervalSince1970: 100)
        )))
        XCTAssertTrue(snapshot.ingestSharedCalendarInvite(SharedCalendarInviteInboxItem(
            wrapEventID: "calendar-wrap",
            rumorEventID: "calendar-rumor",
            sender: SharedInboxSender(publicKey: sender.publicKeyHex, name: "Alice"),
            event: SharedCalendarEventDelivery(
                eventID: "event-1",
                canonical: "30310:\(sender.publicKeyHex):event-1",
                view: "30311:\(sender.publicKeyHex):event-1",
                eventKey: "event-key",
                inviteToken: "invite-token",
                title: "Planning call"
            ),
            receivedAt: Date(timeIntervalSince1970: 110)
        )))

        let thread = try XCTUnwrap(snapshot.directMessageThreads().first)
        XCTAssertEqual(thread.peerPublicKey, sender.publicKeyHex)
        XCTAssertEqual(thread.sharedContacts.first?.contact.primaryName, "Sam")
        XCTAssertEqual(thread.latestCalendarInvite?.event.displayTitle, "Planning call")
        XCTAssertEqual(thread.actionRequiredCount, 2)
        XCTAssertEqual(thread.latestActivityTimestamp, 110)

        XCTAssertTrue(snapshot.deleteDirectMessageThread(peerPublicKey: sender.publicKeyHex, at: 120))
        XCTAssertTrue(snapshot.directMessageThreads().isEmpty)
        XCTAssertEqual(snapshot.sharedContactInboxItems?.first?.status, .deleted)
        XCTAssertEqual(snapshot.sharedCalendarInviteItems?.first?.status, .deleted)
    }

    func testMutedAndLeftGroupPreferencesAffectUnreadAndPersist() throws {
        let sender = try identity(senderPrivateKey)
        let recipient = try identity(recipientPrivateKey)
        let group = try XCTUnwrap(NostrGroupConversation(
            name: "Planning",
            memberPublicKeys: [sender.publicKeyHex, recipient.publicKeyHex],
            createdAt: 100
        ))
        var snapshot = TaskifySnapshot.empty
        XCTAssertTrue(snapshot.upsertGroupConversation(group))
        XCTAssertTrue(snapshot.setDirectMessageGroupMuted(group.groupID, muted: true, at: 150))
        XCTAssertTrue(snapshot.setDirectMessageGroupLeft(group.groupID, left: true))
        XCTAssertTrue(snapshot.isDirectMessageGroupMuted(group.groupID))
        XCTAssertTrue(snapshot.hasLeftDirectMessageGroup(group.groupID))

        let groupMessage = NostrDirectMessage(
            rumorEventID: String(repeating: "7", count: 64),
            wrapEventID: String(repeating: "8", count: 64),
            peerPublicKey: group.groupID,
            senderPublicKey: sender.publicKeyHex,
            content: "Muted message",
            createdAt: 160,
            isIncoming: true,
            groupID: group.groupID,
            groupMemberPublicKeys: group.memberPublicKeys
        )
        XCTAssertTrue(snapshot.ingestDirectMessage(groupMessage, now: 160))
        XCTAssertEqual(snapshot.directMessageThreads().first?.unreadCount, 0)
    }

    func testLegacySnapshotWithoutChatFieldsStillDecodes() throws {
        let encoded = try JSONEncoder().encode(TaskifySnapshot.empty)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "directMessages")
        object.removeValue(forKey: "directMessageReadAt")
        object.removeValue(forKey: "directMessageReactions")
        object.removeValue(forKey: "nostrGroupConversations")
        object.removeValue(forKey: "directMessageArchivedAt")
        object.removeValue(forKey: "directMessageDeletedEventIDs")
        object.removeValue(forKey: "directMessageBlockedPeers")
        object.removeValue(forKey: "directMessageMutedGroups")
        object.removeValue(forKey: "directMessageLeftGroups")
        let decoded = try JSONDecoder().decode(
            TaskifySnapshot.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
        XCTAssertTrue(decoded.directMessageHistory.isEmpty)
        XCTAssertTrue(decoded.directMessageThreads().isEmpty)
    }

    private func identity(_ privateKeyHex: String) throws -> NostrIdentity {
        try NostrIdentity(privateKey: Data(hex: privateKeyHex))
    }

    private func message(
        rumorID: String,
        wrapID: String,
        peer: String,
        sender: String,
        content: String,
        createdAt: Int,
        incoming: Bool
    ) -> NostrDirectMessage {
        NostrDirectMessage(
            rumorEventID: rumorID,
            wrapEventID: wrapID,
            peerPublicKey: peer,
            senderPublicKey: sender,
            content: content,
            createdAt: createdAt,
            isIncoming: incoming
        )
    }

    private func reaction(
        rumorID: String,
        targetID: String,
        sender: String,
        peer: String,
        emoji: String,
        createdAt: Int
    ) -> NostrDirectMessageReaction {
        NostrDirectMessageReaction(
            rumorEventID: rumorID,
            wrapEventID: String(repeating: "9", count: 64),
            targetEventID: targetID,
            senderPublicKey: sender,
            peerPublicKey: peer,
            emoji: emoji,
            createdAt: createdAt
        )
    }
}
