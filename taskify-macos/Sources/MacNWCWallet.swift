import AppKit
import SwiftUI
import TaskifyCore
import UniformTypeIdentifiers

/// The wallet page while an NWC wallet replaces the ecash wallet: lightning only.
struct MacNWCWalletPanel: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @State private var action: String?
    @State private var editingAddress = false
    @State private var addressDraft = ""
    @State private var transactions: [NWCTransaction] = []
    @State private var historyMessage: String?
    @State private var removing: CashuPendingReceive?
    @State private var tokenStates: [String: String] = [:]
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 26) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(wallet.nwcWalletLabel.uppercased()) BALANCE").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(wallet.nwcStatus?.balanceSat.map { wallet.displayAmount(forSats: $0).primary }
                         ?? WalletViewModel.unknownBalanceText)
                        .font(.system(size: 42, weight: .semibold, design: .rounded))
                        .accessibilityLabel(wallet.nwcStatus?.balanceSat.map { "\(wallet.nwcWalletLabel) balance, \($0) sats" }
                            ?? "\(wallet.nwcWalletLabel) balance, \(wallet.nwcBalanceUnavailableReason ?? "loading")")
                    if let reason = wallet.nwcBalanceUnavailableReason {
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button { Task { await wallet.refreshNWC(); await loadHistory() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
            HStack {
                Button("Receive", systemImage: "arrow.down.left") { action = "receive" }.buttonStyle(.borderedProminent)
                Button("Pay Lightning", systemImage: "bolt") { action = "pay" }
            }.controlSize(.large)
            if let message = wallet.statusMessage { Label(message, systemImage: "checkmark.circle").foregroundStyle(.green) }
            if let error = error ?? wallet.errorMessage { Text(error).foregroundStyle(.red).textSelection(.enabled) }

            GroupBox("Your Lightning Address") {
                VStack(alignment: .leading, spacing: 8) {
                    if let address = wallet.nwcReceiveAddress, !editingAddress {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(address).textSelection(.enabled)
                                if address == wallet.nwcStatus?.connection.walletLightningAddress {
                                    Text("Payments go to \(wallet.nwcWalletLabel).").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Button("Copy") { macCopy(address) }
                            Button("Change…") { addressDraft = wallet.nwcReceiveAddressOverride ?? ""; editingAddress = true }
                        }
                    } else {
                        Text(wallet.nwcReceiveAddress == nil
                            ? "\(wallet.nwcWalletLabel) didn't share a lightning address. If it has one, enter it to show it here."
                            : "Show a different lightning address for \(wallet.nwcWalletLabel).")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            TextField("you@example.com", text: $addressDraft)
                            Button("Save") {
                                Task {
                                    do { try await wallet.setNWCReceiveAddress(addressDraft); editingAddress = false }
                                    catch { self.error = error.localizedDescription }
                                }
                            }.disabled(addressDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                            if wallet.nwcReceiveAddressOverride != nil {
                                Button("Use Wallet's Address") { Task { try? await wallet.setNWCReceiveAddress(nil); editingAddress = false } }
                            }
                            if editingAddress { Button("Cancel") { editingAddress = false } }
                        }
                    }
                }.padding(10)
            }

            if !wallet.pendingEcashReceives.isEmpty {
                GroupBox("Ecash Tokens") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Ecash sent to you is kept here as tokens, not claimed into a wallet. Move them to \(wallet.nwcWalletLabel), or copy a token to redeem it in another ecash wallet.")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(wallet.pendingEcashReceives) { pending in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(wallet.formattedSats(pending.amount))
                                    Text("\(URL(string: pending.mintURL)?.host() ?? pending.mintURL) · \(tokenStates[pending.id] ?? "Checking…")")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Move to \(wallet.nwcWalletLabel)") { Task { await wallet.moveTokenToNWC(pending) } }
                                    .disabled(wallet.isMovingToNWC || tokenStates[pending.id] == "Already claimed")
                                Button("Copy") { macCopy(pending.token) }
                                Button(role: .destructive) { removing = pending } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                            }
                        }
                        if wallet.isMovingToNWC { ProgressView("Moving…").controlSize(.small) }
                    }.padding(10)
                }
            }

            GroupBox("\(wallet.nwcWalletLabel) Activity") {
                VStack(alignment: .leading) {
                    if let historyMessage { Text(historyMessage).foregroundStyle(.secondary).padding(20) }
                    ForEach(transactions) { tx in
                        HStack {
                            Image(systemName: tx.direction == .incoming ? "arrow.down.left" : "arrow.up.right")
                                .foregroundStyle(tx.direction == .incoming ? .green : .secondary)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(tx.description?.isEmpty == false ? tx.description! : (tx.direction == .incoming ? "Received" : "Sent"))
                                Text((tx.settledAt ?? tx.createdAt).formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(tx.direction == .incoming ? "+" : "−")\(wallet.formattedSats(tx.amountSat))").monospacedDigit()
                        }.padding(8)
                    }
                }
            }
        }
        .task { await loadHistory() }
        .task(id: wallet.pendingEcashReceives.map(\.id)) { await checkTokens() }
        .sheet(isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } })) {
            MacNWCTransfer(mode: action ?? "receive")
        }
        .confirmationDialog(
            "Remove this token? If it hasn't been claimed, removing it loses those sats unless you've copied it.",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
        ) {
            Button("Remove Token", role: .destructive) {
                guard let pending = removing else { return }
                removing = nil
                Task { try? await wallet.discardPendingReceive(pending) }
            }
            Button("Cancel", role: .cancel) { removing = nil }
        }
    }

    private func loadHistory() async {
        do {
            transactions = try await wallet.nwcTransactions()
            historyMessage = transactions.isEmpty ? "No transactions yet." : nil
        } catch {
            historyMessage = "\(wallet.nwcWalletLabel) didn't share its history."
        }
    }

    private func checkTokens() async {
        for pending in wallet.pendingEcashReceives where tokenStates[pending.id] == nil {
            do {
                _ = try await wallet.previewUnspentToken(pending.token)
                tokenStates[pending.id] = "Unclaimed"
            } catch {
                tokenStates[pending.id] = String(describing: error).localizedCaseInsensitiveContains("spent")
                    ? "Already claimed" : "Couldn't reach mint"
            }
        }
    }
}

