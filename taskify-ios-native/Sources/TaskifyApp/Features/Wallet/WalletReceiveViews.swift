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
struct ReceiveCashuRequestSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var wallet: WalletViewModel

    /// Which currency this sheet's keypad is entering in. Seeded from the saved preference and
    /// flipped by tapping the amount display.
    @State private var entryCurrency: WalletPrimaryCurrency = .sat
    @State private var selectedMintURL = ""
    @State private var amountText = ""
    @State private var memo = ""
    @State private var singleUse = true
    @State private var lockToWallet = false
    @State private var request: CashuCreatedPaymentRequest?
    @State private var localError: String?
    @State private var copied = false
    @FocusState private var memoFocused: Bool

    private var parsedAmount: UInt64? {
        // Always sats, whatever currency the keypad is in -- dollar entry converts here.
        wallet.sats(fromEntry: amountText, currency: entryCurrency)
    }

    private var amountIsValid: Bool {
        amountText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (parsedAmount ?? 0) > 0
    }

    private var selectedMint: CashuMintSummary? {
        wallet.snapshot.mints.first { $0.url == selectedMintURL }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                GeometryReader { proxy in
                    ScrollView {
                        Group {
                            if let request {
                                requestView(request)
                            } else {
                                createView
                            }
                        }
                        .padding(22)
                        .padding(.bottom, 28)
                        .frame(minHeight: proxy.size.height, alignment: .center)
                    }
                }
            }
            .navigationTitle("Receive Cashu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { memoFocused = false }
                }
            }
            .alert("Cashu request", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            entryCurrency = wallet.amountEntryCurrency
            if selectedMintURL.isEmpty {
                selectedMintURL = wallet.activeMint?.url ?? wallet.snapshot.mints.first?.url ?? ""
            }
            // Deliberately does not restore a previously created request. Reopening the builder
            // means "make me a request", not "here's the one you made earlier" -- same reasoning as
            // Receive Lightning's address page. Existing requests stay reachable from History.
        }
        .onChange(of: wallet.createdPaymentRequests) { _, requests in
            guard let request else { return }
            self.request = requests.first { $0.requestID == request.requestID } ?? request
        }
    }

    private var createView: some View {
        VStack(spacing: 20) {
            WalletMintSelectorCard(label: "RECEIVE TO", mints: wallet.snapshot.mints, selectedMintURL: $selectedMintURL)

            WalletAmountDisplayCard(
                primary: wallet.entryPrimaryText(amountText, currency: entryCurrency),
                caption: "Leave at 0 to request any amount",
                secondary: wallet.entrySecondaryText(amountText, currency: entryCurrency),
                onToggleCurrency: wallet.currencyToggleAction(using: model) {
                    amountText = ""
                    entryCurrency = wallet.amountEntryCurrency
                }
            )

            Picker("Request type", selection: $singleUse) {
                Text("Single-use").tag(true)
                Text("Multi-use").tag(false)
            }
            .pickerStyle(.segmented)

            VStack(alignment: .leading, spacing: 10) {
                Toggle("Lock payments to this wallet", isOn: $lockToWallet)
                    .disabled(wallet.primaryP2PKKey == nil)
                if let key = wallet.primaryP2PKKey {
                    Text("Only Taskify clients holding your device-only recipient key can redeem payments to this request. Key …\(key.publicKey.suffix(10)).")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                } else {
                    Button("Generate recipient key") {
                        Task {
                            do {
                                _ = try await wallet.generateP2PKKey(label: "Taskify iPhone")
                                lockToWallet = true
                            } catch {
                                localError = WalletViewModel.message(for: error)
                            }
                        }
                    }
                    .font(.subheadline.weight(.semibold))
                    Text("A separate recipient key is stored in the device Keychain; your Nostr identity and wallet seed are not exposed.")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }
            .padding(15)
            .taskifyGlass(cornerRadius: 18)

            WalletAmountKeypad(amountText: $amountText, allowsDecimal: entryCurrency == .usd)

            TextField("What is this payment for? (optional)", text: $memo, axis: .vertical)
                .lineLimit(2...4)
                .foregroundStyle(TaskifyTheme.primaryText)
                .focused($memoFocused)
                .padding(.horizontal, 15)
                .padding(.vertical, 12)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TaskifyTheme.border))
                .onChange(of: memo) { _, value in
                    if value.count > 280 { memo = String(value.prefix(280)) }
                }

            Button(action: createRequest) {
                Text(wallet.isWorking ? "Creating request…" : "Create request")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.72))
            }
            .buttonStyle(.plain)
            .disabled(
                wallet.isWorking
                    || selectedMintURL.isEmpty
                    || model.identityPublicKey.isEmpty
                    || model.walletPaymentRequestRelayURLs.isEmpty
                    || !amountIsValid
            )

            Label(
                singleUse
                    ? "The request closes after its first successful payment."
                    : "A reusable request stays active and can receive multiple payments.",
                systemImage: singleUse ? "1.circle" : "arrow.trianglehead.2.clockwise"
            )
            .font(.caption)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(15)
            .taskifyGlass(cornerRadius: 18)
        }
    }

    private func requestView(_ request: CashuCreatedPaymentRequest) -> some View {
        VStack(spacing: 18) {
            if request.state == .completed {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 62))
                    .foregroundStyle(.green)
                    .symbolEffect(.bounce, value: request.receivedCount)
                Text("Payment received")
                    .font(.title2.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text("\(wallet.formattedSats(request.receivedAmount)) were added to your wallet.")
                    .foregroundStyle(TaskifyTheme.secondaryText)
            } else if request.state == .cancelled {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 58))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Text("Request closed")
                    .font(.title2.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
            } else {
                Text(request.amount.map { "\(wallet.formattedSats($0))" } ?? "Any amount")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(TaskifyTheme.primaryText)

                Label(
                    request.receivedCount == 0
                        ? "Waiting for payment"
                        : "Received \(wallet.formattedSats(request.receivedAmount))",
                    systemImage: request.receivedCount == 0 ? "antenna.radiowaves.left.and.right" : "checkmark.circle.fill"
                )
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(request.receivedCount == 0 ? TaskifyTheme.accent : .green)

                CashuQRCodeView(
                    value: request.encoded,
                    accessibilityLabel: "Cashu payment request QR code"
                )
                .frame(maxWidth: 300)
                .padding(16)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 24, style: .continuous))

                HStack(spacing: 12) {
                    Button {
                        UIPasteboard.general.string = request.encoded
                        copied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                    } label: {
                        Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .taskifyGlassControl(in: Capsule())
                    }
                    .buttonStyle(.plain)

                    ShareLink(item: request.encoded) {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .taskifyGlassControl(in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                .foregroundStyle(TaskifyTheme.primaryText)
            }

            VStack(alignment: .leading, spacing: 10) {
                if let description = request.description {
                    Label(description, systemImage: "text.alignleft")
                }
                Label(
                    request.singleUse ? "Single payment" : "Reusable request",
                    systemImage: request.singleUse ? "1.circle" : "arrow.trianglehead.2.clockwise"
                )
                if request.lockPublicKey != nil {
                    Label("Locked to this wallet", systemImage: "lock.shield.fill")
                }
                Label(
                    URL(string: request.mintURLs.first ?? "")?.host() ?? request.mintURLs.first ?? "Cashu mint",
                    systemImage: "building.columns"
                )
                Label("Delivered privately over Nostr", systemImage: "lock.fill")
            }
            .font(.caption)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .taskifyGlass(cornerRadius: 18)

            Button {
                self.request = nil
                amountText = ""
                memo = ""
            } label: {
                Label("Create another request", systemImage: "plus")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.55))
            }
            .buttonStyle(.plain)
            .foregroundStyle(TaskifyTheme.primaryText)

            if request.isActive {
                Button("Close this request", role: .destructive) {
                    Task {
                        do { try await wallet.cancelPaymentRequest(request) }
                        catch { localError = WalletViewModel.message(for: error) }
                    }
                }
                .disabled(wallet.isWorking)
            }
        }
    }

    private func createRequest() {
        memoFocused = false
        Task {
            do {
                request = try await wallet.createPaymentRequest(
                    amount: parsedAmount,
                    description: memo,
                    mintURLs: [selectedMintURL],
                    recipientPublicKey: model.identityPublicKey,
                    relayURLs: model.walletPaymentRequestRelayURLs,
                    singleUse: singleUse,
                    lockPublicKey: lockToWallet ? wallet.primaryP2PKKey?.publicKey : nil
                )
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
    }
}

struct ReceiveLightningSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    /// Flips to the eCash version of this action, matching the PWA sheet header's mode button.
    var onSwitchMode: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    /// Which currency this sheet's keypad is entering in. Seeded from the saved preference and
    /// flipped by tapping the amount display.
    @State private var entryCurrency: WalletPrimaryCurrency = .sat
    /// Opens on the user's Lightning address rather than an amount keypad: most people receiving
    /// just want something scannable, and asking for a specific amount is the rarer case. Matches
    /// the PWA's `lightningReceiveView` starting at "address".
    @State private var step: Step = .address
    @State private var addressCopied = false
    @State private var amountText = ""
    @State private var selectedMintURL = ""
    @State private var quote: CashuLightningReceiveQuote?
    @State private var receivedAmount: UInt64?
    @State private var isChecking = false
    @State private var copied = false
    @State private var localError: String?

    private enum Step {
        case address
        case amount
    }

    init(
        wallet: WalletViewModel,
        initialQuote: CashuLightningReceiveQuote? = nil,
        onSwitchMode: (() -> Void)? = nil
    ) {
        self.wallet = wallet
        self.onSwitchMode = onSwitchMode
        _selectedMintURL = State(initialValue: initialQuote?.mintURL ?? "")
        _quote = State(initialValue: initialQuote)
    }

    private var amount: UInt64? {
        // Always sats, whatever currency the keypad is in -- dollar entry converts here.
        wallet.sats(fromEntry: amountText, currency: entryCurrency)
    }

    private var outstandingInvoiceCount: Int {
        wallet.activeLightningReceiveQuotes.count
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                GeometryReader { proxy in
                    ScrollView {
                        VStack(spacing: 20) {
                            if let receivedAmount {
                                successView(amount: receivedAmount)
                            } else if let quote {
                                invoiceView(quote)
                            } else if step == .amount {
                                amountView
                            } else {
                                addressView
                            }
                        }
                        .padding(22)
                        .padding(.bottom, 26)
                        .frame(minHeight: proxy.size.height, alignment: .center)
                    }
                }
            }
            .navigationTitle("Receive Lightning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if step == .amount && quote == nil && receivedAmount == nil {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { step = .address }
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                    } else if let onSwitchMode {
                        Button("ecash", action: onSwitchMode)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Lightning receive", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        // Deliberately does not restore the mint's most recent outstanding quote on open. Reopening
        // Receive means "show me something to be paid at", not "here's the invoice you already
        // made" -- an invoice the user has moved on from would otherwise sit in front of the
        // address page every time. Outstanding invoices remain reachable from History, which is
        // where `initialQuote` comes from.
        .onChange(of: wallet.lightningReceiveQuotes) { _, trackedQuotes in
            guard let quote,
                  let updated = trackedQuotes.first(where: { $0.id == quote.id }) else { return }
            applyQuoteUpdate(updated)
        }
        .onAppear {
            entryCurrency = wallet.amountEntryCurrency
            if selectedMintURL.isEmpty {
                selectedMintURL = wallet.activeMint?.url ?? wallet.snapshot.mints.first?.url ?? ""
            }
        }
    }

    /// The landing page: a big scannable Lightning address, and one button for the less common
    /// case of wanting a specific amount.
    private var addressView: some View {
        VStack(spacing: 20) {
            if let address = wallet.preferredLightningAddress {
                VStack(spacing: 14) {
                    walletFieldLabel("LIGHTNING ADDRESS")

                    CashuQRCodeView(value: address, accessibilityLabel: "Lightning address QR code")

                    Button {
                        UIPasteboard.general.string = address
                        addressCopied = true
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task {
                            try? await Task.sleep(nanoseconds: 1_600_000_000)
                            addressCopied = false
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(address)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .lineLimit(2)
                                .multilineTextAlignment(.center)
                                .minimumScaleFactor(0.7)
                            Image(systemName: addressCopied ? "checkmark" : "doc.on.doc")
                                .font(.caption)
                                .foregroundStyle(addressCopied ? .green : TaskifyTheme.secondaryText)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy lightning address \(address)")
                }
                .padding(18)
                .frame(maxWidth: .infinity)
                .taskifyGlass(cornerRadius: 24)
            } else if LightningAddressSettings.provider == .none {
                VStack(spacing: 8) {
                    Text("Lightning address disabled")
                        .font(.headline)
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text("Use Amount to create an invoice, or turn an address back on in Wallet \u{2192} Address.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .taskifyGlass(cornerRadius: 24)
            } else {
                VStack(spacing: 8) {
                    Text("No Lightning address yet")
                        .font(.headline)
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text("Set up your Taskify Nostr identity in Settings to get an address anyone can pay.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .taskifyGlass(cornerRadius: 24)
            }

            WalletPrimaryActionButton(title: "Create Invoice") {
                withAnimation(.easeInOut(duration: 0.2)) { step = .amount }
            }
            .disabled(wallet.snapshot.mints.isEmpty)
            .opacity(wallet.snapshot.mints.isEmpty ? 0.45 : 1)
        }
    }

    private var amountView: some View {
        VStack(spacing: 20) {
            WalletMintSelectorCard(label: "RECEIVE TO", mints: wallet.snapshot.mints, selectedMintURL: $selectedMintURL)
            WalletAmountDisplayCard(
                primary: wallet.entryPrimaryText(amountText, currency: entryCurrency),
                caption: "Enter amount to receive",
                secondary: wallet.entrySecondaryText(amountText, currency: entryCurrency),
                onToggleCurrency: wallet.currencyToggleAction(using: model) {
                    amountText = ""
                    entryCurrency = wallet.amountEntryCurrency
                }
            )
            WalletAmountKeypad(amountText: $amountText, allowsDecimal: entryCurrency == .usd)

            Button {
                createInvoice()
            } label: {
                Text(wallet.isWorking ? "Creating invoice…" : "Create invoice")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.72))
            }
            .buttonStyle(.plain)
            .disabled(wallet.isWorking || amount == nil || amount == 0 || selectedMintURL.isEmpty)

            if outstandingInvoiceCount > 0 {
                Label(
                    "Taskify is monitoring \(outstandingInvoiceCount) other outstanding \(outstandingInvoiceCount == 1 ? "invoice" : "invoices").",
                    systemImage: "bolt.horizontal.circle"
                )
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func invoiceView(_ quote: CashuLightningReceiveQuote) -> some View {
        VStack(spacing: 18) {
            VStack(spacing: 4) {
                Text("\(wallet.formattedSats(quote.amount))")
                    .font(.largeTitle.bold().monospacedDigit())
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text(URL(string: quote.mintURL)?.host() ?? quote.mintURL)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            CashuQRCodeView(value: quote.invoice, accessibilityLabel: "Lightning invoice QR code")
                .padding(16)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                .frame(maxWidth: 310)

            VStack(spacing: 10) {
                Label(statusText(for: quote), systemImage: statusIcon(for: quote))
                    .font(.headline)
                    .foregroundStyle(statusColor(for: quote))
                if quote.state == .unpaid || quote.state == .pending {
                    ProgressView()
                        .tint(TaskifyTheme.accent)
                }
                if let expiresAt = quote.expiresAt, quote.state != .issued {
                    if quote.state == .expired {
                        Text("Invoice expired")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    } else {
                        Text("Expires \(expiresAt, style: .relative)")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    }
                }
            }

            Label(
                "You can leave this screen or close Taskify. Every outstanding invoice will be checked while the app is active and again when it reopens.",
                systemImage: "checkmark.shield"
            )
            .font(.caption)
            .multilineTextAlignment(.leading)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 12) {
                Button {
                    UIPasteboard.general.setItems(
                        [[UTType.plainText.identifier: quote.invoice]],
                        options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)]
                    )
                    copied = true
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)

                ShareLink(item: quote.invoice) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
            }

            Button {
                Task { await checkPayment(showError: true) }
            } label: {
                Text(isChecking ? "Checking payment…" : "Check payment")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.60))
            }
            .buttonStyle(.plain)
            .disabled(isChecking || quote.state == .expired)

            Button("Create a new invoice") {
                self.quote = nil
                amountText = ""
                copied = false
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(TaskifyTheme.accent)
        }
    }

    private func successView(amount: UInt64) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 74))
                .foregroundStyle(.green)
                .symbolEffect(.bounce, value: amount)
            Text("Lightning received")
                .font(.title.bold())
                .foregroundStyle(TaskifyTheme.primaryText)
            Text("\(wallet.formattedSats(amount))")
                .font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(TaskifyTheme.secondaryText)
            Text("The mint issued fresh ecash into your Taskify wallet.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.secondaryText)
            Button("Done") { dismiss() }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .foregroundStyle(TaskifyTheme.primaryText)
                .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.72))
                .buttonStyle(.plain)
        }
        .padding(.top, 42)
    }

    private func createInvoice() {
        guard let amount, amount > 0 else { return }
        Task {
            do {
                quote = try await wallet.createLightningReceiveQuote(
                    mintURL: selectedMintURL,
                    amount: amount
                )
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
    }

    @MainActor
    private func checkPayment(showError: Bool) async {
        guard let quote, !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        do {
            let updated = try await wallet.checkLightningReceiveQuote(id: quote.id)
            applyQuoteUpdate(updated)
        } catch {
            if showError { localError = WalletViewModel.message(for: error) }
        }
    }

    private func applyQuoteUpdate(_ updated: CashuLightningReceiveQuote) {
        quote = updated
        guard updated.state == .issued, receivedAmount == nil else { return }
        let amount = updated.issuedAmount > 0 ? updated.issuedAmount : updated.amount
        withAnimation(.spring(response: 0.45, dampingFraction: 0.72)) {
            receivedAmount = amount
        }
    }

    private func statusText(for quote: CashuLightningReceiveQuote) -> String {
        switch quote.state {
        case .unpaid: "Waiting for payment"
        case .paid: "Payment found"
        case .pending: "Payment pending"
        case .issued: "Ecash issued"
        case .expired: "Invoice expired"
        }
    }

    private func statusIcon(for quote: CashuLightningReceiveQuote) -> String {
        switch quote.state {
        case .unpaid, .pending: "bolt.fill"
        case .paid, .issued: "checkmark.circle.fill"
        case .expired: "clock.badge.exclamationmark"
        }
    }

    private func statusColor(for quote: CashuLightningReceiveQuote) -> Color {
        switch quote.state {
        case .unpaid, .pending: TaskifyTheme.accent
        case .paid, .issued: .green
        case .expired: .orange
        }
    }
}

/// The wallet's dedicated Lightning-address management screen -- choosing solife.me / npub.cash /
/// none as the address shown on Receive, npub.cash auto-claim, and (when solife.me is selected)
/// which of the account's addresses to show plus its payment mint. Mirrors the PWA's
/// `WalletAddressView`, reachable from the wallet toolbar rather than nested inside Receive.
struct WalletAddressManagerView: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var provider = LightningAddressSettings.provider
    @State private var autoClaimEnabled = LightningAddressSettings.autoClaimEnabled
    @State private var selectedSolifeAddress = LightningAddressSettings.selectedSolifeAddress
    @State private var copied = false
    @State private var showingPurchase = false
    @State private var mintUpdateError: String?

    private var mintChoices: [String] {
        var urls = wallet.snapshot.mints.map(\.url)
        if let configured = wallet.solifeConfig?.mintUrl, !urls.contains(configured) {
            urls.append(configured)
        }
        return urls
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    providerPicker

                    switch provider {
                    case .solife: solifeSection
                    case .npubCash: npubCashSection
                    case .none: disabledSection
                    }
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Lightning Address")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .onAppear {
            wallet.refreshLightningAddresses()
            if provider == .solife, wallet.solifeAccount == nil {
                Task { await wallet.refreshSolifeAccount() }
            }
        }
        .sheet(isPresented: $showingPurchase) {
            SolifeCustomAddressPurchaseSheet(wallet: wallet) { claimed in
                selectAddress(claimed)
            }
        }
    }

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Address Type")
                .font(.caption.weight(.bold))
                .foregroundStyle(TaskifyTheme.secondaryText)
            Text("Choose the address shown when receiving Lightning.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
            Picker("Address Type", selection: $provider) {
                ForEach(LightningAddressProvider.allCases) { option in
                    Text(option.displayName).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: provider) { _, next in
                LightningAddressSettings.setProvider(next)
                if next != .npubCash { autoClaimEnabled = false }
                wallet.refreshLightningAddresses()
                if next == .solife, wallet.solifeAccount == nil {
                    Task { await wallet.refreshSolifeAccount() }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 18)
    }

    private var disabledSection: some View {
        Text("Lightning address disabled. Use Amount to create an invoice.")
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(20)
            .taskifyGlass(cornerRadius: 18)
    }

    // MARK: - npub.cash

    private var npubCashSection: some View {
        Group {
            if let identity = wallet.npubCashIdentity {
                VStack(spacing: 12) {
                    Button {
                        UIPasteboard.general.string = identity.address
                        withAnimation(.snappy) { copied = true }
                    } label: {
                        VStack(spacing: 8) {
                            Text(identity.address)
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .multilineTextAlignment(.center)
                            Label(copied ? "Copied" : "Tap to copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(copied ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                        }
                    }
                    .buttonStyle(.plain)

                    if wallet.automaticallyRedeemsIncomingPayments {
                        Toggle("Auto-claim on open", isOn: $autoClaimEnabled)
                            .onChange(of: autoClaimEnabled) { _, enabled in
                                LightningAddressSettings.setAutoClaimEnabled(enabled)
                            }
                        Text("Automatically check for and redeem pending eCash each time the wallet opens.")
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Button {
                        Task { await wallet.claimNpubCash(auto: false) }
                    } label: {
                        if wallet.npubCashClaimStatus == .checking {
                            ProgressView().frame(maxWidth: .infinity).frame(height: 46)
                        } else {
                            Text("Check for pending eCash")
                                .frame(maxWidth: .infinity)
                                .frame(height: 46)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(wallet.npubCashClaimStatus == .checking)

                    if let message = wallet.npubCashClaimMessage {
                        Label(message, systemImage: statusIcon)
                            .font(.caption)
                            .foregroundStyle(statusColor)
                    }
                }
                .padding(16)
                .taskifyGlass(cornerRadius: 18)
            } else if let identityError = wallet.npubCashIdentityError {
                Label(identityError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(16)
                    .taskifyGlass(cornerRadius: 18)
            }
        }
    }

    private var statusIcon: String {
        switch wallet.npubCashClaimStatus {
        case .success: "checkmark.circle.fill"
        case .error: "exclamationmark.triangle.fill"
        case .checking, .idle: "info.circle"
        }
    }

    private var statusColor: Color {
        switch wallet.npubCashClaimStatus {
        case .success: .green
        case .error: .orange
        case .checking, .idle: TaskifyTheme.secondaryText
        }
    }

    // MARK: - solife.me

    private var solifeSection: some View {
        Group {
            if wallet.solifeAccountStatus == .loading, wallet.solifeAccount == nil {
                ProgressView("Loading your solife.me account…")
                    .padding(.top, 40)
            } else if let account = wallet.solifeAccount {
                let defaultIsSelected = selectedSolifeAddress == nil
                    || !account.addresses.contains { $0.address.lowercased() == selectedSolifeAddress }

                addressCard(
                    title: "Default address",
                    address: account.lightningAddress,
                    mintURL: account.lightningAddressMintUrl,
                    isSelected: defaultIsSelected,
                    onSelect: { selectAddress(nil) },
                    onSelectMint: { mintURL in
                        await updateMint { try await wallet.updateSolifeDefaultMint(mintURL) }
                    }
                )

                if !account.addresses.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Custom addresses")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        ForEach(account.addresses, id: \.handle) { customAddress in
                            VStack(spacing: 0) {
                                addressCard(
                                    title: customAddress.handle,
                                    address: customAddress.address,
                                    mintURL: customAddress.mintUrl,
                                    isSelected: isShownOnReceive(customAddress.address),
                                    showsMint: customAddress.nwcForward == nil,
                                    onSelect: { selectAddress(customAddress.address) },
                                    onSelectMint: { mintURL in
                                        await updateMint {
                                            try await wallet.updateSolifeCustomAddressMint(
                                                handle: customAddress.handle,
                                                mintURL: mintURL
                                            )
                                        }
                                    }
                                )
                                SolifeNWCForwardControl(wallet: wallet, address: customAddress)
                            }
                        }
                    }
                }

                Button {
                    showingPurchase = true
                } label: {
                    if let price = wallet.solifeConfig?.customAddressPriceSats {
                        Text(price > 0 ? "New Custom Address (\(wallet.formattedSats(price)))" : "New Custom Address")
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                    } else {
                        Text("New Custom Address")
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                    }
                }
                .buttonStyle(.borderedProminent)

                if let mintUpdateError {
                    Label(mintUpdateError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            } else if let message = wallet.solifeAccountMessage {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.top, 40)
            }
        }
    }

    private func addressCard(
        title: String,
        address: String,
        mintURL: String,
        isSelected: Bool,
        showsMint: Bool = true,
        onSelect: @escaping () -> Void,
        onSelectMint: @escaping (String?) async -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Spacer()
                if isSelected {
                    Label("Shown on Receive", systemImage: "checkmark.circle.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.accent)
                } else {
                    Button("Show on Receive", action: onSelect)
                        .font(.caption2.weight(.semibold))
                }
            }
            Text(address)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(TaskifyTheme.primaryText)
                .lineLimit(1)
                .truncationMode(.middle)

            if showsMint {
            Menu {
                Button("Server default") {
                    Task { await onSelectMint(nil) }
                }
                ForEach(mintChoices, id: \.self) { url in
                    Button(url) {
                        Task { await onSelectMint(url) }
                    }
                }
            } label: {
                Label(mintURL, systemImage: "building.columns")
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 18)
    }

    private func isShownOnReceive(_ address: String) -> Bool {
        if wallet.isNWCWalletActive {
            return wallet.nwcReceiveAddressOverride == address.lowercased()
        }
        return selectedSolifeAddress == address.lowercased()
    }

    private func selectAddress(_ address: String?) {
        if wallet.isNWCWalletActive, let address {
            // NWC mode: shown on Receive in place of the wallet's own address. The Nostr
            // profile's lightning address is never changed here.
            Task { try? await wallet.setNWCReceiveAddress(address) }
            return
        }
        selectedSolifeAddress = address?.lowercased()
        LightningAddressSettings.setSelectedSolifeAddress(address)
        wallet.refreshLightningAddresses()
    }

    private func updateMint(_ action: () async throws -> Void) async {
        mintUpdateError = nil
        do {
            try await action()
        } catch {
            mintUpdateError = WalletViewModel.message(for: error)
        }
    }
}

/// Handle availability check, purchase, invoice payment (when the handle isn't free), and
/// settlement verification — the same sequence as the PWA's `handlePurchaseCustomAddress`.
struct SolifeCustomAddressPurchaseSheet: View {
    @ObservedObject var wallet: WalletViewModel
    var onClaimed: (String) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var handle = ""
    @State private var availability: SolifeAddressAvailability?
    @State private var isChecking = false
    @State private var isPurchasing = false
    @State private var pendingPurchase: SolifeAddressPurchase?
    @State private var lightningQuote: CashuLightningPaymentQuote?
    @State private var payWithNWC = false
    @State private var claimedAddress: String?
    @State private var errorMessage: String?
    @FocusState private var handleFocused: Bool

    private var normalizedHandle: String { handle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    private var handleIsValid: Bool {
        normalizedHandle.range(of: "^[a-z0-9][a-z0-9_-]{1,31}$", options: .regularExpression) != nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if let claimedAddress {
                        VStack(spacing: 10) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 48))
                                .foregroundStyle(.green)
                            Text("Claimed \(claimedAddress)")
                                .font(.title3.bold())
                                .foregroundStyle(TaskifyTheme.primaryText)
                        }
                        .padding(.top, 30)
                    } else {
                        VStack(spacing: 6) {
                            Text("New Custom Address")
                                .font(.title3.bold())
                                .foregroundStyle(TaskifyTheme.primaryText)
                            if let price = wallet.solifeConfig?.customAddressPriceSats {
                                Text(price > 0 ? "\(wallet.formattedSats(price)) one-time fee." : "Custom address claims are currently free.")
                                    .font(.subheadline)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                            }
                        }

                        HStack(spacing: 6) {
                            TextField("handle", text: $handle)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($handleFocused)
                                .onChange(of: handle) { _, newValue in
                                    handle = newValue.lowercased()
                                    availability = nil
                                }
                            Text("@solife.me")
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 46)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(TaskifyTheme.border))

                        if let pendingPurchase {
                            if let lightningQuote {
                                payInvoiceView(pendingPurchase, quote: lightningQuote)
                            } else if payWithNWC {
                                payWithNWCView(pendingPurchase)
                            } else {
                                Text("Paying \(wallet.formattedSats(pendingPurchase.priceSats)) to claim \(pendingPurchase.address)…")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                ProgressView()
                            }
                        } else {
                            if let availability {
                                Label(
                                    availability.available ? "Available" : (availability.reason ?? "Not available"),
                                    systemImage: availability.available ? "checkmark.circle" : "xmark.circle"
                                )
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(availability.available ? Color.green : Color.orange)
                            }

                            Button {
                                Task { await checkAvailabilityThenPurchase() }
                            } label: {
                                if isChecking || isPurchasing {
                                    ProgressView().frame(maxWidth: .infinity).frame(height: 46)
                                } else {
                                    Text("Purchase Address")
                                        .frame(maxWidth: .infinity)
                                        .frame(height: 46)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!handleIsValid || isChecking || isPurchasing)
                        }

                        if let errorMessage {
                            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }
                }
                .padding(22)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(claimedAddress == nil ? "Cancel" : "Done") { dismiss() }
                        .disabled(isChecking || isPurchasing)
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .interactiveDismissDisabled(isChecking || isPurchasing)
        .task {
            handleFocused = true
            if wallet.solifeConfig == nil {
                await wallet.refreshSolifeAccount()
            }
        }
    }

    private func payInvoiceView(_ purchase: SolifeAddressPurchase, quote: CashuLightningPaymentQuote) -> some View {
        VStack(spacing: 14) {
            VStack(spacing: 6) {
                Text("\(wallet.formattedSats(quote.amount))").font(.title2.bold())
                let fee = quote.feeReserve + quote.walletFee
                if fee > 0 {
                    Text("+ \(wallet.formattedSats(fee)) fee").font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            Button {
                Task { await payAndVerify(purchase, quote: quote) }
            } label: {
                if isPurchasing {
                    ProgressView().frame(maxWidth: .infinity).frame(height: 46)
                } else {
                    Text("Pay & Claim").frame(maxWidth: .infinity).frame(height: 46)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isPurchasing)
        }
    }

    private func checkAvailabilityThenPurchase() async {
        guard handleIsValid else { return }
        isChecking = true
        errorMessage = nil
        do {
            let result = try await wallet.checkSolifeAddressAvailability(handle: normalizedHandle)
            availability = result
            guard result.available else {
                isChecking = false
                return
            }
            isChecking = false
            await purchase()
        } catch {
            isChecking = false
            errorMessage = WalletViewModel.message(for: error)
        }
    }

    private func purchase() async {
        isPurchasing = true
        errorMessage = nil
        do {
            switch try await wallet.purchaseSolifeCustomAddress(handle: normalizedHandle) {
            case .address(let address):
                claimedAddress = address.address
                onClaimed(address.address)
            case .purchase(let purchase):
                pendingPurchase = purchase
                if wallet.isNWCWalletActive {
                    // The fee comes from the NWC wallet, not the hidden ecash wallet.
                    payWithNWC = true
                    break
                }
                guard let mintURL = wallet.activeMint?.url else {
                    throw CashuWalletError.lightningPaymentMissing
                }
                lightningQuote = try await wallet.prepareLightningPayment(
                    mintURL: mintURL,
                    invoice: purchase.bolt11,
                    amount: nil
                )
            }
        } catch {
            errorMessage = WalletViewModel.message(for: error)
        }
        isPurchasing = false
    }

    private func payAndVerify(_ purchase: SolifeAddressPurchase, quote: CashuLightningPaymentQuote) async {
        isPurchasing = true
        errorMessage = nil
        do {
            _ = try await wallet.confirmLightningPayment(quote)
            lightningQuote = nil
            try await verifyClaim(purchase)
        } catch {
            errorMessage = WalletViewModel.message(for: error)
        }
        isPurchasing = false
    }

    private func payWithNWCAndVerify(_ purchase: SolifeAddressPurchase) async {
        isPurchasing = true
        errorMessage = nil
        do {
            do {
                _ = try await wallet.payWithNWC(invoice: purchase.bolt11)
            } catch NWCError.paymentUnconfirmed {
                // May still settle; solife.me's own verification below decides.
            }
            payWithNWC = false
            try await verifyClaim(purchase)
        } catch {
            errorMessage = WalletViewModel.message(for: error)
        }
        isPurchasing = false
    }

    private func payWithNWCView(_ purchase: SolifeAddressPurchase) -> some View {
        VStack(spacing: 14) {
            Text("\(wallet.formattedSats(purchase.priceSats))").font(.title2.bold())
            Text("Paid from \(wallet.nwcWalletLabel)").font(.caption).foregroundStyle(TaskifyTheme.secondaryText)
            Button {
                Task { await payWithNWCAndVerify(purchase) }
            } label: {
                if isPurchasing {
                    ProgressView().frame(maxWidth: .infinity).frame(height: 46)
                } else {
                    Text("Pay & Claim").frame(maxWidth: .infinity).frame(height: 46)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isPurchasing)
        }
    }

    private func verifyClaim(_ purchase: SolifeAddressPurchase) async throws {
        do {
            var latest = purchase
            for _ in 0..<5 where !latest.isSettled {
                try? await Task.sleep(for: .milliseconds(1_500))
                latest = try await wallet.verifySolifePurchase(purchaseID: purchase.purchaseID)
            }
            if latest.status == "address_claimed" {
                claimedAddress = latest.address
                pendingPurchase = nil
                onClaimed(latest.address)
            } else if latest.status == "expired" {
                errorMessage = "The invoice expired for \(latest.address)."
                pendingPurchase = nil
            } else if let error = latest.error, !error.isEmpty {
                errorMessage = error
                pendingPurchase = nil
            } else {
                errorMessage = "Payment sent, but solife.me hasn't confirmed \(latest.address) yet. Check back shortly."
            }
        } catch {
            errorMessage = WalletViewModel.message(for: error)
        }
        isPurchasing = false
    }
}

struct ReceiveCashuSheet: View {
    @ObservedObject var wallet: WalletViewModel
    /// Flips to the Lightning version of this action, matching the PWA sheet header's mode button.
    var onSwitchMode: (() -> Void)?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// A standing multi-use, open-amount request so the page has something scannable the moment it
    /// opens -- the ecash counterpart to leading Receive Lightning with the user's address.
    @State private var openRequest: CashuCreatedPaymentRequest?
    @State private var requestCopied = false
    @State private var showingRequestBuilder = false
    @State private var token = ""
    @State private var redeemable: RedeemableCashuToken?
    @State private var isInspecting = false
    @State private var localError: String?

    /// `initialToken` is how Chat hands over a token tapped in a DM -- the receiving end of
    /// sending ecash to a contact. The wallet's own scanner opens the redeem page directly and
    /// doesn't come through here.
    init(wallet: WalletViewModel, initialToken: String = "", onSwitchMode: (() -> Void)? = nil) {
        self.wallet = wallet
        self.onSwitchMode = onSwitchMode
        _token = State(initialValue: initialToken)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 18) {
                        openRequestCard

                        WalletPrimaryActionButton(title: "Create request") {
                            showingRequestBuilder = true
                        }
                        .disabled(wallet.activeMint == nil || model.identityPublicKey.isEmpty)
                        .opacity(wallet.activeMint == nil || model.identityPublicKey.isEmpty ? 0.45 : 1)

                        WalletPrimaryActionButton(
                            title: "Paste from clipboard",
                            busyTitle: "Checking token…",
                            isBusy: isInspecting,
                            systemImage: "doc.on.clipboard"
                        ) {
                            Task { await pasteToken() }
                        }
                        .disabled(isInspecting)
                    }
                    .padding(22)
                }
            }
            .navigationTitle("Receive eCash")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showingRequestBuilder) {
                ReceiveCashuRequestSheet(wallet: wallet)
            }
            .sheet(item: $redeemable) { item in
                RedeemCashuTokenSheet(wallet: wallet, redeemable: item) {
                    // Close the redeem page first, then this sheet a beat later. Tearing both down
                    // in the same frame leaves SwiftUI animating two dismissals at once.
                    redeemable = nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { dismiss() }
                }
            }
            .task {
                await inspectInitialToken()
                await inspectClipboard()
                await ensureOpenRequest()
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let onSwitchMode {
                        Button("Lightning", action: onSwitchMode)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Receive ecash", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            guard token.isEmpty, let pasted = UIPasteboard.general.string else { return }
            let trimmed = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("cashuA") || trimmed.hasPrefix("cashuB") { token = trimmed }
        }
    }

    /// A token handed over by Chat. Unlike the clipboard this was an explicit act, so a failure
    /// here is worth reporting rather than swallowing.
    private func inspectInitialToken() async {
        let candidate = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return }
        await inspect(candidate, reportFailures: true)
    }

    /// Explicit paste: the user asked, so tell them when it doesn't work -- including when the
    /// mint says the token has already been spent.
    private func pasteToken() async {
        guard let candidate = UIPasteboard.general.string?
            .trimmingCharacters(in: .whitespacesAndNewlines), !candidate.isEmpty else {
            localError = "There's nothing on the clipboard to paste."
            return
        }
        await inspect(candidate, reportFailures: true)
    }

    /// Opportunistic read on open. Anything that isn't a live token is ignored in silence -- the
    /// clipboard usually has nothing to do with this screen, so complaining about it would be
    /// noise rather than help.
    private func inspectClipboard() async {
        guard let candidate = UIPasteboard.general.string?
            .trimmingCharacters(in: .whitespacesAndNewlines), !candidate.isEmpty else { return }
        await inspect(candidate, reportFailures: false)
    }

    /// Verifies a candidate with the mint and, only if it is a real unspent token, opens the
    /// redeem page. The unspent check is what stops an already-claimed token -- which still
    /// decodes perfectly well -- from being offered for redemption a second time.
    private func inspect(_ candidate: String, reportFailures: Bool) async {
        guard !isInspecting, redeemable == nil else { return }

        let normalized = candidate.lowercased().hasPrefix("cashu:")
            ? String(candidate.dropFirst("cashu:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            : candidate
        guard normalized.lowercased().hasPrefix("cashu") else {
            if reportFailures { localError = "That doesn't look like an ecash token." }
            return
        }

        isInspecting = true
        defer { isInspecting = false }
        do {
            let preview = try await wallet.previewUnspentToken(normalized)
            token = normalized
            redeemable = RedeemableCashuToken(token: normalized, preview: preview)
        } catch {
            if reportFailures { localError = WalletViewModel.message(for: error) }
        }
    }

    /// A standing multi-use, open-amount request. Created quietly on open so there is always
    /// something to scan; failure is silent because this is a convenience, not the page's purpose
    /// -- pasting a token still works without it.
    @ViewBuilder
    private var openRequestCard: some View {
        if let openRequest {
            VStack(spacing: 14) {
                HStack {
                    walletFieldLabel("PAYMENT REQUEST")
                    Spacer(minLength: 8)
                    Text("Multi-use")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }

                CashuQRCodeView(value: openRequest.encoded, accessibilityLabel: "Cashu payment request QR code")

                Button {
                    UIPasteboard.general.string = openRequest.encoded
                    requestCopied = true
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    Task {
                        try? await Task.sleep(nanoseconds: 1_600_000_000)
                        requestCopied = false
                    }
                } label: {
                    Label(requestCopied ? "Copied" : "Copy request", systemImage: requestCopied ? "checkmark" : "doc.on.doc")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(requestCopied ? .green : TaskifyTheme.secondaryText)
                }
                .buttonStyle(.plain)
            }
            .padding(18)
            .frame(maxWidth: .infinity)
            .taskifyGlass(cornerRadius: 24)
        }
    }

    private func ensureOpenRequest() async {
        guard openRequest == nil,
              let mint = wallet.activeMint,
              !model.identityPublicKey.isEmpty else { return }

        // Reuse the standing request if one is already open for this mint. This is the ecash
        // equivalent of a Lightning address -- a durable thing to be paid at -- so opening the
        // page repeatedly must not mint a fresh request each time.
        if let existing = wallet.createdPaymentRequests.first(where: {
            $0.isActive && !$0.singleUse && $0.amount == nil && $0.mintURLs.contains(mint.url)
        }) {
            openRequest = existing
            return
        }

        openRequest = try? await wallet.createPaymentRequest(
            amount: nil,
            description: nil,
            mintURLs: [mint.url],
            recipientPublicKey: model.identityPublicKey,
            relayURLs: model.walletPaymentRequestRelayURLs,
            singleUse: false
        )
    }


}

/// A token that previewed cleanly and that the mint confirms is still unspent.
struct RedeemableCashuToken: Identifiable {
    let id = UUID()
    let token: String
    let preview: CashuTokenPreview
}

/// Redeeming a token gets its own page rather than unfolding inside the Receive eCash sheet: it's
/// a different job from handing out a request, it ends in its own success state, and it only ever
/// opens once the mint has confirmed the token is valid and unspent -- so there is something
/// definite to show by the time it appears.
struct RedeemCashuTokenSheet: View {
    @ObservedObject var wallet: WalletViewModel
    let redeemable: RedeemableCashuToken
    /// Dismisses the whole receive stack, not just this page. Redeeming is the end of the
    /// errand -- dropping the user back on the Receive eCash sheet they passed through would
    /// make them close a second screen to get anywhere.
    var onFinish: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var receivedAmount: UInt64?
    @State private var queuedReceive: CashuPendingReceive?
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 18) {
                        if let receivedAmount {
                            successView(amount: receivedAmount)
                        } else if let queuedReceive {
                            queuedView(queuedReceive)
                        } else {
                            Image(systemName: "banknote.fill")
                                .font(.system(size: 46))
                                .foregroundStyle(TaskifyTheme.accent)

                            tokenPreview(redeemable.preview)

                            WalletPrimaryActionButton(
                                title: "Receive \(wallet.formattedSats(redeemable.preview.receivedAmount))",
                                busyTitle: "Receiving…",
                                isBusy: wallet.isWorking,
                                systemImage: "checkmark"
                            ) {
                                Task { await receive() }
                            }
                            .disabled(wallet.isWorking)
                        }
                    }
                    .padding(22)
                }
            }
            .navigationTitle("Redeem ecash")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { finish() }
                }
            }
            .alert("Redeem ecash", isPresented: Binding(
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
    }

    private func finish() {
        if let onFinish { onFinish() } else { dismiss() }
    }

    private func receive() async {
        do {
            switch try await wallet.submitReceive(redeemable.token) {
            case .received(let amount):
                receivedAmount = amount
            case .alreadyReceived(let amount):
                receivedAmount = amount
            case .queued(let pending):
                queuedReceive = pending
            }
        } catch {
            localError = WalletViewModel.message(for: error)
        }
    }

    private func tokenPreview(_ preview: CashuTokenPreview) -> some View {
        VStack(spacing: 12) {
            HStack {
                Text("Token value")
                Spacer()
                Text("\(wallet.formattedSats(preview.amount))").bold()
            }
            if let fee = preview.fee, fee > 0 {
                HStack {
                    Text("Mint fee")
                    Spacer()
                    Text("−\(wallet.formattedSats(fee))")
                }
            }
            Divider().overlay(TaskifyTheme.border)
            HStack {
                Text("You receive").bold()
                Spacer()
                Text("\(wallet.formattedSats(preview.receivedAmount))").bold()
            }
            Text(preview.mintURL)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.tertiaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let memo = preview.memo, !memo.isEmpty {
                Text(memo)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .font(.subheadline)
        .foregroundStyle(TaskifyTheme.primaryText)
        .padding(18)
        .taskifyGlass(cornerRadius: 22)
    }

    private func successView(amount: UInt64) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.green)
                .symbolEffect(.bounce, value: amount)
            Text("Received")
                .font(.title.bold())
                .foregroundStyle(TaskifyTheme.primaryText)
            Text("\(wallet.formattedSats(amount))")
                .font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(TaskifyTheme.secondaryText)
            Button("Done") { finish() }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(.white)
                .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
                .buttonStyle(.plain)
        }
        .padding(.top, 54)
    }

    private func queuedView(_ pending: CashuPendingReceive) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 66))
                .foregroundStyle(TaskifyTheme.accent)
                .symbolEffect(.pulse)

            Text("Ecash saved safely")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            Text(wallet.automaticallyRedeemsIncomingPayments ? "Taskify kept the token on this device and will retry its mint automatically. You can close this screen without losing it." : "Taskify kept the token on this device. Choose Retry when you want to redeem it.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.secondaryText)

            VStack(spacing: 9) {
                HStack {
                    Text("Token value")
                    Spacer()
                    Text("\(wallet.formattedSats(pending.amount))").bold()
                }
                HStack {
                    Text("Mint")
                    Spacer()
                    Text(URL(string: pending.mintURL)?.host() ?? pending.mintURL)
                        .lineLimit(1)
                }
            }
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.primaryText)
            .padding(16)
            .taskifyGlass(cornerRadius: 20)

            Button {
                Task {
                    do {
                        receivedAmount = try await wallet.retryPendingReceive(pending)
                        queuedReceive = nil
                    } catch CashuWalletError.pendingReceiveAlreadySpent {
                        localError = CashuWalletError.pendingReceiveAlreadySpent.errorDescription
                    } catch {
                        localError = "The mint is still unavailable. Your token remains saved. \(WalletViewModel.message(for: error))"
                    }
                }
            } label: {
                Label(wallet.isWorking ? "Retrying…" : "Retry now", systemImage: "arrow.clockwise")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundStyle(.white)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(wallet.isWorking)

            Button("Done") { finish() }
                .font(.headline)
                .foregroundStyle(TaskifyTheme.accent)
        }
        .padding(.top, 34)
    }
}

