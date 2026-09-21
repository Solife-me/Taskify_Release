import SwiftUI
import TaskifyCore

enum MacWalletAdvancedSheet: Identifiable, Equatable {
    case paymentRequests
    case mintTransfer
    case p2pkKeys
    case addressQR(String)

    var id: String {
        switch self {
        case .paymentRequests: return "paymentRequests"
        case .mintTransfer: return "mintTransfer"
        case .p2pkKeys: return "p2pkKeys"
        case .addressQR(let value): return "addressQR-\(value)"
        }
    }
}

struct MacContactPicker: View {
    let title: String
    var select: (NostrContact) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    private var contacts: [NostrContact] {
        model.nostrContacts
            .filter { search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search) }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2.bold())
            TextField("Search contacts", text: $search).textFieldStyle(.roundedBorder)
            if contacts.isEmpty {
                ContentUnavailableView("No Contacts", systemImage: "person.2", description: Text("Save a contact from Chat first."))
            } else {
                List(contacts) { contact in
                    Button { select(contact); dismiss() } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(contact.displayName)
                            Text(contact.npub).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                    }.buttonStyle(.plain)
                }
            }
            HStack { Spacer(); Button("Cancel", role: .cancel) { dismiss() } }
        }.padding(24).frame(width: 420, height: 480)
    }
}

struct MacP2PKKeyManager: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var importSecret = ""
    @State private var error: String?
    @State private var busy = false
    @State private var removing: CashuP2PKKey?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("P2PK Keys").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            Text("Taskify automatically redeems ecash locked to your Nostr identity. These are additional keys for advanced locking scenarios.")
                .font(.caption).foregroundStyle(.secondary)
            if wallet.p2pkKeys.isEmpty {
                ContentUnavailableView("No Additional Keys", systemImage: "key")
            } else {
                List {
                    ForEach(wallet.p2pkKeys) { key in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(key.label?.isEmpty == false ? key.label! : "Unlabeled Key")
                                    if wallet.primaryP2PKKey?.id == key.id {
                                        Text("PRIMARY").font(.caption2.bold()).foregroundStyle(Color.accentColor)
                                    }
                                }
                                Text(key.publicKey).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                                Text("Used \(key.usedCount) time\(key.usedCount == 1 ? "" : "s")").font(.caption2).foregroundStyle(.tertiary)
                            }
                            Spacer()
                            if wallet.primaryP2PKKey?.id != key.id {
                                Button("Make Primary") { perform { try await wallet.setPrimaryP2PKKey(id: key.id) } }
                            }
                            Button(role: .destructive) { removing = key } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                        }.padding(.vertical, 4)
                    }
                }
            }
            Divider()
            HStack {
                TextField("Label (optional)", text: $label)
                Button("Generate New Key") { perform { try await wallet.generateP2PKKey(label: label.isEmpty ? nil : label); label = "" } }
            }
            HStack {
                SecureField("Import private key (hex)", text: $importSecret)
                Button("Import") { perform { try await wallet.importP2PKKey(secret: importSecret, label: label.isEmpty ? nil : label); importSecret = ""; label = "" } }
                    .disabled(importSecret.isEmpty)
            }
            if busy { ProgressView().controlSize(.small) }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }.padding(24).frame(width: 560, height: 560)
            .confirmationDialog("Remove this key? Ecash already locked to it will become unredeemable by Taskify.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Remove Key", role: .destructive) {
                    guard let key = removing else { return }
                    removing = nil
                    perform { try await wallet.removeP2PKKey(id: key.id) }
                }
                Button("Cancel", role: .cancel) { removing = nil }
            }
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
}

