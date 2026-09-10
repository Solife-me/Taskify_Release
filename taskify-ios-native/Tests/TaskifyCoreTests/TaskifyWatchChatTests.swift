import Foundation
import XCTest
@testable import TaskifyCore
@testable import TaskifyWatchShared

final class TaskifyWatchChatTests: XCTestCase {
    private let aliceKey = try! Data(hex: String(repeating: "0", count: 63) + "1")
    private let bobKey = try! Data(hex: String(repeating: "0", count: 63) + "2")
    private let carolKey = try! Data(hex: String(repeating: "0", count: 63) + "3")

    func testWatchNIP44MatchesTaskifyCoreForDeterministicNonce() throws {
        let alice = try NostrIdentity(privateKey: aliceKey)
        let bob = try NostrIdentity(privateKey: bobKey)
        let plaintext = Data("interoperable watch message".utf8)
        let nonce = Data(repeating: 0x42, count: 32)

        let watchPayload = try TaskifyWatchNIP44V2.encrypt(
            plaintext,
            privateKey: alice.privateKey,
            publicKey: bob.publicKey,
            nonce: nonce
        )
        let corePayload = try NIP44V2.encrypt(
            plaintext,
            privateKey: alice.privateKey,
            publicKey: bob.publicKey,
            nonce: nonce
        )

        XCTAssertEqual(watchPayload, corePayload)
        XCTAssertEqual(
            try TaskifyWatchNIP44V2.decrypt(
                corePayload,
                privateKey: bob.privateKey,
                publicKey: alice.publicKey
            ),
            plaintext
        )
    }

    func testWatchCreatesUniqueGroupWrapsAroundOneCanonicalRumor() throws {
        let alice = try NostrIdentity(privateKey: aliceKey)
        let bob = try NostrIdentity(privateKey: bobKey)
        let carol = try NostrIdentity(privateKey: carolKey)
        let set = try TaskifyWatchNIP17.createEnvelopeSet(
            content: "hello group",
            senderPrivateKey: aliceKey,
            memberPublicKeys: [alice.publicKeyHex, bob.publicKeyHex, carol.publicKeyHex],
            subject: "Watch group",
            createdAt: 1_700_000_000
        )

        XCTAssertEqual(set.wraps.count, 3)
        XCTAssertEqual(Set(set.wraps.map(\.event.id)).count, 3)
        XCTAssertEqual(Set(set.rumor.recipientPublicKeys), Set([bob.publicKeyHex, carol.publicKeyHex]))
        XCTAssertTrue(set.rumor.tags.contains(["subject", "Watch group"]))

        for (identity, expectedRecipient) in [
            (alice, alice.publicKeyHex),
            (bob, bob.publicKeyHex),
            (carol, carol.publicKeyHex),
        ] {
            let wrap = try XCTUnwrap(set.wraps.first { $0.recipientPublicKey == expectedRecipient })
            let decrypted = try TaskifyWatchNIP17.unwrap(
                wrap.event,
                recipientPrivateKey: identity.privateKey
            )
            XCTAssertEqual(decrypted.rumor, set.rumor)
        }
    }

    func testWatchGiftWrapDecryptsWithExistingIPhoneNIP17Implementation() throws {
        let bob = try NostrIdentity(privateKey: bobKey)
        let set = try TaskifyWatchNIP17.createEnvelopeSet(
            content: "from watch",
            senderPrivateKey: aliceKey,
            memberPublicKeys: [bob.publicKeyHex],
            createdAt: 1_700_000_000
        )
        let bobWrap = try XCTUnwrap(set.wraps.first { $0.recipientPublicKey == bob.publicKeyHex })
        let coreEvent = try JSONDecoder().decode(
            NostrEvent.self,
            from: JSONEncoder().encode(bobWrap.event)
        )

        let decrypted = try NIP17GiftWrap.unwrapRumor(coreEvent, recipient: bob)
        XCTAssertEqual(decrypted.rumor.id, set.rumor.id)
        XCTAssertEqual(decrypted.rumor.content, "from watch")
    }