struct PendingEcashSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var retryingID: String?
    @State private var discardCandidate: CashuPendingReceive?
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()

                if wallet.pendingEcashReceives.isEmpty {
                    ContentUnavailableView {
                        Label("All caught up", systemImage: "checkmark.circle.fill")
                    } description: {
                        Text("There are no saved ecash tokens waiting to be redeemed.")
                    }
                    .foregroundStyle(TaskifyTheme.primaryText)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            Text(wallet.automaticallyRedeemsIncomingPayments ? "Tokens waiting on a mint stay encrypted by iOS file protection on this device. Cashu tokens do not have a normal expiration, so Taskify keeps retrying recoverable tokens until they succeed, the mint confirms they are spent, or you remove them." : "Tokens stay saved on this device until you choose to retry or remove them. They are not automatically redeemed on this device.")
                                .font(.footnote)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                                .taskifyGlass(cornerRadius: 20)

                            ForEach(wallet.pendingEcashReceives) { pending in
                                pendingRow(pending)
                            }
                        }
                        .padding(18)
                        .padding(.bottom, 24)
                    }
                    .refreshable { await wallet.refresh() }
                }
            }
            .navigationTitle("Saved ecash")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Remove this saved token?",
                isPresented: Binding(
                    get: { discardCandidate != nil },
                    set: { if !$0 { discardCandidate = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove from Taskify", role: .destructive) {
                    guard let pending = discardCandidate else { return }
                    discardCandidate = nil
                    Task {
                        do {
                            try await wallet.discardPendingReceive(pending)
                        } catch {
                            localError = WalletViewModel.message(for: error)
                        }
                    }
                }
                Button("Keep token", role: .cancel) { discardCandidate = nil }
            } message: {
                Text("Only remove it if you kept the original token somewhere else or know it was already redeemed.")
            }
            .alert("Saved ecash", isPresented: Binding(
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

    private func pendingRow(_ pending: CashuPendingReceive) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 12) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.title3)
                    .frame(width: 42, height: 42)
                    .foregroundStyle(TaskifyTheme.accent)
                    .background(
                        TaskifyTheme.accent.opacity(0.12),
                        in: Circle()
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text("\(wallet.formattedSats(pending.amount))")
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(URL(string: pending.mintURL)?.host() ?? pending.mintURL)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }

                Spacer()

                Text("Saved")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.accent)
            }

            if let memo = pending.memo, !memo.isEmpty {
                Text(memo)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            if let lastAttemptAt = pending.lastAttemptAt {
                Text("Last tried \(lastAttemptAt, style: .relative) · \(pending.attemptCount) attempt\(pending.attemptCount == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            HStack(spacing: 12) {
                Button {
                    retry(pending)
                } label: {
                    Label(
                        retryingID == pending.id ? "Retrying…" : "Retry now",
                        systemImage: "arrow.clockwise"
                    )
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.52))
                }
                .buttonStyle(.plain)
                .disabled(retryingID != nil || wallet.isWorking)

                Button {
                    discardCandidate = pending
                } label: {
                    Image(systemName: "trash")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 46, height: 42)
                        .foregroundStyle(.orange)
                        .taskifyGlassControl(in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(retryingID != nil || wallet.isWorking)
                .accessibilityLabel("Remove saved ecash token")
            }
        }
        .padding(16)
        .taskifyGlass(cornerRadius: 22)
    }

    private func retry(_ pending: CashuPendingReceive) {
        retryingID = pending.id
        Task {
            defer { retryingID = nil }
            do {
                _ = try await wallet.retryPendingReceive(pending)
            } catch CashuWalletError.pendingReceiveAlreadySpent {
                localError = CashuWalletError.pendingReceiveAlreadySpent.errorDescription
            } catch {
                localError = "The token remains saved. \(WalletViewModel.message(for: error))"
            }
        }
    }
}