/// Receive (create an invoice) or pay (invoice or lightning address) through the NWC wallet.
struct MacNWCTransfer: View {
    let mode: String
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var input = ""
    @State private var invoice: NWCInvoice?
    @State private var received = false
    @State private var resolvedInvoice: String?
    @State private var resolvedAmount: UInt64?
    @State private var resultMessage: String?
    @State private var error: String?
    @State private var busy = false

    private var isAddress: Bool { LnurlPayClient.isLightningAddress(input) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(mode == "receive" ? "Receive Lightning" : "Pay Lightning").font(.title2.bold())
            Label(mode == "receive" ? "To \(wallet.nwcWalletLabel)" : "From \(wallet.nwcWalletLabel)", systemImage: "bolt.horizontal.circle")
                .font(.caption).foregroundStyle(.secondary)
            if mode == "receive" {
                if received {
                    Label("Received \(wallet.formattedSats(UInt64(amount) ?? 0)).", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else if let invoice {
                    Text("Share this Lightning invoice.").foregroundStyle(.secondary)
                    ScrollView { Text(invoice.invoice).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }.frame(maxHeight: 90)
                    MacQRCodeView(value: invoice.invoice)
                    HStack { Button("Copy") { macCopy(invoice.invoice) }; ProgressView().controlSize(.small); Text("Waiting for payment…").font(.caption) }
                } else {
                    TextField("Amount in sats", text: $amount)
                    Button("Create Invoice") {
                        perform {
                            guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }
                            invoice = try await wallet.createNWCInvoice(amount: value)
                        }
                    }.buttonStyle(.borderedProminent).disabled(busy)
                }
            } else if let resultMessage {
                Label(resultMessage, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else if let resolvedInvoice, let resolvedAmount {
                Text("Pay \(wallet.formattedSats(resolvedAmount))")
                if let balance = wallet.nwcStatus?.balanceSat {
                    Text("Wallet balance: \(wallet.formattedSats(balance))").foregroundStyle(.secondary)
                }
                Button("Confirm Payment") {
                    perform {
                        let payment = try await wallet.payWithNWC(invoice: resolvedInvoice)
                        let fee = payment.feesPaidMsat.map { " Fee: \(wallet.formattedSats($0 / 1_000))." } ?? ""
                        resultMessage = "Payment sent.\(fee)"
                    }
                }.buttonStyle(.borderedProminent).disabled(busy)
                Button("Back") { self.resolvedInvoice = nil }.disabled(busy)
            } else {
                TextField("Lightning invoice or address (name@domain)", text: $input, axis: .vertical).lineLimit(3...6)
                if isAddress { TextField("Amount in sats", text: $amount) }
                Button("Review") {
                    perform {
                        if isAddress {
                            guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }
                            let resolution = try await LnurlPayClient.resolveInvoice(address: input, amountSats: value)
                            resolvedInvoice = resolution.invoice
                            resolvedAmount = resolution.amountSats
                        } else {
                            let normalized = try CashuWalletService.normalizedLightningInvoice(input)
                            guard let msat = try Bolt11Amount.millisatoshis(normalized) else {
                                error = "This invoice has no amount. Ask for an invoice with an amount."
                                return
                            }
                            resolvedInvoice = normalized
                            resolvedAmount = msat / 1_000
                        }
                    }
                }.buttonStyle(.borderedProminent).disabled(busy || input.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if busy { ProgressView().controlSize(.small) }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Spacer()
            HStack { Spacer(); Button("Close") { dismiss() }.disabled(busy) }
        }
        .padding(26).frame(width: 520, height: invoice != nil ? 560 : 400).interactiveDismissDisabled(busy)
        .task(id: invoice?.invoice) {
            guard let invoice else { return }
            while !Task.isCancelled, !received {
                if await wallet.isNWCInvoiceSettled(invoice) {
                    received = true
                    await wallet.refreshNWC()
                    return
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
}

/// Connect an NWC wallet, move the ecash balance into it, switch modes.
struct MacWalletModeView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var connection = ""
    @State private var error: String?
    @State private var confirmSkip = false
    @State private var ranMigration = false

    private var ecashTotal: UInt64 { wallet.ecashMintBalances.reduce(0) { $0 + $1.available } }
    private var journal: SweepJournal? {
        guard let journal = wallet.nwcMigrationJournal else { return nil }
        return ranMigration || journal.status != .completed ? journal : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Wallet").font(.title2.bold())
            if !wallet.nwcConnected {
                Text("Use your own lightning wallet over Nostr Wallet Connect (NWC) instead of Taskify's ecash wallet. Payments you send and receive go straight to that wallet.")
                Text("In your wallet, create an NWC connection that can send and receive, then paste it here.").foregroundStyle(.secondary)
                TextField("nostr+walletconnect://…", text: $connection, axis: .vertical).lineLimit(2...5)
                Button("Connect") {
                    Task {
                        do { try await wallet.connectNWC(uri: connection); connection = "" } catch { self.error = error.localizedDescription }
                    }
                }.buttonStyle(.borderedProminent).disabled(connection.trimmingCharacters(in: .whitespaces).isEmpty || wallet.isWorking)
            } else if let missing = wallet.nwcStatus?.missingMethods, !missing.isEmpty {
                Text("\(wallet.nwcWalletLabel) doesn't allow \(missing.joined(separator: " and ")), which Taskify needs to send and receive. Create a connection with send and receive permissions.")
                    .foregroundStyle(.orange)
                Button("Disconnect", role: .destructive) { Task { await wallet.disconnectNWC() } }
            } else if wallet.walletMode == .nwc {
                Text("You're using **\(wallet.nwcWalletLabel)** for payments. Taskify's ecash wallet and its recovery phrase are kept; switch back any time.")
                progress
                if ecashTotal > 0 {
                    Text("\(wallet.formattedSats(ecashTotal)) is still in the ecash wallet.")
                    Button("Move \(wallet.formattedSats(ecashTotal)) to \(wallet.nwcWalletLabel)") { Task { await migrate(thenSwitch: false) } }
                        .disabled(wallet.isMovingToNWC)
                }
                HStack {
                    Button("Switch Back to Ecash Wallet") { switchTo(.ecash) }.disabled(wallet.isMovingToNWC)
                    Button("Disconnect", role: .destructive) { Task { await wallet.disconnectNWC() } }.disabled(wallet.isMovingToNWC)
                }
            } else {
                Text("Switch to **\(wallet.nwcWalletLabel)**? Sending and receiving will use it, and only lightning payments will show. Ecash sent to you is kept as tokens you can move to \(wallet.nwcWalletLabel) or redeem elsewhere.")
                if ecashTotal > 0 {
                    GroupBox("Ecash Balance") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(wallet.ecashMintBalances) { mint in
                                HStack { Text(mint.name); Spacer(); Text(wallet.formattedSats(mint.available)).monospacedDigit() }
                            }
                            Text("Moving pays each mint's lightning fee. A few sats of returned fee reserve may stay in ecash.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(8)
                    }
                    progress
                    HStack {
                        Button(journal.map { $0.status == .completed ? "Move \(wallet.formattedSats(ecashTotal)) and Switch" : "Try Again" }
                               ?? "Move \(wallet.formattedSats(ecashTotal)) and Switch") {
                            Task { await migrate(thenSwitch: true) }
                        }.buttonStyle(.borderedProminent).disabled(wallet.isMovingToNWC)
                        if confirmSkip {
                            Button("Switch Without Moving") { switchTo(.nwc) }
                            Button("Cancel") { confirmSkip = false }
                        } else {
                            Button("Switch Without Moving Funds…") { confirmSkip = true }.disabled(wallet.isMovingToNWC)
                        }
                    }
                    if confirmSkip {
                        Text("Your \(wallet.formattedSats(ecashTotal)) stays in Taskify's ecash wallet. You won't see it while using \(wallet.nwcWalletLabel); switch back to spend or move it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    progress
                    Button("Use \(wallet.nwcWalletLabel)") { switchTo(.nwc) }.buttonStyle(.borderedProminent)
                }
                Button("Disconnect \(wallet.nwcWalletLabel)", role: .destructive) { Task { await wallet.disconnectNWC() } }
                    .disabled(wallet.isMovingToNWC)
            }
            if wallet.isMovingToNWC { ProgressView("Moving…").controlSize(.small) }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Spacer()
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).disabled(wallet.isMovingToNWC) }
        }
        .padding(26).frame(width: 560, height: 520)
        .interactiveDismissDisabled(wallet.isMovingToNWC)
        .task { await wallet.refreshNWC() }
    }

    @ViewBuilder
    private var progress: some View {
        if let journal {
            GroupBox("Transfer to \(wallet.nwcWalletLabel)") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(journal.sources, id: \.sourceID) { source in
                        HStack {
                            Text(URL(string: source.sourceID)?.host() ?? source.label)
                            Spacer()
                            Text(Self.label(for: source.status)).foregroundStyle(source.status == .failed ? .red : .secondary)
                        }
                        if source.sentSat > 0 {
                            Text("Sent \(wallet.formattedSats(source.sentSat)) · fees \(wallet.formattedSats(source.feesSat))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if source.status == .awaitingSettlement {
                            Text("The mint hasn't finished this payment. Your funds are safe; check again in a few minutes.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let error = source.error { Text(error).font(.caption).foregroundStyle(.red) }
                    }
                    if journal.summary.unconfirmedSat > 0 {
                        Text("The mint reports \(wallet.formattedSats(journal.summary.unconfirmedSat)) as paid, but \(wallet.nwcWalletLabel) hasn't confirmed receiving it. Check its history.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }.padding(8)
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
}

// MARK: - Multi-wallet and wallet-only settings

struct MacWalletManagerView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    @State private var editing: NWCWalletSummary?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Wallets").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            ScrollView {
                VStack(spacing: 10) {
                    walletRow(title: "Taskify eCash", subtitle: "Built-in Cashu wallet", icon: "bitcoinsign.circle.fill",
                              selected: !wallet.isNWCWalletActive) {
                        wallet.setWalletMode(.ecash)
                    }
                    ForEach(wallet.nwcWallets) { saved in
                        HStack(spacing: 8) {
                            walletRow(title: saved.name, subtitle: saved.displayedReceiveAddress ?? "Lightning via NWC",
                                      icon: "bolt.horizontal.circle.fill",
                                      selected: wallet.isNWCWalletActive && wallet.activeNWCWalletID == saved.id) {
                                Task {
                                    do { try await wallet.selectNWCWallet(id: saved.id) }
                                    catch { self.error = error.localizedDescription }
                                }
                            }
                            Button { editing = saved } label: { Image(systemName: "slider.horizontal.3") }
                                .buttonStyle(.borderless).help("Edit \(saved.name)")
                        }
                    }
                    Button("Connect a Wallet", systemImage: "link.badge.plus") { adding = true }
                        .buttonStyle(.borderedProminent).controlSize(.large).padding(.top, 4)
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }
        .padding(26).frame(width: 540, height: 520)
        .task { await wallet.refreshNWC() }
        .sheet(isPresented: $adding) { MacNWCWalletEditor(saved: nil) }
        .sheet(item: $editing) { MacNWCWalletEditor(saved: $0) }
    }

    private func walletRow(title: String, subtitle: String, icon: String, selected: Bool,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.title3).foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).fontWeight(.semibold)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
            }
            .padding(13).contentShape(Rectangle())
            .background(selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08),
                        in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain).frame(maxWidth: .infinity)
    }
}

private struct MacNWCWalletEditor: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    let saved: NWCWalletSummary?
    @State private var name = ""
    @State private var connection = ""
    @State private var address = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(saved == nil ? "Connect Wallet" : "Edit Wallet").font(.title2.bold())
            TextField("Wallet name", text: $name)
            if saved == nil {
                SecureField("nostr+walletconnect://…", text: $connection)
                Text("Create a connection that can send and receive invoices.").font(.caption).foregroundStyle(.secondary)
            }
            TextField("Lightning address shown for this wallet (optional)", text: $address)
            Text("Leave blank to use the address supplied by the wallet.").font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            Spacer()
            HStack {
                if let saved {
                    Button("Remove Wallet", role: .destructive) {
                        Task { await wallet.disconnectNWC(id: saved.id); dismiss() }
                    }.disabled(busy)
                }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.disabled(busy)
                Button(saved == nil ? "Connect" : "Save") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || (saved == nil && connection.isEmpty))
            }
        }
        .padding(26).frame(width: 500, height: 330).interactiveDismissDisabled(busy)
        .onAppear {
            name = saved?.name ?? "NWC wallet"
            address = saved?.receiveAddress ?? ""
        }
    }

    private func save() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            if let saved {
                try await wallet.renameNWCWallet(id: saved.id, name: name)
                try await wallet.setNWCReceiveAddress(address.isEmpty ? nil : address, for: saved.id)
            } else {
                try await wallet.connectNWC(uri: connection, name: name)
                try await wallet.setNWCReceiveAddress(address.isEmpty ? nil : address)
            }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct MacWalletSettingsView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var destination: Destination?

    private enum Destination: String, Identifiable {
        case wallets, address, swap, mints, recovery
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Wallet Settings").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            VStack(spacing: 9) {
                row("Wallets", "Add and switch between eCash and NWC", "wallet.bifold", .wallets)
                row("Lightning Address", "Choose what Receive shows for each wallet", "at", .address)
                row("Swap", "Move funds between wallets", "arrow.left.arrow.right", .swap)
                row("Mints", "Manage eCash balances", "building.columns", .mints)
                row("Backup & Recovery", "Protect the built-in wallet", "key.viewfinder", .recovery)
            }
            GroupBox("Currency") {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("Currency Conversion", isOn: Binding(get: { model.walletConversionEnabled }, set: { model.setWalletConversionEnabled($0) }))
                    Picker("Bitcoin Denomination", selection: Binding(get: { model.walletDenominationDisplay }, set: { model.setWalletDenominationDisplay($0) })) {
                        Text("\(WalletAmountFormat.bitcoinSymbol)42,778").tag(WalletDenominationDisplay.bitcoinSymbol)
                        Text("42,778 sat").tag(WalletDenominationDisplay.sat)
                    }
                }.padding(8)
            }
        }
        .padding(26).frame(width: 560, height: 600)
        .sheet(item: $destination) { destination in
            switch destination {
            case .wallets: MacWalletManagerView()
            case .address: MacWalletAddressSettingsView()
            case .swap: MacWalletSwapSettingsView()
            case .mints: MacMintManagerView()
            case .recovery: MacWalletRecoverySettingsView()
            }
        }
    }

    private func row(_ title: String, _ detail: String, _ icon: String, _ destination: Destination) -> some View {
        Button { self.destination = destination } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.title3).foregroundStyle(Color.accentColor).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) { Text(title).fontWeight(.semibold); Text(detail).font(.caption).foregroundStyle(.secondary) }
                Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }.padding(12).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain)
    }
}

