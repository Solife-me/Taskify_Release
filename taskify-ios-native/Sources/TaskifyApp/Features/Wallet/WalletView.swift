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

enum NpubCashClaimStatus: Equatable {
    case idle
    case checking
    case success
    case error
}

enum SolifeAccountStatus: Equatable {
    case idle
    case loading
    case error
}

/// A last-known BTC/USD price, so the wallet has an immediate (if possibly stale) conversion
/// available before the first live fetch completes -- matches the PWA's `LS_BTC_USD_PRICE_CACHE`
/// localStorage cache, minus the `updatedAt` timestamp, which nothing in this app's UI surfaces.
enum WalletPriceCache {
    private static let key = "taskify.wallet.btcUsdPriceCache"

    static var cachedPrice: Double? {
        let value = UserDefaults.standard.double(forKey: key)
        return value > 0 ? value : nil
    }

    static func save(_ price: Double) {
        UserDefaults.standard.set(price, forKey: key)
    }
}

@MainActor
final class WalletViewModel: ObservableObject {
    /// Desktop and tablet wallets must not race the phone to redeem shared DMs.
    var automaticallyRedeemsIncomingPayments: Bool {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .phone
        #else
        false
        #endif
    }

    @Published private(set) var incomingTokensAwaitingRedemption: [CashuIncomingTokenDelivery] = []
    @Published private(set) var incomingRequestsAwaitingRedemption: [CashuNostrPaymentDelivery] = []

    static let suggestedMintURL = "https://mint.minibits.cash/Bitcoin"
    /// Outstanding-invoice check cadence. Each unchanged round trip doubles the wait (up to
    /// the maximum) so a wallet that is merely left open stays quiet; a paid invoice resets
    /// the interval immediately.
    private static let lightningPollBaseSeconds: UInt64 = 15
    private static let lightningPollMaximumSeconds: UInt64 = 60

    @Published private(set) var snapshot = CashuWalletSnapshot.empty
    @Published private(set) var isLoading = false
    @Published var isWorking = false
    @Published var errorMessage: String?
    @Published var statusMessage: String?
    @Published private(set) var activeMintURL: String
    @Published private(set) var lightningReceiveQuotes: [CashuLightningReceiveQuote] = []
    @Published private(set) var pendingEcashReceives: [CashuPendingReceive] = []
    @Published private(set) var createdPaymentRequests: [CashuCreatedPaymentRequest] = []
    @Published private(set) var solifeAddress: String?
    @Published private(set) var solifeAccount: SolifeAccount?
    @Published private(set) var solifeConfig: SolifeConfig?
    @Published private(set) var solifeAccountStatus: SolifeAccountStatus = .idle
    @Published private(set) var solifeAccountMessage: String?
    @Published private(set) var npubCashIdentity: NpubCashIdentity?
    @Published private(set) var npubCashIdentityError: String?
    @Published private(set) var npubCashClaimStatus: NpubCashClaimStatus = .idle
    @Published private(set) var npubCashClaimMessage: String?
    @Published private(set) var btcUSDPrice: Double? = WalletPriceCache.cachedPrice
    @Published private(set) var p2pkKeyRing: CashuP2PKKeyRing
    // NWC wallet mode (see NWCWalletViews.swift).
    @Published var walletMode: TaskifyWalletMode = NWCWalletSettings().mode
    @Published var nwcConnected: Bool = KeychainNWCConnectionStore().load() != nil
    @Published var nwcWallets: [NWCWalletSummary] = []
    @Published var activeNWCWalletID: String?
    @Published var nwcStatus: NWCWalletStatus?
    @Published var nwcMigrationJournal: SweepJournal?
    @Published var isMovingToNWC = false
    @Published var nwcReceiveAddressOverride: String? = NWCWalletSettings().receiveAddress
    let nwcService = NWCWalletService(journalURL: WalletViewModel.nwcJournalURL)

    private(set) var service: CashuWalletService?
    private var hasStarted = false
    private var isAppActive = true
    private var lightningMonitorTask: Task<Void, Never>?
    private var priceMonitorTask: Task<Void, Never>?
    private var paymentInboxTask: Task<Void, Never>?
    private var paymentInboxNeedsAnotherPass = false
    private var isRecoveringPaymentInbox = false
    private var isRecoveringIncomingTokenInbox = false
    private var isClaimingNpubCash = false
    private var announcedLightningQuoteIDs: Set<String> = []
    private let paymentNotificationCoordinator = WalletPaymentNotificationCoordinator()
    private let activeMintKey = "taskify.wallet.active-mint"

    init() {
        activeMintURL = UserDefaults.standard.string(forKey: activeMintKey) ?? ""
        p2pkKeyRing = (try? KeychainP2PKKeyStore().load()) ?? CashuP2PKKeyRing()
    }

    var p2pkKeys: [CashuP2PKKey] { p2pkKeyRing.keys }
    var primaryP2PKKey: CashuP2PKKey? { p2pkKeyRing.primaryKey }

    private var p2pkSigningPrivateKeys: [String] {
        var keys = p2pkKeyRing.keys.map(\.privateKey)
        // The PWA can lock a contact payment to the recipient's Nostr public key. Including the
        // local Nostr key lets this client redeem those interoperable contact-locked tokens too.
        if let identity = try? KeychainIdentityStore().load() {
            keys.append(identity.privateKeyHex)
        }
        return Array(Set(keys))
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
            startPriceMonitoring()
            return
        }
        hasStarted = true
        isLoading = true
        defer { isLoading = false }

