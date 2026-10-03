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
struct WalletHistorySheet: View {
    private enum Filter: String, CaseIterable {
        case all = "All"
        case pending = "Pending"
    }

    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var selectedOutgoing: CashuOutgoingToken?
    @State private var selectedLightningQuote: CashuLightningReceiveQuote?
    @State private var selectedTransaction: CashuTransactionSummary?
    @State private var filter: Filter = .all

    private var activityItems: [WalletActivityItem] {
        let actionableTokens = wallet.snapshot.outgoingTokens.filter {
            $0.status == .ready || $0.status == .partiallyRedeemed
        }
        let actionableTokenIDs = Set(actionableTokens.map(\.id))
        let transactions = wallet.snapshot.transactions
            .filter { transaction in
                guard let outgoingTokenID = transaction.outgoingTokenID else { return true }
                return !actionableTokenIDs.contains(outgoingTokenID)
            }
            .map(WalletActivityItem.transaction)
        let invoices = wallet.activeLightningReceiveQuotes.map(WalletActivityItem.lightningInvoice)
        let outgoing = actionableTokens.map(WalletActivityItem.outgoingToken)
        return (transactions + invoices + outgoing).sorted { $0.date > $1.date }
    }

    var body: some View {
        let allItems = activityItems
        let pendingItems = allItems.filter(\.isPending)
        let filteredItems = filter == .pending ? pendingItems : allItems

        return NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if !allItems.isEmpty {
                            historyFilters(pendingItems: pendingItems)
                                .padding(.bottom, 2)
                        }

                        if filteredItems.isEmpty {
                            ContentUnavailableView(
                                filter == .pending ? "No pending entries" : "No wallet activity",
                                systemImage: filter == .pending ? "checkmark.circle" : "clock",
                                description: Text(filter == .pending
                                    ? "Pending invoices and unredeemed ecash will appear here."
                                    : "Lightning invoices and ecash activity will appear here.")
                            )
                            .foregroundStyle(TaskifyTheme.secondaryText)
                        } else {
                            ForEach(filteredItems) { item in
                                switch item {
                                case .outgoingToken(let outgoing):
                                    Button { selectedOutgoing = outgoing } label: {
                                        WalletOutgoingTokenRow(outgoing: outgoing)
                                    }
                                    .buttonStyle(.plain)
                                case .transaction(let transaction):
                                    Button { selectedTransaction = transaction } label: {
                                        WalletTransactionRow(transaction: transaction)
                                    }
                                    .buttonStyle(.plain)
                                case .lightningInvoice(let quote):
                                    Button { selectedLightningQuote = quote } label: {
                                        WalletLightningInvoiceRow(quote: quote)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    .padding(18)
                    .padding(.bottom, 30)
                }
            }
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $selectedOutgoing) { outgoing in
                OutgoingTokenSheet(wallet: wallet, outgoing: outgoing)
            }
            .sheet(item: $selectedLightningQuote) { quote in
                ReceiveLightningSheet(wallet: wallet, initialQuote: quote)
            }
            .sheet(item: $selectedTransaction) { transaction in
                WalletTransactionDetailSheet(wallet: wallet, transaction: transaction)
            }
        }
        .preferredColorScheme(.dark)
    }

    private func historyFilters(pendingItems: [WalletActivityItem]) -> some View {
        HStack(spacing: 13) {
            ForEach(Filter.allCases, id: \.self) { option in
                if option != Filter.all {
                    Text("•")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .accessibilityHidden(true)
                }

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        filter = option
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(option.rawValue.uppercased())
                            .font(.caption2.weight(.bold))
                            .tracking(1)

                        if option == .pending, !pendingItems.isEmpty {
                            Text(pendingItems.count.formatted())
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(TaskifyTheme.raisedFill, in: Capsule())
                        }
                    }
                    .foregroundStyle(filter == option ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                }
                .buttonStyle(.plain)
                .disabled(option == .pending && pendingItems.isEmpty)
                .opacity(option == .pending && pendingItems.isEmpty ? 0.45 : 1)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 42)
        .taskifyGlass(cornerRadius: 18)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Filter wallet history")
    }
}

struct WalletOutgoingTokenRow: View {
    let outgoing: CashuOutgoingToken

    private var statusLabel: String {
        switch outgoing.status {
        case .ready: "Ready to share"
        case .partiallyRedeemed: "Partially redeemed"
        case .redeemed: "Redeemed"
        case .reclaimed: "Reclaimed"
        }
    }

