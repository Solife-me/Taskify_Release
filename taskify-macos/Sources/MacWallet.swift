import SwiftUI
import TaskifyCore

struct MacWalletView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @State private var action: String?
    @State private var mintURL = ""
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("AVAILABLE BALANCE").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(wallet.displayAmount(forSats: wallet.snapshot.available).primary).font(.system(size: 42, weight: .semibold, design: .rounded))
                        if wallet.snapshot.pending > 0 || wallet.snapshot.reserved > 0 {
                            Text("\(wallet.formattedSats(wallet.snapshot.pending)) pending · \(wallet.formattedSats(wallet.snapshot.reserved)) reserved").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button { Task { await wallet.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                }
                HStack {
                    Button("Receive", systemImage: "arrow.down.left") { action = "receive" }.buttonStyle(.borderedProminent)
                    Button("Send Ecash", systemImage: "arrow.up.right") { action = "send" }.disabled(wallet.activeMint == nil)
                    Button("Pay Lightning", systemImage: "bolt") { action = "pay" }.disabled(wallet.activeMint == nil)
                }.controlSize(.large)
                if let message = wallet.statusMessage { Label(message, systemImage: "checkmark.circle").foregroundStyle(.green) }
                if let error = error ?? wallet.errorMessage { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                GroupBox("Mints") {
                    VStack(spacing: 12) {
                        ForEach(wallet.snapshot.mints) { mint in
                            HStack {
                                Image(systemName: mint.isReachable ? "building.columns" : "wifi.slash").foregroundStyle(.secondary)
                                VStack(alignment: .leading) { Text(mint.name); Text(mint.url).font(.caption).foregroundStyle(.secondary) }
                                Spacer()
                                Text(wallet.formattedSats(mint.available)).monospacedDigit()
                                Button(wallet.activeMintURL == mint.url ? "Selected" : "Select") { wallet.selectMint(mint.url) }.disabled(wallet.activeMintURL == mint.url)
                            }
                        }
                        HStack {
                            TextField("https://your-mint.example", text: $mintURL)
                            Button("Add Mint") {
                                Task { do { try await wallet.addMint(mintURL); mintURL = "" } catch { self.error = error.localizedDescription } }
                            }.disabled(mintURL.isEmpty || wallet.isWorking)
                        }
                    }.padding(10)
                }
                if !wallet.activeLightningReceiveQuotes.isEmpty {
                    GroupBox("Pending Lightning Receives") {
                        ForEach(wallet.activeLightningReceiveQuotes) { quote in
                            HStack {
                                Text(wallet.formattedSats(quote.amount))
                                Spacer()
                                Button("Copy Invoice") { macCopy(quote.invoice) }
                                Button("Check Payment") { Task { do { _ = try await wallet.checkLightningReceiveQuote(id: quote.id) } catch { self.error = error.localizedDescription } } }
                            }.padding(8)
                        }
                    }
                }
                if !wallet.recoverablePendingEcashReceives.isEmpty {
                    GroupBox("Pending Ecash Receives") {
                        ForEach(wallet.recoverablePendingEcashReceives) { pending in
                            HStack {
                                Text("Interrupted receive")
                                Spacer()
                                Button("Retry") { Task { do { _ = try await wallet.retryPendingReceive(pending) } catch { self.error = error.localizedDescription } } }
                            }.padding(8)
                        }
                    }
                }
                GroupBox("Activity") {
                    if wallet.snapshot.transactions.isEmpty { Text("Your transactions will appear here.").foregroundStyle(.secondary).padding(26) }
                    ForEach(wallet.snapshot.transactions) { transaction in
                        HStack {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(transaction.memo ?? String(describing: transaction.kind).capitalized)
                                Text(transaction.date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(String(describing: transaction.state).capitalized).font(.caption).foregroundStyle(.secondary)
                            Text(wallet.formattedSats(transaction.amount)).monospacedDigit()
                        }.padding(10)
                    }
                }
                if !wallet.snapshot.outgoingTokens.isEmpty {
                    GroupBox("Saved Outgoing Ecash") {
                        ForEach(wallet.snapshot.outgoingTokens) { token in
                            HStack {
                                Text(wallet.formattedSats(token.amount))
                                Text(String(describing: token.status).capitalized).foregroundStyle(.secondary)
                                Spacer()
                                Button("Copy Token") { macCopy(token.token) }
                            }.padding(8)
                        }
                    }
                }
            }.padding(32).frame(maxWidth: 900)
                .frame(maxWidth: .infinity)
        }.sheet(isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } })) {
            MacWalletTransfer(mode: action ?? "receive")
        }
    }
}