struct CashuTokenScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let guidanceTitle: String
    let guidanceText: String
    let unavailableText: String
    let acceptedPrefixes: [String]
    let invalidCodeMessage: String
    let acceptsAnimatedCashu: Bool
    let onToken: (String) -> Void
    @State private var scanError: String?
    @State private var scanStatus: String?

    init(onToken: @escaping (String) -> Void) {
        title = "Scan ecash"
        guidanceTitle = "Scan a Cashu token"
        guidanceText = "Point the camera at a Cashu QR code. Keep it steady while animated frames are captured."
        unavailableText = "You can still paste the Cashu token from the Receive screen."
        acceptedPrefixes = ["cashua", "cashub", "ur:"]
        invalidCodeMessage = "That QR code is not a Cashu token."
        acceptsAnimatedCashu = true
        self.onToken = onToken
    }

    init(lightningInvoice onInvoice: @escaping (String) -> Void) {
        title = "Scan invoice"
        guidanceTitle = "Scan a Lightning invoice"
        guidanceText = "Point the camera at a BOLT11 Lightning invoice."
        unavailableText = "You can still paste the invoice from the Lightning payment screen."
        acceptedPrefixes = ["lightning:ln", "lnbc", "lntb", "lnbcrt", "lnsb"]
        invalidCodeMessage = "That QR code is not a Lightning invoice."
        acceptsAnimatedCashu = false
        onToken = onInvoice
    }

    init(paymentRequest onRequest: @escaping (String) -> Void) {
        title = "Scan request"
        guidanceTitle = "Scan a Cashu request"
        guidanceText = "Point the camera at a creqA, creqB, or unified Bitcoin payment QR code."
        unavailableText = "You can still paste the Cashu request from the payment screen."
        acceptedPrefixes = ["creqa", "creqb1", "bitcoin:", "cashu:creq"]
        invalidCodeMessage = "That QR code is not a Cashu payment request."
        acceptsAnimatedCashu = false
        onToken = onRequest
    }

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        NavigationStack {
            Group {
                if scannerAvailable {
                    ZStack(alignment: .bottom) {
                        CashuTokenCodeScanner(
                            acceptedPrefixes: acceptedPrefixes,
                            invalidCodeMessage: invalidCodeMessage,
                            acceptsAnimatedCashu: acceptsAnimatedCashu,
                            onCode: onToken,
                            onProgress: {
                                scanError = nil
                                scanStatus = $0
                            },
                            onError: { scanError = $0 }
                        )
                        .ignoresSafeArea(edges: .bottom)

                        VStack(spacing: 8) {
                            Label(guidanceTitle, systemImage: "viewfinder")
                                .font(.subheadline.weight(.semibold))
                            Text(scanError ?? scanStatus ?? guidanceText)
                                .font(.caption)
                                .foregroundStyle(scanError == nil ? TaskifyTheme.secondaryText : Color.orange)
                                .multilineTextAlignment(.center)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity)
                        .taskifyGlass(cornerRadius: 22)
                        .padding(16)
                    }
                } else {
                    ContentUnavailableView {
                        Label("Camera scanning unavailable", systemImage: "qrcode.viewfinder")
                    } description: {
                        Text(unavailableText)
                    } actions: {
                        Button("Use paste instead") { dismiss() }
                            .buttonStyle(.borderedProminent)
                    }
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .background(TaskifyTheme.background.ignoresSafeArea())
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct CashuTokenCodeScanner: UIViewControllerRepresentable {
    let acceptedPrefixes: [String]
    let invalidCodeMessage: String
    let acceptsAnimatedCashu: Bool
    let onCode: (String) -> Void
    let onProgress: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            acceptedPrefixes: acceptedPrefixes,
            invalidCodeMessage: invalidCodeMessage,
            acceptsAnimatedCashu: acceptsAnimatedCashu,
            onCode: onCode,
            onProgress: onProgress,
            onError: onError
        )
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        context.coordinator.scanner = scanner
        DispatchQueue.main.async {
            do {
                try scanner.startScanning()
            } catch {
                context.coordinator.onError("The camera scanner could not start. Check camera access in iOS Settings.")
            }
        }
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) {
        uiViewController.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let acceptedPrefixes: [String]
        let invalidCodeMessage: String
        let acceptsAnimatedCashu: Bool
        let onCode: (String) -> Void
        let onProgress: (String) -> Void
        let onError: (String) -> Void
        weak var scanner: DataScannerViewController?
        private var deliveredCode = false
        private let animatedCollector = CashuAnimatedQRCollector()
        private let haptic = UISelectionFeedbackGenerator()

        init(
            acceptedPrefixes: [String],
            invalidCodeMessage: String,
            acceptsAnimatedCashu: Bool,
            onCode: @escaping (String) -> Void,
            onProgress: @escaping (String) -> Void,
            onError: @escaping (String) -> Void
        ) {
            self.acceptedPrefixes = acceptedPrefixes
            self.invalidCodeMessage = invalidCodeMessage
            self.acceptsAnimatedCashu = acceptsAnimatedCashu
            self.onCode = onCode
            self.onProgress = onProgress
            self.onError = onError
            haptic.prepare()
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            process(addedItems, with: dataScanner)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didUpdate updatedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            process(updatedItems, with: dataScanner)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            onError("Camera scanning became unavailable. You can still paste the token manually.")
        }

        private func process(
            _ items: [RecognizedItem],
            with dataScanner: DataScannerViewController
        ) {
            guard !deliveredCode else { return }
            var sawBarcode = false
            for item in items {
                guard case let .barcode(barcode) = item,
                      let value = barcode.payloadStringValue else {
                    continue
                }
                sawBarcode = true
                let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard acceptedPrefixes.contains(where: normalized.lowercased().hasPrefix) else {
                    continue
                }

                if acceptsAnimatedCashu {
                    switch animatedCollector.add(normalized) {
                    case .progress(let received, let expected, let duplicate):
                        if !duplicate {
                            haptic.selectionChanged()
                            haptic.prepare()
                        }
                        let progress = expected.map { "\(min(received, $0))/\($0)" } ?? "\(received)"
                        onProgress(duplicate
                            ? "Frame already captured · \(progress)"
                            : "Captured frame \(progress) · Keep scanning")
                        return
                    case .complete(let token):
                        deliver(token, with: dataScanner)
                        return
                    case .invalid(let message):
                        onError(message)
                        return
                    case .notAnimated:
                        break
                    }
                }

                deliver(normalized, with: dataScanner)
                return
            }
            if sawBarcode {
                onError(invalidCodeMessage)
            }
        }

        private func deliver(_ value: String, with dataScanner: DataScannerViewController) {
            deliveredCode = true
            dataScanner.stopScanning()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCode(value)
        }
    }
}

/// Picks a Nostr contact to pay. Shared by both send sheets so the two payment rails present the
/// same contact list, which is the point of the PWA's Contacts button: who you're paying is one
/// decision, and how the money travels is another.
struct WalletContactPickerSheet: View {
    let title: String
    /// Contacts that can't be paid on this rail are still listed but not selectable, so someone
    /// looking for a name finds it and learns why rather than wondering where it went.
    let isSelectable: (NostrContact) -> Bool
    let unavailableNote: String
    let onSelect: (NostrContact) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var contacts: [NostrContact] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let all = model.nostrContacts.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
        guard !query.isEmpty else { return all }
        return all.filter {
            $0.displayName.lowercased().contains(query)
                || $0.subtitle.lowercased().contains(query)
                || $0.npub.lowercased().contains(query)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                Group {
                    if model.nostrContacts.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "person.crop.circle.badge.questionmark")
                                .font(.system(size: 42))
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                            Text("No contacts yet")
                                .font(.headline)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text("Add someone in the Chat tab and they'll show up here.")
                                .font(.subheadline)
                                .multilineTextAlignment(.center)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        .padding(32)
                    } else {
                        ScrollView {
                            VStack(spacing: 10) {
                                ForEach(contacts) { contact in
                                    row(contact)
                                }
                            }
                            .padding(20)
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "Search contacts")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func row(_ contact: NostrContact) -> some View {
        let selectable = isSelectable(contact)
        return Button {
            onSelect(contact)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(contact.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(selectable ? contact.subtitle : unavailableNote)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if selectable {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .taskifyGlass(cornerRadius: 20)
        }
        .buttonStyle(.plain)
        .disabled(!selectable)
        .opacity(selectable ? 1 : 0.45)
    }
}

#endif