private struct MacMintManagerView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var mintURL = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Mints").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(wallet.snapshot.mints) { mint in
                        HStack {
                            Image(systemName: mint.isReachable ? "building.columns" : "wifi.slash")
                            VStack(alignment: .leading) { Text(mint.name); Text(mint.url).font(.caption).foregroundStyle(.secondary) }
                            Spacer(); Text(wallet.formattedSats(mint.available)).monospacedDigit()
                            Button(wallet.activeMintURL == mint.url ? "Selected" : "Select") { wallet.selectMint(mint.url) }.disabled(wallet.activeMintURL == mint.url)
                            Button("Remove", role: .destructive) { Task { try? await wallet.removeMint(mint.url) } }
                        }.padding(10).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            HStack {
                TextField("https://your-mint.example", text: $mintURL)
                Button("Add Mint") { Task { do { try await wallet.addMint(mintURL); mintURL = "" } catch { self.error = error.localizedDescription } } }
                    .disabled(mintURL.isEmpty || wallet.isWorking)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.padding(26).frame(width: 650, height: 500)
    }
}

private struct MacWalletSwapSettingsView: View {
    enum Direction: String, CaseIterable, Identifiable { case toNWC = "eCash → NWC", toEcash = "NWC → eCash"; var id: String { rawValue } }
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var direction = Direction.toNWC
    @State private var amount = ""
    @State private var mintURL = ""
    @State private var mintTransfer = false
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Swap").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            Button("Transfer Between eCash Mints…") { mintTransfer = true }.disabled(wallet.snapshot.mints.count < 2)
            Divider()
            if wallet.nwcConnected {
                Picker("Direction", selection: $direction) { ForEach(Direction.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented)
                Picker(direction == .toNWC ? "From Mint" : "To Mint", selection: $mintURL) { ForEach(wallet.snapshot.mints) { Text($0.name).tag($0.url) } }
                TextField("Amount in sats", text: $amount)
                Button(busy ? "Moving…" : "Move Funds") { Task { await swap() } }.buttonStyle(.borderedProminent).disabled(busy || mintURL.isEmpty)
            } else {
                ContentUnavailableView("Connect an NWC Wallet", systemImage: "bolt.slash", description: Text("Add one in Wallets, or transfer between eCash mints."))
            }
            if let message { Text(message).font(.caption).foregroundStyle(message.hasPrefix("Moved") ? Color.green : .red) }
            Spacer()
        }.padding(26).frame(width: 520, height: 380).onAppear { mintURL = wallet.activeMintURL }
            .sheet(isPresented: $mintTransfer) { MacMintTransfer() }
    }

    private func swap() async {
        guard let value = UInt64(amount), value > 0 else { message = "Enter a positive whole number of sats."; return }
        busy = true; message = nil; defer { busy = false }
        do {
            if direction == .toNWC { try await wallet.swapEcashToNWC(amount: value, sourceMintURL: mintURL) }
            else { try await wallet.swapNWCToEcash(amount: value, destinationMintURL: mintURL) }
            message = "Moved \(wallet.formattedSats(value))"
        } catch { message = error.localizedDescription }
    }
}