    func testUnsupportedVerifiedRumorBecomesAnIPhonePlaceholder() throws {
        let alice = try NostrIdentity(privateKey: aliceKey)
        let bob = try NostrIdentity(privateKey: bobKey)
        let rumor = try TaskifyWatchNIP17Rumor(
            publicKey: alice.publicKeyHex,
            createdAt: 1_700_000_000,
            kind: 30_078,
            tags: [["p", bob.publicKeyHex]],
            content: "opaque unsupported payload"
        )

        let message = try TaskifyWatchNIP17.chatMessage(
            from: TaskifyWatchNIP17DecryptedRumor(
                wrapEventID: String(repeating: "f", count: 64),
                rumor: rumor
            ),
            identityPublicKey: bob.publicKeyHex
        )

        XCTAssertEqual(message.kind, .unsupportedMessage)
        XCTAssertEqual(message.content, "Open this message on iPhone")
        XCTAssertEqual(message.conversationID, alice.publicKeyHex)
    }

    func testLegacyChatSnapshotSeedsDurableDedupeLedgerFromMessages() throws {
        let alice = try NostrIdentity(privateKey: aliceKey)
        let bob = try NostrIdentity(privateKey: bobKey)
        let rumorID = String(repeating: "a", count: 64)
        let wrapID = String(repeating: "b", count: 64)
        let message = TaskifyWatchChatMessage(
            rumorID: rumorID,
            wrapID: wrapID,
            conversationID: alice.publicKeyHex,
            senderPublicKey: alice.publicKeyHex,
            memberPublicKeys: [alice.publicKeyHex, bob.publicKeyHex],
            content: "legacy",
            createdAt: 1_700_000_000,
            kind: .text
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoder.encode(
                TaskifyWatchChatSnapshot(messages: [message])
            )) as? [String: Any]
        )
        object["schemaVersion"] = 1
        object.removeValue(forKey: "processedWrapIDs")
        object.removeValue(forKey: "processedRumorIDs")

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let decoded = try decoder.decode(
            TaskifyWatchChatSnapshot.self,
            from: JSONSerialization.data(withJSONObject: object)
        )