        do {
            // Opening the CDK SQLite repository and deriving its wallet identifier are
            // synchronous. Performing them on MainActor caused the first Boards frame to
            // pause even though the wallet tab was not visible.
            let service = try await Task.detached(priority: .userInitiated) {
                let mnemonic = try KeychainWalletSeedStore().loadOrCreate()
                return try Self.makeService(
                    mnemonic: mnemonic,
                    migrateLegacyFiles: true
                )
            }.value
            self.service = service
            await service.configureP2PKSigningKeys(
                privateKeys: p2pkSigningPrivateKeys
            )
            await service.recoverInterruptedOperations()
            await refresh()
            announcedLightningQuoteIDs = Set(
                lightningReceiveQuotes.lazy.filter { $0.state == .issued }.map(\.id)
            )
            await recoverPendingEcashReceives(force: true)
            await recoverNostrPaymentRequests()
            await recoverIncomingTokenInbox()
            if recoverLightningReceives {
                await recoverPendingLightningReceives()
            }
            startLightningMonitoring()
            startPriceMonitoring()
            refreshLightningAddresses()
            if LightningAddressSettings.provider == .npubCash, LightningAddressSettings.autoClaimEnabled {
                await claimNpubCash(auto: true)
            }
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func refresh() async {
        refreshManualPaymentInbox()
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
        if isNWCWalletActive { await refreshNWC() }
    }

    func appDidBecomeActive() {
        isAppActive = true
        guard hasStarted else { return }
        if hasOutstandingLightningInvoices {
            Task { await paymentNotificationCoordinator.requestAuthorizationIfNeeded() }
        }
        restartLightningMonitoring()
        restartPriceMonitoring()
        refreshLightningAddresses()
        Task {
            await service?.recoverInterruptedOperations()
            await recoverPendingEcashReceives(force: true)
            await recoverNostrPaymentRequests()
            await recoverIncomingTokenInbox()
            if LightningAddressSettings.provider == .npubCash, LightningAddressSettings.autoClaimEnabled {
                await claimNpubCash(auto: true)
            }
            await refresh()
        }
    }

    func appDidEnterBackground() {
        isAppActive = false
        lightningMonitorTask?.cancel()
        lightningMonitorTask = nil
        stopPriceMonitoring()
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

    /// The APNs alert has already caused AppModel to fetch and decrypt the NIP-17 gift wrap.
    /// Redeem any resulting ecash before claiming "Payment Received" so a malformed,
    /// spent, or transiently unavailable token never produces a false receipt notification.
    func performDMPushRefresh(
        notifyPayments: Bool,
        senderName: (String) -> String
    ) async -> Bool {
        if !hasStarted {
            await start(recoverLightningReceives: false)
        }
        guard service != nil else { return false }
        let requestReceipts = await recoverNostrPaymentRequests(presentInApp: false)
        let incomingReceipts = await recoverIncomingTokenInbox(presentInApp: false)
        if notifyPayments {
            let requestSenderNames = Dictionary(
                requestReceipts.map {
                    ($0.senderPublicKey.lowercased(), senderName($0.senderPublicKey))
                },
                uniquingKeysWith: { first, _ in first }
            )
            await paymentNotificationCoordinator.notifyCashuRequestReceipts(
                requestReceipts,
                senderNames: requestSenderNames
            )
            let incomingSenderNames = Dictionary(
                incomingReceipts.map {
                    ($0.senderPublicKey.lowercased(), senderName($0.senderPublicKey))
                },
                uniquingKeysWith: { first, _ in first }
            )
            await paymentNotificationCoordinator.notifyDMPushPaymentReceived(
                incomingReceipts,
                senderNames: incomingSenderNames
            )
        }
        return !requestReceipts.isEmpty || !incomingReceipts.isEmpty
    }

    private func refreshManualPaymentInbox() {
        guard !automaticallyRedeemsIncomingPayments else { return }
        if let url = try? CashuIncomingTokenInboxStore.defaultURL() {
            let deliveries = CashuIncomingTokenInboxStore.load(from: url)
            if deliveries != incomingTokensAwaitingRedemption {
                incomingTokensAwaitingRedemption = deliveries
            }
        }
        if let url = try? CashuNostrPaymentInboxStore.defaultURL() {
            let tokenEventIDs = Set(incomingTokensAwaitingRedemption.map(\.eventID))
            let deliveries = CashuNostrPaymentInboxStore.load(from: url)
                .filter { !tokenEventIDs.contains($0.eventID) }
            if deliveries != incomingRequestsAwaitingRedemption {
                incomingRequestsAwaitingRedemption = deliveries
            }
        }
    }

    /// Only called by an explicit Redeem action. Viewing or refreshing the inbox is local-only.
    func redeemIncomingPayment(_ delivery: CashuIncomingTokenDelivery) async throws {
        guard !isWorking else { return }
        // A NUT-18 delivery can also appear in the generic token inbox. Preserve its
        // request bookkeeping while presenting only one Redeem action.
        if let requestURL = try? CashuNostrPaymentInboxStore.defaultURL(),
           let request = CashuNostrPaymentInboxStore.load(from: requestURL)
            .first(where: { $0.eventID == delivery.eventID }) {
            try await redeemIncomingPayment(request)
            return
        }
        let url = try CashuIncomingTokenInboxStore.defaultURL()
        _ = try await submitReceive(delivery.token)
        try CashuIncomingTokenInboxStore.markHandled(delivery, at: url)
        refreshManualPaymentInbox()
    }

    func redeemIncomingPayment(_ delivery: CashuNostrPaymentDelivery) async throws {
        guard !isWorking, !isNWCWalletActive else { return }
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        let url = try CashuNostrPaymentInboxStore.defaultURL()
        isWorking = true
        defer { isWorking = false }
        do {
            do {
                let receipt = try await service.receiveNostrPayment(delivery)
                statusMessage = "Received \(formattedSats(receipt.amount))"
            } catch CashuWalletError.paymentRequestNotFound {
                // Requests created on another device still carry redeemable bearer ecash.
                let token = try CashuPaymentRequestContract.tokenString(fromPaymentPayload: delivery.payloadJSON)
                switch try await service.submitReceive(token) {
                case .received(let amount): statusMessage = "Received \(formattedSats(amount))"
                case .alreadyReceived: statusMessage = "This ecash was already received"
                case .queued: statusMessage = "Ecash saved — choose Retry in the wallet to redeem it"
                }
            } catch CashuWalletError.paymentRequestAlreadyProcessed {
                statusMessage = "This ecash was already received"
            }
            try CashuNostrPaymentInboxStore.remove(eventIDs: [delivery.eventID], at: url)
            let tokenURL = try CashuIncomingTokenInboxStore.defaultURL()
            if let tokenDelivery = CashuIncomingTokenInboxStore.load(from: tokenURL)
                .first(where: { $0.eventID == delivery.eventID }) {
                try CashuIncomingTokenInboxStore.markHandled(tokenDelivery, at: tokenURL)
            }
            await refresh()
        } catch {
            await refresh()
            throw error
        }
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
                _ = await self.recoverIncomingTokenInbox(presentInApp: self.isAppActive)
            } while self.paymentInboxNeedsAnotherPass && !Task.isCancelled
            self.paymentInboxTask = nil
        }
    }

    /// Derives the `<npub>@solife.me` forwarding address (any Nostr key works, nothing to enable)
    /// and, when npub.cash is the selected provider, the `<npub>@npub.cash` address. Both are
    /// local-only, no network call. Called whenever the wallet starts, the app returns to the
    /// foreground, or the user changes the selected provider, so the address is ready to show
    /// immediately.
    func refreshLightningAddresses() {
        let identity = try? KeychainIdentityStore().load()
        solifeAddress = identity.map { SolifeClient.address(npub: $0.npub) }

        guard LightningAddressSettings.provider == .npubCash else {
            npubCashIdentity = nil
            npubCashIdentityError = nil
            return
        }
        guard let identity else {
            npubCashIdentity = nil
            npubCashIdentityError = "Set up your Taskify Nostr identity to use npub.cash."
            return
        }
        npubCashIdentity = NpubCashClient.identity(npub: identity.npub)
        npubCashIdentityError = nil
    }

