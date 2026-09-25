import SwiftUI
import TaskifyCore
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Solife forwarding

/// Forward a custom solife.me address to the user's own wallet over an NWC connection
/// (the same feature as the PWA's Address view).
struct SolifeNWCForwardControl: View {
    @ObservedObject var wallet: WalletViewModel
    let address: SolifeAddress
    @State private var editing = false
    @State private var connection = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let forward = address.nwcForward {
                Label("Payments go to \(forward.walletAlias ?? "your NWC wallet")", systemImage: "arrow.turn.down.right")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.primaryText)
                if forward.canSpend {
                    Text("This connection can also spend from your wallet. solife.me only uses it to create invoices, but a receive-only connection means nothing can spend even if the server were compromised.")
                        .font(.caption2).foregroundStyle(.orange)
                }
                if let lastError = forward.lastError {
                    Text("Last payment attempt failed: \(lastError). Check that the wallet is online.")
                        .font(.caption2).foregroundStyle(.orange)
                }
                Button("Stop forwarding") {
                    Task { await run { try await wallet.clearSolifeNWCForward(handle: address.handle) } }
                }
                .font(.caption.weight(.semibold))
                .disabled(busy)
            } else if editing {
                Text("For tighter permissions, paste a separate receive-only NWC connection. solife.me only uses it to create invoices and never to pay.")
                    .font(.caption2).foregroundStyle(TaskifyTheme.secondaryText)
                TextField("nostr+walletconnect://…", text: $connection, axis: .vertical)
                    .font(.caption.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(10)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                HStack {
                    Button(busy ? "Checking…" : "Forward payments") {
                        Task {
                            await run { try await wallet.setSolifeNWCForward(handle: address.handle, connection: connection) }
                            if error == nil { editing = false; connection = "" }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || connection.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("Cancel") { editing = false }.disabled(busy)
                }
                .font(.caption)
            } else {
                if wallet.isNWCWalletActive {
                    Button {
                        Task { await run { try await wallet.shareActiveNWCWithSolife(handle: address.handle) } }
                    } label: {
                        Label("Use (wallet.nwcWalletLabel)", systemImage: "bolt.horizontal.circle.fill")
                    }
                    .font(.caption.weight(.semibold))
                    .disabled(busy)
                    Text("Opt in to let solife.me use this wallet connection for invoice creation. It cannot initiate payments through Taskify.")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                Button(wallet.isNWCWalletActive ? "Use a separate receive-only connection…" : "Add a receive-only wallet connection…") {
                    editing = true
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
            if let error {
                Text(error).font(.caption2).foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func run(_ action: () async throws -> Void) async {
        busy = true
        error = nil
        do {
            try await action()
        } catch {
            self.error = WalletViewModel.message(for: error)
        }
        busy = false
    }
}

// MARK: - Wallet mode sheet

struct NWCWalletModeSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var connectionText = ""
    @State private var localError: String?
    @State private var confirmSkip = false
    @State private var ranMigration = false

    private var ecashTotal: UInt64 { wallet.ecashMintBalances.reduce(0) { $0 + $1.available } }
    private var journal: SweepJournal? {
        guard let journal = wallet.nwcMigrationJournal else { return nil }
        return ranMigration || journal.status != .completed ? journal : nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    if !wallet.nwcConnected {
                        connectView
                    } else if let missing = wallet.nwcStatus?.missingMethods, !missing.isEmpty {
                        card {
                            Text("\(wallet.nwcWalletLabel) doesn't allow \(missing.joined(separator: " and ")), which Taskify needs to send and receive. Create a connection with send and receive permissions.")
                                .foregroundStyle(.orange)
                            Button("Disconnect", role: .destructive) { Task { await wallet.disconnectNWC() } }
                        }
                    } else if wallet.walletMode == .nwc {
                        nwcActiveView
                    } else {
                        switchView
                    }
                }
                .padding(22)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Wallet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.disabled(wallet.isMovingToNWC)
                }
            }
            .alert("Wallet", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(wallet.isMovingToNWC)
        .task { await wallet.refreshNWC() }
    }

    private var connectView: some View {
        VStack(spacing: 16) {
            card {
                Text("Use your own lightning wallet over Nostr Wallet Connect (NWC) instead of Taskify's ecash wallet. Payments you send and receive go straight to that wallet.")
                Text("In your wallet, create an NWC connection that can send and receive, then paste it here.")
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
            TextField("nostr+walletconnect://…", text: $connectionText, axis: .vertical)
                .accessibilityIdentifier("nwc-connection-field")
                .font(.caption.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            HStack(spacing: 12) {
                Button {
                    if let pasted = UIPasteboard.general.string { connectionText = pasted }
                } label: {
                    Label("Paste", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity).frame(height: 46)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
            }
            WalletPrimaryActionButton(title: "Connect", busyTitle: "Connecting…", isBusy: wallet.isWorking) {
                Task {
                    do {
                        try await wallet.connectNWC(uri: connectionText)
                        connectionText = ""
                    } catch {
                        localError = WalletViewModel.message(for: error)
                    }
                }
            }
            .disabled(connectionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || wallet.isWorking)
        }
    }

    private var switchView: some View {
        VStack(spacing: 16) {
            card {
                Text("Switch to **\(wallet.nwcWalletLabel)**? Sending and receiving will use it, and only lightning payments will show. Ecash sent to you is kept as tokens you can move to \(wallet.nwcWalletLabel) or redeem elsewhere.")
            }
            if ecashTotal > 0 {
                card {
                    walletFieldLabel("ECASH BALANCE")
                    ForEach(wallet.ecashMintBalances) { mint in
                        HStack {
                            Text(URL(string: mint.url)?.host() ?? mint.url).lineLimit(1)
                            Spacer()
                            Text(wallet.formattedSats(mint.available)).monospacedDigit()
                        }
                    }
                    Text("Moving pays each mint's lightning fee. A few sats of returned fee reserve may stay in ecash.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                progress
                WalletPrimaryActionButton(
                    title: journal.map { $0.status == .completed ? "Move \(wallet.formattedSats(ecashTotal)) and switch" : "Try again" }
                        ?? "Move \(wallet.formattedSats(ecashTotal)) and switch",
                    busyTitle: "Moving…",
                    isBusy: wallet.isMovingToNWC
                ) {
                    Task { await migrate(thenSwitch: true) }
                }
                .disabled(wallet.isMovingToNWC)
                if confirmSkip {
                    card {
                        Text("Your \(wallet.formattedSats(ecashTotal)) stays in Taskify's ecash wallet. You won't see it while using \(wallet.nwcWalletLabel); switch back to spend or move it.")
                        HStack {
                            Button("Switch without moving") { switchTo(.nwc) }.buttonStyle(.borderedProminent)
                            Button("Cancel") { confirmSkip = false }
                        }
                    }
                } else {
                    Button("Switch without moving funds") { confirmSkip = true }
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .disabled(wallet.isMovingToNWC)
                }
            } else {
                progress
                WalletPrimaryActionButton(title: "Use \(wallet.nwcWalletLabel)") { switchTo(.nwc) }
            }
            Button("Disconnect \(wallet.nwcWalletLabel)", role: .destructive) { Task { await wallet.disconnectNWC() } }
                .font(.subheadline)
                .disabled(wallet.isMovingToNWC)
        }
    }

    private var nwcActiveView: some View {
        VStack(spacing: 16) {
            card {
                Text("You're using **\(wallet.nwcWalletLabel)** for payments. Taskify's ecash wallet and its recovery phrase are kept; switch back any time.")
                if let balance = wallet.nwcStatus?.balanceSat {
                    WalletDetailRow(title: "Balance", value: wallet.formattedSats(balance))
                }
            }
            progress
            if ecashTotal > 0 {
                card {
                    Text("\(wallet.formattedSats(ecashTotal)) is still in the ecash wallet.")
                    WalletPrimaryActionButton(
                        title: "Move \(wallet.formattedSats(ecashTotal)) to \(wallet.nwcWalletLabel)",
                        busyTitle: "Moving…",
                        isBusy: wallet.isMovingToNWC
                    ) {
                        Task { await migrate(thenSwitch: false) }
                    }
                    .disabled(wallet.isMovingToNWC)
                }
            }
            Button("Switch back to ecash wallet") { switchTo(.ecash) }
                .disabled(wallet.isMovingToNWC)
            Button("Disconnect \(wallet.nwcWalletLabel)", role: .destructive) { Task { await wallet.disconnectNWC() } }
                .font(.subheadline)
                .disabled(wallet.isMovingToNWC)
        }
    }

    @ViewBuilder
    private var progress: some View {
        if let journal {
            card {
                walletFieldLabel("TRANSFER TO \(wallet.nwcWalletLabel.uppercased())")
                ForEach(journal.sources, id: \.sourceID) { source in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(URL(string: source.sourceID)?.host() ?? source.label).lineLimit(1)
                            Spacer()
                            Text(Self.label(for: source.status))
                                .foregroundStyle(source.status == .failed ? .red : TaskifyTheme.secondaryText)
                        }
                        if source.sentSat > 0 {
                            Text("Sent \(wallet.formattedSats(source.sentSat)) · fees \(wallet.formattedSats(source.feesSat))")
                                .font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        if source.status == .awaitingSettlement {
                            Text("The mint hasn't finished this payment. Your funds are safe; check again in a few minutes.")
                                .font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        if let error = source.error {
                            Text(error).font(.caption).foregroundStyle(.red)
                        }
                    }
                }
                let summary = journal.summary
                if summary.unconfirmedSat > 0 {
                    Text("The mint reports \(wallet.formattedSats(summary.unconfirmedSat)) as paid, but \(wallet.nwcWalletLabel) hasn't confirmed receiving it. Check its history.")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    private static func label(for status: SweepSourceStatus) -> String {
        switch status {
        case .pending: "Waiting"
        case .inProgress: "Moving…"
        case .swept: "Moved"
        case .dust: "Too small to move"
        case .awaitingSettlement: "Still settling"
        case .failed: "Not moved"
        }
    }

    private func migrate(thenSwitch: Bool) async {
        confirmSkip = false
        ranMigration = true
        guard let journal = await wallet.migrateToNWC() else { return }
        if thenSwitch, journal.status == .completed { switchTo(.nwc) }
    }

    private func switchTo(_ mode: TaskifyWalletMode) {
        wallet.setWalletMode(mode)
        dismiss()
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10, content: content)
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.primaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .taskifyGlass(cornerRadius: 22)
    }
}

// MARK: - Multi-wallet management

/// Taskify's wallet switcher. The built-in ecash wallet is permanent; every NWC connection is a
/// separately named wallet with its own receive-address choice.
struct WalletManagerSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showingAddWallet = false
    @State private var editingWallet: NWCWalletSummary?
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    walletRow(
                        title: "Taskify eCash",
                        subtitle: "Built-in Cashu wallet",
                        systemImage: "bitcoinsign.circle.fill",
                        selected: !wallet.isNWCWalletActive
                    ) {
                        wallet.setWalletMode(.ecash)
                    }

                    ForEach(wallet.nwcWallets) { saved in
                        HStack(spacing: 10) {
                            Button {
                                Task {
                                    do { try await wallet.selectNWCWallet(id: saved.id) }
                                    catch { localError = WalletViewModel.message(for: error) }
                                }
                            } label: {
                                walletRowLabel(
                                    title: saved.name,
                                    subtitle: saved.displayedReceiveAddress ?? "Lightning via NWC",
                                    systemImage: "bolt.horizontal.circle.fill",
                                    selected: wallet.isNWCWalletActive && wallet.activeNWCWalletID == saved.id
                                )
                            }
                            .buttonStyle(.plain)

                            Button { editingWallet = saved } label: {
                                Image(systemName: "slider.horizontal.3")
                                    .font(.headline)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                    .frame(width: 44, height: 44)
                                    .taskifyGlassControl(in: Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Edit \(saved.name)")
                        }
                    }

                    Button { showingAddWallet = true } label: {
                        Label("Connect a Wallet", systemImage: "link.badge.plus")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .frame(height: 54)
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 18, style: .continuous), tint: TaskifyTheme.accent.opacity(0.38))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 8)
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Wallets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await wallet.refreshNWC() }
            .sheet(isPresented: $showingAddWallet) { NWCConnectWalletSheet(wallet: wallet) }
            .sheet(item: $editingWallet) { saved in NWCWalletEditorSheet(wallet: wallet, saved: saved) }
            .alert("Wallets", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
                Button("OK", role: .cancel) { localError = nil }
            } message: { Text(localError ?? "") }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private func walletRow(
        title: String,
        subtitle: String,
        systemImage: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            walletRowLabel(title: title, subtitle: subtitle, systemImage: systemImage, selected: selected)
        }
        .buttonStyle(.plain)
    }

    private func walletRowLabel(
        title: String,
        subtitle: String,
        systemImage: String,
        selected: Bool
    ) -> some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(selected ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                .frame(width: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline).foregroundStyle(TaskifyTheme.primaryText)
                Text(subtitle).font(.caption).foregroundStyle(TaskifyTheme.secondaryText).lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected ? TaskifyTheme.accent : TaskifyTheme.tertiaryText)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(selected ? TaskifyTheme.accent : TaskifyTheme.border, lineWidth: selected ? 2 : 1)
        }
    }
}

private struct NWCConnectWalletSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var connection = ""
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Create an NWC connection with send and receive permissions in your lightning wallet, then paste it below.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                    walletFieldLabel("WALLET NAME")
                    TextField("Optional — e.g. Personal", text: $name)
                        .padding(14)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    walletFieldLabel("NWC CONNECTION")
                    TextField("nostr+walletconnect://…", text: $connection, axis: .vertical)
                        .font(.caption.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(14)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    Button {
                        if let pasted = UIPasteboard.general.string { connection = pasted }
                    } label: {
                        Label("Paste", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity).frame(height: 44)
                    }
                    .buttonStyle(.bordered)
                    WalletPrimaryActionButton(title: "Connect Wallet", busyTitle: "Connecting…", isBusy: wallet.isWorking) {
                        Task {
                            do {
                                try await wallet.connectNWC(uri: connection, name: name)
                                dismiss()
                            } catch { localError = WalletViewModel.message(for: error) }
                        }
                    }
                    .disabled(connection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || wallet.isWorking)
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Connect Wallet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .alert("Connect Wallet", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
                Button("OK", role: .cancel) { localError = nil }
            } message: { Text(localError ?? "") }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }
}

private struct NWCWalletEditorSheet: View {
    @ObservedObject var wallet: WalletViewModel
    let saved: NWCWalletSummary
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var address: String
    @State private var localError: String?
    @State private var confirmingDelete = false

    init(wallet: WalletViewModel, saved: NWCWalletSummary) {
        self.wallet = wallet
        self.saved = saved
        _name = State(initialValue: saved.name)
        _address = State(initialValue: saved.receiveAddress ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Wallet") {
                    TextField("Wallet name", text: $name)
                    LabeledContent("Connection", value: "Nostr Wallet Connect")
                }
                Section("Lightning Address") {
                    TextField("Use wallet address", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                    Text(address.isEmpty
                         ? "Taskify will show the address supplied by this wallet, if available."
                         : "This address is shown whenever this wallet is selected.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                Section {
                    Button("Disconnect Wallet", role: .destructive) { confirmingDelete = true }
                }
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Wallet Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await wallet.renameNWCWallet(id: saved.id, name: name)
                                try await wallet.setNWCReceiveAddress(address, for: saved.id)
                                dismiss()
                            } catch { localError = WalletViewModel.message(for: error) }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .confirmationDialog("Disconnect \(saved.name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Disconnect Wallet", role: .destructive) {
                    Task { await wallet.disconnectNWC(id: saved.id); dismiss() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes the NWC connection from this device. Funds remain in the lightning wallet.")
            }
            .alert("Wallet Settings", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
                Button("OK", role: .cancel) { localError = nil }
            } message: { Text(localError ?? "") }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }
}

// MARK: - Receive

struct NWCReceiveSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var step: Step = .address
    @State private var amountText = ""
    @State private var entryCurrency: WalletPrimaryCurrency = .sat
    @State private var invoice: NWCInvoice?
    @State private var invoiceAmount: UInt64 = 0
    @State private var received = false
    @State private var editingAddress = false
    @State private var addressDraft = ""
    @State private var localError: String?

    private enum Step { case address, amount, invoice }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    switch step {
                    case .address: addressView
                    case .amount: amountView
                    case .invoice: invoiceView
                    }
                }
                .padding(22)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Receive Lightning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .alert("Receive", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        .onAppear { entryCurrency = wallet.amountEntryCurrency }
        .task(id: invoice?.invoice) { await watchInvoice() }
    }

    private var addressView: some View {
        VStack(spacing: 18) {
            if let address = wallet.nwcReceiveAddress, !editingAddress {
                CashuQRCodeView(value: address, accessibilityLabel: "Lightning address QR code")
                    .frame(maxWidth: 280)
                Text(address).font(.headline).foregroundStyle(TaskifyTheme.primaryText)
                if address == wallet.nwcStatus?.connection.walletLightningAddress {
                    Text("Payments go to \(wallet.nwcWalletLabel).")
                        .font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                }
                HStack {
                    Button("Copy") { UIPasteboard.general.string = address }
                    Button("Change address") {
                        addressDraft = wallet.nwcReceiveAddressOverride ?? ""
                        editingAddress = true
                    }
                }
                .buttonStyle(.bordered)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text(wallet.nwcReceiveAddress == nil
                        ? "\(wallet.nwcWalletLabel) didn't share a lightning address. If it has one, enter it to show it here, or create an invoice for a specific amount."
                        : "Show a different lightning address for \(wallet.nwcWalletLabel).")
                        .font(.subheadline).foregroundStyle(TaskifyTheme.secondaryText)
                    TextField("you@example.com", text: $addressDraft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .padding(14)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    HStack {
                        Button("Save address") {
                            Task {
                                do {
                                    try await wallet.setNWCReceiveAddress(addressDraft)
                                    editingAddress = false
                                } catch {
                                    localError = WalletViewModel.message(for: error)
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(addressDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                        if wallet.nwcReceiveAddressOverride != nil {
                            Button("Use wallet's address") {
                                Task {
                                    try? await wallet.setNWCReceiveAddress(nil)
                                    editingAddress = false
                                }
                            }
                        }
                        if editingAddress { Button("Cancel") { editingAddress = false } }
                    }
                }
                .padding(18)
                .taskifyGlass(cornerRadius: 22)
            }
            WalletPrimaryActionButton(title: "Create invoice") { step = .amount }
        }
    }

    private var amountView: some View {
        VStack(spacing: 20) {
            WalletDetailRow(title: "Receive to", value: wallet.nwcWalletLabel)
                .padding(16)
                .taskifyGlass(cornerRadius: 18)
            WalletAmountDisplayCard(
                primary: wallet.entryPrimaryText(amountText, currency: entryCurrency),
                caption: "Enter amount to receive",
                secondary: wallet.entrySecondaryText(amountText, currency: entryCurrency),
                onToggleCurrency: wallet.currencyToggleAction(using: model) {
                    amountText = ""
                    entryCurrency = wallet.amountEntryCurrency
                }
            )
            WalletAmountKeypad(amountText: $amountText, allowsDecimal: entryCurrency == .usd)
            let sats = wallet.sats(fromEntry: amountText, currency: entryCurrency) ?? 0
            WalletPrimaryActionButton(title: "Create invoice", busyTitle: "Creating…", isBusy: wallet.isWorking) {
                Task {
                    do {
                        invoice = try await wallet.createNWCInvoice(amount: sats)
                        invoiceAmount = sats
                        step = .invoice
                    } catch {
                        localError = WalletViewModel.message(for: error)
                    }
                }
            }
            .disabled(sats == 0 || wallet.isWorking)
            Button("Back") { step = .address }.foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

    private var invoiceView: some View {
        VStack(spacing: 18) {
            if received {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 72)).foregroundStyle(.green)
                Text("Received \(wallet.formattedSats(invoiceAmount))").font(.title2.bold())
                WalletPrimaryActionButton(title: "Done") { dismiss() }
            } else if let invoice {
                CashuQRCodeView(value: invoice.invoice, accessibilityLabel: "Lightning invoice QR code")
                    .frame(maxWidth: 280)
                WalletDetailRow(title: "Amount", value: wallet.formattedSats(invoiceAmount))
                WalletDetailRow(title: "Wallet", value: wallet.nwcWalletLabel)
                Button("Copy invoice") { UIPasteboard.general.string = invoice.invoice }.buttonStyle(.bordered)
                Label("Waiting for payment…", systemImage: "clock").font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                Button("New invoice") {
                    self.invoice = nil
                    step = .amount
                }
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
    }

    private func watchInvoice() async {
        guard let invoice else { return }
        while !Task.isCancelled, !received {
            if await wallet.isNWCInvoiceSettled(invoice) {
                received = true
                wallet.statusMessage = "Received \(wallet.formattedSats(invoiceAmount))"
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await wallet.refreshNWC()
                return
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }
}

// MARK: - Send

struct NWCSendSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var destination = ""
    @State private var amountText = ""
    @State private var entryCurrency: WalletPrimaryCurrency = .sat
    @State private var step: Step = .destination
    @State private var resolvedInvoice: String?
    @State private var resolvedAmount: UInt64?
    @State private var paid: NWCPayment?
    @State private var isResolving = false
    @State private var showingScanner = false
    @State private var showingContactPicker = false
    @State private var localError: String?

    private enum Step { case destination, amount, confirm }

    private var trimmed: String { destination.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isAddress: Bool { LnurlPayClient.isLightningAddress(trimmed) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if let paid {
                        successView(paid)
                    } else {
                        switch step {
                        case .destination: destinationView
                        case .amount: amountView
                        case .confirm: confirmView
                        }
                    }
                }
                .padding(22)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Pay Lightning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.disabled(wallet.isWorking) }
            }
            .alert("Lightning payment", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(wallet.isWorking || isResolving)
        .onAppear { entryCurrency = wallet.amountEntryCurrency }
        .sheet(isPresented: $showingScanner) {
            CashuTokenScannerSheet(lightningInvoice: { value in
                destination = value
                showingScanner = false
            })
        }
        .sheet(isPresented: $showingContactPicker) {
            WalletContactPickerSheet(title: "Pay a contact", isSelectable: { _ in true }, unavailableNote: "") { contact in
                destination = WalletContactPayment.lightningAddress(lud16: contact.profile?.lud16, npub: contact.npub)
            }
        }
    }

    private var destinationView: some View {
        VStack(spacing: 18) {
            walletFieldLabel("SEND TO")
            TextField("Invoice or lightning address", text: $destination, axis: .vertical)
                .accessibilityIdentifier("nwc-send-destination")
                .font(.caption.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .frame(minHeight: 90, alignment: .topLeading)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            HStack(spacing: 12) {
                pill("Scan", "qrcode.viewfinder") { showingScanner = true }
                pill("Paste", "doc.on.clipboard") { destination = UIPasteboard.general.string ?? destination }
                pill("Contacts", "person.crop.circle") { showingContactPicker = true }
            }
            WalletDetailRow(title: "Pay from", value: wallet.nwcWalletLabel)
                .padding(16)
                .taskifyGlass(cornerRadius: 18)
            WalletPrimaryActionButton(title: isAddress ? "Continue" : "Review payment", busyTitle: "Checking…", isBusy: isResolving) {
                if isAddress {
                    step = .amount
                } else {
                    Task { await resolve(amount: nil) }
                }
            }
            .disabled(trimmed.isEmpty || isResolving)
        }
    }

    private var amountView: some View {
        VStack(spacing: 20) {
            WalletDetailRow(title: "Send to", value: trimmed).padding(16).taskifyGlass(cornerRadius: 18)
            WalletAmountDisplayCard(
                primary: wallet.entryPrimaryText(amountText, currency: entryCurrency),
                caption: "Enter amount to send",
                secondary: wallet.entrySecondaryText(amountText, currency: entryCurrency),
                onToggleCurrency: wallet.currencyToggleAction(using: model) {
                    amountText = ""
                    entryCurrency = wallet.amountEntryCurrency
                }
            )
            WalletAmountKeypad(amountText: $amountText, allowsDecimal: entryCurrency == .usd)
            let sats = wallet.sats(fromEntry: amountText, currency: entryCurrency) ?? 0
            WalletPrimaryActionButton(title: "Review payment", busyTitle: "Resolving address…", isBusy: isResolving) {
                Task { await resolve(amount: sats) }
            }
            .disabled(sats == 0 || isResolving)
            Button("Back") { step = .destination }.foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

    private var confirmView: some View {
        VStack(spacing: 20) {
            if let amount = resolvedAmount {
                WalletAmountHero(label: "AMOUNT", amount: wallet.displayAmount(forSats: amount).primary,
                                 secondary: wallet.displayAmount(forSats: amount).secondary)
            }
            VStack(spacing: 12) {
                WalletDetailRow(title: "To", value: isAddress ? trimmed : "Lightning invoice")
                WalletDetailRow(title: "Paid by", value: wallet.nwcWalletLabel)
                if let balance = wallet.nwcStatus?.balanceSat {
                    WalletDetailRow(title: "Wallet balance", value: wallet.formattedSats(balance))
                }
            }
            .padding(18)
            .taskifyGlass(cornerRadius: 22)
            WalletPrimaryActionButton(
                title: "Pay \(resolvedAmount.map(wallet.formattedSats) ?? "")",
                busyTitle: "Paying…",
                isBusy: wallet.isWorking,
                systemImage: "bolt.fill"
            ) {
                guard let invoice = resolvedInvoice else { return }
                Task {
                    do {
                        paid = try await wallet.payWithNWC(invoice: invoice)
                    } catch {
                        localError = WalletViewModel.message(for: error)
                    }
                }
            }
            .disabled(wallet.isWorking)
            Button("Back") {
                resolvedInvoice = nil
                step = isAddress ? .amount : .destination
            }
            .foregroundStyle(TaskifyTheme.secondaryText)
            .disabled(wallet.isWorking)
        }
    }

    private func successView(_ payment: NWCPayment) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 72)).foregroundStyle(.green)
            Text("Payment sent").font(.title2.bold())
            if let amount = resolvedAmount {
                Text(wallet.formattedSats(amount)).font(.title.bold())
            }
            if let fees = payment.feesPaidMsat {
                WalletDetailRow(title: "Fee paid", value: wallet.formattedSats(fees / 1_000))
                    .padding(16).taskifyGlass(cornerRadius: 18)
            }
            WalletPrimaryActionButton(title: "Done") { dismiss() }
        }
    }

    private func resolve(amount: UInt64?) async {
        isResolving = true
        defer { isResolving = false }
        do {
            if isAddress {
                let resolution = try await LnurlPayClient.resolveInvoice(address: trimmed, amountSats: amount ?? 0)
                resolvedInvoice = resolution.invoice
                resolvedAmount = resolution.amountSats
            } else {
                let invoice = try CashuWalletService.normalizedLightningInvoice(trimmed)
                guard let msat = try Bolt11Amount.millisatoshis(invoice) else {
                    throw NWCError.invalidConnection("This invoice has no amount. Ask for an invoice with an amount.")
                }
                resolvedInvoice = invoice
                resolvedAmount = msat / 1_000
            }
            step = .confirm
        } catch {
            localError = WalletViewModel.message(for: error)
        }
    }

    private func pill(_ title: String, _ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .frame(maxWidth: .infinity).frame(height: 46)
                .taskifyGlassControl(in: Capsule())
        }
        .buttonStyle(.plain)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(TaskifyTheme.primaryText)
    }
}

// MARK: - Saved ecash tokens

struct NWCTokensSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var states: [String: TokenState] = [:]
    @State private var confirmRemove: CashuPendingReceive?

    enum TokenState: Equatable { case checking, unclaimed, claimed, unknown }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Ecash sent to you is kept here as tokens, not claimed into a wallet. Move them to \(wallet.nwcWalletLabel), or copy a token to redeem it in another ecash wallet.")
                        .font(.footnote).foregroundStyle(TaskifyTheme.secondaryText)
                }
                if wallet.pendingEcashReceives.isEmpty {
                    Text("No ecash tokens.").foregroundStyle(TaskifyTheme.secondaryText)
                }
                ForEach(wallet.pendingEcashReceives) { pending in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(wallet.formattedSats(pending.amount)).font(.headline)
                            Spacer()
                            Text(label(states[pending.id])).font(.caption)
                                .foregroundStyle(states[pending.id] == .unclaimed ? .green : TaskifyTheme.secondaryText)
                        }
                        Text(URL(string: pending.mintURL)?.host() ?? pending.mintURL)
                            .font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                        HStack {
                            Button("Move to \(wallet.nwcWalletLabel)") {
                                Task { await wallet.moveTokenToNWC(pending) }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(wallet.isMovingToNWC || states[pending.id] == .claimed)
                            Button("Copy") { UIPasteboard.general.string = pending.token }
                                .buttonStyle(.bordered)
                            Button("Remove", role: .destructive) { confirmRemove = pending }
                                .buttonStyle(.bordered)
                        }
                        .font(.caption)
                    }
                    .padding(.vertical, 4)
                }
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Ecash tokens")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.disabled(wallet.isMovingToNWC) }
            }
            .overlay {
                if wallet.isMovingToNWC {
                    ProgressView("Moving…").padding(22).taskifyGlass(cornerRadius: 20)
                }
            }
            .confirmationDialog(
                "Remove this token?",
                isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
                presenting: confirmRemove
            ) { pending in
                Button("Remove", role: .destructive) {
                    Task { try? await wallet.discardPendingReceive(pending) }
                }
            } message: { pending in
                Text(states[pending.id] == .claimed
                    ? "This token was already claimed."
                    : "If this token hasn't been claimed, removing it loses \(wallet.formattedSats(pending.amount)) unless you've copied it.")
            }
        }
        .preferredColorScheme(.dark)
        .task(id: wallet.pendingEcashReceives.map(\.id)) { await checkStates() }
    }

    private func label(_ state: TokenState?) -> String {
        switch state {
        case .checking, nil: "Checking…"
        case .unclaimed: "Unclaimed"
        case .claimed: "Already claimed"
        case .unknown: "Couldn't reach mint"
        }
    }

    private func checkStates() async {
        for pending in wallet.pendingEcashReceives where states[pending.id] == nil {
            states[pending.id] = .checking
            do {
                _ = try await wallet.previewUnspentToken(pending.token)
                states[pending.id] = .unclaimed
            } catch CashuWalletError.pendingReceiveAlreadySpent {
                states[pending.id] = .claimed
            } catch {
                states[pending.id] = String(describing: error).localizedCaseInsensitiveContains("spent") ? .claimed : .unknown
            }
        }
    }
}

// MARK: - History

struct NWCHistorySheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var transactions: [NWCTransaction] = []
    @State private var message: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if let message {
                    Text(message).foregroundStyle(TaskifyTheme.secondaryText)
                }
                ForEach(transactions) { tx in
                    HStack {
                        Image(systemName: tx.direction == .incoming ? "arrow.down.circle.fill" : "arrow.up.circle.fill")
                            .foregroundStyle(tx.direction == .incoming ? .green : TaskifyTheme.accent)
                        VStack(alignment: .leading) {
                            Text(tx.description?.isEmpty == false ? tx.description! : (tx.direction == .incoming ? "Received" : "Sent"))
                                .lineLimit(1)
                            Text((tx.settledAt ?? tx.createdAt).formatted(date: .abbreviated, time: .shortened))
                                .font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        Spacer()
                        Text("\(tx.direction == .incoming ? "+" : "−")\(wallet.formattedSats(tx.amountSat))").monospacedDigit()
                    }
                }
            }
            .overlay { if loading { ProgressView() } }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("\(wallet.nwcWalletLabel) history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
        .task {
            do {
                transactions = try await wallet.nwcTransactions()
                if transactions.isEmpty { message = "No transactions yet." }
            } catch {
                message = "\(wallet.nwcWalletLabel) didn't share its history: \(WalletViewModel.message(for: error))"
            }
            loading = false
        }
    }
}
