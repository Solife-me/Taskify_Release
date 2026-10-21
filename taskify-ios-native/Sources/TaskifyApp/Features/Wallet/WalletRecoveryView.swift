import LocalAuthentication
import SwiftUI
import TaskifyCore
import TaskifyWallet
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// The Wallet tab from December 1, 2026 (C9-2, matching the PWA's `WalletRecoveryView`): what is
/// left, as tokens any Cashu wallet can redeem, and the 12 words. It reads storage only.
struct WalletRecoveryView: View {
    @State private var snapshot: CashuWalletRecoverySnapshot?
    @State private var words: [String]?
    @State private var copiedID: String?
    @State private var errorMessage: String?

    private var secondaryText: Color {
        #if canImport(UIKit)
        TaskifyTheme.secondaryText
        #else
        .secondary
        #endif
    }

    private var background: some View {
        #if canImport(UIKit)
        TaskifyTheme.background
        #else
        Color.black.opacity(0.92)
        #endif
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("The Taskify wallet closed on \(TaskifyWalletPhaseOut.removalDateText). Copy each token below into another Cashu wallet, such as Minibits or Cashu.me, to redeem it. A NUT-13 wallet can also restore most funds from the 12 words.")
                        .font(.subheadline)
                        .foregroundStyle(secondaryText)
                }

                if let snapshot {
                    if snapshot.isEmpty {
                        Section { Text("Nothing is left in this wallet.").foregroundStyle(secondaryText) }
                    }
                    if !snapshot.mints.isEmpty {
                        Section("Your notes, one token per mint") {
                            ForEach(snapshot.mints) { mint in
                                tokenRow(id: "mint-\(mint.mintURL)", amount: mint.amount, mintURL: mint.mintURL, token: mint.token)
                            }
                        }
                    }
                    if !snapshot.savedTokens.isEmpty {
                        Section("Saved tokens") {
                            ForEach(snapshot.savedTokens) { token in
                                tokenRow(id: "saved-\(token.id)", amount: token.amount, mintURL: token.mintURL, token: token.token)
                            }
                        }
                    }
                    if !snapshot.unclaimedSentTokens.isEmpty {
                        Section {
                            ForEach(snapshot.unclaimedSentTokens) { token in
                                tokenRow(id: "sent-\(token.id)", amount: token.amount, mintURL: token.mintURL, token: token.token)
                            }
                        } header: {
                            Text("Sent, not yet claimed")
                        } footer: {
                            Text("If the person you sent these to never claims them, you can redeem them yourself.")
                        }
                    }
                } else {
                    Section { ProgressView("Reading the wallet…") }
                }

                Section("The 12 words") {
                    if let words {
                        Text(words.enumerated().map { "\($0 + 1). \($1)" }.joined(separator: "   "))
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                    } else {
                        Button("Show the 12 words") { Task { await revealWords() } }
                    }
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(background.ignoresSafeArea())
            .navigationTitle("Recover your wallet")
            .task { await load() }
        }
    }

    private func tokenRow(id: String, amount: UInt64?, mintURL: String?, token: String) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(amount.map { "\($0.formatted()) sats" } ?? "Cashu token").font(.headline)
                Text(mintURL.flatMap { URL(string: $0)?.host } ?? "Unknown mint")
                    .font(.caption)
                    .foregroundStyle(secondaryText)
            }
            Spacer()
            Button(copiedID == id ? "Copied" : "Copy token") {
                copy(token)
                copiedID = id
            }
            .buttonStyle(.bordered)
        }
    }

    private func load() async {
        guard snapshot == nil else { return }
        do {
            guard let urls = try WalletViewModel.recoveryFileURLs() else {
                snapshot = .empty
                return
            }
            snapshot = await CashuWalletRecovery.load(databaseURL: urls.database, outgoingTokensURL: urls.outgoing, pendingReceivesURL: urls.pending)
        } catch {
            errorMessage = error.localizedDescription
            snapshot = .empty
        }
    }

    private func revealWords() async {
        let context = LAContext()
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            guard (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Show your wallet's 12 words")) == true else { return }
        }
        do {
            guard let mnemonic = try KeychainWalletSeedStore().load() else {
                errorMessage = "This device has no wallet seed."
                return
            }
            words = mnemonic.split(separator: " ").map(String.init)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func copy(_ token: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = token
        #else
        NSPasteboard.general.setString(token, forType: .string)
        #endif
    }
}
