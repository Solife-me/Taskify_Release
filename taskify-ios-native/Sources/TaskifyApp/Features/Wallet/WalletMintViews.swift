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
struct MintManagerSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var mintURL = ""
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Mints hold your ecash. A balance at one mint is separate from balances at other mints.")
                            .font(.subheadline)
                            .foregroundStyle(TaskifyTheme.secondaryText)

                        if wallet.snapshot.mints.isEmpty {
                            ContentUnavailableView(
                                "No mints yet",
                                systemImage: "building.columns",
                                description: Text("Add a mint below to begin.")
                            )
                            .foregroundStyle(TaskifyTheme.secondaryText)
                        }

                        ForEach(wallet.snapshot.mints) { mint in
                            Button { wallet.selectMint(mint.url) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: wallet.activeMint?.url == mint.url ? "checkmark.circle.fill" : "circle")
                                        .font(.title3)
                                        .foregroundStyle(wallet.activeMint?.url == mint.url ? TaskifyTheme.accent : TaskifyTheme.tertiaryText)

                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(mint.name)
                                            .font(.headline)
                                            .foregroundStyle(TaskifyTheme.primaryText)
                                        Text(mint.url)
                                            .font(.caption)
                                            .foregroundStyle(TaskifyTheme.tertiaryText)
                                            .lineLimit(1)
                                    }

                                    Spacer()

                                    Text("\(wallet.formattedSats(mint.available))")
                                        .font(.subheadline.weight(.semibold).monospacedDigit())
                                        .foregroundStyle(TaskifyTheme.primaryText)
                                }
                                .padding(15)
                                .taskifyGlass(cornerRadius: 20)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Remove mint", systemImage: "trash", role: .destructive) {
                                    Task {
                                        do { try await wallet.removeMint(mint.url) }
                                        catch { localError = WalletViewModel.message(for: error) }
                                    }
                                }
                                .disabled(mint.total > 0)
                            }
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            Text("Add a mint")
                                .font(.headline)
                                .foregroundStyle(TaskifyTheme.primaryText)

                            TextField("https://mint.example.com", text: $mintURL)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.URL)
                                .autocorrectionDisabled()
                                .padding(.horizontal, 15)
                                .frame(height: 50)
                                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TaskifyTheme.border))
                                .foregroundStyle(TaskifyTheme.primaryText)

                            Button {
                                Task {
                                    do {
                                        try await wallet.addMint(mintURL)
                                        mintURL = ""
                                    } catch {
                                        localError = WalletViewModel.message(for: error)
                                    }
                                }
                            } label: {
                                Label(wallet.isWorking ? "Connecting…" : "Add mint", systemImage: "plus")
                                    .font(.headline)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 13)
                                    .foregroundStyle(.white)
                                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.75))
                            }
                            .buttonStyle(.plain)
                            .disabled(wallet.isWorking || mintURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                            if mintURL.isEmpty && wallet.snapshot.mints.isEmpty {
                                Button("Use \(WalletViewModel.suggestedMintURL)") {
                                    mintURL = WalletViewModel.suggestedMintURL
                                }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.accent)
                                .frame(maxWidth: .infinity)
                            }
                        }
                        .padding(18)
                        .taskifyGlass(cornerRadius: 22)
                    }
                    .padding(18)
                    .padding(.bottom, 30)
                }
            }
            .navigationTitle("Mints")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Mint", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct MintTransferSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var sourceMintURL = ""
    @State private var destinationMintURL = ""
    @State private var amountText = ""
    @State private var result: CashuMintTransferResult?
    @State private var localError: String?
    @FocusState private var amountFocused: Bool

    private var amount: UInt64? {
        UInt64(amountText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var sourceMint: CashuMintSummary? {
        wallet.snapshot.mints.first { $0.url == sourceMintURL }
    }

    private var destinationMint: CashuMintSummary? {
        wallet.snapshot.mints.first { $0.url == destinationMintURL }
    }

    private var canTransfer: Bool {
        guard let amount, amount > 0, let sourceMint else { return false }
        return sourceMintURL != destinationMintURL
            && !destinationMintURL.isEmpty
            && amount <= sourceMint.available
            && !wallet.isWorking
    }

    private var transferHasCompleted: Bool {
        guard let result else { return false }
        if result.state == .completed { return true }
        return wallet.lightningReceiveQuotes.contains {
            $0.id == result.receiveQuoteID && $0.state == .issued
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    Group {
                        if result != nil {
                            resultView
                        } else if wallet.snapshot.mints.count < 2 {
                            ContentUnavailableView {
                                Label("Two mints needed", systemImage: "arrow.left.arrow.right")
                            } description: {
                                Text("Add another mint from Wallet → Mints before moving a balance.")
                            }
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .padding(.top, 70)
                        } else {
                            transferForm
                        }
                    }
                    .padding(22)
                }
            }
            .navigationTitle("Move between mints")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .disabled(wallet.isWorking)
                }
            }
            .alert("Mint transfer", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(wallet.isWorking)
        .onAppear(perform: chooseInitialMints)
        .onChange(of: sourceMintURL) { _, source in
            guard source == destinationMintURL else { return }
            destinationMintURL = wallet.snapshot.mints.first { $0.url != source }?.url ?? ""
        }
    }

    private var transferForm: some View {
        VStack(spacing: 18) {
            Image(systemName: "arrow.left.arrow.right.circle.fill")
                .font(.system(size: 54))
                .foregroundStyle(TaskifyTheme.accent)

            Text("Move your balance")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            Text("Taskify creates an invoice at the destination mint, pays it from the source mint, and claims the new ecash automatically.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.secondaryText)

            VStack(spacing: 12) {
                mintPicker(
                    title: "FROM",
                    selection: $sourceMintURL,
                    selectedMint: sourceMint,
                    options: wallet.snapshot.mints.filter { $0.available > 0 }
                )

                Button {
                    let oldSource = sourceMintURL
                    sourceMintURL = destinationMintURL
                    destinationMintURL = oldSource
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                        .font(.subheadline.bold())
                        .frame(width: 42, height: 42)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Swap source and destination mints")
                .disabled((destinationMint?.available ?? 0) == 0)
                .opacity((destinationMint?.available ?? 0) == 0 ? 0.45 : 1)

                mintPicker(
                    title: "TO",
                    selection: $destinationMintURL,
                    selectedMint: destinationMint,
                    options: wallet.snapshot.mints.filter { $0.url != sourceMintURL }
                )
            }

            VStack(spacing: 5) {
                TextField("0", text: $amountText)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .font(.system(size: 46, weight: .bold, design: .rounded))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .focused($amountFocused)
                Text(WalletAmountFormat.inputUnitLabel(display: WalletCurrencySettings.denominationDisplay))
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let sourceMint {
                    Text("\(wallet.formattedSats(sourceMint.available)) available")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity)
            .taskifyGlass(cornerRadius: 26)

            Button {
                guard let amount else { return }
                amountFocused = false
                Task {
                    do {
                        result = try await wallet.transferBetweenMints(
                            amount: amount,
                            sourceMintURL: sourceMintURL,
                            destinationMintURL: destinationMintURL
                        )
                    } catch {
                        localError = WalletViewModel.message(for: error)
                    }
                }
            } label: {
                HStack(spacing: 9) {
                    if wallet.isWorking { ProgressView().tint(.white) }
                    Text(wallet.isWorking ? "Moving balance…" : "Transfer")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(.white)
                .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(!canTransfer)
            .opacity(canTransfer || wallet.isWorking ? 1 : 0.45)

            Label(
                "The source balance also covers Lightning and mint fees. If claiming takes longer, it continues through Taskify's saved invoice monitor.",
                systemImage: "bolt.horizontal.circle"
            )
            .font(.caption)
            .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }

    private var resultView: some View {
        VStack(spacing: 20) {
            Image(systemName: transferHasCompleted ? "checkmark.circle.fill" : "clock.badge.checkmark.fill")
                .font(.system(size: 72))
                .foregroundStyle(transferHasCompleted ? Color.green : Color.orange)
                .symbolEffect(.bounce, value: transferHasCompleted)

            Text(transferHasCompleted ? "Transfer complete" : "Transfer is finishing")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            if let result {
                Text("\(wallet.formattedSats((transferHasCompleted ? max(result.receivedAmount, result.amount) : result.amount)))")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(TaskifyTheme.primaryText)

                VStack(spacing: 13) {
                    transferResultRow("From", value: mintName(for: result.sourceMintURL))
                    transferResultRow("To", value: mintName(for: result.destinationMintURL))
                    if let fee = result.feePaid {
                        transferResultRow("Fee paid", value: "\(wallet.formattedSats(fee))")
                    }
                    transferResultRow("Status", value: transferHasCompleted ? "Received" : "Claiming in background")
                }
                .padding(18)
                .taskifyGlass(cornerRadius: 22)
            }

            Text(transferHasCompleted
                ? "The destination mint balance is ready to use."
                : "The Lightning payment was submitted. You can close this sheet; Taskify will keep checking and claim the destination balance automatically.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Button("Done") { dismiss() }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(.white)
                .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
                .buttonStyle(.plain)
        }
    }

    private func mintPicker(
        title: String,
        selection: Binding<String>,
        selectedMint: CashuMintSummary?,
        options: [CashuMintSummary]
    ) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.caption2.bold())
                    .tracking(1.1)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                Text(selectedMint?.name ?? "Select mint")
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.primaryText)
                if let selectedMint {
                    Text("\(wallet.formattedSats(selectedMint.available))")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            Spacer()
            Picker(title, selection: selection) {
                ForEach(options) { mint in
                    Text("\(mint.name) · \(wallet.formattedSats(mint.available))").tag(mint.url)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .tint(TaskifyTheme.accent)
        }
        .padding(16)
        .taskifyGlass(cornerRadius: 20)
    }

    private func transferResultRow(_ title: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundStyle(TaskifyTheme.secondaryText)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
                .foregroundStyle(TaskifyTheme.primaryText)
        }
        .font(.subheadline)
    }

    private func chooseInitialMints() {
        guard sourceMintURL.isEmpty else { return }
        let mints = wallet.snapshot.mints
        sourceMintURL = wallet.activeMint.flatMap { $0.available > 0 ? $0.url : nil }
            ?? mints.first(where: { $0.available > 0 })?.url
            ?? mints.first?.url
            ?? ""
        destinationMintURL = mints.first { $0.url != sourceMintURL }?.url ?? ""
    }

    private func mintName(for url: String) -> String {
        wallet.snapshot.mints.first { $0.url == url }?.name ?? url
    }
}

struct WalletRecoverySheet: View {
    private enum Page: String, CaseIterable, Identifiable {
        case backup = "Back Up"
        case restore = "Restore"

        var id: String { rawValue }
    }

    private enum RecoveryAction {
        case transfer
        case replace
    }

    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage("taskify.wallet.recovery-acknowledged") private var recoveryAcknowledged = false
    @State private var page: Page = .backup
    @State private var phrase: String?
    @State private var isAuthenticating = false
    @State private var localError: String?
    @State private var copied = false
    @State private var exportDocument: WalletSeedBackupDocument?
    @State private var showingExporter = false
    @State private var showingImporter = false
    @State private var recoveryInput = ""
    @State private var mintURLs = WalletViewModel.suggestedMintURL
    @State private var material: CashuRecoveryMaterial?
    @State private var confirmingRestore = false
    @State private var recoveryAction: RecoveryAction = .transfer
    @State private var showingAdvancedReplacement = false
    @State private var outcome: WalletRestoreOutcome?

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 18) {
                        Picker("Wallet recovery", selection: $page) {
                            ForEach(Page.allCases) { page in
                                Text(page.rawValue).tag(page)
                            }
                        }
                        .pickerStyle(.segmented)

                        if page == .backup {
                            backupView
                        } else {
                            restoreView
                        }
                    }
                    .padding(20)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Wallet recovery")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Wallet recovery", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
            .confirmationDialog(
                recoveryAction == .transfer ? "Transfer ecash into Taskify?" : "Replace the Taskify wallet seed?",
                isPresented: $confirmingRestore,
                titleVisibility: .visible
            ) {
                if recoveryAction == .transfer {
                    Button("Transfer ecash") { performRestore() }
                } else {
                    Button("Replace wallet seed", role: .destructive) { performRestore() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                if recoveryAction == .transfer {
                    Text("Taskify keeps its current recovery words. Spendable ecash recovered from the imported seed is reissued into this wallet; normal mint receive fees may reduce the deposited amount.")
                } else {
                    Text("This advanced action changes Taskify's recovery words. It is allowed only when the current wallet has no balance, pending ecash, or unredeemed outgoing tokens.")
                }
            }
        }
        .preferredColorScheme(.dark)
        .fileExporter(
            isPresented: $showingExporter,
            document: exportDocument,
            contentType: .json,
            defaultFilename: Self.backupFilename
        ) { result in
            switch result {
            case .success:
                recoveryAcknowledged = true
                wallet.statusMessage = "Wallet backup saved"
            case .failure(let error):
                localError = error.localizedDescription
            }
            exportDocument = nil
        }
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: [.json, .plainText],
            allowsMultipleSelection: false
        ) { result in
            importBackup(result)
        }
#if DEBUG
        .onAppear {
            let environment = ProcessInfo.processInfo.environment
            if environment["TASKIFY_WALLET_RECOVERY_PAGE"] == "restore" {
                page = .restore
            }
        }
#endif
    }

    private var backupView: some View {
        VStack(spacing: 18) {
            Image(systemName: recoveryAcknowledged ? "checkmark.shield.fill" : "key.fill")
                .font(.system(size: 52))
                .foregroundStyle(recoveryAcknowledged ? Color.green : TaskifyTheme.accent)

            VStack(spacing: 6) {
                Text(recoveryAcknowledged ? "Recovery backup saved" : "Protect your ecash")
                    .font(.title2.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text("These 12 words restore the deterministic Cashu wallet. Keep them private—anyone with the words can recover and spend its ecash.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            if let phrase {
                recoveryWords(phrase)

                Button {
                    recoveryAcknowledged = true
                } label: {
                    Label(
                        recoveryAcknowledged ? "Recovery words saved" : "I saved these words",
                        systemImage: recoveryAcknowledged ? "checkmark.circle.fill" : "circle"
                    )
                    .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(recoveryAcknowledged ? Color.green : TaskifyTheme.accent)
            }

            VStack(spacing: 12) {
                Button {
                    phrase == nil ? revealPhrase() : hidePhrase()
                } label: {
                    Label(
                        isAuthenticating ? "Authenticating…" : (phrase == nil ? "Show recovery words" : "Hide recovery words"),
                        systemImage: phrase == nil ? "eye" : "eye.slash"
                    )
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: Capsule(), tint: phrase == nil ? TaskifyTheme.accent.opacity(0.72) : nil)
                }
                .buttonStyle(.plain)
                .disabled(isAuthenticating)

                HStack(spacing: 12) {
                    Button { copyPhrase() } label: {
                        Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .taskifyGlassControl(in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(phrase == nil)

                    Button { exportBackup() } label: {
                        Label("Save file", systemImage: "square.and.arrow.down")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .taskifyGlassControl(in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(isAuthenticating)
                }
            }

            Label(
                "The JSON backup uses the same nut13-wallet-backup envelope as the Taskify PWA and includes the mint list. The phrase remains the source of recovery.",
                systemImage: "arrow.triangle.2.circlepath"
            )
            .font(.caption)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .taskifyGlass(cornerRadius: 18)
        }
    }

    private var restoreView: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let outcome {
                restoreSuccess(outcome)
            } else {
                VStack(spacing: 7) {
                    Image(systemName: "arrow.right.arrow.left.circle.fill")
                        .font(.system(size: 52))
                        .foregroundStyle(TaskifyTheme.accent)
                    Text("Transfer ecash from a seed")
                        .font(.title2.bold())
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text("Paste recovery words or import a PWA/native backup. Your current Taskify recovery words stay unchanged.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                .frame(maxWidth: .infinity)

                TextEditor(text: $recoveryInput)
                    .font(.system(.footnote, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(12)
                    .frame(minHeight: 145)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(TaskifyTheme.border))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .privacySensitive()
                    .onChange(of: recoveryInput) { _, _ in material = nil }

                Button { showingImporter = true } label: {
                    Label("Choose PWA or native backup file", systemImage: "doc.badge.plus")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(TaskifyTheme.accent)
                .frame(maxWidth: .infinity)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Mints to scan")
                        .font(.headline)
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text("One HTTPS mint URL per line. Backup files fill this automatically; add any other mints where this seed was used.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                    TextEditor(text: $mintURLs)
                        .font(.system(.footnote, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .padding(10)
                        .frame(minHeight: 82)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 15).stroke(TaskifyTheme.border))
                        .foregroundStyle(TaskifyTheme.primaryText)
                }
                .padding(16)
                .taskifyGlass(cornerRadius: 20)

                if material != nil {
                    Label(
                        "Valid recovery phrase · \(parsedMintURLs.count) mint\(parsedMintURLs.count == 1 ? "" : "s") ready to scan",
                        systemImage: "checkmark.seal.fill"
                    )
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.green)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    reviewRestore(action: .transfer)
                } label: {
                    Text(material == nil ? "Review transfer" : (wallet.isWorking ? "Transferring…" : "Transfer ecash"))
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.72))
                }
                .buttonStyle(.plain)
                .disabled(wallet.isWorking || recoveryInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Label(
                    "The imported seed is used only for this recovery scan and is never saved as the Taskify wallet seed.",
                    systemImage: "checkmark.shield"
                )
                .font(.caption)
                .foregroundStyle(.green)
                .padding(15)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 18))

                DisclosureGroup(isExpanded: $showingAdvancedReplacement) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Only use this when you intentionally want the imported words to become Taskify's wallet recovery words. The current wallet must be completely empty first.")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                        Button(role: .destructive) {
                            reviewRestore(action: .replace)
                        } label: {
                            Label("Replace Taskify wallet seed", systemImage: "exclamationmark.triangle")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 46)
                        }
                        .buttonStyle(.bordered)
                        .disabled(wallet.isWorking || recoveryInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .padding(.top, 10)
                } label: {
                    Text("Advanced: replace wallet seed")
                        .font(.subheadline.weight(.semibold))
                }
                .tint(.orange)
                .padding(15)
                .taskifyGlass(cornerRadius: 18)
            }
        }
    }

    private func recoveryWords(_ phrase: String) -> some View {
        let words = phrase.split(separator: " ").map(String.init)
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 2), spacing: 10) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                HStack(spacing: 8) {
                    Text("\(index + 1)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                    Text(word)
                        .font(.subheadline.weight(.semibold).monospaced())
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(height: 42)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 13))
            }
        }
        .padding(14)
        .taskifyGlass(cornerRadius: 22)
        .privacySensitive()
        .textSelection(.enabled)
    }

    private func restoreSuccess(_ restoreOutcome: WalletRestoreOutcome) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.green)
                .symbolEffect(.bounce, value: restoreOutcome.recovered)
            Text(successTitle(for: restoreOutcome))
                .font(.title.bold())
                .foregroundStyle(TaskifyTheme.primaryText)
            Text(successAmount(for: restoreOutcome))
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(TaskifyTheme.secondaryText)

            if restoreOutcome.mode == .transfer, restoreOutcome.found > 0 {
                Text("\(wallet.formattedSats(restoreOutcome.found)) found" + (restoreOutcome.fees > 0 ? " · \(wallet.formattedSats(restoreOutcome.fees)) mint fees" : ""))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            VStack(spacing: 10) {
                ForEach(restoreOutcome.mints, id: \.mintURL) { mint in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(URL(string: mint.mintURL)?.host() ?? mint.mintURL)
                                .lineLimit(1)
                            if let errorMessage = mint.errorMessage {
                                Text(errorMessage)
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                                    .lineLimit(2)
                            }
                        }
                        Spacer()
                        if mint.succeeded {
                            Text("\(wallet.formattedSats(mint.deposited))")
                                .bold()
                        } else {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                        }
                    }
                }
            }
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.primaryText)
            .padding(16)
            .taskifyGlass(cornerRadius: 20)

            Button(restoreOutcome.mode == .transfer ? "View Taskify wallet backup" : "Back up this wallet") {
                page = .backup
                phrase = nil
                outcome = nil
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .foregroundStyle(TaskifyTheme.primaryText)
            .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.72))
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 36)
    }

    private func successTitle(for restoreOutcome: WalletRestoreOutcome) -> String {
        switch restoreOutcome.mode {
        case .transfer: "Ecash transferred"
        case .rescan: "Wallet rescanned"
        case .replace: "Wallet seed replaced"
        }
    }

    private func successAmount(for restoreOutcome: WalletRestoreOutcome) -> String {
        switch restoreOutcome.mode {
        case .transfer: "\(wallet.formattedSats(restoreOutcome.recovered)) added to Taskify"
        case .rescan, .replace: "\(wallet.formattedSats(restoreOutcome.recovered)) recovered"
        }
    }

    private var parsedMintURLs: [String] {
        mintURLs
            .components(separatedBy: CharacterSet(charactersIn: ",\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func revealPhrase() {
        isAuthenticating = true
        Task {
            defer { isAuthenticating = false }
            do {
                try await authenticate(reason: "Show your Cashu wallet recovery words")
                phrase = try await wallet.recoveryPhrase()
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
    }

    private func hidePhrase() {
        phrase = nil
        if copied { UIPasteboard.general.items = [] }
        copied = false
    }

    private func copyPhrase() {
        guard let phrase else { return }
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: phrase]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(60),
            ]
        )
        copied = true
    }

    private func exportBackup() {
        isAuthenticating = true
        Task {
            defer { isAuthenticating = false }
            do {
                try await authenticate(reason: "Export your Cashu wallet recovery backup")
                let json = try await wallet.recoveryBackupJSON()
                exportDocument = WalletSeedBackupDocument(json: json)
                showingExporter = true
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
    }

    private func reviewRestore(action: RecoveryAction) {
        do {
            let parsed = try wallet.parseRecoveryMaterial(recoveryInput)
            material = parsed
            if !parsed.mintURLs.isEmpty {
                let combined = Array(Set(parsedMintURLs + parsed.mintURLs)).sorted()
                mintURLs = combined.joined(separator: "\n")
            }
            recoveryAction = action
            confirmingRestore = true
        } catch {
            localError = WalletViewModel.message(for: error)
        }
    }

    private func performRestore() {
        guard let material else { return }
        Task {
            do {
                switch recoveryAction {
                case .transfer:
                    outcome = try await wallet.transferFromSeed(
                        material: material,
                        additionalMintURLs: parsedMintURLs
                    )
                case .replace:
                    outcome = try await wallet.replaceWalletSeed(
                        material: material,
                        additionalMintURLs: parsedMintURLs
                    )
                }
                recoveryInput = ""
                phrase = nil
                if recoveryAction == .replace { recoveryAcknowledged = false }
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
    }

    private func importBackup(_ result: Result<[URL], Error>) {
        do {
            let url = try result.get().first
            guard let url else { return }
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            recoveryInput = try String(contentsOf: url, encoding: .utf8)
            material = nil
        } catch {
            localError = error.localizedDescription
        }
    }

    private func authenticate(reason: String) async throws {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var authenticationError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authenticationError) else {
            if let authenticationError { throw authenticationError }
            throw WalletRecoveryAuthenticationError.unavailable
        }
        guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else {
            throw WalletRecoveryAuthenticationError.failed
        }
    }

    private static var backupFilename: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmm"
        return "taskify-wallet-seed-\(formatter.string(from: Date()))"
    }
}

enum WalletRecoveryAuthenticationError: LocalizedError {
    case unavailable
    case failed

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Set a device passcode before viewing or exporting wallet recovery words."
        case .failed:
            "Device authentication did not complete."
        }
    }
}

struct WalletSeedBackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var json: String

    init(json: String) {
        self.json = json
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let json = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.json = json
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(json.utf8))
    }
}

#endif
