import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers

/// Asks the user to save their key once losing it would cost them something (C9-5, matching the
/// PWA's `KeyBackupBanner`): a key made here, three tasks or a day later, until it is copied.
struct KeyBackupBanner: View {
    @Environment(AppModel.self) private var model
    @AppStorage(KeyBackupSettings.storageKey) private var stateRaw = ""

    var body: some View {
        let state = KeyBackupSettings.decode(stateRaw)
        if state.isPromptDue(now: Date(), taskCount: model.activeTaskIDs.count) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Your tasks are tied to a key that exists only on this device. Save your nsec in a password manager to sign in elsewhere or recover your tasks.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.primaryText)
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
                    .buttonStyle(.borderedProminent)
                    .tint(TaskifyTheme.accent)
                    Button("Not now") { KeyBackupSettings.snooze() }
                        .buttonStyle(.bordered)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .taskifyGlass(cornerRadius: 18)
            .accessibilityElement(children: .contain)
        }
    }
}