    private var statusColor: Color {
        switch outgoing.status {
        case .ready: TaskifyTheme.accent
        case .partiallyRedeemed: .orange
        case .redeemed: .green
        case .reclaimed: TaskifyTheme.secondaryText
        }
    }

    private var mintName: String {
        URL(string: outgoing.mintURL)?.host() ?? outgoing.mintURL
    }

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: "banknote")
                .font(.headline)
                .frame(width: 42, height: 42)
                .foregroundStyle(TaskifyTheme.primaryText)
                .background(TaskifyTheme.raisedFill, in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text("Ecash")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(outgoing.createdAt, style: .relative)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }

                HStack(spacing: 5) {
                    Text(statusLabel)
                        .foregroundStyle(statusColor)
                    Text("•")
                    Text(mintName)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }
                .font(.caption)
            }

            Spacer(minLength: 8)

            Text("−\(WalletAmountFormat.formatSats(outgoing.amount, display: WalletCurrencySettings.denominationDisplay))")
                .font(.headline.monospacedDigit())
                .foregroundStyle(TaskifyTheme.primaryText)

            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .padding(14)
        .taskifyGlass(cornerRadius: 18)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the Cashu token")
    }
}

struct WalletLightningInvoiceRow: View {
    let quote: CashuLightningReceiveQuote

    private var mintName: String {
        URL(string: quote.mintURL)?.host() ?? quote.mintURL
    }

    private var status: String {
        switch quote.state {
        case .unpaid: "Pending"
        case .paid: "Payment found"
        case .pending: "Claiming payment"
        case .issued: "Received"
        case .expired: "Expired"
        }
    }

    private var statusColor: Color {
        switch quote.state {
        case .unpaid, .pending: TaskifyTheme.accent
        case .paid, .issued: .green
        case .expired: .orange
        }
    }

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: "bolt.fill")
                .font(.headline)
                .frame(width: 42, height: 42)
                .foregroundStyle(.yellow)
                .background(TaskifyTheme.raisedFill, in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text("Lightning")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(quote.createdAt, style: .relative)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }

                HStack(spacing: 5) {
                    Text(status)
                        .foregroundStyle(statusColor)
                    Text("•")
                    Text(mintName)
                        .lineLimit(1)
                }
                .font(.caption)

                if let expiresAt = quote.expiresAt, quote.state == .unpaid {
                    Text("Expires \(expiresAt, style: .relative)")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }

            Spacer(minLength: 8)

            Text("+\(WalletAmountFormat.formatSats(quote.amount, display: WalletCurrencySettings.denominationDisplay))")
                .font(.headline.monospacedDigit())
                .foregroundStyle(.green)

            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .padding(14)
        .taskifyGlass(cornerRadius: 18)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Pending Lightning invoice for \(quote.amount) sats, \(status)")
        .accessibilityHint("Opens the invoice")
    }
}

struct WalletTransactionDetailSheet: View {
    @ObservedObject var wallet: WalletViewModel
    private let initialTransaction: CashuTransactionSummary

    @Environment(\.dismiss) private var dismiss
    @State private var copiedField: CopiedField?
    @State private var isRefreshing = false
    @State private var statusError: String?

    init(wallet: WalletViewModel, transaction: CashuTransactionSummary) {
        self.wallet = wallet
        self.initialTransaction = transaction
    }

    private enum CopiedField {
        case cashuRequest
        case cashuToken
        case mint
        case reference
        case invoice
        case preimage
        case quote
    }

    private struct PaymentArtifact {
        let title: String
        let value: String
        let accessibilityLabel: String
        let systemImage: String
        let isBearerToken: Bool
        let copiedField: CopiedField
    }

    private var transaction: CashuTransactionSummary {
        wallet.snapshot.transactions.first(where: {
            $0.id == initialTransaction.id
                || (initialTransaction.quoteID != nil && $0.quoteID == initialTransaction.quoteID)
        }) ?? initialTransaction
    }

    private var amountDisplay: (primary: String, secondary: String?) {
        wallet.displayAmount(forSats: transaction.amount)
    }

    private var statusLabel: String {
        if let tokenStatus = transaction.outgoingTokenStatus {
            return switch tokenStatus {
            case .ready: "Ready to share"
            case .partiallyRedeemed: "Partially redeemed"
            case .redeemed: "Redeemed"
            case .reclaimed: "Reclaimed"
            }
        }
        return switch transaction.state {
        case .pending: "Pending"
        case .completed: "Completed"
        case .failed: "Failed"
        }
    }

