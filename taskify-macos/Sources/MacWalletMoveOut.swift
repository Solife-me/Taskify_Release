import SwiftUI
import TaskifyCore
import TaskifyWallet

struct MacWalletMoveOutView: View {
    @EnvironmentObject private var wallet: WalletViewModel
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
        Form {
            Section {
                Text("Move funds out")
                    .font(.largeTitle.bold())
                Text(WalletMoveOutContent.intro)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
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
                    MacWalletSavedTokensList(wallet: wallet) { errorMessage = $0 }
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .task { await wallet.checkSavedTokens() }
        .sheet(isPresented: $showingLightning) {
            MacWalletTransfer(mode: "pay")
        }
        .sheet(isPresented: $showingEcash) {
            MacWalletTransfer(mode: "send")
        }
        .sheet(isPresented: $showingNWC) {
            MacWalletMoveToNWCView()
        }
        .sheet(isPresented: $showingWords) {
            MacWalletRecoveryWordsView()
        }
    }

    private func routeRow(_ route: WalletMoveOutRoute) -> some View {
        Button {
            open(route.id)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: route.systemImage)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(route.title)
                    Text(route.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
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

struct MacWalletMoveToNWCView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var isMoving = false
    @State private var error: String?

    private var ecashTotal: UInt64 {
        wallet.ecashMintBalances.reduce(0) { $0 + $1.available }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Move to your NWC wallet").font(.title2.bold())
            if wallet.nwcWallets.isEmpty {
                ContentUnavailableView(
                    "No NWC wallet",
                    systemImage: "bolt.slash",
                    description: Text("Connect an NWC wallet first, then move the remaining ecash balance to it.")
                )
            } else {
                Text("Pays your connected wallet over Lightning from every eCash mint that still has a balance.")
                    .foregroundStyle(.secondary)
                Text(ecashTotal > 0
                     ? "\(wallet.formattedSats(ecashTotal)) to move"
                     : "Nothing left to move.")
                    .font(.headline)

                if let journal = wallet.nwcMigrationJournal {
                    GroupBox("Transfer to \(wallet.nwcWalletLabel)") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(journal.sources, id: \.sourceID) { source in
                                HStack {
                                    Text(URL(string: source.sourceID)?.host() ?? source.label)
                                    Spacer()
                                    Text(Self.label(for: source.status))
                                        .foregroundStyle(source.status == .failed ? .red : .secondary)
                                }
                                if source.sentSat > 0 {
                                    Text("Sent \(wallet.formattedSats(source.sentSat)) · fees \(wallet.formattedSats(source.feesSat))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if let sourceError = source.error {
                                    Text(sourceError).font(.caption).foregroundStyle(.red)
                                }
                            }
                        }
                        .padding(8)
                    }
                }

                Button(ecashTotal > 0 ? "Move \(wallet.formattedSats(ecashTotal))" : "Nothing to move") {
                    Task {
                        isMoving = true
                        defer { isMoving = false }
                        _ = await wallet.migrateToNWC()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isMoving || wallet.isMovingToNWC || ecashTotal == 0)
            }

            if isMoving || wallet.isMovingToNWC {
                ProgressView("Moving…").controlSize(.small)
            }
            if let error {
                Text(error).foregroundStyle(.red)
            }

            Spacer()
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isMoving || wallet.isMovingToNWC)
            }
        }
        .padding(26)
        .frame(width: 560, height: 460)
        .interactiveDismissDisabled(isMoving || wallet.isMovingToNWC)
        .task { await wallet.refreshNWC() }
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
}

struct MacWalletRecoveryWordsView: View {
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var phrase: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("The 12 words").font(.title2.bold())
            Text("A NUT-13 wallet can restore most of these funds from them.")
                .foregroundStyle(.secondary)

            if let phrase {
                ScrollView {
                    Text(phrase)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                Button("Copy") { macCopySecret(phrase) }
            } else {
                Button("Show the 12 words") {
                    Task {
                        do {
                            try await authenticate("Show your wallet's 12 words")
                            phrase = try await wallet.recoveryPhrase()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            }

            if let error {
                Text(error).foregroundStyle(.red)
            }

            Spacer()
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(26)
        .frame(width: 520, height: 360)
    }
}

struct MacWalletSavedTokensList: View {
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
                    Button("Check again") {
                        Task { await wallet.checkSavedTokens() }
                    }
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
                        .foregroundStyle(.secondary)
                    HStack(spacing: 16) {
                        Button(copiedID == token.id ? "Copied" : "Copy") {
                            macCopySecret(token.token)
                            copiedID = token.id
                        }
                        if state != .unspent {
                            Button("Remove", role: .destructive) {
                                Task {
                                    do {
                                        try await wallet.removeSavedToken(token)
                                    } catch {
                                        onError(error.localizedDescription)
                                    }
                                }
                            }
                        }
                    }
                    .font(.caption)
                }
            }
        }
    }

    private static func describe(_ state: CashuNUT07.TokenState?, mint: String?) -> String {
        let mintName = mint.flatMap { URL(string: $0)?.host } ?? "its mint"
        return switch state {
        case .unspent:
            "Still holds funds at \(mintName). Copy it and redeem it in another Cashu wallet."
        case .unknown:
            "\(mintName) could not be asked about it. Copy it to keep it, then remove it."
        case .spent, nil:
            "Not checked yet."
        }
    }
}
