import SwiftUI
import TaskifyCore
import TaskifyWallet

struct MacWalletView: View {
    @EnvironmentObject private var wallet: WalletViewModel

    var body: some View {
        MacWalletMoveOutView()
    }
}

private struct ContactPickerRequest: Identifiable { let purpose: String; var id: String { purpose } }

struct MacWalletTransfer: View {
    let mode: String
    var contact: NostrContact? = nil
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
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
    @State private var sentViaMessage = false
    @State private var confirmedAmount: UInt64 = 0
    private var isLightningAddress: Bool { mode == "pay" && LnurlPayClient.isLightningAddress(input) }
    private var title: String {
        switch mode {
        case "receive": return "Receive"
        case "send": if let contact { return "Send Ecash to \(contact.displayName)" }; return "Send Ecash"
        default: if let contact { return "Pay \(contact.displayName)" }; return "Pay Lightning"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title).font(.title2.bold())
            if let contact, output == nil, resultMessage == nil {
                Label("With \(contact.displayName)", systemImage: "person.crop.circle").font(.caption).foregroundStyle(.secondary)
            }
            if let output {
                Text(mode == "send" ? "Ecash is ready. This token is also saved in your wallet." : "Share this Lightning invoice.").foregroundStyle(.secondary)
                ScrollView { Text(output).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 110)
                MacQRCodeView(value: output)
                HStack {
                    // In send mode the output is a token, which is cash; an invoice is fine to share.
                    Button("Copy") { if mode == "send" { macCopySecret(output) } else { macCopy(output) } }
                    if mode == "send", let contact, !sentViaMessage {
                        Button("Send to \(contact.displayName) via Message") {
                            perform {
                                let text = WalletContactPayment.ecashDirectMessage(senderNpub: model.identityNpub, formattedAmount: wallet.formattedSats(confirmedAmount), token: output)
                                try await model.sendDirectMessage(to: contact.publicKey, content: text, replyToEventID: nil)
                                sentViaMessage = true
                            }
                        }
                    }
                    if sentViaMessage { Label("Sent", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                }
            } else if let resultMessage {
                Label(resultMessage, systemImage: resultPending ? "clock" : "checkmark.circle.fill").foregroundStyle(resultPending ? .orange : .green)
            } else if let quote = sendQuote {
                Text("Send \(wallet.formattedSats(quote.amount))")
                Text("Fee: \(wallet.formattedSats(quote.fee))").foregroundStyle(.secondary)
                Button("Confirm Send") { perform { confirmedAmount = quote.amount; output = try await wallet.confirmSend(quote, memo: nil).token; sendQuote = nil } }
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
                    TextField(mode == "receive" ? "Paste ecash token, or leave empty for Lightning" : "Lightning invoice or address (name@domain)", text: $input, axis: .vertical).lineLimit(3...6)
                }
                Button(mode == "receive" ? (input.isEmpty ? "Create Lightning Invoice" : "Redeem Ecash") : "Review") {
                    perform {
                        switch mode {
                        case "receive":
                            if !input.isEmpty {
                                switch MacWalletOutcome(receive: try await wallet.submitReceive(input)) {
                                case .received(let sats): resultMessage = "Received \(wallet.formattedSats(sats))."
                                case .alreadyReceived: resultMessage = "This token was already received. No additional funds were added."
                                case .receiveQueued: resultPending = true; resultMessage = "Token saved. Choose Retry in Pending Ecash Receives to redeem it."
                                case .paid, .paymentPending: break
                                }
                            }
                            else { guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }; output = try await wallet.createLightningReceiveQuote(mintURL: wallet.activeMintURL, amount: value).invoice }
                        case "send":
                            guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }
                            sendQuote = try await wallet.prepareSend(mintURL: wallet.activeMintURL, amount: value, lockPublicKey: contact?.publicKey)
                        default:
                            if isLightningAddress {
                                guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }
                                let resolution = try await LnurlPayClient.resolveInvoice(address: input, amountSats: value)
                                payQuote = try await wallet.prepareLightningPayment(mintURL: wallet.activeMintURL, invoice: resolution.invoice, amount: resolution.amountSats)
                            } else {
                                payQuote = try await wallet.prepareLightningPayment(mintURL: wallet.activeMintURL, invoice: input, amount: amount.isEmpty ? nil : UInt64(amount))
                            }
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
        }.padding(26).frame(width: 520, height: output != nil ? 560 : 450).interactiveDismissDisabled()
            .onAppear {
                guard mode == "pay", let contact else { return }
                input = WalletContactPayment.lightningAddress(lud16: contact.profile?.lud16, npub: contact.npub)
            }
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
