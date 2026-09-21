import SwiftUI
import TaskifyCore

/// The wallet page while an NWC wallet replaces the ecash wallet: lightning only.
struct MacNWCWalletPanel: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @State private var action: String?
    @State private var showingMode = false
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
                    Text(wallet.displayAmount(forSats: wallet.nwcStatus?.balanceSat ?? 0).primary)
                        .font(.system(size: 42, weight: .semibold, design: .rounded))
                        .accessibilityLabel("\(wallet.nwcWalletLabel) balance, \(wallet.nwcStatus?.balanceSat ?? 0) sats")
                }
                Spacer()
                Button { Task { await wallet.refreshNWC(); await loadHistory() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
            }
            HStack {
                Button("Receive", systemImage: "arrow.down.left") { action = "receive" }.buttonStyle(.borderedProminent)
                Button("Pay Lightning", systemImage: "bolt") { action = "pay" }
                Button("Wallet…", systemImage: "bolt.horizontal.circle") { showingMode = true }
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
                                do { try wallet.setNWCReceiveAddress(addressDraft); editingAddress = false } catch { self.error = error.localizedDescription }
                            }.disabled(addressDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                            if wallet.nwcReceiveAddressOverride != nil {
                                Button("Use Wallet's Address") { try? wallet.setNWCReceiveAddress(nil); editingAddress = false }
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
        .sheet(isPresented: $showingMode) { MacWalletModeView() }
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
