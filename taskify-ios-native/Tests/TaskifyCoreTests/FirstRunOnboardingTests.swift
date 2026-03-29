import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("FirstRunOnboarding")
struct FirstRunOnboardingTests {
    private let validSecret = String(repeating: "a", count: 64)

    @Test("fresh install requires first-run onboarding")
    func freshInstallShowsOnboarding() {
        #expect(
            FirstRunOnboardingGate.shouldShowFirstRunOnboarding(
                secretKeyHex: nil,
                onboardingDone: false
            ) == true
        )
    }

    @Test("valid key suppresses first-run onboarding")
    func validKeySuppressesOnboarding() {
        #expect(
            FirstRunOnboardingGate.shouldShowFirstRunOnboarding(
                secretKeyHex: validSecret,
                onboardingDone: false
            ) == false
        )
    }

    @Test("done flag suppresses onboarding even without a key")
    func doneFlagSuppressesOnboarding() {
        #expect(
            FirstRunOnboardingGate.shouldShowFirstRunOnboarding(
                secretKeyHex: nil,
                onboardingDone: true
            ) == false
        )
    }

    @Test("existing key flow moves to notifications on success")
    func useExistingKeySuccess() {
        let viewModel = FirstRunOnboardingViewModel(
            onUseExistingKey: { $0 == "nsec1ok" },
            onGenerateNewKey: { nil },
            onRestoreFromBackupFile: { _ in },
            onRestoreFromCloud: { _ in },
            onEnableNotifications: {},
            onComplete: {}
        )
        viewModel.openSignIn()
        viewModel.existingKeyInput = "nsec1ok"

        let accepted = viewModel.submitExistingKey()

        #expect(accepted == true)
        #expect(viewModel.page == .notifications)
        #expect(viewModel.signInError == nil)
    }

    @Test("existing key flow shows parity validation message on failure")
    func useExistingKeyFailure() {
        let viewModel = FirstRunOnboardingViewModel(
            onUseExistingKey: { _ in false },
            onGenerateNewKey: { nil },
            onRestoreFromBackupFile: { _ in },
            onRestoreFromCloud: { _ in },
            onEnableNotifications: {},
            onComplete: {}
        )
        viewModel.openSignIn()
        viewModel.existingKeyInput = "bad"

        let accepted = viewModel.submitExistingKey()

        #expect(accepted == false)
        #expect(viewModel.page == .signIn)
        #expect(viewModel.signInError == "That nsec looks invalid. Paste a valid nsec or 64-character secret key.")
    }

    @Test("create flow generates nsec once and opens create page")
    func openCreateGeneratesKey() {
        var calls = 0
        let viewModel = FirstRunOnboardingViewModel(
            onUseExistingKey: { _ in false },
            onGenerateNewKey: {
                calls += 1
                return GeneratedBackup(nsec: "nsec1generated")
            },
            onRestoreFromBackupFile: { _ in },
            onRestoreFromCloud: { _ in },
            onEnableNotifications: {},
            onComplete: {}
        )

        viewModel.openCreate()
        viewModel.openCreate()

        #expect(calls == 1)
        #expect(viewModel.page == .create)
        #expect(viewModel.createdNsec == "nsec1generated")
    }

    @Test("notification step completes immediately when push is unavailable")
    func notificationsCompleteWhenPushUnavailable() async {
        var completed = 0
        var enableCalls = 0
        let viewModel = FirstRunOnboardingViewModel(
            onUseExistingKey: { _ in false },
            onGenerateNewKey: { nil },
            onRestoreFromBackupFile: { _ in },
            onRestoreFromCloud: { _ in },
            onEnableNotifications: { enableCalls += 1 },
            onComplete: { completed += 1 }
        )

        await viewModel.enableNotifications(pushSupported: false, pushConfigured: false)

        #expect(completed == 1)
        #expect(enableCalls == 0)
    }

    @Test("restore from backup file surfaces thrown error message")
    func restoreFromBackupFailure() async {
        enum DummyError: LocalizedError {
            case bad

            var errorDescription: String? { "Invalid backup file." }
        }

        let viewModel = FirstRunOnboardingViewModel(
            onUseExistingKey: { _ in false },
            onGenerateNewKey: { nil },
            onRestoreFromBackupFile: { _ in throw DummyError.bad },
            onRestoreFromCloud: { _ in },
            onEnableNotifications: {},
            onComplete: {}
        )

        await viewModel.restoreFromBackupFile(data: Data("{}".utf8))

        #expect(viewModel.restoreBusy == nil)
        #expect(viewModel.restoreError == "Invalid backup file.")
    }
}
