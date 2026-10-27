import SwiftUI
import TaskifyCore
import TaskifyWallet

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

    private var routes: [WalletMoveOutRoute] {
        WalletMoveOutContent.routes(
            balanceSats: balance,
            hasNWCWallet: !wallet.nwcWallets.isEmpty,
            usesNpubCashProvider: LightningAddressSettings.provider == .npubCash,
            claimMessage: claimMessage,
            isBusy: wallet.isWorking
        )
    }

    private var sections: [WalletMoveOutRoute.Section] {
        WalletMoveOutRoute.Section.allCases
            .filter { section in routes.contains { $0.section == section } }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(WalletMoveOutContent.intro)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                    Text(WalletMoveOutContent.balanceText(
                        formattedBalance: wallet.formattedSats(balance),
                        hasFunds: balance > 0
                    ))
                    .font(.headline)
                }

                ForEach(sections, id: \.rawValue) { section in
                    Section(WalletMoveOutContent.sectionTitle(for: section)) {
                        ForEach(routes.filter { $0.section == section }) { route in
                            routeRow(route)
                        }
                    }
                }

                if !wallet.savedTokens.isEmpty {
                    Section("Saved tokens") {
                        WalletSavedTokensList(wallet: wallet) { errorMessage = $0 }
                    }
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

    private func routeRow(_ route: WalletMoveOutRoute) -> some View {
        Button {
            open(route.id)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: route.systemImage)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.accent)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(route.title).foregroundStyle(TaskifyTheme.primaryText)
                    Text(route.detail).font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
        }
        .disabled(!route.isEnabled)
        .opacity(route.isEnabled ? 1 : 0.45)
    }

    private func open(_ id: WalletMoveOutRoute.ID) {
        switch id {
        case .receive:
            break
        case .payLightning:
            showingLightning = true
        case .makeEcashToken:
            showingEcash = true
        case .moveToNWC:
            showingNWC = true
        case .claimNpubCash:
            Task {
                let claimed = await wallet.claimNpubCash(auto: false)
                claimMessage = claimed > 0
                    ? "Claimed \(claimed) payment\(claimed == 1 ? "" : "s")."
                    : "Nothing to claim."
            }
        case .showRecoveryWords:
            showingWords = true
        }
    }
}