private struct MacWalletAddressSettingsView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var separateConnection = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Lightning Address").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            if wallet.isNWCWalletActive {
                GroupBox("Shown for \(wallet.nwcWalletLabel)") {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("you@example.com", text: $address)
                        HStack {
                            Button("Save") { Task { await run { try await wallet.setNWCReceiveAddress(address.isEmpty ? nil : address) } } }
                            if wallet.nwcReceiveAddressOverride != nil { Button("Use Wallet's Address") { Task { await run { try await wallet.setNWCReceiveAddress(nil); address = "" } } } }
                        }
                    }.padding(8)
                }
            } else if let address = wallet.preferredLightningAddress {
                LabeledContent("Shown on Receive", value: address).textSelection(.enabled)
            }
            GroupBox("solife.me Forwarding") {
                VStack(alignment: .leading, spacing: 12) {
                    if wallet.solifeAccountStatus == .loading { ProgressView("Loading addresses…") }
                    ForEach(wallet.solifeAccount?.addresses ?? [], id: \.handle) { item in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(item.address).fontWeight(.semibold).textSelection(.enabled)
                            if let forward = item.nwcForward {
                                Text("Payments go to \(forward.walletAlias ?? "your NWC wallet").").font(.caption)
                                if forward.canSpend { Text("This connection can spend. A receive-only connection is safer.").font(.caption).foregroundStyle(.orange) }
                                Button("Stop Forwarding") { Task { await run { try await wallet.clearSolifeNWCForward(handle: item.handle) } } }
                            } else {
                                if wallet.isNWCWalletActive {
                                    Button("Use \(wallet.nwcWalletLabel)") { Task { await run { try await wallet.shareActiveNWCWithSolife(handle: item.handle) } } }
                                        .buttonStyle(.borderedProminent)
                                    Text("Opt in to share the active connection for invoice creation. Taskify does not let the server initiate payments.").font(.caption).foregroundStyle(.secondary)
                                }
                                DisclosureGroup("Use a separate receive-only connection") {
                                    SecureField("nostr+walletconnect://…", text: $separateConnection)
                                    Button("Forward with This Connection") { Task { await run { try await wallet.setSolifeNWCForward(handle: item.handle, connection: separateConnection); separateConnection = "" } } }
                                        .disabled(separateConnection.isEmpty)
                                }.font(.caption)
                            }
                        }.padding(.vertical, 7)
                    }
                    if wallet.solifeAccount?.addresses.isEmpty != false { Text(wallet.solifeAccountMessage ?? "No solife.me addresses are available yet.").font(.caption).foregroundStyle(.secondary) }
                }.padding(8)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            Spacer()
        }.padding(26).frame(width: 620, height: 560)
            .task { await wallet.refreshSolifeAccount(); address = wallet.nwcReceiveAddressOverride ?? "" }
    }

    private func run(_ action: () async throws -> Void) async {
        busy = true; error = nil; defer { busy = false }
        do { try await action() } catch { self.error = error.localizedDescription }
    }
}