        XCTAssertEqual(decoded.processedWrapIDs, [wrapID])
        XCTAssertEqual(decoded.processedRumorIDs, [rumorID])
    }

    func testIPhoneGiftWrapDecryptsWithWatchImplementation() throws {
        let alice = try NostrIdentity(privateKey: aliceKey)
        let bob = try NostrIdentity(privateKey: bobKey)
        let rumor = try NIP17Rumor(
            publicKey: alice.publicKeyHex,
            createdAt: 1_700_000_000,
            kind: NIP17GiftWrap.rumorKind,
            tags: [["p", bob.publicKeyHex]],
            content: "from phone"
        )
        let coreWrap = try NIP17GiftWrap.wrap(
            rumor: rumor,
            sender: alice,
            recipientPublicKey: bob.publicKey
        )
        let watchEvent = try JSONDecoder().decode(
            TaskifyWatchNostrEvent.self,
            from: JSONEncoder().encode(coreWrap)
        )

        let decrypted = try TaskifyWatchNIP17.unwrap(
            watchEvent,
            recipientPrivateKey: bob.privateKey
        )
        XCTAssertEqual(decrypted.rumor.id, rumor.id)
        XCTAssertEqual(decrypted.rumor.content, "from phone")
    }

    func testWatchRelayRoutingUsesPublishedListAndFallsBackOnlyOnConfirmedAbsence() throws {
        let bob = try NostrIdentity(privateKey: bobKey)
        let old = try TaskifyWatchNostrCrypto.inboxPreferenceEvent(
            privateKey: bobKey,
            relayURLs: ["wss://old.example"],
            createdAt: 100
        )
        let newest = try TaskifyWatchNostrCrypto.inboxPreferenceEvent(
            privateKey: bobKey,
            relayURLs: ["wss://new.example", "wss://second.example"],
            createdAt: 200
        )
        let published = TaskifyWatchRelayRouting.resolve(
            recipientPublicKey: bob.publicKeyHex,
            events: [old, newest],
            discoveryComplete: true
        )
        XCTAssertEqual(published.status, .published)
        XCTAssertEqual(published.relayURLs, ["wss://new.example", "wss://second.example"])

        let absent = TaskifyWatchRelayRouting.resolve(
            recipientPublicKey: bob.publicKeyHex,
            events: [],
            discoveryComplete: true
        )
        XCTAssertEqual(absent.status, .confirmedAbsent)
        XCTAssertEqual(absent.relayURLs, TaskifyWatchRelayRouting.defaultFallbackRelayURLs)
        XCTAssertTrue(absent.canPublish)

        let indeterminate = TaskifyWatchRelayRouting.resolve(
            recipientPublicKey: bob.publicKeyHex,
            events: [],
            discoveryComplete: false
        )
        XCTAssertEqual(indeterminate.status, .indeterminate)
        XCTAssertTrue(indeterminate.relayURLs.isEmpty)
    }

    func testPublishedButUnusablePreferenceNeverUsesFallback() throws {
        let bob = try NostrIdentity(privateKey: bobKey)
        let emptyPreference = try TaskifyWatchNostrCrypto.signedEvent(
            privateKey: bobKey,
            createdAt: 200,
            kind: 10_050,
            tags: [],
            content: ""
        )
        let result = TaskifyWatchRelayRouting.resolve(
            recipientPublicKey: bob.publicKeyHex,
            events: [emptyPreference],
            discoveryComplete: true
        )
        XCTAssertEqual(result.status, .publishedButUnusable)
        XCTAssertTrue(result.relayURLs.isEmpty)
    }

    func testWatchRelayNormalizationCanonicalizesBeforeDeduplication() {
        XCTAssertEqual(
            TaskifyWatchRelayRouting.normalizedRelayURLs([
                "WSS://Relay.Example:443/",
                "wss://relay.example",
                "wss://other.example/path/#ignored",
            ]),
            ["wss://relay.example", "wss://other.example/path"]
        )
    }

    func testWatchRelayDiscoveryRequiresBoundedIndependentAbsenceEvidence() {
        XCTAssertFalse(
            TaskifyWatchRelayDiscoveryPolicy.hasSufficientAbsenceEvidence(
                completedRelayURLs: [],
                queriedRelayURLs: []
            )
        )
        XCTAssertFalse(
            TaskifyWatchRelayDiscoveryPolicy.hasSufficientAbsenceEvidence(
                completedRelayURLs: ["wss://one.example"],
                queriedRelayURLs: ["wss://one.example", "wss://two.example"]
            )
        )
        XCTAssertTrue(
            TaskifyWatchRelayDiscoveryPolicy.hasSufficientAbsenceEvidence(
                completedRelayURLs: ["wss://one.example", "wss://two.example"],
                queriedRelayURLs: ["wss://one.example", "wss://two.example"]
            )
        )
        XCTAssertFalse(
            TaskifyWatchRelayDiscoveryPolicy.hasSufficientAbsenceEvidence(
                completedRelayURLs: [
                    "wss://one.example/path-a",
                    "wss://one.example/path-b",
                ],
                queriedRelayURLs: [
                    "wss://one.example/path-a",
                    "wss://one.example/path-b",
                    "wss://two.example",
                ]
            )
        )
        XCTAssertTrue(
            TaskifyWatchRelayDiscoveryPolicy.hasSufficientAbsenceEvidence(
                completedRelayURLs: ["wss://one.example"],
                queriedRelayURLs: ["wss://one.example"]
            )
        )
    }

    func testWatchRelayDiscoveryReservesQuerySlotsForTaskifyDefaults() {
        let contacts = (1...9).map { "wss://contact\($0).example" }
        let relays = TaskifyWatchRelayDiscoveryPolicy.prioritizedRelayURLs(
            contactRelayURLs: contacts,
            contextRelayURLs: ["wss://board.example"]
        )

        XCTAssertEqual(Array(relays.prefix(5)), Array(contacts.prefix(5)))
        XCTAssertEqual(
            Array(relays.dropFirst(5)),
            TaskifyWatchRelayRouting.defaultFallbackRelayURLs
        )
        XCTAssertEqual(
            relays.count,
            TaskifyWatchRelayDiscoveryPolicy.maximumQueriedRelayCount
        )
    }

    func testSenderMirrorCannotMakeAnUndeliveredWatchMessageLookSent() throws {
        let alice = try NostrIdentity(privateKey: aliceKey)
        let bob = try NostrIdentity(privateKey: bobKey)
        let envelope = try TaskifyWatchNIP17.createEnvelopeSet(
            content: "recipient must be acknowledged first",
            senderPrivateKey: aliceKey,
            memberPublicKeys: [bob.publicKeyHex],
            createdAt: 1_700_000_000
        )
        let decision = TaskifyWatchRelayDecision(
            status: .published,
            relayURLs: ["wss://relay.example"]
        )
        var wraps = envelope.wraps.map {
            TaskifyWatchOutboxWrap(
                recipientPublicKey: $0.recipientPublicKey,
                event: $0.event,
                routingDecision: decision
            )
        }
        let senderIndex = try XCTUnwrap(
            wraps.firstIndex { $0.recipientPublicKey == alice.publicKeyHex }
        )
        let recipientIndex = try XCTUnwrap(
            wraps.firstIndex { $0.recipientPublicKey == bob.publicKeyHex }
        )
        wraps[senderIndex].acknowledgements[0].state = .accepted

        var entry = TaskifyWatchChatOutboxEntry(
            rumorID: envelope.rumor.id,
            conversationID: bob.publicKeyHex,
            wraps: wraps,
            senderPublicKey: alice.publicKeyHex
        )
        XCTAssertFalse(entry.areRecipientCopiesDelivered)
        XCTAssertEqual(entry.deliveryState, .queued)

        entry.wraps[recipientIndex].acknowledgements[0].state = .accepted
        XCTAssertTrue(entry.areRecipientCopiesDelivered)
        XCTAssertEqual(entry.deliveryState, .sent)
    }

    func testPersistedFallbackDecisionCanPublishWithoutRecipientPreference() {
        // Taskify deliberately permits fallback delivery for recipients with no inbox list.
        let decision = TaskifyWatchRelayDecision(status: .confirmedAbsent,
            relayURLs: ["wss://push.example", "wss://relay.damus.io"])
        XCTAssertTrue(decision.canPublish)
    }

    func testAcknowledgementMatchesGatewayURLNormalizationDrift() throws {
        let bob = try NostrIdentity(privateKey: bobKey)
        let set = try TaskifyWatchNIP17.createEnvelopeSet(
            content: "routing drift",
            senderPrivateKey: aliceKey,
            memberPublicKeys: [bob.publicKeyHex],
            createdAt: 1_700_000_000
        )
        let bobWrap = try XCTUnwrap(set.wraps.first { $0.recipientPublicKey == bob.publicKeyHex })
        let routedRelays = TaskifyWatchRelayRouting.normalizedRelayURLs([
            "wss://relay.example?x=1", "wss://relay.damus.io",
        ])
        XCTAssertEqual(routedRelays.count, 2)
        let wrap = TaskifyWatchOutboxWrap(
            recipientPublicKey: bob.publicKeyHex,
            event: bobWrap.event,
            routingDecision: TaskifyWatchRelayDecision(
                status: .published,
                relayURLs: routedRelays
            )
        )

        // The gateway echoes WHATWG-normalized URLs, which insert the empty path "/" before
        // a query string. Exact matching would silently discard that accepted result and the
        // wrap would stay queued forever despite the relay holding the event.
        XCTAssertEqual(wrap.acknowledgementIndex(forResultRelay: "wss://relay.example/?x=1"), 0)
        XCTAssertEqual(wrap.acknowledgementIndex(forResultRelay: "wss://relay.damus.io"), 1)
        XCTAssertNil(wrap.acknowledgementIndex(forResultRelay: "wss://unknown.example"))
    }

    func testOutboxWrapSubmissionErrorRoundTripsAndStaysOptionalWhenDecoding() throws {
        let bob = try NostrIdentity(privateKey: bobKey)
        let set = try TaskifyWatchNIP17.createEnvelopeSet(
            content: "error surface",
            senderPrivateKey: aliceKey,
            memberPublicKeys: [bob.publicKeyHex],
            createdAt: 1_700_000_000
        )
        let bobWrap = try XCTUnwrap(set.wraps.first { $0.recipientPublicKey == bob.publicKeyHex })
        var wrap = TaskifyWatchOutboxWrap(
            recipientPublicKey: bob.publicKeyHex,
            event: bobWrap.event,
            routingDecision: TaskifyWatchRelayDecision(status: .indeterminate)
        )
        wrap.lastSubmissionError = "The Taskify push relay rejected the request."

        let encoded = try JSONEncoder().encode(wrap)
        let decoded = try JSONDecoder().decode(TaskifyWatchOutboxWrap.self, from: encoded)
        XCTAssertEqual(decoded.lastSubmissionError, wrap.lastSubmissionError)

        // A snapshot persisted before the field existed must keep decoding.
        let legacy = try JSONDecoder().decode(
            TaskifyWatchOutboxWrap.self,
            from: JSONEncoder().encode(
                TaskifyWatchOutboxWrap(
                    recipientPublicKey: bob.publicKeyHex,
                    event: bobWrap.event,
                    routingDecision: TaskifyWatchRelayDecision(status: .indeterminate),
                    lastSubmissionError: nil
                )
            )
        )
        XCTAssertNil(legacy.lastSubmissionError)
    }
}
