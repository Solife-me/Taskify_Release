import LocalAuthentication
import SwiftUI
import TaskifyCore
#if canImport(UIKit)
import UIKit
#endif
import UniformTypeIdentifiers
#if canImport(VisionKit) && os(iOS)
import VisionKit
#endif

#if os(iOS)
/// Wallet-only configuration lives beside the wallet instead of in the app-wide Settings tab.
struct WalletSettingsSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var showingWallets = false
    @State private var showingAddress = false
    @State private var showingSwap = false
    @State private var showingMints = false
    @State private var showingRecovery = false
    @State private var showingCurrency = false
    @State private var showingRecipientKeys = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    settingsRow("Wallets", detail: wallet.isNWCWalletActive ? wallet.nwcWalletLabel : "Taskify eCash", icon: "wallet.pass") { showingWallets = true }
                    settingsRow("Lightning Address", detail: wallet.isNWCWalletActive ? (wallet.nwcReceiveAddress ?? "Not set") : (wallet.preferredLightningAddress ?? "Not set"), icon: "at") { showingAddress = true }
                    settingsRow("Swap", detail: "Move funds between wallets", icon: "arrow.left.arrow.right") { showingSwap = true }
                    settingsRow("Mints", detail: "Manage eCash balances", icon: "building.columns") { showingMints = true }
                    settingsRow("Backup & Recovery", detail: "Protect the built-in wallet", icon: "key.viewfinder") { showingRecovery = true }
                    settingsRow("Currency", detail: model.walletConversionEnabled ? "Sats and USD" : "Sats only", icon: "bitcoinsign.circle") { showingCurrency = true }
                    settingsRow("Recipient Keys", detail: "P2PK-locked eCash", icon: "lock.keyhole") { showingRecipientKeys = true }
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Wallet Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showingWallets) { WalletManagerSheet(wallet: wallet) }
            .sheet(isPresented: $showingAddress) { WalletAddressManagerView(wallet: wallet) }
            .sheet(isPresented: $showingSwap) { WalletSwapSheet(wallet: wallet) }
            .sheet(isPresented: $showingMints) { MintManagerSheet(wallet: wallet) }
            .sheet(isPresented: $showingRecovery) { WalletRecoverySheet(wallet: wallet) }
            .sheet(isPresented: $showingCurrency) { WalletCurrencySettingsSheet().environment(model) }
            .sheet(isPresented: $showingRecipientKeys) { WalletRecipientKeysSheet(wallet: wallet) }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private func settingsRow(_ title: String, detail: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.accent)
                    .frame(width: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline).foregroundStyle(TaskifyTheme.primaryText)
                    Text(detail).font(.caption).foregroundStyle(TaskifyTheme.secondaryText).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }
            .padding(17)
            .frame(maxWidth: .infinity, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
        }
        .buttonStyle(.plain)
    }
}

struct WalletSwapSheet: View {
    enum Direction: String, CaseIterable, Identifiable {
        case toNWC = "eCash → NWC"
        case toEcash = "NWC → eCash"
        var id: String { rawValue }
    }

    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var direction = Direction.toNWC
    @State private var amountText = ""
    @State private var mintURL = ""
    @State private var localError: String?
    @State private var completedMessage: String?
    @State private var showingMintSwap = false

    private var amount: UInt64? { UInt64(amountText.trimmingCharacters(in: .whitespacesAndNewlines)) }
    private var mintChoices: [CashuMintSummary] {
        direction == .toNWC ? wallet.snapshot.mints.filter { $0.available > 0 } : wallet.snapshot.mints
    }