    /// Checks npub.cash for a pending balance and, if any, redeems each token through the normal
    /// receive path (`submitReceive`) — the same preview-free flow already used for NUT-18
    /// payment-request receipts, so a claimed token gets identical mint verification, retry, and
    /// history handling as any other incoming ecash.
    @discardableResult
    func claimNpubCash(auto: Bool) async -> Int {
        guard !auto || automaticallyRedeemsIncomingPayments else { return 0 }
        guard LightningAddressSettings.provider == .npubCash, !isClaimingNpubCash else { return 0 }
        guard let identity = try? KeychainIdentityStore().load() else {
            if !auto {
                npubCashClaimStatus = .error
                npubCashClaimMessage = "Set up your Taskify Nostr identity to use npub.cash."
            }
            return 0
        }
        isClaimingNpubCash = true
        defer { isClaimingNpubCash = false }
        npubCashClaimStatus = .checking
        npubCashClaimMessage = "Checking npub.cash for pending tokens…"

        do {
            let result = try await NpubCashClient.claim(identity: identity)
            guard !result.tokens.isEmpty else {
                npubCashClaimStatus = .idle
                npubCashClaimMessage = result.balance > 0
                    ? "npub.cash reported a balance, but no token was returned. Try again shortly."
                    : "No pending eCash found."
                return 0
            }

            var claimedCount = 0
            var claimedTotal: UInt64 = 0
            var lastError: String?
            for token in result.tokens {
                do {
                    switch try await submitReceive(token) {
                    case .received(let amount):
                        claimedCount += 1
                        claimedTotal += amount
                    case .alreadyReceived:
                        lastError = "This eCash was already received."
                    case .queued:
                        claimedCount += 1
                    }
                } catch {
                    lastError = Self.message(for: error)
                }
            }

            if claimedCount > 0 {
                npubCashClaimStatus = .success
                npubCashClaimMessage = claimedTotal > 0
                    ? "Claimed \(formattedSats(claimedTotal)) via npub.cash"
                    : "Claimed \(claimedCount) token\(claimedCount == 1 ? "" : "s") via npub.cash"
                if !auto {
                    #if canImport(UIKit)
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    #endif
                }
            } else {
                npubCashClaimStatus = .error
                npubCashClaimMessage = lastError ?? "Unable to claim eCash from npub.cash."
            }
            return Int(claimedTotal)
        } catch {
            npubCashClaimStatus = .error
            npubCashClaimMessage = Self.message(for: error)
            return 0
        }
    }

    /// Loads the solife.me account: default address, mint routing, and any purchased custom
    /// addresses. Unlike npub.cash there's no "enable" step — any Nostr identity already
    /// authenticates, so this is only fetched when the user opens address management, not
    /// automatically on wallet start.
    func refreshSolifeAccount() async {
        guard let identity = try? KeychainIdentityStore().load() else {
            solifeAccountStatus = .error
            solifeAccountMessage = "Set up your Taskify Nostr identity to manage solife.me addresses."
            return
        }
        solifeAccountStatus = .loading
        solifeAccountMessage = nil
        do {
            let (config, account) = try await SolifeClient.fetchAccount(identity: identity)
            solifeConfig = config
            solifeAccount = account
            solifeAccountStatus = .idle
        } catch {
            solifeAccountStatus = .error
            solifeAccountMessage = Self.message(for: error)
        }
    }

    func checkSolifeAddressAvailability(handle: String) async throws -> SolifeAddressAvailability {
        try await SolifeClient.fetchAddressAvailability(handle: handle)
    }

    /// Claims a custom handle. A free handle settles immediately; a priced one returns an invoice
    /// the caller must pay (via `prepareLightningPayment`/`confirmLightningPayment`) and then
    /// confirm with `verifySolifePurchase`.
    func purchaseSolifeCustomAddress(handle: String) async throws -> SolifeCustomAddressClaim {
        guard let identity = try? KeychainIdentityStore().load() else {
            throw SolifeError.authenticationFailed
        }
        let (_, claim) = try await SolifeClient.claimCustomAddress(
            identity: identity,
            handle: handle,
            relays: TaskifyRelayDefaults.urls,
            mintURL: nil
        )
        if case .address = claim {
            await refreshSolifeAccount()
        }
        return claim
    }

    func verifySolifePurchase(purchaseID: String) async throws -> SolifeAddressPurchase {
        guard let identity = try? KeychainIdentityStore().load() else {
            throw SolifeError.authenticationFailed
        }
        let (_, purchase) = try await SolifeClient.verifyAddressPurchase(
            identity: identity,
            purchaseID: purchaseID
        )
        if purchase.status == "address_claimed" {
            await refreshSolifeAccount()
        }
        return purchase
    }

    func updateSolifeDefaultMint(_ mintURL: String?) async throws {
        guard let identity = try? KeychainIdentityStore().load() else {
            throw SolifeError.authenticationFailed
        }
        _ = try await SolifeClient.updateDefaultMint(identity: identity, mintURL: mintURL)
        await refreshSolifeAccount()
    }

    func updateSolifeCustomAddressMint(handle: String, mintURL: String?) async throws {
        guard let identity = try? KeychainIdentityStore().load() else {
            throw SolifeError.authenticationFailed
        }
        _ = try await SolifeClient.updateCustomAddressMint(identity: identity, handle: handle, mintURL: mintURL)
        await refreshSolifeAccount()
    }