struct MacPaymentRequestsView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    @State private var paying = false
    @State private var error: String?
    @State private var cancelling: CashuCreatedPaymentRequest?
    @State private var showingQRFor: CashuCreatedPaymentRequest?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Payment Requests").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            HStack {
                Button("New Request…") { creating = true }.buttonStyle(.borderedProminent)
                Button("Pay a Request…") { paying = true }
            }
            if wallet.createdPaymentRequests.isEmpty {
                ContentUnavailableView("No Requests Yet", systemImage: "qrcode",
                    description: Text("Create a request to ask a contact to pay you a specific amount."))
            } else {
                List(wallet.createdPaymentRequests.sorted { $0.createdAt > $1.createdAt }) { request in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(request.amount.map { wallet.formattedSats($0) } ?? "Any amount").font(.headline)
                            Spacer()
                            Text(request.state.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                        }
                        if let description = request.description, !description.isEmpty {
                            Text(description).font(.caption).foregroundStyle(.secondary)
                        }
                        if request.receivedAmount > 0 {
                            Text("Received \(wallet.formattedSats(request.receivedAmount)) from \(request.receivedCount) payment\(request.receivedCount == 1 ? "" : "s")")
                                .font(.caption).foregroundStyle(.green)
                        }
                        HStack {
                            Button("Copy") { macCopy(request.encoded) }
                            Button("QR Code") { showingQRFor = request }
                            if request.state == .active { Button("Cancel Request", role: .destructive) { cancelling = request } }
                        }.font(.caption)
                    }.padding(.vertical, 6)
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.padding(24).frame(width: 560, height: 560)
            .sheet(isPresented: $creating) { MacCreatePaymentRequest() }
            .sheet(isPresented: $paying) { MacPayPaymentRequest() }
            .sheet(item: $showingQRFor) { request in
                VStack(spacing: 16) {
                    Text("Scan to Pay").font(.title3.bold())
                    MacQRCodeView(value: request.encoded, label: "Payment request QR code")
                    Button("Copy") { macCopy(request.encoded) }
                    Button("Done") { showingQRFor = nil }.keyboardShortcut(.defaultAction)
                }.padding(28).frame(width: 320, height: 380)
            }
            .confirmationDialog("Cancel this payment request?", isPresented: Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })) {
                Button("Cancel Request", role: .destructive) {
                    guard let request = cancelling else { return }
                    cancelling = nil
                    Task { do { try await wallet.cancelPaymentRequest(request) } catch { self.error = error.localizedDescription } }
                }
                Button("Keep Request", role: .cancel) { cancelling = nil }
            }
    }
}

private struct MacCreatePaymentRequest: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recipient: NostrContact?
    @State private var pickingContact = false
    @State private var amount = ""
    @State private var anyAmount = false
    @State private var description = ""
    @State private var singleUse = true
    @State private var lockToPrimaryKey = false
    @State private var selectedMintURLs = Set<String>()
    @State private var busy = false
    @State private var error: String?
    @State private var created: CashuCreatedPaymentRequest?
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("New Payment Request").font(.title2.bold())
                Spacer()
                if created == nil { Button("Cancel", role: .cancel) { dismiss() }.disabled(busy) }
            }.padding(22)
            Divider()
            if let created {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Send this to \(recipient?.displayName ?? "your contact"), or share the code below.").foregroundStyle(.secondary)
                    MacQRCodeView(value: created.encoded, label: "Payment request QR code")
                    ScrollView { Text(created.encoded).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 80)
                    Button("Copy") { macCopy(created.encoded) }
                    Spacer()
                    HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
                }.padding(22)
            } else {
                Form {
                    Section("Who Pays") {
                        Button(recipient?.displayName ?? "Choose Recipient…") { pickingContact = true }
                    }
                    Section("Amount") {
                        Toggle("Any Amount", isOn: $anyAmount)
                        if !anyAmount { TextField("Amount in sats", text: $amount) }
                        TextField("Description (optional)", text: $description)
                    }
                    Section("Mints") {
                        ForEach(wallet.snapshot.mints) { mint in
                            Toggle(mint.name, isOn: Binding(
                                get: { selectedMintURLs.contains(mint.url) },
                                set: { if $0 { selectedMintURLs.insert(mint.url) } else { selectedMintURLs.remove(mint.url) } }))
                        }
                    }
                    Section("Options") {
                        Toggle("Single Use", isOn: $singleUse)
                        if wallet.primaryP2PKKey != nil { Toggle("Lock to My Primary P2PK Key", isOn: $lockToPrimaryKey) }
                    }
                    if let error { Section { Text(error).foregroundStyle(.red).textSelection(.enabled) } }
                }.formStyle(.grouped).disabled(busy)
                HStack {
                    if busy { ProgressView().controlSize(.small) }
                    Spacer()
                    Button("Create Request") {
                        guard let recipient else { error = "Choose who should pay this request."; return }
                        busy = true; error = nil
                        Task {
                            defer { busy = false }
                            do {
                                created = try await wallet.createPaymentRequest(
                                    amount: anyAmount ? nil : UInt64(amount),
                                    description: description.isEmpty ? nil : description,
                                    mintURLs: selectedMintURLs.isEmpty ? wallet.snapshot.mints.map(\.url) : Array(selectedMintURLs),
                                    recipientPublicKey: recipient.publicKey,
                                    relayURLs: model.appRelays,
                                    singleUse: singleUse,
                                    lockPublicKey: lockToPrimaryKey ? wallet.primaryP2PKKey?.publicKey : nil
                                )
                            } catch { self.error = error.localizedDescription }
                        }
                    }.buttonStyle(.borderedProminent).disabled(busy || recipient == nil || (!anyAmount && (UInt64(amount) ?? 0) == 0))
                }.padding(22)
            }
        }.frame(width: 500, height: 620)
            .interactiveDismissDisabled(busy)
            .onAppear { selectedMintURLs = Set(wallet.snapshot.mints.map(\.url)) }
            .sheet(isPresented: $pickingContact) { MacContactPicker(title: "Who Should Pay?") { recipient = $0 } }
    }
}

