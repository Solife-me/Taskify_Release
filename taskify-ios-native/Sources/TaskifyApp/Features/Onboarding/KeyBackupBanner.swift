import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers

/// Offers recovery once the user has tasks they could lose.
struct KeyBackupBanner: View {
    @Environment(AppModel.self) private var model
    @AppStorage(KeyBackupSettings.storageKey) private var stateRaw = ""
    @State private var showingICloudBackup = false

    var body: some View {
        let state = KeyBackupSettings.decode(stateRaw)
        if state.isPromptDue(now: Date(), taskCount: model.activeTaskIDs.count),
           !model.hasICloudKeyRecoveryCopy || showingICloudBackup {
            VStack(alignment: .leading, spacing: 10) {
                Text("Save your private key so you can recover your Taskify account if you lose this device.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.primaryText)
                Button {
                    showingICloudBackup = true
                } label: {
                    Label("Back up with iCloud", systemImage: "icloud.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
                .tint(TaskifyTheme.accent)
                .disabled(model.identityNpub.isEmpty)
                HStack(spacing: 12) {
                    Button("Copy nsec") {
                        guard let nsec = model.currentIdentityNsec() else { return }
                        // As Settings copies it: this device only, cleared after a minute.
                        UIPasteboard.general.setItems(
                            [[UTType.plainText.identifier: nsec]],
                            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)]
                        )
                        KeyBackupSettings.markSaved()
                    }
                    .buttonStyle(.bordered)
                    Button("Not now") { KeyBackupSettings.snooze() }
                        .buttonStyle(.bordered)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .taskifyGlass(cornerRadius: 18)
            .accessibilityElement(children: .contain)
            .sheet(isPresented: $showingICloudBackup) {
                ICloudKeyRecoveryView(mode: .backup)
            }
        }
    }
}

struct ICloudKeyRecoveryView: View {
    enum Mode: Identifiable {
        case backup
        case restore

        var id: Self { self }

        var title: String {
            switch self {
            case .backup: "iCloud Key Recovery"
            case .restore: "Restore from iCloud"
            }
        }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let mode: Mode
    var onRestored: () -> Void = {}

    @State private var recoveryAccounts: [String] = []
    @State private var didCheckForBackups = false
    @State private var errorMessage: String?
    @State private var showingRemoveConfirmation = false
    @State private var pendingRestore: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch mode {
                    case .backup: backupControls
                    case .restore: restoreControls
                    }

                    Text("In Settings, tap your name, then iCloud → Passwords & Keychain. Turn on syncing for this device.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(.red)
                    }
                }
                .padding(24)
                .frame(maxWidth: 540, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle(mode.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { refresh() }
            }
            .alert("Remove iCloud recovery copy?", isPresented: $showingRemoveConfirmation) {
                Button("Remove backup", role: .destructive) {
                    perform { try model.removeICloudKeyRecovery() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes the recovery copy for this Taskify account from iCloud Keychain and synced devices. You can keep using this account here.")
            }
            .alert("Restore this Taskify account?", isPresented: Binding(
                get: { pendingRestore != nil },
                set: { if !$0 { pendingRestore = nil } }
            ), presenting: pendingRestore) { npub in
                Button("Restore account") {
                    perform {
                        try model.restoreIdentityFromICloud(npub: npub)
                        dismiss()
                        onRestored()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { npub in
                if !model.showsFirstRunOnboarding && npub != model.identityNpub {
                    Text("This switches Taskify to \(npub). Save your current private key first if you’ll need it again.")
                } else {
                    Text(npub)
                }
            }
        }
    }

    private var backupControls: some View {
        Group {
            if model.hasICloudKeyRecoveryCopy {
                Label("Recovery copy saved here", systemImage: "checkmark.circle")
                    .font(.headline)
                Text("iCloud Keychain syncs this copy to your approved Apple devices. Check for it on another device to confirm it synced.")
                    .font(.subheadline)
                Button("Remove iCloud backup", role: .destructive) { showingRemoveConfirmation = true }
                    .buttonStyle(.bordered)
            } else {
                Text("Save a copy of your Taskify private key to iCloud Keychain. You can restore your account on another device using the same Apple Account.")
                    .font(.subheadline)
                Button("Enable iCloud recovery") {
                    perform { try model.enableICloudKeyRecovery() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.identityNpub.isEmpty)
            }
        }
    }

    private var restoreControls: some View {
        Group {
            Text("Use the same Apple Account you used to save your Taskify key. It may take a moment for a backup to appear.")
                .font(.subheadline)

            if didCheckForBackups && recoveryAccounts.isEmpty && errorMessage == nil {
                Text("No Taskify recovery copies found on this device yet.")
                    .font(.headline)
            }

            ForEach(recoveryAccounts, id: \.self) { npub in
                Button {
                    pendingRestore = npub
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Restore account", systemImage: "icloud.and.arrow.down")
                        Text(npub)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("taskify-icloud-restore-\(npub)")
            }

            Button("Check again") { refresh() }
                .buttonStyle(.bordered)
        }
    }

    private func refresh() {
        switch mode {
        case .backup:
            model.refreshICloudKeyRecoveryStatus()
        case .restore:
            perform {
                recoveryAccounts = []
                recoveryAccounts = try model.iCloudKeyRecoveryAccounts()
                didCheckForBackups = true
            }
        }
    }

    private func perform(_ action: () throws -> Void) {
        errorMessage = nil
        do { try action() }
        catch { errorMessage = error.localizedDescription }
    }
}
