import Foundation
import XCTest
@testable import TaskifyCore

final class NostrContactsTests: XCTestCase {
    private let privateKeyHex = String(repeating: "0", count: 63) + "1"
    private let aliceKey = String(repeating: "1", count: 64)
    private let bobKey = String(repeating: "2", count: 64)

    func testNIP51PrivateContactListRoundTripsWithPWAFields() throws {
        let identity = try NostrIdentity(privateKey: Data(hex: privateKeyHex))
        let alice = try XCTUnwrap(NostrContact(
            publicKeyValue: aliceKey,
            relayURLs: ["wss://relay.example/"],
            petname: "Alice"
        ))
        let bob = try XCTUnwrap(NostrContact(
            publicKeyValue: bobKey,
            petname: "Bob"
        ))
        let event = try NIP51ContactListContract.event(
            contacts: [alice, bob],
            identity: identity,
            createdAt: 1_721_600_000,
            extraTags: [["title", "Private teammates"]],
            nonce: Data((0..<32).map(UInt8.init))
        )

        XCTAssertTrue(event.verify())
        XCTAssertEqual(event.kind, 30_000)
        XCTAssertEqual(event.firstTagValue(named: "d"), "Chat-Friends")

        let decoded = try NIP51ContactListContract.decode(event: event, identity: identity)
        XCTAssertEqual(decoded.eventCreatedAt, 1_721_600_000)
        XCTAssertEqual(decoded.contacts.map(\.publicKey), [aliceKey, bobKey])
        XCTAssertEqual(decoded.contacts.map(\.petname), ["Alice", "Bob"])
        XCTAssertEqual(decoded.contacts.first?.relayURLs, ["wss://relay.example"])
        XCTAssertEqual(decoded.extraTags, [["title", "Private teammates"]])
    }

    func testNIP51DecoderHandlesPWADoubleBlankPetnameShape() throws {
        let identity = try NostrIdentity(privateKey: Data(hex: privateKeyHex))
        let items: [[String]] = [["p", aliceKey, "", "", "Alice"]]
        let plaintext = try JSONSerialization.data(withJSONObject: items)
        let content = try NIP44V2.encrypt(
            plaintext,
            privateKey: identity.privateKey,
            publicKey: identity.publicKey,
            nonce: Data(repeating: 7, count: 32)
        )
        let event = try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: 100,
            kind: NIP51ContactListContract.eventKind,
            tags: [["d", NIP51ContactListContract.eventDTag]],
            content: content
        )

        let decoded = try NIP51ContactListContract.decode(event: event, identity: identity)
        XCTAssertEqual(decoded.contacts.first?.petname, "Alice")
    }

    func testNIP51RejectsWrongOwnerOrListName() throws {
        let identity = try NostrIdentity(privateKey: Data(hex: privateKeyHex))
        let contact = try XCTUnwrap(NostrContact(publicKeyValue: aliceKey))
        let event = try NIP51ContactListContract.event(
            contacts: [contact],
            identity: identity,
            createdAt: 100,
            nonce: Data(repeating: 3, count: 32)
        )

        var wrongTag = event
        wrongTag.tags = [["d", "Other"]]
        XCTAssertThrowsError(try NIP51ContactListContract.decode(event: wrongTag, identity: identity))

        let otherIdentity = try NostrIdentity(privateKey: Data(hex: String(repeating: "0", count: 63) + "2"))
        XCTAssertThrowsError(try NIP51ContactListContract.decode(event: event, identity: otherIdentity))
    }

    func testProfileParsingUsesSignedKindZeroMetadata() throws {
        let identity = try NostrIdentity(privateKey: Data(hex: privateKeyHex))
        let event = try NostrEvent.signed(
            privateKey: identity.privateKey,
            createdAt: 250,
            kind: 0,
            tags: [],
            content: #"{"name":"alice","display_name":"Alice Example","about":"Builds things","picture":"https://example.com/a.jpg","nip05":"alice@example.com","lud16":"alice@example.com"}"#
        )

        let profile = try XCTUnwrap(NostrContactProfile.decode(event: event))
        XCTAssertEqual(profile.displayName, "Alice Example")
        XCTAssertEqual(profile.nip05, "alice@example.com")
        XCTAssertEqual(profile.eventCreatedAt, 250)
    }

    func testSnapshotAppliesOnlyNewestListAndPreservesProfileCache() throws {
        let profile = NostrContactProfile(displayName: "Alice Profile", eventCreatedAt: 50)
        let cached = try XCTUnwrap(NostrContact(
            publicKeyValue: aliceKey,
            petname: "Old petname",
            profile: profile
        ))
        var snapshot = TaskifySnapshot(
            boards: [Board.week()],
            tasks: [],
            selectedBoardID: "week-default",
            contacts: [cached],
            contactsListUpdatedAt: 100
        )
        let incoming = try XCTUnwrap(NostrContact(
            publicKeyValue: aliceKey,
            relayURLs: ["wss://relay.example"],
            petname: "New petname"
        ))

        XCTAssertFalse(snapshot.replaceContacts(from: NIP51ContactList(
            contacts: [],
            eventCreatedAt: 99
        )))
        XCTAssertTrue(snapshot.replaceContacts(from: NIP51ContactList(
            contacts: [incoming],
            eventCreatedAt: 101
        )))
        XCTAssertEqual(snapshot.contactDirectory.first?.petname, "New petname")
        XCTAssertEqual(snapshot.contactDirectory.first?.profile, profile)
    }

    func testSnapshotContactMutationDeduplicatesAndDeletes() throws {
        var snapshot = TaskifySnapshot.empty
        XCTAssertNotNil(snapshot.upsertContact(
            publicKeyValue: aliceKey,
            relayURLs: ["wss://one.example"],
            petname: "Alice",
            updatedAt: 10
        ))
        XCTAssertNotNil(snapshot.upsertContact(
            publicKeyValue: aliceKey,
            relayURLs: ["wss://two.example"],
            petname: "Ali",
            updatedAt: 11
        ))
        XCTAssertEqual(snapshot.contactDirectory.count, 1)
        XCTAssertEqual(snapshot.contactDirectory.first?.petname, "Ali")
        XCTAssertEqual(snapshot.contactDirectory.first?.relayURLs, ["wss://two.example"])
        XCTAssertTrue(snapshot.removeContact(publicKeyValue: aliceKey, updatedAt: 12))
        XCTAssertTrue(snapshot.contactDirectory.isEmpty)
        XCTAssertEqual(snapshot.contactsListUpdatedAt, 12)
    }

    func testLegacySnapshotWithoutContactsStillDecodes() throws {
        let current = TaskifySnapshot.empty
        let data = try JSONEncoder().encode(current)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "contacts")
        object.removeValue(forKey: "contactsListUpdatedAt")
        object.removeValue(forKey: "contactsListExtraTags")

        let legacy = try JSONDecoder().decode(
            TaskifySnapshot.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
        XCTAssertTrue(legacy.contactDirectory.isEmpty)
    }
}
