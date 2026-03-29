import Foundation

public struct GeneratedBackup: Equatable, Sendable {
    public let nsec: String

    public init(nsec: String) {
        self.nsec = nsec
    }
}

public enum FirstRunOnboardingPage: String, Equatable, Sendable {
    case home
    case signIn
    case create
    case restore
    case notifications
}

public enum FirstRunRestoreBusyState: String, Equatable, Sendable {
    case file
    case cloud
}

public enum FirstRunOnboardingStore {
    public static let completionKey = "taskify_onboarding_done_v1"

    public static func isCompleted(userDefaults: UserDefaults = .standard) -> Bool {
        userDefaults.string(forKey: completionKey) == "done"
    }

    public static func markCompleted(userDefaults: UserDefaults = .standard) {
        userDefaults.set("done", forKey: completionKey)
    }

    public static func reset(userDefaults: UserDefaults = .standard) {
        userDefaults.removeObject(forKey: completionKey)
    }
}

public enum FirstRunOnboardingGate {
    public static func needsKeySelection(secretKeyHex: String?) -> Bool {
        let trimmed = (secretKeyHex ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        return trimmed.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) == nil
    }

    public static func shouldShowFirstRunOnboarding(secretKeyHex: String?, onboardingDone: Bool) -> Bool {
        if !needsKeySelection(secretKeyHex: secretKeyHex) {
            return false
        }
        return !onboardingDone
    }
}

@MainActor
public final class FirstRunOnboardingViewModel: ObservableObject {
    @Published public private(set) var page: FirstRunOnboardingPage
    @Published public var existingKeyInput: String
    @Published public private(set) var createdNsec: String
    @Published public var cloudRestoreInput: String
    @Published public private(set) var signInError: String?
    @Published public private(set) var createError: String?
    @Published public private(set) var restoreError: String?
    @Published public private(set) var restoreBusy: FirstRunRestoreBusyState?
    @Published public private(set) var createMessage: String?
    @Published public private(set) var notificationBusy: Bool
    @Published public private(set) var notificationError: String?

    private let onUseExistingKey: (String) -> Bool
    private let onGenerateNewKey: () -> GeneratedBackup?
    private let onRestoreFromBackupFile: (Data) async throws -> Void
    private let onRestoreFromCloud: (String) async throws -> Void
    private let onEnableNotifications: () async throws -> Void
    private let onComplete: () -> Void

    public init(
        onUseExistingKey: @escaping (String) -> Bool,
        onGenerateNewKey: @escaping () -> GeneratedBackup?,
        onRestoreFromBackupFile: @escaping (Data) async throws -> Void,
        onRestoreFromCloud: @escaping (String) async throws -> Void,
        onEnableNotifications: @escaping () async throws -> Void,
        onComplete: @escaping () -> Void
    ) {
        self.page = .home
        self.existingKeyInput = ""
        self.createdNsec = ""
        self.cloudRestoreInput = ""
        self.signInError = nil
        self.createError = nil
        self.restoreError = nil
        self.restoreBusy = nil
        self.createMessage = nil
        self.notificationBusy = false
        self.notificationError = nil
        self.onUseExistingKey = onUseExistingKey
        self.onGenerateNewKey = onGenerateNewKey
        self.onRestoreFromBackupFile = onRestoreFromBackupFile
        self.onRestoreFromCloud = onRestoreFromCloud
        self.onEnableNotifications = onEnableNotifications
        self.onComplete = onComplete
    }

    public func goHome() {
        page = .home
        signInError = nil
        createError = nil
        restoreError = nil
        createMessage = nil
        notificationError = nil
    }

    public func openSignIn() {
        signInError = nil
        page = .signIn
    }

    public func openRestore() {
        restoreError = nil
        page = .restore
    }

    public func openCreate() {
        createError = nil
        createMessage = nil
        if createdNsec.isEmpty {
            guard let generated = onGenerateNewKey() else {
                createError = "Unable to generate a key right now. Try again."
                page = .create
                return
            }
            createdNsec = generated.nsec
        }
        page = .create
    }

    @discardableResult
    public func submitExistingKey() -> Bool {
        signInError = nil
        let trimmed = existingKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            signInError = "Enter your nsec first."
            return false
        }
        let accepted = onUseExistingKey(trimmed)
        guard accepted else {
            signInError = "That nsec looks invalid. Paste a valid nsec or 64-character secret key."
            return false
        }
        page = .notifications
        return true
    }

    public func continueFromCreatedLogin() {
        guard !createdNsec.isEmpty else { return }
        page = .notifications
    }

    public func noteCopiedNsec() {
        createMessage = "nsec copied"
    }

    public func noteSavedNsecFile() {
        createMessage = "nsec file saved"
    }

    public func noteUnableToCopyNsec() {
        createMessage = "Unable to copy nsec on this device"
    }

    public func noteUnableToSaveNsecFile() {
        createMessage = "Unable to save key file on this device"
    }

    public func restoreFromBackupFile(data: Data) async {
        restoreError = nil
        restoreBusy = .file
        defer { restoreBusy = nil }

        do {
            try await onRestoreFromBackupFile(data)
        } catch {
            restoreError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if restoreError?.isEmpty != false {
                restoreError = "Unable to restore backup file."
            }
        }
    }

    public func restoreFromCloud() async {
        guard restoreBusy == nil else { return }

        restoreError = nil
        restoreBusy = .cloud
        defer { restoreBusy = nil }

        do {
            try await onRestoreFromCloud(cloudRestoreInput)
        } catch {
            restoreError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if restoreError?.isEmpty != false {
                restoreError = "Unable to restore cloud backup."
            }
        }
    }

    public func completeOnboarding() {
        onComplete()
    }

    public func enableNotifications(pushSupported: Bool, pushConfigured: Bool) async {
        if !pushSupported || !pushConfigured {
            onComplete()
            return
        }

        notificationBusy = true
        notificationError = nil
        defer { notificationBusy = false }

        do {
            try await onEnableNotifications()
            onComplete()
        } catch {
            notificationError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if notificationError?.isEmpty != false {
                notificationError = "Unable to enable notifications."
            }
        }
    }
}