    private var statusColor: Color {
        if let tokenStatus = transaction.outgoingTokenStatus {
            return switch tokenStatus {
            case .ready: TaskifyTheme.accent
            case .partiallyRedeemed: .orange
            case .redeemed: .green
            case .reclaimed: TaskifyTheme.secondaryText
            }
        }
        return switch transaction.state {
        case .pending: TaskifyTheme.accent
        case .completed: .green
        case .failed: .orange
        }
    }

    private var statusIcon: String {
        if let tokenStatus = transaction.outgoingTokenStatus {
            return switch tokenStatus {
            case .ready: "qrcode"
            case .partiallyRedeemed: "circle.lefthalf.filled"
            case .redeemed: "checkmark.circle.fill"
            case .reclaimed: "arrow.uturn.backward.circle.fill"
            }
        }
        return switch transaction.state {
        case .pending: "clock.fill"
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private var amountPrefix: String {
        if transaction.state == .failed { return "" }
        return isIncoming ? "+" : "−"
    }

    private var canRefreshStatus: Bool {
        if transaction.state == .pending { return true }
        return transaction.outgoingTokenStatus == .ready
            || transaction.outgoingTokenStatus == .partiallyRedeemed
    }

    private var isIncoming: Bool {
        transaction.direction == .incoming
    }

    private var directionLabel: String {
        if transaction.kind == .lightning {
            return isIncoming ? "Lightning received" : "Lightning payment"
        }
        if transaction.cashuPaymentRequest != nil { return "Cashu request paid" }
        return isIncoming ? "Received" : "Sent"
    }

    private var timeLabel: String {
        isIncoming ? "Time received" : "Time sent"
    }

    private var mintName: String {
        URL(string: transaction.mintURL)?.host() ?? transaction.mintURL
    }

    private var summaryIcon: String {
        transaction.kind == .lightning ? "bolt.fill" : (isIncoming ? "arrow.down" : "arrow.up")
    }

    private var paymentArtifacts: [PaymentArtifact] {
        var artifacts: [PaymentArtifact] = []
        if transaction.kind == .lightning,
           let invoice = transaction.paymentRequest?.trimmingCharacters(in: .whitespacesAndNewlines),
           !invoice.isEmpty {
            artifacts.append(PaymentArtifact(
                title: "Lightning invoice",
                value: invoice,
                accessibilityLabel: "Lightning invoice QR code",
                systemImage: "bolt.fill",
                isBearerToken: false,
                copiedField: .invoice
            ))
        }
        if transaction.kind == .ecash,
           let token = transaction.cashuToken?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty {
            artifacts.append(PaymentArtifact(
                title: "Cashu token",
                value: token,
                accessibilityLabel: "Cashu token QR code",
                systemImage: "banknote",
                isBearerToken: true,
                copiedField: .cashuToken
            ))
        }
        if let request = transaction.cashuPaymentRequest?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !request.isEmpty {
            artifacts.append(PaymentArtifact(
                title: "Cashu payment request",
                value: request,
                accessibilityLabel: "Cashu payment request QR code",
                systemImage: "qrcode",
                isBearerToken: false,
                copiedField: .cashuRequest
            ))
        }
        return artifacts
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 18) {
                        summaryCard
                        detailCard

                        ForEach(paymentArtifacts, id: \.title) { artifact in
                            paymentArtifactCard(artifact)
                        }

                        if let memo = transaction.memo?.trimmingCharacters(in: .whitespacesAndNewlines),
                           !memo.isEmpty {
                            memoCard(memo)
                        }

                        technicalDetails
                    }
                    .padding(20)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Transaction details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDragIndicator(.visible)
        .alert("Could not check status", isPresented: Binding(
            get: { statusError != nil },
            set: { if !$0 { statusError = nil } }
        )) {
            Button("OK", role: .cancel) { statusError = nil }
        } message: {
            Text(statusError ?? "")
        }
    }

    private var summaryCard: some View {
        VStack(spacing: 13) {
            Image(systemName: summaryIcon)
                .font(.system(size: 24, weight: .bold))
                .frame(width: 58, height: 58)
                .foregroundStyle(isIncoming ? Color.green : TaskifyTheme.primaryText)
                .taskifyGlassControl(in: Circle(), tint: isIncoming ? Color.green.opacity(0.16) : nil)

            Text(directionLabel)
                .font(.headline)
                .foregroundStyle(isIncoming ? Color.green : TaskifyTheme.primaryText)

            VStack(spacing: 2) {
                Text("\(amountPrefix)\(amountDisplay.primary)")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .monospacedDigit()
                if let secondary = amountDisplay.secondary {
                    Text(secondary)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            .foregroundStyle(TaskifyTheme.primaryText)

            Label(statusLabel, systemImage: statusIcon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(statusColor)

            if canRefreshStatus {
                Button {
                    Task {
                        isRefreshing = true
                        do {
                            if let outgoingTokenID = transaction.outgoingTokenID,
                               let outgoing = wallet.snapshot.outgoingTokens.first(where: {
                                   $0.id == outgoingTokenID
                               }) {
                                _ = try await wallet.checkOutgoingToken(outgoing)
                            } else {
                                await wallet.refresh()
                            }
                        } catch {
                            statusError = WalletViewModel.message(for: error)
                        }
                        isRefreshing = false
                    }
                } label: {
                    Label(isRefreshing ? "Checking…" : "Check status", systemImage: "arrow.clockwise")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 18)
                        .frame(height: 42)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isRefreshing)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
        .taskifyGlass(cornerRadius: 28)
    }

    private var detailCard: some View {
        VStack(spacing: 0) {
            WalletTransactionDetailRow(
                title: "Amount",
                value: amountDisplay.primary,
                secondaryValue: amountDisplay.secondary
            )

            Divider().overlay(TaskifyTheme.border)

            WalletTransactionDetailRow(
                title: "Status",
                value: statusLabel
            )

            if let spent = transaction.tokenSpentProofCount,
               let total = transaction.tokenProofCount,
               total > 0 {
                Divider().overlay(TaskifyTheme.border)
                WalletTransactionDetailRow(
                    title: "Proofs redeemed",
                    value: "\(spent) of \(total)"
                )
            }

            Divider().overlay(TaskifyTheme.border)

            WalletTransactionDetailRow(
                title: "Type",
                value: transaction.kind == .lightning
                    ? "Lightning"
                    : (transaction.cashuPaymentRequest == nil ? "Cashu token" : "Cashu payment request")
            )

            if transaction.fee > 0 {
                Divider().overlay(TaskifyTheme.border)
                WalletTransactionDetailRow(
                    title: "Fee paid",
                    value: wallet.formattedSats(transaction.fee)
                )
            }

            Divider().overlay(TaskifyTheme.border)

            WalletTransactionDetailRow(
                title: timeLabel,
                value: transaction.date.formatted(date: .abbreviated, time: .standard)
            )

            Divider().overlay(TaskifyTheme.border)

            WalletTransactionDetailRow(
                title: "Mint",
                value: mintName
            )
        }
        .padding(.horizontal, 16)
        .taskifyGlass(cornerRadius: 24)
    }

    private func memoCard(_ memo: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Note", systemImage: "text.alignleft")
                .font(.caption.bold())
                .foregroundStyle(TaskifyTheme.accent)
            Text(memo)
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.primaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(17)
        .taskifyGlass(cornerRadius: 22)
    }

    private func paymentArtifactCard(_ artifact: PaymentArtifact) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(artifact.title, systemImage: artifact.systemImage)
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)

            CashuQRCodeView(value: artifact.value, accessibilityLabel: artifact.accessibilityLabel)
                .frame(maxWidth: 240)
                .padding(14)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: .infinity)

            HStack(spacing: 12) {
                Button {
                    copy(artifact.value, field: artifact.copiedField)
                } label: {
                    Label(
                        copiedField == artifact.copiedField ? "Copied" : "Copy",
                        systemImage: copiedField == artifact.copiedField ? "checkmark" : "doc.on.doc"
                    )
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)

                ShareLink(item: artifact.value) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .foregroundStyle(TaskifyTheme.primaryText)

            if artifact.isBearerToken,
               isIncoming
                    || transaction.outgoingTokenStatus == .redeemed
                    || transaction.outgoingTokenStatus == .reclaimed {
                Text("This historical token is no longer spendable.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            } else if artifact.isBearerToken {
                Label(
                    "Cashu tokens are bearer money. Share this token only when you intend to give it to someone.",
                    systemImage: "exclamationmark.shield"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            } else {
                Text(transaction.cashuPaymentRequest == nil
                    ? "This is the original invoice saved with the transaction."
                    : "This is the original Cashu request saved with the transaction.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }
        }
        .padding(17)
        .taskifyGlass(cornerRadius: 24)
    }

    private var technicalDetails: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("TRANSACTION INFORMATION")
                .font(.caption.bold())
                .tracking(1.1)
                .foregroundStyle(TaskifyTheme.accent)

            CopyableTransactionField(
                title: "Mint URL",
                value: transaction.mintURL,
                copied: copiedField == .mint
            ) {
                copy(transaction.mintURL, field: .mint)
            }

            CopyableTransactionField(
                title: "Transaction reference",
                value: transaction.id,
                copied: copiedField == .reference
            ) {
                copy(transaction.id, field: .reference)
            }

            if let quoteID = transaction.quoteID, !quoteID.isEmpty {
                CopyableTransactionField(
                    title: "Mint quote reference",
                    value: quoteID,
                    copied: copiedField == .quote
                ) {
                    copy(quoteID, field: .quote)
                }
            }

            if let invoice = transaction.paymentRequest, !invoice.isEmpty {
                CopyableTransactionField(
                    title: "Lightning invoice",
                    value: invoice,
                    copied: copiedField == .invoice
                ) {
                    copy(invoice, field: .invoice)
                }
            }

            if let request = transaction.cashuPaymentRequest, !request.isEmpty {
                CopyableTransactionField(
                    title: "Cashu payment request",
                    value: request,
                    copied: copiedField == .cashuRequest
                ) {
                    copy(request, field: .cashuRequest)
                }
            }

            if let preimage = transaction.paymentProof, !preimage.isEmpty {
                CopyableTransactionField(
                    title: "Payment proof",
                    value: preimage,
                    copied: copiedField == .preimage
                ) {
                    copy(preimage, field: .preimage)
                }
            }

            Label(
                "The transaction reference identifies this local Cashu wallet operation. It does not reveal your wallet recovery phrase.",
                systemImage: "lock.shield"
            )
            .font(.caption)
            .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }

    private func copy(_ value: String, field: CopiedField) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: value]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)]
        )
        copiedField = field
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

struct WalletTransactionDetailRow: View {
    let title: String
    let value: String
    var secondaryValue: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title)
                .foregroundStyle(TaskifyTheme.secondaryText)
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 2) {
                Text(value)
                    .foregroundStyle(TaskifyTheme.primaryText)
                if let secondaryValue {
                    Text(secondaryValue)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(.vertical, 14)
    }
}

struct CopyableTransactionField: View {
    let title: String
    let value: String
    let copied: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.secondaryText)
                    Text(value)
                        .font(.caption.monospaced())
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 8)

                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(copied ? Color.green : TaskifyTheme.accent)
                    .frame(width: 38, height: 38)
                    .taskifyGlassControl(in: Circle())
            }
            .padding(15)
            .taskifyGlass(cornerRadius: 20)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy \(title)")
    }
}

