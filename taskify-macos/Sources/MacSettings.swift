import AppKit
import LocalAuthentication
import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers

struct MacSettingsView: View {
    @Environment(AppModel.self) private var model
    @EnvironmentObject private var wallet: WalletViewModel
    @State private var relay = ""
    @State private var identity = ""
    @State private var message: String?
    @State private var importConfirmation = false
    @State private var recoveryPhrase: String?
    @State private var restoringWallet = false
    @State private var restoreCandidate: TaskifySnapshot?
    @State private var profile = NostrProfileDraft()
    @State private var profileLoaded = false
    var body: some View {
        TabView {
            Form {
                Section("Tasks") {
                    Picker("Start Week On", selection: Binding(get: { model.weekStart }, set: { model.setWeekStart($0) })) {
                        ForEach(WeekdayColumn.allCases) { Text($0.fullName).tag($0) }
                    }
                    Picker("New Task Position", selection: Binding(get: { model.newTaskPosition }, set: { model.setNewTaskPosition($0) })) {
                        Text("Top").tag(NewTaskPosition.top); Text("Bottom").tag(NewTaskPosition.bottom)
                    }
                    Toggle("Show Full Week Recurrences", isOn: Binding(get: { model.showFullWeekRecurring }, set: { model.setShowFullWeekRecurring($0) }))
                    Toggle("Track Streaks", isOn: Binding(get: { model.streaksEnabled }, set: { model.setStreaksEnabled($0) }))
                    Toggle("Bible Tracker", isOn: Binding(get: { model.visibleBoards.contains { $0.kind == .bible } }, set: { _ = model.setBibleTrackerEnabled($0) }))
                }
                Section("Devotional") {
                    Toggle("Scripture Memory", isOn: Binding(get: { model.scriptureMemoryEnabled },
                        set: { model.updateScriptureMemorySettings(enabled: $0, boardID: model.scriptureMemoryBoardID, frequency: model.scriptureMemoryFrequency) }))
                    if model.scriptureMemoryEnabled {
                        Picker("Board", selection: Binding(get: { model.scriptureMemoryBoardID ?? "" },
                            set: { model.updateScriptureMemorySettings(enabled: true, boardID: $0.isEmpty ? nil : $0, frequency: model.scriptureMemoryFrequency) })) {
                            Text("None").tag("")
                            ForEach(model.scriptureMemoryEligibleBoards) { Text($0.name).tag($0.id) }
                        }
                        Picker("Review Frequency", selection: Binding(get: { model.scriptureMemoryFrequency },
                            set: { model.updateScriptureMemorySettings(enabled: true, boardID: model.scriptureMemoryBoardID, frequency: $0) })) {
                            ForEach(ScriptureMemoryFrequency.allCases, id: \.self) { Text($0.label).tag($0) }
                        }
                    }
                    Toggle("Fasting Reminders", isOn: Binding(get: { model.fastingRemindersEnabled },
                        set: { model.updateFastingReminders(enabled: $0, mode: model.fastingRemindersMode, perMonth: model.fastingRemindersPerMonth, weekday: model.fastingRemindersWeekday) }))
                    if model.fastingRemindersEnabled {
                        Picker("Pattern", selection: Binding(get: { model.fastingRemindersMode },
                            set: { model.updateFastingReminders(enabled: true, mode: $0, perMonth: model.fastingRemindersPerMonth, weekday: model.fastingRemindersWeekday) })) {
                            Text("Weekly").tag(FastingRemindersMode.weekday)
                            Text("Random").tag(FastingRemindersMode.random)
                        }
                        if model.fastingRemindersMode == .weekday {
                            Picker("Weekday", selection: Binding(get: { model.fastingRemindersWeekday },
                                set: { model.updateFastingReminders(enabled: true, mode: .weekday, perMonth: model.fastingRemindersPerMonth, weekday: $0) })) {
                                ForEach(Array(WeekdayColumn.allCases.enumerated()), id: \.offset) { index, day in Text(day.fullName).tag(index) }
                            }
                        } else {
                            Stepper("About \(model.fastingRemindersPerMonth) per month",
                                value: Binding(get: { model.fastingRemindersPerMonth },
                                    set: { model.updateFastingReminders(enabled: true, mode: .random, perMonth: $0, weekday: model.fastingRemindersWeekday) }),
                                in: 1...31)
                        }
                    }
                }
                Section("Notifications") {
                    LabeledContent("Reminders", value: model.notificationStatus)
                    Button("Enable Task Notifications") { model.requestNotificationPermission() }
                    Text("Messages sync while Taskify is running. Closed-app message notifications need a separately provisioned Mac push service.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Wallet Display") {
                    Toggle("Currency Conversion", isOn: Binding(get: { model.walletConversionEnabled }, set: { model.setWalletConversionEnabled($0) }))
                }
            }.formStyle(.grouped).tabItem { Label("General", systemImage: "gearshape") }
            Form {
                Section("Nostr Account") {
                    Text(model.identityNpub).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Button("Copy Public Key") { macCopy(model.identityNpub) }
                    SecureField("Import nsec or secret key", text: $identity)
                    Button("Switch Account…") { importConfirmation = true }.disabled(identity.isEmpty)
                    Text("Switching accounts replaces this Mac's task and chat state. The wallet has its own recovery phrase.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Backup") {
                    Button("Export Task Backup…") { exportBackup() }
                    Button("Restore Task Backup…") { importBackup() }
                    Button("Check Encrypted Account Backup") { model.checkAccountSyncNow() }
                    if let message = model.accountBackupMessage { Text(message).font(.caption) }
                    Button("Copy Private Key…") {
                        Task {
                            do { try await authenticate("Copy your Taskify private key"); macCopy(try model.exportIdentityNsec()); message = "Private key copied." }
                            catch { message = error.localizedDescription }
                        }
                    }
                }
                Section("Wallet Recovery") {
                    Button("Recover Wallet…") { restoringWallet = true }
                    Button("Show Recovery Phrase…") {
                        Task { do { try await authenticate("View your Taskify wallet recovery phrase"); recoveryPhrase = try await wallet.recoveryPhrase() } catch { message = error.localizedDescription } }
                    }
                    Button("Export Wallet Backup…") {
                        Task {
                            do {
                                try await authenticate("Export your Taskify wallet recovery backup")
                                let backup = try await wallet.recoveryBackupJSON()
                                let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "Taskify-wallet-recovery.json"
                                guard panel.runModal() == .OK, let url = panel.url else { return }
                                try backup.write(to: url, atomically: true, encoding: .utf8)
                                message = "Wallet recovery backup exported. Store it securely; it controls your funds."
                            } catch { message = error.localizedDescription }
                        }
                    }
                }
                if let message { Text(message).font(.caption).textSelection(.enabled) }
            }.formStyle(.grouped).tabItem { Label("Account", systemImage: "person.crop.circle") }
            Form {
                Section("Public Profile") {
                    TextField("Display Name", text: profileBinding(\.displayName))
                    TextField("Username", text: profileBinding(\.username))
                    TextField("About", text: profileBinding(\.about), axis: .vertical).lineLimit(2...6)
                    TextField("Picture URL", text: profileBinding(\.picture))
                    TextField("Lightning Address", text: profileBinding(\.lud16))
                    TextField("NIP-05 Address", text: profileBinding(\.nip05))
                    Text("These profile details are public on Nostr.").font(.caption).foregroundStyle(.secondary)
                    Button("Publish Profile") { Task { do { try await model.publishOwnProfile(profile) } catch { message = error.localizedDescription } } }
                }
                if let message { Text(message).font(.caption) }
                if let message = model.profilePublishMessage { Text(message).font(.caption) }
            }.formStyle(.grouped).disabled(!profileLoaded || model.isPublishingProfile)
                .task { await model.loadOwnProfile(); profile = NostrProfileDraft(profile: model.ownProfile); profileLoaded = true }
                .tabItem { Label("Profile", systemImage: "person.text.rectangle") }
            Form {
                Section("Relay Connections") {
                    ForEach(model.appRelays, id: \.self) { url in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(url)
                                if let status = model.relayStatuses.first(where: { $0.relayURL == url }) { Text(String(describing: status.phase)).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Button("Remove") { _ = model.removeAppRelay(url) }
                        }
                    }
                    HStack { TextField("wss://relay.example", text: $relay); Button("Add") { _ = model.addAppRelay(relay); relay = "" }.disabled(relay.isEmpty) }
                    Button("Sync Now") { model.retrySync() }
                    Text(model.syncDetail).font(.caption).foregroundStyle(.secondary)
                }
                Section("Encrypted File Server") {
                    Picker("Server", selection: Binding(get: { model.encryptedMediaServerURL }, set: { model.selectEncryptedFileServer($0) })) {
                        ForEach(model.encryptedFileServers, id: \.url) { Text($0.url).tag($0.url) }
                    }
                }
            }.formStyle(.grouped).tabItem { Label("Sync", systemImage: "network") }
        }.padding(12)
            .sheet(isPresented: Binding(get: { recoveryPhrase != nil }, set: { if !$0 { recoveryPhrase = nil } })) {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Wallet Recovery Phrase").font(.title2.bold())
                    Text("Store these words securely. Anyone with them can access your funds.").foregroundStyle(.secondary)
                    Text(recoveryPhrase ?? "").font(.title3.monospaced()).textSelection(.enabled)
                    Button("Done") { recoveryPhrase = nil }.keyboardShortcut(.defaultAction)
                }.padding(28).frame(width: 480)
            }
            .sheet(isPresented: $restoringWallet) { MacWalletRecovery() }
            .confirmationDialog("Replace this Mac's task and chat data with the selected backup?", isPresented: Binding(get: { restoreCandidate != nil }, set: { if !$0 { restoreCandidate = nil } })) {
                Button("Restore Backup", role: .destructive) {
                    guard let candidate = restoreCandidate else { return }
                    restoreCandidate = nil
                    Task { await model.restoreLocalBackup(candidate) }
                }
                Button("Cancel", role: .cancel) { restoreCandidate = nil }
            }
            .confirmationDialog("Switch the account on this Mac?", isPresented: $importConfirmation) {
                Button("Switch Account", role: .destructive) { if model.importIdentity(identity) { identity = ""; message = "Account imported." } }
                Button("Cancel", role: .cancel) {}
            }
    }
    private func profileBinding(_ key: WritableKeyPath<NostrProfileDraft, String?>) -> Binding<String> {
        Binding(get: { profile[keyPath: key] ?? "" }, set: { profile[keyPath: key] = $0 })
    }
    private func importBackup() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                restoreCandidate = try await AttachmentFiles.work {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let data = try Data(contentsOf: url)
                    return try JSONDecoder().decode(TaskifySnapshot.self, from: data)
                }
            } catch { message = error.localizedDescription }
        }
    }
    private func exportBackup() {
        let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "Taskify-backup.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try model.localBackupJSON().write(to: url, atomically: true, encoding: .utf8); message = "Backup exported." }
        catch { message = error.localizedDescription }
    }
}

@MainActor
func authenticate(_ reason: String) async throws {
    let context = LAContext()
    guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else { throw CocoaError(.userCancelled) }
}

struct MacOnboarding: View {
    @Environment(AppModel.self) private var model
    @State private var key = ""
    @State private var importing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Image(systemName: "checkmark.square.fill").font(.system(size: 54)).foregroundStyle(Color.accentColor)
            Text("A little more space\nfor what matters.").font(.system(size: 32, weight: .semibold, design: .rounded))
            Text("Welcome to Taskify for Mac. Organize your days, keep conversations close, and sync with your existing Taskify account.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Toggle("I already use Taskify", isOn: $importing)
            if importing {
                SecureField("Paste your Taskify nsec", text: $key).textFieldStyle(.roundedBorder)
                Text("Find your private key in the account settings on your other device.").font(.caption).foregroundStyle(.secondary)
            }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red).font(.caption) }
            HStack {
                Spacer()
                Button(importing ? "Import Account" : "Get Started") {
                    if importing { guard model.importIdentity(key) else { return }; key = "" }
                    model.completeFirstRunOnboarding()
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(importing && key.isEmpty)
            }
        }.padding(38).frame(width: 480).interactiveDismissDisabled()
    }
}
