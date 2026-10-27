import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers
import UIKit

/// First-run onboarding, matching the PWA's `FirstRunOnboarding.tsx` since C2-5 (iOS: C9-5).
///
/// It starts with tasks, not keys: "Start using Taskify" keeps the identity the app already made
/// and opens the boards; the key is offered for saving later, once the user has something to lose
/// (`KeyBackupState`, shown by `KeyBackupBanner`). "I already use Taskify" replaces that identity
/// with the user's own key (`importIdentity`), which starts the usual account-sync search.
/// Notification permission is asked when the first reminder is set, not here.
struct FirstRunOnboardingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private enum Page {
        case home
        case signIn
    }

    @State private var page: Page = .home
    @State private var existingKeyInput = ""
    @State private var signInError: String?

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let showsPanel = geometry.size.width >= 600
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        if showsPanel {
                            VStack(spacing: 16) {
                                Image(systemName: "checklist")
                                    .font(.system(size: 44, weight: .medium))
                                    .foregroundStyle(TaskifyTheme.accent)
                                    .accessibilityHidden(true)
                                Text("Welcome to Taskify")
                                    .font(.largeTitle.bold())
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                    .multilineTextAlignment(.center)
                                    .accessibilityAddTraits(.isHeader)
                            }
                            .frame(maxWidth: .infinity)
                        }

                        switch page {
                        case .home: homePage
                        case .signIn: signInPage
                        }
                    }
                    .padding(showsPanel ? 32 : 0)
                    .frame(maxWidth: 540, alignment: .leading)
                    .background {
                        if showsPanel {
                            RoundedRectangle(cornerRadius: 28, style: .continuous)
                                .fill(TaskifyTheme.raisedFill)
                                .overlay {
                                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                                        .stroke(TaskifyTheme.border, lineWidth: 1)
                                }
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: max(0, geometry.size.height - 48))
                    .padding(24)
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle(showsPanel ? "" : "Welcome to Taskify")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(showsPanel ? .hidden : .visible, for: .navigationBar)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
        }
        .interactiveDismissDisabled()
    }

    /// Long localized labels and accessibility text sizes can stack without clipping.
    private var actionLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(spacing: 12))
    }

    private var homePage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Plan your week, keep lists and share boards. Your tasks stay private and sync across your devices.")
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)

            Button {
                KeyBackupSettings.markCreatedHere()
                finish()
            } label: {
                Text("Start using Taskify")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(TaskifyTheme.accent)
            .controlSize(.large)

            Button {
                signInError = nil
                page = .signIn
            } label: {
                Text("I already use Taskify")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    private var signInPage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in with your key")
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)
            Text("Use the nsec from your other device or password manager. Your boards come back from your account backup.")
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)

            SecureField("nsec1... or 64-character key", text: $existingKeyInput)
                .submitLabel(.go)
                .onSubmit { handleUseExistingKey() }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(minHeight: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(TaskifyTheme.border, lineWidth: 1)
                )

            if let signInError {
                Text(signInError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            actionLayout {
                Button("Back") { page = .home }
                    .buttonStyle(.bordered)

                Button("Sign in") { handleUseExistingKey() }
                    .buttonStyle(.borderedProminent)
                    .tint(TaskifyTheme.accent)
            }
        }
    }

    private func handleUseExistingKey() {
        signInError = nil
        let trimmed = existingKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            signInError = "Enter your nsec first."
            return
        }
        let succeeded = model.importIdentity(trimmed)
        let importError = model.errorMessage
        // importIdentity's failure path also sets model.errorMessage, which drives RootTabView's
        // own .alert — presented from the same view this fullScreenCover is presented from.
        // SwiftUI can't show both at once and dismisses the cover to show the alert instead, so
        // clear it here and rely purely on the inline signInError below.
        model.errorMessage = nil
        guard succeeded else {
            signInError = importError ?? "Could not import your identity. Please try again."
            return
        }
        finish()
    }

    private func finish() {
        model.completeFirstRunOnboarding()
    }
}
