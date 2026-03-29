import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("ContactsViewModel")
struct ContactsViewModelTests {

    @Test("sets empty and ready states from contact payloads")
    func states() {
        let vm = ContactsViewModel()
        vm.setContacts([])
        #expect(vm.state == .empty)

        vm.setContacts([
            TaskifyContactRecord(
                id: "1",
                kind: .custom,
                name: "Alice",
                address: "",
                paymentRequest: "",
                npub: "",
                createdAt: 1,
                updatedAt: 1
            )
        ])
        #expect(vm.state == .ready)
    }

    @Test("filters contacts by multiple fields")
    func filtersContacts() {
        let vm = ContactsViewModel()
        vm.setContacts([
            TaskifyContactRecord(
                id: "1",
                kind: .nostr,
                name: "Alice",
                address: "alice@getalby.com",
                paymentRequest: "",
                npub: "npub1alice",
                username: "alice",
                displayName: "Alice Example",
                createdAt: 1,
                updatedAt: 1
            ),
            TaskifyContactRecord(
                id: "2",
                kind: .custom,
                name: "Bob",
                address: "",
                paymentRequest: "",
                npub: "",
                createdAt: 1,
                updatedAt: 1
            ),
        ])

        #expect(vm.filteredContacts(searchText: "getalby").map(\.id) == ["1"])
        #expect(vm.filteredContacts(searchText: "bob").map(\.id) == ["2"])
    }

    @Test("verified NIP-05 subtitles take precedence for nostr contacts")
    func prefersVerifiedNip05Subtitle() {
        let vm = ContactsViewModel()
        let contact = TaskifyContactRecord(
            id: "alice",
            kind: .nostr,
            name: "Alice",
            address: "alice@getalby.com",
            paymentRequest: "",
            npub: "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d",
            nip05: "alice@example.com",
            createdAt: 1,
            updatedAt: 50
        )
        vm.setContacts([contact])
        vm.setNip05Checks([
            "alice": Nip05CheckState(
                status: .valid,
                nip05: "alice@example.com",
                npub: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                checkedAt: 100,
                contactUpdatedAt: 50
            )
        ])

        let subtitle = vm.subtitle(for: contact)
        #expect(subtitle?.text == "alice@example.com")
        #expect(subtitle?.verified == true)
        #expect(vm.fields(for: contact).first(where: { $0.key == "nip05" })?.verified == true)
    }

    @Test("profile subtitles still prefer lightning over nip05")
    func profileSubtitlePrefersLightning() {
        let vm = ContactsViewModel()
        let profile = TaskifyContactRecord(
            id: "profile",
            kind: .nostr,
            name: "Nathan",
            address: "nathan@getalby.com",
            paymentRequest: "",
            npub: "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d",
            nip05: "nathan@example.com",
            createdAt: 1,
            updatedAt: 1,
            source: .profile
        )

        let subtitle = vm.subtitle(for: profile, isProfile: true)
        #expect(subtitle?.text == "nathan@getalby.com")
        #expect(subtitle?.verified == false)
    }

    @Test("follow state uses normalized public follow hex keys")
    func followsMatchNormalizedPubkeys() {
        let vm = ContactsViewModel()
        let contact = TaskifyContactRecord(
            id: "alice",
            kind: .nostr,
            name: "Alice",
            address: "",
            paymentRequest: "",
            npub: "npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d",
            createdAt: 1,
            updatedAt: 1
        )
        vm.setPublicFollows([
            TaskifyPublicFollowRecord(pubkey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
        ])

        #expect(vm.isFollowed(contact) == true)
        #expect(vm.canFollow(contact) == true)
    }
}