    func createPaymentRequest(
        amount: UInt64?,
        description: String?,
        mintURLs: [String],
        recipientPublicKey: String,
        relayURLs: [String],
        singleUse: Bool,
        lockPublicKey: String? = nil
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
            singleUse: singleUse,
            lockPublicKey: lockPublicKey
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

    @discardableResult
    func generateP2PKKey(label: String? = nil) async throws -> CashuP2PKKey {
        let key = try CashuP2PKKey.generate(label: label)
        var next = p2pkKeyRing
        next.keys.append(key)
        if next.primaryKeyID == nil { next.primaryKeyID = key.id }
        try await applyP2PKKeyRing(next)
        return key
    }

    @discardableResult
    func importP2PKKey(secret: String, label: String? = nil) async throws -> CashuP2PKKey {
        let key = try CashuP2PKKey.importSecret(secret, label: label)
        guard !p2pkKeyRing.keys.contains(where: { $0.publicKey == key.publicKey }) else {
            throw CashuP2PKError.duplicateKey
        }
        var next = p2pkKeyRing
        next.keys.append(key)
        if next.primaryKeyID == nil { next.primaryKeyID = key.id }
        try await applyP2PKKeyRing(next)
        return key
    }

    func setPrimaryP2PKKey(id: UUID) async throws {
        guard p2pkKeyRing.keys.contains(where: { $0.id == id }) else {
            throw CashuP2PKError.keyNotFound
        }
        var next = p2pkKeyRing
        next.primaryKeyID = id
        try await applyP2PKKeyRing(next)
    }

    func removeP2PKKey(id: UUID) async throws {
        guard p2pkKeyRing.keys.contains(where: { $0.id == id }) else {
            throw CashuP2PKError.keyNotFound
        }
        var next = p2pkKeyRing
        next.keys.removeAll { $0.id == id }
        if next.primaryKeyID == id { next.primaryKeyID = next.keys.last?.id }
        try await applyP2PKKeyRing(next)
    }

    private func applyP2PKKeyRing(_ keyRing: CashuP2PKKeyRing) async throws {
        try KeychainP2PKKeyStore().save(keyRing)
        p2pkKeyRing = keyRing
        await service?.configureP2PKSigningKeys(privateKeys: p2pkSigningPrivateKeys)
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

    /// Preview that also confirms with the mint that the token hasn't already been spent.
    func previewUnspentToken(_ token: String) async throws -> CashuTokenPreview {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        return try await service.previewUnspentToken(token)
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
            statusMessage = "Paid \(formattedSats(result.amount)) to Cashu request"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            #endif
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
        if isNWCWalletActive {
            let saved = try await service.saveReceiveWithoutRedeeming(token)
            pendingEcashReceives = await service.savedPendingReceives()
            statusMessage = "Saved \(formattedSats(saved.amount)) to Ecash tokens"
            return .queued(saved)
        }
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
            statusMessage = "Received \(formattedSats(amount))"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            #endif
        case .alreadyReceived:
            statusMessage = "This ecash was already received"
        case .queued:
            if automaticallyRedeemsIncomingPayments {
                await paymentNotificationCoordinator.requestAuthorizationIfNeeded()
            }
            statusMessage = automaticallyRedeemsIncomingPayments
                ? "Ecash saved — Taskify will retry automatically"
                : "Ecash saved — choose Retry in the wallet to redeem it"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            #endif
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
        statusMessage = "Received \(formattedSats(amount))"
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
        return amount
    }

    func discardPendingReceive(_ pending: CashuPendingReceive) async throws {
        guard let service else { throw CashuWalletError.pendingReceiveMissing }
        try await service.discardPendingReceive(id: pending.id)
        await refresh()
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
            var pollSeconds = Self.lightningPollBaseSeconds
            while !Task.isCancelled {
                guard let self else { return }
                let hasOutstandingInvoices = self.hasOutstandingLightningInvoices
                let hasPendingEcash = !self.recoverablePendingEcashReceives.isEmpty
                if hasOutstandingInvoices {
                    let quotesBefore = self.lightningReceiveQuotes
                    await self.recoverPendingLightningReceives()
                    // Escalate while checks come back unchanged so an unpaid invoice cannot
                    // hold the app on a hot multi-second poll for its entire lifetime; any
                    // state change resets the cadence for responsive claim detection.
                    pollSeconds = self.lightningReceiveQuotes == quotesBefore
                        ? min(pollSeconds * 2, Self.lightningPollMaximumSeconds)
                        : Self.lightningPollBaseSeconds
                }
                if hasPendingEcash {
                    await self.recoverPendingEcashReceives()
                }
                do {
                    try await Task.sleep(
                        for: .seconds(hasOutstandingInvoices ? pollSeconds : (hasPendingEcash ? 15 : 30))
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

    /// Matches the PWA's `useWalletPrice` gating: only poll while conversion is turned on and the
    /// app is in the foreground (the PWA also requires the wallet modal to be open, which doesn't
    /// have a clean native analogue since the wallet is an always-mounted tab rather than a
    /// dismissable modal -- app-foreground is the natural equivalent cost-control here). Every
    /// 5 minutes, matching the PWA's `BACKGROUND_REFRESH_INTERVAL_MS`.
    func startPriceMonitoringIfNeeded() {
        startPriceMonitoring()
    }

    func stopPriceMonitoring() {
        priceMonitorTask?.cancel()
        priceMonitorTask = nil
    }

    private func startPriceMonitoring() {
        guard WalletCurrencySettings.conversionEnabled, isAppActive, priceMonitorTask == nil else { return }
        priceMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard WalletCurrencySettings.conversionEnabled else {
                    self.priceMonitorTask = nil
                    return
                }
                if let price = try? await CoinbasePriceClient.fetchSpotPriceUSD() {
                    self.btcUSDPrice = price
                    WalletPriceCache.save(price)
                }
                do {
                    try await Task.sleep(for: .seconds(300))
                } catch {
                    return
                }
            }
        }
    }

    private func restartPriceMonitoring() {
        priceMonitorTask?.cancel()
        priceMonitorTask = nil
        startPriceMonitoring()
    }

    /// The primary/secondary amount pair for a sat amount, following the PWA's `formatSatAmount`/
    /// `formatUsdAmount` + `walletPrimaryCurrency`/`walletDenominationDisplay` settings: which
    /// currency leads depends on `walletPrimaryCurrency`, and a secondary "≈" line only appears
    /// when conversion is enabled and a price is available. `amount` is assumed non-negative --
    /// callers that need a sign prefix (e.g. transaction history's +/-) apply it themselves.
    /// `primary` is a parameter rather than a settings read so callers can pass an observable
    /// source. `WalletCurrencySettings` is backed by UserDefaults, which SwiftUI can't observe --
    /// a view that only reads it here will not re-render when the currency is switched.
    func displayAmount<T: BinaryInteger>(
        forSats amount: T,
        primary: WalletPrimaryCurrency? = nil
    ) -> (primary: String, secondary: String?) {
        let satText = WalletAmountFormat.formatSats(amount, display: WalletCurrencySettings.denominationDisplay)
        guard WalletCurrencySettings.conversionEnabled, let price = btcUSDPrice else {
            return (satText, nil)
        }
        let usdText = WalletAmountFormat.formatUSD(WalletAmountFormat.usdValue(sats: amount, btcUSDPrice: price))
        switch primary ?? WalletCurrencySettings.primaryCurrency {
        case .usd:
            return (usdText, satText)
        case .sat:
            return (satText, "≈ \(usdText)")
        }
    }

    /// The denomination-aware sat string alone (no USD line) -- for call sites where a secondary
    /// currency line doesn't fit (status toasts, inline labels).
    func formattedSats<T: BinaryInteger>(_ amount: T) -> String {
        WalletAmountFormat.formatSats(amount, display: WalletCurrencySettings.denominationDisplay)
    }

    /// The address to lead the Receive screen with. Prefers a short custom solife.me address over
    /// the npub-derived one -- an `npub1...@solife.me` string is technically valid but unreadable,
    /// and this is the first thing someone is asked to scan or read aloud.
    var preferredLightningAddress: String? {
        switch LightningAddressSettings.provider {
        case .none:
            return nil
        case .npubCash:
            return npubCashIdentity?.address
        case .solife:
            return SolifeClient.preferredReceiveAddress(
                selectedAddress: LightningAddressSettings.selectedSolifeAddress,
                account: solifeAccount,
                derivedAddress: solifeAddress
            )
        }
    }

    // MARK: - Amount entry

    /// Which currency the amount keypads are entering in. Only ever dollars when there's a rate to
    /// convert with, so a stale preference can't strand the user typing a currency the app can't
    /// price.
    var amountEntryCurrency: WalletPrimaryCurrency {
        guard WalletCurrencySettings.conversionEnabled, btcUSDPrice != nil else { return .sat }
        return WalletCurrencySettings.primaryCurrency
    }

    /// The figure as typed, in whichever currency is being entered.
    func entryPrimaryText(_ text: String, currency: WalletPrimaryCurrency) -> String {
        let value = text.isEmpty ? "0" : text
        switch currency {
        case .sat:
            return "\(value) \(WalletAmountFormat.inputUnitLabel(display: WalletCurrencySettings.denominationDisplay))"
        case .usd:
            return "$\(value)"
        }
    }

    /// The same amount in the other currency, for the line underneath.
    func entrySecondaryText(_ text: String, currency: WalletPrimaryCurrency) -> String? {
        guard let price = btcUSDPrice, price > 0, WalletCurrencySettings.conversionEnabled else { return nil }
        switch currency {
        case .sat:
            guard let sats = UInt64(text.trimmingCharacters(in: .whitespacesAndNewlines)), sats > 0 else { return nil }
            return "≈ \(WalletAmountFormat.formatUSD(WalletAmountFormat.usdValue(sats: sats, btcUSDPrice: price)))"
        case .usd:
            guard let sats = sats(fromEntry: text, currency: .usd), sats > 0 else { return nil }
            return "≈ \(formattedSats(sats))"
        }
    }

    /// What the sheet actually acts on. Every wallet operation is denominated in sats regardless of
    /// what the user typed, so dollar entry converts here and nowhere else.
    func sats(fromEntry text: String, currency: WalletPrimaryCurrency) -> UInt64? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        switch currency {
        case .sat:
            return UInt64(trimmed)
        case .usd:
            guard let price = btcUSDPrice, let usd = Double(trimmed) else { return nil }
            return WalletAmountFormat.satsValue(usd: usd, btcUSDPrice: price)
        }
    }

    /// Swaps which currency leads, for the tap-the-amount gesture the PWA's amount displays have.
    /// Returns nil when there's nothing to swap to (conversion off, or no price yet), which also
    /// leaves the amount card non-interactive rather than tappable-but-inert.
    ///
    /// `onChange` exists because `WalletCurrencySettings` is UserDefaults-backed and not
    /// observable: the calling view bumps a revision counter to re-render itself.
    /// Goes through `AppModel` rather than writing the preference directly: it also refreshes the
    /// published copy other views read and schedules the account backup that carries the setting
    /// to the PWA. Writing UserDefaults alone would leave both stale.
    func currencyToggleAction(
        using model: AppModel,
        _ onChange: @escaping () -> Void
    ) -> (() -> Void)? {
        guard WalletCurrencySettings.conversionEnabled, btcUSDPrice != nil else { return nil }
        return {
            model.setWalletPrimaryCurrency(
                WalletCurrencySettings.primaryCurrency == .sat ? .usd : .sat
            )
            onChange()
        }
    }

    /// The "≈ $x.xx" line for an amount the user is currently typing on a keypad. Unlike
    /// `displayAmount(forSats:)` this always leads with sats, because the keypad itself is
    /// denominated in sats regardless of which currency is set as primary.
    func conversionLine(forTypedSats amountText: String) -> String? {
        guard WalletCurrencySettings.conversionEnabled,
              let price = btcUSDPrice,
              let sats = UInt64(amountText.trimmingCharacters(in: .whitespacesAndNewlines)),
              sats > 0 else { return nil }
        return "≈ \(WalletAmountFormat.formatUSD(WalletAmountFormat.usdValue(sats: sats, btcUSDPrice: price)))"
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
        // Writing an identical array still fires objectWillChange and re-renders every
        // observing view -- the monitor used to do that on every poll cycle.
        guard quotes != lightningReceiveQuotes else { return }
        lightningReceiveQuotes = quotes
    }

    @discardableResult
    private func recoverPendingEcashReceives(
        force: Bool = false,
        presentInApp: Bool = true
    ) async -> [CashuRecoveredReceive] {
        guard let service else { return [] }
        if isNWCWalletActive || !automaticallyRedeemsIncomingPayments {
            // Manual devices and NWC mode keep saved tokens unredeemed.
            let saved = await service.savedPendingReceives()
            if saved != pendingEcashReceives { pendingEcashReceives = saved }
            return []
        }
        let recovered = await service.recoverPendingReceives(force: force)
        let savedPendingReceives = await service.savedPendingReceives()
        if savedPendingReceives != pendingEcashReceives {
            pendingEcashReceives = savedPendingReceives
        }
        guard !recovered.isEmpty else { return [] }
        await refresh()
        guard presentInApp else { return recovered }

        let total = recovered.reduce(UInt64(0)) { $0 + $1.receivedAmount }
        statusMessage = recovered.count == 1
            ? "Received \(formattedSats(total)) from saved ecash"
            : "Received \(formattedSats(total)) from \(recovered.count) saved tokens"
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
        return recovered
    }

    @discardableResult
    private func recoverNostrPaymentRequests(
        presentInApp: Bool = true
    ) async -> [CashuPaymentRequestReceipt] {
        guard automaticallyRedeemsIncomingPayments else {
            refreshManualPaymentInbox()
            return []
        }
        // Payments to requests made in ecash mode wait in their durable inbox until the
        // ecash wallet is active again, rather than being claimed into it now.
        guard !isNWCWalletActive else { return [] }
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

        var receipts: [CashuPaymentRequestReceipt] = []
        for delivery in deliveries {
            guard !Task.isCancelled else { break }
            do {
                let receipt = try await service.receiveNostrPayment(delivery)
                receipts.append(receipt)
                // Removed immediately, not batched after the loop: if the app is interrupted
                // partway through (backgrounded and killed before this pass finishes), a delivery
                // that already succeeded here must not be left sitting in the durable inbox to be
                // redeemed-and-notified-about all over again on the next cold launch.
                try? CashuNostrPaymentInboxStore.remove(eventIDs: [delivery.eventID], at: inboxURL)
            } catch let error as CashuWalletError where Self.isTerminalPaymentDeliveryError(error) {
                try? CashuNostrPaymentInboxStore.remove(eventIDs: [delivery.eventID], at: inboxURL)
            } catch CashuWalletError.paymentRequestUncertain {
                // The mint rejected this as already spent, but nothing on this device shows *we*
                // were the one who spent it -- most likely someone else redeemed it first (a
                // different wallet holding the same request, or a race with another delivery of
                // the same payment). A few retries across separate recovery passes give a same-
                // device timing race (the evidence just hasn't landed yet) a chance to resolve;
                // past that, retrying forever would just repeat the same failed mint call on every
                // future launch for money that's already gone, so give up for good.
                let attempts = (delivery.uncertainAttempts ?? 0) + 1
                if attempts >= Self.maximumUncertainPaymentAttempts {
                    try? CashuNostrPaymentInboxStore.remove(eventIDs: [delivery.eventID], at: inboxURL)
                } else {
                    var retried = delivery
                    retried.uncertainAttempts = attempts
                    try? CashuNostrPaymentInboxStore.update(retried, at: inboxURL)
                }
            } catch {
                // Keep transient mint/network failures in the durable inbox.
            }
        }
        guard !receipts.isEmpty else {
            createdPaymentRequests = await service.savedCreatedPaymentRequests()
            return []
        }

        await refresh()
        if presentInApp {
            let total = receipts.reduce(UInt64(0)) { $0 + $1.amount }
            statusMessage = receipts.count == 1
                ? "Received \(formattedSats(total)) from a Cashu request"
                : "Received \(formattedSats(total)) from \(receipts.count) Cashu payments"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            #endif
        }
        return receipts
    }

    /// Claims unsolicited incoming tokens — e.g. eCash a Lightning-address forwarder like
    /// solife.me drops in a DM — through the same `submitReceive` path as a manually pasted
    /// token. Unlike `recoverNostrPaymentRequests`, there's no request on this device to match:
    /// any decodable token found in an incoming DM is fair game.
    @discardableResult
    private func recoverIncomingTokenInbox(
        presentInApp: Bool = true
    ) async -> [DMPushRedeemedPaymentReceipt] {
        guard automaticallyRedeemsIncomingPayments else {
            refreshManualPaymentInbox()
            return []
        }
        guard !isRecoveringIncomingTokenInbox else {
            paymentInboxNeedsAnotherPass = true
            return []
        }
        isRecoveringIncomingTokenInbox = true
        defer { isRecoveringIncomingTokenInbox = false }
        guard let service,
              let inboxURL = try? CashuIncomingTokenInboxStore.defaultURL() else { return [] }
        let deliveries = CashuIncomingTokenInboxStore.load(from: inboxURL)
        guard !deliveries.isEmpty else { return [] }

        var claimedTotal: UInt64 = 0
        var claimedCount = 0
        var savedTotal: UInt64 = 0
        var savedCount = 0
        var receipts: [DMPushRedeemedPaymentReceipt] = []
        for delivery in deliveries {
            guard !Task.isCancelled else { break }
            if isNWCWalletActive {
                // Keep the original token so it stays redeemable anywhere.
                if let saved = try? await service.saveReceiveWithoutRedeeming(delivery.token) {
                    savedTotal += saved.amount
                    savedCount += 1
                }
                try? CashuIncomingTokenInboxStore.markHandled(delivery, at: inboxURL)
                continue
            }
            do {
                switch try await service.submitReceive(delivery.token) {
                case .received(let amount):
                    claimedTotal += amount
                    claimedCount += 1
                    receipts.append(DMPushRedeemedPaymentReceipt(
                        eventID: delivery.eventID,
                        amount: amount,
                        senderPublicKey: delivery.senderPublicKey
                    ))
                case .alreadyReceived:
                    // Idempotent replay of a token this wallet credited earlier. It is handled,
                    // but it is not a fresh balance change and must not produce another receipt.
                    break
                case .queued:
                    // Now tracked by the pending-receive system's own retry loop.
                    break
                }
                try? CashuIncomingTokenInboxStore.markHandled(delivery, at: inboxURL)
            } catch {
                // Malformed, already-spent, or already owned by the pending-receive retry system:
                // this NIP-17 delivery itself must never be replayed into another redemption.
                try? CashuIncomingTokenInboxStore.markHandled(delivery, at: inboxURL)
            }
        }
        if savedCount > 0 {
            pendingEcashReceives = await service.savedPendingReceives()
            if presentInApp {
                statusMessage = savedCount == 1
                    ? "Saved \(formattedSats(savedTotal)) of ecash to move to your wallet"
                    : "Saved \(savedCount) ecash tokens (\(formattedSats(savedTotal)))"
            }
        }
        guard claimedCount > 0 else { return [] }

        await refresh()
        if presentInApp {
            statusMessage = claimedCount == 1
                ? "Received \(formattedSats(claimedTotal))"
                : "Received \(formattedSats(claimedTotal)) from \(claimedCount) payments"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            #endif
        }
        return receipts
    }

    /// `.paymentRequestUncertain` deliveries get this many recovery passes (not raw retries --
    /// once per `recoverNostrPaymentRequests` call, so roughly once per cold launch/background
    /// refresh) before being dropped as unrecoverable.
    private static let maximumUncertainPaymentAttempts = 3

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
            statusMessage = "Received \(formattedSats(total)) over Lightning"
        } else {
            statusMessage = "Received \(formattedSats(total)) from \(newlyIssued.count) Lightning invoices"
        }
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
        return newlyIssued
    }

    func prepareSend(
        mintURL: String,
        amount: UInt64,
        lockPublicKey: String? = nil
    ) async throws -> CashuPreparedSendQuote {
        guard let service else { throw CashuWalletError.preparedSendMissing }
        isWorking = true
        defer { isWorking = false }
        return try await service.prepareSend(
            mintURL: mintURL,
            amount: amount,
            lockPublicKey: lockPublicKey
        )
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
            statusMessage = "Paid \(formattedSats(result.amount)) over Lightning"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            #endif
        } else {
            statusMessage = "Lightning payment is processing"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            #endif
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
            statusMessage = "Moved \(formattedSats(result.receivedAmount)) between mints"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            #endif
        } else {
            statusMessage = "Mint transfer is finishing in the background"
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            #endif
        }
        return result
    }

