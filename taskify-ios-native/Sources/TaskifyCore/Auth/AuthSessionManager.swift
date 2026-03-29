import Foundation

public enum AuthState: Equatable {
    case signedOut
    case importing
    case signedIn(TaskifyProfile)
    case error(String)
}

@MainActor
public final class AuthSessionManager {
    public private(set) var state: AuthState = .signedOut

    public static let defaultRelayPreset = ["wss://relay.damus.io", "wss://relay.snort.social"]

    private let loadActiveProfileFn: () throws -> TaskifyProfile?
    private let saveProfileFn: (TaskifyProfile) throws -> Void
    private let importIdentityFn: (String) throws -> NostrIdentity
    private let clearActiveProfileFn: () throws -> Void

    public init(
        loadActiveProfile: @escaping () throws -> TaskifyProfile?,
        saveProfile: @escaping (TaskifyProfile) throws -> Void,
        importIdentity: @escaping (String) throws -> NostrIdentity,
        clearActiveProfile: @escaping () throws -> Void = {}
    ) {
        self.loadActiveProfileFn = loadActiveProfile
        self.saveProfileFn = saveProfile
        self.importIdentityFn = importIdentity
        self.clearActiveProfileFn = clearActiveProfile
    }

    public func bootstrap() {
        do {
            if let profile = try loadActiveProfileFn() {
                state = .signedIn(profile)
            } else {
                state = .signedOut
            }
        } catch {
            state = .error("Unable to load profile.")
        }
    }

    public func signIn(secretKeyInput: String, profileName: String, relays: [String]) {
        state = .importing
        do {
            let identity = try importIdentityFn(secretKeyInput)
            let trimmedName = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
            let selectedRelays = relays.isEmpty ? Self.defaultRelayPreset : relays
            let profile = TaskifyProfile(
                name: trimmedName.isEmpty ? "Default" : trimmedName,
                nsecHex: identity.nsecHex,
                npub: identity.npub,
                relays: selectedRelays,
                boards: []
            )
            try saveProfileFn(profile)
            state = .signedIn(profile)
        } catch let e as NostrIdentityService.IdentityError {
            switch e {
            case .invalidSecretKey, .invalidNsec:
                state = .error("Enter a valid nsec or 64-hex private key.")
            case .invalidPrivateKey, .invalidNpub, .invalidPublicKey:
                state = .error("Unable to derive npub from the provided key.")
            }
        } catch {
            state = .error("Unable to sign in. Please check your private key.")
        }
    }

    public func signOut() {
        do {
            try clearActiveProfileFn()
            state = .signedOut
        } catch {
            state = .error("Unable to sign out.")
        }
    }
}
