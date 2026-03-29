import Foundation
import Security
import TaskifyCore

@MainActor
final class AppAuthViewModel: ObservableObject {
    @Published var state: AuthState = .importing
    @Published private(set) var hasBootstrapped = false

    private let manager = AuthSessionManager(
        loadActiveProfile: { try KeychainStore.loadActiveProfile() },
        saveProfile: { profile in try KeychainStore.saveProfile(profile) },
        importIdentity: { input in try NostrIdentityService.importIdentity(secretKeyInput: input) },
        clearActiveProfile: { try KeychainStore.clearActiveProfile() }
    )

    lazy var signInViewModel: SignInViewModel = {
        SignInViewModel { [weak self] secretKeyInput, profileName in
            guard let self else { return .error("Unable to sign in. Please check your private key.") }
            return self.signIn(secretKeyInput: secretKeyInput, profileName: profileName)
        }
    }()

    var activeProfile: TaskifyProfile? {
        guard case .signedIn(let profile) = state else { return nil }
        return profile
    }

    func bootstrap() async {
        guard !hasBootstrapped else { return }
        manager.bootstrap()
        state = manager.state
        hasBootstrapped = true
    }

    @discardableResult
    func signIn(
        secretKeyInput: String,
        profileName: String = "",
        relays: [String]? = nil
    ) -> AuthState {
        manager.signIn(
            secretKeyInput: secretKeyInput,
            profileName: profileName,
            relays: relays ?? AuthSessionManager.defaultRelayPreset
        )
        state = manager.state
        return manager.state
    }

    func useExistingOnboardingKey(_ value: String) -> Bool {
        switch signIn(secretKeyInput: value) {
        case .signedIn:
            return true
        default:
            return false
        }
    }

    func generateOnboardingLogin() -> GeneratedBackup? {
        let secretKeyHex = Self.generateSecretKeyHex()

        do {
            let nsec = try NostrIdentityService.deriveNsec(fromSecretKeyHex: secretKeyHex)
            switch signIn(secretKeyInput: secretKeyHex) {
            case .signedIn:
                return GeneratedBackup(nsec: nsec)
            default:
                return nil
            }
        } catch {
            state = .error("Unable to generate a key right now. Try again.")
            return nil
        }
    }

    func restoreFromBackup(data: Data, settingsManager: SettingsManager) throws {
        let payload = try TaskifyBackupRestoreParser.parse(data: data)
        let nextState = signIn(
            secretKeyInput: payload.secretKeyInput,
            relays: payload.relays.isEmpty ? AuthSessionManager.defaultRelayPreset : payload.relays
        )

        switch nextState {
        case .signedIn:
            if let settings = payload.settings {
                settingsManager.settings = settings
            }
            settingsManager.saveNow()
        case .error(let message):
            throw AppAuthError(message: message)
        default:
            throw AppAuthError(message: "Unable to restore backup file.")
        }
    }

    func signOut() {
        manager.signOut()
        state = manager.state
        signInViewModel.reset()
    }

    private static func generateSecretKeyHex() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().padding(
                toLength: 64,
                withPad: "0",
                startingAt: 0
            )
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

private struct AppAuthError: LocalizedError {
    let message: String

    var errorDescription: String? { message }
}