    func reclaim(_ outgoing: CashuOutgoingToken) async throws -> UInt64 {
        guard let service else { throw CashuWalletError.outgoingTokenMissing }
        isWorking = true
        defer { isWorking = false }
        let amount = try await service.reclaimOutgoingToken(id: outgoing.id)
        await refresh()
        statusMessage = "Reclaimed \(formattedSats(amount))"
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

        let candidate: CashuWalletService
        if isCurrentWallet {
            candidate = currentService
        } else {
            candidate = try await Self.makeServiceOffMain(
                mnemonic: material.mnemonic,
                migrateLegacyFiles: false
            )
        }
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
            "Transferred \(formattedSats(outcome.recovered)) into Taskify"
        case .transfer:
            "Seed scan complete"
        case .rescan where outcome.recovered > 0:
            "Recovered \(formattedSats(outcome.recovered))"
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

        let candidate: CashuWalletService
        if isCurrentWallet {
            candidate = currentService
        } else {
            candidate = try await Self.makeServiceOffMain(
                mnemonic: material.mnemonic,
                migrateLegacyFiles: false
            )
        }
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
            await candidate.configureP2PKSigningKeys(
                privateKeys: p2pkSigningPrivateKeys
            )
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
            ? "Recovered \(formattedSats(outcome.recovered))"
            : "Wallet seed replaced"
        return outcome
    }

