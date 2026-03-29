import Foundation
import Testing
@testable import TaskifyCore

@Suite("ContactSyncContracts")
struct ContactSyncContractTests {

    @Test("builds NIP-51 private tags with relay hints and petnames")
    func buildPrivateItems() {
        let contacts = [
            TaskifyContactRecord(
                id: "1",
                kind: .nostr,
                name: "Alice",
                address: "",
                paymentRequest: "",
                npub: "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d",
                relays: ["wss://relay.one"],
                createdAt: 1,
                updatedAt: 1
            ),
            TaskifyContactRecord(
                id: "2",
                kind: .nostr,
                name: "",
                address: "",
                paymentRequest: "",
                npub: "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d",
                displayName: "Duplicate",
                relays: ["wss://relay.two"],
                createdAt: 1,
                updatedAt: 1
            ),
        ]

        let items = buildNip51PrivateItems(contacts)
        #expect(items.count == 1)
        #expect(items[0] == [
            "p",
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "wss://relay.one",
            "Alice",
        ])
    }

    @Test("extracts public follows from kind 3 tags")
    func extractPublicFollowTags() {
        let follows = extractPublicFollows(from: [
            ["p", "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "wss://relay.one", "Alice"],
            ["p", "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "wss://relay.two", "Dup"],
        ])
        #expect(follows.count == 1)
        #expect(follows.first?.relay == "wss://relay.one")
        #expect(follows.first?.petname == "Alice")
    }

    @Test("contact fingerprints are stable for equivalent relay ordering")
    func stableFingerprint() {
        let first = TaskifyContactRecord(
            id: "1",
            kind: .nostr,
            name: "Alice",
            address: "alice@getalby.com",
            paymentRequest: "",
            npub: "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d",
            relays: ["wss://relay.two", "wss://relay.one"],
            createdAt: 1,
            updatedAt: 1
        )
        let second = TaskifyContactRecord(
            id: "1",
            kind: .nostr,
            name: "Alice",
            address: "alice@getalby.com",
            paymentRequest: "",
            npub: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            relays: ["wss://relay.one", "wss://relay.two"],
            createdAt: 1,
            updatedAt: 1
        )

        #expect(computeContactsFingerprint([first]) == computeContactsFingerprint([second]))
    }
}
