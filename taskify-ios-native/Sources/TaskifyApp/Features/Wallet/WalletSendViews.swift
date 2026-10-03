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
struct SendLightningSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    /// Flips to the eCash version of this action, matching the PWA sheet header's mode button.
    var onSwitchMode: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    /// Which currency this sheet's keypad is entering in. Seeded from the saved preference and
    /// flipped by tapping the amount display.
    @State private var entryCurrency: WalletPrimaryCurrency = .sat
    @State private var invoice = ""
    @State private var amountText = ""
    @State private var selectedMintURL = ""
    @State private var quote: CashuLightningPaymentQuote?
    @State private var result: CashuLightningPaymentResult?
    @State private var localError: String?
    @State private var showingScanner = false
    @State private var isResolvingAddress = false
    @State private var step: Step = .destination
    @State private var showingContactPicker = false
    @FocusState private var focusedField: Field?

    /// Split across two screens the way the PWA's Lightning send sheet is (`lightningSendView`
    /// "input" then "address"): a destination screen, then -- only when the destination doesn't
    /// carry its own amount -- a keypad screen. Cramming a multi-line invoice field, a mint
    /// selector and a keypad onto one screen is what the PWA avoids here.
    private enum Step {
        case destination
        case amount
    }

    private enum Field {
        case invoice
    }

    private var customAmount: UInt64? {
        // Always sats, whatever currency the keypad is in -- dollar entry converts here.
        wallet.sats(fromEntry: amountText, currency: entryCurrency)
    }

    /// A `name@domain` Lightning Address (LUD-16) rather than a pasted/scanned BOLT11 invoice --
    /// matches the PWA's `isLnAddress` branch in `CashuWalletModal.tsx`'s `handlePayInvoice`.
    private var isLightningAddress: Bool {
        LnurlPayClient.isLightningAddress(invoice)
    }

    private var trimmedInvoice: String {
        invoice.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var fundedMints: [CashuMintSummary] {
        wallet.snapshot.mints.filter { $0.available > 0 }
    }

    private var canLeaveDestinationStep: Bool {
        !trimmedInvoice.isEmpty && !selectedMintURL.isEmpty
    }

    private var canSubmitAmount: Bool {
        (customAmount ?? 0) > 0
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()

                ScrollView {
                    Group {
                        if let result {
                            successView(result)
                        } else if let quote {
                            confirmationView(quote)
                        } else if step == .amount {
                            amountView
                        } else {
                            destinationView
                        }
                    }
                    .padding(22)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Pay Lightning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if step == .amount && quote == nil && result == nil {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { step = .destination }
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    if let onSwitchMode {
                        Button("eCash", action: onSwitchMode)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Lightning payment", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(wallet.isWorking || isResolvingAddress)
        .onAppear {
            entryCurrency = wallet.amountEntryCurrency
            if selectedMintURL.isEmpty { selectedMintURL = wallet.activeMint?.url ?? "" }
        }
        .onDisappear {
            if let quote, result == nil {
                Task { await wallet.cancelLightningPayment(quote) }
            }
        }
        .sheet(isPresented: $showingContactPicker) {
            WalletContactPickerSheet(
                title: "Pay a contact",
                isSelectable: { _ in true },
                unavailableNote: ""
            ) { contact in
                invoice = WalletContactPayment.lightningAddress(lud16: contact.profile?.lud16, npub: contact.npub)
                focusedField = nil
            }
        }
        .sheet(isPresented: $showingScanner) {
            CashuTokenScannerSheet(lightningInvoice: { value in
                invoice = value
                showingScanner = false
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            })
        }
    }

    /// Step one, mirroring the PWA's "input" view: where the money is going and which mint pays.
    private var destinationView: some View {
        VStack(spacing: 20) {
            walletFieldLabel("SEND TO")

            ZStack(alignment: .topLeading) {
                if invoice.isEmpty {
                    Text("Invoice or lightning address")
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 14)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $invoice)
                    .font(.caption.monospaced())
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .scrollContentBackground(.hidden)
                    .focused($focusedField, equals: .invoice)
                    .padding(10)
            }
            .frame(minHeight: 104)
            .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(TaskifyTheme.border))

            HStack(spacing: 12) {
                Button { showingScanner = true } label: {
                    Label("Scan", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)

                Button {
                    if let pasted = UIPasteboard.general.string {
                        invoice = pasted
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    }
                } label: {
                    Label("Paste", systemImage: "doc.on.clipboard")
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)

                Button { showingContactPicker = true } label: {
                    Label("Contacts", systemImage: "person.crop.circle")
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .font(.headline)
            .foregroundStyle(TaskifyTheme.primaryText)

            if fundedMints.isEmpty {
                Text("Add a mint with a balance in Wallet → Mints to start sending.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                WalletMintSelectorCard(
                    label: "PAY FROM",
                    mints: fundedMints,
                    selectedMintURL: $selectedMintURL
                )
            }

            WalletPrimaryActionButton(
                title: isLightningAddress ? "Continue" : "Review payment",
                busyTitle: "Checking invoice…",
                isBusy: wallet.isWorking
            ) {
                focusedField = nil
                if isLightningAddress {
                    withAnimation(.easeInOut(duration: 0.2)) { step = .amount }
                } else {
                    Task { await prepareQuote() }
                }
            }
            .disabled(wallet.isWorking || !canLeaveDestinationStep)
            .opacity(canLeaveDestinationStep ? 1 : 0.45)

            Label(
                "The selected Cashu mint pays the invoice. Taskify never sends your recovery phrase.",
                systemImage: "lock.shield"
            )
            .font(.caption)
            .multilineTextAlignment(.center)
            .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }

    /// Step two, mirroring the PWA's "address" view: a lightning address carries no amount of its
    /// own, so it gets the same keypad the rest of the wallet's amount entry uses.
    private var amountView: some View {
        VStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                walletFieldLabel("SEND TO")
                Text(trimmedInvoice)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .taskifyGlass(cornerRadius: 18)
            }

            WalletAmountDisplayCard(
                primary: wallet.entryPrimaryText(amountText, currency: entryCurrency),
                caption: "Enter amount to send",
                secondary: wallet.entrySecondaryText(amountText, currency: entryCurrency),
                onToggleCurrency: wallet.currencyToggleAction(using: model) {
                    amountText = ""
                    entryCurrency = wallet.amountEntryCurrency
                }
            )

            WalletAmountKeypad(amountText: $amountText, allowsDecimal: entryCurrency == .usd)

            WalletPrimaryActionButton(
                title: "Review payment",
                busyTitle: isResolvingAddress ? "Resolving address…" : "Checking invoice…",
                isBusy: wallet.isWorking || isResolvingAddress
            ) {
                Task { await prepareQuote() }
            }
            .disabled(wallet.isWorking || isResolvingAddress || !canSubmitAmount)
            .opacity(canSubmitAmount ? 1 : 0.45)
        }
    }

    /// Resolves a lightning address to an invoice where needed, then asks the mint to quote the
    /// payment. Success lands on the review screen rather than paying outright.
    private func prepareQuote() async {
        do {
            if isLightningAddress {
                isResolvingAddress = true
                let resolution = try await LnurlPayClient.resolveInvoice(
                    address: trimmedInvoice,
                    amountSats: customAmount ?? 0
                )
                isResolvingAddress = false
                quote = try await wallet.prepareLightningPayment(
                    mintURL: selectedMintURL,
                    invoice: resolution.invoice,
                    amount: resolution.amountSats
                )
            } else {
                quote = try await wallet.prepareLightningPayment(
                    mintURL: selectedMintURL,
                    invoice: trimmedInvoice,
                    amount: customAmount
                )
            }
        } catch {
            isResolvingAddress = false
            localError = WalletViewModel.message(for: error)
        }
    }


    /// Native-only review step -- the PWA pays straight from its send sheet. Kept because a
    /// Lightning payment is irreversible and the fee reserve isn't knowable until the mint quotes
    /// it, but restyled to the PWA's grammar: amount hero, label/value rows, one full-width action.
    private func confirmationView(_ quote: CashuLightningPaymentQuote) -> some View {
        let amount = wallet.displayAmount(forSats: quote.amount)

        return VStack(spacing: 20) {
            WalletAmountHero(
                label: "AMOUNT",
                amount: amount.primary,
                secondary: amount.secondary
            )

            VStack(spacing: 14) {
                WalletDetailRow(title: "Maximum routing fee", value: wallet.formattedSats(quote.feeReserve))
                if quote.walletFee > 0 {
                    WalletDetailRow(title: "Mint input fee", value: wallet.formattedSats(quote.walletFee))
                }
                Divider().overlay(TaskifyTheme.border)
                WalletDetailRow(
                    title: "Maximum from balance",
                    value: wallet.formattedSats(quote.maximumTotal),
                    emphasized: true
                )
                WalletDetailRow(
                    title: "Paid by",
                    value: URL(string: quote.mintURL)?.host() ?? quote.mintURL
                )
                if let expiresAt = quote.expiresAt {
                    WalletDetailRow(
                        title: "Invoice expires",
                        value: expiresAt.formatted(.relative(presentation: .named)),
                        valueColor: quote.isExpired() ? .orange : nil
                    )
                }
            }
            .padding(18)
            .taskifyGlass(cornerRadius: 22)

            WalletPrimaryActionButton(
                title: "Pay \(wallet.formattedSats(quote.amount))",
                busyTitle: "Paying…",
                isBusy: wallet.isWorking,
                systemImage: "bolt.fill"
            ) {
                Task {
                    do {
                        result = try await wallet.confirmLightningPayment(quote)
                    } catch {
                        localError = WalletViewModel.message(for: error)
                        self.quote = nil
                    }
                }
            }
            .disabled(wallet.isWorking || quote.isExpired())
            .opacity(quote.isExpired() ? 0.45 : 1)

            Button("Back") {
                Task { await wallet.cancelLightningPayment(quote) }
                self.quote = nil
            }
            .disabled(wallet.isWorking)
            .foregroundStyle(TaskifyTheme.secondaryText)

            Text("The actual routing fee can be lower than the maximum. Unused fee reserve returns to your wallet automatically.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }


    private func successView(_ result: CashuLightningPaymentResult) -> some View {
        VStack(spacing: 20) {
            Image(systemName: result.state == .completed ? "checkmark.circle.fill" : "clock.badge.checkmark.fill")
                .font(.system(size: 72))
                .foregroundStyle(result.state == .completed ? Color.green : Color.orange)
                .symbolEffect(.bounce, value: result.quoteID)

            Text(result.state == .completed ? "Payment sent" : "Payment processing")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            Text(wallet.displayAmount(forSats: result.amount).primary)
                .font(.system(size: 42, weight: .bold, design: .rounded))
                .foregroundStyle(TaskifyTheme.primaryText)
            if let secondary = wallet.displayAmount(forSats: result.amount).secondary {
                Text(secondary)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            VStack(spacing: 14) {
                WalletDetailRow(title: "Amount", value: wallet.formattedSats(result.amount))
                if let feePaid = result.feePaid {
                    WalletDetailRow(title: "Fee paid", value: wallet.formattedSats(feePaid))
                }
                WalletDetailRow(
                    title: "Status",
                    value: result.state == .completed ? "Completed" : "Pending",
                    valueColor: result.state == .completed ? .green : .orange
                )
            }
            .padding(18)
            .taskifyGlass(cornerRadius: 22)

            Text(result.state == .completed
                ? "The payment and its technical details are now available in Wallet History."
                : "The mint is still processing this payment. Do not retry it. Taskify will reconcile the reserved balance when the wallet next refreshes online.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.secondaryText)

            WalletPrimaryActionButton(title: "Done") { dismiss() }
        }
    }
}

struct PayCashuRequestSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var requestValue = ""
    @State private var preview: CashuPaymentRequestPreview?
    @State private var selectedMintURL = ""
    @State private var amountText = ""
    @State private var result: CashuPaymentRequestPaymentResult?
    @State private var isInspecting = false
    @State private var showingScanner = false
    @State private var confirmingPayment = false
    @State private var paymentUncertain = false
    @State private var localError: String?
    @FocusState private var amountFocused: Bool
    @FocusState private var requestFocused: Bool

    private var compatibleMints: [CashuMintSummary] {
        guard let preview else { return [] }
        return wallet.snapshot.mints.filter {
            CashuWalletService.paymentRequestAcceptsMint(preview, mintURL: $0.url)
        }
    }

    private var selectedMint: CashuMintSummary? {
        compatibleMints.first { $0.url == selectedMintURL }
    }

    private var paymentAmount: UInt64? {
        if let fixed = preview?.amount { return fixed }
        return UInt64(amountText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var canReview: Bool {
        guard let amount = paymentAmount,
              amount > 0,
              let mint = selectedMint,
              !paymentUncertain,
              preview?.transports.isEmpty == false else { return false }
        return mint.available >= amount && !wallet.isWorking
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()

                ScrollView {
                    Group {
                        if let result {
                            successView(result)
                        } else if let preview {
                            requestPreview(preview)
                        } else {
                            requestInput
                        }
                    }
                    .padding(22)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Cashu request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if result == nil {
                        Button {
                            showingScanner = true
                        } label: {
                            Image(systemName: "qrcode.viewfinder")
                        }
                        .accessibilityLabel("Scan Cashu payment request")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                paymentAmount.map { "Pay \(wallet.formattedSats($0))?" } ?? "Pay Cashu request?",
                isPresented: $confirmingPayment,
                titleVisibility: .visible
            ) {
                Button("Pay request") { pay() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This creates bearer ecash and sends it using the request's Nostr or HTTP delivery method. The payment cannot be reversed.")
            }
            .alert("Cashu payment request", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
            .sheet(isPresented: $showingScanner) {
                CashuTokenScannerSheet(paymentRequest: { value in
                    requestValue = value
                    showingScanner = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        inspectRequest()
                    }
                })
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            guard requestValue.isEmpty,
                  let pasted = UIPasteboard.general.string,
                  (try? CashuWalletService.normalizedPaymentRequest(pasted)) != nil else { return }
            requestValue = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async { inspectRequest() }
        }
    }

    private var requestInput: some View {
        VStack(spacing: 18) {
            Image(systemName: "qrcode")
                .font(.system(size: 52))
                .foregroundStyle(TaskifyTheme.accent)

            VStack(spacing: 6) {
                Text("Fulfill an ecash request")
                    .font(.title2.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text("Scan or paste a PWA-compatible creqA, creqB, or unified Bitcoin payment request.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            TextEditor(text: $requestValue)
                .font(.system(.footnote, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(12)
                .frame(minHeight: 130)
                .background(
                    TaskifyTheme.raisedFill,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(TaskifyTheme.border)
                )
                .foregroundStyle(TaskifyTheme.primaryText)
                .focused($requestFocused)

            HStack(spacing: 12) {
                Button {
                    guard let value = UIPasteboard.general.string else { return }
                    requestValue = value
                    requestFocused = false
                    DispatchQueue.main.async { inspectRequest() }
                } label: {
                    Label("Paste", systemImage: "doc.on.clipboard")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)

                Button { showingScanner = true } label: {
                    Label("Scan", systemImage: "qrcode.viewfinder")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .foregroundStyle(TaskifyTheme.primaryText)

            Button { inspectRequest() } label: {
                Text(isInspecting ? "Reading request…" : "Continue")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .contentShape(Capsule())
                    .foregroundStyle(.white)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(
                isInspecting
                    || requestValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            )
        }
    }

    private func requestPreview(_ preview: CashuPaymentRequestPreview) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "arrow.up.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(TaskifyTheme.accent)

            Text(preview.amount == nil ? "Choose an amount" : "Review request")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            if let fixedAmount = preview.amount {
                Text(wallet.formattedSats(fixedAmount))
                    .font(.system(size: 46, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .padding(.vertical, 23)
                    .frame(maxWidth: .infinity)
                    .taskifyGlass(cornerRadius: 26)
            } else {
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
                }
                .padding(.vertical, 23)
                .frame(maxWidth: .infinity)
                .taskifyGlass(cornerRadius: 26)
            }

            mintPicker
            requestDetails(preview)

            if compatibleMints.isEmpty {
                Label(
                    "None of your configured mints are accepted by this request.",
                    systemImage: "building.columns.fill"
                )
                .font(.footnote)
                .foregroundStyle(.orange)
            } else if let amount = paymentAmount,
                      let mint = selectedMint,
                      mint.available < amount {
                Label(
                    "This mint needs \(wallet.formattedSats(amount - mint.available)) more.",
                    systemImage: "exclamationmark.circle"
                )
                .font(.footnote)
                .foregroundStyle(.orange)
            }

            if preview.transports.isEmpty {
                Label(
                    "This request has no Nostr or HTTP return address, so it cannot be fulfilled from a scanned code.",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.footnote)
                .foregroundStyle(.orange)
            }

            if paymentUncertain {
                Label(
                    "Payment delivery is uncertain. Verify with the recipient before doing anything else.",
                    systemImage: "exclamationmark.shield"
                )
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.orange)
            }

            Button {
                amountFocused = false
                confirmingPayment = true
            } label: {
                Label(
                    wallet.isWorking ? "Sending…" : "Review payment",
                    systemImage: "arrow.up"
                )
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(.white)
                .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(!canReview)

            Button("Use a different request") {
                self.preview = nil
                selectedMintURL = ""
                amountText = ""
                paymentUncertain = false
            }
            .foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

    @ViewBuilder
    private var mintPicker: some View {
        if compatibleMints.count > 1 {
            Picker("Send from", selection: $selectedMintURL) {
                ForEach(compatibleMints) { mint in
                    Text("\(mint.name) · \(wallet.formattedSats(mint.available))").tag(mint.url)
                }
            }
            .pickerStyle(.menu)
            .tint(TaskifyTheme.accent)
        } else if let mint = compatibleMints.first {
            HStack {
                Label(mint.name, systemImage: "building.columns")
                Spacer()
                Text("\(wallet.formattedSats(mint.available))")
            }
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .padding(16)
            .taskifyGlass(cornerRadius: 18)
        }
    }

    private func requestDetails(_ preview: CashuPaymentRequestPreview) -> some View {
        VStack(spacing: 11) {
            if let description = preview.description?.trimmingCharacters(in: .whitespacesAndNewlines),
               !description.isEmpty {
                HStack(alignment: .top) {
                    Text("Memo")
                    Spacer()
                    Text(description)
                        .multilineTextAlignment(.trailing)
                        .foregroundStyle(TaskifyTheme.primaryText)
                }
            }

            HStack {
                Text("Delivery")
                Spacer()
                Text(preview.transports.map { $0 == .nostr ? "Nostr" : "HTTP" }.joined(separator: ", "))
                    .foregroundStyle(TaskifyTheme.primaryText)
            }

            if let singleUse = preview.singleUse {
                HStack {
                    Text("Request")
                    Spacer()
                    Text(singleUse ? "Single-use" : "Reusable")
                        .foregroundStyle(TaskifyTheme.primaryText)
                }
            }
        }
        .font(.subheadline)
        .foregroundStyle(TaskifyTheme.secondaryText)
        .padding(17)
        .taskifyGlass(cornerRadius: 22)
    }

    private func successView(_ result: CashuPaymentRequestPaymentResult) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.green)
                .symbolEffect(.bounce, value: result.amount)
            Text("Request paid")
                .font(.title.bold())
                .foregroundStyle(TaskifyTheme.primaryText)
            Text("\(wallet.formattedSats(result.amount))")
                .font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(TaskifyTheme.secondaryText)
            Text("The ecash was delivered using the payment request's preferred transport.")
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
        .padding(.top, 54)
    }

    private func inspectRequest() {
        guard !isInspecting else { return }
        requestFocused = false
        isInspecting = true
        defer { isInspecting = false }
        do {
            let preview = try wallet.previewPaymentRequest(requestValue)
            withAnimation(.snappy(duration: 0.22)) {
                self.preview = preview
            }
            paymentUncertain = false
            let active = wallet.activeMint
            if let active,
               CashuWalletService.paymentRequestAcceptsMint(preview, mintURL: active.url) {
                selectedMintURL = active.url
            } else {
                selectedMintURL = wallet.snapshot.mints.first(where: {
                    CashuWalletService.paymentRequestAcceptsMint(preview, mintURL: $0.url)
                })?.url ?? ""
            }
            if preview.amount == nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    amountFocused = true
                }
            }
        } catch {
            localError = WalletViewModel.message(for: error)
        }
    }

    private func pay() {
        guard let preview, let amount = paymentAmount else { return }
        Task {
            do {
                result = try await wallet.payPaymentRequest(
                    preview,
                    mintURL: selectedMintURL,
                    customAmount: preview.amount == nil ? amount : nil
                )
            } catch CashuWalletError.paymentRequestUncertain {
                paymentUncertain = true
                localError = CashuWalletError.paymentRequestUncertain.errorDescription
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
    }
}

struct SendCashuSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(AppModel.self) private var model
    /// Flips to the Lightning version of this action, matching the PWA sheet header's mode button.
    var onSwitchMode: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    /// Which currency this sheet's keypad is entering in. Seeded from the saved preference and
    /// flipped by tapping the amount display.
    @State private var entryCurrency: WalletPrimaryCurrency = .sat
    @State private var amountText = ""
    @State private var memo = ""
    @State private var selectedMintURL = ""
    @State private var quote: CashuPreparedSendQuote?
    @State private var outgoing: CashuOutgoingToken?
    @State private var localError: String?
    @State private var confirmingReclaim = false
    @State private var showingContactPicker = false
    /// When set, the created token is delivered to this contact over an encrypted DM instead of
    /// being handed back for the user to share themselves.
    @State private var recipient: NostrContact?
    @State private var isSendingToContact = false
    @State private var sentToContact: NostrContact?
    @State private var lockToken = false
    @State private var manualLockKey = ""

    private var amount: UInt64? {
        // Always sats, whatever currency the keypad is in -- dollar entry converts here.
        wallet.sats(fromEntry: amountText, currency: entryCurrency)
    }

    private var normalizedLockKey: String? {
        guard lockToken else { return nil }
        if let recipient {
            return CashuP2PKKey.normalizePublicKey(recipient.npub)
        }
        return CashuP2PKKey.normalizePublicKey(manualLockKey)
    }

    private func directMessageBody(token: String, sats: UInt64) -> String {
        WalletContactPayment.ecashDirectMessage(
            senderNpub: model.identityNpub,
            formattedAmount: wallet.formattedSats(sats),
            token: token
        )
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                GeometryReader { proxy in
                    ScrollView {
                        Group {
                            if let outgoing {
                                if let sentToContact {
                                    Label(
                                        "Sent to \(sentToContact.displayName)",
                                        systemImage: "checkmark.circle.fill"
                                    )
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.green)
                                    .frame(maxWidth: .infinity)
                                    .padding(.bottom, 4)
                                }
                                OutgoingTokenContent(
                                    outgoing: outgoing,
                                    checkAction: {
                                        Task {
                                            do { self.outgoing = try await wallet.checkOutgoingToken(outgoing) }
                                            catch { localError = WalletViewModel.message(for: error) }
                                        }
                                    },
                                    reclaimAction: { confirmingReclaim = true }
                                )
                            } else if let quote {
                                confirmationView(quote)
                            } else {
                                amountView
                            }
                        }
                        .padding(22)
                        .frame(minHeight: proxy.size.height, alignment: .center)
                    }
                }
            }
            .navigationTitle(outgoing == nil ? "Send eCash" : "Ecash token")
            .navigationBarTitleDisplayMode(.inline)
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
            .sheet(isPresented: $showingContactPicker) {
                WalletContactPickerSheet(
                    title: "Send ecash to",
                    isSelectable: { _ in true },
                    unavailableNote: ""
                ) { contact in
                    recipient = contact
                }
            }
            .alert("Send ecash", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK", role: .cancel) { localError = nil }
            } message: {
                Text(localError ?? "")
            }
            .confirmationDialog(
                "Reclaim this token?",
                isPresented: $confirmingReclaim,
                titleVisibility: .visible
            ) {
                Button("Reclaim ecash") {
                    guard let outgoing else { return }
                    Task {
                        do {
                            _ = try await wallet.reclaim(outgoing)
                            dismiss()
                        } catch {
                            localError = "The token may already have been redeemed. \(WalletViewModel.message(for: error))"
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Only reclaim a token you have not given to someone else.")
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            entryCurrency = wallet.amountEntryCurrency
            if selectedMintURL.isEmpty { selectedMintURL = wallet.activeMint?.url ?? "" }
        }
        .onDisappear {
            if let quote, outgoing == nil {
                Task { await wallet.cancelPreparedSend(quote) }
            }
        }
    }

    private var amountView: some View {
        VStack(spacing: 20) {
            WalletMintSelectorCard(
                label: "SEND FROM",
                mints: wallet.snapshot.mints.filter { $0.available > 0 },
                selectedMintURL: $selectedMintURL
            )

            WalletAmountDisplayCard(
                primary: wallet.entryPrimaryText(amountText, currency: entryCurrency),
                caption: "Enter amount to send",
                secondary: wallet.entrySecondaryText(amountText, currency: entryCurrency),
                onToggleCurrency: wallet.currencyToggleAction(using: model) {
                    amountText = ""
                    entryCurrency = wallet.amountEntryCurrency
                }
            )

            WalletAmountKeypad(amountText: $amountText, allowsDecimal: entryCurrency == .usd)

            VStack(alignment: .leading, spacing: 8) {
                walletFieldLabel("SEND TO")
                if let recipient {
                    HStack(spacing: 10) {
                        Image(systemName: "person.crop.circle.fill")
                            .foregroundStyle(TaskifyTheme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(recipient.displayName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text("Delivered over an encrypted DM")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        Spacer(minLength: 8)
                        Button {
                            self.recipient = nil
                            lockToken = false
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Send as a shareable token instead")
                    }
                    .padding(16)
                    .taskifyGlass(cornerRadius: 18)
                } else {
                    Button { showingContactPicker = true } label: {
                        Label("Choose a contact", systemImage: "person.crop.circle")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .taskifyGlassControl(in: Capsule())
                    }
                    .buttonStyle(.plain)
                    Text("Or leave this empty to get a token you can share yourself.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                Toggle(
                    recipient == nil ? "Lock token to a recipient key" : "Lock token to this contact",
                    isOn: $lockToken
                )
                .font(.subheadline.weight(.semibold))
                .padding(.top, 6)

                if lockToken, recipient == nil {
                    HStack(spacing: 8) {
                        TextField("P2PK key or npub", text: $manualLockKey)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.system(.caption, design: .monospaced))
                        Button("Paste") {
                            manualLockKey = UIPasteboard.general.string ?? ""
                        }
                        .font(.caption.weight(.semibold))
                    }
                    .padding(.horizontal, 15)
                    .frame(minHeight: 50)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TaskifyTheme.border))
                    if !manualLockKey.isEmpty, normalizedLockKey == nil {
                        Label("Enter a valid compressed P2PK key, npub, or 64-character public key.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                } else if lockToken, recipient != nil {
                    Label("Only this contact's Nostr key can unlock the ecash.", systemImage: "lock.shield.fill")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                walletFieldLabel("MEMO")
                TextField("Optional note for the recipient", text: $memo)
                    .padding(.horizontal, 15)
                    .frame(height: 50)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TaskifyTheme.border))
                    .foregroundStyle(TaskifyTheme.primaryText)
            }

            WalletPrimaryActionButton(
                title: "Continue",
                busyTitle: "Preparing…",
                isBusy: wallet.isWorking
            ) {
                guard let amount, amount > 0 else { return }
                Task {
                    do {
                        quote = try await wallet.prepareSend(
                            mintURL: selectedMintURL,
                            amount: amount,
                            lockPublicKey: normalizedLockKey
                        )
                    }
                    catch { localError = WalletViewModel.message(for: error) }
                }
            }
            .disabled(
                wallet.isWorking
                    || amount == nil
                    || amount == 0
                    || selectedMintURL.isEmpty
                    || (lockToken && normalizedLockKey == nil)
            )
            .opacity((amount ?? 0) > 0 && !selectedMintURL.isEmpty ? 1 : 0.45)

            Text("The token remains reserved until its recipient redeems it or you reclaim it.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }

    /// Mints the token and, when a contact was chosen, delivers it to them over a NIP-17 DM.
    ///
    /// The DM is sent after the token exists, and a failure to deliver deliberately does not
    /// discard it: the money has already left the balance at that point, so the token is kept on
    /// screen to share by hand rather than being silently stranded.
    private func confirm(_ quote: CashuPreparedSendQuote) async {
        let sentAmount = quote.amount
        do {
            let token = try await wallet.confirmSend(quote, memo: memo)
            outgoing = token

            guard let recipient else { return }
            isSendingToContact = true
            defer { isSendingToContact = false }
            do {
                try await model.sendDirectMessage(
                    to: recipient.npub,
                    content: directMessageBody(token: token.token, sats: sentAmount)
                )
                sentToContact = recipient
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                localError = "The token was created but couldn't be sent to \(recipient.displayName). Share it manually below. (\(WalletViewModel.message(for: error)))"
            }
        } catch {
            localError = WalletViewModel.message(for: error)
        }
    }

    /// Native-only review step before minting the token, restyled to match the PWA's grammar
    /// (amount hero, label/value rows, one full-width action) rather than the ad-hoc HStacks it
    /// used before.
    private func confirmationView(_ quote: CashuPreparedSendQuote) -> some View {
        let amount = wallet.displayAmount(forSats: quote.amount)

        return VStack(spacing: 20) {
            WalletAmountHero(
                label: "RECIPIENT RECEIVES",
                amount: amount.primary,
                secondary: amount.secondary
            )

            VStack(spacing: 14) {
                WalletDetailRow(title: "Mint fee", value: wallet.formattedSats(quote.fee))
                Divider().overlay(TaskifyTheme.border)
                WalletDetailRow(
                    title: "Total from balance",
                    value: wallet.formattedSats(quote.amount + quote.fee),
                    emphasized: true
                )
                WalletDetailRow(
                    title: "Sent from",
                    value: URL(string: quote.mintURL)?.host() ?? quote.mintURL
                )
            }
            .padding(18)
            .taskifyGlass(cornerRadius: 22)

            WalletPrimaryActionButton(
                title: recipient == nil ? "Create token" : "Send to \(recipient?.displayName ?? "")",
                busyTitle: isSendingToContact ? "Sending…" : "Creating token…",
                isBusy: wallet.isWorking || isSendingToContact
            ) {
                Task { await confirm(quote) }
            }
            .disabled(wallet.isWorking || isSendingToContact)

            Button("Back") {
                Task { await wallet.cancelPreparedSend(quote) }
                self.quote = nil
            }
            .foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

}

#endif