private struct MacWalletRecoverySettingsView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showingRecovery = false
    @State private var phrase: String?
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Backup & Recovery").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            Button("Recover Wallet…") { showingRecovery = true }
            Button("Show Recovery Phrase…") {
                Task { do { try await authenticate("View your Taskify wallet recovery phrase"); phrase = try await wallet.recoveryPhrase() } catch { message = error.localizedDescription } }
            }
            Button("Export Wallet Backup…") { exportBackup() }
            if let phrase { Text(phrase).font(.body.monospaced()).textSelection(.enabled).padding().background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10)) }
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
            Spacer()
        }.padding(26).frame(width: 540, height: 390).sheet(isPresented: $showingRecovery) { MacWalletRecovery() }
    }

    private func exportBackup() {
        Task {
            do {
                try await authenticate("Export your Taskify wallet recovery backup")
                let backup = try await wallet.recoveryBackupJSON()
                let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "Taskify-wallet-recovery.json"
                guard panel.runModal() == .OK, let url = panel.url else { return }
                try backup.write(to: url, atomically: true, encoding: .utf8)
                message = "Wallet recovery backup exported."
            } catch { message = error.localizedDescription }
        }
    }
}

struct MacWalletHistoryView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var nwcTransactions: [NWCTransaction] = []
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("History").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            List {
                if wallet.isNWCWalletActive {
                    ForEach(nwcTransactions) { tx in
                        LabeledContent(tx.description?.isEmpty == false ? tx.description! : (tx.direction == .incoming ? "Received" : "Sent"),
                                       value: "\(tx.direction == .incoming ? "+" : "−")\(wallet.formattedSats(tx.amountSat))")
                    }
                } else {
                    ForEach(wallet.snapshot.transactions) { tx in
                        LabeledContent(tx.memo ?? String(describing: tx.kind).capitalized, value: wallet.formattedSats(tx.amount))
                    }
                }
                if let message { Text(message).foregroundStyle(.secondary) }
            }
        }.padding(22).frame(width: 620, height: 520).task {
            guard wallet.isNWCWalletActive else { return }
            do { nwcTransactions = try await wallet.nwcTransactions(); if nwcTransactions.isEmpty { message = "No transactions yet." } }
            catch { message = "This wallet didn't share its history." }
        }
    }
}
