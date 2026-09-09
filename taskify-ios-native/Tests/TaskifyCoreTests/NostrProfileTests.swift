import Foundation
import XCTest
@testable import TaskifyCore

final class NostrProfileTests: XCTestCase {
    private let privateKeyHex = String(repeating: "0", count: 63) + "1"

    private func identity() throws -> NostrIdentity {
        try NostrIdentity(privateKey: try Data(hex: privateKeyHex))
    }

    func testProfileEventRoundTripsThroughProfileDecode() throws {
        let identity = try identity()
        let draft = NostrProfileDraft(
            username: "nathan",
            displayName: "Nathan Hughes",
            about: "Building Taskify",
            picture: "https://example.com/pic.jpg",
            lud16: "nathan@solife.me",
            nip05: "nathan@solife.me"
        )
        let event = try NostrProfileContract.event(
            draft: draft,
            previousContent: nil,
            identity: identity,
            createdAt: 1_700_000_000
        )

        XCTAssertTrue(event.verify())
        XCTAssertEqual(event.kind, NostrProfileContract.eventKind)
        XCTAssertEqual(event.tags, [])
        XCTAssertEqual(event.publicKey, identity.publicKeyHex)

        let decoded = try XCTUnwrap(NostrContactProfile.decode(event: event))
        // The draft's username publishes as the Nostr `name` attribute, which decodes back
        // into `name` (used by `NostrContact.displayName`).
        XCTAssertEqual(decoded.name, "nathan")
        XCTAssertEqual(decoded.username, nil)
        XCTAssertEqual(decoded.displayName, "Nathan Hughes")
        XCTAssertEqual(decoded.about, "Building Taskify")
        XCTAssertEqual(decoded.picture, "https://example.com/pic.jpg")
        XCTAssertEqual(decoded.lud16, "nathan@solife.me")
        XCTAssertEqual(decoded.nip05, "nathan@solife.me")
        XCTAssertEqual(decoded.eventCreatedAt, 1_700_000_000)
    }

