import LocalAuthentication
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers
import VisionKit
import PhotosUI

struct SettingsView: View {
    private static let watchCardID = "taskify-settings-watch-authorization"

    @Environment(AppModel.self) private var model
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.openURL) private var openURL
    @StateObject private var watchBridge = TaskifyWatchBridge.shared
    @Binding private var watchSetupRequestID: UUID?
    @State private var newBoardName = ""
    @State private var newBoardKind: BoardKind = .week
    @State private var selectedCompoundChildIDs: Set<String> = []
    @State private var managingBoard: Board?
    @State private var managingCompoundBoard: Board?
    @State private var sharedBoardID = ""
    @State private var sharedBoardName = ""
    @State private var showingBoardScanner = false
    @State private var identityInput = ""
    @State private var revealedNsec: String?
    @State private var nsecCopied = false
    @State private var isAuthenticatingNsec = false
    @State private var nsecAuthError: String?
    @State private var showingAddFileServer = false
    @State private var newFileServerType: TaskifyFileServerType = .originless
    @State private var newFileServerURL = ""
    @State private var fileServerMessage: String?
    @State private var newAppRelayURL = ""
    @State private var appRelayMessage: String?
    @State private var showingClearChatHistoryConfirmation = false
    @State private var localBackupExportDocument: LocalBackupDocument?
    @State private var showingLocalBackupExporter = false
    @State private var showingLocalBackupImporter = false
    @State private var pendingLocalBackupRestore: TaskifySnapshot?
    @State private var confirmingLocalBackupRestore = false
    @State private var localBackupMessage: String?
    @State private var confirmingWatchProvisioning = false
    @State private var showingP2PKImport = false
    @State private var p2pkImportSecret = ""
    @State private var p2pkImportLabel = ""
    @State private var p2pkMessage: String?
    @State private var p2pkKeyToRemove: CashuP2PKKey?
    @State private var backgroundPhotoItem: PhotosPickerItem?
    @State private var backgroundPhotoIsLoading = false
    @State private var appearanceMessage: String?
    /// Empty by default -- every settings group starts collapsed, matching the PWA's
    /// collapsed-by-default accordions, so opening Settings shows a scannable list of category
    /// headers instead of every card's full contents at once.
    @State private var expandedSettingsGroups: Set<String> = []
    @AppStorage(TaskPresentationSettings.completedTabKey)
    private var completedTabEnabled = TaskPresentationSettings.completedTabDefault
    @AppStorage(TaskPresentationSettings.hideCompletedSubtasksKey)
    private var hideCompletedSubtasks = TaskPresentationSettings.hideCompletedSubtasksDefault
    @AppStorage(TaskifyAppearanceSettings.accentKey)
    private var accentChoiceRaw = TaskifyAccentChoice.blue.rawValue
    @AppStorage(TaskifyAppearanceSettings.scaleKey)
    private var interfaceScaleRaw = TaskifyInterfaceScale.system.rawValue
    @AppStorage(TaskifyAppearanceSettings.backgroundBlurKey)
    private var backgroundIsBlurred = false
    @AppStorage(TaskifyAppearanceSettings.revisionKey)
    private var appearanceRevision = ""

    init(watchSetupRequestID: Binding<UUID?> = .constant(nil)) {
        _watchSetupRequestID = watchSetupRequestID
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Settings")
                .taskifyScreenTitle()
                .padding(.horizontal, 18)
                .padding(.top, 14)

            ScrollViewReader { settingsProxy in
                ScrollView {
                    VStack(spacing: 14) {
                        // Ordered and grouped to track the PWA's Settings page (Boards, View,
                        // Wallet, Chat, Bible, Push, Nostr, ...) instead of an alphabet-soup of
                        // individually titled cards, so the two apps read as the same page.
                        settingsGroup("Boards", systemImage: "square.grid.2x2.fill") {
                            boardsCard
                        }

                        settingsGroup("View", systemImage: "eye.fill") {
                            taskPresentationCard
                            taskOrderingCard
                            startupTabCard
                            streaksCard
                            appearanceCard
                        }

                        settingsGroup("Wallet", systemImage: "bitcoinsign.circle.fill") {
                            walletCurrencyCard
                            p2pkRecipientKeysCard
                        }

                        settingsGroup("Chat", systemImage: "bubble.left.and.text.bubble.right.fill") {
                            chatHistoryCard
                        }

                        settingsGroup("Bible", systemImage: "book.closed.fill") {
                            bibleTrackerCard
                            fastingRemindersCard
                            scriptureMemoryCard
                        }

                        settingsGroup("Notifications", systemImage: "bell.badge.fill") {
                            notificationsCard
                        }

                        settingsGroup("Nostr & Sync", systemImage: "network") {
                            identityCard
                            accountSyncCard
                            syncCard
                            watchCard
                                .id(Self.watchCardID)
                            storageCard
                        }

                        settingsGroup("Backup", systemImage: "arrow.down.doc.fill") {
                            localBackupCard
                        }

                        settingsGroup("App", systemImage: "checkmark.seal.fill") {
                            migrationCard
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 18)
                }
                .scrollIndicators(.hidden)
                .task(id: watchSetupRequestID) {
                    guard let requestID = watchSetupRequestID else { return }
                    expandedSettingsGroups.insert("Nostr & Sync")
                    await Task.yield()
                    try? await Task.sleep(for: .milliseconds(80))
                    guard !Task.isCancelled else { return }
                    withAnimation(.easeInOut(duration: 0.25)) {
                        settingsProxy.scrollTo(Self.watchCardID, anchor: .center)
                    }
                    watchBridge.consumeSetupNavigationRequest(requestID)
                    watchSetupRequestID = nil
                }
            }
        }
        .onChange(of: backgroundPhotoItem) { _, item in
            guard let item else { return }
            Task { await loadBackgroundPhoto(item) }
        }
        .sheet(isPresented: $showingBoardScanner) {
            BoardQRJoinFlow()
                .environment(model)
        }
        .sheet(item: $managingBoard) { board in
            BoardManagerSheet(boardID: board.id)
                .environment(model)
        }
        .sheet(item: $managingCompoundBoard) { board in
            CompoundBoardManagerSheet(boardID: board.id)
                .environment(model)
        }
        .alert(
            "Private key",
            isPresented: Binding(
                get: { nsecAuthError != nil },
                set: { if !$0 { nsecAuthError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { nsecAuthError = nil }
        } message: {
            Text(nsecAuthError ?? "")
        }
        .alert(
            "Clear all message history?",
            isPresented: $showingClearChatHistoryConfirmation
        ) {
            Button("Clear history", role: .destructive) {
                model.clearDirectMessageHistory()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the chat messages stored on this device. It does not delete another participant's copy.")
        }
        .fileExporter(
            isPresented: $showingLocalBackupExporter,
            document: localBackupExportDocument,
            contentType: .json,
            defaultFilename: "taskify-backup"
        ) { result in
            switch result {
            case .success:
                localBackupMessage = "Backup saved."
            case .failure(let error):
                localBackupMessage = error.localizedDescription
            }
            localBackupExportDocument = nil
        }
        .fileImporter(
            isPresented: $showingLocalBackupImporter,
            allowedContentTypes: [.json],
            allowsMultipleSelection: false
        ) { result in
            handleLocalBackupImport(result)
        }
        .confirmationDialog(
            "Replace all local data with this backup?",
            isPresented: $confirmingLocalBackupRestore,
            titleVisibility: .visible
        ) {
            Button("Restore backup", role: .destructive) {
                if let pendingLocalBackupRestore {
                    let restored = pendingLocalBackupRestore
                    Task { await model.restoreLocalBackup(restored) }
                    localBackupMessage = "Local backup restored."
                }
                pendingLocalBackupRestore = nil
            }
            Button("Cancel", role: .cancel) {
                pendingLocalBackupRestore = nil
            }
        } message: {
            Text("This replaces every board, task, and related setting on this device with the contents of the backup file. It does not change your Nostr identity or wallet. This can't be undone.")
        }
        .confirmationDialog(
            "Enable independent Watch sync?",
            isPresented: $confirmingWatchProvisioning,
            titleVisibility: .visible
        ) {
            Button("Send Nostr identity to Watch") {
                watchBridge.provision(using: model)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your Nostr private key will be sent through the encrypted paired-device connection and stored only in the Watch's passcode-protected, device-only Keychain. Wallet keys and ecash are never sent.")
        }
        .confirmationDialog(
            "Remove recipient key?",
            isPresented: Binding(
                get: { p2pkKeyToRemove != nil },
                set: { if !$0 { p2pkKeyToRemove = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove key", role: .destructive) {
                guard let key = p2pkKeyToRemove else { return }
                Task {
                    do { try await wallet.removeP2PKKey(id: key.id) }
                    catch { p2pkMessage = WalletViewModel.message(for: error) }
                }
                p2pkKeyToRemove = nil
            }
            Button("Cancel", role: .cancel) { p2pkKeyToRemove = nil }
        } message: {
            Text("Ecash locked to this key can no longer be redeemed on this device. Only remove it after you are certain no locked tokens remain.")
        }
        .task {
#if DEBUG
            switch ProcessInfo.processInfo.environment["TASKIFY_SETTINGS_SHEET"] {
            case "boardManager":
                managingBoard = model.visibleBoards.first
            case "compoundBoardManager":
                managingCompoundBoard = model.visibleBoards.first(where: { $0.kind == .compound })
                    ?? model.visibleBoards.first
            default:
                break
            }
#endif
        }
    }

    /// A tappable category header above a cluster of related cards, matching the PWA's Settings
    /// page grouping (Boards, View, Wallet, Chat, Bible, ...) and its collapsed-by-default
    /// Show/Hide accordions — native keeps each sub-topic as its own glass card rather than
    /// merging them into one PWA-style section (safer, since each card owns its own
    /// bindings/state), but collapsing the whole cluster behind one header still gets the same
    /// "scan categories, expand only what you need" navigation speedup. Styled as its own glass
    /// card (icon + title + chevron) rather than bare text, so a collapsed group still looks like
    /// a card in the list instead of a stray label floating on the background.
    private func settingsGroup<Content: View>(
        _ title: String,
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let isExpanded = expandedSettingsGroups.contains(title)
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isExpanded {
                        expandedSettingsGroups.remove(title)
                    } else {
                        expandedSettingsGroups.insert(title)
                    }
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: systemImage)
                        .font(.title2)
                        .foregroundStyle(TaskifyTheme.accent)
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
                .taskifyGlass(cornerRadius: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Double-tap to \(isExpanded ? "collapse" : "expand")")

            if isExpanded {
                VStack(spacing: 18) {
                    content()
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "person.badge.key.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Nostr identity")
                    .font(.headline)
            }

            Text(model.identityNpub.isEmpty ? "Creating secure identity…" : model.identityNpub)
                .font(.caption.monospaced())
                .foregroundStyle(TaskifyTheme.secondaryText)
                .lineLimit(2)
                .textSelection(.enabled)

            Button {
                UIPasteboard.general.string = model.identityNpub
            } label: {
                Label("Copy npub", systemImage: "doc.on.doc")
            }
            .buttonStyle(.bordered)
            .disabled(model.identityNpub.isEmpty)

            SecureField("Import nsec or 64-character secret", text: $identityInput)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(TaskifyTheme.border, lineWidth: 1)
                )

            Button("Import identity") {
                guard model.importIdentity(identityInput) else { return }
                identityInput = ""
            }
            .buttonStyle(.bordered)
            .disabled(identityInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Divider()

            VStack(alignment: .leading, spacing: 10) {
                Text("Private key (nsec)")
                    .font(.subheadline.weight(.semibold))
                Text("Anyone with this key can act as you on Nostr and control this account's boards, chat, and sync. Keep it private.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let revealedNsec {
                    Text(revealedNsec)
                        .font(.caption.monospaced())
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(3)
                        .textSelection(.enabled)
                        .privacySensitive()
                }

                HStack(spacing: 12) {
                    Button {
                        revealedNsec == nil ? revealNsec() : hideNsec()
                    } label: {
                        Label(
                            isAuthenticatingNsec ? "Authenticating…" : (revealedNsec == nil ? "Show nsec" : "Hide nsec"),
                            systemImage: revealedNsec == nil ? "eye" : "eye.slash"
                        )
                    }
                    .buttonStyle(.bordered)
                    .disabled(isAuthenticatingNsec || model.identityNpub.isEmpty)

                    Button { copyNsec() } label: {
                        Label(nsecCopied ? "Copied" : "Copy nsec", systemImage: nsecCopied ? "checkmark" : "doc.on.doc")
                    }
                    .buttonStyle(.bordered)
                    .disabled(revealedNsec == nil)
                }
            }
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var accountSyncCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "arrow.triangle.2.circlepath.icloud")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Account Sync")
                    .font(.headline)
            }

            Button {
                model.checkAccountSyncNow()
            } label: {
                if model.isCheckingAccountBackup {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Syncing…")
                    }
                } else {
                    Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .buttonStyle(.bordered)
            .disabled(model.identityNpub.isEmpty || model.isCheckingAccountBackup)

            if let message = model.accountBackupMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            Text("Boards and settings stay synced in the background with any other Taskify client using the same account. Wallet data and device-only settings are never included.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var syncCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: model.syncIsOnline ? "checkmark.icloud.fill" : "arrow.triangle.2.circlepath.icloud")
                    .font(.title2)
                    .foregroundStyle(model.syncIsOnline ? Color.green : TaskifyTheme.accent)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Nostr sync")
                        .font(.headline)
                    Text(model.syncStatus)
                        .font(.subheadline.weight(.semibold))
                }

                Spacer()

                Circle()
                    .fill(model.syncIsOnline ? Color.green : Color.orange)
                    .frame(width: 9, height: 9)
                    .accessibilityHidden(true)
            }

            Text(model.syncDetail)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            if model.relayStatuses.isEmpty {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Preparing relays…")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            } else {
                VStack(spacing: 8) {
                    ForEach(model.relayStatuses) { relay in
                        RelayStatusRow(relay: relay)
                    }
                }
            }

            if model.pendingSyncChangeCount > 0 {
                Label(
                    "\(model.pendingSyncChangeCount) change\(model.pendingSyncChangeCount == 1 ? "" : "s") safely queued",
                    systemImage: "tray.full.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)
            }

            Label(
                "Background sync: \(model.backgroundSyncStatus)",
                systemImage: "arrow.clockwise.icloud"
            )
            .font(.caption)
            .foregroundStyle(TaskifyTheme.secondaryText)

            Button {
                model.retrySync()
            } label: {
                Label("Retry sync", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)

            Text("Taskify stays synced when at least one relay is available. Individual relay issues are shown above without incorrectly marking the whole app offline.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            Divider()

            appRelaysSection
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var watchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "applewatch")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Apple Watch")
                        .font(.headline)
                    Text("Secure Nostr companion")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            Text(watchBridge.state.message)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Button {
                confirmingWatchProvisioning = true
            } label: {
                Label(
                    watchBridge.state == .provisioned ? "Send account again" : "Enable Watch sync",
                    systemImage: "lock.shield.fill"
                )
            }
            .buttonStyle(.borderedProminent)
            .disabled(watchBridge.state == .activating || watchBridge.state == .provisioning)

            Text("Open Taskify on an unlocked, passcode-protected Watch, then enable sync here. Watch task additions and completions are delivered immediately or safely queued for the iPhone. Quick Add offers native Watch text input or Taskify Dictation with a task review before saving. Direct Watch-to-relay updates are the next Watch milestone. Removing the Watch passcode deletes its stored identity.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    /// The account-level relay set: the relays new boards are created on, and the ones that
    /// carry direct messages, shared tasks and the encrypted account backup. Editing this list
    /// deliberately leaves existing boards untouched — each board keeps its own relays, managed
    /// from that board's manager sheet.
    private var appRelaysSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("App relays")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.primaryText)

            ForEach(model.appRelayURLs, id: \.self) { relayURL in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(URL(string: relayURL)?.host ?? relayURL)
                            .font(.subheadline)
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .lineLimit(1)
                        Text(relayURL)
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: 8)

                    Button {
                        applyAppRelayChange(model.removeAppRelay(relayURL), relayURL: relayURL)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.appRelayURLs.count <= 1)
                    .accessibilityIdentifier("remove-app-relay-\(URL(string: relayURL)?.host ?? relayURL)")
                    .accessibilityLabel("Remove \(URL(string: relayURL)?.host ?? relayURL)")
                }
            }

            HStack(spacing: 10) {
                TextField("wss://relay.example", text: $newAppRelayURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.subheadline)
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .background(
                        TaskifyTheme.raisedFill,
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                    )
                    .accessibilityIdentifier("app-relay-input")
                    .onSubmit { addAppRelay() }

                Button("Add") { addAppRelay() }
                    .buttonStyle(.bordered)
                    .disabled(newAppRelayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Button("Restore default relays") {
                model.restoreDefaultAppRelays()
                appRelayMessage = "Default app relays restored."
            }
            .buttonStyle(.bordered)
            .disabled(model.appRelaysAreDefault)

            if let appRelayMessage {
                Text(appRelayMessage)
                    .font(.caption)
                    .foregroundStyle(
                        appRelayMessage.hasPrefix("Enter") || appRelayMessage.hasPrefix("Keep")
                            || appRelayMessage.hasPrefix("That")
                            ? Color.orange
                            : TaskifyTheme.secondaryText
                    )
            }

            Text("New boards are created on these relays, and they carry direct messages, shared tasks and your encrypted account backup. Existing boards keep their own relays — change those from each board's manager.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }

    private func addAppRelay() {
        let entry = newAppRelayURL
        applyAppRelayChange(model.addAppRelay(entry), relayURL: entry)
    }

    private func applyAppRelayChange(_ result: AppModel.AppRelayChangeResult, relayURL: String) {
        switch result {
        case .changed:
            newAppRelayURL = ""
            appRelayMessage = "App relays updated. Sync is reconnecting."
        case .invalidURL:
            appRelayMessage = "Enter a valid ws:// or wss:// relay address."
        case .duplicate:
            appRelayMessage = "That relay is already in the list."
        case .lastRelay:
            appRelayMessage = "Keep at least one app relay."
        }
    }

    private var storageCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "externaldrive.fill.badge.icloud")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Encrypted media storage")
                        .font(.headline)
                    Text("\(model.encryptedFileServers.count) server\(model.encryptedFileServers.count == 1 ? "" : "s") configured")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            Text("Task photos, documents, and chat attachments are encrypted on this device before they are uploaded. The server only receives opaque encrypted bytes. Blossom servers additionally require sign-in, authorized with your Taskify identity — not the board's key — each time you upload.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            VStack(spacing: 6) {
                ForEach(model.encryptedFileServers) { entry in
                    fileServerRow(entry)
                }
            }

            if showingAddFileServer {
                addFileServerForm
            } else {
                Button {
                    newFileServerType = .originless
                    newFileServerURL = ""
                    fileServerMessage = nil
                    showingAddFileServer = true
                } label: {
                    Label("Add server", systemImage: "plus")
                }
                .buttonStyle(.bordered)
            }

            Button("Restore Taskify defaults") {
                model.resetEncryptedFileServers()
                fileServerMessage = "Restored the default server list."
            }
            .buttonStyle(.bordered)

            if let fileServerMessage {
                Text(fileServerMessage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(
                        fileServerMessage.hasPrefix("Enter") || fileServerMessage.hasPrefix("That")
                            ? Color.red
                            : TaskifyTheme.secondaryText
                    )
            }

            if model.encryptedFileServers.contains(where: { $0.type == .blossom }) {
                Text("Warning: some Blossom servers inspect uploads and reject encrypted, unrecognizable file types. If uploads start failing, switch to an Originless server.")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
            }

            Text("Originless is recommended for encrypted blobs. A self-hosted or permissive Blossom server also works, but many public Blossom servers reject opaque encrypted uploads. NIP-96 servers use discovery and authenticated NIP-98 uploads. Attachments remain limited to 50 MB because Taskify's PWA-compatible AES-GCM attachment format must encrypt and validate each complete file before upload.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func fileServerRow(_ entry: TaskifyFileServerEntry) -> some View {
        let isSelected = entry.url == model.encryptedMediaServerURL
        return HStack(spacing: 10) {
            Button {
                model.selectEncryptedFileServer(entry.url)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(isSelected ? TaskifyTheme.accent : TaskifyTheme.tertiaryText)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(entry.displayLabel)
                                .font(.subheadline)
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .lineLimit(1)
                            Text(entry.type.displayLabel)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(TaskifyTheme.raisedFill, in: Capsule())
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        Text(entry.url)
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            .buttonStyle(.plain)

            Spacer(minLength: 8)

            Button {
                model.removeEncryptedFileServer(entry.url)
            } label: {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .disabled(model.encryptedFileServers.count <= 1)
            .accessibilityLabel("Remove \(entry.displayLabel)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            isSelected ? TaskifyTheme.raisedFill : Color.clear,
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    private var addFileServerForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Server type", selection: $newFileServerType) {
                ForEach(TaskifyFileServerType.allCases, id: \.self) { type in
                    Text(type.displayLabel).tag(type)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            TextField("https://example.com", text: $newFileServerURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.done)
                .onSubmit(addFileServer)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(
                    TaskifyTheme.raisedFill,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(TaskifyTheme.border, lineWidth: 1)
                )

            HStack(spacing: 10) {
                Button("Add server", action: addFileServer)
                    .buttonStyle(.borderedProminent)
                    .disabled(newFileServerURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Cancel", role: .cancel) {
                    showingAddFileServer = false
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func addFileServer() {
        switch model.addEncryptedFileServer(url: newFileServerURL, type: newFileServerType) {
        case .added:
            newFileServerURL = ""
            showingAddFileServer = false
            fileServerMessage = "Server added and selected."
        case .invalidURL:
            fileServerMessage = "Enter a valid server address."
        case .notHTTPS:
            fileServerMessage = "Enter an HTTPS server address."
        case .duplicate:
            fileServerMessage = "That server is already in the list."
        }
    }

    private var chatHistoryCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left.and.text.bubble.right.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Chat history")
                        .font(.headline)
                    Text("\(model.storedDirectMessageCount) message\(model.storedDirectMessageCount == 1 ? "" : "s") stored")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            HStack {
                Text("Keep message history")
                Spacer()
                Picker(
                    "Keep message history",
                    selection: Binding(
                        get: { model.chatMessageRetention },
                        set: { model.setChatMessageRetention($0) }
                    )
                ) {
                    ForEach(ChatMessageRetention.allCases, id: \.rawValue) { retention in
                        Text(retention.label).tag(retention)
                    }
                }
                .pickerStyle(.menu)
            }

            if model.chatMessageRetention != .forever {
                Text("Messages older than this are removed locally when Taskify loads or when this setting changes.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            Button("Clear all message history", role: .destructive) {
                showingClearChatHistoryConfirmation = true
            }
            .buttonStyle(.bordered)
            .disabled(model.storedDirectMessageCount == 0)

            Text("Retention and clearing are local privacy controls. They do not publish deletion events or erase messages from other participants' devices.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var walletCurrencyCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "bitcoinsign.circle.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Wallet currency")
                        .font(.headline)
                    Text(model.walletConversionEnabled ? "Conversion on" : "Sats only")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            Text("Currency conversion")
                .font(.subheadline.weight(.semibold))
            Picker(
                "Currency conversion",
                selection: Binding(
                    get: { model.walletConversionEnabled },
                    set: { model.setWalletConversionEnabled($0) }
                )
            ) {
                Text("On").tag(true)
                Text("Off").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text("Show USD equivalents by fetching the spot BTC price from Coinbase.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            // No "primary currency" picker here: tapping the wallet balance, or any amount
            // display, switches it in place. Setting it from two screens away was redundant once
            // the thing it affects became directly tappable.

            Divider()

            Text("Bitcoin denomination")
                .font(.subheadline.weight(.semibold))
            Picker(
                "Bitcoin denomination",
                selection: Binding(
                    get: { model.walletDenominationDisplay },
                    set: { model.setWalletDenominationDisplay($0) }
                )
            ) {
                Text("\(WalletAmountFormat.bitcoinSymbol)42,778").tag(WalletDenominationDisplay.bitcoinSymbol)
                Text("42,778 sat").tag(WalletDenominationDisplay.sat)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text("Choose how sat amounts are labeled in the wallet.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var p2pkRecipientKeysCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "lock.keyhole.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Recipient keys")
                        .font(.headline)
                    Text("P2PK-locked ecash")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                Spacer()
                Button {
                    Task {
                        do {
                            _ = try await wallet.generateP2PKKey(label: "Taskify iPhone")
                            p2pkMessage = "New recipient key created."
                        } catch {
                            p2pkMessage = WalletViewModel.message(for: error)
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Generate recipient key")
            }

            Text("Recipient private keys stay in this device's Keychain. Share only the public key when someone should lock ecash specifically to you.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            if wallet.p2pkKeys.isEmpty {
                Button("Generate recipient key") {
                    Task {
                        do {
                            _ = try await wallet.generateP2PKKey(label: "Taskify iPhone")
                            p2pkMessage = "Recipient key created."
                        } catch {
                            p2pkMessage = WalletViewModel.message(for: error)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            } else {
                ForEach(wallet.p2pkKeys) { key in
                    HStack(spacing: 10) {
                        Image(systemName: wallet.primaryP2PKKey?.id == key.id ? "key.fill" : "key")
                            .foregroundStyle(wallet.primaryP2PKKey?.id == key.id ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(key.label ?? "Recipient key")
                                .font(.subheadline.weight(.semibold))
                            Text("\(key.publicKey.prefix(12))…\(key.publicKey.suffix(8))")
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        Spacer()
                        Menu {
                            Button {
                                UIPasteboard.general.string = key.publicKey
                                p2pkMessage = "Public recipient key copied."
                            } label: {
                                Label("Copy public key", systemImage: "doc.on.doc")
                            }
                            if wallet.primaryP2PKKey?.id != key.id {
                                Button {
                                    Task {
                                        do { try await wallet.setPrimaryP2PKKey(id: key.id) }
                                        catch { p2pkMessage = WalletViewModel.message(for: error) }
                                    }
                                } label: {
                                    Label("Make primary", systemImage: "checkmark.circle")
                                }
                            }
                            Button(role: .destructive) { p2pkKeyToRemove = key } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                    .padding(12)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }

            Button(showingP2PKImport ? "Hide import" : "Import nsec or secret key") {
                withAnimation(.easeInOut(duration: 0.2)) { showingP2PKImport.toggle() }
            }
            .font(.subheadline.weight(.semibold))

            if showingP2PKImport {
                TextField("Label (optional)", text: $p2pkImportLabel)
                    .textFieldStyle(.roundedBorder)
                SecureField("nsec or 64-character secret", text: $p2pkImportSecret)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                Button("Import key") {
                    Task {
                        do {
                            _ = try await wallet.importP2PKKey(
                                secret: p2pkImportSecret,
                                label: p2pkImportLabel
                            )
                            p2pkImportSecret = ""
                            p2pkImportLabel = ""
                            showingP2PKImport = false
                            p2pkMessage = "Recipient key imported."
                        } catch {
                            p2pkMessage = WalletViewModel.message(for: error)
                        }
                    }
                }
                .buttonStyle(.bordered)
                .disabled(p2pkImportSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let p2pkMessage {
                Text(p2pkMessage)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var availableCompoundChildren: [Board] {
        model.visibleBoards.filter { $0.kind == .list }
    }

    private var archivedBoards: [Board] {
        model.boardsForManagement.filter(\.archived)
    }

    private var createBoardButtonTitle: String {
        switch newBoardKind {
        case .week: "Create weekly board"
        case .list: "Create list board"
        case .compound: "Create compound board"
        case .bible: "Create board"
        }
    }

    private func boardSummary(_ board: Board) -> String {
        switch board.kind {
        case .week:
            "Weekly board"
        case .list:
            "List board • \(board.columns.count) lists"
        case .compound:
            "Compound board • \(model.compoundChildBoards(for: board.id).count) linked boards"
        case .bible:
            "Bible board"
        }
    }

    private var boardsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "square.grid.2x2.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Boards & Lists")
                    .font(.headline)
            }

            ForEach(model.visibleBoards.filter { $0.kind != .bible }) { board in
                VStack(spacing: 7) {
                    HStack(spacing: 8) {
                        Button {
                            model.selectBoard(board.id)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(board.name)
                                    Text(boardSummary(board))
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                    HStack(spacing: 6) {
                                        Text(board.effectiveNostrBoardID)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(TaskifyTheme.secondaryText)
                                            .lineLimit(1)

                                        Image(systemName: "doc.on.doc")
                                            .font(.caption2)
                                            .foregroundStyle(TaskifyTheme.secondaryText)
                                    }
                                }
                                Spacer()
                                if board.id == model.selectedBoardID {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(TaskifyTheme.accent)
                                }
                            }
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .padding(.horizontal, 16)
                            .frame(maxWidth: .infinity, minHeight: 58)
                            .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(TaskifyTheme.border, lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = board.effectiveNostrBoardID
                            } label: {
                                Label("Copy board ID", systemImage: "doc.on.doc")
                            }
                        }

                        Button {
                            managingBoard = board
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.headline)
                                .frame(width: 46, height: 58)
                                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                                        .stroke(TaskifyTheme.border, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .accessibilityLabel("Manage \(board.name)")
                    }

                    if board.kind == .compound {
                        Button {
                            managingCompoundBoard = board
                        } label: {
                            Label("Manage linked boards", systemImage: "slider.horizontal.3")
                                .font(.caption.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 38)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }

            if !archivedBoards.isEmpty {
                Divider()

                Text("Archived")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TaskifyTheme.secondaryText)

                ForEach(archivedBoards) { board in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(board.name)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text(boardSummary(board))
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }

                        Spacer()

                        Button("Restore") {
                            _ = model.unarchiveBoard(boardID: board.id)
                        }
                        .buttonStyle(.bordered)

                        Button {
                            managingBoard = board
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .font(.title3)
                                .frame(width: 38, height: 38)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .accessibilityLabel("Manage \(board.name)")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(TaskifyTheme.border, lineWidth: 1)
                    )
                }

                Text("Archived boards stay on this device and can be restored at any time.")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            TextField("Board name", text: $newBoardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(TaskifyTheme.border, lineWidth: 1))

            Picker("Board type", selection: $newBoardKind) {
                Text("Weekly").tag(BoardKind.week)
                Text("Lists").tag(BoardKind.list)
                Text("Compound").tag(BoardKind.compound)
            }
            .pickerStyle(.segmented)

            if newBoardKind == .compound {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Linked list boards")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TaskifyTheme.secondaryText)

                    if availableCompoundChildren.isEmpty {
                        Text("Create a list board before creating a compound board.")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    } else {
                        ForEach(availableCompoundChildren) { child in
                            Button {
                                if selectedCompoundChildIDs.contains(child.id) {
                                    selectedCompoundChildIDs.remove(child.id)
                                } else {
                                    selectedCompoundChildIDs.insert(child.id)
                                }
                            } label: {
                                HStack {
                                    Image(systemName: selectedCompoundChildIDs.contains(child.id) ? "checkmark.square.fill" : "square")
                                        .foregroundStyle(selectedCompoundChildIDs.contains(child.id) ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                                    Text(child.name)
                                    Spacer()
                                    Text("\(child.columns.count) lists")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                }
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .padding(.horizontal, 12)
                                .frame(height: 42)
                                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            Button {
                let created: Bool
                switch newBoardKind {
                case .week:
                    created = model.createWeekBoard(name: newBoardName)
                case .list:
                    created = model.createListBoard(name: newBoardName)
                case .compound:
                    let orderedChildIDs = availableCompoundChildren
                        .filter { selectedCompoundChildIDs.contains($0.id) }
                        .map(\.id)
                    created = model.createCompoundBoard(
                        name: newBoardName,
                        childBoardIDs: orderedChildIDs
                    )
                case .bible:
                    created = false
                }
                guard created else { return }
                newBoardName = ""
                selectedCompoundChildIDs.removeAll()
            } label: {
                Text(createBoardButtonTitle)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(TaskifyTheme.accent, in: Capsule())
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .disabled(
                newBoardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    (newBoardKind == .compound && selectedCompoundChildIDs.isEmpty)
            )

            Divider()

            Text("Join a shared board")
                .font(.headline)

            TextField("Board ID or Taskify share", text: $sharedBoardID, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(2...5)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .frame(minHeight: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Text("Paste either a board ID or the full share text from Taskify. The board name and relays are imported automatically when available.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Button {
                showingBoardScanner = true
            } label: {
                Label("Scan board QR code", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
            }
            .buttonStyle(.bordered)

            TextField("Board name (optional)", text: $sharedBoardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Button("Join shared board") {
                guard model.joinSharedBoard(shareText: sharedBoardID, name: sharedBoardName) else { return }
                sharedBoardID = ""
                sharedBoardName = ""
            }
            .buttonStyle(.borderedProminent)
            .disabled(sharedBoardID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var bibleTrackerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "Bible Reading Tracker",
                isOn: Binding(
                    get: { model.bibleTrackerEnabled },
                    set: { _ = model.setBibleTrackerEnabled($0) }
                )
            )
            .font(.headline)
            Text("Adds a Bible board for tracking chapters read, book by book. Progress stays on this device only.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var fastingRemindersCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Toggle(
                "Fasting Reminders",
                isOn: Binding(
                    get: { model.fastingRemindersEnabled },
                    set: { newValue in
                        model.updateFastingReminders(
                            enabled: newValue,
                            mode: model.fastingRemindersMode,
                            perMonth: model.fastingRemindersPerMonth,
                            weekday: model.fastingRemindersWeekday
                        )
                    }
                )
            )
            .font(.headline)

            if model.fastingRemindersEnabled {
                Picker(
                    "Schedule",
                    selection: Binding(
                        get: { model.fastingRemindersMode },
                        set: { newMode in
                            let maxPerMonth = newMode == .random ? 31 : 5
                            model.updateFastingReminders(
                                enabled: true,
                                mode: newMode,
                                perMonth: min(model.fastingRemindersPerMonth, maxPerMonth),
                                weekday: model.fastingRemindersWeekday
                            )
                        }
                    )
                ) {
                    Text("Weekly").tag(FastingRemindersMode.weekday)
                    Text("Random days").tag(FastingRemindersMode.random)
                }
                .pickerStyle(.segmented)

                if model.fastingRemindersMode == .weekday {
                    Picker(
                        "Day of week",
                        selection: Binding(
                            get: { model.fastingRemindersWeekday },
                            set: { newWeekday in
                                model.updateFastingReminders(
                                    enabled: true,
                                    mode: model.fastingRemindersMode,
                                    perMonth: model.fastingRemindersPerMonth,
                                    weekday: newWeekday
                                )
                            }
                        )
                    ) {
                        ForEach(0..<7, id: \.self) { index in
                            Text(weekdayName(index)).tag(index)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Stepper(
                    "\(model.fastingRemindersPerMonth) time\(model.fastingRemindersPerMonth == 1 ? "" : "s") per month",
                    value: Binding(
                        get: { model.fastingRemindersPerMonth },
                        set: { newValue in
                            model.updateFastingReminders(
                                enabled: true,
                                mode: model.fastingRemindersMode,
                                perMonth: newValue,
                                weekday: model.fastingRemindersWeekday
                            )
                        }
                    ),
                    in: 1...(model.fastingRemindersMode == .random ? 31 : 5)
                )

                Text(model.fastingRemindersMode == .weekday
                    ? "Adds a \"Fasting\" task to your Week board on the chosen weekday."
                    : "Adds a \"Fasting\" task to your Week board on this many random days each month.")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func weekdayName(_ index: Int) -> String {
        let symbols = Calendar.current.weekdaySymbols
        guard index >= 0, index < symbols.count else { return "" }
        return symbols[index]
    }

    private var scriptureMemoryCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Toggle(
                "Scripture Memory",
                isOn: Binding(
                    get: { model.scriptureMemoryEnabled },
                    set: { newValue in
                        model.updateScriptureMemorySettings(
                            enabled: newValue,
                            boardID: model.scriptureMemoryBoardID ?? model.scriptureMemoryEligibleBoards.first?.id,
                            frequency: model.scriptureMemoryFrequency
                        )
                    }
                )
            )
            .font(.headline)

            if model.scriptureMemoryEnabled {
                if model.scriptureMemoryEligibleBoards.isEmpty {
                    Text("Create a week or list board first to choose where review tasks appear.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                } else {
                    Picker(
                        "Board",
                        selection: Binding(
                            get: { model.scriptureMemoryBoardID ?? model.scriptureMemoryEligibleBoards.first?.id ?? "" },
                            set: { newBoardID in
                                model.updateScriptureMemorySettings(
                                    enabled: true,
                                    boardID: newBoardID,
                                    frequency: model.scriptureMemoryFrequency
                                )
                            }
                        )
                    ) {
                        ForEach(model.scriptureMemoryEligibleBoards) { board in
                            Text(board.name).tag(board.id)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Picker(
                    "Frequency",
                    selection: Binding(
                        get: { model.scriptureMemoryFrequency },
                        set: { newFrequency in
                            model.updateScriptureMemorySettings(
                                enabled: true,
                                boardID: model.scriptureMemoryBoardID,
                                frequency: newFrequency
                            )
                        }
                    )
                ) {
                    ForEach(ScriptureMemoryFrequency.allCases, id: \.rawValue) { frequency in
                        Text(frequency.label).tag(frequency)
                    }
                }
                .pickerStyle(.segmented)

                Picker(
                    "Review list order",
                    selection: Binding(
                        get: { model.scriptureMemorySort },
                        set: { model.setScriptureMemorySort($0) }
                    )
                ) {
                    ForEach(ScriptureMemorySort.allCases, id: \.rawValue) { sort in
                        Text(sort.label).tag(sort)
                    }
                }
                .pickerStyle(.menu)

                Text("Add passages from the Bible board. Taskify creates one review task at the selected frequency and prioritizes passages that most need review.")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var streaksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "Task Streaks",
                isOn: Binding(
                    get: { model.streaksEnabled },
                    set: { model.setStreaksEnabled($0) }
                )
            )
            .font(.headline)
            Text("Shows a \u{1F525} count on daily and weekly recurring tasks each time you complete them in a row.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var taskPresentationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "checklist")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Task cards & completed items")
                    .font(.headline)
            }

            Toggle("Completed view", isOn: $completedTabEnabled)

            Text(
                completedTabEnabled
                    ? "Completed tasks leave their lists and collect behind the checkmark button."
                    : "Completed tasks stay at the bottom of their lists and the checkmark button becomes Clear completed."
            )
            .font(.caption2)
            .foregroundStyle(TaskifyTheme.tertiaryText)

            Divider()

            Toggle("Hide completed subtasks", isOn: $hideCompletedSubtasks)

            Text("Finished checklist items stay available in Edit but are hidden from task cards.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var taskOrderingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                Text("New task position")
                    .font(.headline)
            }

            Picker(
                "New task position",
                selection: Binding(
                    get: { model.newTaskPosition },
                    set: { model.setNewTaskPosition($0) }
                )
            ) {
                Text("Top").tag(NewTaskPosition.top)
                Text("Bottom").tag(NewTaskPosition.bottom)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text("Where a quick-added task lands within its list or day.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            Divider()

            Text("Week starts on")
                .font(.headline)

            Picker(
                "Week starts on",
                selection: Binding(
                    get: { model.weekStart },
                    set: { model.setWeekStart($0) }
                )
            ) {
                ForEach(WeekdayColumn.supportedWeekStarts) { weekday in
                    Text(weekday.fullName).tag(weekday)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text("Orders week boards and controls when weekly recurring tasks reappear.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            Divider()

            Toggle(
                "Show full week for recurring tasks",
                isOn: Binding(
                    get: { model.showFullWeekRecurring },
                    set: { model.setShowFullWeekRecurring($0) }
                )
            )

            Text("Displays every occurrence in the current week at once. When off, frequent recurring tasks reveal on their due day.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var startupTabCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "arrow.up.forward.app.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Launch tab")
                    .font(.headline)
            }

            Picker(
                "Launch tab",
                selection: Binding(
                    get: { model.startupTab },
                    set: { model.setStartupTab($0) }
                )
            ) {
                ForEach(StartupTab.allCases, id: \.self) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text("Which tab Taskify opens to next time you launch it.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            Divider()

            Text("Board on app start")
                .font(.subheadline.weight(.semibold))

            Text("Choose a board for each day. First visible follows the order shown in the board switcher.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            VStack(spacing: 4) {
                ForEach(WeekdayColumn.allCases) { weekday in
                    HStack(spacing: 12) {
                        Text(weekday.fullName)
                            .font(.subheadline)
                            .foregroundStyle(TaskifyTheme.secondaryText)

                        Spacer(minLength: 12)

                        Picker(
                            weekday.fullName,
                            selection: Binding(
                                get: { model.startupBoardID(for: weekday) ?? "" },
                                set: {
                                    model.setStartupBoardID(
                                        $0.isEmpty ? nil : $0,
                                        for: weekday
                                    )
                                }
                            )
                        ) {
                            Text("First visible").tag("")
                            ForEach(model.visibleBoards) { board in
                                Text(board.name).tag(board.id)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                    }
                    .frame(minHeight: 38)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var localBackupCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "arrow.down.doc.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Local backup")
                        .font(.headline)
                    Text("An offline copy, independent of Nostr sync")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            Text("Downloads every board, task, contact, and Bible/scripture-memory setting to one file on this device. It does not include your Nostr identity or wallet seed — those already have their own backup flows above and in the Wallet tab.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            HStack(spacing: 10) {
                Button {
                    exportLocalBackup()
                } label: {
                    Label("Download backup", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    localBackupMessage = nil
                    showingLocalBackupImporter = true
                } label: {
                    Label("Restore", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            }

            if let localBackupMessage {
                Text(localBackupMessage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func exportLocalBackup() {
        do {
            localBackupExportDocument = LocalBackupDocument(json: try model.localBackupJSON())
            showingLocalBackupExporter = true
        } catch {
            localBackupMessage = "Could not prepare the backup file."
        }
    }

    private func handleLocalBackupImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                pendingLocalBackupRestore = try JSONDecoder().decode(TaskifySnapshot.self, from: data)
                confirmingLocalBackupRestore = true
            } catch {
                localBackupMessage = "That file isn't a valid Taskify backup."
            }
        case .failure(let error):
            localBackupMessage = error.localizedDescription
        }
    }

    private var migrationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Native app status")
                    .font(.headline)
            }

            StatusRow(title: "Offline task storage", status: "Active", complete: true)
            StatusRow(title: "Weekly boards", status: "Active", complete: true)
            StatusRow(title: "List boards & rich task editing", status: "Active", complete: true)
            StatusRow(title: "Compound boards", status: "Active", complete: true)
            StatusRow(title: "Bible reading tracker", status: "Active with print & scan", complete: true)
            StatusRow(title: "Fasting reminders", status: "Active", complete: true)
            StatusRow(title: "Scripture memory", status: "Active", complete: true)
            StatusRow(title: "Task streaks", status: "Active", complete: true)
            StatusRow(title: "Recurrence & native reminders", status: "Active", complete: true)
            StatusRow(title: "Nostr sync", status: model.syncStatus, complete: model.syncIsOnline)
            StatusRow(title: "Account sync continuity", status: "Active", complete: true)
            StatusRow(title: "Task sharing & assignments", status: "Active", complete: true)
            StatusRow(title: "Background sync", status: model.backgroundSyncStatus, complete: true)
            StatusRow(title: "Encrypted chat", status: "Active", complete: true)
            StatusRow(title: "Wallet", status: "Active", complete: true)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var notificationsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "bell.badge.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Task reminders")
                        .font(.headline)
                    Text(model.notificationStatus)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            Text("Reminders are scheduled locally by iOS. Task titles and dates stay on this device.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            if model.notificationStatus == "Disabled in iOS Settings" {
                Button("Open iOS Settings") {
                    if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                        openURL(settingsURL)
                    }
                }
                .buttonStyle(.borderedProminent)
            } else if model.notificationStatus != "Enabled" && model.notificationStatus != "Delivered quietly" {
                Button("Enable notifications") {
                    model.requestNotificationPermission()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var appearanceCard: some View {
        let photoAccents = TaskifyAppearanceSettings.backgroundAccents
        let selectedPhotoAccentIndex = TaskifyAppearanceSettings.selectedBackgroundAccentIndex
        let _ = appearanceRevision

        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "paintpalette.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Appearance")
                        .font(.headline)
                    Text("Personalize Taskify while keeping native materials and accessibility.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            Divider()

            Text("Accent color")
                .font(.subheadline.weight(.semibold))

            HStack(spacing: 10) {
                ForEach(TaskifyAccentChoice.presetChoices, id: \.self) { choice in
                    AppearanceAccentSwatch(
                        label: "\(choice.label) accent",
                        color: appearanceAccentColor(for: choice),
                        foregroundColor: TaskifyTheme.accentOn,
                        isSelected: accentChoiceRaw == choice.rawValue
                    ) {
                        accentChoiceRaw = choice.rawValue
                        TaskifyAppearanceSettings.selectAccent(choice)
                    }
                }

                if !photoAccents.isEmpty {
                    Divider()
                        .frame(height: 34)
                        .padding(.horizontal, 1)

                    ForEach(Array(photoAccents.enumerated()), id: \.offset) { index, accent in
                        AppearanceAccentSwatch(
                            label: "Photo accent \(index + 1), \(accent.hex)",
                            color: accent.taskifyColor,
                            foregroundColor: accent.prefersDarkForeground
                                ? TaskifyTheme.accentOn
                                : Color.white,
                            isSelected: accentChoiceRaw == TaskifyAccentChoice.background.rawValue
                                && selectedPhotoAccentIndex == index
                        ) {
                            accentChoiceRaw = TaskifyAccentChoice.background.rawValue
                            TaskifyAppearanceSettings.selectBackgroundAccent(at: index)
                        }
                    }
                }
            }

            if !photoAccents.isEmpty {
                Text("The last \(photoAccents.count == 1 ? "swatch is" : "\(photoAccents.count) swatches are") sampled from your background.")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            Text("Interface size")
                .font(.subheadline.weight(.semibold))
            Picker("Interface size", selection: Binding(
                get: { TaskifyInterfaceScale(rawValue: interfaceScaleRaw) ?? .system },
                set: { interfaceScaleRaw = $0.rawValue }
            )) {
                ForEach(TaskifyInterfaceScale.allCases, id: \.self) { scale in
                    Text(scale.label).tag(scale)
                }
            }
            .pickerStyle(.menu)

            Divider()

            if let image = TaskifyAppearanceSettings.backgroundImage {
                GeometryReader { proxy in
                    ZStack {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: proxy.size.width, height: proxy.size.height)
                            .clipped()
                            .blur(radius: backgroundIsBlurred ? 7 : 0)
                            .scaleEffect(backgroundIsBlurred ? 1.08 : 1.02)

                        Color.black.opacity(backgroundIsBlurred ? 0.10 : 0.04)
                    }
                }
                .frame(height: 118)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                Picker("Background clarity", selection: $backgroundIsBlurred) {
                    Text("Sharp").tag(false)
                    Text("Blurred").tag(true)
                }
                .pickerStyle(.segmented)
                .onChange(of: backgroundIsBlurred) { _, _ in
                    TaskifyAppearanceSettings.bumpRevision()
                }
            }

            HStack {
                PhotosPicker(selection: $backgroundPhotoItem, matching: .images) {
                    Label(
                        TaskifyAppearanceSettings.hasBackgroundImage ? "Change photo" : "Choose background",
                        systemImage: "photo"
                    )
                }
                .buttonStyle(.bordered)
                .disabled(backgroundPhotoIsLoading)

                if TaskifyAppearanceSettings.hasBackgroundImage {
                    Button("Remove", role: .destructive) {
                        TaskifyAppearanceSettings.removeBackgroundImage()
                        accentChoiceRaw = TaskifyAccentChoice.blue.rawValue
                        appearanceMessage = nil
                    }
                    .buttonStyle(.bordered)
                    .disabled(backgroundPhotoIsLoading)
                }

                if backgroundPhotoIsLoading {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let appearanceMessage {
                Text(appearanceMessage)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
        .task {
            _ = TaskifyAppearanceSettings.ensureBackgroundAccents()
        }
    }

    private func loadBackgroundPhoto(_ item: PhotosPickerItem) async {
        backgroundPhotoIsLoading = true
        defer {
            backgroundPhotoItem = nil
            backgroundPhotoIsLoading = false
        }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                appearanceMessage = "That photo couldn't be loaded."
                return
            }
            try TaskifyAppearanceSettings.saveBackgroundImage(data: data)
            accentChoiceRaw = TaskifyAccentChoice.background.rawValue
            appearanceMessage = nil
        } catch {
            appearanceMessage = error.localizedDescription
        }
    }

    private func appearanceAccentColor(for choice: TaskifyAccentChoice) -> Color {
        TaskifyTheme.color(for: choice)
    }

    private func revealNsec() {
        isAuthenticatingNsec = true
        Task {
            defer { isAuthenticatingNsec = false }
            do {
                try await authenticateForIdentity(reason: "Show your Taskify private key")
                revealedNsec = try model.exportIdentityNsec()
            } catch {
                nsecAuthError = error.localizedDescription
            }
        }
    }

    private func hideNsec() {
        if nsecCopied { UIPasteboard.general.items = [] }
        revealedNsec = nil
        nsecCopied = false
    }

    private func copyNsec() {
        guard let revealedNsec else { return }
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: revealedNsec]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(60),
            ]
        )
        nsecCopied = true
    }

    private func authenticateForIdentity(reason: String) async throws {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var authenticationError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authenticationError) else {
            if let authenticationError { throw authenticationError }
            throw IdentityAuthenticationError.unavailable
        }
        guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else {
            throw IdentityAuthenticationError.failed
        }
    }
}

private enum IdentityAuthenticationError: LocalizedError {
    case unavailable
    case failed

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Set a device passcode before viewing or copying your private key."
        case .failed:
            "Device authentication did not complete."
        }
    }
}

private struct AppearanceAccentSwatch: View {
    let label: String
    let color: Color
    let foregroundColor: Color
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(color)
                .frame(width: 34, height: 34)
                .overlay {
                    if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(foregroundColor)
                    }
                }
                .padding(4)
                .background(color.opacity(isSelected ? 0.22 : 0), in: Circle())
                .overlay {
                    Circle()
                        .stroke(
                            isSelected ? Color.white.opacity(0.9) : Color.white.opacity(0.22),
                            lineWidth: isSelected ? 2 : 1
                        )
                }
                .shadow(color: isSelected ? color.opacity(0.55) : .clear, radius: 6)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
    }
}

private struct BoardManagerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let boardID: String
    @State private var boardName = ""
    @State private var newRelayURL = ""
    @State private var relayMessage: String?
    @State private var showingDeleteConfirmation = false
    @State private var showingArchiveBlocked = false
    @State private var showingRegenerateBoardIDConfirmation = false
    @State private var recoveryBusy = false
    @State private var recoveryMessage: String?

    private var board: Board? {
        model.board(withID: boardID)
    }

    private var taskCount: Int {
        model.taskCount(forBoardID: boardID)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                if let board {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            nameCard(board)
                            reorderCard(board)
                            detailsCard(board)
                            if board.kind != .bible {
                                completionCard(board)
                            }
                            if board.kind == .list {
                                indexCardToggleCard(board)
                            }
                            relaysCard(board)
                            syncRecoveryCard(board)
                            archiveCard(board)
                            deleteCard
                        }
                        .padding(18)
                    }
                } else {
                    ContentUnavailableView("Board unavailable", systemImage: "exclamationmark.triangle")
                }
            }
            .navigationTitle(board?.name ?? "Manage board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .onAppear {
            boardName = board?.name ?? ""
        }
        .alert("Keep one active board", isPresented: $showingArchiveBlocked) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Create or restore another board before archiving this one.")
        }
        .confirmationDialog(
            "Delete \(board?.name ?? "this board")?",
            isPresented: $showingDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete board and \(taskCount) task\(taskCount == 1 ? "" : "s")", role: .destructive) {
                guard model.deleteBoard(boardID: boardID) else { return }
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the local copy. It does not delete copies already held by collaborators.")
        }
        .confirmationDialog(
            "Generate a new board ID?",
            isPresented: $showingRegenerateBoardIDConfirmation,
            titleVisibility: .visible
        ) {
            Button("Generate ID and republish", role: .destructive) {
                runRecoveryAction {
                    let newID = try await model.regenerateBoardNostrID(boardID: boardID)
                    return "New board ID created and snapshot queued (…\(newID.suffix(8))). Existing shares will not follow future changes."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This moves future sync to a new board identity. People using the old board share must receive the new share to keep syncing.")
        }
    }

    private func nameCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Board name")
                .font(.headline)

            TextField("Board name", text: $boardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(TaskifyTheme.border, lineWidth: 1)
                )

            Button("Save name") {
                let trimmedName = boardName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard model.renameBoard(boardID: boardID, name: trimmedName) else { return }
                boardName = trimmedName
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                boardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    boardName.trimmingCharacters(in: .whitespacesAndNewlines) == board.name
            )

            Text("Name changes sync with collaborators on shared boards.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var reorderableBoardIDs: [String] {
        model.visibleBoards.filter { $0.kind != .bible }.map(\.id)
    }

    private func reorderCard(_ board: Board) -> some View {
        let position = reorderableBoardIDs.firstIndex(of: board.id)
        let canMoveUp = (position ?? 0) > 0
        let canMoveDown = position.map { $0 < reorderableBoardIDs.count - 1 } ?? false

        return VStack(alignment: .leading, spacing: 12) {
            Text("Order")
                .font(.headline)

            HStack(spacing: 10) {
                Button {
                    _ = model.moveBoard(boardID: boardID, direction: -1)
                } label: {
                    Label("Move Up", systemImage: "arrow.up")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.bordered)
                .disabled(!canMoveUp)

                Button {
                    _ = model.moveBoard(boardID: boardID, direction: 1)
                } label: {
                    Label("Move Down", systemImage: "arrow.down")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.bordered)
                .disabled(!canMoveDown)
            }
            .font(.subheadline.weight(.semibold))

            Text("Changes where this board appears in the board switcher. Stays on this device only.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func detailsCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Board details")
                .font(.headline)

            VStack(alignment: .leading, spacing: 10) {
                LabeledContent("Type", value: boardKindName(board.kind))
                LabeledContent("Tasks", value: "\(taskCount)")
            }
            .font(.subheadline)

            Button {
                UIPasteboard.general.string = board.effectiveNostrBoardID
            } label: {
                Label("Copy board ID", systemImage: "doc.on.doc")
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func indexCardToggleCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "List index card",
                isOn: Binding(
                    get: { board.indexCardEnabled },
                    set: { _ = model.setBoardIndexCardEnabled(boardID: boardID, enabled: $0) }
                )
            )
            Text("Add a quick navigation card to jump to any list and keep it centered when opening the board.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func completionCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "Clear completed button",
                isOn: Binding(
                    get: { !board.clearCompletedDisabled },
                    set: {
                        _ = model.setBoardClearCompletedEnabled(
                            boardID: boardID,
                            enabled: $0
                        )
                    }
                )
            )
            Text("When the global Completed view is off, show the destructive Clear completed action for this board.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func relaysCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Nostr relays")
                .font(.headline)

            VStack(spacing: 8) {
                ForEach(board.effectiveRelayURLs, id: \.self) { relayURL in
                    HStack(spacing: 10) {
                        Image(systemName: "network")
                            .foregroundStyle(TaskifyTheme.accent)
                        Text(relayURL)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button(role: .destructive) {
                            removeRelay(relayURL, from: board)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                        }
                        .buttonStyle(.borderless)
                        .disabled(board.effectiveRelayURLs.count <= 1)
                        .accessibilityLabel("Remove \(relayURL)")
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 42)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TaskifyTheme.border, lineWidth: 1)
                    )
                }
            }

            HStack(spacing: 8) {
                TextField("wss://relay.example", text: $newRelayURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.done)
                    .onSubmit { addRelay(to: board) }
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TaskifyTheme.border, lineWidth: 1)
                    )

                Button("Add") { addRelay(to: board) }
                    .buttonStyle(.borderedProminent)
                    .disabled(newRelayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Button("Restore Taskify defaults") {
                guard model.updateBoardRelayURLs(
                    boardID: board.id,
                    relayURLs: TaskifyRelayDefaults.urls
                ) else { return }
                relayMessage = "Default relays restored."
            }
            .buttonStyle(.bordered)
            .disabled(board.effectiveRelayURLs == TaskifyRelayDefaults.urls)

            if let relayMessage {
                Text(relayMessage)
                    .font(.caption)
                    .foregroundStyle(relayMessage.hasPrefix("Invalid") || relayMessage.hasPrefix("Keep")
                        ? Color.red
                        : TaskifyTheme.secondaryText)
            }

            Text("Relay changes apply immediately, migrate queued publishes, and sync in this board's share metadata. Secure wss:// relays are recommended.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func syncRecoveryCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Sync recovery")
                    .font(.headline)
                Spacer()
                if recoveryBusy { ProgressView().controlSize(.small) }
            }

            Button {
                runRecoveryAction {
                    try await model.resyncBoardHistory(boardID: boardID)
                    return "Relay history re-sync started."
                }
            } label: {
                Label("Re-sync relay history", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            Button {
                runRecoveryAction {
                    let result = try await model.republishBoardSnapshot(boardID: boardID)
                    return "Queued \(result.publishedRecordCount) current board record\(result.publishedRecordCount == 1 ? "" : "s") for republishing."
                }
            } label: {
                Label("Republish current snapshot", systemImage: "icloud.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            Button {
                runRecoveryAction {
                    let result = try await model.cleanStaleBoardEvents(boardID: boardID)
                    if result.staleEventCount == 0 {
                        return "No stale task versions found across \(result.respondingRelayCount) responding relay\(result.respondingRelayCount == 1 ? "" : "s")."
                    }
                    return "Queued deletion requests for \(result.staleEventCount) stale task version\(result.staleEventCount == 1 ? "" : "s")."
                }
            } label: {
                Label("Clean up stale task versions", systemImage: "eraser")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            Button(role: .destructive) {
                showingRegenerateBoardIDConfirmation = true
            } label: {
                Label("Generate new board ID", systemImage: "key.horizontal")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            if let recoveryMessage {
                Text(recoveryMessage)
                    .font(.caption)
                    .foregroundStyle(recoveryMessage.hasPrefix("Could not") ? Color.orange : TaskifyTheme.secondaryText)
            }
            Text("Use re-sync when relay content seems incomplete. Republish repairs missing current records. A new ID is a last resort that intentionally creates a new sync namespace.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func runRecoveryAction(
        _ operation: @escaping @MainActor () async throws -> String
    ) {
        guard !recoveryBusy else { return }
        recoveryBusy = true
        recoveryMessage = nil
        Task {
            defer { recoveryBusy = false }
            do { recoveryMessage = try await operation() }
            catch { recoveryMessage = "Could not complete recovery: \(error.localizedDescription)" }
        }
    }

    private func archiveCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if board.archived {
                Button {
                    guard model.unarchiveBoard(boardID: boardID) else { return }
                    dismiss()
                } label: {
                    Label("Restore board", systemImage: "tray.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            } else {
                Button {
                    if model.archiveBoard(boardID: boardID) {
                        dismiss()
                    } else {
                        showingArchiveBlocked = true
                    }
                } label: {
                    Label("Archive board", systemImage: "archivebox")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            Text("Archiving is local to this device and can be reversed from Settings.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var deleteCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(role: .destructive) {
                showingDeleteConfirmation = true
            } label: {
                Label("Delete board", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            Text("Deleting removes this board and its locally stored tasks from this device.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func addRelay(to board: Board) {
        guard let normalized = TaskifyRelayURL.normalize(newRelayURL) else {
            relayMessage = "Invalid relay. Enter a ws:// or wss:// address."
            return
        }
        guard !board.effectiveRelayURLs.contains(normalized) else {
            relayMessage = "That relay is already configured."
            return
        }
        guard model.updateBoardRelayURLs(
            boardID: board.id,
            relayURLs: board.effectiveRelayURLs + [normalized]
        ) else {
            relayMessage = "Invalid relay configuration."
            return
        }
        newRelayURL = ""
        relayMessage = "Relay added and sync is reconnecting."
    }

    private func removeRelay(_ relayURL: String, from board: Board) {
        let remaining = board.effectiveRelayURLs.filter { $0 != relayURL }
        guard !remaining.isEmpty else {
            relayMessage = "Keep at least one relay for board sync."
            return
        }
        guard model.updateBoardRelayURLs(
            boardID: board.id,
            relayURLs: remaining
        ) else {
            relayMessage = "Invalid relay configuration."
            return
        }
        relayMessage = "Relay removed and queued changes were updated."
    }

    private func boardKindName(_ kind: BoardKind) -> String {
        switch kind {
        case .week: "Weekly"
        case .list: "Lists"
        case .compound: "Compound"
        case .bible: "Bible"
        }
    }
}

private struct CompoundBoardManagerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let boardID: String

    private var board: Board? {
        model.board(withID: boardID)
    }

    private var linkedBoards: [Board] {
        model.compoundChildBoards(for: boardID)
    }

    private var availableBoards: [Board] {
        model.visibleBoards.filter { candidate in
            candidate.kind == .list && !isIncluded(candidate)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                if let board {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            settingsCard(board)
                            linkedBoardsCard
                            if !availableBoards.isEmpty {
                                addBoardCard
                            }
                        }
                        .padding(18)
                    }
                } else {
                    ContentUnavailableView("Board unavailable", systemImage: "exclamationmark.triangle")
                }
            }
            .navigationTitle(board?.name ?? "Compound board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private func settingsCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "List index card",
                isOn: Binding(
                    get: { board.indexCardEnabled },
                    set: { _ = model.setBoardIndexCardEnabled(boardID: boardID, enabled: $0) }
                )
            )
            Text("Quickly jump between lists across all linked boards.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            Divider()
                .padding(.vertical, 4)

            Toggle(
                "Hide board names in column headers",
                isOn: Binding(
                    get: { board.hideChildBoardNames },
                    set: { _ = model.setCompoundHideChildBoardNames(boardID: boardID, hidden: $0) }
                )
            )
            Text("When off, each list shows the child board it came from.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var linkedBoardsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Linked boards")
                .font(.headline)

            if linkedBoards.isEmpty {
                Text("No list boards linked yet.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            VStack(spacing: 8) {
                ForEach(Array(linkedBoards.enumerated()), id: \.element.id) { index, child in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(child.name)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text("\(child.columns.count) lists")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }

                        Spacer()

                        Button {
                            _ = model.moveCompoundChild(
                                boardID: boardID,
                                childBoardID: child.id,
                                direction: -1
                            )
                        } label: {
                            Image(systemName: "arrow.up")
                        }
                        .buttonStyle(.borderless)
                        .disabled(index == 0)

                        Button {
                            _ = model.moveCompoundChild(
                                boardID: boardID,
                                childBoardID: child.id,
                                direction: 1
                            )
                        } label: {
                            Image(systemName: "arrow.down")
                        }
                        .buttonStyle(.borderless)
                        .disabled(index == linkedBoards.count - 1)

                        Button(role: .destructive) {
                            _ = model.setCompoundChild(
                                boardID: boardID,
                                childBoardID: child.id,
                                included: false
                            )
                        } label: {
                            Image(systemName: "minus.circle.fill")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(child.name)")
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 42)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TaskifyTheme.border, lineWidth: 1)
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var addBoardCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add a list board")
                .font(.headline)

            VStack(spacing: 8) {
                ForEach(availableBoards) { child in
                    Button {
                        _ = model.setCompoundChild(
                            boardID: boardID,
                            childBoardID: child.id,
                            included: true
                        )
                    } label: {
                        Label(child.name, systemImage: "plus.circle.fill")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func isIncluded(_ child: Board) -> Bool {
        board?.children.contains(where: { child.matchesReference($0) }) == true
    }
}

struct BoardQRJoinFlow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onJoined: (() -> Void)?
    @State private var scannedShare: BoardSharePayload?
    @State private var rawShare = ""
    @State private var scanError: String?

    init(onJoined: (() -> Void)? = nil) {
        self.onJoined = onJoined
    }

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        NavigationStack {
            Group {
                if let scannedShare {
                    reviewView(scannedShare)
                } else if scannerAvailable {
                    scannerView
                } else {
                    unavailableView
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle(scannedShare == nil ? "Scan board" : "Join board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var scannerView: some View {
        ZStack(alignment: .bottom) {
            TaskifyBoardCodeScanner(
                onCode: handleScannedCode,
                onError: { scanError = $0 }
            )
            .ignoresSafeArea(edges: .bottom)

            VStack(spacing: 8) {
                Label("Point the camera at a Taskify board QR code", systemImage: "viewfinder")
                    .font(.subheadline.weight(.semibold))
                    .multilineTextAlignment(.center)

                if let scanError {
                    Text(scanError)
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                        .multilineTextAlignment(.center)
                } else {
                    Text("The board details will be shown for review before joining.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(TaskifyTheme.border, lineWidth: 1))
            .padding(16)
        }
    }

    private var unavailableView: some View {
        ContentUnavailableView {
            Label("Camera scanning unavailable", systemImage: "qrcode.viewfinder")
        } description: {
            Text("Use a supported iPhone with camera access, or paste the Taskify share into the board join field.")
        } actions: {
            Button("Use paste instead") { dismiss() }
                .buttonStyle(.borderedProminent)
        }
        .foregroundStyle(TaskifyTheme.primaryText)
    }

    private func reviewView(_ share: BoardSharePayload) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(spacing: 9) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(Color.green)
                    Text(share.boardName ?? "Shared Board")
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                    Text("Review this live board before joining.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                .frame(maxWidth: .infinity)

                detailCard(title: "BOARD ID", values: [share.boardID], icon: "number")
                detailCard(
                    title: "RELAYS",
                    values: share.relayURLs.isEmpty ? TaskifyRelayDefaults.urls : share.relayURLs,
                    icon: "antenna.radiowaves.left.and.right"
                )

                Button {
                    guard model.joinSharedBoard(shareText: rawShare, name: "") else { return }
                    onJoined?()
                    dismiss()
                } label: {
                    Label("Join live board", systemImage: "person.2.badge.plus")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .buttonStyle(.borderedProminent)

                Button("Scan a different code") {
                    rawShare = ""
                    scannedShare = nil
                    scanError = nil
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)
            }
            .padding(20)
        }
    }

    private func detailCard(title: String, values: [String], icon: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.system(size: 10, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
            ForEach(values, id: \.self) { value in
                Label(value, systemImage: icon)
                    .font(.caption.monospaced())
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15)
        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(TaskifyTheme.border, lineWidth: 1))
    }

    private func handleScannedCode(_ rawValue: String) {
        guard let share = BoardShareContract.decode(rawValue) else {
            scanError = "That QR code is not a valid Taskify board share."
            return
        }
        rawShare = rawValue
        scannedShare = share
        scanError = nil
    }
}

private struct TaskifyBoardCodeScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode, onError: onError)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        context.coordinator.scanner = scanner
        DispatchQueue.main.async {
            do {
                try scanner.startScanning()
            } catch {
                context.coordinator.onError("The camera scanner could not start. Check camera access in iOS Settings.")
            }
        }
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) {
        uiViewController.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        let onError: (String) -> Void
        weak var scanner: DataScannerViewController?

        init(onCode: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            self.onCode = onCode
            self.onError = onError
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems {
                guard case let .barcode(barcode) = item,
                      let value = barcode.payloadStringValue else {
                    continue
                }
                onCode(value)
                return
            }
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            onError("Camera scanning became unavailable. You can still paste the board share manually.")
        }
    }
}

private struct LocalBackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var json: String

    init(json: String) {
        self.json = json
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let json = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.json = json
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(json.utf8))
    }
}

private struct RelayStatusRow: View {
    let relay: TaskRelayStatus

    private var color: Color {
        switch relay.phase {
        case .online: .green
        case .syncing: TaskifyTheme.accent
        case .connecting: .orange
        case .offline: .red
        }
    }

    private var label: String {
        switch relay.phase {
        case .online: "Synced"
        case .syncing: "Loading"
        case .connecting: "Connecting"
        case .offline: "Unavailable"
        }
    }

    private var relayName: String {
        URL(string: relay.relayURL)?.host ?? relay.relayURL
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(relayName)
                    .font(.subheadline.monospaced())
                    .lineLimit(1)

                if let message = relay.message, !message.isEmpty {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }
            }

            Spacer()

            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 42)
        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(TaskifyTheme.border, lineWidth: 1)
        )
    }
}

private struct StatusRow: View {
    let title: String
    let status: String
    let complete: Bool

    var body: some View {
        HStack {
            Image(systemName: complete ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(complete ? Color.green : TaskifyTheme.secondaryText)
            Text(title)
            Spacer()
            Text(status)
                .font(.caption.weight(.semibold))
                .foregroundStyle(complete ? Color.green : TaskifyTheme.secondaryText)
        }
    }
}
