import Foundation
import Testing
@testable import TaskifyCore

private final class InMemorySecureStore: SecureStore {
    var values: [String: Data] = [:]

    func set(_ data: Data, key: String) throws {
        values[key] = data
    }

    func get(key: String) throws -> Data? {
        values[key]
    }

    func delete(key: String) throws {
        values.removeValue(forKey: key)
    }
}

@Suite("ProfileIdentityStore")
struct ProfileIdentityStoreTests {

    @Test("saveProfile persists active profile and profile names")
    func saveProfilePersistsActiveAndNames() throws {
        let secure = InMemorySecureStore()
        let store = ProfileIdentityStore(secureStore: secure)

        let profile = TaskifyProfile(
            name: "Nathan",
            nsecHex: String(repeating: "a", count: 64),
            npub: "npub1test",
            relays: ["wss://relay.damus.io"],
            boards: []
        )

        try store.saveProfile(profile)

        let active = try store.loadActiveProfile()
        #expect(active?.name == "Nathan")

        let names = try store.allProfileNames()
        #expect(names == ["Nathan"])
    }

    @Test("saving second profile appends unique names")
    func saveSecondProfileAppendsName() throws {
        let secure = InMemorySecureStore()
        let store = ProfileIdentityStore(secureStore: secure)

        let p1 = TaskifyProfile(name: "Nathan", nsecHex: String(repeating: "a", count: 64), npub: "npub1a", relays: [], boards: [])
        let p2 = TaskifyProfile(name: "Ink", nsecHex: String(repeating: "b", count: 64), npub: "npub1b", relays: [], boards: [])

        try store.saveProfile(p1)
        try store.saveProfile(p2)

        let names = try store.allProfileNames().sorted()
        #expect(names == ["Ink", "Nathan"])
        #expect(try store.loadActiveProfile()?.name == "Ink")
    }

    @Test("deleteProfile removes profile and updates names")
    func deleteProfileRemovesName() throws {
        let secure = InMemorySecureStore()
        let store = ProfileIdentityStore(secureStore: secure)

        let p1 = TaskifyProfile(name: "Nathan", nsecHex: String(repeating: "a", count: 64), npub: "npub1a", relays: [], boards: [])
        let p2 = TaskifyProfile(name: "Ink", nsecHex: String(repeating: "b", count: 64), npub: "npub1b", relays: [], boards: [])

        try store.saveProfile(p1)
        try store.saveProfile(p2)

        try store.deleteProfile(name: "Nathan")
        let names = try store.allProfileNames()
        #expect(names == ["Ink"])
    }

    @Test("saveProfile filters ATS-blocked relays")
    func saveProfileFiltersBlockedRelays() throws {
        let secure = InMemorySecureStore()
        let store = ProfileIdentityStore(secureStore: secure)

        let profile = TaskifyProfile(
            name: "Nathan",
            nsecHex: String(repeating: "a", count: 64),
            npub: "npub1test",
            relays: ["wss://relay.damus.io", "wss://relay.primal.net"],
            boards: []
        )

        try store.saveProfile(profile)

        let active = try store.loadActiveProfile()
        #expect(active?.relays == ["wss://relay.damus.io"])
    }
}
