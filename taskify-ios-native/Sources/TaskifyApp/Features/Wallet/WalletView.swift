import CoreImage
import CoreImage.CIFilterBuiltins
import LocalAuthentication
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers
import VisionKit

enum WalletRecoveryMode: Equatable {
    case transfer
    case rescan
    case replace
}

struct WalletMintRecoveryOutcome: Equatable {
    let mintURL: String
    let found: UInt64
    let deposited: UInt64
    let spent: UInt64
    let pending: UInt64
    let errorMessage: String?

    var fee: UInt64 { found > deposited ? found - deposited : 0 }
    var succeeded: Bool { errorMessage == nil }
}

struct WalletRestoreOutcome: Equatable {
    let mode: WalletRecoveryMode
    let mints: [WalletMintRecoveryOutcome]

    var recovered: UInt64 { mints.reduce(0) { $0 + $1.deposited } }
    var found: UInt64 { mints.reduce(0) { $0 + $1.found } }
    var spent: UInt64 { mints.reduce(0) { $0 + $1.spent } }
    var pending: UInt64 { mints.reduce(0) { $0 + $1.pending } }
    var fees: UInt64 { mints.reduce(0) { $0 + $1.fee } }
    var failures: [WalletMintRecoveryOutcome] { mints.filter { !$0.succeeded } }
}

@MainActor
final class WalletViewModel: ObservableObject {
    static let suggestedMintURL = "https://mint.solife.me"

    @Published private(set) var snapshot = CashuWalletSnapshot.empty
    @Published private(set) var isLoading = false
    @Published private(set) var isWorking = false
    @Published var errorMessage: String?
    @Published var statusMessage: String?
    @Published private(set) var activeMintURL: String
    @Published private(set) var lightningReceiveQuotes: [CashuLightningReceiveQuote] = []
    @Published private(set) var pendingEcashReceives: [CashuPendingReceive] = []
    @Published private(set) var createdPaymentRequests: [CashuCreatedPaymentRequest] = []

    private var service: CashuWalletService?
    private var hasStarted = false
    private var isAppActive = true
    private var lightningMonitorTask: Task<Void, Never>?
    private var paymentInboxTask: Task<Void, Never>?
    private var paymentInboxNeedsAnotherPass = false
    private var isRecoveringPaymentInbox = false
    private var announcedLightningQuoteIDs: Set<String> = []
    private let paymentNotificationCoordinator = WalletPaymentNotificationCoordinator()
    private let activeMintKey = "taskify.wallet.active-mint"

    init() {
        activeMintURL = UserDefaults.standard.string(forKey: activeMintKey) ?? ""
    }

    var activeMint: CashuMintSummary? {
        snapshot.mints.first { $0.url == activeMintURL } ?? snapshot.mints.first
    }

    var activeLightningReceiveQuotes: [CashuLightningReceiveQuote] {
        lightningReceiveQuotes
            .filter { $0.isOutstanding() }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var hasOutstandingLightningInvoices: Bool {
        !activeLightningReceiveQuotes.isEmpty
    }

    var recoverablePendingEcashReceives: [CashuPendingReceive] {
        pendingEcashReceives.filter(\.isRecoverable)
    }

    func start(recoverLightningReceives: Bool = true) async {
        guard !hasStarted else {
            while isLoading && service == nil {
                try? await Task.sleep(for: .milliseconds(50))
            }
            await refresh()
            startLightningMonitoring()
            return
        }
        hasStarted = true
        isLoading = true
        defer { isLoading = false }

        do {
            let mnemonic = try KeychainWalletSeedStore().loadOrCreate()
            let service = try makeService(mnemonic: mnemonic, migrateLegacyFiles: true)
            self.service = service
            await service.recoverInterruptedOperations()
            await refresh()
            announcedLightningQuoteIDs = Set(
                lightningReceiveQuotes.lazy.filter { $0.state == .issued }.map(\.id)
            )
            await recoverPendingEcashReceives(force: true)
            await recoverNostrPaymentRequests()
            if recoverLightningReceives {
                await recoverPendingLightningReceives()
            }
            startLightningMonitoring()
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func refresh() async {
        guard let service else { return }
        await service.refreshPendingLightningPayments()
        await service.refreshOutgoingTokenStates()
        snapshot = await service.snapshot()
        if let quotes = try? await service.trackedLightningReceiveQuotes() {
            lightningReceiveQuotes = quotes
        }
        pendingEcashReceives = await service.savedPendingReceives()
        createdPaymentRequests = await service.savedCreatedPaymentRequests()
        repairActiveMintSelection()
    }

    func appDidBecomeActive() {
        isAppActive = true
        guard hasStarted else { return }
        if hasOutstandingLightningInvoices {
            Task { await paymentNotificationCoordinator.requestAuthorizationIfNeeded() }
        }
        restartLightningMonitoring()
        Task {
            await service?.recoverInterruptedOperations()
            await recoverPendingEcashReceives(force: true)
            await recoverNostrPaymentRequests()
            await refresh()
        }
    }

    func appDidEnterBackground() {
        isAppActive = false
        lightningMonitorTask?.cancel()
        lightningMonitorTask = nil
    }

    func performBackgroundLightningRefresh() async -> Bool {
        appDidEnterBackground()
        if !hasStarted {
            await start(recoverLightningReceives: false)
        }
        guard service != nil else { return false }

        let newlyIssued = await recoverPendingLightningReceives(
            presentInApp: false
        )
        let recoveredEcash = await recoverPendingEcashReceives(
            force: true,
            presentInApp: false
        )
        let paymentRequestReceipts = await recoverNostrPaymentRequests(presentInApp: false)
        await service?.refreshPendingLightningPayments(force: true)
        if let service {
            snapshot = await service.snapshot()
        }
        await paymentNotificationCoordinator.notifyPayments(newlyIssued)
        await paymentNotificationCoordinator.notifyEcashReceipts(recoveredEcash)
        await paymentNotificationCoordinator.notifyCashuRequestReceipts(paymentRequestReceipts)
        return true
    }

    func paymentDeliveryWasQueued() {
        guard hasStarted else { return }
        paymentInboxNeedsAnotherPass = true
        guard paymentInboxTask == nil else { return }
        paymentInboxTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.paymentInboxNeedsAnotherPass = false
                _ = await self.recoverNostrPaymentRequests(presentInApp: self.isAppActive)
            } while self.paymentInboxNeedsAnotherPass && !Task.isCancelled
            self.paymentInboxTask = nil
        }
    }

    func createPaymentRequest(
        amount: UInt64?,
        description: String?,
        mintURLs: [String],
        recipientPublicKey: String,
        relayURLs: [String],
        singleUse: Bool
    ) async throws -> CashuCreatedPaymentRequest {
        guard let service else { throw CashuWalletError.paymentRequestNotFound }
        isWorking = true
        defer { isWorking = false }
        let request = try await service.createNostrPaymentRequest(
            amount: amount,
            description: description,
            mintURLs: mintURLs,
            recipientPublicKey: recipientPublicKey,
            relayURLs: relayURLs,
            singleUse: singleUse
        )
        await paymentNotificationCoordinator.requestAuthorizationIfNeeded()
        createdPaymentRequests = await service.savedCreatedPaymentRequests()
        return request
    }

    func cancelPaymentRequest(_ request: CashuCreatedPaymentRequest) async throws {
        guard let service else { throw CashuWalletError.paymentRequestNotFound }
        isWorking = true
        defer { isWorking = false }
        try await service.cancelCreatedPaymentRequest(id: request.requestID)
        createdPaymentRequests = await service.savedCreatedPaymentRequests()
    }

    @discardableResult
    func performBackgroundPaymentRequestRefresh() async -> Bool {
        guard service != nil else { return false }
        let receipts = await recoverNostrPaymentRequests(presentInApp: false)
        await paymentNotificationCoordinator.notifyCashuRequestReceipts(receipts)
        return true
    }

    func selectMint(_ mintURL: String) {
        activeMintURL = mintURL
        UserDefaults.standard.set(mintURL, forKey: activeMintKey)
    }

    func addMint(_ mintURL: String) async throws {
        guard let service else { return }
        isWorking = true
        defer { isWorking = false }
        try await service.addMint(mintURL)
        let normalized = try CashuWalletService.normalizedMintURL(mintURL)
        selectMint(normalized)
        await refresh()
        statusMessage = "Mint added"
    }

    func removeMint(_ mintURL: String) async throws {
        guard let service else { return }
        isWorking = true
        defer { isWorking = false }
        try await service.removeMint(mintURL)
        await refresh()
        statusMessage = "Mint removed"
    }

    func previewToken(_ token: String) async throws -> CashuTokenPreview {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        return try await service.previewToken(token)
    }

    func previewPaymentRequest(_ value: String) throws -> CashuPaymentRequestPreview {
        try CashuWalletService.previewPaymentRequest(value)
    }

    func payPaymentRequest(
        _ preview: CashuPaymentRequestPreview,
        mintURL: String,
        customAmount: UInt64?
    ) async throws -> CashuPaymentRequestPaymentResult {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await service.payPaymentRequest(
                preview.encoded,
                mintURL: mintURL,
                customAmount: customAmount
            )
            await refresh()
            statusMessage = "Paid \(result.amount.formatted()) sats to Cashu request"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return result
        } catch {
            await refresh()
            throw error
        }
    }