    var body: some View {
        NavigationStack {
            Form {
                if !wallet.isNWCWalletActive {
                    Section {
                        Label("Select an NWC wallet in Wallets before moving funds between wallets.", systemImage: "bolt.slash")
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                } else {
                    Section("Direction") {
                        Picker("Direction", selection: $direction) {
                            ForEach(Direction.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: direction) { _, _ in mintURL = mintChoices.first?.url ?? "" }
                    }
                    Section("Amount") {
                        TextField("Sats", text: $amountText)
                            .keyboardType(.numberPad)
                        Text("Lightning and mint fees are shown by the source wallet and deducted in addition to the transfer amount.")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    Section(direction == .toNWC ? "Source Mint" : "Destination Mint") {
                        if mintChoices.isEmpty {
                            Text("Add an eCash mint first.").foregroundStyle(TaskifyTheme.secondaryText)
                        } else {
                            Picker("Mint", selection: $mintURL) {
                                ForEach(mintChoices) { mint in
                                    Text("\(mint.name) · \(wallet.formattedSats(mint.available))").tag(mint.url)
                                }
                            }
                        }
                    }
                    Section {
                        Button {
                            Task { await transfer() }
                        } label: {
                            if wallet.isWorking {
                                ProgressView().frame(maxWidth: .infinity)
                            } else {
                                Text("Move Funds").frame(maxWidth: .infinity)
                            }
                        }
                        .disabled(amount == nil || amount == 0 || mintURL.isEmpty || wallet.isWorking)
                    }
                }
                if let completedMessage {
                    Section { Label(completedMessage, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                }
                if wallet.snapshot.mints.count > 1 {
                    Section("eCash Mints") {
                        Button("Swap Between Mints", systemImage: "building.columns.fill") { showingMintSwap = true }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Swap")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { if mintURL.isEmpty { mintURL = mintChoices.first?.url ?? "" } }
            .sheet(isPresented: $showingMintSwap) { MintTransferSheet(wallet: wallet) }
            .alert("Swap", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) {
                Button("OK", role: .cancel) { localError = nil }
            } message: { Text(localError ?? "") }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private func transfer() async {
        guard let amount, amount > 0 else { return }
        localError = nil
        completedMessage = nil
        do {
            switch direction {
            case .toNWC:
                try await wallet.swapEcashToNWC(amount: amount, sourceMintURL: mintURL)
                completedMessage = "Moved \(wallet.formattedSats(amount)) to \(wallet.nwcWalletLabel)."
            case .toEcash:
                try await wallet.swapNWCToEcash(amount: amount, destinationMintURL: mintURL)
                completedMessage = "Moved \(wallet.formattedSats(amount)) to Taskify eCash."
            }
            amountText = ""
        } catch {
            localError = WalletViewModel.message(for: error)
        }
    }
}

struct WalletCurrencySettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Currency Conversion") {
                    Picker("Conversion", selection: Binding(
                        get: { model.walletConversionEnabled },
                        set: { model.setWalletConversionEnabled($0) }
                    )) {
                        Text("On").tag(true)
                        Text("Off").tag(false)
                    }
                    .pickerStyle(.segmented)
                    Text("Show USD equivalents using the current BTC spot price.")
                        .font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                }
                Section("Bitcoin Denomination") {
                    Picker("Denomination", selection: Binding(
                        get: { model.walletDenominationDisplay },
                        set: { model.setWalletDenominationDisplay($0) }
                    )) {
                        Text("\(WalletAmountFormat.bitcoinSymbol)42,778").tag(WalletDenominationDisplay.bitcoinSymbol)
                        Text("42,778 sat").tag(WalletDenominationDisplay.sat)
                    }
                    .pickerStyle(.segmented)
                }
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Currency")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }
}

struct WalletRecipientKeysSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var importSecret = ""
    @State private var importLabel = ""
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Private recipient keys stay in this device's Keychain. Share only the public key when someone should lock eCash to you.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                Section("Keys") {
                    ForEach(wallet.p2pkKeys) { key in
                        HStack(spacing: 12) {
                            Image(systemName: wallet.primaryP2PKKey?.id == key.id ? "key.fill" : "key")
                                .foregroundStyle(TaskifyTheme.accent)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(key.label ?? "Recipient key")
                                Text("\(key.publicKey.prefix(12))…\(key.publicKey.suffix(8))")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                            }
                            Spacer()
                            Menu {
                                Button("Copy Public Key", systemImage: "doc.on.doc") {
                                    UIPasteboard.general.string = key.publicKey
                                    message = "Public key copied."
                                }
                                if wallet.primaryP2PKKey?.id != key.id {
                                    Button("Make Primary", systemImage: "checkmark.circle") {
                                        Task { try? await wallet.setPrimaryP2PKKey(id: key.id) }
                                    }
                                }
                            } label: { Image(systemName: "ellipsis.circle") }
                        }
                    }
                    Button("Generate Recipient Key", systemImage: "plus") {
                        Task {
                            do {
                                _ = try await wallet.generateP2PKKey(label: "Taskify iPhone")
                                message = "Recipient key created."
                            } catch { message = WalletViewModel.message(for: error) }
                        }
                    }
                }
                Section("Import") {
                    TextField("Label (optional)", text: $importLabel)
                    SecureField("nsec or 64-character secret", text: $importSecret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Import Key") {
                        Task {
                            do {
                                _ = try await wallet.importP2PKKey(secret: importSecret, label: importLabel)
                                importSecret = ""
                                importLabel = ""
                                message = "Recipient key imported."
                            } catch { message = WalletViewModel.message(for: error) }
                        }
                    }
                    .disabled(importSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let message { Section { Text(message).font(.caption) } }
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Recipient Keys")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }
}

enum WalletActivityItem: Identifiable {
    case outgoingToken(CashuOutgoingToken)
    case transaction(CashuTransactionSummary)
    case lightningInvoice(CashuLightningReceiveQuote)

    var id: String {
        switch self {
        case .outgoingToken(let outgoing): "outgoing-token-\(outgoing.id)"
        case .transaction(let transaction): "transaction-\(transaction.id)"
        case .lightningInvoice(let quote): "lightning-invoice-\(quote.id)"
        }
    }

    var date: Date {
        switch self {
        case .outgoingToken(let outgoing): outgoing.createdAt
        case .transaction(let transaction): transaction.date
        case .lightningInvoice(let quote): quote.createdAt
        }
    }

    var isPending: Bool {
        switch self {
        case .outgoingToken(let outgoing):
            outgoing.status == .ready || outgoing.status == .partiallyRedeemed
        case .transaction(let transaction):
            transaction.state == .pending
                || transaction.outgoingTokenStatus == .ready
                || transaction.outgoingTokenStatus == .partiallyRedeemed
        case .lightningInvoice(let quote):
            quote.state == .unpaid || quote.state == .paid || quote.state == .pending
        }
    }
}

#endif
