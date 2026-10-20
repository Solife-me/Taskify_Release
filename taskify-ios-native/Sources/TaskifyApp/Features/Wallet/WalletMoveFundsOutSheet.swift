import SwiftUI
import TaskifyCore

/// The wallet's only way forward while it is phased out (C9-1, matching the PWA's
/// `MoveFundsOutSheet`): every route out of the Taskify wallet, and none in.
struct WalletMoveFundsOutSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showingLightning = false
    @State private var showingEcash = false
    @State private var showingNWC = false
    @State private var showingWords = false
    @State private var claimMessage: String?
    @State private var errorMessage: String?

    private var balance: UInt64 { wallet.snapshot.available }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("The wallet no longer takes in new funds, and it closes on \(TaskifyWalletPhaseOut.removalDateText). Move what is left to a wallet you keep.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                    Text(balance > 0 ? "\(wallet.formattedSats(balance)) to move" : "Nothing left to move.")
                        .font(.headline)
                }

                Section("To a Lightning wallet") {
                    route(
                        "Pay an invoice or Lightning address",
                        detail: "From your own wallet's receive screen.",
                        icon: "bolt.fill",
                        enabled: balance > 0
                    ) { showingLightning = true }
                }

                Section("As ecash, to another Cashu wallet") {
                    route(
                        "Make an ecash token",
                        detail: "Redeem it in Minibits, Cashu.me or another Cashu wallet. It stays in History until claimed.",
                        icon: "banknote",
                        enabled: balance > 0
                    ) { showingEcash = true }
                    if !wallet.nwcWallets.isEmpty {
                        route(
                            "Move to your NWC wallet",
                            detail: "Pays your connected wallet over Lightning.",
                            icon: "arrow.right.circle",
                            enabled: balance > 0
                        ) { showingNWC = true }
                    }
                }

                if LightningAddressSettings.provider == .npubCash {
                    Section("npub.cash") {
                        route(
                            "Claim payments waiting at npub.cash",
                            detail: claimMessage ?? "Payments to your old address arrive here first; move them out after claiming.",
                            icon: "tray.and.arrow.down",
                            enabled: !wallet.isWorking
                        ) {
                            Task {
                                let claimed = await wallet.claimNpubCash(auto: false)
                                claimMessage = claimed > 0 ? "Claimed \(claimed) payment\(claimed == 1 ? "" : "s")." : "Nothing to claim."
                            }
                        }
                    }
                }

                if !wallet.savedTokens.isEmpty {
                    Section("Saved tokens") {
                        WalletSavedTokensList(wallet: wallet) { errorMessage = $0 }
                    }
                }

                Section("Restore in another Cashu wallet") {
                    route(
                        "Show the 12 words",
                        detail: "A NUT-13 wallet can restore most of these funds from them.",
                        icon: "key.viewfinder",
                        enabled: true
                    ) { showingWords = true }
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Move funds out")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await wallet.checkSavedTokens() }
            .sheet(isPresented: $showingLightning) {
                SendLightningSheet(wallet: wallet, onSwitchMode: {
                    showingLightning = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showingEcash = true }
                })
            }
            .sheet(isPresented: $showingEcash) {
                SendCashuSheet(wallet: wallet, onSwitchMode: {
                    showingEcash = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showingLightning = true }
                })
            }
            .sheet(isPresented: $showingNWC) { WalletSwapSheet(wallet: wallet) }
            .sheet(isPresented: $showingWords) { WalletRecoverySheet(wallet: wallet) }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private func route(_ title: String, detail: String, icon: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.accent)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).foregroundStyle(TaskifyTheme.primaryText)
                    Text(detail).font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}