    func submitReceive(_ token: String) async throws -> CashuReceiveSubmissionResult {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        isWorking = true
        defer { isWorking = false }
        let result: CashuReceiveSubmissionResult
        do {
            result = try await service.submitReceive(token)
        } catch {
            await refresh()
            throw error
        }
        await refresh()
        switch result {
        case .received(let amount):
            statusMessage = "Received \(amount.formatted()) sats"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .queued:
            await paymentNotificationCoordinator.requestAuthorizationIfNeeded()
            statusMessage = "Ecash saved — Taskify will retry automatically"
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
        return result
    }

    func retryPendingReceive(_ pending: CashuPendingReceive) async throws -> UInt64 {
        guard let service else { throw CashuWalletError.pendingReceiveMissing }
        isWorking = true
        defer { isWorking = false }
        let amount: UInt64
        do {
            amount = try await service.redeemPendingReceive(id: pending.id)
        } catch {
            await refresh()
            throw error
        }
        await refresh()
        statusMessage = "Received \(amount.formatted()) sats"
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        return amount
    }

    func discardPendingReceive(_ pending: CashuPendingReceive) async throws {
        guard let service else { throw CashuWalletError.pendingReceiveMissing }
        try await service.discardPendingReceive(id: pending.id)
        await refresh()
    }

    func latestLightningReceiveQuote(
        mintURL: String? = nil
    ) async throws -> CashuLightningReceiveQuote? {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        return try await service.latestLightningReceiveQuote(mintURL: mintURL)
    }

    func createLightningReceiveQuote(
        mintURL: String,
        amount: UInt64
    ) async throws -> CashuLightningReceiveQuote {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        isWorking = true
        defer { isWorking = false }
        let quote = try await service.createLightningReceiveQuote(
            mintURL: mintURL,
            amount: amount
        )
        await paymentNotificationCoordinator.requestAuthorizationIfNeeded()
        await refreshLightningReceiveQuotes()
        restartLightningMonitoring()
        return quote
    }

    func checkLightningReceiveQuote(
        id: String
    ) async throws -> CashuLightningReceiveQuote {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        let quote = try await service.checkAndClaimLightningReceiveQuote(id: id)
        await refreshLightningReceiveQuotes()
        if quote.state == .issued {
            await announceNewlyIssuedLightningQuotes([quote])
        }
        return quote
    }

    private func startLightningMonitoring() {
        guard isAppActive, service != nil, lightningMonitorTask == nil else { return }
        lightningMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let hasOutstandingInvoices = self.hasOutstandingLightningInvoices
                let hasPendingEcash = !self.recoverablePendingEcashReceives.isEmpty
                if hasOutstandingInvoices {
                    await self.recoverPendingLightningReceives()
                }
                if hasPendingEcash {
                    await self.recoverPendingEcashReceives()
                }
                do {
                    try await Task.sleep(
                        for: .seconds(hasOutstandingInvoices ? 4 : (hasPendingEcash ? 15 : 30))
                    )
                } catch {
                    return
                }
            }
        }
    }

    private func restartLightningMonitoring() {
        lightningMonitorTask?.cancel()
        lightningMonitorTask = nil
        startLightningMonitoring()
    }

    @discardableResult
    private func recoverPendingLightningReceives(
        presentInApp: Bool = true
    ) async -> [CashuLightningReceiveQuote] {
        guard let service else { return [] }
        let checkedQuotes = await service.recoverPendingLightningReceives()
        await refreshLightningReceiveQuotes()
        return await announceNewlyIssuedLightningQuotes(
            checkedQuotes,
            presentInApp: presentInApp
        )
    }

    private func refreshLightningReceiveQuotes() async {
        guard let service,
              let quotes = try? await service.trackedLightningReceiveQuotes() else { return }
        lightningReceiveQuotes = quotes
    }

    @discardableResult
    private func recoverPendingEcashReceives(
        force: Bool = false,
        presentInApp: Bool = true
    ) async -> [CashuRecoveredReceive] {
        guard let service else { return [] }
        let recovered = await service.recoverPendingReceives(force: force)
        pendingEcashReceives = await service.savedPendingReceives()
        guard !recovered.isEmpty else { return [] }
        await refresh()
        guard presentInApp else { return recovered }

        let total = recovered.reduce(UInt64(0)) { $0 + $1.receivedAmount }
        statusMessage = recovered.count == 1
            ? "Received \(total.formatted()) sats from saved ecash"
            : "Received \(total.formatted()) sats from \(recovered.count) saved tokens"
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        return recovered
    }

    @discardableResult
    private func recoverNostrPaymentRequests(
        presentInApp: Bool = true
    ) async -> [CashuPaymentRequestReceipt] {
        guard !isRecoveringPaymentInbox else {
            paymentInboxNeedsAnotherPass = true
            return []
        }
        isRecoveringPaymentInbox = true
        defer { isRecoveringPaymentInbox = false }
        guard let service,
              let inboxURL = try? CashuNostrPaymentInboxStore.defaultURL() else { return [] }
        let deliveries = CashuNostrPaymentInboxStore.load(from: inboxURL)
        guard !deliveries.isEmpty else {
            createdPaymentRequests = await service.savedCreatedPaymentRequests()
            return []
        }

        var completedEventIDs = Set<String>()
        var receipts: [CashuPaymentRequestReceipt] = []
        for delivery in deliveries {
            guard !Task.isCancelled else { break }
            do {
                let receipt = try await service.receiveNostrPayment(delivery)
                receipts.append(receipt)
                completedEventIDs.insert(delivery.eventID)
            } catch let error as CashuWalletError where Self.isTerminalPaymentDeliveryError(error) {
                completedEventIDs.insert(delivery.eventID)
            } catch {
                // Keep transient mint/network failures in the durable inbox.
            }
        }
        if !completedEventIDs.isEmpty {
            try? CashuNostrPaymentInboxStore.remove(eventIDs: completedEventIDs, at: inboxURL)
        }
        guard !receipts.isEmpty else {
            createdPaymentRequests = await service.savedCreatedPaymentRequests()
            return []
        }

        await refresh()
        if presentInApp {
            let total = receipts.reduce(UInt64(0)) { $0 + $1.amount }
            statusMessage = receipts.count == 1
                ? "Received \(total.formatted()) sats from a Cashu request"
                : "Received \(total.formatted()) sats from \(receipts.count) Cashu payments"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
        return receipts
    }

    private static func isTerminalPaymentDeliveryError(_ error: CashuWalletError) -> Bool {
        switch error {
        case .invalidPaymentRequest,
             .unsupportedUnit,
             .paymentRequestNotFound,
             .paymentRequestAlreadyCompleted,
             .paymentRequestAlreadyProcessed,
             .paymentRequestAmountMismatch,
             .paymentRequestMintUnavailable:
            true
        default:
            false
        }
    }

    @discardableResult
    private func announceNewlyIssuedLightningQuotes(
        _ quotes: [CashuLightningReceiveQuote],
        presentInApp: Bool = true
    ) async -> [CashuLightningReceiveQuote] {
        var newlyIssued: [CashuLightningReceiveQuote] = []
        for quote in quotes where quote.state == .issued {
            if announcedLightningQuoteIDs.insert(quote.id).inserted {
                newlyIssued.append(quote)
            }
        }
        guard !newlyIssued.isEmpty else { return [] }

        await refresh()
        guard presentInApp else { return newlyIssued }
        let total = newlyIssued.reduce(UInt64(0)) { partial, quote in
            partial + (quote.issuedAmount > 0 ? quote.issuedAmount : quote.amount)
        }
        if newlyIssued.count == 1 {
            statusMessage = "Received \(total.formatted()) sats over Lightning"
        } else {
            statusMessage = "Received \(total.formatted()) sats from \(newlyIssued.count) Lightning invoices"
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        return newlyIssued
    }

    func prepareSend(mintURL: String, amount: UInt64) async throws -> CashuPreparedSendQuote {
        guard let service else { throw CashuWalletError.preparedSendMissing }
        isWorking = true
        defer { isWorking = false }
        return try await service.prepareSend(mintURL: mintURL, amount: amount)
    }

    func confirmSend(_ quote: CashuPreparedSendQuote, memo: String?) async throws -> CashuOutgoingToken {
        guard let service else { throw CashuWalletError.preparedSendMissing }
        isWorking = true
        defer { isWorking = false }
        let outgoing = try await service.confirmPreparedSend(id: quote.id, memo: memo)
        await refresh()
        return outgoing
    }

    func cancelPreparedSend(_ quote: CashuPreparedSendQuote) async {
        await service?.cancelPreparedSend(id: quote.id)
        await refresh()
    }

    func prepareLightningPayment(
        mintURL: String,
        invoice: String,
        amount: UInt64?
    ) async throws -> CashuLightningPaymentQuote {
        guard let service else { throw CashuWalletError.lightningPaymentMissing }
        isWorking = true
        defer { isWorking = false }
        return try await service.prepareLightningPayment(
            mintURL: mintURL,
            invoice: invoice,
            amount: amount
        )
    }

    func cancelLightningPayment(_ quote: CashuLightningPaymentQuote) async {
        await service?.cancelLightningPayment(id: quote.id)
        await refresh()
    }

    func confirmLightningPayment(
        _ quote: CashuLightningPaymentQuote
    ) async throws -> CashuLightningPaymentResult {
        guard let service else { throw CashuWalletError.lightningPaymentMissing }
        isWorking = true
        defer { isWorking = false }
        let result = try await service.confirmLightningPayment(id: quote.id)
        await refresh()
        if result.state == .completed {
            statusMessage = "Paid \(result.amount.formatted()) sats over Lightning"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            statusMessage = "Lightning payment is processing"
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
        return result
    }

    func transferBetweenMints(
        amount: UInt64,
        sourceMintURL: String,
        destinationMintURL: String
    ) async throws -> CashuMintTransferResult {
        guard let service else { throw CashuWalletError.lightningPaymentMissing }
        isWorking = true
        defer { isWorking = false }

        let result = try await service.transferBetweenMints(
            amount: amount,
            from: sourceMintURL,
            to: destinationMintURL
        )
        await refreshLightningReceiveQuotes()
        await refresh()
        restartLightningMonitoring()

        if result.state == .completed {
            statusMessage = "Moved \(result.receivedAmount.formatted()) sats between mints"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            statusMessage = "Mint transfer is finishing in the background"
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
        return result
    }

    func reclaim(_ outgoing: CashuOutgoingToken) async throws -> UInt64 {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        isWorking = true
        defer { isWorking = false }
        let amount = try await service.reclaimOutgoingToken(id: outgoing.id)
        await refresh()
        statusMessage = "Reclaimed \(amount.formatted()) sats"
        return amount
    }

    func checkOutgoingToken(_ outgoing: CashuOutgoingToken) async throws -> CashuOutgoingToken {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        isWorking = true
        defer { isWorking = false }
        let checked = try await service.checkOutgoingTokenState(id: outgoing.id)
        snapshot = await service.snapshot()
        return checked
    }

    func recoveryPhrase() async throws -> String {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        return await service.recoveryPhrase()
    }

    func recoveryBackupJSON() async throws -> String {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        return try await service.seedBackupJSON()
    }

    func parseRecoveryMaterial(_ value: String) throws -> CashuRecoveryMaterial {
        try CashuWalletService.parseRecoveryMaterial(value)
    }

    func transferFromSeed(
        material: CashuRecoveryMaterial,
        additionalMintURLs: [String]
    ) async throws -> WalletRestoreOutcome {
        guard let currentService = service else { throw CashuWalletError.outgoingTokenMissing }

        let currentPhrase = await currentService.recoveryPhrase()
        let isCurrentWallet = currentPhrase == material.mnemonic
        let requestedMints = material.mintURLs
            + additionalMintURLs
            + snapshot.mints.map(\.url)
            + [Self.suggestedMintURL]
        let mintURLs = try normalizedUniqueMintURLs(requestedMints)

        isWorking = true
        defer { isWorking = false }

        let candidate = isCurrentWallet
            ? currentService
            : try makeService(mnemonic: material.mnemonic, migrateLegacyFiles: false)
        var results: [WalletMintRecoveryOutcome] = []
        var firstError: Error?
        for mintURL in mintURLs {
            do {
                let restored = try await candidate.restoreMint(mintURL)
                if isCurrentWallet {
                    results.append(WalletMintRecoveryOutcome(
                        mintURL: mintURL,
                        found: restored.unspent,
                        deposited: restored.unspent,
                        spent: restored.spent,
                        pending: restored.pending,
                        errorMessage: nil
                    ))
                } else {
                    let transferred = try await candidate.transferRestoredBalance(
                        fromMint: mintURL,
                        into: currentService
                    )
                    results.append(WalletMintRecoveryOutcome(
                        mintURL: mintURL,
                        found: transferred.recovered,
                        deposited: transferred.deposited,
                        spent: restored.spent,
                        pending: transferred.pending,
                        errorMessage: nil
                    ))
                }
            } catch {
                firstError = firstError ?? error
                results.append(WalletMintRecoveryOutcome(
                    mintURL: mintURL,
                    found: 0,
                    deposited: 0,
                    spent: 0,
                    pending: 0,
                    errorMessage: Self.message(for: error)
                ))
            }
        }
        await candidate.recoverInterruptedOperations()
        await currentService.recoverInterruptedOperations()
        await refresh()
        if results.allSatisfy({ !$0.succeeded }), let firstError { throw firstError }

        let outcome = WalletRestoreOutcome(
            mode: isCurrentWallet ? .rescan : .transfer,
            mints: results
        )
        statusMessage = switch outcome.mode {
        case .transfer where outcome.recovered > 0:
            "Transferred \(outcome.recovered.formatted()) sats into Taskify"
        case .transfer:
            "Seed scan complete"
        case .rescan where outcome.recovered > 0:
            "Recovered \(outcome.recovered.formatted()) sats"
        case .rescan:
            "Wallet rescan complete"
        case .replace:
            "Wallet seed replaced"
        }
        return outcome
    }

    func replaceWalletSeed(
        material: CashuRecoveryMaterial,
        additionalMintURLs: [String]
    ) async throws -> WalletRestoreOutcome {
        guard let currentService = service else { throw CashuWalletError.outgoingTokenMissing }

        let currentPhrase = await currentService.recoveryPhrase()
        let isCurrentWallet = currentPhrase == material.mnemonic
        if !isCurrentWallet {
            let hasTrackedTokens = snapshot.outgoingTokens.contains {
                $0.status == .ready || $0.status == .partiallyRedeemed
            }
            guard
                snapshot.available == 0,
                snapshot.pending == 0,
                snapshot.reserved == 0,
                !hasTrackedTokens
            else {
                throw CashuWalletError.walletReplacementBlocked
            }
        }

        let requestedMints = material.mintURLs
            + additionalMintURLs
            + snapshot.mints.map(\.url)
            + [Self.suggestedMintURL]
        let mintURLs = try normalizedUniqueMintURLs(requestedMints)

        isWorking = true
        defer { isWorking = false }

        let candidate = isCurrentWallet
            ? currentService
            : try makeService(mnemonic: material.mnemonic, migrateLegacyFiles: false)
        var results: [WalletMintRecoveryOutcome] = []
        for mintURL in mintURLs {
            let restored = try await candidate.restoreMint(mintURL)
            results.append(WalletMintRecoveryOutcome(
                mintURL: mintURL,
                found: restored.unspent,
                deposited: restored.unspent,
                spent: restored.spent,
                pending: restored.pending,
                errorMessage: nil
            ))
        }
        await candidate.recoverInterruptedOperations()

        if !isCurrentWallet {
            // The Keychain switch is the commit point. Until every selected mint
            // restores successfully, the currently active wallet stays untouched.
            try KeychainWalletSeedStore().save(material.mnemonic)
            service = candidate
            UserDefaults.standard.removeObject(forKey: activeMintKey)
            activeMintURL = ""
        }

        await refresh()
        let outcome = WalletRestoreOutcome(
            mode: isCurrentWallet ? .rescan : .replace,
            mints: results
        )
        statusMessage = outcome.recovered > 0
            ? "Recovered \(outcome.recovered.formatted()) sats"
            : "Wallet seed replaced"
        return outcome
    }

    private func makeService(mnemonic: String, migrateLegacyFiles: Bool) throws -> CashuWalletService {
        let directory = try walletDirectory()
        let identifier = try CashuWalletService.walletIdentifier(for: mnemonic)
        let databaseURL = directory.appendingPathComponent("cashu-\(identifier).sqlite")
        let outgoingURL = directory.appendingPathComponent("outgoing-\(identifier).json")
        if migrateLegacyFiles {
            try migrateLegacyWalletFiles(
                directory: directory,
                databaseURL: databaseURL,
                outgoingURL: outgoingURL
            )
        }
        return try CashuWalletService(
            databaseURL: databaseURL,
            outgoingTokensURL: outgoingURL,
            mnemonic: mnemonic
        )
    }

    private func walletDirectory() throws -> URL {
        let directory = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
            .appendingPathComponent("TaskifyNative", isDirectory: true)
            .appendingPathComponent("Wallet", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        return directory
    }

    private func migrateLegacyWalletFiles(
        directory: URL,
        databaseURL: URL,
        outgoingURL: URL
    ) throws {
        let fileManager = FileManager.default
        let legacyDatabase = directory.appendingPathComponent("cashu.sqlite")
        if !fileManager.fileExists(atPath: databaseURL.path),
           fileManager.fileExists(atPath: legacyDatabase.path) {
            try fileManager.moveItem(at: legacyDatabase, to: databaseURL)
        }
        // Move each SQLite sidecar independently so an interrupted upgrade can
        // finish on the next launch even when the main database already moved.
        for suffix in ["-wal", "-shm"] {
            let source = URL(fileURLWithPath: legacyDatabase.path + suffix)
            let destination = URL(fileURLWithPath: databaseURL.path + suffix)
            if fileManager.fileExists(atPath: source.path),
               !fileManager.fileExists(atPath: destination.path) {
                try fileManager.moveItem(at: source, to: destination)
            }
        }

        let legacyOutgoing = directory.appendingPathComponent("outgoing-tokens.json")
        if !fileManager.fileExists(atPath: outgoingURL.path),
           fileManager.fileExists(atPath: legacyOutgoing.path) {
            try fileManager.moveItem(at: legacyOutgoing, to: outgoingURL)
        }
    }

    private func normalizedUniqueMintURLs(_ values: [String]) throws -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let normalized = try CashuWalletService.normalizedMintURL(trimmed)
            guard seen.insert(normalized).inserted else { continue }
            result.append(normalized)
        }
        return result
    }

    private func repairActiveMintSelection() {
        if snapshot.mints.contains(where: { $0.url == activeMintURL }) { return }
        if let first = snapshot.mints.first {
            selectMint(first.url)
        } else {
            activeMintURL = ""
            UserDefaults.standard.removeObject(forKey: activeMintKey)
        }
    }

    static func message(for error: Error) -> String {
        if let localized = error as? LocalizedError, let message = localized.errorDescription {
            return message
        }
        return error.localizedDescription
    }
}

struct WalletView: View {
    @Environment(AppModel.self) private var model
    @EnvironmentObject private var wallet: WalletViewModel
    @State private var showingMints = false
    @State private var showingHistory = false
    @State private var showingReceiveOptions = false
    @State private var showingSendOptions = false
    @State private var showingReceive = false
    @State private var showingLightningReceive = false
    @State private var showingScanner = false
    @State private var showingSend = false
    @State private var showingLightningSend = false
    @State private var showingPaymentRequest = false
    @State private var showingCreatePaymentRequest = false
    @State private var showingMintTransfer = false
    @State private var showingPendingEcash = false
    @State private var showingRecovery = false
    @State private var scannedToken = ""

    var body: some View {
        ZStack {
            TaskifyTheme.background.ignoresSafeArea()

            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 0) {
                        header

                        utilityToolbar
                            .padding(.top, 14)

                        Group {
                            if wallet.snapshot.mints.isEmpty && !wallet.isLoading {
                                setupCard
                            } else {
                                VStack(spacing: 20) {
                                    balanceCard
                                    actionRow

                                    if !wallet.pendingEcashReceives.isEmpty {
                                        pendingEcashCard
                                            .padding(.top, 4)
                                    }
                                }
                            }
                        }
                        .frame(
                            minHeight: max(360, geometry.size.height - 250),
                            alignment: .center
                        )
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 12)
                    .padding(.bottom, 110)
                }
                .scrollIndicators(.hidden)
                .refreshable { await wallet.refresh() }
            }

            if wallet.isLoading {
                ProgressView("Opening wallet…")
                    .tint(.white)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .padding(22)
                    .taskifyGlass(cornerRadius: 20)
            }
        }
        .task {
#if DEBUG
            if ProcessInfo.processInfo.environment["TASKIFY_SHOW_WALLET_RECOVERY"] == "1" {
                showingRecovery = true
            }
#endif
        }
        .sheet(isPresented: $showingMints) {
            MintManagerSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingHistory) {
            WalletHistorySheet(wallet: wallet)
        }
        .sheet(isPresented: $showingReceive) {
            ReceiveCashuSheet(wallet: wallet, initialToken: scannedToken)
        }
        .sheet(isPresented: $showingLightningReceive) {
            ReceiveLightningSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingScanner) {
            CashuTokenScannerSheet(onToken: { token in
                scannedToken = token
                showingScanner = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    showingReceive = true
                }
            })
        }
        .sheet(isPresented: $showingSend) {
            SendCashuSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingLightningSend) {
            SendLightningSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingPaymentRequest) {
            PayCashuRequestSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingCreatePaymentRequest) {
            ReceiveCashuRequestSheet(wallet: wallet)
                .environment(model)
        }
        .sheet(isPresented: $showingMintTransfer) {
            MintTransferSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingPendingEcash) {
            PendingEcashSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingRecovery) {
            WalletRecoverySheet(wallet: wallet)
        }
        .confirmationDialog(
            "Receive into Taskify",
            isPresented: $showingReceiveOptions,
            titleVisibility: .visible
        ) {
            Button("Lightning invoice", systemImage: "bolt.fill") {
                showingLightningReceive = true
            }
            .disabled(wallet.activeMint == nil)
            Button("Cashu token", systemImage: "banknote") {
                scannedToken = ""
                showingReceive = true
            }
            Button("Cashu payment request", systemImage: "qrcode") {
                showingCreatePaymentRequest = true
            }
            .disabled(wallet.activeMint == nil || model.identityPublicKey.isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Create a Lightning invoice or Cashu request, or redeem an existing Cashu token.")
        }
        .confirmationDialog(
            "Send from Taskify",
            isPresented: $showingSendOptions,
            titleVisibility: .visible
        ) {
            Button("Pay Lightning invoice", systemImage: "bolt.fill") {
                showingLightningSend = true
            }
            Button("Create Cashu token", systemImage: "banknote") {
                showingSend = true
            }
            Button("Fulfill Cashu request", systemImage: "qrcode") {
                showingPaymentRequest = true
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Pay a Lightning invoice, fulfill a Cashu request, or create an ecash token to share.")
        }
        .alert(
            "Wallet",
            isPresented: Binding(
                get: { wallet.errorMessage != nil },
                set: { if !$0 { wallet.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { wallet.errorMessage = nil }
        } message: {
            Text(wallet.errorMessage ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Text("Wallet")
                .taskifyScreenTitle()
                .frame(maxWidth: .infinity, alignment: .leading)

            Text("SATS")
                .font(.caption.weight(.bold))
                .tracking(1.1)
                .foregroundStyle(TaskifyTheme.accent)
                .padding(.horizontal, 15)
                .frame(height: 40)
                .taskifyGlassControl(in: Capsule())
                .accessibilityLabel("Balance shown in sats")

            Button { showingHistory = true } label: {
                Text("History")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .padding(.horizontal, 15)
                    .frame(height: 40)
                    .taskifyGlassControl(in: Capsule())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityLabel("Wallet history")
        }
    }

    private var utilityToolbar: some View {
        HStack(alignment: .top) {
            Spacer()

            TaskifyGlassControlGroup(spacing: 8) {
                VStack(alignment: .trailing, spacing: 9) {
                    WalletUtilityButton(title: "Mints", systemImage: "building.columns") {
                        showingMints = true
                    }

                    WalletUtilityButton(title: "Swap", systemImage: "arrow.left.arrow.right") {
                        showingMintTransfer = true
                    }
                    .disabled(wallet.snapshot.mints.count < 2 || wallet.snapshot.available == 0)
                    .opacity(wallet.snapshot.mints.count < 2 || wallet.snapshot.available == 0 ? 0.45 : 1)

                    WalletUtilityButton(title: "Backup", systemImage: "key.viewfinder") {
                        showingRecovery = true
                    }
                }
            }
        }
    }

    private var balanceCard: some View {
        VStack(spacing: 10) {
            Text("\(wallet.snapshot.available.formatted()) sats")
                .font(.system(size: 48, weight: .semibold, design: .rounded))
                .minimumScaleFactor(0.62)
                .lineLimit(1)
                .contentTransition(.numericText())
                .monospacedDigit()
                .foregroundStyle(TaskifyTheme.primaryText)

            if wallet.snapshot.pending > 0 || wallet.snapshot.reserved > 0 {
                VStack(spacing: 5) {
                    if wallet.snapshot.pending > 0 {
                        Text("\(wallet.snapshot.pending.formatted()) sats pending")
                    }
                    if wallet.snapshot.reserved > 0 {
                        Text("\(wallet.snapshot.reserved.formatted()) sats in outgoing tokens")
                    }
                }
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 22)
        .padding(.vertical, 42)
        .taskifyGlass(cornerRadius: 30)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Available balance, \(wallet.snapshot.available) sats")
    }

    private var actionRow: some View {
        HStack(spacing: 12) {
            WalletActionButton(title: "Receive", icon: "arrow.down", accent: true) {
                showingReceiveOptions = true
            }

            Button { showingScanner = true } label: {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 20, weight: .semibold))
                    .frame(width: 52, height: 52)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Scan a Cashu token")

            WalletActionButton(title: "Send", icon: "arrow.up", accent: false) {
                showingSendOptions = true
            }
            .disabled(wallet.snapshot.available == 0)
            .opacity(wallet.snapshot.available == 0 ? 0.45 : 1)
        }
    }

    private var setupCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Set up your wallet", systemImage: "sparkles")
                .font(.headline)
                .foregroundStyle(TaskifyTheme.primaryText)

            Text("Add a Cashu mint to receive and send ecash. Taskify suggests the same mint used by the PWA, but you can choose another.")
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Button {
                Task {
                    do {
                        try await wallet.addMint(WalletViewModel.suggestedMintURL)
                    } catch {
                        wallet.errorMessage = WalletViewModel.message(for: error)
                    }
                }
            } label: {
                Label(wallet.isWorking ? "Connecting…" : "Add Taskify mint", systemImage: "plus")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(.white)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.75))
            }
            .buttonStyle(.plain)
            .disabled(wallet.isWorking)

            Button("Choose a different mint") { showingMints = true }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.accent)
                .frame(maxWidth: .infinity)
        }
        .padding(20)
        .taskifyGlass(cornerRadius: 24)
    }

    private var pendingEcashCard: some View {
        Button { showingPendingEcash = true } label: {
            HStack(spacing: 14) {
                Image(systemName: wallet.recoverablePendingEcashReceives.isEmpty
                    ? "exclamationmark.triangle.fill"
                    : "arrow.clockwise.circle.fill")
                    .font(.title3)
                    .frame(width: 46, height: 46)
                    .foregroundStyle(wallet.recoverablePendingEcashReceives.isEmpty ? .orange : TaskifyTheme.accent)
                    .background(
                        (wallet.recoverablePendingEcashReceives.isEmpty ? Color.orange : TaskifyTheme.accent)
                            .opacity(0.12),
                        in: Circle()
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text("Saved ecash")
                        .font(.headline)
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(pendingEcashDescription)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .multilineTextAlignment(.leading)
                }

                Spacer()

                Text(wallet.pendingEcashReceives.count.formatted())
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(TaskifyTheme.primaryText)

                Image(systemName: "chevron.right")
                    .font(.caption.bold())
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }
            .padding(16)
            .taskifyGlass(cornerRadius: 22)
        }
        .buttonStyle(.plain)
    }

    private var pendingEcashDescription: String {
        if wallet.recoverablePendingEcashReceives.isEmpty {
            return "A token needs your attention"
        }
        return wallet.recoverablePendingEcashReceives.count == 1
            ? "Waiting for its mint — retrying automatically"
            : "Waiting for their mints — retrying automatically"
    }
}