struct WalletTransactionRow: View {
    let transaction: CashuTransactionSummary

    private var isIncoming: Bool { transaction.direction == .incoming }

    private var typeLabel: String {
        transaction.kind == .lightning ? "Lightning" : "Ecash"
    }

    private var mintName: String {
        URL(string: transaction.mintURL)?.host() ?? transaction.mintURL
    }

    private var statusLabel: String {
        if let tokenStatus = transaction.outgoingTokenStatus {
            return switch tokenStatus {
            case .ready: "Ready to share"
            case .partiallyRedeemed: "Partially redeemed"
            case .redeemed: "Redeemed"
            case .reclaimed: "Reclaimed"
            }
        }
        return switch transaction.state {
        case .pending: "Pending"
        case .completed: isIncoming ? "Received" : "Sent"
        case .failed: "Failed"
        }
    }

    private var statusColor: Color {
        if let tokenStatus = transaction.outgoingTokenStatus {
            return switch tokenStatus {
            case .ready: TaskifyTheme.accent
            case .partiallyRedeemed: .orange
            case .redeemed: .green
            case .reclaimed: TaskifyTheme.secondaryText
            }
        }
        return switch transaction.state {
        case .pending: TaskifyTheme.accent
        case .completed: isIncoming ? .green : TaskifyTheme.secondaryText
        case .failed: .orange
        }
    }

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: transaction.kind == .lightning
                ? "bolt.fill"
                : (transaction.cashuPaymentRequest == nil ? (isIncoming ? "arrow.down" : "arrow.up") : "qrcode"))
                .font(.headline)
                .frame(width: 42, height: 42)
                .foregroundStyle(transaction.kind == .lightning ? Color.yellow : (isIncoming ? Color.green : TaskifyTheme.primaryText))
                .background(TaskifyTheme.raisedFill, in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(typeLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(transaction.date, style: .relative)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }
                HStack(spacing: 5) {
                    Text(statusLabel)
                        .foregroundStyle(statusColor)
                    Text("•")
                    Text(mintName)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }
                .font(.caption)
            }

            Spacer()

            Text("\(transaction.state == .failed ? "" : (isIncoming ? "+" : "−"))\(WalletAmountFormat.formatSats(transaction.amount, display: WalletCurrencySettings.denominationDisplay))")
                .font(.headline.monospacedDigit())
                .foregroundStyle(
                    transaction.state == .failed
                        ? TaskifyTheme.secondaryText
                        : (isIncoming ? Color.green : TaskifyTheme.primaryText)
                )

            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .padding(14)
        .taskifyGlass(cornerRadius: 18)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens transaction details")
    }
}