    func testProfileEventContentMatchesPWAShape() throws {
        let draft = NostrProfileDraft(
            username: "nathan",
            displayName: "Nathan",
            picture: "https://example.com/a.jpg",
            lud16: "nathan@solife.me"
        )
        let content = try NostrProfileContract.contentJSON(previousContent: nil, draft: draft)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any])
        // Keys the PWA's `buildProfileContent` writes and its `parseProfileContent` reads back.
        XCTAssertEqual(object["name"] as? String, "nathan")
        XCTAssertEqual(object["display_name"] as? String, "Nathan")
        XCTAssertEqual(object["picture"] as? String, "https://example.com/a.jpg")
        XCTAssertEqual(object["lud16"] as? String, "nathan@solife.me")
        XCTAssertEqual(object["lightning_address"] as? String, "nathan@solife.me")
        XCTAssertNil(object["about"])
    }

    func testProfileEventPreservesUnknownKeysAndRemovesClearedFields() throws {
        let previous = #"{"name":"old","banner":"https://example.com/b.jpg","lud16":"old@x.dev"}"#
        let draft = NostrProfileDraft(displayName: "New", about: "New about")
        let content = try NostrProfileContract.contentJSON(previousContent: previous, draft: draft)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any])
        // Unknown keys from other clients survive; fields the draft cleared are removed —
        // under every spelling they might have been written as.
        XCTAssertNil(object["name"])
        XCTAssertEqual(object["banner"] as? String, "https://example.com/b.jpg")
        XCTAssertEqual(object["display_name"] as? String, "New")
        XCTAssertEqual(object["about"] as? String, "New about")
        XCTAssertNil(object["lud16"])
        XCTAssertNil(object["lightning_address"])
    }

    func testEditingAndClearingProfileRemovesStaleAliases() throws {
        let previous = #"{"name":"old","username":"stale","displayName":"Old","image":"https://example.com/old.jpg","avatar":"https://example.com/older.jpg"}"#
        let updated = try NostrProfileContract.contentJSON(
            previousContent: previous,
            draft: NostrProfileDraft(username: "new", displayName: "New", picture: "https://example.com/new.jpg")
        )
        let decoded = try XCTUnwrap(NostrContactProfile.decode(content: updated))
        XCTAssertEqual(NostrProfileDraft(profile: decoded).username, "new")
        let cleared = try NostrProfileContract.contentJSON(previousContent: updated, draft: NostrProfileDraft())
        let clearedProfile = try XCTUnwrap(NostrContactProfile.decode(content: cleared))
        XCTAssertNil(clearedProfile.name)
        XCTAssertNil(clearedProfile.username)
        XCTAssertNil(clearedProfile.displayName)
        XCTAssertNil(clearedProfile.picture)
    }

    func testProfileDraftSeedsUsernameFromNameAttribute() {
        let profile = NostrContactProfile(
            name: "oldname",
            displayName: "Old",
            username: nil,
            about: nil,
            picture: nil,
            lud16: nil,
            nip05: nil,
            eventCreatedAt: 1
        )
        // A profile with only `name` must re-publish its name, not silently drop it.
        XCTAssertEqual(NostrProfileDraft(profile: profile).username, "oldname")
    }

    func testDeletionEventTargetsPreviousProfile() throws {
        let identity = try identity()
        let previousID = String(repeating: "a", count: 64)
        let event = try NostrProfileContract.deletionEvent(
            previousEventID: previousID,
            identity: identity,
            createdAt: 1_700_000_001
        )
        XCTAssertTrue(event.verify())
        XCTAssertEqual(event.kind, NostrProfileContract.deletionEventKind)
        XCTAssertEqual(event.firstTagValue(named: "e"), previousID)
        XCTAssertEqual(event.firstTagValue(named: "k"), "0")
        XCTAssertEqual(event.content, "")
    }

    func testDecodeNprofileExtractsKeyAndRelayHints() throws {
        let key = try identity().publicKey
        let relays = ["wss://relay.example.com", "wss://other.example.org"]
        var payload = Data([0, UInt8(key.count)])
        payload.append(key)
        for relay in relays {
            let bytes = Data(relay.utf8)
            payload.append(1)
            payload.append(UInt8(bytes.count))
            payload.append(bytes)
        }
        let nprofile = try Bech32.encode(prefix: "nprofile", data: payload)

        let decoded = try XCTUnwrap(NostrProfilePayload.decodeNprofile(nprofile))
        XCTAssertEqual(decoded.publicKey, key)
        XCTAssertEqual(decoded.relayURLs, relays)
        XCTAssertNil(NostrProfilePayload.decodeNprofile("nprofile1invalid"))
    }

    func testDecodeContactSharePayload() throws {
        let npub = try Bech32.encode(prefix: "npub", data: identity().publicKey)
        let payload: [String: Any] = [
            "v": 1,
            "kind": "nostr",
            "npub": npub,
            "relays": ["wss://relay.example.com"],
            "displayName": "Nathan",
            "lud16": "nathan@solife.me",
        ]
        let json = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
        let encoded = Data(json.utf8).base64EncodedString()

        let decoded = try XCTUnwrap(ContactSharePayload.decode("taskify:contact:\(encoded)"))
        XCTAssertEqual(decoded.npub, npub)
        XCTAssertEqual(decoded.relays, ["wss://relay.example.com"])
        XCTAssertEqual(decoded.displayName, "Nathan")
        XCTAssertEqual(decoded.lud16, "nathan@solife.me")
    }

    func testDecodeContactSharePayloadRejectsInvalidValues() {
        XCTAssertNil(ContactSharePayload.decode("https://example.com"))
        XCTAssertNil(ContactSharePayload.decode("taskify:contact:not-base64!!"))
        let emptyObject = Data("{}".utf8).base64EncodedString()
        XCTAssertNil(ContactSharePayload.decode("taskify:contact:\(emptyObject)"))
    }
}