private enum WalletActivityItem: Identifiable {
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

private struct WalletActionButton: View {
    let title: String
    let icon: String
    let accent: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .foregroundStyle(TaskifyTheme.primaryText)
                .taskifyGlassControl(
                    in: Capsule(),
                    tint: accent ? TaskifyTheme.accent.opacity(0.72) : nil
                )
        }
        .buttonStyle(.plain)
    }
}

private struct WalletUtilityButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(.horizontal, 15)
                .frame(height: 40)
                .taskifyGlassControl(in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

private struct WalletMintSelectorCard: View {
    let label: String
    let mints: [CashuMintSummary]
    @Binding var selectedMintURL: String

    private var selectedMint: CashuMintSummary? {
        mints.first { $0.url == selectedMintURL }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.1)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Menu {
                ForEach(mints) { mint in
                    Button {
                        selectedMintURL = mint.url
                    } label: {
                        if mint.url == selectedMintURL {
                            Label(mint.name, systemImage: "checkmark")
                        } else {
                            Text(mint.name)
                        }
                    }
                }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectedMint?.name ?? "Select mint")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                        Text(selectedMint.map { "\($0.available.formatted()) sats available" } ?? "No mint selected")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    Spacer()
                    if mints.count > 1 {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 52)
                .taskifyGlass(cornerRadius: 20)
            }
            .buttonStyle(.plain)
            .disabled(mints.count <= 1)
        }
    }
}