struct OutgoingTokenSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    let outgoing: CashuOutgoingToken
    @State private var localError: String?
    @State private var confirmingReclaim = false

    private var currentOutgoing: CashuOutgoingToken {
        wallet.snapshot.outgoingTokens.first(where: { $0.id == outgoing.id }) ?? outgoing
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    OutgoingTokenContent(
                        outgoing: currentOutgoing,
                        checkAction: {
                            Task {
                                do { _ = try await wallet.checkOutgoingToken(currentOutgoing) }
                                catch { localError = WalletViewModel.message(for: error) }
                            }
                        },
                        reclaimAction: { confirmingReclaim = true }
                    )
                    .padding(22)
                }
            }
            .navigationTitle("Ecash token")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Reclaim this token?", isPresented: $confirmingReclaim) {
                Button("Reclaim ecash") {
                    Task {
                        do {
                            _ = try await wallet.reclaim(currentOutgoing)
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
            .alert("Outgoing token", isPresented: Binding(
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

struct OutgoingTokenContent: View {
    let outgoing: CashuOutgoingToken
    let checkAction: () -> Void
    let reclaimAction: () -> Void
    @State private var copied = false

    private var isSpendable: Bool {
        outgoing.status == .ready || outgoing.status == .partiallyRedeemed
    }

    private var statusLabel: String {
        switch outgoing.status {
        case .ready: "Ready to share"
        case .partiallyRedeemed: "Partially redeemed"
        case .redeemed: "Redeemed"
        case .reclaimed: "Reclaimed"
        }
    }

    private var statusColor: Color {
        switch outgoing.status {
        case .ready: TaskifyTheme.accent
        case .partiallyRedeemed: .orange
        case .redeemed: .green
        case .reclaimed: TaskifyTheme.secondaryText
        }
    }

    var body: some View {
        VStack(spacing: 18) {
            Text("\(WalletAmountFormat.formatSats(outgoing.amount, display: WalletCurrencySettings.denominationDisplay))")
                .font(.system(size: 38, weight: .bold, design: .rounded))
                .foregroundStyle(TaskifyTheme.primaryText)

            Label(statusLabel, systemImage: outgoing.status == .redeemed ? "checkmark.circle.fill" : "qrcode")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(statusColor)

            CashuQRCodeView(value: outgoing.token)
                .frame(maxWidth: 300)
                .padding(16)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 24, style: .continuous))

            Text(isSpendable
                ? "The recipient can scan this code or redeem the copied Cashu token."
                : "This historical token is no longer spendable.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.secondaryText)

            if outgoing.status == .ready {
                HStack(spacing: 12) {
                Button {
                    UIPasteboard.general.string = outgoing.token
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.72))
                }
                .buttonStyle(.plain)

                ShareLink(item: outgoing.token) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
                }
            }

            if isSpendable {
                Button(action: checkAction) {
                    Label("Check redemption status", systemImage: "arrow.clockwise")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Capsule())
                }
                .buttonStyle(.plain)
            }

            if isSpendable {
                Button("Reclaim unredeemed token", action: reclaimAction)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
            }

            if let spent = outgoing.spentProofCount,
               let total = outgoing.proofCount,
               total > 0 {
                Text("\(spent) of \(total) proofs redeemed")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            Text(outgoing.mintURL)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }
}

#endif
