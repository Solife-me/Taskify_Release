import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("AuthSessionManager")
struct AuthSessionManagerTests {

    @Test("bootstrap starts signed out when no active profile")
    func bootstrapSignedOut() async throws {
        let manager = AuthSessionManager(
            loadActiveProfile: { nil },
            saveProfile: { _ in },
            importIdentity: { _ in fatalError("not used") }
        )

        await manager.bootstrap()
        #expect(await manager.state == .signedOut)
    }

    @Test("bootstrap starts signed in when active profile exists")
    func bootstrapSignedIn() async throws {
        let profile = TaskifyProfile(name: "Nathan", nsecHex: String(repeating: "a", count: 64), npub: "npub1x", relays: [], boards: [])
        let manager = AuthSessionManager(
            loadActiveProfile: { profile },
            saveProfile: { _ in },
            importIdentity: { _ in fatalError("not used") }
        )

        await manager.bootstrap()
        #expect(await manager.state == .signedIn(profile))
    }

    @Test("sign in transitions importing -> signed in and persists profile")
    func signInSuccess() async throws {
        var saved: TaskifyProfile?
        let manager = AuthSessionManager(
            loadActiveProfile: { nil },
            saveProfile: { profile in saved = profile },
            importIdentity: { _ in
                NostrIdentity(nsecHex: String(repeating: "1", count: 64), npub: "npub1abc")
            }
        )

        await manager.signIn(secretKeyInput: "nsec1...", profileName: "Nathan", relays: ["wss://relay.damus.io"])

        let state = await manager.state
        switch state {
        case .signedIn(let profile):
            #expect(profile.name == "Nathan")
            #expect(profile.npub == "npub1abc")
            #expect(saved?.name == "Nathan")
        default:
            Issue.record("Expected signedIn state")
        }
    }

    @Test("blank profile name defaults to Default")
    func signInBlankProfileDefaults() async throws {
        var saved: TaskifyProfile?
        let manager = AuthSessionManager(
            loadActiveProfile: { nil },
            saveProfile: { profile in saved = profile },
            importIdentity: { _ in NostrIdentity(nsecHex: String(repeating: "2", count: 64), npub: "npub1def") }
        )

        await manager.signIn(secretKeyInput: "nsec1...", profileName: "   ", relays: ["wss://relay.damus.io"])

        #expect(saved?.name == "Default")
    }

    @Test("empty relays fall back to default relay preset")
    func signInEmptyRelaysDefaults() async throws {
        var saved: TaskifyProfile?
        let manager = AuthSessionManager(
            loadActiveProfile: { nil },
            saveProfile: { profile in saved = profile },
            importIdentity: { _ in NostrIdentity(nsecHex: String(repeating: "3", count: 64), npub: "npub1ghi") }
        )

        await manager.signIn(secretKeyInput: "nsec1...", profileName: "Nathan", relays: [])

        #expect(saved?.relays == ["wss://relay.damus.io", "wss://relay.snort.social"])
    }

    @Test("invalid nsec/hex shows PWA-parity validation message")
    func signInInvalidKeyMessage() async throws {
        let manager = AuthSessionManager(
            loadActiveProfile: { nil },
            saveProfile: { _ in },
            importIdentity: { _ in throw NostrIdentityService.IdentityError.invalidSecretKey }
        )

        await manager.signIn(secretKeyInput: "bad", profileName: "Nathan", relays: [])

        let state = await manager.state
        switch state {
        case .error(let message):
            #expect(message == "Enter a valid nsec or 64-hex private key.")
        default:
            Issue.record("Expected error state")
        }
    }

    @Test("unexpected sign-in failure shows generic message")
    func signInFailureGeneric() async throws {
        enum DummyError: Error { case badKey }
        let manager = AuthSessionManager(
            loadActiveProfile: { nil },
            saveProfile: { _ in },
            importIdentity: { _ in throw DummyError.badKey }
        )

        await manager.signIn(secretKeyInput: "bad", profileName: "Nathan", relays: [])

        let state = await manager.state
        switch state {
        case .error(let message):
            #expect(message == "Unable to sign in. Please check your private key.")
        default:
            Issue.record("Expected error state")
        }
    }

    @Test("sign out always returns signed out")
    func signOut() async throws {
        var cleared = false
        let manager = AuthSessionManager(
            loadActiveProfile: {
                TaskifyProfile(name: "Nathan", nsecHex: String(repeating: "a", count: 64), npub: "npub1x", relays: [], boards: [])
            },
            saveProfile: { _ in },
            importIdentity: { _ in fatalError("not used") },
            clearActiveProfile: { cleared = true }
        )

        await manager.bootstrap()
        await manager.signOut()
        #expect(await manager.state == .signedOut)
        #expect(cleared == true)
    }
}