private struct WalletAmountDisplayCard: View {
    let amountText: String
    var suffix: String = "sats"
    var caption: String = "Enter amount"

    var body: some View {
        VStack(spacing: 4) {
            Text("\(amountText.isEmpty ? "0" : amountText) \(suffix)")
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .foregroundStyle(TaskifyTheme.primaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            Text(caption)
                .font(.footnote)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .taskifyGlass(cornerRadius: 24)
    }
}

private struct WalletAmountKeypad: View {
    @Binding var amountText: String
    var maxDigits: Int = 12

    private static let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "backspace"]

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3),
            spacing: 12
        ) {
            ForEach(Self.keys, id: \.self) { key in
                Button {
                    handle(key)
                } label: {
                    Group {
                        if key == "clear" {
                            Text("Clear")
                                .font(.subheadline.weight(.semibold))
                        } else if key == "backspace" {
                            Image(systemName: "delete.left")
                                .font(.system(size: 17, weight: .semibold))
                        } else {
                            Text(key)
                                .font(.title3.weight(.semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func handle(_ key: String) {
        switch key {
        case "clear":
            amountText = ""
        case "backspace":
            if !amountText.isEmpty { amountText.removeLast() }
        default:
            let next = amountText == "0" ? key : amountText + key
            amountText = String(next.filter(\.isNumber).prefix(maxDigits))
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

private struct MintManagerSheet: View {
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

                                    Text("\(mint.available.formatted()) sats")
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

private struct MintTransferSheet: View {
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
                Text("sats")
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let sourceMint {
                    Text("\(sourceMint.available.formatted()) sats available")
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
                Text("\((transferHasCompleted ? max(result.receivedAmount, result.amount) : result.amount).formatted()) sats")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(TaskifyTheme.primaryText)

                VStack(spacing: 13) {
                    transferResultRow("From", value: mintName(for: result.sourceMintURL))
                    transferResultRow("To", value: mintName(for: result.destinationMintURL))
                    if let fee = result.feePaid {
                        transferResultRow("Fee paid", value: "\(fee.formatted()) sats")
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
                    Text("\(selectedMint.available.formatted()) sats")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            Spacer()
            Picker(title, selection: selection) {
                ForEach(options) { mint in
                    Text("\(mint.name) · \(mint.available.formatted()) sats").tag(mint.url)
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

private struct WalletRecoverySheet: View {
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
                Text("\(restoreOutcome.found.formatted()) sats found" + (restoreOutcome.fees > 0 ? " · \(restoreOutcome.fees.formatted()) sats mint fees" : ""))
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
                            Text("\(mint.deposited.formatted()) sats")
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
        case .transfer: "\(restoreOutcome.recovered.formatted()) sats added to Taskify"
        case .rescan, .replace: "\(restoreOutcome.recovered.formatted()) sats recovered"
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

private enum WalletRecoveryAuthenticationError: LocalizedError {
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

private struct WalletSeedBackupDocument: FileDocument {
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

private struct ReceiveCashuRequestSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var wallet: WalletViewModel

    @State private var selectedMintURL = ""
    @State private var amountText = ""
    @State private var memo = ""
    @State private var singleUse = true
    @State private var request: CashuCreatedPaymentRequest?
    @State private var localError: String?
    @State private var copied = false
    @FocusState private var memoFocused: Bool

    private var parsedAmount: UInt64? {
        let trimmed = amountText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return UInt64(trimmed)
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
            if selectedMintURL.isEmpty {
                selectedMintURL = wallet.activeMint?.url ?? wallet.snapshot.mints.first?.url ?? ""
            }
            if request == nil {
                request = wallet.createdPaymentRequests.first(where: {
                    $0.isActive && $0.mintURLs.contains(selectedMintURL)
                })
            }
        }
        .onChange(of: wallet.createdPaymentRequests) { _, requests in
            guard let request else { return }
            self.request = requests.first { $0.requestID == request.requestID } ?? request
        }
    }

    private var createView: some View {
        VStack(spacing: 20) {
            WalletMintSelectorCard(label: "RECEIVE TO", mints: wallet.snapshot.mints, selectedMintURL: $selectedMintURL)

            WalletAmountDisplayCard(amountText: amountText, caption: "Leave at 0 to request any amount")

            Picker("Request type", selection: $singleUse) {
                Text("Single-use").tag(true)
                Text("Multi-use").tag(false)
            }
            .pickerStyle(.segmented)

            WalletAmountKeypad(amountText: $amountText)

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
                Text("\(request.receivedAmount.formatted()) sats were added to your wallet.")
                    .foregroundStyle(TaskifyTheme.secondaryText)
            } else if request.state == .cancelled {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 58))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Text("Request closed")
                    .font(.title2.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
            } else {
                Text(request.amount.map { "\($0.formatted()) sats" } ?? "Any amount")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(TaskifyTheme.primaryText)

                Label(
                    request.receivedCount == 0
                        ? "Waiting for payment"
                        : "Received \(request.receivedAmount.formatted()) sats",
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
                    singleUse: singleUse
                )
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
    }
}

private struct ReceiveLightningSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var amountText = ""
    @State private var selectedMintURL = ""
    @State private var quote: CashuLightningReceiveQuote?
    @State private var receivedAmount: UInt64?
    @State private var isChecking = false
    @State private var copied = false
    @State private var localError: String?

    init(
        wallet: WalletViewModel,
        initialQuote: CashuLightningReceiveQuote? = nil
    ) {
        self.wallet = wallet
        _selectedMintURL = State(initialValue: initialQuote?.mintURL ?? "")
        _quote = State(initialValue: initialQuote)
    }

    private var amount: UInt64? {
        UInt64(amountText.trimmingCharacters(in: .whitespacesAndNewlines))
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
                            } else {
                                amountView
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
        .task(id: selectedMintURL) {
            guard !selectedMintURL.isEmpty, quote == nil else { return }
            do {
                quote = try await wallet.latestLightningReceiveQuote(mintURL: selectedMintURL)
            } catch {
                localError = WalletViewModel.message(for: error)
            }
        }
        .onChange(of: wallet.lightningReceiveQuotes) { _, trackedQuotes in
            guard let quote,
                  let updated = trackedQuotes.first(where: { $0.id == quote.id }) else { return }
            applyQuoteUpdate(updated)
        }
        .onAppear {
            if selectedMintURL.isEmpty {
                selectedMintURL = wallet.activeMint?.url ?? wallet.snapshot.mints.first?.url ?? ""
            }
        }
    }

    private var amountView: some View {
        VStack(spacing: 20) {
            WalletMintSelectorCard(label: "RECEIVE TO", mints: wallet.snapshot.mints, selectedMintURL: $selectedMintURL)
            WalletAmountDisplayCard(amountText: amountText, caption: "Enter amount to receive")
            WalletAmountKeypad(amountText: $amountText)

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
                Text("\(quote.amount.formatted()) sats")
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
            Text("\(amount.formatted()) sats")
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

private struct ReceiveCashuSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var preview: CashuTokenPreview?
    @State private var receivedAmount: UInt64?
    @State private var queuedReceive: CashuPendingReceive?
    @State private var isInspecting = false
    @State private var localError: String?

    init(wallet: WalletViewModel, initialToken: String = "") {
        self.wallet = wallet
        _token = State(initialValue: initialToken)
    }

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
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.system(size: 52))
                                .foregroundStyle(TaskifyTheme.accent)

                            VStack(spacing: 6) {
                                Text("Receive Cashu ecash")
                                    .font(.title2.bold())
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Paste a cashuA or cashuB token. Taskify verifies and swaps it with its mint before adding the balance.")
                                    .font(.subheadline)
                                    .multilineTextAlignment(.center)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                            }

                            TextEditor(text: $token)
                                .font(.system(.footnote, design: .monospaced))
                                .scrollContentBackground(.hidden)
                                .padding(12)
                                .frame(minHeight: 130)
                                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(TaskifyTheme.border))
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .onChange(of: token) { _, _ in preview = nil }

                            Button {
                                if let value = UIPasteboard.general.string { token = value }
                            } label: {
                                Label("Paste from clipboard", systemImage: "doc.on.clipboard")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .foregroundStyle(TaskifyTheme.accent)

                            if let preview {
                                tokenPreview(preview)
                                Button {
                                    Task {
                                        do {
                                            switch try await wallet.submitReceive(token) {
                                            case .received(let amount):
                                                receivedAmount = amount
                                            case .queued(let pending):
                                                queuedReceive = pending
                                            }
                                        } catch {
                                            localError = WalletViewModel.message(for: error)
                                        }
                                    }
                                } label: {
                                    Label(wallet.isWorking ? "Receiving…" : "Receive \(preview.receivedAmount.formatted()) sats", systemImage: "checkmark")
                                        .font(.headline)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 14)
                                        .foregroundStyle(.white)
                                        .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
                                }
                                .buttonStyle(.plain)
                                .disabled(wallet.isWorking)
                            } else {
                                Button {
                                    inspectToken()
                                } label: {
                                    Text(isInspecting ? "Checking token…" : "Continue")
                                        .font(.headline)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 14)
                                        .foregroundStyle(.white)
                                        .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
                                }
                                .buttonStyle(.plain)
                                .disabled(isInspecting || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        }
                    }
                    .padding(22)
                }
            }
            .navigationTitle("Receive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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

    private func inspectToken() {
        isInspecting = true
        Task {
            defer { isInspecting = false }
            do { preview = try await wallet.previewToken(token) }
            catch { localError = WalletViewModel.message(for: error) }
        }
    }

    private func tokenPreview(_ preview: CashuTokenPreview) -> some View {
        VStack(spacing: 12) {
            HStack {
                Text("Token value")
                Spacer()
                Text("\(preview.amount.formatted()) sats").bold()
            }
            if let fee = preview.fee, fee > 0 {
                HStack {
                    Text("Mint fee")
                    Spacer()
                    Text("−\(fee.formatted()) sats")
                }
            }
            Divider().overlay(TaskifyTheme.border)
            HStack {
                Text("You receive").bold()
                Spacer()
                Text("\(preview.receivedAmount.formatted()) sats").bold()
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
            Text("\(amount.formatted()) sats")
                .font(.title2.weight(.semibold).monospacedDigit())
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

    private func queuedView(_ pending: CashuPendingReceive) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 66))
                .foregroundStyle(TaskifyTheme.accent)
                .symbolEffect(.pulse)

            Text("Ecash saved safely")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            Text("Taskify kept the token on this device and will retry its mint automatically. You can close this screen without losing it.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.secondaryText)

            VStack(spacing: 9) {
                HStack {
                    Text("Token value")
                    Spacer()
                    Text("\(pending.amount.formatted()) sats").bold()
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

            Button("Done") { dismiss() }
                .font(.headline)
                .foregroundStyle(TaskifyTheme.accent)
        }
        .padding(.top, 34)
    }
}

private struct PendingEcashSheet: View {
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
                        Text("Every saved ecash token has been redeemed.")
                    }
                    .foregroundStyle(TaskifyTheme.primaryText)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            Text("Tokens waiting on a mint stay encrypted by iOS file protection on this device. Cashu tokens do not have a normal expiration, so Taskify keeps retrying recoverable tokens until they succeed or you remove them.")
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
                Image(systemName: pending.state == .queued
                    ? "clock.arrow.circlepath"
                    : "exclamationmark.triangle.fill")
                    .font(.title3)
                    .frame(width: 42, height: 42)
                    .foregroundStyle(pending.state == .queued ? TaskifyTheme.accent : .orange)
                    .background(
                        (pending.state == .queued ? TaskifyTheme.accent : Color.orange).opacity(0.12),
                        in: Circle()
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text("\(pending.amount.formatted()) sats")
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(URL(string: pending.mintURL)?.host() ?? pending.mintURL)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }

                Spacer()

                Text(pending.state == .queued ? "Saved" : "Check token")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(pending.state == .queued ? TaskifyTheme.accent : .orange)
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

            if pending.state == .needsAttention {
                Text("The mint says this token is already spent. Verify the balance or original sender before removing it.")
                    .font(.caption)
                    .foregroundStyle(.orange)
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

private struct CashuTokenScannerSheet: View {
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

private struct CashuTokenCodeScanner: UIViewControllerRepresentable {
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

private struct SendLightningSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var invoice = ""
    @State private var amountText = ""
    @State private var selectedMintURL = ""
    @State private var quote: CashuLightningPaymentQuote?
    @State private var result: CashuLightningPaymentResult?
    @State private var localError: String?
    @State private var showingScanner = false
    @FocusState private var focusedField: Field?

    private enum Field {
        case invoice
        case amount
    }

    private var customAmount: UInt64? {
        let value = amountText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        return UInt64(value)
    }

    private var canContinue: Bool {
        !invoice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !selectedMintURL.isEmpty
            && (amountText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || customAmount != nil)
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
                        } else {
                            invoiceView
                        }
                    }
                    .padding(22)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Pay Lightning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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
        .interactiveDismissDisabled(wallet.isWorking)
        .onAppear {
            if selectedMintURL.isEmpty { selectedMintURL = wallet.activeMint?.url ?? "" }
        }
        .onDisappear {
            if let quote, result == nil {
                Task { await wallet.cancelLightningPayment(quote) }
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

    private var invoiceView: some View {
        VStack(spacing: 20) {
            Image(systemName: "bolt.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.yellow)

            VStack(spacing: 6) {
                Text("Pay a Lightning invoice")
                    .font(.title2.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text("Paste or scan a BOLT11 invoice, then review the exact amount and fees before paying.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            ZStack(alignment: .topLeading) {
                if invoice.isEmpty {
                    Text("Lightning invoice")
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
            .frame(minHeight: 116)
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
            }
            .font(.headline)
            .foregroundStyle(TaskifyTheme.primaryText)

            mintPicker

            VStack(alignment: .leading, spacing: 8) {
                Text("AMOUNTLESS INVOICE")
                    .font(.caption.bold())
                    .tracking(1)
                    .foregroundStyle(TaskifyTheme.accent)
                TextField("Optional amount in sats", text: $amountText)
                    .keyboardType(.numberPad)
                    .focused($focusedField, equals: .amount)
                    .padding(.horizontal, 15)
                    .frame(height: 50)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TaskifyTheme.border))
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text("Leave this empty unless the invoice does not contain an amount.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            Button {
                focusedField = nil
                Task {
                    do {
                        quote = try await wallet.prepareLightningPayment(
                            mintURL: selectedMintURL,
                            invoice: invoice,
                            amount: customAmount
                        )
                    } catch {
                        localError = WalletViewModel.message(for: error)
                    }
                }
            } label: {
                Text(wallet.isWorking ? "Checking invoice…" : "Review payment")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundStyle(.white)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(wallet.isWorking || !canContinue)

            Label(
                "The selected Cashu mint pays the invoice. Taskify never sends your recovery phrase.",
                systemImage: "lock.shield"
            )
            .font(.caption)
            .multilineTextAlignment(.center)
            .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }

    @ViewBuilder
    private var mintPicker: some View {
        let fundedMints = wallet.snapshot.mints.filter { $0.available > 0 }
        if fundedMints.count > 1 {
            Picker("Pay from", selection: $selectedMintURL) {
                ForEach(fundedMints) { mint in
                    Text("\(mint.name) · \(mint.available.formatted()) sats").tag(mint.url)
                }
            }
            .pickerStyle(.menu)
            .tint(TaskifyTheme.accent)
            .padding(.horizontal, 15)
            .frame(height: 50)
            .taskifyGlass(cornerRadius: 18)
        } else if let mint = fundedMints.first {
            HStack {
                Label(mint.name, systemImage: "building.columns")
                Spacer()
                Text("\(mint.available.formatted()) sats")
            }
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.secondaryText)
            .padding(16)
            .taskifyGlass(cornerRadius: 18)
        }
    }

    private func confirmationView(_ quote: CashuLightningPaymentQuote) -> some View {
        VStack(spacing: 20) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 34, weight: .bold))
                .frame(width: 70, height: 70)
                .foregroundStyle(.yellow)
                .taskifyGlassControl(in: Circle())

            Text("Review payment")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            VStack(spacing: 14) {
                paymentRow("Invoice amount", value: "\(quote.amount.formatted()) sats")
                paymentRow("Maximum routing fee", value: "\(quote.feeReserve.formatted()) sats")
                if quote.walletFee > 0 {
                    paymentRow("Mint input fee", value: "\(quote.walletFee.formatted()) sats")
                }
                Divider().overlay(TaskifyTheme.border)
                paymentRow("Maximum from balance", value: "\(quote.maximumTotal.formatted()) sats", emphasized: true)

                Text(URL(string: quote.mintURL)?.host() ?? quote.mintURL)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let expiresAt = quote.expiresAt {
                    Label("Invoice expires \(expiresAt, style: .relative)", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(quote.isExpired() ? Color.orange : TaskifyTheme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.primaryText)
            .padding(18)
            .taskifyGlass(cornerRadius: 22)

            Button {
                Task {
                    do {
                        result = try await wallet.confirmLightningPayment(quote)
                    } catch {
                        localError = WalletViewModel.message(for: error)
                        self.quote = nil
                    }
                }
            } label: {
                Label(
                    wallet.isWorking ? "Paying…" : "Pay \(quote.amount.formatted()) sats",
                    systemImage: "bolt.fill"
                )
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(.white)
                .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(wallet.isWorking || quote.isExpired())

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

            Text("\(result.amount.formatted()) sats")
                .font(.system(size: 42, weight: .bold, design: .rounded))
                .foregroundStyle(TaskifyTheme.primaryText)

            VStack(spacing: 14) {
                paymentRow("Amount", value: "\(result.amount.formatted()) sats")
                if let feePaid = result.feePaid {
                    paymentRow("Fee paid", value: "\(feePaid.formatted()) sats")
                }
                paymentRow("Status", value: result.state == .completed ? "Completed" : "Pending")
            }
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.primaryText)
            .padding(18)
            .taskifyGlass(cornerRadius: 22)

            Text(result.state == .completed
                ? "The payment and its technical details are now available in Wallet History."
                : "The mint is still processing this payment. Do not retry it. Taskify will reconcile the reserved balance when the wallet next refreshes online.")
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

    private func paymentRow(_ title: String, value: String, emphasized: Bool = false) -> some View {
        HStack {
            Text(title).fontWeight(emphasized ? .bold : .regular)
            Spacer()
            Text(value).fontWeight(emphasized ? .bold : .semibold).monospacedDigit()
        }
    }
}

private struct PayCashuRequestSheet: View {
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
                paymentAmount.map { "Pay \($0.formatted()) sats?" } ?? "Pay Cashu request?",
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
                VStack(spacing: 4) {
                    Text(fixedAmount.formatted())
                        .font(.system(size: 46, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text("sats")
                        .font(.headline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
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
                    Text("sats")
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
                    "This mint needs \((amount - mint.available).formatted()) more sats.",
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
                    Text("\(mint.name) · \(mint.available.formatted()) sats").tag(mint.url)
                }
            }
            .pickerStyle(.menu)
            .tint(TaskifyTheme.accent)
        } else if let mint = compatibleMints.first {
            HStack {
                Label(mint.name, systemImage: "building.columns")
                Spacer()
                Text("\(mint.available.formatted()) sats")
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
            Text("\(result.amount.formatted()) sats")
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

private struct SendCashuSheet: View {
    @ObservedObject var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var amountText = ""
    @State private var memo = ""
    @State private var selectedMintURL = ""
    @State private var quote: CashuPreparedSendQuote?
    @State private var outgoing: CashuOutgoingToken?
    @State private var localError: String?
    @State private var confirmingReclaim = false

    private var amount: UInt64? {
        UInt64(amountText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                GeometryReader { proxy in
                    ScrollView {
                        Group {
                            if let outgoing {
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
            .navigationTitle(outgoing == nil ? "Send" : "Ecash token")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
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

            WalletAmountDisplayCard(amountText: amountText, caption: "Enter amount to send")

            WalletAmountKeypad(amountText: $amountText)

            TextField("Memo (optional)", text: $memo)
                .padding(.horizontal, 15)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TaskifyTheme.border))
                .foregroundStyle(TaskifyTheme.primaryText)

            Button {
                guard let amount, amount > 0 else { return }
                Task {
                    do { quote = try await wallet.prepareSend(mintURL: selectedMintURL, amount: amount) }
                    catch { localError = WalletViewModel.message(for: error) }
                }
            } label: {
                Text(wallet.isWorking ? "Preparing…" : "Continue")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundStyle(.white)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(wallet.isWorking || amount == nil || amount == 0 || selectedMintURL.isEmpty)

            Text("The token remains reserved until its recipient redeems it or you reclaim it.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
    }

    private func confirmationView(_ quote: CashuPreparedSendQuote) -> some View {
        VStack(spacing: 20) {
            Text("Review send")
                .font(.title2.bold())
                .foregroundStyle(TaskifyTheme.primaryText)

            VStack(spacing: 14) {
                HStack {
                    Text("Recipient receives")
                    Spacer()
                    Text("\(quote.amount.formatted()) sats").bold()
                }
                HStack {
                    Text("Mint fee")
                    Spacer()
                    Text("\(quote.fee.formatted()) sats")
                }
                Divider().overlay(TaskifyTheme.border)
                HStack {
                    Text("Total from balance").bold()
                    Spacer()
                    Text("\((quote.amount + quote.fee).formatted()) sats").bold()
                }
                Text(quote.mintURL)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.subheadline)
            .foregroundStyle(TaskifyTheme.primaryText)
            .padding(18)
            .taskifyGlass(cornerRadius: 22)

            Button {
                Task {
                    do { outgoing = try await wallet.confirmSend(quote, memo: memo) }
                    catch { localError = WalletViewModel.message(for: error) }
                }
            } label: {
                Text(wallet.isWorking ? "Creating token…" : "Create token")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundStyle(.white)
                    .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
            }
            .buttonStyle(.plain)
            .disabled(wallet.isWorking)

            Button("Back") {
                Task { await wallet.cancelPreparedSend(quote) }
                self.quote = nil
            }
            .foregroundStyle(TaskifyTheme.secondaryText)
        }
    }
}

private struct WalletHistorySheet: View {
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

    private var pendingItems: [WalletActivityItem] {
        activityItems.filter(\.isPending)
    }

    private var filteredItems: [WalletActivityItem] {
        filter == .pending ? pendingItems : activityItems
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if !activityItems.isEmpty {
                            historyFilters
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

    private var historyFilters: some View {
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

private struct WalletOutgoingTokenRow: View {
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

            Text("−\(outgoing.amount.formatted())")
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

private struct WalletLightningInvoiceRow: View {
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

            Text("+\(quote.amount.formatted())")
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

private struct WalletTransactionDetailSheet: View {
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

            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("\(amountPrefix)\(transaction.amount.formatted())")
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text("sats")
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
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
                value: "\(transaction.amount.formatted()) sats"
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
                    value: "\(transaction.fee.formatted()) sats"
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

private struct WalletTransactionDetailRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title)
                .foregroundStyle(TaskifyTheme.secondaryText)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(TaskifyTheme.primaryText)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(.vertical, 14)
    }
}

private struct CopyableTransactionField: View {
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

private struct WalletTransactionRow: View {
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

            Text("\(transaction.state == .failed ? "" : (isIncoming ? "+" : "−"))\(transaction.amount.formatted())")
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

private struct OutgoingTokenSheet: View {
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

private struct OutgoingTokenContent: View {
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
            Text("\(outgoing.amount.formatted()) sats")
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

private struct CashuQRCodeView: View {
    let value: String
    let accessibilityLabel: String
    private let frames: [String]
    @State private var frameIndex = 0

    init(value: String, accessibilityLabel: String = "Cashu token QR code") {
        self.value = value
        self.accessibilityLabel = accessibilityLabel
        frames = CashuAnimatedQRAnimation(token: value)?.frames ?? []
    }

    private var displayedValue: String {
        guard !frames.isEmpty else { return value }
        return frames[min(frameIndex, frames.count - 1)]
    }

    private func image(for value: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let transformed = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(transformed, from: transformed.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }

    var body: some View {
        VStack(spacing: 9) {
            Group {
                if let image = image(for: displayedValue) {
                    Image(uiImage: image)
                        .resizable()
                        .interpolation(.none)
                        .scaledToFit()
                } else {
                    ContentUnavailableView("Payment detail is too large for a QR code", systemImage: "qrcode")
                        .foregroundStyle(Color.black)
                }
            }
            .aspectRatio(1, contentMode: .fit)

            if frames.count > 1 {
                HStack(spacing: 6) {
                    Image(systemName: "qrcode")
                    Text("Animated QR")
                    Text("\(frameIndex + 1)/\(frames.count)")
                        .monospacedDigit()
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.black.opacity(0.68))
            }
        }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(frames.count > 1 ? "Animated frame \(frameIndex + 1) of \(frames.count)" : "")
        .task(id: value) {
            frameIndex = 0
            guard frames.count > 1 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(450))
                guard !Task.isCancelled else { return }
                frameIndex = (frameIndex + 1) % frames.count
            }
        }
    }
}