private struct MacWalletTransfer: View {
    let mode: String
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var amount = ""
    @State private var input = ""
    @State private var output: String?
    @State private var error: String?
    @State private var busy = false
    @State private var sendQuote: CashuPreparedSendQuote?
    @State private var payQuote: CashuLightningPaymentQuote?
    @State private var resultMessage: String?
    @State private var resultPending = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(mode == "receive" ? "Receive" : mode == "send" ? "Send Ecash" : "Pay Lightning").font(.title2.bold())
            if let output {
                Text(mode == "send" ? "Ecash is ready. This token is also saved in your wallet." : "Share this Lightning invoice.").foregroundStyle(.secondary)
                ScrollView { Text(output).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 150)
                Button("Copy") { macCopy(output) }
            } else if let resultMessage {
                Label(resultMessage, systemImage: resultPending ? "clock" : "checkmark.circle.fill").foregroundStyle(resultPending ? .orange : .green)
            } else if let quote = sendQuote {
                Text("Send \(wallet.formattedSats(quote.amount))")
                Text("Fee: \(wallet.formattedSats(quote.fee))").foregroundStyle(.secondary)
                Button("Confirm Send") { perform { output = try await wallet.confirmSend(quote, memo: nil).token; sendQuote = nil } }
                    .buttonStyle(.borderedProminent).disabled(busy)
            } else if let quote = payQuote {
                Text("Pay \(wallet.formattedSats(quote.amount))")
                Text("Maximum total including fees: \(wallet.formattedSats(quote.maximumTotal))").foregroundStyle(.secondary)
                Text(quote.mintURL).font(.caption).textSelection(.enabled)
                Button("Confirm Payment") { perform { let result = try await wallet.confirmLightningPayment(quote)
                    payQuote = nil
                    resultPending = MacWalletOutcome(payment: result).isPending
                    resultMessage = resultPending ? "Payment pending. Follow its status in Activity; do not pay again." : "Payment completed." } }
                    .buttonStyle(.borderedProminent).disabled(busy)
            } else {
                if mode != "receive" || input.isEmpty {
                    Picker("Mint", selection: Binding(get: { wallet.activeMintURL }, set: { wallet.selectMint($0) })) {
                        ForEach(wallet.snapshot.mints) { Text($0.name).tag($0.url) }
                    }
                    TextField("Amount in sats", text: $amount)
                }
                if mode != "send" {
                    TextField(mode == "receive" ? "Paste ecash token, or leave empty for Lightning" : "Lightning invoice", text: $input, axis: .vertical).lineLimit(3...6)
                }
                Button(mode == "receive" ? (input.isEmpty ? "Create Lightning Invoice" : "Redeem Ecash") : "Review") {
                    perform {
                        switch mode {
                        case "receive":
                            if !input.isEmpty {
                                switch MacWalletOutcome(receive: try await wallet.submitReceive(input)) {
                                case .received(let sats): resultMessage = "Received \(wallet.formattedSats(sats))."
                                case .alreadyReceived: resultMessage = "This token was already received. No additional funds were added."
                                case .receiveQueued: resultPending = true; resultMessage = "Receive queued. Your token is saved for retry in Pending Ecash Receives."
                                case .paid, .paymentPending: break
                                }
                            }
                            else { guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }; output = try await wallet.createLightningReceiveQuote(mintURL: wallet.activeMintURL, amount: value).invoice }
                        case "send":
                            guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }
                            sendQuote = try await wallet.prepareSend(mintURL: wallet.activeMintURL, amount: value)
                        default:
                            payQuote = try await wallet.prepareLightningPayment(mintURL: wallet.activeMintURL, invoice: input, amount: amount.isEmpty ? nil : UInt64(amount))
                        }
                    }
                }.buttonStyle(.borderedProminent).disabled(busy || wallet.isLoading)
            }
            if busy { ProgressView().controlSize(.small) }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Spacer()
            HStack { Spacer(); Button("Close") {
                perform {
                    if let quote = sendQuote { await wallet.cancelPreparedSend(quote) }
                    if let quote = payQuote { await wallet.cancelLightningPayment(quote) }
                    dismiss()
                }
            }.disabled(busy) }
        }.padding(26).frame(width: 520, height: 450).interactiveDismissDisabled()
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
}