    private nonisolated static func makeServiceOffMain(
        mnemonic: String,
        migrateLegacyFiles: Bool
    ) async throws -> CashuWalletService {
        try await Task.detached(priority: .userInitiated) {
            try makeService(
                mnemonic: mnemonic,
                migrateLegacyFiles: migrateLegacyFiles
            )
        }.value
    }

    private nonisolated static func makeService(
        mnemonic: String,
        migrateLegacyFiles: Bool
    ) throws -> CashuWalletService {
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

    private nonisolated static func walletDirectory() throws -> URL {
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

    private nonisolated static func migrateLegacyWalletFiles(
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

/// Shared by the iPad and Mac wallets. Rendering only decodes local token metadata.
struct ManualIncomingPaymentsView: View {
    @ObservedObject var wallet: WalletViewModel
    @State private var redemptionError: String?

    var body: some View {
        if !wallet.automaticallyRedeemsIncomingPayments {
            GroupBox("Incoming Payments") {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Payments are not automatically redeemed on this device. Choose Redeem to add one here, or leave it for your phone.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(wallet.incomingTokensAwaitingRedemption) { delivery in
                        HStack {
                            paymentLabel(token: delivery.token, date: delivery.receivedAt)
                            Spacer()
                            Button("Redeem") {
                                Task {
                                    redemptionError = nil
                                    do { try await wallet.redeemIncomingPayment(delivery) }
                                    catch { redemptionError = WalletViewModel.message(for: error) }
                                }
                            }
                            .disabled(wallet.isWorking || wallet.isLoading || wallet.isNWCWalletActive)
                        }
                    }
                    ForEach(wallet.incomingRequestsAwaitingRedemption) { delivery in
                        HStack {
                            paymentLabel(
                                token: (try? CashuPaymentRequestContract.tokenString(fromPaymentPayload: delivery.payloadJSON)) ?? "",
                                date: delivery.receivedAt
                            )
                            Spacer()
                            Button("Redeem") {
                                Task {
                                    redemptionError = nil
                                    do { try await wallet.redeemIncomingPayment(delivery) }
                                    catch { redemptionError = WalletViewModel.message(for: error) }
                                }
                            }
                            .disabled(wallet.isWorking || wallet.isLoading || wallet.isNWCWalletActive)
                        }
                    }
                    if let redemptionError {
                        Text(redemptionError).font(.caption).foregroundStyle(.red)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
        }
    }

    private func paymentLabel(token: String, date: Date) -> some View {
        let summary = CashuWalletService.offlineTokenSummary(token)
        return VStack(alignment: .leading, spacing: 4) {
            Text(summary.map { wallet.formattedSats($0.amount) } ?? "Ecash payment")
            if let summary { Text(summary.mintURL).font(.caption).foregroundStyle(.secondary) }
            Text(date.formatted(date: .abbreviated, time: .shortened))
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

#if os(iOS)
struct WalletView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject private var wallet: WalletViewModel
    @State private var showingMints = false
    @State private var showingHistory = false
    @State private var showingReceive = false
    @State private var showingLightningReceive = false
    @State private var showingScanner = false
    @State private var showingSend = false
    @State private var showingLightningSend = false
    @State private var showingPaymentRequest = false
    @State private var showingCreatePaymentRequest = false
    @State private var showingPendingEcash = false
    @State private var showingRecovery = false
    @State private var scannedRedeemable: RedeemableCashuToken?
    @State private var isInspectingScan = false
    @State private var showingWalletMode = false
    @State private var showingNWCReceive = false
    @State private var showingNWCSend = false
    @State private var showingNWCTokens = false
    @State private var showingNWCHistory = false
    @State private var showingWalletSettings = false

    var body: some View {
        ZStack {
            TaskifyContentBackground().ignoresSafeArea()

            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 0) {
                        header

                        utilityToolbar
                            .padding(.top, 14)

                        if !wallet.automaticallyRedeemsIncomingPayments {
                            ManualIncomingPaymentsView(wallet: wallet)
                                .padding(.top, 14)
                        }

                        Group {
                            if wallet.snapshot.mints.isEmpty && !wallet.isLoading && !wallet.isNWCWalletActive {
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
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
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
        .onChange(of: model.walletConversionEnabled) { _, enabled in
            if enabled {
                wallet.startPriceMonitoringIfNeeded()
            } else {
                wallet.stopPriceMonitoring()
            }
        }
        .sheet(isPresented: $showingMints) {
            MintManagerSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingHistory) {
            WalletHistorySheet(wallet: wallet)
        }
        // Clearing the scanned token on dismiss keeps it a one-shot hand-off. It used to persist,
        // so every later visit to Receive eCash replayed the last scan through the scanner path --
        // which reports failures -- and a token since redeemed greeted the user with an
        // "already spent" alert they never asked for.
        .sheet(isPresented: $showingReceive) {
            ReceiveCashuSheet(wallet: wallet, onSwitchMode: {
                showingReceive = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showingLightningReceive = true }
            })
        }
        .sheet(isPresented: $showingLightningReceive) {
            ReceiveLightningSheet(wallet: wallet, onSwitchMode: {
                showingLightningReceive = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showingReceive = true }
            })
        }
        .sheet(isPresented: $showingScanner) {
            CashuTokenScannerSheet(onToken: { token in
                showingScanner = false
                // Scanning a token says exactly what the user wants. Opening Receive eCash first
                // put a page about handing out requests in front of the thing they asked for.
                Task { await redeemScannedToken(token) }
            })
        }
        .sheet(item: $scannedRedeemable) { item in
            RedeemCashuTokenSheet(wallet: wallet, redeemable: item)
        }
        .sheet(isPresented: $showingSend) {
            SendCashuSheet(wallet: wallet, onSwitchMode: {
                showingSend = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showingLightningSend = true }
            })
        }
        .sheet(isPresented: $showingLightningSend) {
            SendLightningSheet(wallet: wallet, onSwitchMode: {
                showingLightningSend = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { showingSend = true }
            })
        }
        .sheet(isPresented: $showingPaymentRequest) {
            PayCashuRequestSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingCreatePaymentRequest) {
            ReceiveCashuRequestSheet(wallet: wallet)
                .environment(model)
        }
        .sheet(isPresented: $showingPendingEcash) {
            PendingEcashSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingRecovery) {
            WalletRecoverySheet(wallet: wallet)
        }
        .sheet(isPresented: $showingWalletMode) {
            WalletManagerSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingWalletSettings) {
            WalletSettingsSheet(wallet: wallet).environment(model)
        }
        .sheet(isPresented: $showingNWCReceive) {
            NWCReceiveSheet(wallet: wallet).environment(model)
        }
        .sheet(isPresented: $showingNWCSend) {
            NWCSendSheet(wallet: wallet).environment(model)
        }
        .sheet(isPresented: $showingNWCTokens) {
            NWCTokensSheet(wallet: wallet)
        }
        .sheet(isPresented: $showingNWCHistory) {
            NWCHistorySheet(wallet: wallet)
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

            Spacer(minLength: 0)
        }
    }

    private var utilityToolbar: some View {
        HStack(alignment: .top) {
            Spacer()

            TaskifyGlassControlGroup(spacing: 8) {
                // A phone stacks these beside the balance; a regular-width window has room for a
                // row, which keeps the balance from being pushed down the page.
                if horizontalSizeClass == .regular {
                    HStack(spacing: 9) { utilityButtons }
                } else {
                    VStack(alignment: .trailing, spacing: 9) { utilityButtons }
                }
            }
        }
    }

    @ViewBuilder
    private var utilityButtons: some View {
        WalletUtilityButton(title: "History", systemImage: "clock.arrow.circlepath") {
            if wallet.isNWCWalletActive { showingNWCHistory = true } else { showingHistory = true }
        }
        .accessibilityLabel("Wallet history")

        WalletUtilityButton(title: "Wallets", systemImage: "wallet.pass") {
            showingWalletMode = true
        }
        .accessibilityIdentifier("wallet-mode-button")

        WalletUtilityButton(title: "Settings", systemImage: "gearshape.fill") {
            showingWalletSettings = true
        }
    }

    /// Verifies a scanned token with its mint and opens the redeem page. Scanning is a deliberate
    /// act, so an unusable token says so rather than failing quietly the way a clipboard read does.
    private func redeemScannedToken(_ token: String) async {
        guard !isInspectingScan else { return }
        isInspectingScan = true
        defer { isInspectingScan = false }

        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.lowercased().hasPrefix("cashu:")
            ? String(trimmed.dropFirst("cashu:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            : trimmed
        do {
            let preview = try await wallet.previewUnspentToken(normalized)
            scannedRedeemable = RedeemableCashuToken(token: normalized, preview: preview)
        } catch {
            wallet.errorMessage = WalletViewModel.message(for: error)
        }
    }

    private var balanceCard: some View {
        let nwcActive = wallet.isNWCWalletActive
        let nwcBalance = wallet.nwcStatus?.balanceSat
        let balanceUnknown = nwcActive && nwcBalance == nil
        let balance = wallet.displayAmount(
            forSats: nwcActive ? (nwcBalance ?? 0) : wallet.snapshot.available,
            primary: model.walletPrimaryCurrency
        )
        return VStack(spacing: 10) {
            Text(balanceUnknown ? WalletViewModel.unknownBalanceText : balance.primary)
                .font(.system(size: 48, weight: .semibold, design: .rounded))
                .minimumScaleFactor(0.62)
                .lineLimit(1)
                .contentTransition(.numericText())
                .monospacedDigit()
                .foregroundStyle(TaskifyTheme.primaryText)

            if balanceUnknown {
                if let reason = wallet.nwcBalanceUnavailableReason {
                    Text(reason)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            } else if let secondary = balance.secondary {
                Text(secondary)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            if !nwcActive && (wallet.snapshot.pending > 0 || wallet.snapshot.reserved > 0) {
                VStack(spacing: 5) {
                    if wallet.snapshot.pending > 0 {
                        Text("\(wallet.formattedSats(wallet.snapshot.pending)) pending")
                    }
                    if wallet.snapshot.reserved > 0 {
                        Text("\(wallet.formattedSats(wallet.snapshot.reserved)) in outgoing tokens")
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
        .contentShape(Rectangle())
        .onTapGesture {
            guard let toggle = wallet.currencyToggleAction(using: model, {}) else { return }
            withAnimation(.easeInOut(duration: 0.2)) { toggle() }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(nwcActive
            ? (nwcBalance.map { "\(wallet.nwcWalletLabel) balance, \($0) sats" }
                ?? "\(wallet.nwcWalletLabel) balance, \(wallet.nwcBalanceUnavailableReason ?? "loading")")
            : "Available balance, \(wallet.snapshot.available) sats")
        .accessibilityIdentifier("wallet-balance")
        .accessibilityHint(
            wallet.currencyToggleAction(using: model, {}) == nil
                ? ""
                : "Double-tap to switch between sats and dollars"
        )
    }

    private var actionRow: some View {
        HStack(spacing: 12) {
            WalletActionButton(title: "Receive", icon: "arrow.down", accent: true) {
                if wallet.isNWCWalletActive { showingNWCReceive = true } else { showingLightningReceive = true }
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
                if wallet.isNWCWalletActive { showingNWCSend = true } else { showingLightningSend = true }
            }
            .disabled(!wallet.isNWCWalletActive && wallet.snapshot.available == 0)
            .opacity(!wallet.isNWCWalletActive && wallet.snapshot.available == 0 ? 0.45 : 1)
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
        Button {
            if wallet.isNWCWalletActive { showingNWCTokens = true } else { showingPendingEcash = true }
        } label: {
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
                    Text(wallet.isNWCWalletActive ? "Ecash tokens" : "Saved ecash")
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
        if wallet.isNWCWalletActive {
            let total = wallet.pendingEcashReceives.reduce(UInt64(0)) { $0 + $1.amount }
            return "\(wallet.formattedSats(total)) to move to \(wallet.nwcWalletLabel) or redeem elsewhere"
        }
        if wallet.recoverablePendingEcashReceives.isEmpty {
            return "A token needs your attention"
        }
        if !wallet.automaticallyRedeemsIncomingPayments {
            return "Choose when to redeem these saved tokens"
        }
        return wallet.recoverablePendingEcashReceives.count == 1
            ? "Waiting for its mint — retrying automatically"
            : "Waiting for their mints — retrying automatically"
    }
}

#endif
