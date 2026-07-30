import SwiftUI
import TaskifyCore
import UIKit
import VisionKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var newBoardName = ""
    @State private var newBoardKind: BoardKind = .week
    @State private var selectedCompoundChildIDs: Set<String> = []
    @State private var managingBoard: Board?
    @State private var managingCompoundBoard: Board?
    @State private var sharedBoardID = ""
    @State private var sharedBoardName = ""
    @State private var showingBoardScanner = false
    @State private var identityInput = ""
    @State private var showingAddFileServer = false
    @State private var newFileServerType: TaskifyFileServerType = .originless
    @State private var newFileServerURL = ""
    @State private var fileServerMessage: String?
    @State private var newAppRelayURL = ""
    @State private var appRelayMessage: String?
    @State private var showingClearChatHistoryConfirmation = false
    @AppStorage(TaskPresentationSettings.completedTabKey)
    private var completedTabEnabled = TaskPresentationSettings.completedTabDefault
    @AppStorage(TaskPresentationSettings.hideCompletedSubtasksKey)
    private var hideCompletedSubtasks = TaskPresentationSettings.hideCompletedSubtasksDefault

    var body: some View {
        // @Environment values aren't bindable directly; @Bindable re-wraps the same model
        // reference so `$model.pendingAccountBackup` below still works post-@Observable.
        @Bindable var model = model

        return VStack(alignment: .leading, spacing: 10) {
            Text("Settings")
                .taskifyScreenTitle()
                .padding(.horizontal, 18)
                .padding(.top, 14)

            ScrollView {
                VStack(spacing: 18) {
                    identityCard
                    syncCard
                    storageCard
                    chatHistoryCard
                    walletCurrencyCard
                    boardsCard
                    bibleTrackerCard
                    fastingRemindersCard
                    scriptureMemoryCard
                    streaksCard
                    taskPresentationCard
                    taskOrderingCard
                    startupTabCard
                    notificationsCard
                    migrationCard
                    appearanceCard
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 18)
            }
            .scrollIndicators(.hidden)
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
        .sheet(item: $model.pendingAccountBackup) { payload in
            PWAAccountBackupReviewSheet(payload: payload)
                .environment(model)
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

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nostr identity")
                .font(.headline)

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

            Button {
                model.findPWAAccountBackup()
            } label: {
                if model.isCheckingAccountBackup {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Checking for PWA backup…")
                    }
                } else {
                    Label("Find PWA account backup", systemImage: "arrow.triangle.2.circlepath.icloud")
                }
            }
            .buttonStyle(.bordered)
            .disabled(model.identityNpub.isEmpty || model.isCheckingAccountBackup)

            if let message = model.accountBackupMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            Text("After a backup is restored, native board additions, names, lists, archive state, and relay changes are written back through the same encrypted PWA backup. Wallet data and unsupported fields are preserved unchanged.")
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

            Text("Originless is recommended for encrypted blobs. A self-hosted or permissive Blossom server also works, but many public Blossom servers reject opaque encrypted uploads. NIP-96 servers currently upload the same way as Originless (real NIP-96 authentication isn't implemented yet). Attachments remain limited to 50 MB because this version encrypts and validates each complete file in memory before upload.")
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

            if model.walletConversionEnabled {
                Divider()

                Text("Primary currency")
                    .font(.subheadline.weight(.semibold))
                Picker(
                    "Primary currency",
                    selection: Binding(
                        get: { model.walletPrimaryCurrency },
                        set: { model.setWalletPrimaryCurrency($0) }
                    )
                ) {
                    Text("Sats").tag(WalletPrimaryCurrency.sat)
                    Text("USD").tag(WalletPrimaryCurrency.usd)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

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
            Text("Boards & Lists")
                .font(.headline)

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

                Text("Add passages from the Bible board. Taskify schedules one review task at a time, spacing it out further each time you review it.")
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
            Text("Task cards & completed items")
                .font(.headline)

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
            Text("New task position")
                .font(.headline)

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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var startupTabCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Launch tab")
                .font(.headline)

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

    private var migrationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Native app status")
                .font(.headline)

            StatusRow(title: "Offline task storage", status: "Active", complete: true)
            StatusRow(title: "Weekly boards", status: "Active", complete: true)
            StatusRow(title: "List boards & rich task editing", status: "Active", complete: true)
            StatusRow(title: "Compound boards", status: "Active", complete: true)
            StatusRow(title: "Bible reading tracker", status: "Active (no print/scan)", complete: true)
            StatusRow(title: "Fasting reminders", status: "Active", complete: true)
            StatusRow(title: "Scripture memory", status: "Active", complete: true)
            StatusRow(title: "Task streaks", status: "Active", complete: true)
            StatusRow(title: "Recurrence & native reminders", status: "Active", complete: true)
            StatusRow(title: "Nostr sync", status: model.syncStatus, complete: model.syncIsOnline)
            StatusRow(title: "PWA account backup continuity", status: "Active", complete: true)
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
        HStack(spacing: 14) {
            Image(systemName: "moon.stars.fill")
                .font(.title2)
                .foregroundStyle(TaskifyTheme.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text("PWA-inspired dark appearance")
                    .font(.headline)
                Text("Native materials, Dynamic Type, and VoiceOver are enabled.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }
}

private struct PWAAccountBackupReviewSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let payload: NostrAppBackupPayload

    private var review: NostrAppBackupReview {
        NostrAppBackupReview(payload: payload, currentBoards: model.snapshot.boards)
    }

    private var backupDate: Date {
        Date(timeIntervalSince1970: TimeInterval(payload.timestamp))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        summaryCard
                        boardsCard
                        if review.containsWalletSeed || review.containsPWASettings {
                            safetyCard
                        }

                        Button {
                            model.applyPendingPWAAccountBackup()
                            dismiss()
                        } label: {
                            Label("Add compatible boards", systemImage: "square.and.arrow.down")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(review.importableBoardCount == 0 && review.alreadyConnectedBoardCount == 0)
                    }
                    .padding(18)
                }
            }
            .navigationTitle("Restore from PWA")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") {
                        model.dismissPWAAccountBackup()
                        dismiss()
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("PWA backup found")
                .font(.headline)

            VStack(alignment: .leading, spacing: 10) {
                LabeledContent("Backup date", value: backupDate.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Boards to add", value: "\(review.importableBoardCount)")
                LabeledContent("Already connected", value: "\(review.alreadyConnectedBoardCount)")
                LabeledContent("Relay addresses", value: "\(review.relayCount)")
                if review.unsupportedBoardCount > 0 {
                    LabeledContent("Not yet supported", value: "\(review.unsupportedBoardCount)")
                }
            }
            .font(.subheadline)

            Text("Import adds compatible boards and relay settings. It does not delete native boards or tasks.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var boardsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Boards")
                .font(.headline)

            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(payload.boards.enumerated()), id: \.offset) { _, board in
                    HStack(spacing: 12) {
                        Image(systemName: board.kind == .compound ? "square.stack.3d.up" : "rectangle.3.group")
                            .foregroundStyle(board.kind == .bible ? TaskifyTheme.tertiaryText : TaskifyTheme.accent)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(board.name?.isEmpty == false ? board.name! : "Shared Board")
                            Text(board.kind == .bible ? "Bible board • not imported yet" : boardKindLabel(board.kind))
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var safetyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Kept separate for safety")
                .font(.headline)
            if review.containsWalletSeed {
                Label("Wallet seed stays encrypted and is not imported", systemImage: "lock.shield")
                    .font(.subheadline)
            }
            if review.containsPWASettings {
                Label("PWA-only appearance and device settings are not imported", systemImage: "slider.horizontal.3")
                    .font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func boardKindLabel(_ kind: BoardKind?) -> String {
        switch kind ?? .list {
        case .week: "Weekly board"
        case .list: "List board"
        case .compound: "Compound board"
        case .bible: "Bible board"
        }
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

private struct BoardQRJoinFlow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var scannedShare: BoardSharePayload?
    @State private var rawShare = ""
    @State private var scanError: String?

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