struct MacWalletRecovery: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var phrase = ""
    @State private var mints = ""
    @State private var replace = false
    @State private var material: CashuRecoveryMaterial?
    @State private var working = false
    @State private var result: WalletRestoreOutcome?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Recover Wallet").font(.title2.bold())
            if let result {
                Text("Recovered \(wallet.formattedSats(result.recovered))").font(.headline)
                Text("\(wallet.formattedSats(result.pending)) pending · \(wallet.formattedSats(result.fees)) fees").foregroundStyle(.secondary)
                ScrollView {
                    ForEach(result.mints, id: \.mintURL) { mint in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(mint.mintURL).font(.caption)
                            Text(mint.errorMessage ?? "Recovered \(wallet.formattedSats(mint.deposited))").font(.caption).foregroundStyle(mint.succeeded ? Color.secondary : .red)
                        }.padding(.vertical, 8)
                    }
                }
            } else {
                SecureField("Recovery words or wallet backup JSON", text: $phrase).disabled(working)
                TextField("Additional mint URLs, separated by commas", text: $mints, axis: .vertical).lineLimit(2...4).disabled(working)
                Toggle("Replace this Mac's wallet recovery phrase", isOn: $replace).disabled(working)
                Text(replace ? "Replacement requires an empty wallet with no pending funds or tracked outgoing tokens." : "Funds are recovered into this Mac's current wallet. Its recovery phrase stays the same. Mint fees may apply.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Review Recovery…") {
                    do { material = try wallet.parseRecoveryMaterial(phrase) } catch { self.error = error.localizedDescription }
                }.disabled(working || phrase.isEmpty)
            }
            if working { ProgressView("Recovering funds…").controlSize(.small) }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Spacer()
            HStack { Spacer(); Button("Done") { phrase = ""; dismiss() }.disabled(working) }
        }.padding(26).frame(width: 540, height: 480).interactiveDismissDisabled(working)
            .confirmationDialog(replace ? "Replace this Mac's empty wallet and recover funds from the supplied seed?" : "Recover available funds into your current wallet? Mint fees may apply.", isPresented: Binding(get: { material != nil }, set: { if !$0 { material = nil } })) {
                Button(replace ? "Replace and Recover" : "Recover Funds") {
                    guard let material else { return }
                    let confirmedReplacement = replace
                    self.material = nil; working = true; error = nil
                    let urls = mints.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                    Task {
                        defer { working = false }
                        do {
                            try await macAuthenticatedRecovery(replace: confirmedReplacement, authenticate: {
                                try await authenticate("Recover your Taskify wallet")
                            }, recover: { replacement in
                                if replacement { result = try await wallet.replaceWalletSeed(material: material, additionalMintURLs: urls) }
                                else { result = try await wallet.transferFromSeed(material: material, additionalMintURLs: urls) }
                            })
                            phrase = ""
                        } catch { self.error = error.localizedDescription }
                    }
                }
                Button("Cancel", role: .cancel) { material = nil }
            }
    }
}