private struct MacPayPaymentRequest: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var preview: CashuPaymentRequestPreview?
    @State private var mintURL = ""
    @State private var customAmount = ""
    @State private var busy = false
    @State private var error: String?
    @State private var result: CashuPaymentRequestPaymentResult?
    private func availableMintURLs(for preview: CashuPaymentRequestPreview) -> [String] {
        MacPaymentRequestMintSelection.candidates(requestedMintURLs: preview.mintURLs, walletMintURLs: wallet.snapshot.mints.map(\.url))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Pay a Request").font(.title2.bold())
            if let result {
                Label("Paid \(wallet.formattedSats(result.amount))", systemImage: "checkmark.circle.fill").font(.headline).foregroundStyle(.green)
                Spacer()
                HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
            } else if let preview {
                Text(preview.amount.map { "Requesting \(wallet.formattedSats($0))" } ?? "Requesting any amount").font(.headline)
                if let description = preview.description, !description.isEmpty { Text(description).foregroundStyle(.secondary) }
                if preview.amount == nil { TextField("Amount in sats", text: $customAmount) }
                Picker("Pay From", selection: $mintURL) {
                    ForEach(availableMintURLs(for: preview), id: \.self) { url in
                        Text(wallet.snapshot.mints.first { $0.url == url }?.name ?? url).tag(url)
                    }
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("Cancel", role: .cancel) { dismiss() }.disabled(busy)
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    Button("Pay") {
                        busy = true; error = nil
                        Task {
                            defer { busy = false }
                            do {
                                result = try await wallet.payPaymentRequest(preview, mintURL: mintURL, customAmount: preview.amount == nil ? UInt64(customAmount) : nil)
                            } catch { self.error = error.localizedDescription }
                        }
                    }.buttonStyle(.borderedProminent).disabled(busy || mintURL.isEmpty || (preview.amount == nil && (UInt64(customAmount) ?? 0) == 0))
                }
            } else {
                TextField("Paste payment request", text: $input, axis: .vertical).lineLimit(3...6)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("Cancel", role: .cancel) { dismiss() }
                    Spacer()
                    Button("Preview") {
                        do {
                            let value = try wallet.previewPaymentRequest(input)
                            preview = value
                            mintURL = availableMintURLs(for: value).first ?? ""
                        } catch { self.error = error.localizedDescription }
                    }.buttonStyle(.borderedProminent).disabled(input.isEmpty)
                }
            }
        }.padding(26).frame(width: 480, height: 420).interactiveDismissDisabled(busy)
    }
}

struct MacMintTransfer: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var sourceURL = ""
    @State private var destinationURL = ""
    @State private var amount = ""
    @State private var busy = false
    @State private var error: String?
    @State private var result: CashuMintTransferResult?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Transfer Between Mints").font(.title2.bold())
            if let result {
                Label(result.state == .completed ? "Moved \(wallet.formattedSats(result.receivedAmount))" : "Transfer is finishing in the background",
                      systemImage: result.state == .completed ? "checkmark.circle.fill" : "clock")
                    .foregroundStyle(result.state == .completed ? Color.green : Color.orange)
                if let fee = result.feePaid { Text("Fee: \(wallet.formattedSats(fee))").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
            } else {
                Picker("From", selection: $sourceURL) { ForEach(wallet.snapshot.mints) { Text($0.name).tag($0.url) } }
                Picker("To", selection: $destinationURL) { ForEach(wallet.snapshot.mints.filter { $0.url != sourceURL }) { Text($0.name).tag($0.url) } }
                TextField("Amount in sats", text: $amount)
                Text("The mint fee for moving funds applies both ways.").font(.caption).foregroundStyle(.secondary)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("Cancel", role: .cancel) { dismiss() }.disabled(busy)
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    Button("Transfer") {
                        guard let value = UInt64(amount), value > 0 else { error = "Enter a positive whole number of sats."; return }
                        guard !sourceURL.isEmpty, !destinationURL.isEmpty, sourceURL != destinationURL else { error = "Choose two different mints."; return }
                        busy = true; error = nil
                        Task {
                            defer { busy = false }
                            do { result = try await wallet.transferBetweenMints(amount: value, sourceMintURL: sourceURL, destinationMintURL: destinationURL) }
                            catch { self.error = error.localizedDescription }
                        }
                    }.buttonStyle(.borderedProminent).disabled(busy)
                }
            }
        }.padding(26).frame(width: 460, height: 360).interactiveDismissDisabled(busy)
            .onAppear {
                sourceURL = wallet.activeMintURL
                destinationURL = wallet.snapshot.mints.first { $0.url != wallet.activeMintURL }?.url ?? ""
            }
    }
}
