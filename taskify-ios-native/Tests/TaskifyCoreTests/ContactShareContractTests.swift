import Foundation
import Testing
@testable import TaskifyCore

@Suite("ContactShareContract")
struct ContactShareContractTests {

    @Test("builds and parses PWA-compatible contact share envelopes")
    func envelopeRoundTrip() throws {
        let contact = TaskifyContactRecord(
            id: "c1",
            kind: .nostr,
            name: "Alice",
            address: "alice@getalby.com",
            paymentRequest: "",
            npub: "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d",
            username: "alice",
            displayName: "Alice Example",
            nip05: "alice@example.com",
            about: "Ignored by envelope builder",
            picture: "https://example.com/pic.png",
            relays: [" wss://relay.one ", "wss://relay.one", "wss://relay.two"],
            createdAt: 1,
            updatedAt: 1,
            source: .manual
        )

        let raw = ContactShareContract.buildEnvelopeString(
            contact: contact,
            sender: (npub: "npub1sender", name: "Nathan")
        )

        #expect(raw != nil)
        let parsed = ContactShareContract.parseEnvelope(raw ?? "")
        #expect(parsed?.npub == contact.npub)
        #expect(parsed?.name == "Alice")
        #expect(parsed?.displayName == "Alice Example")
        #expect(parsed?.username == "alice")
        #expect(parsed?.nip05 == "alice@example.com")
        #expect(parsed?.lud16 == "alice@getalby.com")
        #expect(parsed?.relays == ["wss://relay.one", "wss://relay.two"])
        #expect(parsed?.senderNpub == "npub1sender")
        #expect(parsed?.senderName == "Nathan")
    }

    @Test("nostr contacts use npub for qr values")
    func nostrQrValue() {
        let contact = TaskifyContactRecord(
            id: "c1",
            kind: .nostr,
            name: "Alice",
            address: "",
            paymentRequest: "",
            npub: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            relays: [],
            createdAt: 1,
            updatedAt: 1
        )

        let value = ContactShareContract.buildQRValue(contact: contact)
        #expect(value == "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d")
    }

    @Test("custom qr payload round-trips")
    func customQrRoundTrip() {
        let contact = TaskifyContactRecord(
            id: "c1",
            kind: .custom,
            name: "Pay Me",
            address: "pm@getalby.com",
            paymentRequest: "",
            npub: "",
            displayName: "Payment Contact",
            nip05: "pay@example.com",
            picture: "https://example.com/contact.png",
            relays: ["wss://relay.one"],
            createdAt: 1,
            updatedAt: 1
        )

        let value = ContactShareContract.buildQRValue(contact: contact)
        let parsed = ContactShareContract.parseQRValue(value ?? "")
        #expect(parsed?.kind == .custom)
        #expect(parsed?.name == "Pay Me")
        #expect(parsed?.displayName == "Payment Contact")
        #expect(parsed?.address == "pm@getalby.com")
        #expect(parsed?.nip05 == "pay@example.com")
        #expect(parsed?.picture == "https://example.com/contact.png")
        #expect(parsed?.relays == ["wss://relay.one"])
    }
}
