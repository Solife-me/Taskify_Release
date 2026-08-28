import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers
import UIKit

/// First-run onboarding, ported from the PWA's `FirstRunOnboarding.tsx` / `useFirstRunOnboarding.ts`.
///
/// One behavioral difference from the PWA: native always auto-generates a Nostr identity on
/// first launch (see `AppModel.load()`), so there's no "no key yet" state to gate on — by the
/// time this view can appear, a key already exists. "Sign in with an existing key" therefore
/// *replaces* the auto-generated one (via `importIdentity`, same as Settings' identity import),
/// and "Create new login" just surfaces/backs up the key that's already there. The PWA's third
/// option — restoring from a local backup *file* — isn't ported here: native has no local backup
/// file export/import to restore from yet. Signing in with an existing key already triggers the
/// existing automatic account-sync search (`AppModel.refreshAccountSync`), which covers the
/// common "I already used Taskify" case without new plumbing.
struct FirstRunOnboardingView: View {
    @Environment(AppModel.self) private var model

    private enum Page {
        case home
        case signIn
        case create
        case notifications
    }

    @State private var page: Page = .home
    @State private var existingKeyInput = ""
    @State private var createdNsec = ""
    @State private var signInError: String?
    @State private var createMessage: String?
    @State private var notificationBusy = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Spacer(minLength: 8)

                switch page {
                case .home: homePage
                case .signIn: signInPage
                case .create: createPage
                case .notifications: notificationsPage
                }

                Spacer()
            }
            .padding(24)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Welcome to Taskify")
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
    }

    private var homePage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose how you want to get started.")
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)

            Button {
                signInError = nil
                page = .signIn
            } label: {
                Text("Sign in with nsec")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(TaskifyTheme.accent)
            .controlSize(.large)

            Button {
                openCreatePage()
            } label: {
                Text("Create new login")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    private var signInPage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in with nsec")
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)

            SecureField("nsec1... or 64-character key", text: $existingKeyInput)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 16)
                .frame(height: 50)
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

            HStack(spacing: 12) {
                Button("Back") { page = .home }
                    .buttonStyle(.bordered)

                Button("Continue") { handleUseExistingKey() }
                    .buttonStyle(.borderedProminent)
                    .tint(TaskifyTheme.accent)
            }
        }
    }

    private var createPage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Create new login")
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)

            Text("This private key acts as a password to log in to your account. Store it somewhere safe like a password manager.")
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Text(createdNsec.isEmpty ? "Generating key…" : createdNsec)
                .font(.caption.monospaced())
                .foregroundStyle(TaskifyTheme.primaryText)
                .textSelection(.enabled)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            HStack(spacing: 12) {
                Button {
                    UIPasteboard.general.setItems(
                        [[UTType.plainText.identifier: createdNsec]],
                        options: [
                            .localOnly: true,
                            .expirationDate: Date().addingTimeInterval(120),
                        ]
                    )
                    createMessage = "nsec copied"
                } label: {
                    Label("Copy nsec", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .disabled(createdNsec.isEmpty)

                if !createdNsec.isEmpty {
                    ShareLink(item: createdNsec) {
                        Label("Save", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.bordered)
                }
            }

            if let createMessage {
                Text(createMessage)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            HStack(spacing: 12) {
                Button("Back") { page = .home }
                    .buttonStyle(.bordered)

                Button("Continue") { page = .notifications }
                    .buttonStyle(.borderedProminent)
                    .tint(TaskifyTheme.accent)
                    .disabled(createdNsec.isEmpty)
            }
        }
    }

    private var notificationsPage: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Enable reminder notifications?")
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)

            Text("Taskify only sends notifications for reminders you create on tasks or events. Taskify never sends unsolicited notifications. This also enables push notifications for new chat messages — message contents stay encrypted end to end.")
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)

            HStack(spacing: 12) {
                Button("Not now") {
                    finish()
                }
                .buttonStyle(.bordered)
                .disabled(notificationBusy)

                Button {
                    notificationBusy = true
                    model.requestNotificationPermission()
                    // Onboarding also opts the account into DM push with the default
                    // categories. The registration runs in the background — onboarding
                    // shouldn't wait on the network — and a failure is surfaced later as
                    // Settings' push status, where it can be retried.
                    Task {
                        await model.enableDMPushNotifications(
                            selection: .both,
                            relayURL: TaskifyDMPushSettings.relayURL,
                            serverURL: TaskifyDMPushSettings.serverURL
                        )
                    }
                    finish()
                } label: {
                    Text(notificationBusy ? "Enabling…" : "Enable notifications")
                }
                .buttonStyle(.borderedProminent)
                .tint(TaskifyTheme.accent)
                .disabled(notificationBusy)
            }
        }
    }

    private func openCreatePage() {
        createMessage = nil
        if createdNsec.isEmpty {
            createdNsec = model.currentIdentityNsec() ?? ""
        }
        page = .create
    }

    private func handleUseExistingKey() {
        signInError = nil
        let trimmed = existingKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            signInError = "Enter your nsec first."
            return
        }
        let succeeded = model.importIdentity(trimmed)
        // importIdentity's failure path also sets model.errorMessage, which drives RootTabView's
        // own .alert — presented from the same view this fullScreenCover is presented from.
        // SwiftUI can't show both at once and dismisses the cover to show the alert instead, so
        // clear it here and rely purely on the inline signInError below.
        model.errorMessage = nil
        guard succeeded else {
            signInError = "That nsec looks invalid. Paste a valid nsec or 64-character secret key."
            return
        }
        page = .notifications
    }

    private func finish() {
        model.completeFirstRunOnboarding()
    }
}
