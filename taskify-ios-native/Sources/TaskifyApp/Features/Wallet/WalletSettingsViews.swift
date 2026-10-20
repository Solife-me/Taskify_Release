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
    @State private var showingSwap = false
    @State private var showingMints = false
    @State private var showingRecovery = false
    @State private var showingCurrency = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    settingsRow("Wallets", detail: wallet.isNWCWalletActive ? wallet.nwcWalletLabel : "Taskify eCash", icon: "wallet.pass") { showingWallets = true }
                    settingsRow("Move to NWC Wallet", detail: "Pay your connected wallet from eCash", icon: "arrow.right.circle") { showingSwap = true }
                    settingsRow("Mints", detail: "Manage eCash balances", icon: "building.columns") { showingMints = true }
                    settingsRow("Backup & Recovery", detail: "Protect the built-in wallet", icon: "key.viewfinder") { showingRecovery = true }
                    settingsRow("Currency", detail: model.walletConversionEnabled ? "Sats and USD" : "Sats only", icon: "bitcoinsign.circle") { showingCurrency = true }
                    WalletCloseOutCard(wallet: wallet) { dismiss() }
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Wallet Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showingWallets) { WalletManagerSheet(wallet: wallet) }
            .sheet(isPresented: $showingSwap) { WalletSwapSheet(wallet: wallet) }
            .sheet(isPresented: $showingMints) { MintManagerSheet(wallet: wallet) }
            .sheet(isPresented: $showingRecovery) { WalletRecoverySheet(wallet: wallet) }
            .sheet(isPresented: $showingCurrency) { WalletCurrencySettingsSheet().environment(model) }
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

/// Lets a user who has moved everything out return this device to the no-wallet state.
/// Saved tokens in the close-out card (C9-3): each with what its mint said, a Copy button, and
/// Remove for one that holds no funds or could not be checked (a copy stays in History).
struct WalletSavedTokensList: View {
    @ObservedObject var wallet: WalletViewModel
    var onError: (String) -> Void
    @State private var copiedID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Saved tokens").font(.caption.weight(.semibold))
                Spacer()
                if wallet.isCheckingSavedTokens {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Check again") { Task { await wallet.checkSavedTokens() } }
                        .font(.caption)
                }
            }
            ForEach(wallet.savedTokens) { token in
                let state = wallet.savedTokenStates[token.id]
                VStack(alignment: .leading, spacing: 4) {
                    Text(token.amount.map { wallet.formattedSats($0) } ?? "Cashu token")
                        .font(.caption.weight(.semibold))
                    Text(Self.describe(state, mint: token.mintURL))
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                    HStack(spacing: 16) {
                        Button(copiedID == token.id ? "Copied" : "Copy") {
                            UIPasteboard.general.string = token.token
                            copiedID = token.id
                        }
                        if state != .unspent {
                            Button("Remove", role: .destructive) {
                                Task {
                                    do { try await wallet.removeSavedToken(token) } catch { onError(error.localizedDescription) }
                                }
                            }
                        }
                    }
                    .font(.caption)
                }
                .accessibilityElement(children: .contain)
            }
        }
        .foregroundStyle(TaskifyTheme.secondaryText)
    }

    private static func describe(_ state: CashuNUT07.TokenState?, mint: String?) -> String {
        let mintName = mint.flatMap { URL(string: $0)?.host } ?? "its mint"
        switch state {
        case .unspent: return "Still holds funds at \(mintName). Copy it and redeem it in another Cashu wallet."
        case .unknown: return "\(mintName) could not be asked about it. Copy it to keep it, then remove it."
        case .spent, nil: return "Not checked yet."
        }
    }
}

private struct WalletCloseOutCard: View {
    @ObservedObject var wallet: WalletViewModel
    var onClosed: () -> Void
    @State private var confirming = false
    @State private var isClosing = false
    @State private var errorMessage: String?

    var body: some View {
        let blockers = wallet.closeOutBlockers
        VStack(alignment: .leading, spacing: 10) {
            Text("Close Out Wallet").font(.headline).foregroundStyle(TaskifyTheme.primaryText)
            Text("The Taskify wallet is being phased out. Once all your funds have been moved out, close it to remove the wallet from Taskify on this device.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
            if !blockers.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Move these first:").font(.caption.weight(.semibold))
                    ForEach(blockers, id: \.self) { blocker in
                        Label(blocker, systemImage: "exclamationmark.circle").font(.caption)
                    }
                }
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
            if !wallet.savedTokens.isEmpty {
                WalletSavedTokensList(wallet: wallet) { errorMessage = $0 }
            }
            if let errorMessage {
                Text(errorMessage).font(.caption).foregroundStyle(.red)
            }
            Button(role: .destructive) {
                confirming = true
            } label: {
                if isClosing {
                    ProgressView()
                } else {
                    Text("Close Out Wallet")
                }
            }
            .disabled(!blockers.isEmpty || isClosing)
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 20)
        // A saved token redeemed elsewhere is found and removed as soon as the card shows (C9-3).
        .task { await wallet.checkSavedTokens() }
        .confirmationDialog("Close out the Taskify wallet?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Close Wallet", role: .destructive) {
                isClosing = true
                errorMessage = nil
                Task {
                    defer { isClosing = false }
                    do {
                        try await wallet.closeOutWallet()
                        onClosed()
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(closeOutMessage)
        }
    }

    private var closeOutMessage: String {
        var lines: [String] = []
        let unclaimed = wallet.unclaimedSentTokenSats
        if unclaimed > 0 {
            lines.append("\(wallet.formattedSats(unclaimed)) are in tokens you sent that haven't been redeemed yet. If they're never claimed, you can recover them by restoring your seed phrase in another Cashu wallet.")
        }
        lines.append("Your seed phrase stays on this device. The wallet comes back automatically if funds ever arrive here again.")
        return lines.joined(separator: "\n\n")
    }
}

struct WalletSwapSheet: View {
    /// Only out of the Taskify wallet while it is phased out (C9-1).
    enum Direction: String, CaseIterable, Identifiable {
        case toNWC = "eCash → NWC"
        var id: String { rawValue }
    }

    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var direction = Direction.toNWC
    @State private var amountText = ""
    @State private var mintURL = ""
    @State private var localError: String?
    @State private var completedMessage: String?

    private var amount: UInt64? { UInt64(amountText.trimmingCharacters(in: .whitespacesAndNewlines)) }
    private var mintChoices: [CashuMintSummary] {
        wallet.snapshot.mints.filter { $0.available > 0 }
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
                    Section("Amount") {
                        TextField("Sats", text: $amountText)
                            .keyboardType(.numberPad)
                        Text("Lightning and mint fees are shown by the source wallet and deducted in addition to the transfer amount.")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    Section("Source Mint") {
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
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Move to NWC Wallet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { if mintURL.isEmpty { mintURL = mintChoices.first?.url ?? "" } }
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
